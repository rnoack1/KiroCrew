#!/usr/bin/env python3
"""Post-review chat — keep ONE review session alive so the reviewer can be asked
about the findings it just produced.

Why a whole module for this: a review's reasoning lives in its session context,
not in the report. The report carries the *conclusions* (observation /
consequence / suggestion); "why did you decide that?" is answerable only by the
session that decided it. So the deep-review session is adopted here instead of
being ``destroy()``ed when its task returns.

Two things had to stop killing it, and both are deliberate:

  * **The session.** ``ReviewPool.send(..., keep_session_key=...)`` skips its
    ``destroy()`` and hands the live handle here.
  * **The runtime.** ``_BatchRuntimeHolder`` reference-counts the shared kiro-cli
    subprocess and kills it when the count drains to 0 — that teardown is how the
    pool reclaims RSS, because there is no per-turn compaction. An adopted
    session therefore takes a **batch lease**: ``begin_batch()`` on adopt,
    ``end_batch()`` on close. A chat is, to the holder, just another batch that
    has not finished.

That lease is the whole cost of this feature: while a chat is open the subprocess
cannot be reclaimed. It is bounded on four sides, and every one of them ends in
the same release path — so "chat is open" can never become "runtime leaked":

  * ``CHAT_IDLE_TTL_SECS`` — swept once idle (the common case; nobody closes tabs)
  * explicit close — the user ends the conversation
  * ``MAX_CHAT_SESSIONS`` — a new adopt evicts the least-recently-used idle chat
  * ``close_all()`` — app disable / shutdown

The registry holds live sessions and their turns in memory only. Persisting the
transcript is the caller's job (see ``backend/routes.py``): disk is what the UI
reads, so history survives expiry and restart, while ``live`` tells the UI
whether the composer can still be used. Keeping those separate is what lets an
archived run show what was discussed without offering an input box that would
fail.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from kiro_crew.acp.types import (
        EVENT_COMPLETE,
        EVENT_PERMISSION_REQUEST,
        EVENT_TEXT_CHUNK,
        EVENT_THINKING_CHUNK,
        EVENT_TOOL_CALL,
        STOP_REASON_STALE_RECOVER,
        STOP_REASON_TOOL_STALL,
    )
except ImportError:  # pragma: no cover - standalone / test fallback
    EVENT_TEXT_CHUNK = "text_chunk"  # type: ignore[assignment]
    EVENT_THINKING_CHUNK = "thinking_chunk"  # type: ignore[assignment]
    EVENT_TOOL_CALL = "tool_call"  # type: ignore[assignment]
    EVENT_PERMISSION_REQUEST = "permission_request"  # type: ignore[assignment]
    EVENT_COMPLETE = "complete"  # type: ignore[assignment]
    STOP_REASON_STALE_RECOVER = "stale_recover"  # type: ignore[assignment]
    STOP_REASON_TOOL_STALL = "error: tool stall"  # type: ignore[assignment]

try:
    from kiro_crew.safety_override import safety_override
except Exception:  # pragma: no cover - standalone / test fallback
    safety_override = None  # type: ignore[assignment]

# Module scope, per the repo's top-level-imports rule. No cycle: `store` and
# `results` do not import this module, and `review_pool` (which does) imports it
# lazily inside its own functions.
from sage_lib import results, store  # noqa: E402

logger = logging.getLogger(__name__)

# How long an adopted session may sit unused before the sweep closes it. Short on
# purpose: the lease pins a kiro-cli subprocess, and the realistic usage is a few
# questions right after reading the report, not an all-day conversation. A closed
# chat still shows its transcript; only the ability to continue is lost.
CHAT_IDLE_TTL_SECS = 1800.0

# Absolute lifetime, idle or not. Bounds the pathological case of a page left
# polling forever, which would renew the idle clock indefinitely.
CHAT_MAX_AGE_SECS = 6 * 3600.0

# Concurrent adopted chats. Each one pins the shared subprocess, so this is a
# memory bound, not a throughput knob.
MAX_CHAT_SESSIONS = 4

# Per-question ceiling. Well under the review task timeout: a follow-up question
# is one turn, not a whole review.
CHAT_TURN_TIMEOUT = 300.0


def override_active() -> bool:
    """Whether the platform safety override is active.

    The one gate for chat tool use, and therefore for whether a chat turn may run
    at all. Fails CLOSED when the module is unavailable: "cannot tell" must not
    read as "allowed".
    """
    if safety_override is None:  # pragma: no cover - standalone fallback
        return False
    try:
        return bool(safety_override().is_active())
    except Exception:  # pragma: no cover - defensive
        logger.debug("override probe failed", exc_info=True)
        return False


def chat_key(run_id: str, change_id: str) -> str:
    """Identity of one chat: the review that produced the findings.

    Scoped to (run, change) rather than change alone because re-reviewing a PR
    produces different reasoning, and a chat must belong to the report the user is
    actually looking at.
    """
    return f"{run_id}:{change_id}"


ROLE_USER = "user"
ROLE_REVIEWER = "reviewer"

# Why a question produced no answer, surfaced verbatim to the UI.
REFUSED_NO_YOLO = "tool_refused_no_override"

# A turn was not even attempted because tool use could not be gated. See
# ``_override_active`` and ``ask``.
ERR_NEEDS_OVERRIDE = "chat_needs_override"

# The turn ended abnormally (timeout / tool-stall / stale-recovery / error:*), so
# whatever text arrived is partial and must NOT be shown as a finished answer.
ERR_ABNORMAL = "chat_turn_incomplete"

# The run this chat belongs to was deleted while the chat was still live.
ERR_RUN_GONE = "chat_run_deleted"


def _is_abnormal_stop(reason: str) -> bool:
    """True when an EVENT_COMPLETE stop_reason means the turn did NOT finish.

    Same predicate the review path applies in ``review_pool._is_abnormal_stop``,
    and for the same reason: a 300s timeout still emits EVENT_COMPLETE, so
    breaking on the event alone would store a truncated sentence as a finished
    answer. Duplicated rather than imported because ``review_pool`` imports THIS
    module, and a top-level import back would be circular.
    """
    r = (reason or "").strip().lower()
    if not r:
        return False
    if r in (str(STOP_REASON_TOOL_STALL).lower(),
             str(STOP_REASON_STALE_RECOVER).lower(), "timeout"):
        return True
    return r.startswith("error")


def _scrub(text: str) -> str:
    """Credential + exfiltration-URL scrub for anything leaving this module."""
    try:
        return store.redact_text(text or "")
    except Exception:  # pragma: no cover - defensive
        logger.debug("chat redaction failed", exc_info=True)
        # Fail CLOSED: an unscrubbable string is dropped rather than emitted raw.
        return ""


def _coerce_turn(item: object) -> dict | None:
    """Normalize one on-disk turn into the known shape, or reject it.

    Routed back through ``ChatTurn.to_dict`` so the scrub and the field set have
    exactly one definition. The role is restricted to the two values the UI
    renders: a planted role must not reach a branch nobody designed.
    """
    if not isinstance(item, dict):
        return None
    role = item.get("role")
    if role not in (ROLE_USER, ROLE_REVIEWER):
        return None

    def _str(value: object) -> str:
        return value if isinstance(value, str) else ""

    def _strs(value: object) -> list[str]:
        if not isinstance(value, list):
            return []
        return [v for v in value if isinstance(v, str)]

    raw_ts = item.get("ts")
    return ChatTurn(
        role=str(role),
        text=_str(item.get("text")),
        thinking=_str(item.get("thinking")),
        tools=_strs(item.get("tools")),
        refusals=_strs(item.get("refusals")),
        ts=float(raw_ts) if isinstance(raw_ts, (int, float)) else 0.0,
    ).to_dict()


@dataclass
class ChatTurn:
    """One exchange, as the UI renders it."""

    role: str
    text: str = ""
    thinking: str = ""
    tools: list[str] = field(default_factory=list)
    refusals: list[str] = field(default_factory=list)
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        """Serialize for the API and for disk, scrubbed.

        Every string here is model-written or model-influenced: the reviewer can
        repeat a credential it read in the diff, and a tool title carries the
        arguments it was called with. This is the single boundary both the HTTP
        response and the persisted transcript pass through, so the scrub belongs
        here rather than at each call site. The user's own text is scrubbed too —
        a pasted token is exactly as bad once it is on disk.
        """
        return {
            "role": self.role,
            "text": _scrub(self.text),
            "thinking": _scrub(self.thinking),
            "tools": [_scrub(t) for t in self.tools],
            "refusals": [_scrub(r) for r in self.refusals],
            "ts": self.ts,
        }


@dataclass
class ChatSession:
    """A review session that outlived its review, plus its conversation."""

    key: str
    handle: Any
    created_at: float = field(default_factory=time.time)
    last_used_at: float = field(default_factory=time.time)
    turns: list[ChatTurn] = field(default_factory=list)
    # Held for the duration of one question. The underlying handle rejects a
    # concurrent prompt outright, so serializing here turns a race into a clean
    # "busy" answer instead of an AcpRuntimeError.
    busy: bool = False

    def idle_expired(self, now: float | None = None) -> bool:
        """Unused for longer than the idle TTL. Respects ``busy``: a session
        answering right now is in use, and closing it would kill the answer."""
        now = time.time() if now is None else now
        return (now - self.last_used_at) >= CHAT_IDLE_TTL_SECS

    def aged_out(self, now: float | None = None) -> bool:
        """Past the absolute lifetime, busy or not.

        Deliberately NOT subject to the busy exemption. ``busy`` is what a stuck
        turn looks like, so exempting it from every bound is exactly how a pinned
        subprocess would survive forever — this cap is the backstop for that case.
        """
        now = time.time() if now is None else now
        return (now - self.created_at) >= CHAT_MAX_AGE_SECS

    def expired(self, now: float | None = None) -> bool:
        """Either bound reached. Kept for callers that do not care which."""
        return self.idle_expired(now) or self.aged_out(now)


class ChatSessionRegistry:
    """Owns adopted review sessions and their batch leases.

    One instance per app (see ``backend/routes.py``). All mutation of the session
    map is under ``_lock``; the ACP round-trip for a question deliberately runs
    OUTSIDE that lock, so one slow question cannot stall an unrelated close or
    sweep.
    """

    def __init__(self, pool: Any) -> None:
        self._pool = pool
        self._sessions: dict[str, ChatSession] = {}
        self._lock = asyncio.Lock()

    async def adopt(self, key: str, handle: Any) -> None:
        """Take ownership of a live session handle and lease the runtime.

        Called from ``ReviewPool.send`` after a kept task completes. Takes the
        lease FIRST: if ``begin_batch()`` raises we must not register a session
        whose runtime nobody is holding, and the caller destroys the handle.

        Refuses outright when the safety override is inactive — see below.
        """
        # A chat that cannot answer is not worth a subprocess. Without the
        # override every question is refused, so adopting would pin the shared
        # runtime for the idle TTL after EVERY review to serve a panel that can
        # only say "turn on YOLO". Checked at adoption time; the caller treats a
        # refusal as a normal non-adoption and destroys the handle as before.
        if not override_active():
            raise RuntimeError(ERR_NEEDS_OVERRIDE)
        await self._pool.begin_batch()
        leased = True
        try:
            async with self._lock:
                prior = self._sessions.pop(key, None)
                self._sessions[key] = ChatSession(key=key, handle=handle)
                leased = False  # the map now owns the lease
                victims = self._overflow_victims_locked()
            # Close outside the lock — destroy() and end_batch() both await.
            if prior is not None:
                await self._retire(prior, reason="replaced")
            for victim in victims:
                await self._retire(victim, reason="evicted")
        finally:
            if leased:
                # Registration failed after the lease was taken; hand it back so
                # the count cannot drift upward and pin the subprocess forever.
                await self._release_lease()

    def _overflow_victims_locked(self) -> list[ChatSession]:
        """Least-recently-used idle sessions above the cap. Busy ones are never
        evicted — a question in flight would fail mid-answer."""
        if len(self._sessions) <= MAX_CHAT_SESSIONS:
            return []
        idle = sorted(
            (s for s in self._sessions.values() if not s.busy),
            key=lambda s: s.last_used_at)
        victims = idle[:max(0, len(self._sessions) - MAX_CHAT_SESSIONS)]
        for victim in victims:
            self._sessions.pop(victim.key, None)
        return victims

    def status(self, key: str) -> dict:
        """Whether ``key`` can still be asked, for the UI's composer state."""
        session = self._sessions.get(key)
        if session is None:
            return {"live": False, "busy": False, "turns": []}
        return {
            "live": True,
            "busy": session.busy,
            "turns": [t.to_dict() for t in session.turns],
        }

    async def ask(self, key: str, message: str,
                  timeout: float = CHAT_TURN_TIMEOUT) -> dict:
        """Put one question to the adopted reviewer and return its answer.

        Returns ``{"ok": bool, "turns": list[dict], "error": str}`` rather than
        raising: every failure here is something the UI must render (expired,
        busy, refused, timed out), not a 500.

        Both sides of the exchange come back, in order, so the caller can append
        them to the persisted transcript. Returning only the reply would force the
        caller to re-derive the question it just sent, and would lose the
        server-side timestamp that orders the two.
        """
        # Refuse BEFORE prompting when the safety override is inactive.
        #
        # ``_decide_permission`` only ever sees tools the provider ASKS about, and
        # an agent spec's ``allowedTools`` pre-approves tools so they execute with
        # no permission event at all — the reviewer agent pre-approves one MCP
        # server and the fallback ``kirocrew`` agent pre-approves thirty entries.
        # So rejecting at the permission event cannot be the only gate: for a
        # pre-approved tool there is nothing to reject, and by the time
        # EVENT_TOOL_CALL arrives the tool has already run.
        #
        # The session's spec cannot be narrowed after the fact — it is the review's
        # own session, which is the entire point of keeping it — so the honest gate
        # is the turn itself. A chat turn is user-driven text, and running it
        # un-gated is the thing this whole seam exists to prevent.
        if not self._override_active():
            return {"ok": False, "turns": [], "error": ERR_NEEDS_OVERRIDE}
        async with self._lock:
            session = self._sessions.get(key)
            if session is None:
                return {"ok": False, "turns": [], "error": "chat_expired"}
            if session.busy:
                return {"ok": False, "turns": [], "error": "chat_busy"}
            session.busy = True
            session.last_used_at = time.time()

        user_turn = ChatTurn(role=ROLE_USER, text=message)
        try:
            try:
                reply = await self._run_turn(session, message, timeout)
            except Exception as e:
                logger.debug("chat turn failed", exc_info=True)
                return {"ok": False, "turns": [], "error": str(e)}
        finally:
            # A `finally`, not just the two exit paths: a cancelled handler (client
            # disconnect) raises BaseException, which an `except Exception` never
            # sees. Leaving `busy` set there would exempt the session from the idle
            # sweep and from eviction, pinning the shared subprocess until the app
            # is disabled — the exact leak the bounds exist to prevent.
            async with self._lock:
                session.busy = False
                session.last_used_at = time.time()

        async with self._lock:
            # Record both sides only on success, so a failed question does not
            # leave a dangling user turn with no answer under it.
            session.turns.append(user_turn)
            session.turns.append(reply)
        return {"ok": True,
                "turns": [user_turn.to_dict(), reply.to_dict()],
                "error": ""}

    async def _run_turn(self, session: ChatSession, message: str,
                        timeout: float) -> ChatTurn:
        """Drive one ``prompt()`` and fold its event stream into a turn.

        The handle's guard rejects only a *concurrent* prompt, so a later
        sequential one on the same handle is exactly what makes the reviewer
        remember its own reasoning.
        """
        turn = ChatTurn(role=ROLE_REVIEWER)
        parts: list[str] = []
        thinking: list[str] = []
        stop_reason = ""
        handle = session.handle
        gen = handle.prompt(message, timeout=timeout)
        try:
            async for ev in gen:
                kind = getattr(ev, "kind", None)
                if kind == EVENT_TEXT_CHUNK:
                    parts.append(getattr(ev, "text", "") or "")
                elif kind == EVENT_THINKING_CHUNK:
                    # The review dispatch loop drops this kind; a chat is where
                    # the reasoning is the point, so it is kept and shown.
                    thinking.append(getattr(ev, "text", "") or "")
                elif kind == EVENT_TOOL_CALL:
                    title = str(getattr(ev, "title", "") or "")
                    if title:
                        turn.tools.append(title)
                    await self._audit(handle, ev)
                elif kind == EVENT_PERMISSION_REQUEST:
                    await self._decide_permission(handle, ev, turn)
                elif kind == EVENT_COMPLETE:
                    stop_reason = getattr(ev, "stop_reason", "") or ""
                    break
        finally:
            aclose = getattr(gen, "aclose", None)
            if aclose is not None:
                await aclose()
        # A timeout / tool-stall / stale-recovery still emits EVENT_COMPLETE, so
        # breaking on the event alone would file a truncated sentence as a
        # finished answer — worse than no answer, because nothing marks it partial.
        if _is_abnormal_stop(stop_reason):
            raise RuntimeError(ERR_ABNORMAL)
        turn.text = "".join(parts)
        turn.thinking = "".join(thinking)
        return turn

    async def _decide_permission(self, handle: Any, ev: Any,
                                 turn: ChatTurn) -> None:
        """Approve a tool only when the platform's override says so.

        A review auto-approves everything because its prompt is scripted and
        bounded. A chat turn is driven by whatever the user typed, so the same
        blanket approval would let a sentence run shell with no gate. The gate is
        the existing safety override (YOLO) rather than an app-local flag, so
        this surface cannot drift from the platform's posture. Either way the
        decision is audited.
        """
        req_id = getattr(ev, "request_id", "")
        if self._override_active():
            try:
                await handle.approve_tool(req_id)
            except Exception:
                logger.debug("chat tool approve failed", exc_info=True)
            else:
                await self._audit(handle, ev, request_id=req_id,
                                  outcome="auto_approved")
            return
        try:
            await handle.reject_tool(req_id)
        except Exception:
            logger.debug("chat tool reject failed", exc_info=True)
        else:
            await self._audit(handle, ev, request_id=req_id,
                              outcome="rejected")
        title = str(getattr(ev, "title", "") or "")
        turn.refusals.append(title or REFUSED_NO_YOLO)

    @staticmethod
    def _override_active() -> bool:
        return override_active()

    async def _audit(self, handle: Any, ev: Any, *,
                     request_id: Any = None,
                     outcome: str = "auto_approved") -> None:
        audit = getattr(self._pool, "audit_tool_event", None)
        if audit is None:  # pragma: no cover - standalone fallback
            return
        try:
            await audit(handle, ev, request_id=request_id, outcome=outcome)
        except Exception:  # pragma: no cover - defensive
            logger.debug("chat tool audit failed", exc_info=True)

    async def close(self, key: str) -> bool:
        """End one chat and hand its lease back. Idempotent by key."""
        async with self._lock:
            session = self._sessions.pop(key, None)
        if session is None:
            return False
        await self._retire(session, reason="closed")
        return True

    async def sweep(self) -> int:
        """Close idle/aged-out chats. Safe to call on any cadence."""
        now = time.time()
        async with self._lock:
            # Busy exempts a session from the IDLE clock only. The absolute cap
            # applies regardless: a session that has been "busy" for six hours is
            # not working, it is stuck, and it is holding the shared subprocess.
            due = [s for s in self._sessions.values()
                   if s.aged_out(now) or (not s.busy and s.idle_expired(now))]
            for session in due:
                self._sessions.pop(session.key, None)
        for session in due:
            await self._retire(session, reason="expired")
        return len(due)

    async def close_all(self) -> int:
        """Drop every chat — app disable / shutdown."""
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            await self._retire(session, reason="shutdown")
        return len(sessions)

    async def _retire(self, session: ChatSession, *, reason: str) -> None:
        """Destroy the handle and release its lease.

        Ordering is destroy-then-release: once the lease is gone the runtime may
        be killed, and destroying a session on a dead runtime logs noise.

        Called EXACTLY once per session because every caller removes it from
        ``_sessions`` under ``_lock`` before calling this — that removal, not a
        flag on the session, is what makes the release single. It has to be: the
        lease decrements a count shared with live reviews, so releasing twice
        could tear down a runtime another review is still using. Any new caller
        must pop-under-lock first.
        """
        try:
            await session.handle.destroy()
        except Exception:
            logger.debug("chat session destroy error (%s)", reason,
                         exc_info=True)
        await self._release_lease()

    async def _release_lease(self) -> None:
        try:
            await self._pool.end_batch()
        except Exception:  # pragma: no cover - defensive
            logger.debug("chat lease release failed", exc_info=True)


_REGISTRY: ChatSessionRegistry | None = None


def get_registry(pool: Any) -> ChatSessionRegistry:
    """Process-wide chat registry, rebuilt if the pool singleton was replaced.

    Rebinding on a new pool matters: ``review_pool.get_pool()`` makes a fresh
    ReviewPool after a shutdown, and a registry still holding leases against the
    OLD pool would decrement a counter nobody reads while the new pool's
    subprocess is pinned by nothing.
    """
    global _REGISTRY
    if _REGISTRY is None or _REGISTRY._pool is not pool:
        _REGISTRY = ChatSessionRegistry(pool)
    return _REGISTRY


def peek_registry() -> ChatSessionRegistry | None:
    """The registry if one exists, without creating it (status handlers)."""
    return _REGISTRY


async def shutdown_registry() -> int:
    """Close every chat and drop the singleton (app disable / shutdown)."""
    global _REGISTRY
    closed = 0
    if _REGISTRY is not None:
        closed = await _REGISTRY.close_all()
        _REGISTRY = None
    return closed


# --- transcript persistence -------------------------------------------------
# Separate from the registry on purpose: the registry owns *live* sessions, disk
# owns *history*. That split is what lets an archived run render what was
# discussed after its session is long gone, instead of showing an input box that
# cannot work.

def transcript_path(run_id: str, change_id: str,
                    root: "Path | None" = None) -> "Path":
    """Where one chat's history lives.

    Under the run's own ``chat/`` subdir rather than ``results/``: result records
    are globbed by ``results.list_results``, and a transcript sitting among them
    would be read as a malformed review record.

    ``change_id`` is routed through ``results.safe_change_id`` because it arrives
    from a request and lands in a filename.
    """
    safe = results.safe_change_id(change_id)
    return store.run_dir(run_id, root) / "chat" / f"{safe}.json"


def read_transcript(run_id: str, change_id: str,
                    root: "Path | None" = None) -> list[dict]:
    """History for a chat, or ``[]`` when there is none.

    Tolerant by design: a missing, unreadable or malformed file reads as "no
    history" so the panel still renders.

    Every surviving turn is re-normalized and re-scrubbed rather than trusted.
    Scrubbing on write is not sufficient: the reviewer has shell and can derive
    this path, so it can write the file ITSELF — a planted transcript carrying a
    credential would otherwise be handed to the dashboard verbatim. Re-coercing
    also means a truncated or hand-edited file cannot inject an unknown role and
    reach a render path the UI does not expect.
    """
    path = transcript_path(run_id, change_id, root)
    # The reviewer has shell and this path is predictable, so a prompt-injected
    # worker can plant a symlink here. `read_text` would follow it and copy an
    # arbitrary file into a transcript the dashboard renders; the app's chokepoint
    # opens O_NOFOLLOW, confines the resolved inode to the run dir, and caps size.
    try:
        raw_text = store.read_text_nolink(path, path.parent)
    except Exception:
        return []
    if not raw_text:
        return []
    try:
        raw = json.loads(raw_text)
    except ValueError:
        return []
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        turn = _coerce_turn(item)
        if turn is not None:
            out.append(turn)
    return out


def write_transcript(run_id: str, change_id: str, turns: list[dict],
                     root: "Path | None" = None) -> None:
    """Persist a chat's history atomically.

    Temp-then-replace so a crash mid-write cannot destroy the history that was
    already readable — the same reason ``results.write_result`` does it.
    """
    path = transcript_path(run_id, change_id, root)
    # Do NOT create the run dir. The chat outlives its review, so a question asked
    # from a stale tab after the run was deleted would otherwise resurrect the run
    # directory that deletion just removed.
    if not path.parent.parent.is_dir():
        raise FileNotFoundError(ERR_RUN_GONE)
    path.parent.mkdir(parents=True, exist_ok=True)
    # mkstemp, not a predictable `<name>.json.tmp`: the worker can pre-plant a
    # symlink at a name it can guess, and writing through it would land this
    # content on whatever it points at (the app's own config.json, for instance).
    # An O_EXCL temp with a random name cannot be pre-empted, and os.replace does
    # not follow a symlink at the destination.
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=".chat-", suffix=".json")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(turns, ensure_ascii=False))
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
