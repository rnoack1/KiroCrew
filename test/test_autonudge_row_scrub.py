"""Tests for the inbound conversation-row credential scrub and its per-row marker.

A persisted transcript row is an EGRESS: it is served back to every connected dashboard
client. Three claims are pinned here.

1. **Every user-row persister scrubs**, and the set does not grow unnoticed -- an AST
   ratchet walks the call sites rather than trusting a count.
2. **A rewritten row says so.** The scrub keeps no original, so an unmarked row makes a
   false positive indistinguishable from what the user typed.
3. **A miscomposed host withholds the row instead of raising** -- half a turn on disk is
   worse than a withheld body.
"""

from __future__ import annotations

import ast
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from kiro_crew import autonudge as _an


class TestEveryPersistedRowBodyUsesTheActiveCredentialPolicy:
    """First Principles (CONCERNS): the root cause was closed for user rows only.

    "The bare redactor pair skips a composed host's own patterns" was fixed at the user-row
    persisters, leaving the OTHER halves -- assistant/system rows at the write boundary, the
    Slack nudge reply, the cron rows -- on the bare pair, and model output carries them too.
    """

    TOKEN = "COMPANION-SSO-COOKIE-9f3a2b4c7d1e"

    class _CompanionPolicy:
        token = "COMPANION-SSO-COOKIE-9f3a2b4c7d1e"

        def redact(self, text: str) -> str:
            from kiro_crew import security

            return security.redact(text).replace(self.token, "[REDACTED: companion]")

    @staticmethod
    def _install(policy) -> None:
        import dataclasses

        from kiro_crew.config.loader import KiroCrewConfig
        from kiro_crew.platform import build_default_context, set_context

        base = build_default_context(KiroCrewConfig())
        set_context(dataclasses.replace(base, credentials=policy))

    def test_the_bare_pair_alone_cannot_see_the_companion_shape(self) -> None:
        """POSITIVE CONTROL: without the shim the token survives, so the test can fail."""
        from kiro_crew.security import redact_credentials, redact_exfiltration_urls

        bare, _ = redact_exfiltration_urls(f"key={self.TOKEN}")
        bare, _ = redact_credentials(bare)
        assert self.TOKEN in bare, (
            "precondition: the bare pair already redacts this shape, so neither arm of this "
            "test could distinguish the composed host from the baseline"
        )

    def test_a_user_row_a_caller_rewrote_is_marked_too(self, tmp_path) -> None:
        """Design watch 1 / UX: the user's OWN words are the case that must carry the cue."""
        import json as _json

        from kiro_crew.history import ConversationLog

        log = ConversationLog(base_dir=tmp_path)
        # What a channel persister's own scrub produces, passed in as the user's row.
        log.append("slot-user", "user", "my key is [REDACTED: credential] ok")
        log.append("slot-user", "user", "just my ordinary question")
        rows = [
            _json.loads(line)
            for line in (tmp_path / "slot-user.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip() and _json.loads(line).get("role") == "user"
        ]
        assert len(rows) == 2, f"precondition: expected two user rows, got {len(rows)}"
        rewritten, verbatim = rows[0], rows[1]
        assert rewritten.get("redacted") is True, (
            "a user row rewritten by its persister carries no marker, so a redaction false "
            "positive silently replaces the user's own transcript text"
        )
        assert (
            "redacted" not in verbatim
        ), "a user row nobody rewrote was marked, so the cue would appear on verbatim text"

    def test_a_scrubbed_row_is_rewritten_while_a_clean_row_is_not(self, tmp_path) -> None:
        """Design (F2): the write-time scrub is a one-way door that has to say so.

        The nudge wire already carries ``message_redacted``; a rewritten conversation row
        carried no equivalent, so a reader could not tell it from verbatim text. Same
        contract, mirrored: a boolean set only on change.
        """
        import json as _json

        from kiro_crew.history import ConversationLog

        # Vendor-shaped so the HOST redactor masks it with no companion policy installed.
        key = "AKIAIOSFODNN7EXAMPLE"
        log = ConversationLog(base_dir=tmp_path)
        log.append("slot-flagged", "assistant", f"deploy with {key}")
        log.append("slot-flagged", "assistant", "nothing sensitive here")
        rows = [
            _json.loads(line)
            for line in (tmp_path / "slot-flagged.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip() and _json.loads(line).get("role") == "assistant"
        ]
        assert len(rows) == 2, f"precondition: expected two assistant rows, got {len(rows)}"
        altered, untouched = rows[0], rows[1]
        assert (
            key not in altered["content"]
        ), "precondition: the scrub did not rewrite this row, so nothing was under test"
        assert untouched["content"] == "nothing sensitive here", (
            "a row with nothing credential-shaped in it was rewritten anyway, so the "
            "boundary is not shape-based"
        )
        assert altered.get("redacted") is True, (
            "the rewritten row carries NO marker, so a reader cannot tell it from what the "
            "author actually wrote and a false positive reads as the author's own words"
        )
        assert "redacted" not in untouched, (
            "an untouched row was marked as rewritten, so the marker says nothing and every "
            "row would carry the cue"
        )

    def test_a_non_user_history_row_is_scrubbed_by_the_composed_policy(self) -> None:
        from kiro_crew.history import _redact_at_write_boundary

        self._install(self._CompanionPolicy())
        try:
            stored = _redact_at_write_boundary("assistant", f"here it is: {self.TOKEN}")
        finally:
            from kiro_crew.platform import set_context

            set_context(None)
        assert self.TOKEN not in stored, (
            "an assistant row kept a companion-only credential verbatim, so the host's own "
            "patterns are still skipped for every non-user role"
        )
        assert "[REDACTED: companion]" in stored


class TestEveryChannelPersisterScrubsTheStoredTurn:
    """The persisted transcript row is an egress on every channel, not just Slack.

    Only ``_fire_slack_nudge`` and the dashboard nudge scrub the row they write; the others
    hand a synthetic inbound to the dispatcher and ``_persist_turn`` writes it, so
    store-sourced nudge text reached ``conv_log`` with nothing applied. Scrubbed at the SINK,
    the only place the persisted copy is separable from the PROMPT, which is already consumed
    when ``_persist_turn`` runs; Discord and Telegram scrub in its sole caller (ratchet-pinned).
    """

    SECRET = "AKIAIOSFODNN7EXAMPLE"

    @staticmethod
    def _dispatcher_class(channel: str):
        module = import_module(f"kiro_crew.{channel}.transport_dispatch")
        return getattr(module, f"{channel.capitalize()}Dispatcher")

    @classmethod
    def _user_rows(cls, channel: str, turn: str) -> list[str]:
        rows: list[tuple[str, str]] = []

        def _append(_key, role, text, **_kw):
            rows.append((role, text))

        fake_log = MagicMock()
        fake_log.append = _append
        fake_log.append_if_absent = _append
        holder = SimpleNamespace(conv_log=fake_log)
        cls._dispatcher_class(channel)._persist_turn(holder, "chat-1-123", turn, "", False)
        user_rows = [text for role, text in rows if role == "user"]
        assert user_rows, f"fixture failed: {channel} persisted no user row to read"
        return user_rows

    @pytest.mark.parametrize("channel", ["webex"])
    def test_the_persisted_user_row_carries_no_credential(self, channel: str) -> None:
        """Fail-first: the row written to ``conv_log`` must not echo the stored secret."""
        raw = f"[auto-nudge cycle 1]\ndeploy with {self.SECRET}"
        assert self.SECRET in raw, "fixture failed: the secret is not in the input"
        user_rows = self._user_rows(channel, raw)
        assert self.SECRET not in user_rows[0], (
            f"{channel} persisted the raw store-sourced turn: {user_rows[0]!r}. That row "
            "is served to dashboard readers, so a credential the ingress scan never saw "
            "reaches them verbatim"
        )

    @pytest.mark.parametrize("channel", ["discord", "webex", "telegram"])
    def test_a_clean_turn_is_persisted_unchanged(self, channel: str) -> None:
        """NEGATIVE CONTROL: the scrub must track CHANGE, not rewrite every row."""
        clean = "[auto-nudge cycle 2]\njust keep going"
        user_rows = self._user_rows(channel, clean)
        assert user_rows[0] == clean, (
            f"{channel} altered a turn with nothing credential-shaped in it: "
            f"{user_rows[0]!r} != {clean!r}"
        )


# Every module persisting a role="user" row. Pinned, so a NEW one is added deliberately.
_USER_ROW_PERSISTERS = frozenset(
    {
        "discord/transport_dispatch_ledger.py",
        "eval/runner.py",
        "feishu/transport_dispatch.py",
        "imessage/transport_dispatch.py",
        "llm_helpers_parts/turn_results.py",
        "slack/transport_dispatch.py",
        "taskrunner_parts/run_reporting.py",
        "teams/transport_dispatch.py",
        "telegram/dispatch/turn_engine.py",
        "webex/transport_dispatch.py",
        "wecom/transport_dispatch.py",
        "weixin/transport_dispatch.py",
        "whatsapp/transport_dispatch.py",
    }
)


#: Row-at-a-time ``ConversationLog`` writers, which take ``(key, role, content)`` -- so the
#: role is the SECOND positional argument. The grouped writers below take a SEQUENCE of rows
#: instead, putting the role in the first field of a row tuple.
_ROW_WRITE_METHODS = {"append", "append_if_absent"}
_GROUPED_ROW_WRITERS = {
    "append_rows_if_absent_off_loop",
    "append_if_absent_off_loop",
    "append_off_loop",
}


def _role_keyword_is_user(call: ast.Call) -> bool:
    """``role="user"`` on the call ITSELF, never nested inside an argument.

    ``turns.append(TranscriptTurn(role="user", ...))`` carries it on the dataclass, so
    reading nested keywords would read a list append of a summary row as a durable write.
    """
    return any(
        kw.arg == "role" and isinstance(kw.value, ast.Constant) and kw.value.value == "user"
        for kw in call.keywords
    )


def _rows_hold_a_user_row(call: ast.Call) -> bool:
    for arg in [*call.args, *(kw.value for kw in call.keywords)]:
        if not isinstance(arg, (ast.List, ast.Tuple)):
            continue
        for elt in arg.elts:
            first = elt.elts[0] if isinstance(elt, (ast.Tuple, ast.List)) and elt.elts else None
            if isinstance(first, ast.Constant) and first.value == "user":
                return True
    return False


def _appends_a_user_row(call: ast.Call) -> bool:
    """Does this call persist a ``ConversationLog`` row whose role is ``user``?

    Matches either row writer with the role second, the bound writer handed to
    ``asyncio.to_thread`` (arguments shift right by one), a grouped write's row tuples, and
    ``role="user"``. The dashboard slot's ``append`` takes the role FIRST, so it never matches.
    """
    func = call.func
    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")

    if name in _ROW_WRITE_METHODS:
        args = call.args
        if len(args) >= 2 and isinstance(args[1], ast.Constant) and args[1].value == "user":
            return True
        return _role_keyword_is_user(call)

    if name in _GROUPED_ROW_WRITERS:
        return _rows_hold_a_user_row(call) or _role_keyword_is_user(call)

    if isinstance(func, ast.Attribute) and func.attr == "to_thread":
        args = call.args
        return (
            len(args) >= 3
            and isinstance(args[0], ast.Attribute)
            and args[0].attr in _ROW_WRITE_METHODS
            and isinstance(args[2], ast.Constant)
            and args[2].value == "user"
        )
    return False


def _modules_persisting_user_rows() -> set[str]:
    root = Path(__file__).resolve().parents[1] / "src" / "kiro_crew"
    found: set[str] = set()
    for path in root.rglob("*.py"):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _appends_a_user_row(node):
                found.add(path.relative_to(root).as_posix())
    return found


def _enclosing_scopes(tree: ast.Module) -> dict[ast.AST, ast.AST]:
    """Map every node to the nearest enclosing function, or the module."""
    owner: dict[ast.AST, ast.AST] = {}
    stack: list[ast.AST] = [tree]

    def walk(node: ast.AST) -> None:
        scope = stack[-1]
        for child in ast.iter_child_nodes(node):
            owner[child] = scope
            opens = isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            if opens:
                stack.append(child)
            walk(child)
            if opens:
                stack.pop()

    walk(tree)
    return owner


_SCRUBBERS = {"redact_via_context", "redact_log_via_context"}


def _scrubs_within(scope: ast.AST) -> bool:
    return any(isinstance(n, ast.Name) and n.id in _SCRUBBERS for n in ast.walk(scope))


_SCRUBBED_BY_ITS_CALLER = {
    "discord/transport_dispatch_ledger.py:_persist_turn": "_record_turn",
    "telegram/dispatch/turn_engine.py:_persist_turn": "_run_turn",
}


def _scrubbed_by_its_only_caller(root: Path, site: str) -> bool:
    caller = _SCRUBBED_BY_ITS_CALLER.get(site)
    refs: set[tuple[str, bool]] = set()
    for path in (root / site.split("/")[0]).rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        owner = _enclosing_scopes(tree)
        for node in ast.walk(tree):
            scope = owner.get(node, tree)
            if isinstance(node, ast.Attribute) and node.attr == site.split(":")[1]:
                refs |= {(scope.name, _scrubs_within(scope))} if scope is not tree else set()
    return caller is not None and refs == {(caller, True)}


def _unscrubbed_user_row_sites() -> list[str]:
    """Every role=user append whose own function never calls the redactor.

    Function-scoped: dispatchers rebind ``user_text`` above the call, and a whole-file check
    would pass a second unscrubbed append in a module whose other function scrubs.
    """
    root = Path(__file__).resolve().parents[1] / "src" / "kiro_crew"
    offenders: list[str] = []
    for path in sorted(root.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        owner = _enclosing_scopes(tree)
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and _appends_a_user_row(node)):
                continue
            scope = owner.get(node, tree)
            site = f"{path.relative_to(root).as_posix()}:{getattr(scope, 'name', '<module>')}"
            if not _scrubs_within(scope) and not _scrubbed_by_its_only_caller(root, site):
                offenders.append(site)
    return offenders


class TestEveryUserRowPersisterScrubs:
    """Ratchet: the transcript scrub is a convention across ~13 call sites, so pin them.

    Moving it into ``ConversationLog.append`` is deferred; the reason, and why its measured
    attribution is wrong, is in ``docs/system-specs/modules/history.md``.
    """

    def test_the_set_of_user_row_persisters_has_not_grown(self) -> None:
        """A fourteenth persister goes RED here instead of silently reopening the leak."""
        found = _modules_persisting_user_rows()
        assert found, "the scanner matched nothing, so it cannot detect a new persister"
        added = found - _USER_ROW_PERSISTERS
        assert not added, (
            "a module now persists a role=user transcript row without being registered "
            f"as scrubbing it: {sorted(added)}. Scrub the persisted copy (NOT the text "
            "handed to the model) and add the module to _USER_ROW_PERSISTERS."
        )
        assert not _USER_ROW_PERSISTERS - found, (
            "a registered persister no longer appends a user row; drop it from "
            f"_USER_ROW_PERSISTERS: {sorted(_USER_ROW_PERSISTERS - found)}"
        )

    def test_every_user_row_call_site_scrubs(self) -> None:
        """A new unscrubbed append goes red even in a module already registered."""
        offenders = _unscrubbed_user_row_sites()
        assert not offenders, (
            "these functions persist a role=user transcript row without calling "
            f"redact_via_context anywhere in the same function: {offenders}. Scrub the "
            "persisted copy, NOT the text handed to the model."
        )


class TestPersistedRowRedactionSurvivesAMiscomposedHost:
    """A composed-host failure must not kill ordinary inbound chat.

    ``redact_via_context`` re-raises ``PlatformCompositionError`` by design, right for a nudge
    or an API response the caller answers with an audited refusal. The channel persisters sit on
    ordinary conversation's dispatch path, so that raise takes the message down on a host whose
    only fault is a companion it could not compose (Design review). Containment must not become
    a downgrade: the raw text must never reach the transcript.
    """

    class _BrokenPolicy:
        def redact(self, text: str) -> str:
            from kiro_crew.platform import PlatformCompositionError

            raise PlatformCompositionError("companion credential policy unreadable")

    def _install(self, monkeypatch) -> None:
        from kiro_crew.platform import context as ctx_mod

        class _Ctx:
            credentials = TestPersistedRowRedactionSurvivesAMiscomposedHost._BrokenPolicy()

        # A context IS installed here -- only its policy fails to compose.
        monkeypatch.setattr(ctx_mod, "installed_context", lambda: _Ctx())
        monkeypatch.setattr(ctx_mod, "current_context", lambda: _Ctx())

    def test_the_raising_spelling_still_raises_on_such_a_host(self, monkeypatch) -> None:
        from kiro_crew.platform import PlatformCompositionError
        from kiro_crew.platform.context import redact_via_context

        self._install(monkeypatch)
        with pytest.raises(PlatformCompositionError):
            redact_via_context("token AKIAIOSFODNN7EXAMPLE")

    def test_the_row_spelling_withholds_instead_of_raising(self, monkeypatch) -> None:
        from kiro_crew.platform.context import (
            LOG_WITHHELD_PLACEHOLDER,
            redact_log_via_context,
        )

        self._install(monkeypatch)
        secret = "token AKIAIOSFODNN7EXAMPLE"
        out = redact_log_via_context(secret)
        assert out == LOG_WITHHELD_PLACEHOLDER
        assert secret not in out

    def test_no_raising_redactor_feeds_the_replay_persister(self) -> None:
        """A turn that already went out must be persisted, so its scrub cannot raise."""
        root = Path(__file__).resolve().parents[1] / "src" / "kiro_crew" / "slack"
        offenders: list[str] = []
        reached = 0
        for path in sorted(root.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for fn in ast.walk(tree):
                if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                raised_names = {
                    target.id
                    for node in ast.walk(fn)
                    if isinstance(node, ast.Assign)
                    for target in node.targets
                    if isinstance(target, ast.Name)
                    and isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Name)
                    and node.value.func.id == "redact_via_context"
                }
                for call in ast.walk(fn):
                    if not isinstance(call, ast.Call):
                        continue
                    func = call.func
                    if not (
                        isinstance(func, ast.Name) and func.id == "save_conversation_turn_off_loop"
                    ):
                        continue
                    reached += 1
                    for arg in call.args:
                        if isinstance(arg, ast.Name) and arg.id in raised_names:
                            offenders.append(f"{fn.name}:{arg.id}")
                        elif (
                            isinstance(arg, ast.Call)
                            and isinstance(arg.func, ast.Name)
                            and arg.func.id == "redact_via_context"
                        ):
                            offenders.append(f"{fn.name}:inline")
        assert reached >= 2, f"probe found only {reached} persister call(s) -- it proves nothing"
        assert offenders == [], (
            "a completed turn is scrubbed by the RAISING spelling before being persisted, so a "
            "miscomposed host drops it from replay and restart history: " + "; ".join(offenders)
        )

    def test_every_channel_persister_uses_the_containment_spelling(self) -> None:
        root = Path(__file__).resolve().parents[1] / "src" / "kiro_crew"
        offenders: list[str] = []
        reached = 0
        for rel in sorted(_USER_ROW_PERSISTERS):
            tree = ast.parse((root / rel).read_text(encoding="utf-8"))
            scrubs = False
            for fn in ast.walk(tree):
                if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                names = {n.id for n in ast.walk(fn) if isinstance(n, ast.Name)}
                if "redact_log_via_context" in names:
                    scrubs = True
                if "redact_via_context" in names:
                    offenders.append(f"{rel}:{fn.name}")
            reached += scrubs
        assert reached == len(_USER_ROW_PERSISTERS), (
            f"probe reached {reached} of {len(_USER_ROW_PERSISTERS)} registered "
            "persisters -- it proves nothing"
        )
        assert offenders == [], (
            "a channel dispatch path still uses the raising spelling, so a miscomposed "
            "host kills the message instead of withholding the row: " + "; ".join(offenders)
        )


class TestOrdinaryUserProseSurvivesTheRowScrub:
    """Design's false-positive guard: the at-rest rewrite is irreversible, so it must not
    fire on ordinary prose."""

    CORPUS = (
        "can you rebase this branch onto main and push it",
        "the build failed with exit code 1, no other output",
        "my key insight is that the cache never invalidates",
        "set the token budget to 4096 and retry",
        "password rotation is due next quarter, per the runbook",
        "see https://github.com/acme/widgets/pull/42 for context",
        "AWS costs went up 12% after we moved to us-east-1",
        "the secret to this one is that ordering matters",
        "id 0123456789 belongs to the staging tenant",
        "Authorization is handled by the gateway, not here",
        "run `aws s3 ls` and paste the bucket names",
        "the access key rotation ticket is still open",
    )

    def test_no_ordinary_message_is_rewritten(self) -> None:
        from kiro_crew.platform.context import redact_log_via_context

        rewritten = [text for text in self.CORPUS if redact_log_via_context(text) != text]
        assert not rewritten, (
            "the row scrub rewrote ordinary user prose, and the original is not retained, "
            f"so this destroys transcript text: {rewritten!r}"
        )

    def test_the_guard_can_detect_a_rewrite(self) -> None:
        """Positive control: a real credential MUST still be rewritten."""
        from kiro_crew.platform.context import redact_log_via_context

        secret = "my key is AKIAIOSFODNN7EXAMPLE"
        assert redact_log_via_context(secret) != secret


def _binds_the_scrubber(value: ast.expr) -> bool:
    """Does this assigned value bind the row scrubber's result?

    Two legal spellings, because the scan is quadratic on uniform runs so a caller on the event
    loop hands it to a worker thread rather than calling it inline -- ``x =
    redact_log_via_context(text)`` and ``x = await asyncio.to_thread(redact_log_via_context,
    text)``. Recognising only the first inverts the ratchet: the SAFER spelling would go red.
    """
    inner = value.value if isinstance(value, ast.Await) else value
    if not isinstance(inner, ast.Call):
        return False
    if isinstance(inner.func, ast.Name) and inner.func.id == "redact_log_via_context":
        return True
    to_thread = (
        isinstance(inner.func, ast.Attribute)
        and inner.func.attr == "to_thread"
        and bool(inner.args)
    )
    if not to_thread:
        return False
    first = inner.args[0]
    return isinstance(first, ast.Name) and first.id == "redact_log_via_context"


def _slot_user_row_args(module: str) -> list[tuple[int, str]]:
    """Every ``slot.append("user", X, ...)`` in *module*, as ``(line, what X is)``.

    The role-FIRST shape, which the sibling scanner skips because a row typed into the dashboard
    is stored as typed. A row copied in from a channel is inbound text on its way to a reader, so
    it carries the persisters' egress duty. ``X`` reads as ``redacted`` only when it is a name
    this module bound from ``redact_log_via_context``, inline or via a hop.
    """
    root = Path(_an.__file__).resolve().parent
    tree = ast.parse((root / module).read_text(encoding="utf-8"))
    scrubbed: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if _binds_the_scrubber(node.value):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    scrubbed.add(target.id)
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr != "append" or len(node.args) < 2:
            continue
        first = node.args[0]
        if not (isinstance(first, ast.Constant) and first.value == "user"):
            continue
        arg = node.args[1]
        if isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name):
            found.append(
                (
                    node.lineno,
                    "redacted" if arg.func.id == "redact_log_via_context" else arg.func.id,
                )
            )
        elif isinstance(arg, ast.Name):
            found.append((node.lineno, "redacted" if arg.id in scrubbed else f"raw:{arg.id}"))
        else:
            found.append((node.lineno, type(arg).__name__))
    return found


class TestChannelSourcedSlotRowsAreScrubbed:
    """First Principles: the sweep claimed EVERY inbound user message and missed two.

    The Slack mirror copied raw inbound text straight into the linked dashboard slot, and the
    recovery re-trigger scrubbed its row with the baseline pair, not the host's composed
    policy. Both persist and are served to readers, so a composed host's patterns must apply.
    """

    @pytest.mark.parametrize(
        "module",
        ["slack/handler_runtime/finalize.py", "slack/gateway_runtime/subagent_wiring.py"],
    )
    def test_a_channel_sourced_slot_row_is_scrubbed_and_marked(self, module: str) -> None:
        rows = _slot_user_row_args(module)
        assert rows, f"the scanner found no slot user row in {module}, so it is blind"
        unscrubbed = [(line, what) for line, what in rows if what != "redacted"]
        assert not unscrubbed, (
            f"{module} copies inbound text into the dashboard slot without the "
            f"composed-policy scrub, so a composed host's own patterns are skipped: "
            f"{unscrubbed!r}"
        )
        # Scrubbing without marking is the other half: the slot derives no mark, so a
        # rewrite these two perform reaches the reader with no cue unless they say so.
        # Keyed on the APPEND-BOUND name: `frame["redacted"]` sits in the same module.
        source = (Path(_an.__file__).resolve().parent / module).read_text(encoding="utf-8")
        assert (
            "row = slot.append(" in source and 'row["redacted"] = True' in source
        ), f"{module} rewrote its slot user row but never marked the row append returned"


class TestTheScrubberBindingCheckStillRejectsRawText:
    """The ratchet accepts a second spelling, so prove it did not become unfalsifiable: a
    predicate that accepts everything would pass on a module that scrubs nothing.
    """

    @pytest.mark.parametrize(
        "src,binds",
        [
            ("x = redact_log_via_context(text)", True),
            ("async def f():\n    x = await asyncio.to_thread(redact_log_via_context, t)", True),
            ("x = text", False),
            ("x = some_other_helper(text)", False),
            ("x = text.strip()", False),
            # The hop shape with a DIFFERENT callee: the wrapper is not the credential.
            ("x = asyncio.to_thread(str.upper, text)", False),
            # A bare reference is not a binding -- naming the scrubber is not calling it.
            ("x = redact_log_via_context", False),
        ],
    )
    def test_only_a_real_binding_is_accepted(self, src: str, binds: bool) -> None:
        assign = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Assign))
        assert _binds_the_scrubber(assign.value) is binds


class TestTheLiveFrameCarriesTheRewriteMark:
    """A rewritten row must say so on the LIVE wire, not only after a reload.

    Every other consumer copies the row wholesale; the broadcast frame rebuilds it field by
    field, so a reader watching a channel turn arrive saw rewritten text with no cue.
    """

    @staticmethod
    def _payload(role: str, content: str, *, redacted: bool | None) -> dict:
        from kiro_crew.dashboard.state import DashboardState

        sent: list[dict] = []
        state = object.__new__(DashboardState)
        state._broadcast, state._slots = sent.append, {}  # type: ignore[attr-defined]
        msg: dict = {"role": role, "content": content, "cls": "msg msg-u", "ts": "t0"}
        if redacted is not None:
            msg["redacted"] = redacted
        DashboardState._broadcast_chat_message(state, "slot-1", msg)
        assert len(sent) == 1
        return sent[0]

    def test_a_rewritten_user_row_broadcasts_the_mark(self) -> None:
        payload = self._payload("user", "deploy with [REDACTED: credential] now", redacted=True)
        assert payload["redacted"] is True

    def test_a_verbatim_row_broadcasts_no_mark(self) -> None:
        """Over-marking is the failure the cue exists to avoid: it claims the user's own
        words were mutated when they were not."""
        payload = self._payload("user", "deploy with the staging profile", redacted=None)
        assert "redacted" not in payload

    def test_display_redaction_of_model_output_does_not_mark_the_row(self) -> None:
        """The mark is read off the ROW, never re-derived from the broadcast body.

        Assistant content is masked at render time by ``redact_display_content``, so a
        body-derived mark would label untouched stored text as a rewrite.
        """
        payload = self._payload("assistant", "the token is AKIAIOSFODNN7EXAMPLE", redacted=None)
        assert "redacted" not in payload


class TestTheRatchetSeesEveryDurableWriteShape:
    """Planted call sites, so the guard's REACH is asserted rather than assumed.

    A shape the guard cannot see is a persister that leaks in silence.
    ``append_if_absent`` is the shape Discord's mirror path uses and the one the first
    version of this matcher could not see. The negatives matter as much: the dashboard
    slot takes the role FIRST and must stay out, and a list append of a summary row
    carries ``role="user"`` on the row object rather than on the append itself.
    """

    @staticmethod
    def _matches(source: str) -> bool:
        tree = ast.parse(source)
        return any(isinstance(n, ast.Call) and _appends_a_user_row(n) for n in ast.walk(tree))

    @pytest.mark.parametrize(
        "source",
        [
            'conv_log.append(k, "user", raw)',
            'conv_log.append_if_absent(k, "user", raw)',
            'conv_log.append(k, role="user", content=raw)',
            'conv_log.append_if_absent(k, role="user", content=raw)',
            'await asyncio.to_thread(conv_log.append, k, "user", raw)',
            'await asyncio.to_thread(conv_log.append_if_absent, k, "user", raw)',
            'append_rows_if_absent_off_loop(log, k, [("user", raw, cls, mid)])',
        ],
    )
    def test_a_planted_user_row_write_is_seen(self, source: str) -> None:
        assert self._matches(source), f"the ratchet cannot see this durable write: {source}"

    @pytest.mark.parametrize(
        "source",
        [
            'slot.append("user", content, "msg msg-u")',
            'turns.append(TranscriptTurn(index=1, role="user", text=text))',
            'conv_log.append(k, "assistant", raw)',
            "conv_log.append_if_absent(k, role, content)",
            "durable_rows.append((role, content, cls, mid))",
        ],
    )
    def test_a_non_durable_or_non_user_write_is_left_alone(self, source: str) -> None:
        assert not self._matches(source), f"the ratchet over-matches: {source}"


class TestOnlyARealRewriteIsMarked:
    """Design: the mark was SNIFFED from tags, so a row stored verbatim over-marked.

    12 of the 14 ``slot.append("user", ...)`` sites store their author's words verbatim,
    so a tag there is that author's own typing, and the cue would tell them their text
    was not saved when it was. The slot derives nothing: the two sites that DO scrub mark
    the row ``append`` returns, and a replay carries what was recorded.
    """

    @pytest.mark.parametrize(
        "content",
        ["key [REDACTED: credential] ok", "<withheld: redaction unavailable>", {"t": "x"}, None],
    )
    def test_a_verbatim_slot_row_is_never_marked(self, content: object) -> None:
        from kiro_crew.dashboard.state import _ChatSlot

        slot = _ChatSlot("slot-1")
        slot.append("user", content, "msg msg-u", broadcast=False)
        assert "redacted" not in list(slot.messages)[-1]

    @pytest.mark.parametrize("recorded,marked", [(True, True), (None, False)])
    def test_a_replay_carries_the_recorded_mark(self, recorded, marked: bool) -> None:
        """Both arms matter: the cue must survive a reload and must not be invented on
        one. The body carries a tag either way, so only the recorded field can differ."""
        from kiro_crew.dashboard.chat_persistence import _load_rehydrated_window
        from kiro_crew.dashboard.state import DashboardState, _ChatSlot

        state, slot = object.__new__(DashboardState), _ChatSlot("slot-1")
        state._broadcast = lambda *_a, **_k: None  # type: ignore[attr-defined]
        state._slots = {"slot-1": slot}  # type: ignore[attr-defined]
        row: dict = {"role": "user", "content": "key [REDACTED: credential] ok", "ts": "t0"}
        if recorded is not None:
            row["redacted"] = recorded
        _load_rehydrated_window(state, slot, [row], SimpleNamespace(settle=lambda *_a: None))
        assert list(slot.messages)[-1].get("redacted", False) is marked
