"""Tests for the SessionLaneChanged hook event.

Covers the Phase 1 exit criteria: the event fires from BOTH tag writers with a
correct added/removed delta, fires only on a STATUS-tag change, and cannot fail
or block the tag write when a hook errors.
"""

from __future__ import annotations

import asyncio
import contextlib
import pathlib
import sys
import threading
from unittest.mock import patch

import pytest
from aiohttp.test_utils import TestClient, TestServer
from chat_test_helpers import _make_state, _make_tags_app

from kiro_crew import hooks
from kiro_crew.dashboard.chat_tags import create_tag_definition
from kiro_crew.dashboard.state import _ChatSlot
from kiro_crew.hooks import HOOK_EVENT_SESSION_LANE_CHANGED, HOOK_EVENTS


class _StoreStub:
    """Minimal ScriptHookStore stand-in answering ``list_all``.

    Both the writers' subscriber precondition and the dispatcher read the registry,
    so a stub must answer it. Carries one enabled lane hook by default, so a test
    driving the real writer path is not skipped before it fires.
    """

    def __init__(self, hook_ids=("stub-hook",)):
        import kiro_crew.hooks as _H

        self._live = [
            type(
                "_H",
                (),
                {"id": h, "enabled": True, "event": _H.HOOK_EVENT_SESSION_LANE_CHANGED},
            )()
            for h in hook_ids
        ]

    def list_all(self):
        return list(self._live)


class _Accepted:
    """Test-local count of deltas ACCEPTED onto a dispatch queue.

    Replaces a production module global that existed only for this guard. Counts
    ``Queue.put_nowait`` calls that RETURN: a ``QueueFull`` raise is a rejection,
    so counting the call itself would score an overflow as an acceptance.

    Filtered to the dispatch tuple rather than counting every queue in the
    process, because the patch is on ``asyncio.Queue`` itself and an unrelated
    queue would otherwise inflate the count.
    """

    count = 0


_accepted = _Accepted()


async def _settle() -> None:
    """Let the fire-and-forget dispatch task run to completion.

    The dispatch is deliberately off the request path, so the response returns
    before the hook has fired and a test that asserts immediately sees nothing.

    DRAINS THE ACTUAL TASK rather than spending a fixed number of loop turns. A
    turn budget is a race dressed as a wait: it passes only while the stubbed
    coroutine happens to finish inside the budget, so on a loaded or slow runner
    the same code observes nothing and the assertion fails -- a flake that reads as
    a defect in the writer and reproduces nowhere locally. Awaiting the task makes
    the wait a fact about the task instead of about the machine.

    Falls back to yielding when nothing was scheduled, so a caller that asserts
    NOTHING fired still gets a turn for anything else pending.
    """
    await _drain(require=False)
    for _ in range(4):
        await asyncio.sleep(0)


async def _settle_dispatch() -> None:
    """Await the REAL dispatch task to completion, not just a few loop turns.

    ``_settle`` is sufficient only when ``_fire_session_lane_changed`` itself is
    stubbed. The real ``ScriptHookStore.fire`` awaits ``asyncio.to_thread`` twice
    -- once to evaluate a matcher, once to persist status bookkeeping -- and a
    thread round-trip cannot complete on bare ``sleep(0)`` turns however many you
    take. A test that drives the genuine fire path through ``_settle`` therefore
    observes NOTHING and passes vacuously no matter what the code does, which is
    exactly how an earlier version of the fan-out test below passed while
    asserting nothing at all.
    """
    await _drain(require=True)


async def _drain(*, require: bool = True) -> None:
    """Await every queued delta to completion, not a fixed number of loop turns.

    A turn budget is a race dressed as a wait: it passes only while the stubbed
    coroutine happens to finish inside the budget, so on a loaded runner the same
    code observes nothing and the assertion fails -- a flake that reads as a
    defect in the writer and reproduces nowhere locally. ``Queue.join`` makes the
    wait a fact about the work instead of about the machine.

    ``require`` guards the vacuous pass: with the real fire path a test that
    never enqueued anything would sail through ``join`` and assert against an
    empty list no matter what the code did.
    """
    from kiro_crew import hooks as H

    if require:
        assert _accepted.count > 0, "no delta was accepted -- the test would prove nothing"
    if H._LANE_QUEUE is not None:
        await asyncio.wait_for(H._LANE_QUEUE.join(), timeout=15)


def _lane(state, name: str) -> str:
    """Create a status tag (a board lane) and return its id.

    Built explicitly rather than read from the seeded vocabulary: seeding is a
    behaviour of a different code path, so depending on it here would make this
    file fail for a reason that has nothing to do with the event.
    """
    return create_tag_definition(state, name, status=True)["id"]


@pytest.fixture(autouse=True)
def _isolate_dispatch_state():
    """Drop the module-global queues and workers around every test in this file.

    The queues and their workers are shared mutable state, and the workers are
    bound to ONE event loop while the suite runs a fresh loop per test. Left
    dirty, a queue from an earlier test satisfies ``_drain``'s "something was
    accepted" assertion without this test having enqueued anything -- an
    order-dependent pass that only shows up under randomised ordering.

    Also installs the acceptance spy, for the same isolation reason: the count
    is per-test and must not carry over.
    """
    from kiro_crew.hooks import _reset_lane_dispatch_state

    _reset_lane_dispatch_state()
    _accepted.count = 0
    real_put = asyncio.Queue.put_nowait

    def _counted(queue, item):
        real_put(queue, item)  # raises QueueFull BEFORE the count on a full queue
        if isinstance(item, tuple) and len(item) == 2:
            if isinstance(item[1], hooks.SessionLaneDelta):
                _accepted.count += 1

    with patch.object(asyncio.Queue, "put_nowait", _counted):
        yield
    _reset_lane_dispatch_state()


class TestLaneDeletionFires:
    """Deleting a status tag is a lane transition and must fire.

    Every session holding that tag just left the lane. Without this a hook bound
    to ``*removed:done*`` for cleanup automation silently misses lane deletion --
    the exact polling gap the event exists to close -- so "fires when status tags
    change" would be untrue of one of the writers that changes them.
    """

    @pytest.mark.asyncio
    async def test_deleting_a_status_tag_fires_for_each_holder(self, tmp_path, monkeypatch):
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = [lane]
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.delete(f"/api/chat/tags/{lane}")
                await _settle()

        assert resp.status == 200
        assert len(seen) == 1, f"a status-tag deletion must fire once per holder; got {seen!r}"
        assert seen[0]["removed"] == [lane]
        assert seen[0]["added"] == []
        # The id token must survive even though the vocabulary entry is gone, or a
        # matcher could never match a deletion.
        assert f"removed:{lane}" in hooks._session_lane_matcher_context(
            seen[0]["added"], seen[0]["removed"]
        )
        assert seen[0]["slot_key"] == "s1", "the key the dashboard: prefix derives from"

    @pytest.mark.asyncio
    async def test_deleting_a_NON_status_tag_stays_quiet(self, tmp_path, monkeypatch):
        """Scope control: a plain label carries no lane meaning."""
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            plain = await (await client.post("/api/chat/tags", json={"name": "repo"})).json()
            assert not plain.get("status"), "fixture must be a non-status tag"
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = [plain["id"]]
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.delete(f"/api/chat/tags/{plain['id']}")
                await _settle()

        assert resp.status == 200
        assert state._slots["s1"].tags == []  # the strip still happened
        assert seen == [], "deleting a non-status tag is not a lane transition"


class TestOnlyIdTokensAreEmitted:
    """The matcher grammar carries tag IDS only -- names are payload, not contract.

    Name tokens were dropped as a deliberate subtraction. They existed only to
    make a matcher readable, and they cost: a user-controlled string reaching a
    structural grammar needed an injective escape encoder purely to stop one lane
    forging another's token, and the resulting spelling (``*added:In_20Review*``
    for a lane shown as ``In Review``) had to become frozen contract at the first
    subscriber. Ids already select a lane, are rename-proof, and carry no
    separator to escape.

    The asymmetry is what settles it: adding name tokens later is ADDITIVE, while
    removing them later is BREAKING, and the event ships with zero subscribers --
    so the cheapest moment to not freeze that grammar is now. A subscriber that
    wants the human-readable name reads ``added``/``removed``/``tags`` from the
    payload, which carries the ids it can resolve.
    """

    def test_a_lane_name_contributes_no_token(self):
        ctx = hooks._session_lane_matcher_context(["t1"], [])
        assert ctx == "added:t1;", f"expected the id token alone, got {ctx!r}"

    def test_both_directions_are_id_only(self):
        ctx = hooks._session_lane_matcher_context(["t-new"], ["t-old"])
        assert ctx == "added:t-new; removed:t-old;", ctx

    def test_no_user_controlled_text_can_reach_the_grammar(self):
        """The forgery surface is removed rather than escaped.

        With names gone the only token source is an id, so there is no
        user-controlled string to sanitize -- which is why the injective escape
        encoder and its collision pins went with them. What is retained is an
        ALLOWLIST validating persisted ids, not the encoder.
        """
        assert not hasattr(hooks, "_encode_token"), "the escape encoder should be gone"
        assert hooks._is_token_safe("a3f9c21b0e44") is True
        assert hooks._is_token_safe("has space") is False

    def test_a_malformed_persisted_id_cannot_forge_a_token(self):
        """Ids are generated hex, but ``tags.json`` is persisted state.

        A corrupt or hand-edited id carrying a separator would still split into two
        tokens or forge a direction, so the id is validated structurally and skipped
        when it cannot be a token. Skipping degrades matching for that one tag; it
        does not fire the wrong hook.
        """
        ctx = hooks._session_lane_matcher_context(["ok", "has space", "has:colon", ""], [])
        assert ctx == "added:ok;", f"a malformed id reached the grammar: {ctx!r}"

    def test_a_glob_metacharacter_id_cannot_reach_the_grammar(self):
        """The grammar is consumed by ``fnmatch``, so a wildcard id is refused.

        Refusing only the three separators still admitted glob metacharacters. An
        id of ``*`` makes the selector written for it -- ``*added:*;*`` -- match
        EVERY lane change, so that tag's hook would run on sessions it was never
        registered for.
        """
        import fnmatch

        for meta in ("*", "?", "[a-z]", "a*b", "tag?", "[", "]"):
            assert hooks._is_token_safe(meta) is False, f"{meta!r} must not be a token"

        assert fnmatch.fnmatch(
            "added:*;", "*added:*;*"
        ), "control: a wildcard token really does forge this match"

        ctx = hooks._session_lane_matcher_context(["*"], [])
        assert ctx == "", f"a wildcard id reached the grammar: {ctx!r}"
        assert not fnmatch.fnmatch(ctx, "*added:*;*"), "the wildcard id forged a match"

        assert hooks._is_token_safe("0123456789ab") is True, "a generated id"
        assert hooks._is_token_safe("implementation") is True, "a seeded lane key"
        assert hooks._is_token_safe("t-new_1") is True, "hyphen and underscore"

    def test_two_ids_differing_only_in_case_cannot_alias(self):
        """The allowlist must agree with the matcher, which folds case.

        ``_context_matches`` lowercases both sides, so admitting an uppercase id
        would let two DISTINCT lanes share one token and fire each other's hooks.
        The allowlist refuses them instead, which skips matching for that one tag
        rather than firing the wrong lane's hook.
        """
        import fnmatch

        # The mechanism, asserted rather than assumed: matching really does fold case.
        assert fnmatch.fnmatch("added:abc;".lower(), "*added:ABC;*".lower()) is True

        assert hooks._is_token_safe("A3F9C21B0E44") is False, "uppercase must be refused"
        assert hooks._is_token_safe("MixedCase12") is False, "mixed case must be refused"
        # Positive controls: every shape a real id actually takes still passes.
        assert hooks._is_token_safe("a3f9c21b0e44") is True, "a generated hex id"
        assert hooks._is_token_safe("implementation") is True, "a seeded lane key"


class TestThePayloadKeysAreAlwaysPresent:
    """All three keys are stamped even when the caller supplies only some.

    The four event-specific ``fire`` kwargs were collapsed into one ``event_payload``
    mapping (review-flagged: the signature would otherwise widen once per future
    event, and ``SessionTagsChanged`` is already reserved). That moved key naming to
    the caller, which reintroduces a hazard the kwargs could not have: a caller
    omitting a key would hand a hook a payload missing it, and a hook that always
    reads ``added`` would KeyError on a removal-only change.

    So defaults are stamped BEFORE the caller's mapping is applied. A negative
    control caught this as unpinned -- deleting the defaults left every existing test
    passing, because the production caller happens to supply all four.
    """

    @pytest.mark.asyncio
    async def test_a_partial_payload_is_completed_with_defaults(self, tmp_path):
        import kiro_crew.hooks as H

        seen: list[dict] = []

        async def _capture(h, context="", hook_event=None):
            seen.append(dict(hook_event or {}))
            return H.ScriptHookResult(hook_id=h.id, hook_name=h.name, event=h.event)

        store = H.ScriptHookStore(config_dir=tmp_path)
        store._hooks = {
            "h": H.ScriptHook(
                id="h",
                name="h",
                event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
                command="true",
            )
        }
        store._publish_snapshot()

        with patch.object(H, "run_script_hook", _capture):
            # Deliberately partial: only the added half, as a future caller might.
            await store.fire(
                H.HOOK_EVENT_SESSION_LANE_CHANGED,
                context="added:t1",
                event_payload={"added": ["t1"]},
            )

        assert len(seen) == 1, seen
        ev = seen[0]
        for key, empty in (("slot", ""), ("removed", [])):
            assert key in ev, f"{key!r} missing -- a hook reading it would KeyError: {ev!r}"
            assert ev[key] == empty, f"{key!r} should default to {empty!r}, got {ev[key]!r}"
        assert ev["added"] == ["t1"], "the caller's own value must survive the defaults"


class TestDeltaIsStatusOnly:
    """A bundled edit must not leak a non-status tag into the delta.

    The fire GATE is status-filtered, but that only decides whether to fire. If the
    delta itself came from the raw set difference, one request changing a lane AND a
    plain label would put `added:<label>` in the matcher context, so a hook could
    match a non-status tag -- contradicting the status-only contract.
    """

    @pytest.mark.asyncio
    async def test_a_bundled_edit_yields_only_the_status_tag(self, tmp_path, monkeypatch):
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            label = await (await client.post("/api/chat/tags", json={"name": "repo"})).json()
            label_id = label["id"]
            assert not label.get("status"), "fixture must be a NON-status tag"

            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = []
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                # ONE request adding both: a lane AND a plain label.
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [lane, label_id]})
                await _settle()

        assert resp.status == 200
        assert set(state._slots["s1"].tags) == {lane, label_id}, "both tags must still apply"
        assert len(seen) == 1, f"a status transition happened, so it must fire once: {seen!r}"
        ev = seen[0]
        assert ev["added"] == [lane], f"the delta must name ONLY the status tag: {ev['added']!r}"
        assert label_id not in ev["added"] and label_id not in ev["removed"]
        ctx = hooks._session_lane_matcher_context(ev["added"], ev["removed"])
        assert label_id not in ctx, (
            "a non-status id in the matcher context is the observable leak: " f"{ctx!r}"
        )
        assert "repo" not in ctx, "nor its display name"

    @pytest.mark.asyncio
    async def test_a_label_only_edit_still_does_not_fire(self, tmp_path, monkeypatch):
        """Control: filtering the delta must not start firing on label-only edits."""
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            label_id = (await (await client.post("/api/chat/tags", json={"name": "repo"})).json())[
                "id"
            ]
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = []
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [label_id]})
                await _settle()

        assert resp.status == 200
        assert seen == [], f"a label-only edit is not a lane transition: {seen!r}"

    @pytest.mark.asyncio
    async def test_the_filtered_delta_is_never_empty_when_it_fires(self, tmp_path, monkeypatch):
        """The regression the filtering could have introduced, pinned directly.

        An EMPTY delta would be worse than a wrong one: ``fire`` consults a matcher
        only when the context is non-empty, so an empty context skips filtering and
        runs EVERY hook for the event.
        """
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            done = _lane(state, "Done")
            doing = _lane(state, "Doing")
            label_id = (await (await client.post("/api/chat/tags", json={"name": "repo"})).json())[
                "id"
            ]
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = [doing, label_id]
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                # Lane swap bundled with dropping the label.
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [done]})
                await _settle()

        assert resp.status == 200
        assert len(seen) == 1
        ev = seen[0]
        assert ev["added"] == [done] and ev["removed"] == [doing], ev
        assert label_id not in ev["removed"], "the dropped label must not appear in the delta"
        ctx = hooks._session_lane_matcher_context(ev["added"], ev["removed"])
        assert ctx.strip(), "an empty context would run EVERY hook"
        assert hooks._context_matches(f"*added:{done}*", "glob", ctx) is True
        assert hooks._context_matches(f"*removed:{doing}*", "glob", ctx) is True


class TestBulkDeletionShedsNoHolder:
    """A lane can have more holders than the worker pool, and each is a transition.

    The scheduler this replaced capped CONCURRENCY and dropped everything past the
    cap, so a cleanup hook missed most holders on a widely-used lane -- the very
    gap that firing from the delete path was added to close. The queue must ABSORB
    the fan-out: deferring the work is acceptable, losing it is not.
    """

    @pytest.mark.asyncio
    async def test_more_holders_than_the_worker_pool_all_fire(self):
        import kiro_crew.hooks as H

        fired: list[str] = []

        async def _record(store, **kw):
            fired.append(kw["slot_key"])

        n = 20
        items = [
            H.SessionLaneDelta(
                slot_key=f"s{i}",
                added=[],
                removed=["lane"],
                is_current=lambda: True,
            )
            for i in range(n)
        ]
        with patch.object(H, "_fire_session_lane_changed", _record):
            await H.dispatch_session_lane_changed_bulk(_StoreStub(), items=items)
            assert (
                _accepted.count == n
            ), "the whole fan-out must be accepted, not shed at a concurrency cap"
            await _drain()

        # Compared as SETS: the guarantee asserted here is that no holder is
        # lost. Order is checked by the per-session test below.
        assert sorted(fired) == sorted(
            f"s{i}" for i in range(n)
        ), f"{n - len(fired)} holders were shed; got {len(fired)}"

    @pytest.mark.asyncio
    async def test_one_session_keeps_its_own_order(self):
        """Per-session ordering is the invariant the single FIFO protects.

        A pool would reorder freely. Across sessions that is harmless; within a
        single session it is not -- a card dragged out of a lane and back again
        would deliver "left" and "entered" in either order, and the close-out
        subscriber this event was built for acts irreversibly on whichever it
        sees first.

        The sleep below is UNEVEN deliberately. A bare ``sleep(0)`` is not a
        discriminator: a round-robin drain matches the expected order by
        coincidence, so the test would pass against the very hazard it is meant
        to catch -- measured, this control did not fire until the sleep was made
        uneven. Making the FIRST delta the slow one separates them: one FIFO
        still delivers it first, while any concurrent drain finishes later work
        while this one sleeps.
        """
        import kiro_crew.hooks as H

        seen: list[str] = []

        async def _record(store, **kw):
            # Uneven on purpose -- see the docstring.
            await asyncio.sleep(0.05 if kw["added"][0] == "l0" else 0)
            seen.append(kw["added"][0])

        items = [
            H.SessionLaneDelta(
                slot_key="one-session",
                added=[f"l{i}"],
                removed=[],
                is_current=lambda: True,
            )
            for i in range(12)
        ]
        with patch.object(H, "_fire_session_lane_changed", _record):
            await H.dispatch_session_lane_changed_bulk(_StoreStub(), items=items)
            await _drain()

        assert seen == [
            f"l{i}" for i in range(12)
        ], f"one session's own deltas were reordered: {seen!r}"

    @pytest.mark.asyncio
    async def test_one_failing_fire_does_not_strand_the_rest(self):
        import kiro_crew.hooks as H

        fired: list[str] = []

        async def _record(store, **kw):
            if kw["slot_key"] == "s1":
                raise RuntimeError("hook unreachable")
            fired.append(kw["slot_key"])

        items = [
            H.SessionLaneDelta(
                slot_key=f"s{i}",
                added=[],
                removed=["l"],
                is_current=lambda: True,
            )
            for i in range(3)
        ]
        with patch.object(H, "_fire_session_lane_changed", _record):
            await H.dispatch_session_lane_changed_bulk(_StoreStub(), items=items)
            await _drain()

        assert sorted(fired) == ["s0", "s2"], f"a failing fire stranded the rest: {fired!r}"

    @pytest.mark.asyncio
    async def test_empty_or_storeless_bulk_is_refused_without_accepting(self):
        import kiro_crew.hooks as H

        await H.dispatch_session_lane_changed_bulk(_StoreStub(), items=[])
        one = H.SessionLaneDelta(slot_key="s", added=[], removed=["l"], is_current=lambda: True)
        await H.dispatch_session_lane_changed_bulk(None, items=[one])
        assert _accepted.count == 0


class TestDispatchIsBounded:
    """Absorbing a burst must not become absorbing without limit.

    Each queued delta is memory, and a queue nobody drains is exactly the
    unbounded scheduler the bound exists to prevent -- so the ceiling survives the
    move from concurrency to depth. It is reached only when hooks are not draining
    at all, which is why crossing it is audited rather than silent: a shed cleanup
    is otherwise indistinguishable from a hook that ran and did nothing.
    """

    @pytest.mark.asyncio
    async def test_overflow_past_the_bound_is_refused_and_audited(self, monkeypatch):
        import kiro_crew.hooks as H

        audits: list[dict] = []

        class _Sel:
            def log_api_access(self, **kw):
                audits.append(kw)

        async def _record(store, **kw):
            return None

        monkeypatch.setattr(H, "sel", lambda: _Sel())
        # Depth 2, so the bound is reached by arithmetic: the dispatcher never
        # awaits, so every put lands before the worker can run even once.
        monkeypatch.setattr(H, "_LANE_QUEUE_MAXSIZE", 2)
        H._reset_lane_dispatch_state()

        items = [
            H.SessionLaneDelta(
                slot_key=f"s{i}",
                added=[],
                removed=["l"],
                is_current=lambda: True,
            )
            for i in range(5)
        ]
        with patch.object(H, "_fire_session_lane_changed", _record):
            await H.dispatch_session_lane_changed_bulk(_StoreStub(), items=items)

        assert _accepted.count == 2, (
            "the bound must be hard: " f"{_accepted.count} accepted against a depth of 2"
        )
        rejected = [a for a in audits if a.get("outcome") == "rejected"]
        assert rejected, f"the drop must be audited, not silent; got {audits!r}"
        # The audit ``operation`` is a QUERYABLE surface, and it is the one the
        # pre-merge rename first missed. The spec reserves ``SessionTagsChanged``
        # for a future all-tags event, so a stale ``hooks.session_tags_changed``
        # here would make that event's audit records indistinguishable from this
        # one's. Pinned so a later rename cannot silently leave it behind.
        assert rejected[0].get("operation") == "hooks.session_lane_changed", (
            "audit operation must track the event name: " f"{rejected[0].get('operation')!r}"
        )
        err = rejected[0].get("error") or ""
        assert "queue full" in err, f"the audit must name the cause: {err!r}"
        assert "3 hook(s) not run" in err, f"the audit must name the loss: {err!r}"
        # Every shed slot must be identifiable from the record, not just counted.
        assert "s4" in (rejected[0].get("resources") or "")

    @pytest.mark.asyncio
    async def test_under_the_bound_it_still_runs(self):
        """The bound must not be so eager that the normal path stops working."""
        import kiro_crew.hooks as H

        fired: list[str] = []

        async def _record(store, **kw):
            fired.append(kw["slot_key"])

        with patch.object(H, "_fire_session_lane_changed", _record):
            await H.dispatch_session_lane_changed_bulk(
                _StoreStub(),
                items=[
                    H.SessionLaneDelta(
                        slot_key="s1",
                        added=["a"],
                        removed=[],
                        is_current=lambda: True,
                    )
                ],
            )
            await _drain()

        assert fired == ["s1"]

    @pytest.mark.asyncio
    async def test_no_store_is_refused_without_accepting(self):
        """Refused for the RIGHT reason: no store, not merely no event loop.

        Deliberately async. Run synchronously this assertion passes vacuously --
        with the store check removed there is no running loop, so the queue lookup
        returns ``None`` and the refusal still happens, leaving the test unable to
        tell the two causes apart. Under a running loop only the store check can
        produce it.
        """
        import kiro_crew.hooks as H

        assert asyncio.get_running_loop() is not None  # the discriminator
        await H.dispatch_session_lane_changed_bulk(
            None,
            items=[
                H.SessionLaneDelta(
                    slot_key="s1",
                    added=["a"],
                    removed=[],
                    is_current=lambda: True,
                )
            ],
        )
        # The observable: nothing was accepted. Under a running loop this can only
        # be the store check, which is what makes the refusal attributable.
        assert _accepted.count == 0


class TestMatcherGrammarLivesWithTheEvent:
    """The token grammar is the EVENT's contract, so it lives beside the event."""

    def test_builder_is_exported_from_hooks(self):
        from kiro_crew.hooks import _session_lane_matcher_context

        assert callable(_session_lane_matcher_context)

    def test_grammar_is_direction_tagged_and_carries_ids(self):
        from kiro_crew.hooks import _session_lane_matcher_context

        ctx = _session_lane_matcher_context(["t-done"], ["t-review"])
        assert "added:t-done" in ctx and "removed:t-review" in ctx
        # Names are payload, never grammar -- see TestOnlyIdTokensAreEmitted.
        assert "Done" not in ctx and "Review" not in ctx, ctx

    def test_a_bare_lane_id_matches_nothing_under_default_glob(self):
        """The documented trap, pinned: whole-string fnmatch needs wildcards."""
        from kiro_crew.hooks import _context_matches, _session_lane_matcher_context

        ctx = _session_lane_matcher_context(["t-done"], [])
        assert _context_matches("t-done", "glob", ctx) is False, "bare id must not match"
        assert _context_matches("*added:t-done*", "glob", ctx) is True
        assert _context_matches("*removed:t-done*", "glob", ctx) is False
        # contains mode needs no wildcards -- also documented.
        assert _context_matches("added:t-done", "contains", ctx) is True

    def test_a_selector_for_a_short_id_does_not_fire_on_an_id_it_prefixes(self):
        """A documented selector must not match a DIFFERENT, longer lane id.

        Matching is whole-string ``fnmatch``, so without a boundary a selector
        written for a short id also matches every longer id starting with it --
        and the hook that runs then belongs to a different lane, which for a
        close-out hook means an irreversible action on the wrong session. Two real
        ids are ``uuid4().hex[:12]`` and cannot prefix each other, but ``tags.json``
        is hand-editable, the same path the token validator already guards for
        whitespace and ``:``.

        Pinned with the SHORT id as the selector and the LONG id as the context,
        which is the only direction that can collide: the reverse never matches.
        """
        from kiro_crew.hooks import _context_matches, _session_lane_matcher_context

        short_ctx = _session_lane_matcher_context(["abc"], [])
        long_ctx = _session_lane_matcher_context(["abcdef"], [])
        assert short_ctx == "added:abc;", short_ctx
        assert long_ctx == "added:abcdef;", long_ctx

        # The discriminator: the documented selector for the short lane.
        selector = "*added:abc;*"
        assert (
            _context_matches(selector, "glob", short_ctx) is True
        ), "the selector must still match its OWN lane"
        assert (
            _context_matches(selector, "glob", long_ctx) is False
        ), "a selector for 'abc' fired on lane 'abcdef' -- the wrong hook runs"

    def test_the_any_movement_selector_does_not_fire_on_an_id_it_suffixes(self):
        """The direction-FREE selector must not match a lane whose id ENDS with it.

        The sibling test above covers the PREFIX direction, which the trailing ``;``
        already bounded. This is the other end: a context for lane ``xabc`` is
        ``added:xabc;``, which CONTAINS ``abc;``, so an un-anchored ``*abc;*`` fires
        for a hook bound to lane ``abc`` and a close-out hook acts irreversibly on
        the wrong session. The documented form carries the ``:`` that already
        precedes every id, and ``:`` is outside the id allowlist so it cannot be
        forged -- making ``:<id>;`` matchable only at a token boundary.
        """
        from kiro_crew.hooks import _context_matches, _session_lane_matcher_context

        own = _session_lane_matcher_context(["abc"], [])
        other = _session_lane_matcher_context(["xabc"], [])
        assert own == "added:abc;", own
        assert other == "added:xabc;", other

        # The DOCUMENTED any-movement selector, both modes.
        for mode, selector in (("glob", "*:abc;*"), ("contains", ":abc;")):
            assert (
                _context_matches(selector, mode, own) is True
            ), f"{mode}: the selector must still match its OWN lane"
            assert (
                _context_matches(selector, mode, other) is False
            ), f"{mode}: a selector for 'abc' fired on lane 'xabc' -- the wrong hook runs"

        # Any movement still means EITHER direction; the bound costs nothing there.
        assert (
            _context_matches("*:abc;*", "glob", _session_lane_matcher_context([], ["abc"])) is True
        )

        # Why the form changed: the un-anchored spelling really does collide.
        assert (
            _context_matches("*abc;*", "glob", other) is True
        ), "un-anchored selector no longer collides -- this test no longer discriminates"

    def test_an_id_carrying_the_terminator_cannot_forge_a_boundary(self):
        """A hand-edited id containing ``;`` is refused, not emitted.

        The terminator is only a boundary while an id cannot contain one; an id
        such as ``a;added:b`` would otherwise forge a second token and a direction
        it never had.
        """
        from kiro_crew.hooks import _is_token_safe, _session_lane_matcher_context

        assert _is_token_safe("a;added:b") is False
        assert _session_lane_matcher_context(["a;added:b"], []) == ""


class TestEventRegistration:
    def test_event_is_registered(self):
        assert HOOK_EVENT_SESSION_LANE_CHANGED in HOOK_EVENTS

    def test_event_is_not_a_kiro_cli_event(self):
        """It must NOT reach the generated kiro-cli agent config.

        NOT a bare ``not in _VALID_HOOK_EVENTS`` assertion: that set is camelCase
        (``preToolUse``, ``stop`` -- agent.py:1528), so NO PascalCase name is ever
        a member and the assertion passes for every string ever written. It would
        keep passing if the exclusion broke, which is the definition of vacuous.

        So drive the actual filter, ``_kiro_hooks_only``, and pin that it strips
        the event under BOTH spellings -- the PascalCase name this event really
        uses, and the camelCase form someone would add if they tried to make it a
        kiro-cli event -- with a positive control proving the filter keeps what it
        should.
        """
        from kiro_crew.agent import _VALID_HOOK_EVENTS, _kiro_hooks_only

        camel = "sessionTagsChanged"
        submitted = {
            HOOK_EVENT_SESSION_LANE_CHANGED: [{"command": "x"}],
            camel: [{"command": "y"}],
            "stop": [{"command": "keep"}],
        }
        kept = _kiro_hooks_only(submitted)

        assert "stop" in kept, f"positive control: the filter must keep a real event; {kept!r}"
        assert HOOK_EVENT_SESSION_LANE_CHANGED not in kept
        assert camel not in kept, (
            "the camelCase spelling must be stripped too, or adding it to "
            "defaults.json would silently make it a kiro-cli event"
        )
        # Guards the premise above: if this set ever became PascalCase, the
        # camelCase half of this test would stop meaning anything.
        assert all(
            not e[:1].isupper() for e in _VALID_HOOK_EVENTS
        ), f"_VALID_HOOK_EVENTS is no longer camelCase; revisit this test: {sorted(_VALID_HOOK_EVENTS)!r}"

    def test_event_is_registrable_through_the_api(self):
        """A supported surface must be able to register a hook for it.

        Without this the hook create/update API rejects the event and
        hand-editing hooks.json is the only way to register one, which makes the
        feature unusable through any supported path.
        """
        from kiro_crew.validation import ALLOWED_HOOK_EVENTS

        assert HOOK_EVENT_SESSION_LANE_CHANGED in ALLOWED_HOOK_EVENTS

    def test_three_event_allowlists_diverge_intentionally(self):
        """Pin all three memberships AND the reason, so neither side drifts.

        Three allowlists govern this event and they do NOT agree. Each membership
        is load-bearing in a different direction, so a follow-up must not "fix"
        the divergence by syncing them:

        * ``HOOK_EVENTS``          -- IN. The dispatcher must be able to fire it.
        * ``ALLOWED_HOOK_EVENTS``  -- IN. The registration API must accept it, or
          no supported surface can create such a hook.
        * ``_VALID_HOOK_EVENTS``   -- OUT. kiro-cli rejects a generated agent
          config naming an event it does not know, so including it there breaks
          the config for every agent.

        Asserted as one test rather than three so the rationale lives beside the
        contradiction it explains.
        """
        from kiro_crew.agent import _VALID_HOOK_EVENTS
        from kiro_crew.validation import ALLOWED_HOOK_EVENTS

        assert HOOK_EVENT_SESSION_LANE_CHANGED in HOOK_EVENTS
        assert HOOK_EVENT_SESSION_LANE_CHANGED in ALLOWED_HOOK_EVENTS
        assert HOOK_EVENT_SESSION_LANE_CHANGED not in _VALID_HOOK_EVENTS


class TestFiresFromTagWriters:
    @pytest.mark.asyncio
    async def test_put_tags_fires_with_delta(self, tmp_path, monkeypatch):
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            state._slots["s1"] = _ChatSlot("s1")
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [lane]})
                await _settle()

        assert resp.status == 200
        assert len(seen) == 1
        assert seen[0]["added"] == [lane]
        assert seen[0]["removed"] == []
        assert seen[0]["slot_key"] == "s1"

    @pytest.mark.asyncio
    async def test_drop_fires_and_reports_the_replaced_lane(self, tmp_path, monkeypatch):
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            first = _lane(state, "Implementation")
            second = _lane(state, "Done")
            slot = _ChatSlot("s1")
            slot.tags = [first]
            state._slots["s1"] = slot
            col = await (
                await client.post(
                    "/api/chat/tag-columns", json={"name": "Done", "tag_ids": [second]}
                )
            ).json()
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.post("/api/chat/slots/s1/drop", json={"column_id": col["id"]})
                await _settle()

        assert resp.status == 200
        assert len(seen) == 1
        assert seen[0]["added"] == [second]
        assert seen[0]["removed"] == [first]


class TestScope:
    @pytest.mark.asyncio
    async def test_non_status_tag_does_not_fire(self, tmp_path, monkeypatch):
        """maybe_auto_tag writes non-status tags routinely; those must stay quiet."""
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            plain = await (await client.post("/api/chat/tags", json={"name": "repo"})).json()
            assert not plain.get("status"), "fixture must be a non-status tag"
            state._slots["s1"] = _ChatSlot("s1")
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [plain["id"]]})
                await _settle()

        assert resp.status == 200
        assert state._slots["s1"].tags == [plain["id"]]  # the write still happened
        assert seen == []


class TestCannotBlockTheWrite:
    @pytest.mark.asyncio
    async def test_hook_error_does_not_fail_the_response(self, tmp_path, monkeypatch):
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)

        async def _explode(store, **kw):
            raise RuntimeError("hook blew up")

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            state._slots["s1"] = _ChatSlot("s1")
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _explode),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [lane]})
                await _settle()

        assert resp.status == 200
        assert state._slots["s1"].tags == [lane]

    @pytest.mark.asyncio
    async def test_blocking_exit_code_is_ignored(self):
        """A hook exiting 2 blocks a PreToolUse call; here it must not.

        Asserted at the wrapper rather than through the handler: exit 2 is
        surfaced by the store's own result, and the wrapper's contract is that
        it returns normally regardless.
        """
        from kiro_crew.hooks import _fire_session_lane_changed

        class _BlockingStore:
            def __init__(self):
                self.calls = 0

            async def fire(self, event, **kw):
                self.calls += 1
                raise RuntimeError("simulated blocked hook")

        store = _BlockingStore()
        await _fire_session_lane_changed(store, slot_key="s1", added=["a"], removed=[])
        assert store.calls == 1  # it really did dispatch

    @pytest.mark.asyncio
    async def test_no_store_is_a_noop(self):
        from kiro_crew.hooks import _fire_session_lane_changed

        await _fire_session_lane_changed(None, slot_key="s1", added=["a"], removed=[])


class TestRefusedWriteDoesNotFire:
    """A write that was REFUSED and rolled back must not announce a change.

    Upstream pins each forced save with ``expected_history_key``; when the save
    refuses (session deleted or rebound mid-persist) the endpoint rolls the live
    tags back and answers with its rejection shape. The hook dispatch sits after
    ``push_slots_update()``, below every refusal's early return, so it must not
    fire -- otherwise a hook would act on a lane transition that never persisted
    and was undone in memory too.
    """

    @pytest.mark.asyncio
    async def test_refused_drop_does_not_fire(self, tmp_path, monkeypatch):
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async def _refuse(*a, **kw):
            return False  # the pinned save refused without writing

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            col = await (
                await client.post("/api/chat/tag-columns", json={"name": "Done", "tag_ids": [lane]})
            ).json()
            state._slots["s1"] = _ChatSlot("s1")
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop", _refuse),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.post("/api/chat/slots/s1/drop", json={"column_id": col["id"]})
                await _settle()

        assert resp.status == 200
        assert seen == [], "a refused, rolled-back drop must not fire SessionLaneChanged"
        # And the rollback really happened, so there was nothing to announce.
        assert state._slots["s1"].tags == []


class TestRemovalOnlyDoesNotFanOut:
    """An empty matcher context makes ``fire`` skip filtering entirely.

    ``ScriptHookStore.fire`` only consults a hook's matcher when the context is
    non-empty (``if hook.matcher: ... elif context:``), so a removal-only
    transition that produced no tokens would run EVERY hook registered for the
    event -- including ones deliberately narrowed to a different lane.
    """

    @pytest.mark.asyncio
    async def test_an_all_invalid_transition_refuses_rather_than_fanning_out(self):
        """The fan-out hazard, closed at its only reachable entrance.

        ``_session_lane_matcher_context`` SKIPS an id that fails token validation
        (``tags.json`` is persisted state a hand edit or a legacy writer can leave
        malformed), so a transition whose every id is unsafe yields an EMPTY
        context -- and ``fire`` consults a matcher only when the context is
        non-empty. Dispatching that runs every hook registered for the event, on a
        lane none of them named; for a destructive close-out hook that is the worst
        outcome available. The fire must refuse instead. Asserted at the store,
        because the observable is that ``fire`` is never reached.
        """
        from kiro_crew.hooks import _fire_session_lane_changed

        calls: list[dict] = []

        class _Store(_StoreStub):
            async def fire(self, event, **kw):
                calls.append(kw)
                return []

        # A space and a ``:`` are the two structural separators, so neither id can
        # be tokenized and the context comes out empty.
        await _fire_session_lane_changed(
            _Store(),
            slot_key="s1",
            added=["has space"],
            removed=["has:colon"],
        )
        assert calls == [], (
            "an empty matcher context reached fire, which SKIPS matcher filtering "
            f"and therefore runs every registered hook: {calls!r}"
        )

    @pytest.mark.asyncio
    async def test_a_valid_transition_still_reaches_fire_with_its_derived_context(self):
        """Counter-control: the guard must refuse ONLY the empty case.

        Without this, the test above also passes when the fire never dispatches at
        all -- which would silence the event rather than narrow it.
        """
        from kiro_crew.hooks import _fire_session_lane_changed

        calls: list[dict] = []

        class _Store(_StoreStub):
            async def fire(self, event, **kw):
                calls.append(kw)
                return []

        await _fire_session_lane_changed(
            _Store(), slot_key="s1", added=["t-done"], removed=["t-doing"]
        )
        assert len(calls) == 1, "a valid transition must still fire"
        ctx = calls[0]["context"]
        assert "added:t-done" in ctx and "removed:t-doing" in ctx, ctx

    @pytest.mark.asyncio
    async def test_a_partly_invalid_transition_still_fires_on_the_surviving_ids(self):
        """Degradation stays PER TAG: one malformed id must not silence the rest."""
        from kiro_crew.hooks import _fire_session_lane_changed

        calls: list[dict] = []

        class _Store(_StoreStub):
            async def fire(self, event, **kw):
                calls.append(kw)
                return []

        await _fire_session_lane_changed(
            _Store(),
            slot_key="s1",
            added=["t-ok", "has space"],
            removed=[],
        )
        assert len(calls) == 1, "a survivable id must still produce a fire"
        assert calls[0]["context"] == "added:t-ok;"

    @pytest.mark.asyncio
    async def test_removal_only_still_produces_a_matcher_context(self, tmp_path, monkeypatch):
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = [lane]
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": []})
                await _settle()

        assert resp.status == 200
        assert len(seen) == 1
        assert seen[0]["removed"] == [lane]
        assert seen[0]["added"] == []
        ctx = hooks._session_lane_matcher_context(seen[0]["added"], seen[0]["removed"])
        assert ctx, "a removal-only transition must not yield an empty matcher context"
        # Direction-tagged, so entering and leaving a lane are distinguishable.
        assert f"removed:{lane}" in ctx
        assert "added:" not in ctx, "a removal-only transition must emit no added: token"

    @pytest.mark.asyncio
    async def test_removal_only_fires_leave_hook_but_not_enter_hook(self, tmp_path, monkeypatch):
        """End to end, and DISCRIMINATING in both degenerate directions.

        Two hooks differing only in the direction they select. A removal must run
        the ``*removed:done*`` one and not the ``*added:done*`` one.

        This is deliberately built so it cannot pass for the wrong reason. Two
        earlier versions did. The first used a bare ``review`` matcher: the
        default glob mode fnmatches the WHOLE context, so ANY bare word fails and
        the assertion held without the matcher being consulted. The second still
        used ``_settle``, whose bare loop turns cannot complete the two
        ``asyncio.to_thread`` awaits inside the real ``fire`` -- so the dispatch
        never reached a hook and an empty ``ran`` was guaranteed regardless of the
        code. Hence ``_settle_dispatch`` (which asserts a task existed and awaits
        it) plus the leave-hook as a POSITIVE control: if the context were
        untagged its selector would not match either and ``ran`` would be empty;
        if the context were empty, ``fire`` would skip filtering and BOTH would run.
        """
        import kiro_crew.hooks as H

        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        ran: list[str] = []

        # Created before the store so the selectors can name the lane's real ID.
        # The grammar carries ids only, so a selector spelling the display name
        # ("*removed:done*") matches nothing -- which would make this test pass
        # for the wrong reason in the enter direction and fail in the leave one.
        lane = _lane(state, "Done")

        store = H.ScriptHookStore(config_dir=tmp_path)
        store._hooks = {
            "enter": H.ScriptHook(
                id="enter",
                name="on-enter-done",
                event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
                matcher=f"*added:{lane}*",
                command="true",
            ),
            "leave": H.ScriptHook(
                id="leave",
                name="on-leave-done",
                event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
                matcher=f"*removed:{lane}*",
                command="true",
            ),
        }
        store._publish_snapshot()

        async def _fake_run(h, context="", hook_event=None):
            ran.append(h.id)
            return H.ScriptHookResult(hook_id=h.id, hook_name=h.name, event=h.event)

        async with TestClient(TestServer(app)) as client:
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = [lane]
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: store),
                patch.object(H, "run_script_hook", _fake_run),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": []})
                await _settle_dispatch()

        assert resp.status == 200
        assert ran == ["leave"], (
            "a removal must run only the removed: selector -- "
            f"got {ran!r} (empty means the context is not direction-tagged; "
            "both means matcher filtering was skipped)"
        )


class TestGovernanceProfileIsConsulted:
    """The capability gate must resolve the ORIGINATING surface's profile.

    ``_script_hooks_capability_denied`` infers the surface from the session key
    it is handed. With no key it falls back to policy-only resolution, so a
    profile denying script hooks for the dashboard is never consulted and a
    profile-denied script runs.
    """

    @pytest.mark.asyncio
    async def test_dispatch_threads_the_effective_session_key(self, tmp_path, monkeypatch):
        """End-to-end, through the REAL fire, because the key is now derived there.

        This once patched ``_fire_session_lane_changed`` and asserted the key the
        WRITER passed it. The writer no longer passes one -- the fire derives it --
        so that assertion would now check a value the test itself supplied. Patching
        the hook STORE instead leaves the derivation under test and makes the
        assertion end-to-end: HTTP write in, ``parent_session_key`` out.
        """
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        class _Store(_StoreStub):
            async def fire(self, event, **kw):
                seen.append(kw)
                return []

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            state._slots["s1"] = _ChatSlot("s1")
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _Store()),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [lane]})
                await _settle()

        assert resp.status == 200
        assert len(seen) == 1
        # The PREFIXED form, not the bare slot id: sel._infer_source classifies
        # the dashboard surface off "dashboard:", and an unprefixed key hits the
        # bare-key "slack" fallback -- binding the wrong surface, not none.
        assert seen[0]["parent_session_key"] == "dashboard:s1"

    @pytest.mark.asyncio
    async def test_wrapper_forwards_the_key_as_parent_session_key(self):
        from kiro_crew.hooks import _fire_session_lane_changed

        captured: dict = {}

        class _Store(_StoreStub):
            async def fire(self, event, **kw):
                captured.update(kw)
                return []

        await _fire_session_lane_changed(
            _Store(),
            slot_key="s1",
            added=["a"],
            removed=[],
        )
        # DERIVED, not passed: the prefixed form is now built inside the fire, so
        # this asserts the derivation itself rather than a value the test supplied.
        assert captured["parent_session_key"] == "dashboard:s1"

    @pytest.mark.asyncio
    async def test_gate_receives_the_session_key_from_the_hook_event(self, tmp_path):
        """run_script_hook resolves the gate against the threaded key."""
        import kiro_crew.hooks as H

        keys: list[str] = []

        def _gate(session_key: str = "") -> str | None:
            keys.append(session_key)
            return "denied by test profile"  # returns early, so nothing spawns

        hook = H.ScriptHook(
            id="h1", name="h1", event=H.HOOK_EVENT_SESSION_LANE_CHANGED, command="true"
        )
        with patch.object(H, "_script_hooks_capability_denied", _gate):
            result = await H.run_script_hook(
                hook, context="Done", hook_event={"parent_session_key": "dashboard:s1"}
            )

        assert keys == ["dashboard:s1"]
        assert "governance" in (result.error or "").lower()

    @pytest.mark.asyncio
    async def test_the_gate_never_walks_profiles_on_the_event_loop(self):
        """Every async caller resolves the gate off-loop, for EVERY event.

        Asserted behaviourally rather than by patching ``asyncio.to_thread``: a slow gate
        must not starve a concurrently scheduled coroutine. Resolved inline the ticker
        gets almost no turns. Driven on a PRE-EXISTING event on purpose -- the seam is
        unconditional, so scoping it back to one event must fail this.
        """
        import time

        import kiro_crew.hooks as H

        ticks: list[int] = []

        def _slow_gate(session_key: str = "") -> str | None:
            time.sleep(0.30)  # stands in for the profiles/ directory walk
            return "denied by test profile"  # returns early, so nothing spawns

        async def _ticker() -> None:
            for _ in range(60):
                await asyncio.sleep(0.005)
                ticks.append(1)

        hook = H.ScriptHook(
            id="h1", name="h1", event=H.HOOK_EVENT_USER_PROMPT_SUBMIT, command="true"
        )
        with patch.object(H, "_script_hooks_capability_denied", _slow_gate):
            ticker = asyncio.create_task(_ticker())
            await H.run_script_hook(hook, context="hello", hook_event={})
            ticker.cancel()

        assert len(ticks) > 5, (
            f"event loop starved during the governance lookup (only {len(ticks)} ticks) "
            "-- the capability gate is resolving inline on the loop"
        )


class TestAppTokensCannotTriggerLaneHooks:
    """An app caller must not have a lane hook run for it.

    The dispatch resolves the DASHBOARD profile's ``capabilities.script_hooks``,
    so if an app token that reaches these routes could dispatch, an app profile
    DENYING script hooks would still get a hook command executed on its behalf --
    the app's own governance never consulted. The event carries no app identity to
    resolve instead, so the only correct answer for an app caller is to skip.

    The tag write itself is still applied and still returns 200: the write is
    authorized, only the hook dispatch is not.
    """

    @pytest.mark.asyncio
    async def test_an_app_token_lane_change_does_not_fire(self, tmp_path, monkeypatch):
        """The PUT path: an app-token lane write applies but dispatches nothing."""
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        # The discriminator: this request carries an APP claim, not the dashboard "".
        app = _make_tags_app(state, app_identity="evil-app")
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = []
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [lane]})
                await _drain(require=False)

        assert resp.status == 200, "the WRITE is authorized -- only the dispatch is not"
        assert state._slots["s1"].tags == [lane], "the tag write must still apply"
        assert seen == [], (
            "an app token had a lane hook dispatched for it under the dashboard "
            f"profile -- its own script-hook denial was never consulted: {seen!r}"
        )

    @pytest.mark.asyncio
    async def test_an_app_token_drop_does_not_fire(self, tmp_path, monkeypatch):
        """The drop path: same gate, second of the three dispatch sites."""
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state, app_identity="evil-app")
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            col = await (
                await client.post("/api/chat/tag-columns", json={"name": "Done", "tag_ids": [lane]})
            ).json()
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = []
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.post("/api/chat/slots/s1/drop", json={"column_id": col["id"]})
                await _drain(require=False)

        assert resp.status == 200, resp.status
        assert seen == [], f"an app-token DROP dispatched a lane hook: {seen!r}"

    @pytest.mark.asyncio
    async def test_the_dashboard_user_still_fires(self, tmp_path, monkeypatch):
        """Positive control: the gate must not silence the dashboard caller.

        Without this, a gate that refused EVERYTHING would pass the two tests
        above while removing the feature.
        """
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)  # no app_identity -> the dashboard user
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = []
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [lane]})
                await _settle()

        assert resp.status == 200
        assert len(seen) == 1, f"the dashboard user must still fire exactly once: {seen!r}"

    @pytest.mark.asyncio
    async def test_an_app_token_denial_is_audited(self, tmp_path, monkeypatch):
        """A denial must leave a SEL permission-decision record.

        Without one the refusal is invisible: an app whose profile denies script
        hooks is indistinguishable from an app that never changed a lane, so the
        gate cannot be shown to have run at all. Asserts on the emitted RECORD
        rather than on the absence of a dispatch, because absence is what the
        sibling tests already cover and it cannot prove the audit happened.
        """
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state, app_identity="evil-app")
        audits: list[dict] = []

        class _Sel:
            def log_api_access(self, **kw):
                audits.append(kw)

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = []
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.sel", lambda: _Sel()),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [lane]})

        assert resp.status == 200, "the WRITE is authorized -- only the dispatch is not"
        denied = [a for a in audits if a.get("outcome") == "denied"]
        assert denied, (
            "the dispatch was refused for an app token with NO permission-decision "
            f"record -- the denial is unauditable; got {audits!r}"
        )
        # The operation is the QUERYABLE surface, and must match the overflow
        # audit in ``hooks`` so both refusals for this event share one operation.
        ops = {a.get("operation") for a in denied}
        assert (
            "hooks.session_lane_changed" in ops
        ), f"the denial must be queryable under this event's operation; got {ops!r}"
        rec = next(a for a in denied if a.get("operation") == "hooks.session_lane_changed")
        assert (
            rec.get("caller") == "evil-app"
        ), f"the record must name WHO was refused, not the surface; got {rec.get('caller')!r}"

    @pytest.mark.asyncio
    async def test_a_label_only_app_edit_audits_no_lane_denial(self, tmp_path, monkeypatch):
        """No lane transition means no lane-dispatch decision to audit.

        The permission gate EMITS a denial record, so consulting it before the
        status comparison made every app-token tag write -- a plain-label edit,
        or a no-op -- log a refusal for an event that was never going to fire.
        That inflates the denied count for
        ``operation="hooks.session_lane_changed"`` and disagrees with the delete
        path, which reaches its dispatch only once a status tag really went.
        """
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state, app_identity="evil-app")
        audits: list[dict] = []

        class _Sel:
            def log_api_access(self, **kw):
                audits.append(kw)

        async with TestClient(TestServer(app)) as client:
            label_id = create_tag_definition(state, "repo", status=False)["id"]
            state._slots["s1"] = _ChatSlot("s1")
            state._slots["s1"].tags = []
            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop"),
                patch("kiro_crew.dashboard.chat_tags.sel", lambda: _Sel()),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
            ):
                resp = await client.put("/api/chat/slots/s1/tags", json={"tags": [label_id]})

        assert resp.status == 200, "the write itself is authorized"
        lane_denials = [
            a
            for a in audits
            if a.get("outcome") == "denied" and a.get("operation") == "hooks.session_lane_changed"
        ]
        assert not lane_denials, (
            "a label-only edit changes no lane, so there is no dispatch decision "
            f"to refuse -- yet a denial was audited: {lane_denials!r}"
        )

    @pytest.mark.asyncio
    async def test_an_absent_claim_denial_is_audited_and_distinguished(self):
        """A missing claim is also a denial, and says so differently.

        An absent claim means the caller is not a confirmed dashboard caller --
        the middleware may not have run, or it ran and left the claim absent for
        a person -- so the two reasons must not collapse into one
        indistinguishable record.
        """
        from kiro_crew.dashboard import chat_tags as CT

        audits: list[dict] = []

        class _Sel:
            def log_api_access(self, **kw):
                audits.append(kw)

        with patch("kiro_crew.dashboard.chat_tags.sel", lambda: _Sel()):
            assert await CT._lane_dispatch_is_permitted({}) is False
            assert await CT._lane_dispatch_is_permitted({"app": "some-app"}) is False

        assert len(audits) == 2, f"both denials must be audited; got {audits!r}"
        errors = [a.get("error", "") for a in audits]
        assert (
            errors[0] != errors[1]
        ), f"the two denial reasons must be distinguishable in the record; got {errors!r}"
        assert audits[0].get("caller") == "unknown", audits[0].get("caller")
        assert audits[1].get("caller") == "some-app", audits[1].get("caller")

    @pytest.mark.asyncio
    async def test_an_absent_app_claim_does_not_dispatch(self):
        """FAIL-CLOSED: a missing claim means the middleware did not run.

        Read directly rather than through a client, because the point is the
        predicate's behaviour on a request the auth layer never stamped -- which a
        client wired to that layer cannot produce. A truthiness test would read
        this as the dashboard user and dispatch (CWE-269).
        """
        from kiro_crew.dashboard import chat_tags as CT

        class _Sel:
            def log_api_access(self, **kw):
                pass

        with patch("kiro_crew.dashboard.chat_tags.sel", lambda: _Sel()):
            assert await CT._lane_dispatch_is_permitted({}) is False, "absent claim"
            assert await CT._lane_dispatch_is_permitted({"app": None}) is False, "None fails closed"
            assert await CT._lane_dispatch_is_permitted({"app": "some-app"}) is False
            assert await CT._lane_dispatch_is_permitted({"app": ""}) is True, "the dashboard user"

    @pytest.mark.asyncio
    async def test_the_gate_records_denials_only(self):
        """The gate audits refusals; a permitted dispatch is recorded per hook RUN.

        The permitted decision is not left un-audited -- it is audited where the
        privileged thing happens, once per hook that actually runs, which the
        companion test below pins. Recording it here as well would file a row on
        every lane drag, including the default state where no hook can run.
        """
        from kiro_crew.dashboard import chat_tags as CT

        audits: list[dict] = []

        class _Sel:
            def log_api_access(self, **kw):
                audits.append(kw)

        with patch("kiro_crew.dashboard.chat_tags.sel", lambda: _Sel()):
            assert await CT._lane_dispatch_is_permitted({"app": ""}, resources="t1") is True

        assert audits == [], f"the gate must record denials only; got {audits!r}"

    @pytest.mark.asyncio
    async def test_a_permitted_hook_run_is_audited_by_its_outcome_row(self):
        """A permitted run is recorded ONCE, by its outcome -- not twice.

        The decision row this used to assert was redundant: every permitted run reaches
        an ``_audit_hook_invocation`` site carrying the same session key and the same
        label, so the decision is derivable from the outcome. Both halves are pinned
        here -- the outcome row must exist, and the decision row must NOT come back --
        because deleting one of a redundant pair is only safe while the survivor is
        guaranteed. The deny arm keeps its decision row: it returns before any outcome
        row can be written, which is asserted separately.
        """
        import kiro_crew.hooks as H
        import kiro_crew.sandbox as sandbox_module

        decisions: list[dict] = []
        invocations: list[dict] = []

        class _Sel:
            def log_governance_decision(self, **kw):
                decisions.append(kw)

            def log_tool_invocation(self, **kw):
                invocations.append(kw)

        hook = H.ScriptHook(
            id="h1",
            name="h1",
            event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
            command=f'"{sys.executable}" -c "pass"',
        )
        with patch.object(H, "sel", lambda: _Sel()):
            with patch.object(H, "_script_hooks_capability_denied", lambda sk="": None):
                with patch.object(sandbox_module, "_allow_unsandboxed_exec", lambda: True):
                    await H.run_script_hook(hook, context="c", hook_event={"session_key": "s1"})

        runs = [r for r in invocations if r.get("tool_kind") == "script_hook"]
        assert len(runs) == 1, f"a permitted run must leave one outcome row; got {invocations!r}"
        assert runs[0]["tool_name"] == "run_script_hook:h1", runs[0]
        assert runs[0]["session_key"] == "s1", runs[0]
        allowed = [d for d in decisions if d.get("outcome") == "allowed"]
        assert len(allowed) == 1, (
            "a permitted run must leave one `allowed` governance row: the governance log "
            f"is read on its own, so refusals-only cannot show a run was permitted; got {decisions!r}"
        )
        assert allowed[0]["tool_name"] == "run_script_hook:h1", allowed[0]

    def test_the_subscriber_precondition_reads_the_registry(self):
        """The writers skip the gate unless an enabled lane hook exists.

        Nothing can consume a dispatch with no subscriber, so neither the gate nor the
        queue is entered -- which also keeps a refusal from being audited for a lane
        change that could never have fired. Every arm is driven with a REAL store stub:
        asserting only the no-hook case would pass on an uninitialised store, which is
        False for a reason that has nothing to do with the registry.
        """
        import kiro_crew.hooks as H
        from kiro_crew.dashboard import chat_tags as CT

        def _stub(*events):
            return type(
                "_S",
                (),
                {
                    "list_all": lambda self, e=events: [
                        H.ScriptHook(id=f"h{i}", name=f"h{i}", event=ev, command="true")
                        for i, ev in enumerate(e)
                    ]
                },
            )()

        cases = [
            (None, False, "an uninitialised store cannot report a subscriber"),
            (_stub(), False, "no hook registered at all"),
            (_stub(H.HOOK_EVENT_USER_PROMPT_SUBMIT), False, "another event's hook"),
            (_stub(H.HOOK_EVENT_SESSION_LANE_CHANGED), True, "one enabled lane hook"),
            (
                _stub(H.HOOK_EVENT_USER_PROMPT_SUBMIT, H.HOOK_EVENT_SESSION_LANE_CHANGED),
                True,
                "a lane hook among others",
            ),
        ]
        for store, want, why in cases:
            with patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda s=store: s):
                assert CT._any_lane_hook_registered() is want, why

    def test_a_disabled_lane_hook_is_not_a_subscriber(self):
        """A toggled-off hook must not re-open the audit path it cannot reach."""
        import kiro_crew.hooks as H
        from kiro_crew.dashboard import chat_tags as CT

        off = H.ScriptHook(
            id="h1",
            name="h1",
            event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
            command="true",
            enabled=False,
        )
        store = type("_S", (), {"list_all": lambda self: [off]})()
        with patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: store):
            assert CT._any_lane_hook_registered() is False


class TestGateOffloadIsACallerSideWorkaround:
    """The ``to_thread`` seam exists ONLY because resolution is still synchronous.

    First Principles is right that this is symptom-level: the cause-level fix is
    non-blocking resolution (or a cached fingerprint) in the owning module, and the
    wrapper is a permanent seam a later fix must remember to unwind. This class is
    that reminder, expressed as a test rather than a description footnote -- when the
    cause IS fixed, this fails and names the seam to delete.
    """

    def test_the_gate_is_still_synchronous_so_the_seam_is_still_needed(self):
        """FAILS once resolution stops blocking -- then delete the wrapper.

        If ``_script_hooks_capability_denied`` becomes a coroutine, or the walk it
        performs is cached away, the offload has no remaining justification and
        ``_script_hooks_capability_denied_async`` plus both ``await`` sites should go.
        """
        import inspect

        import kiro_crew.hooks as H

        assert not inspect.iscoroutinefunction(H._script_hooks_capability_denied), (
            "the capability gate is no longer synchronous -- the cause-level fix has "
            "landed, so remove _script_hooks_capability_denied_async and await sites"
        )
        assert inspect.iscoroutinefunction(H._script_hooks_capability_denied_async), (
            "the offload seam is gone while the gate is still synchronous -- an async "
            "caller resolving it inline stalls the event loop"
        )


class TestWriterConventionHasOneSpelling:
    """A future writer must have ONE call to remember, not two in either order.

    The precondition is a PAIR -- is there a subscriber, and is this caller permitted --
    and a writer that remembers only one half dispatches either to nobody or for a
    caller the gate would have refused. It was previously spelled twice and differently
    (two early returns in one writer, two ``and`` terms in another), leaving the spec's
    writer table as the only thing keeping them in step. This asserts the structure
    instead, so drift fails the build rather than a review.
    """

    def _source(self) -> str:
        from pathlib import Path

        import kiro_crew.dashboard.chat_tags as CT

        return Path(CT.__file__).read_text(encoding="utf-8")

    def test_the_underlying_helpers_are_called_only_by_the_shared_predicate(self):
        """Each half is reachable from ONE place: ``_lane_dispatch_allowed``."""
        src = self._source()
        for helper in ("_any_lane_hook_registered", "_lane_dispatch_is_permitted"):
            # One definition, one use inside the predicate. A writer calling it
            # directly is a third occurrence and fails here.
            assert src.count(f"def {helper}") == 1, helper
            uses = src.count(f"{helper}(") - src.count(f"def {helper}(")
            assert uses == 1, (
                f"{helper} is called from {uses} place(s); every writer must go through "
                "_lane_dispatch_allowed so the pair cannot drift apart"
            )

    @pytest.mark.asyncio
    async def test_every_writer_goes_through_the_shared_predicate(self):
        """The predicate is the only precondition a writer spells."""
        src = self._source()
        assert src.count("def _lane_dispatch_allowed") == 1
        callers = src.count("_lane_dispatch_allowed(request") - 1  # minus the def line
        assert callers >= 2, (
            f"only {callers} writer(s) consult the shared precondition; the delete, PUT "
            "and drop paths must all reach a lane dispatch through it"
        )


class TestHookInvocationOutcomeIsAudited:
    """A permitted hook's RESULT must reach the audit trail, not only its permission.

    The governance helper records whether a hook was ALLOWED to run; this records what
    happened when it did. Both are needed: a permitted hook that crashed, hung or exited
    non-zero otherwise left the decision audited and the result visible only in process
    memory (``hook.last_status``), which no audit query can reach. Keyed on the same
    session key as the decision row so the two join per invocation.

    The hook must really execute for these to mean anything, so each test opts into
    unsandboxed exec the way the rest of the suite does -- CI provides no sandbox
    backend and refuses otherwise, which makes every outcome ``error``. Commands are
    ``sys.executable`` programs rather than shell builtins: cmd.exe has no ``true``,
    ``exit`` or ``sleep``, so a POSIX one-liner fails to launch on the Windows shard
    instead of producing the outcome under test.
    """

    def _capture(self):
        rows: list[dict] = []

        class _Sel:
            def log_tool_invocation(self, **kw):
                rows.append(kw)

            def log_governance_decision(self, **kw):
                pass

        return rows, _Sel

    @staticmethod
    def _py(program: str) -> str:
        return f'"{sys.executable}" -c "{program}"'

    async def _run(self, hook, session_key: str):
        import kiro_crew.hooks as H
        import kiro_crew.sandbox as sandbox_module

        rows, sel_cls = self._capture()
        with patch.object(H, "sel", lambda: sel_cls()):
            with patch.object(H, "_script_hooks_capability_denied", lambda sk="": None):
                with patch.object(sandbox_module, "_allow_unsandboxed_exec", lambda: True):
                    await H.run_script_hook(
                        hook, context="c", hook_event={"session_key": session_key}
                    )
        return [r for r in rows if r.get("tool_kind") == "script_hook"], hook

    @pytest.mark.asyncio
    async def test_a_successful_run_is_audited(self):
        import kiro_crew.hooks as H

        hook = H.ScriptHook(
            id="h1", name="h1", event=H.HOOK_EVENT_SESSION_LANE_CHANGED, command=self._py("pass")
        )
        runs, hook = await self._run(hook, "s1")

        assert len(runs) == 1, f"a completed run must be audited exactly once; got {runs!r}"
        assert runs[0]["outcome"] == hook.last_status, (
            "the audited outcome must be the outcome the run actually produced, "
            f"not a different one; row={runs[0]!r} last_status={hook.last_status!r}"
        )
        assert runs[0]["outcome"] == "ok", runs[0]
        assert runs[0]["tool_name"] == "run_script_hook:h1", runs[0]
        assert runs[0]["session_key"] == "s1", (
            "the invocation row must carry the SAME session key as the permission row, "
            "or the two cannot be joined"
        )

    @pytest.mark.asyncio
    async def test_a_failing_run_is_audited_with_its_exit_code(self):
        import kiro_crew.hooks as H

        hook = H.ScriptHook(
            id="h2",
            name="h2",
            event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
            command=self._py("raise SystemExit(3)"),
        )
        runs, hook = await self._run(hook, "s2")

        assert len(runs) == 1, f"a failed run must be audited; got {runs!r}"
        assert runs[0]["outcome"] == "error", runs[0]
        assert runs[0]["metadata"].get("exit_code") == 3, (
            "the exit status is the point of the record -- without it a failure is "
            f"indistinguishable from a success; got {runs[0]!r}"
        )

    @pytest.mark.asyncio
    async def test_a_timed_out_run_is_audited(self):
        """The path with no exit code at all still has to leave a record."""
        import kiro_crew.hooks as H

        hook = H.ScriptHook(
            id="h3",
            name="h3",
            event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
            command=self._py("import time; time.sleep(30)"),
            timeout=1,
        )
        async with _reaped_children() as children:
            runs, hook = await self._run(hook, "s3")
        assert children, "no child was captured, so this cleanup proved nothing"
        assert all(
            p.returncode is not None for p in children
        ), "a sleeper outlived the test: %r" % [p.returncode for p in children]

        assert len(runs) == 1, f"a timed-out run must be audited; got {runs!r}"
        assert runs[0]["outcome"] == "timeout", runs[0]


@contextlib.asynccontextmanager
async def _reaped_children():
    """Kill and await every subprocess spawned inside the block.

    Independent of the code under test: the hook's own timeout and cancellation paths
    also reap, but a test must not rely on the thing it is testing to clean up after it.
    """
    import asyncio as _asyncio

    import kiro_crew.platform_compat as _platform_compat
    import kiro_crew.sandbox as _sandbox

    spawned: list = []
    real_shell = _asyncio.create_subprocess_shell
    real_limited = _sandbox.create_subprocess_limited

    async def recording_shell(*a, **kw):
        proc = await real_shell(*a, **kw)
        spawned.append(proc)
        return proc

    async def recording_limited(*a, **kw):
        proc = await real_limited(*a, **kw)
        spawned.append(proc)
        return proc

    _asyncio.create_subprocess_shell = recording_shell
    _sandbox.create_subprocess_limited = recording_limited
    try:
        yield spawned
    finally:
        _asyncio.create_subprocess_shell = real_shell
        _sandbox.create_subprocess_limited = real_limited
        for proc in spawned:
            # A bare kill drops only the shell, orphaning the python grandchild on
            # Windows; kill_and_reap signals the tree and drains the pipes.
            with contextlib.suppress(Exception):
                await _platform_compat.kill_and_reap(proc, timeout=10)


class TestADeadWorkerIsReplaced:
    """A finished worker task must not be reused, or dispatch stops permanently.

    The guard checked only ``_LANE_WORKER is None``. A worker that was cancelled, or
    that let a ``BaseException`` escape the per-item ``except Exception``, remains a
    non-None task, so every later call reused a task that would never drain again:
    deltas accumulate to the 512 bound and then drop for the life of the process, with
    no recovery path.
    """

    @pytest.mark.asyncio
    async def test_a_finished_worker_is_replaced_on_the_next_dispatch(self):
        import kiro_crew.hooks as H

        H._LANE_QUEUE = None
        H._LANE_WORKER = None
        H._LANE_QUEUE_LOOP = None
        try:
            assert H._lane_dispatch_queue() is not None
            first = H._LANE_WORKER
            assert first is not None

            # Kill it the way a cancellation or escaping BaseException would.
            first.cancel()
            try:
                await first
            except asyncio.CancelledError:
                pass
            assert first.done(), "precondition: the worker must actually be finished"

            assert H._lane_dispatch_queue() is not None
            assert H._LANE_WORKER is not first, (
                "a finished worker was reused -- the queue would fill to its bound and "
                "drop every later delta with no recovery"
            )
            assert not H._LANE_WORKER.done(), "the replacement must be live"
        finally:
            if H._LANE_WORKER is not None:
                H._LANE_WORKER.cancel()
            H._LANE_QUEUE = None
            H._LANE_WORKER = None
            H._LANE_QUEUE_LOOP = None


class TestAnUncommittedHookIsNeverVisible:
    """A hook whose persist FAILS must never be observable as registered.

    Every writer edits ``self._hooks`` before ``_save``, and ``_atomic_mutation`` rolls
    that back when the save raises. The rollback closes the window only AFTER the
    failure, so an unsynchronized reader inside it -- which is what the lane readiness
    check on the tag-write path is -- could observe a hook that never reached disk and
    dispatch to it while the API reported the create as failed.
    """

    def test_a_reader_cannot_observe_a_hook_whose_persist_fails(self, tmp_path):
        import threading

        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        mid_flight = threading.Event()
        reader_tried = threading.Event()
        observed: list[int] = []

        def failing_save():
            # The hook is in _hooks now and not yet on disk: this is the window.
            mid_flight.set()
            reader_tried.wait(timeout=5)
            raise OSError("disk full")

        def reader():
            mid_flight.wait(timeout=5)
            reader_tried.set()
            observed.append(
                sum(
                    1
                    for h in store.list_all()
                    if h.enabled and h.event == H.HOOK_EVENT_SESSION_LANE_CHANGED
                )
            )

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        with patch.object(store, "_save", failing_save):
            with pytest.raises(OSError):
                store.create(
                    {
                        "name": "u1",
                        "event": H.HOOK_EVENT_SESSION_LANE_CHANGED,
                        "command": "true",
                        "enabled": True,
                    }
                )
        t.join(timeout=5)

        assert observed == [0], (
            "the reader observed an uncommitted hook -- the failed create rolled back, "
            f"but the lane had already seen it as registered; observed={observed!r}"
        )
        assert store.list_all() == [], "the rollback itself must leave nothing behind"


class TestOnLoopReadsTakeNoLock:
    """The readiness read must never wait on a writer's mutex.

    Mutations run in ``asyncio.to_thread`` and hold the RLock across ``_save`` ->
    file lock + fsync, while the readiness check runs on the event loop itself. Any
    lock on the read path therefore parks that loop behind a writer's disk I/O,
    freezing requests and heartbeats.
    """

    def test_a_reader_completes_while_a_writer_holds_the_mutex(self, tmp_path):
        import threading

        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        store.create(
            {
                "name": "held",
                "event": H.HOOK_EVENT_SESSION_LANE_CHANGED,
                "command": "true",
                "enabled": True,
            }
        )

        held = threading.Event()
        release = threading.Event()

        def writer():
            with store._mutex:
                held.set()
                release.wait(timeout=10)

        t = threading.Thread(target=writer, daemon=True)
        t.start()
        try:
            assert held.wait(timeout=5), "precondition: the writer must hold the mutex"
            done = threading.Event()
            seen: list[int] = []

            def reader():
                seen.append(len(store.list_all()))
                done.set()

            threading.Thread(target=reader, daemon=True).start()
            assert done.wait(timeout=3), (
                "the on-loop readiness read BLOCKED on a writer's mutex -- on the event "
                "loop this parks every request and the heartbeat behind a disk fsync"
            )
            assert seen == [1], seen
        finally:
            release.set()
            t.join(timeout=5)


class TestSnapshotTracksCommittedState:
    """The lock-free snapshot must equal committed state -- never more, never less.

    Two failure directions, both real: publishing too eagerly re-opens the
    uncommitted-hook finding, and failing to publish makes a committed hook invisible
    so the lane silently stops dispatching.
    """

    def _store(self, tmp_path):
        import kiro_crew.hooks as H

        return H.ScriptHookStore(config_dir=tmp_path), H

    def test_every_committed_mutation_is_visible(self, tmp_path):
        store, H = self._store(tmp_path)
        hook = store.create(
            {
                "name": "a",
                "event": H.HOOK_EVENT_SESSION_LANE_CHANGED,
                "command": "true",
                "enabled": True,
            }
        )
        assert [h.id for h in store.list_all()] == [hook.id], "create must publish"

        store.update(hook.id, {"enabled": False})
        assert [h.enabled for h in store.list_all()] == [False], "update must publish"

        store.delete(hook.id)
        assert store.list_all() == [], "delete must publish"

    def test_an_in_place_update_is_invisible_until_it_persists(self, tmp_path):
        """The reason the snapshot is deep-copied rather than shared."""
        store, H = self._store(tmp_path)
        hook = store.create(
            {
                "name": "b",
                "event": H.HOOK_EVENT_SESSION_LANE_CHANGED,
                "command": "true",
                "enabled": True,
            }
        )

        with patch.object(store, "_save", side_effect=OSError("disk full")):
            with pytest.raises(OSError):
                store.update(hook.id, {"enabled": False})

        assert [h.enabled for h in store.list_all()] == [True], (
            "a failed save left the in-place field edit visible to readers -- a shared "
            "(non-copied) snapshot is what causes this"
        )


class TestTheUiPickerMatchesTheBackendAllowlist:
    """A backend-only event is UNREACHABLE: the dashboard cannot create a hook for it.

    The dashboard's hooks page pins its own static event list, so adding an event to
    ``ALLOWED_HOOK_EVENTS`` alone leaves the picker one short and the described user
    with no way to reach the feature. Nothing coupled the two lists, so the drift was
    silent -- this test is the coupling.
    """

    def _events_from_tsx(self) -> set[str]:
        import re
        from pathlib import Path

        page = Path(__file__).resolve().parents[1] / "website/src/pages/hookEventWireValues.ts"
        text = page.read_text(encoding="utf-8")
        m = re.search(r"export const EVENTS = \[(.*?)\]", text, re.S)
        assert m, f"could not find the EVENTS list in {page}"
        found = set(re.findall(r"'([A-Za-z]+)'", m.group(1)))
        assert found, "parsed an EMPTY event list -- the test would prove nothing"
        return found

    def test_the_picker_offers_exactly_the_allowed_events(self):
        from kiro_crew.validation import ALLOWED_HOOK_EVENTS

        ui = self._events_from_tsx()
        assert ui == set(ALLOWED_HOOK_EVENTS), (
            "the dashboard picker and the backend allowlist disagree; "
            f"ui-only={sorted(ui - set(ALLOWED_HOOK_EVENTS))} "
            f"backend-only={sorted(set(ALLOWED_HOOK_EVENTS) - ui)}"
        )

    def test_the_new_event_is_offered_and_styled(self):
        """A picker entry with no style/badge row renders unlabelled."""
        import re
        from pathlib import Path

        import kiro_crew.hooks as H

        page = Path(__file__).resolve().parents[1] / "website/src/pages/HooksPage.tsx"
        text = page.read_text(encoding="utf-8")
        event = H.HOOK_EVENT_SESSION_LANE_CHANGED
        assert event in self._events_from_tsx(), f"{event} is not offered by the picker"
        for const in ("EVENT_STYLE", "EVENT_BADGE"):
            m = re.search(r"const %s[^{]*\{(.*?)\n\}" % const, text, re.S)
            assert m, f"could not find {const}"
            assert event in m.group(1), f"{event} has no {const} entry, so it renders unstyled"


class TestRunStatusIsVisibleThroughListAll:
    """After a hook fires, its run bookkeeping must reach readers.

    Serving readers from a committed snapshot made "live view" vs "committed view" a
    contract, and the post-fire path mutates ``last_run`` / ``last_status`` /
    ``last_error`` / ``run_count`` on the LIVE objects. Without a republish the hooks
    API keeps serving status frozen at the last create/update/toggle/delete, so the
    page's run count and last status stop moving once hooks start firing.
    """

    def test_status_bookkeeping_after_a_fire_reaches_readers(self, tmp_path):
        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        hook = store.create(
            {
                "name": "s1",
                "event": H.HOOK_EVENT_SESSION_LANE_CHANGED,
                "command": "true",
                "enabled": True,
            }
        )
        assert store.list_all()[0].run_count == 0, "precondition: no runs recorded yet"

        # What the post-fire path does: mutate the live object, then persist.
        live = store._hooks[hook.id]
        live.last_status = "ok"
        live.last_error = ""
        live.run_count += 1
        live.last_run = 1234567890.0
        store._persist_current()

        served = store.list_all()[0]
        assert served.run_count == 1, (
            "the hooks API serves run_count frozen at the last CRUD write -- a fired "
            f"hook's bookkeeping never reaches readers; got {served.run_count}"
        )
        assert served.last_status == "ok", served.last_status
        assert served.last_run == 1234567890.0, served.last_run

    def test_status_still_reaches_readers_when_the_save_fails(self, tmp_path):
        """The run HAPPENED, so hiding it would be the same staleness defect."""
        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        hook = store.create(
            {
                "name": "s2",
                "event": H.HOOK_EVENT_SESSION_LANE_CHANGED,
                "command": "true",
                "enabled": True,
            }
        )
        live = store._hooks[hook.id]
        live.last_status = "error"
        live.run_count += 1

        with patch.object(store, "_save", side_effect=OSError("disk full")):
            store._persist_current()

        served = store.list_all()[0]
        assert served.run_count == 1 and served.last_status == "error", (
            "a run whose status write failed is still a run that happened; readers "
            f"must see it; got run_count={served.run_count} status={served.last_status!r}"
        )


class TestARebindMidPersistDoesNotDispatch:
    """A slot rebound while the delete's save awaited must not get a lane delta.

    The delta keys on the bare slot key, so an unpinned enqueue fires "left lane X"
    against whatever session now routes there. The save already treats rebind-mid-persist
    as ordinary -- it refuses with ``applied=False`` -- and the in-memory strip stands
    either way, so the dispatch is the only place a wrong target can reach an irreversible
    close-out hook. Pinned with the same ownership test the drop endpoint applies.
    """

    @pytest.mark.asyncio
    async def test_a_rebound_slot_is_not_dispatched(self, tmp_path, monkeypatch):
        monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
        state = _make_state(tmp_path)
        app = _make_tags_app(state)
        seen: list[dict] = []

        async def _record(store, **kw):
            seen.append(kw)

        async with TestClient(TestServer(app)) as client:
            lane = _lane(state, "Done")
            original = _ChatSlot("s1")
            original.tags = [lane]
            state._slots["s1"] = original

            async def rebinding_save(*a, **kw):
                # Exactly what the save's expected_history_key pin exists to detect:
                # s1 now routes to a DIFFERENT slot object, so it refuses the write.
                replacement = _ChatSlot("s1")
                replacement.tags = [lane]
                state._slots["s1"] = replacement
                return False

            with (
                patch("kiro_crew.dashboard.chat_tags.save_slot_off_loop", rebinding_save),
                patch("kiro_crew.dashboard.chat_tags.get_global_hook_store", lambda: _StoreStub()),
                patch("kiro_crew.hooks._fire_session_lane_changed", _record),
            ):
                resp = await client.delete(f"/api/chat/tags/{lane}")
                await _settle()

        assert resp.status == 200, resp.status
        assert state._slots["s1"] is not original, "precondition: the rebind must have happened"
        assert seen == [], (
            "a rebound slot was dispatched -- the delta targets whatever session now "
            f"routes to s1, not the one that left the lane; got {seen!r}"
        )


class TestACancelledInvocationIsAudited:
    """A cancelled hook run must still leave an outcome row, and must re-raise.

    ``CancelledError`` is a ``BaseException``, so it bypassed the success branch, the
    ``TimeoutError`` branch and the ``Exception`` branch -- and the tree-kill that only
    the timeout branch performs. Gateway shutdown mid-run is routine, so that left both
    an unaudited invocation and a possibly-orphaned process tree.
    """

    @pytest.mark.asyncio
    async def test_a_cancelled_run_is_audited_and_reraises(self):
        import kiro_crew.hooks as H
        import kiro_crew.sandbox as sandbox_module

        rows: list[dict] = []

        class _Sel:
            def log_tool_invocation(self, **kw):
                rows.append(kw)

            def log_governance_decision(self, **kw):
                pass

        hook = H.ScriptHook(
            id="hc",
            name="hc",
            event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
            command=f'"{sys.executable}" -c "import time; time.sleep(30)"',
            timeout=30,
        )

        async with _reaped_children() as children:
            with patch.object(H, "sel", lambda: _Sel()):
                with patch.object(H, "_script_hooks_capability_denied", lambda sk="": None):
                    with patch.object(sandbox_module, "_allow_unsandboxed_exec", lambda: True):
                        task = asyncio.ensure_future(
                            H.run_script_hook(hook, context="c", hook_event={"session_key": "s9"})
                        )
                        await asyncio.sleep(1.5)  # let the subprocess actually start
                        assert not task.done(), "precondition: the run must be in flight"
                        task.cancel()
                        with pytest.raises(asyncio.CancelledError):
                            await task
        assert children, "no child was captured, so this cleanup proved nothing"
        assert all(
            p.returncode is not None for p in children
        ), "a sleeper outlived the test: %r" % [p.returncode for p in children]

        runs = [r for r in rows if r.get("tool_kind") == "script_hook"]
        assert len(runs) == 1, (
            "a cancelled invocation left no audit row -- CancelledError is a "
            f"BaseException and passed every audit branch; got {rows!r}"
        )
        assert runs[0]["outcome"] == "cancelled", runs[0]
        assert runs[0]["session_key"] == "s9", runs[0]


class TestPublishSnapshotHoldsItsOwnLock:
    """Publishing must not iterate the hook map unlocked.

    ``_publish_snapshot`` and the rollback capture in ``_atomic_mutation`` both walk
    ``self._hooks``; a concurrent insert or delete during that walk raises
    ``RuntimeError: dictionary changed size during iteration``. Two of the three publish
    call sites (``__init__`` and ``_atomic_mutation``) hold no mutex, so the safety was
    non-local -- it rested on callers. Each now takes the reentrant mutex itself.
    """

    def test_a_concurrent_mutator_cannot_break_publish(self, tmp_path):
        import threading

        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        for i in range(20):
            store._hooks["h%d" % i] = H.ScriptHook(
                id="h%d" % i, name="h%d" % i, event=H.HOOK_EVENT_SESSION_LANE_CHANGED
            )

        # Deterministic interleaving, not a timing race: this deepcopy releases a
        # mutator mid-walk and waits, so unlocked the insert resizes the dict.
        released = threading.Event()
        mutated = threading.Event()

        class _Tripwire(H.ScriptHook):
            def __deepcopy__(self, memo):
                released.set()
                mutated.wait(timeout=3)
                return self

        store._hooks["tripwire"] = _Tripwire(
            id="tripwire", name="tripwire", event=H.HOOK_EVENT_SESSION_LANE_CHANGED
        )

        def mutator():
            released.wait(timeout=5)
            try:
                with store._mutex:
                    for j in range(50):
                        store._hooks["late%d" % j] = H.ScriptHook(
                            id="late%d" % j,
                            name="late%d" % j,
                            event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
                        )
            finally:
                mutated.set()

        m = threading.Thread(target=mutator, daemon=True)
        m.start()
        error: list[BaseException] = []
        try:
            store._publish_snapshot()
        except BaseException as exc:  # noqa: BLE001 - catching it IS the assertion
            error.append(exc)
        mutated.set()
        m.join(timeout=5)

        assert not error, (
            "publishing raced a concurrent mutation: %r -- the publish must take the "
            "mutex itself rather than trusting its callers" % error[:1]
        )

    def test_the_mutex_is_reentrant_so_the_locked_caller_still_works(self, tmp_path):
        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        # _persist_current already holds the mutex and then publishes; a non-reentrant
        # lock would deadlock here rather than fail an assertion.
        with store._mutex:
            store._publish_snapshot()
        assert isinstance(store._snapshot, tuple)


class TestCancelledRunPersistsItsBookkeeping:
    """A cancelled run must not silently lose its monotonic run counter.

    ``fire`` persists BELOW its loop, so a re-raised ``CancelledError`` skipped it.
    ``last_status`` would be overwritten by a later persist, but ``run_count`` is
    monotonic -- a lost increment never self-corrects -- so the cancelled path now
    persists on its way out.
    """

    @pytest.mark.asyncio
    async def test_a_cancelled_fire_still_persists(self, tmp_path):
        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        hook = H.ScriptHook(
            id="hc",
            name="hc",
            event=H.HOOK_EVENT_SESSION_LANE_CHANGED,
            command="true",
            enabled=True,
        )
        store._hooks["hc"] = hook
        # Firing reads COMMITTED state, so an injected hook must be published to exist.
        store._publish_snapshot()

        persisted: list[int] = []
        real = store._persist_current

        def counting_persist():
            persisted.append(hook.run_count)
            return real()

        async def hang(*a, **kw):
            hook.run_count += 1
            await asyncio.sleep(30)

        with patch.object(store, "_persist_current", counting_persist):
            with patch.object(H, "run_script_hook", hang):
                task = asyncio.ensure_future(store.fire(H.HOOK_EVENT_SESSION_LANE_CHANGED))
                await asyncio.sleep(0.3)
                assert not task.done(), "precondition: the run must be in flight"
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task

        assert persisted, (
            "a cancelled fire persisted nothing -- the monotonic run_count increment "
            "is lost permanently, since the persist below the loop never runs"
        )
        assert persisted[0] >= 1, persisted


class TestEveryTerminalRunPathIsAudited:
    """Every terminal path of a run must file exactly one invocation audit row.

    The permitted path's audit lives at four separate terminal sites, so the contract
    was asserted by reading rather than enforced. This pins it structurally: each
    terminal branch of the run function carries an audit call.
    """

    def test_each_terminal_branch_audits(self):
        import inspect

        import kiro_crew.hooks as H

        body = inspect.getsource(H.run_script_hook)
        audits = body.count("_audit_hook_invocation(")
        outcomes = {
            o for o in ("ok", "error", "timeout", "cancelled", "blocked") if '"%s"' % o in body
        }
        assert audits >= 4, (
            "only %d audit call(s) in the run function; every terminal path must file "
            "one or a run outcome goes unrecorded" % audits
        )
        for want in ("timeout", "cancelled", "error"):
            assert want in outcomes, "no %r outcome is audited: %r" % (want, sorted(outcomes))


class TestARunsStatusReachesSnapshotReaders:
    """A hook run must republish, or its status is invisible to readers.

    Readers are served the snapshot, so a run mutating ``last_status`` / ``run_count``
    on the live object showed nothing through ``list_all`` until an unrelated write
    republished -- a regression against base, where ``list_all`` returned live objects.
    The Test endpoint hit exactly that gap, so the republish is wrapped in the store.
    """

    @pytest.mark.asyncio
    async def test_a_run_is_visible_through_list_all(self, tmp_path):
        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        hook = H.ScriptHook(
            id="hv", name="hv", event=H.HOOK_EVENT_SESSION_LANE_CHANGED, enabled=True
        )
        store._hooks["hv"] = hook
        store._publish_snapshot()
        assert store.list_all()[0].last_status in (None, ""), "precondition: no run yet"

        async def fake_run(h, ctx=None, ev=None):
            h.last_status = "ok"
            h.run_count += 1
            return H.ScriptHookResult(hook_id=h.id, hook_name=h.name, event=h.event)

        with patch.object(H, "run_script_hook", fake_run):
            await store.run_and_publish(hook, "ctx")

        seen = store.list_all()[0]
        assert seen.last_status == "ok", (
            "a run's status never reached the snapshot: readers see %r, so the hooks "
            "table shows stale status until an unrelated write" % seen.last_status
        )
        assert seen.run_count == 1, seen.run_count

    @pytest.mark.asyncio
    async def test_a_failing_run_still_republishes(self, tmp_path):
        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        hook = H.ScriptHook(
            id="hv", name="hv", event=H.HOOK_EVENT_SESSION_LANE_CHANGED, enabled=True
        )
        store._hooks["hv"] = hook
        store._publish_snapshot()

        async def boom(h, ctx=None, ev=None):
            h.last_status = "error"
            raise RuntimeError("nope")

        with patch.object(H, "run_script_hook", boom):
            with pytest.raises(RuntimeError):
                await store.run_and_publish(hook, "ctx")

        assert (
            store.list_all()[0].last_status == "error"
        ), "a failed run did not republish -- the wrapper must publish in `finally`"


class TestThePublishNeverBlocksTheEventLoop:
    """A run's republish must not take the store mutex on the event loop.

    A CRUD writer holds that same mutex across its file lock and fsync, so acquiring it
    inline would park the event loop for that whole write. The publish
    is therefore offloaded; this pins that the event loop keeps running meanwhile.
    """

    @pytest.mark.asyncio
    async def test_the_loop_still_runs_while_a_writer_holds_the_mutex(self, tmp_path):
        import threading
        import time

        import kiro_crew.hooks as H

        store = H.ScriptHookStore(config_dir=tmp_path)
        hook = H.ScriptHook(
            id="hb", name="hb", event=H.HOOK_EVENT_SESSION_LANE_CHANGED, enabled=True
        )
        store._hooks["hb"] = hook

        held = threading.Event()
        release = threading.Event()

        def hold_the_mutex():
            with store._mutex:
                held.set()
                release.wait(timeout=5)

        ticks = 0

        async def heartbeat():
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0.01)

        async def fake_run(h, ctx=None, ev=None):
            h.last_status = "ok"
            return H.ScriptHookResult(hook_id=h.id, hook_name=h.name, event=h.event)

        t = threading.Thread(target=hold_the_mutex, daemon=True)
        t.start()
        assert held.wait(timeout=5), "precondition: the writer must hold the mutex"

        beat = asyncio.ensure_future(heartbeat())
        try:
            with patch.object(H, "run_script_hook", fake_run):
                runner = asyncio.ensure_future(store.run_and_publish(hook, "ctx"))
                # WALL-CLOCK overshoot: a parked loop also delays the measuring await,
                # so a tick count catches up before it can be read.
                started = time.monotonic()
                await asyncio.sleep(0.2)
                elapsed = time.monotonic() - started
                # 2.0s leaves a 2.5x margin either way: the hold is 5s, so a parked
                # loop overshoots far past this, while a busy machine does not.
                assert elapsed < 2.0, (
                    "a 0.2s sleep took %.2fs, so the event loop was parked for the "
                    "mutex hold -- the publish must not acquire it inline" % elapsed
                )
                assert ticks > 0, "precondition: the heartbeat must have run at all"
                release.set()
                await asyncio.wait_for(runner, timeout=5)
        finally:
            beat.cancel()
            release.set()
            t.join(timeout=5)

        assert store.list_all()[0].last_status == "ok", "the publish must still land"


class TestProcIsNeverUnbound:
    """Cancellation before the subprocess binds must not dereference an unbound name.

    The reap sites sit inside `except ...: try: ... except Exception: pass`, so an
    UnboundLocalError was absorbed rather than surfacing. Binding the name up front and
    testing it makes the None case explicit instead of resting on that swallow.
    """

    def test_the_name_is_bound_before_the_try_and_tested_at_both_reaps(self):
        import inspect

        import kiro_crew.hooks as H

        body = inspect.getsource(H.run_script_hook)
        assert "proc: asyncio.subprocess.Process | None = None" in body, (
            "proc is not pre-bound, so cancellation before the subprocess is created "
            "reaches the reap with the name unbound"
        )
        guarded = body.count("if proc is not None and proc.returncode is None:")
        assert guarded == 2, "a reap site still dereferences proc unguarded: %d" % guarded
        assert body.count("if proc.returncode is None:") == 0, "an unguarded reap remains"
        assert body.index("proc: asyncio.subprocess.Process | None = None") < body.index(
            "    try:"
        ), "the binding must come before the try"


class TestAQueuedDeltaCannotTargetAReplacementSession:
    """Validate slot-instance identity at DRAIN, not only at enqueue.

    The key does not identify a session: a delete/recreate under the same
    channel-derived key rebinds it while the delta waits behind a slow hook, bounded
    only by the 1-300s hook timeout. The writers already guard the enqueue; without the
    same test at the fire, a close-out hook acts irreversibly on the replacement.
    """

    @pytest.mark.asyncio
    async def test_a_rebound_slot_is_dropped_at_drain(self):
        import kiro_crew.hooks as H

        fired: list[dict] = []

        async def _record(store, **kw):
            fired.append(kw)

        live = {"k": "original"}
        # False only AFTER the rebind, so the enqueue is legitimate and the drop is
        # decided at drain -- which is the whole point of the finding.
        delta = H.SessionLaneDelta(
            slot_key="chat-1",
            added=["done"],
            removed=[],
            is_current=lambda: live["k"] == "original",
        )

        H._LANE_QUEUE = None
        H._LANE_WORKER = None
        with patch.object(H, "_fire_session_lane_changed", _record):
            with patch.object(H, "get_global_hook_store", lambda: _StoreStub()):
                live["k"] = "replacement"  # delete/recreate under the same key
                await H.dispatch_session_lane_changed_bulk(_StoreStub(), items=[delta])
                await _settle()

        assert fired == [], (
            "a rebound slot was fired at drain -- the hook would act on the "
            f"replacement session, not the one that changed lane; got {fired!r}"
        )

    @pytest.mark.asyncio
    async def test_an_unrebound_slot_still_fires(self):
        """The arm that must PASS, so the drop above is not vacuous."""
        import kiro_crew.hooks as H

        fired: list[dict] = []

        async def _record(store, **kw):
            fired.append(kw)

        delta = H.SessionLaneDelta(
            slot_key="chat-1", added=["done"], removed=[], is_current=lambda: True
        )

        H._LANE_QUEUE = None
        H._LANE_WORKER = None
        with patch.object(H, "_fire_session_lane_changed", _record):
            with patch.object(H, "get_global_hook_store", lambda: _StoreStub()):
                await H.dispatch_session_lane_changed_bulk(_StoreStub(), items=[delta])
                await _settle()

        assert len(fired) == 1, f"a live slot must still fire; got {fired!r}"
        assert fired[0]["slot_key"] == "chat-1", fired[0]

    def test_both_writers_carry_the_identity_check(self):
        """A writer that omits it silently loses the guard, so pin both sites."""
        import inspect

        from kiro_crew.dashboard import chat_tags as CT

        body = inspect.getsource(CT)
        constructions = body.count("SessionLaneDelta(")
        carried = body.count("is_current=_slot_identity_check(")
        assert constructions == carried == 2, (
            "every SessionLaneDelta construction must carry the identity check: "
            f"{constructions} construction(s), {carried} carrying it"
        )


class TestTheChildReaperIsLoadBearing:
    """The test-side teardown must reap on its own, not lean on the code under test.

    Both sleeper tests run through ``run_script_hook``, which reaps via its timeout and
    cancellation paths -- so those tests cannot show whose cleanup ran. Here nothing but
    the reaper's ``finally`` can reap, so the guarantee is actually observable.
    """

    @pytest.mark.asyncio
    async def test_a_sleeper_is_reaped_with_no_other_cleanup_in_play(self):
        import asyncio as _asyncio

        proc = None
        async with _reaped_children() as children:
            proc = await _asyncio.create_subprocess_shell(
                f'"{sys.executable}" -c "import time; time.sleep(30)"'
            )
            assert proc.returncode is None, "precondition: the sleeper must be running"
            assert children == [proc], (
                "the spawn was not captured, so the teardown has nothing to reap: %r" % children
            )

        assert proc.returncode is not None, (
            "the sleeper outlived the block -- the reaper's finally must kill and await "
            "each captured child, since no hook path is present here to do it"
        )


class TestARolledBackHookNeverFires:
    """A hook whose write never reached disk must not reach the shell."""

    @pytest.mark.asyncio
    async def test_a_hook_mid_rollback_does_not_run_its_command(self, tmp_path, monkeypatch):
        import threading

        import kiro_crew.hooks as H
        import kiro_crew.sandbox as sandbox_module

        sentinel = tmp_path / "FIRED"
        rolled_back = (
            '"' + sys.executable + '" -c "open(r\'' + str(sentinel) + "', chr(119)).close()\""
        )
        committed = '"' + sys.executable + '" -c "pass"'

        store = H.ScriptHookStore(config_dir=tmp_path)
        created = store.create(
            {
                "name": "rollback-probe",
                "event": H.HOOK_EVENT_USER_PROMPT_SUBMIT,
                "command": committed,
                "enabled": True,
            }
        )
        assert created is not None

        inside = threading.Event()
        release = threading.Event()

        def blocking_save(*a, **kw):
            inside.set()
            release.wait(timeout=10)
            raise OSError("disk full")

        monkeypatch.setattr(store, "_save", blocking_save)
        mutation = asyncio.create_task(
            asyncio.to_thread(store.update, created.id, {"command": rolled_back})
        )
        assert await asyncio.to_thread(inside.wait, 10), "the mutation never opened its window"

        # Precondition: the live object MUST carry the uncommitted command right now,
        # or the interleaving under test is not actually in effect.
        assert store.get(created.id).command == rolled_back, "window not open"

        with patch.object(H, "_script_hooks_capability_denied", lambda sk="": None):
            with patch.object(sandbox_module, "_allow_unsandboxed_exec", lambda: True):
                await store.fire(H.HOOK_EVENT_USER_PROMPT_SUBMIT, context="anything")

        release.set()
        with pytest.raises(OSError):
            await mutation

        assert not sentinel.exists(), "a hook whose write never reached disk executed its command"

    @pytest.mark.asyncio
    async def test_a_committed_hook_still_fires(self, tmp_path, monkeypatch):
        import kiro_crew.hooks as H
        import kiro_crew.sandbox as sandbox_module

        sentinel = tmp_path / "COMMITTED"
        command = '"' + sys.executable + '" -c "open(r\'' + str(sentinel) + "', chr(119)).close()\""
        store = H.ScriptHookStore(config_dir=tmp_path)
        created = store.create(
            {
                "name": "committed-probe",
                "event": H.HOOK_EVENT_USER_PROMPT_SUBMIT,
                "command": command,
                "enabled": True,
            }
        )
        assert created is not None

        with patch.object(H, "_script_hooks_capability_denied", lambda sk="": None):
            with patch.object(sandbox_module, "_allow_unsandboxed_exec", lambda: True):
                await store.fire(H.HOOK_EVENT_USER_PROMPT_SUBMIT, context="anything")

        assert sentinel.exists(), "a committed hook stopped firing"


class TestTheFireTargetIsFrozenAtCommit:
    """A writer mutating mid-fire must not change what the command executes."""

    @pytest.mark.asyncio
    async def test_a_mutation_after_selection_does_not_change_the_command(
        self, tmp_path, monkeypatch
    ):
        import kiro_crew.hooks as H
        import kiro_crew.sandbox as sandbox_module

        committed_marker = tmp_path / "COMMITTED"
        injected_marker = tmp_path / "INJECTED"

        def writer(path):
            return '"' + sys.executable + '" -c "open(r\'' + str(path) + "', chr(119)).close()\""

        store = H.ScriptHookStore(config_dir=tmp_path)
        created = store.create(
            {
                "name": "frozen-probe",
                "event": H.HOOK_EVENT_USER_PROMPT_SUBMIT,
                "command": writer(committed_marker),
                "matcher": "anything",
                "enabled": True,
            }
        )
        assert created is not None

        # Runs AFTER fire has chosen its target and BEFORE the command executes.
        def mutate_then_match(*a, **kw):
            store._hooks[created.id].command = writer(injected_marker)
            return True

        with patch.object(H, "_context_matches", mutate_then_match):
            with patch.object(H, "_script_hooks_capability_denied", lambda sk="": None):
                with patch.object(sandbox_module, "_allow_unsandboxed_exec", lambda: True):
                    await store.fire(H.HOOK_EVENT_USER_PROMPT_SUBMIT, context="anything")

        # Precondition: the interleaving must actually have happened.
        assert store._hooks[created.id].command == writer(injected_marker), "never mutated"

        assert not injected_marker.exists(), "a command injected after target selection executed"
        assert committed_marker.exists(), "the committed command did not execute"

    @pytest.mark.asyncio
    async def test_a_runs_bookkeeping_reaches_the_stored_hook(self, tmp_path, monkeypatch):
        import kiro_crew.hooks as H
        import kiro_crew.sandbox as sandbox_module

        store = H.ScriptHookStore(config_dir=tmp_path)
        created = store.create(
            {
                "name": "bookkeeping-probe",
                "event": H.HOOK_EVENT_USER_PROMPT_SUBMIT,
                "command": '"' + sys.executable + '" -c "pass"',
                "enabled": True,
            }
        )
        assert created is not None
        assert store._hooks[created.id].run_count == 0

        with patch.object(H, "_script_hooks_capability_denied", lambda sk="": None):
            with patch.object(sandbox_module, "_allow_unsandboxed_exec", lambda: True):
                await store.fire(H.HOOK_EVENT_USER_PROMPT_SUBMIT, context="anything")

        stored = store._hooks[created.id]
        assert stored.run_count == 1, "the run never reached the stored hook"
        assert stored.last_status == "ok", stored.last_status
        # Readers are served the snapshot, so it must carry it too.
        published = [h for h in store.list_all() if h.id == created.id]
        assert published and published[0].run_count == 1, "readers never saw the run"


class TestColdSelNeverBlocksTheLoop:
    """The audit seam must hand a COLD ``sel()`` to a thread, never run it inline.

    A cold ``sel()`` does trust-dir creation, an HMAC key load and a tail read on the
    caller's thread, so an audit site the request path awaits would stall the gateway.
    Warm is the steady state, so both arms are pinned: warm stays inline (no thread hop
    to pay per row) and cold offloads.
    """

    @pytest.mark.asyncio
    async def test_a_cold_audit_write_is_offloaded_to_a_thread(self, monkeypatch):
        import kiro_crew.hooks as H

        ran_on = []

        def _write():
            ran_on.append(threading.current_thread().name)

        monkeypatch.setattr(H, "sel_is_warm", lambda: False)
        await H._audit_off_loop(_write, "probe")

        assert ran_on, "the row was never written at all"
        assert ran_on[0] != threading.current_thread().name, (
            "a cold audit write ran on the caller's thread, which is the event loop: "
            f"{ran_on[0]}"
        )

    @pytest.mark.asyncio
    async def test_a_warm_audit_write_stays_inline(self, monkeypatch):
        import kiro_crew.hooks as H

        ran_on = []

        def _write():
            ran_on.append(threading.current_thread().name)

        monkeypatch.setattr(H, "sel_is_warm", lambda: True)
        await H._audit_off_loop(_write, "probe")

        assert ran_on == [
            threading.current_thread().name
        ], "a warm write paid a thread hop it does not need"

    @pytest.mark.asyncio
    async def test_a_failed_audit_never_escapes_into_the_response(self, monkeypatch):
        import kiro_crew.hooks as H

        def _boom():
            raise OSError("trust dir unwritable")

        monkeypatch.setattr(H, "sel_is_warm", lambda: False)
        await H._audit_off_loop(_boom, "probe")

    def test_every_new_audit_site_routes_through_the_seam(self):
        import kiro_crew.hooks as H

        body = pathlib.Path(H.__file__).read_text(encoding="utf-8")
        gate = body.count("_audit_off_loop(")
        assert gate >= 4, (
            "a new audit site bypasses the warm gate; the seam is called "
            f"{gate} time(s) and the fix added three call sites plus the definition"
        )
