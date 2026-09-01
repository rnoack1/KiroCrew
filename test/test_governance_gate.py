"""Phase 6 + 8 — the PreToolUse gate enforces governance, and audits denials.

The headline behavior: a profile (or policy) that excludes an MCP tool causes
KiroCrew to refuse the call at its own host gate, EVEN IF the kiro agent config
granted it.  Plus: a governance deny wins over a user auto-approve, and a deny
emits a redacted ``governance_decision`` SEL record.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import threading

import pytest

from kiro_crew.hooks import TOOL_DENY, HookManager, HooksConfig
from kiro_crew.platform import context as ctx_mod
from kiro_crew.platform import governance_profiles as gp
from kiro_crew.platform.bootstrap import build_default_context
from kiro_crew.platform.governance import parse_policy


@pytest.fixture
def profiles_dir(tmp_path, monkeypatch):
    d = tmp_path / "profiles"
    d.mkdir()
    monkeypatch.setattr(gp, "_PROFILES_DIR", d)
    gp.reset_store()
    yield d
    gp.reset_store()


def _install_ceiling(monkeypatch, policy_body):
    """Compose a context carrying the given policy and install it as active."""
    from kiro_crew.config.loader import KiroCrewConfig

    base = build_default_context(KiroCrewConfig.load())
    ceiling = parse_policy(policy_body) if policy_body is not None else None
    ctx = dataclasses.replace(base, governance=ceiling)
    ctx_mod.set_context(ctx)
    return ctx


@pytest.fixture(autouse=True)
def _reset_ctx():
    yield
    ctx_mod.reset_context()


def _write(d, name, body):
    (d / f"{name}.json").write_text(json.dumps(body))


def test_profile_denies_mcp_tool_kiro_would_grant(profiles_dir, monkeypatch):
    # Policy: ungoverned mcp (deny[] = allow-all).  Profile bound to the cron
    # surface denies the whole @kirocrew-cron server.
    _install_ceiling(monkeypatch, {"version": 1, "boot": {"fail_closed": True}})
    _write(
        profiles_dir,
        "cron",
        {
            "name": "cron",
            "bind": {"type": "surface", "id": "cron"},
            "mcp": {"mode": "deny", "deny": ["@kirocrew-cron"]},
        },
    )
    hooks = HookManager(HooksConfig(auto_approve_tools=["*"]))  # kiro would auto-approve!
    result = hooks.on_tool_call("mcp__kirocrew-cron__cron_add", session_key="cron:job-1:run-1")
    assert result.action == TOOL_DENY
    assert "governance" in result.reason.lower()


def test_governance_deny_beats_user_auto_approve(profiles_dir, monkeypatch):
    _install_ceiling(monkeypatch, {"version": 1, "boot": {"fail_closed": True}})
    _write(
        profiles_dir,
        "dash",
        {
            "name": "dash",
            "bind": {"type": "surface", "id": "dashboard"},
            "tools": {"mode": "allow", "allow": ["read"]},  # only read
        },
    )
    hooks = HookManager(HooksConfig(auto_approve_tools=["*"]))
    # execute_bash is auto-approved by config but NOT in the profile allow-set.
    result = hooks.on_tool_call("execute_bash", session_key="dashboard:slot1")
    assert result.action == TOOL_DENY


def test_allowed_tool_passes(profiles_dir, monkeypatch):
    _install_ceiling(monkeypatch, {"version": 1, "boot": {"fail_closed": True}})
    _write(
        profiles_dir,
        "dash",
        {
            "name": "dash",
            "bind": {"type": "surface", "id": "dashboard"},
            "tools": {"mode": "allow", "allow": ["read", "grep"]},
        },
    )
    hooks = HookManager()
    result = hooks.on_tool_call("read", session_key="dashboard:slot1")
    assert result.action != TOOL_DENY


def test_no_policy_no_profile_is_noop(monkeypatch, tmp_path):
    # Ungoverned standalone host: gate behaves exactly as before.
    monkeypatch.setattr(gp, "_PROFILES_DIR", tmp_path / "none")
    gp.reset_store()
    _install_ceiling(monkeypatch, None)
    hooks = HookManager()
    result = hooks.on_tool_call("execute_bash", session_key="cli_chat")
    assert result.action != TOOL_DENY


def test_policy_ceiling_denies_regardless_of_profile(profiles_dir, monkeypatch):
    # Policy denies a command; even with no profile the gate refuses.
    _install_ceiling(
        monkeypatch,
        {
            "version": 1,
            "boot": {"fail_closed": True},
            "commands": {"mode": "deny", "deny": ["terraform destroy*"]},
        },
    )
    hooks = HookManager()
    result = hooks.on_tool_call("Running: terraform destroy -auto-approve", session_key="cli_chat")
    assert result.action == TOOL_DENY


def test_denial_emits_redacted_audit(profiles_dir, monkeypatch):
    events = []

    class _FakeSel:
        def log_governance_decision(self, **kw):
            events.append(kw)

    monkeypatch.setattr("kiro_crew.sel.sel", lambda: _FakeSel())
    _install_ceiling(
        monkeypatch,
        {
            "version": 1,
            "boot": {"fail_closed": True},
            "commands": {"mode": "deny", "deny": ["*secret*"]},
        },
    )
    hooks = HookManager()
    hooks.on_tool_call("Running: echo my-secret-value", session_key="cli_chat")
    assert events, "expected a governance_decision audit record"
    assert events[0]["outcome"] == "denied"


def test_single_token_command_still_governed(profiles_dir, monkeypatch):
    # An UNPREFIXED single-token command (claude-agent-acp delivers a bare bash
    # title) must still be checked against the commands ceiling — not silently
    # routed to the (absent) tools scope and permitted.
    _install_ceiling(
        monkeypatch,
        {
            "version": 1,
            "boot": {"fail_closed": True},
            "commands": {"mode": "deny", "deny": ["whoami"]},
        },
    )
    hooks = HookManager()
    result = hooks.on_tool_call("whoami", session_key="cli_chat")
    assert result.action == TOOL_DENY


def test_unprefixed_multiword_tool_checked_against_tools(profiles_dir, monkeypatch):
    # An unprefixed multi-word title is checked against BOTH scopes; a tools
    # allow-set that excludes it still denies.
    _install_ceiling(monkeypatch, {"version": 1, "boot": {"fail_closed": True}})
    _write(
        profiles_dir,
        "dash",
        {
            "name": "dash",
            "bind": {"type": "surface", "id": "dashboard"},
            "tools": {"mode": "allow", "allow": ["read"]},
        },
    )
    hooks = HookManager()
    # "List files" is not in the tools allow-set → denied (would have been
    # misrouted to commands-only under the old single-pair classification).
    result = hooks.on_tool_call("List files", session_key="dashboard:s")
    assert result.action == TOOL_DENY


def test_file_read_title_not_name_gate_governed(profiles_dir, monkeypatch):
    # A "Reading <path>" title is governed at the filesystem chokepoint, not the
    # name gate — so a tools-only profile must not accidentally deny a read here.
    _install_ceiling(monkeypatch, {"version": 1, "boot": {"fail_closed": True}})
    _write(
        profiles_dir,
        "dash",
        {
            "name": "dash",
            "bind": {"type": "surface", "id": "dashboard"},
            "tools": {"mode": "allow", "allow": ["read"]},
        },
    )
    hooks = HookManager()
    result = hooks.on_tool_call("Reading /home/user/project/file.txt", session_key="dashboard:s")
    assert result.action != TOOL_DENY


# ---------------------------------------------------------------------------
# The capability gate resolves OFF the event loop, so its thread-safety is
# load-bearing.
#
# ``hooks._script_hooks_capability_denied`` resolves ``capabilities.script_hooks``
# through ``governance_permits``, and both of its call sites in ``hooks.py`` run it
# via ``asyncio.to_thread`` -- so gate resolution happens on worker threads for
# EVERY hook event, not just the one whose feature introduced the offload. That
# makes the store's concurrency contract a correctness dependency of the gate.
#
# The pin lives HERE, beside the gate, rather than in the feature test file that
# first needed it: a ``governance_profiles`` maintainer reads this file, and
# reverting that feature must not silently delete the guard for a property the
# gate still relies on.
# ---------------------------------------------------------------------------


class TestEveryPermittedRunIsAudited:
    """A permitted command hook leaves an SEL record on EVERY execution.

    The audit exists so "which hook commands ran under which governance decision"
    is answerable. A coalescing scheme that emits only the first permit per
    (session, hook) answers a weaker question -- it proves the decision was once
    made, not that THIS execution was covered -- so a repeated permitted run
    executes code with no record of the permission that allowed it.

    The cadence also has to match the skills-only arm, which audits per fire. One
    decision class with two cadences drifts, and a query over the class silently
    means different things depending on which arm produced the row.
    """

    def test_a_pre_existing_event_emits_no_allowed_record(self, monkeypatch):
        """The other half of the scope: the allow audit is NOT all-event.

        Emitting on every permitted command-hook run changed audit volume for the four
        pre-existing events, which main does not audit at all. Scoping keeps this event
        auditable without that rider, and this pins the boundary so a later widening is
        a deliberate change rather than a silent one. Denials stay unscoped.
        """
        import kiro_crew.hooks as H

        emitted: list[str] = []
        monkeypatch.setattr(
            H,
            "_audit_governance_hook_decision",
            lambda sk, label, outcome, reason: emitted.append(outcome),
        )
        monkeypatch.setattr(H, "_script_hooks_capability_denied", lambda sk: None)

        hook = H.ScriptHook(id="h", name="h", command="true", event=H.HOOK_EVENT_USER_PROMPT_SUBMIT)
        asyncio.run(H.run_script_hook(hook, "", {"parent_session_key": "dashboard:s1"}))

        assert emitted == [], (
            "a pre-existing event must not emit the per-run allowed record; " f"got {emitted!r}"
        )

    def test_two_permitted_runs_emit_two_allowed_records(self, monkeypatch):
        """The regression guard: N executions must yield N allowed records.

        Scoped to ``SessionLaneChanged``: the per-run allow audit is this event's, not
        an all-event change. Its counterpart above pins the other side of that boundary.
        """
        import kiro_crew.hooks as H

        emitted: list[str] = []
        monkeypatch.setattr(
            H,
            "_audit_governance_hook_decision",
            lambda sk, label, outcome, reason: emitted.append(outcome),
        )
        monkeypatch.setattr(H, "_script_hooks_capability_denied", lambda sk: None)

        hook = H.ScriptHook(
            id="h", name="h", command="true", event=H.HOOK_EVENT_SESSION_LANE_CHANGED
        )
        for _ in range(3):
            asyncio.run(H.run_script_hook(hook, "", {"parent_session_key": "dashboard:s1"}))

        assert (
            emitted == ["allowed"] * 3
        ), f"every permitted execution must be audited, none skipped: {emitted!r}"

    def test_a_repeated_deny_is_audited_every_time(self, monkeypatch):
        import kiro_crew.hooks as H

        emitted: list[str] = []
        monkeypatch.setattr(
            H,
            "_audit_governance_hook_decision",
            lambda sk, label, outcome, reason: emitted.append(outcome),
        )
        monkeypatch.setattr(H, "_script_hooks_capability_denied", lambda sk: "profile forbids")

        hook = H.ScriptHook(
            id="h", name="h", command="true", event=H.HOOK_EVENT_SESSION_LANE_CHANGED
        )
        for _ in range(3):
            result = asyncio.run(
                H.run_script_hook(hook, "", {"parent_session_key": "dashboard:s1"})
            )
            assert result.exit_code == 2, "a governance deny must block the hook"

        assert emitted == ["denied"] * 3, f"every deny must be audited: {emitted!r}"

    def test_alternating_verdicts_are_each_audited(self, monkeypatch):
        """allow -> deny -> allow must produce three records, in order."""
        import kiro_crew.hooks as H

        emitted: list[str] = []
        monkeypatch.setattr(
            H,
            "_audit_governance_hook_decision",
            lambda sk, label, outcome, reason: emitted.append(outcome),
        )
        verdicts = iter([None, "profile forbids", None])
        monkeypatch.setattr(H, "_script_hooks_capability_denied", lambda sk: next(verdicts))

        hook = H.ScriptHook(
            id="h", name="h", command="true", event=H.HOOK_EVENT_SESSION_LANE_CHANGED
        )
        for _ in range(3):
            asyncio.run(H.run_script_hook(hook, "", {"parent_session_key": "dashboard:s1"}))

        assert emitted == ["allowed", "denied", "allowed"], f"{emitted!r}"


class TestTheRealStoreIsDrivenConcurrently:
    """Drive the ACTUAL ``governance_profiles`` store from many threads at once.

    Why this exists separately from ``TestTheOffloadedGateIsConcurrencySafe``:
    that test monkeypatches ``governance_permits`` itself, so it pins the gate's
    own thread behaviour (verdict consistency, fail-closed across the thread hop)
    but never enters the store -- the real lock, the real ``_dir_fingerprint``
    walk and the real reload path are never contended. The offload makes the
    STORE's concurrency contract load-bearing, so a claim that the contract is
    pinned has to be backed by a test that actually reaches it. Without this, a
    future change inside the store that breaks it fails under production load
    rather than in CI.

    Deliberately no monkeypatch on the resolver: only ``_PROFILES_DIR`` is
    redirected (by the ``profiles_dir`` fixture) so the code under test is the
    shipping code path.
    """

    def test_concurrent_real_resolution_is_consistent_and_reload_safe(
        self, profiles_dir, monkeypatch
    ):
        import kiro_crew.hooks as H

        # A DELEGATING spy, not a substitute: it counts entries and calls the real
        # resolver through, so the real lock, fingerprint walk and reload still run.
        # Without this the test cannot tell "resolved 8 times" from "never entered
        # the store" -- a negative control that replaced the call with None passed,
        # which is precisely the aspirational-pin failure this class exists to
        # avoid.
        real = gp.governance_permits
        entries: list[str] = []

        def _spy(capability, item, session_key=""):
            entries.append(session_key)
            return real(capability, item, session_key=session_key)

        monkeypatch.setattr(gp, "governance_permits", _spy)

        results: list[object] = []
        errors: list[BaseException] = []
        barrier = threading.Barrier(8)

        def _worker(i: int) -> None:
            try:
                barrier.wait(timeout=15)
                # Half the workers mutate the profiles dir mid-flight, so the
                # fingerprint changes under the readers and the reload path is
                # genuinely contended rather than merely warm.
                if i % 2 == 0:
                    (profiles_dir / f"p{i}.json").write_text(
                        '{"name": "p%d", "capabilities": {}}' % i, encoding="utf-8"
                    )
                results.append(H._script_hooks_capability_denied(f"dashboard:s{i}"))
            except BaseException as exc:  # noqa: BLE001 -- a raise here IS the finding
                errors.append(exc)

        threads = [threading.Thread(target=_worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        assert not errors, f"real-store concurrent resolution raised: {errors!r}"
        assert len(results) == 8, f"a worker never returned: {len(results)}"
        # PREMISE GUARD: the store really was entered, once per worker. This is what
        # makes the assertions below statements about the store rather than about a
        # code path that quietly never ran.
        assert len(entries) == 8, f"the real resolver was not entered 8x: {entries!r}"
        # Every verdict must be a well-formed gate answer -- None (no opinion or
        # permitted) or a non-empty denial reason. A torn snapshot read would
        # surface here as a raise above, or as a value of neither shape.
        for r in results:
            assert r is None or (isinstance(r, str) and r), f"malformed verdict: {r!r}"

    def test_the_store_survives_a_reset_under_concurrent_readers(self, profiles_dir):
        """``reset_store`` while readers resolve must not raise or wedge."""
        import kiro_crew.hooks as H

        errors: list[BaseException] = []
        barrier = threading.Barrier(6)

        def _reader() -> None:
            try:
                barrier.wait(timeout=15)
                for _ in range(5):
                    H._script_hooks_capability_denied("dashboard:s1")
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        def _resetter() -> None:
            try:
                barrier.wait(timeout=15)
                for _ in range(5):
                    gp.reset_store()
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=_reader) for _ in range(5)]
        threads.append(threading.Thread(target=_resetter))
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        assert not errors, f"reset under concurrent readers raised: {errors!r}"


class TestTheOffloadedGateIsConcurrencySafe:
    """The offload makes ``governance_permits`` thread-safety LOAD-BEARING.

    Two ``to_thread`` call sites move gate resolution onto worker threads for all
    five pre-existing hook events, which previously resolved it inline. The store
    is built for that -- ``governance_profiles`` takes a ``threading.Lock`` whose own
    comment names concurrent worker-thread callers, acquires it NON-blocking, and
    publishes a ``@dataclass(frozen=True)`` snapshot in one assignment so a
    lock-free reader cannot observe a torn state.

    But "the code says it is safe" is not a test. An assumption that is load-bearing
    and unpinned is exactly what regresses silently: remove the lock and nothing here
    would fail. So drive the offloaded helper from many threads at once and pin that
    every caller gets a consistent verdict, so a future change that breaks the
    store's concurrency contract fails HERE rather than under production load.
    """

    def test_concurrent_workers_all_get_the_same_verdict(self, monkeypatch):
        import kiro_crew.hooks as H

        calls: list[str] = []
        barrier = threading.Barrier(8)

        def _resolve(_capability, _item, session_key=""):
            # Maximise overlap: every thread is inside the resolver together.
            barrier.wait(timeout=10)
            calls.append(session_key)

            class _D:
                permitted = True

            return _D()

        monkeypatch.setattr("kiro_crew.platform.governance_profiles.governance_permits", _resolve)

        results: list[object] = []
        errors: list[BaseException] = []

        def _worker() -> None:
            try:
                results.append(H._script_hooks_capability_denied("dashboard:s1"))
            except BaseException as exc:  # noqa: BLE001 -- a raise here IS the finding
                errors.append(exc)

        threads = [threading.Thread(target=_worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)

        assert not errors, f"concurrent gate resolution raised: {errors!r}"
        assert len(results) == 8, f"a worker never returned: {len(results)}"
        assert all(r is None for r in results), f"verdicts diverged under concurrency: {results!r}"
        assert len(calls) == 8, "every worker must reach the resolver"

    def test_a_composition_error_still_fails_closed_from_a_worker_thread(self, monkeypatch):
        """Fail-closed CPP must survive the thread hop, not be swallowed by it.

        ``PlatformCompositionError`` is the one exception the gate must propagate;
        every other error degrades to "no opinion". ``to_thread`` re-raises in the
        awaiting coroutine, so the distinction has to hold across the boundary --
        otherwise the offload would silently convert a fail-closed denial into a
        permissive None.
        """
        import kiro_crew.hooks as H
        from kiro_crew.platform.context import PlatformCompositionError

        def _boom(_capability, _item, session_key=""):
            raise PlatformCompositionError("composition refused")

        monkeypatch.setattr("kiro_crew.platform.governance_profiles.governance_permits", _boom)
        with pytest.raises(PlatformCompositionError):
            H._script_hooks_capability_denied("dashboard:s1")

        def _other(_capability, _item, session_key=""):
            raise RuntimeError("transient governance glitch")

        monkeypatch.setattr("kiro_crew.platform.governance_profiles.governance_permits", _other)
        # Control: any OTHER error must NOT propagate, or one glitch wedges every hook.
        assert H._script_hooks_capability_denied("dashboard:s1") is None
