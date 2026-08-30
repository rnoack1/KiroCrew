"""Behavioural tests for the ``GET /api/skills`` single-flight join.

Covers:
- concurrent readers coalesce onto ONE assembly (the measured fix: 0% -> 87.5%
  redundant-scan elimination at 8-way)
- NOTHING is retained past the burst, so a later read always rescans and the
  base's recorded "no result cache" default still holds
- a different loader is a different catalog and never joins
- readers of different projects serialize on the one global assembly lock
- no module owes the catalog an invalidation: no invalidator exists to call

Earlier revisions of this change shipped a 3s stored entry plus an invalidation
call in every mutating module, and then a separate leaf module holding the
protocol. Review removed the store (it contributed none of the measured win while
obliging every mutator to invalidate), then the epoch stamp (its only trigger was
unreachable), then the module itself (one consumer, so the leaf property and the
injected assembly served nobody). The tests that pinned each went with it.

Every test stubs the two expensive collaborators (the edition capability manager
and ``collect_skills_blocking``) and counts calls, so "shared one assembly" is
asserted by the assembler NOT running rather than by a latency measurement.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from aiohttp.test_utils import TestClient, TestServer

# Reused rather than re-implemented: these are the same scaffolding helpers the
# skills-browser suite builds its endpoint tests from. Imported instead of
# copied, and the test lives HERE instead of being appended there, because that
# module carries 155 lines of pre-existing black drift -- touching it would bury
# this fix under unrelated reformatting.
from test_skill_browser import _make_app, _write_skill  # type: ignore[import-not-found]

from kiro_crew.dashboard.handlers import prompts


@pytest.fixture(autouse=True)
def clean_protocol_state():
    """Each test starts and ends with no in-flight bookkeeping.

    This is module state, so a leaked handoff or waiter count from a neighbour
    could serve one test from another's rows -- which would make a broken join
    look correct.
    """
    prompts._catalog_handoff.clear()
    prompts._catalog_waiters.clear()
    yield
    prompts._catalog_handoff.clear()
    prompts._catalog_waiters.clear()


@pytest.fixture
def stub_assembly(monkeypatch):
    """Replace both expensive collaborators and count assembler invocations."""
    calls = {"n": 0}

    class _NoCapabilities:
        def available(self) -> bool:
            return False

    def _collect(skills, package_skills, project_dir):
        calls["n"] += 1
        # Echo BOTH inputs the catalog varies by, so a key that omits either
        # shows up as a wrong value rather than only as a wrong call count.
        return [
            {
                "key": f"skill-for-{project_dir}",
                "name": "s",
                "description": "",
                "loader": id(skills),
            }
        ]

    monkeypatch.setattr(prompts, "_capability_manager", lambda: _NoCapabilities())
    monkeypatch.setattr(prompts, "collect_skills_blocking", _collect)
    return calls


@pytest.fixture
def loader():
    """One SkillsLoader stand-in per test.

    Reused across calls WITHIN a test on purpose: a gateway has a single loader,
    so passing a fresh object per call would exercise the isolation gate instead
    of the behaviour each test names.
    """
    return object()


class TestSkillsCatalogSingleFlight:
    """Concurrent readers must share one assembly.

    This is the whole fix. Measured against a counting assembler, 8 simultaneous
    reads produced 8 assemblies -- a 0% elimination rate precisely under the
    contention the slow samples came from.
    """

    @pytest.mark.asyncio
    async def test_concurrent_misses_coalesce_into_one_assembly(self, stub_assembly, loader):
        results = await asyncio.gather(
            *[prompts._assemble_skills_catalog(loader, Path("/proj/a")) for _ in range(8)]
        )
        assert stub_assembly["n"] == 1, (
            "each concurrent reader assembled its own catalog; without coalescing the "
            "endpoint pays N scans exactly when it is contended"
        )
        assert all(r is results[0] for r in results), "joined readers got different objects"

    @pytest.mark.asyncio
    async def test_a_later_sequential_read_reassembles(self, stub_assembly, loader):
        """Nothing survives the burst, so the recorded no-result-cache default holds.

        This is the property that removes every invalidation obligation: a read
        that is not part of a concurrent burst scans current on-disk state, so an
        out-of-app edit can never be hidden and no mutator owes this code a call.
        """
        await prompts._assemble_skills_catalog(loader, Path("/proj/a"))
        await prompts._assemble_skills_catalog(loader, Path("/proj/a"))
        assert stub_assembly["n"] == 2, (
            "a second, non-concurrent read was served from retained rows -- the join "
            "is storing a result past its burst, which reintroduces staleness"
        )
        assert not prompts._catalog_handoff, "the handoff outlived its burst"
        assert not prompts._catalog_waiters, "waiter bookkeeping leaked"

    @pytest.mark.asyncio
    async def test_different_keys_serialize_on_the_one_global_lock(self, monkeypatch, loader):
        """Two projects share ONE assembly lock, so they serialize -- by design.

        Pinned in the direction actually shipped: this is the cost the smaller
        shape accepts, so reintroducing per-key locks fails here and the trade gets
        re-decided deliberately rather than drifting back in. The recorded escape,
        if this ever bites, is a per-key in-flight future (see the spec).
        """
        overlap = {"now": 0, "max": 0}

        async def _assemble(skills, project_dir):
            overlap["now"] += 1
            overlap["max"] = max(overlap["max"], overlap["now"])
            await asyncio.sleep(0)
            overlap["now"] -= 1
            return [{"name": str(project_dir)}]

        monkeypatch.setattr(prompts, "_assemble_skills_catalog_uncached", _assemble)
        await asyncio.gather(
            prompts._assemble_skills_catalog(loader, Path("/proj/a")),
            prompts._assemble_skills_catalog(loader, Path("/proj/b")),
        )
        assert overlap["max"] == 1, (
            "two assemblies overlapped, so the single global assembly lock is not "
            "serializing them -- the coalescing guarantee is weaker than documented"
        )

    @pytest.mark.asyncio
    async def test_a_different_loader_does_not_join(self, stub_assembly):
        """The join applies loader IDENTITY, not just the key.

        The key is (home, project) and does NOT include the loader, so two readers
        holding DIFFERENT loaders collide on one in-flight entry. Without the
        identity check the second is handed rows assembled from a catalog it never
        asked for.
        """
        loader_a = object()
        loader_b = object()
        results = await asyncio.gather(
            prompts._assemble_skills_catalog(loader_a, Path("/proj/a")),
            prompts._assemble_skills_catalog(loader_b, Path("/proj/a")),
        )
        assert stub_assembly["n"] == 2, (
            "a reader with a different loader joined an assembly started under another "
            "loader, so it received rows for a catalog it never asked for"
        )
        assert results[0] is not results[1], "two distinct loaders were served the same object"

    @pytest.mark.asyncio
    async def test_the_assembly_lock_is_released_when_the_assembly_finishes(
        self, stub_assembly, loader
    ):
        """A finished assembly must not leave the coalescing lock held.

        The lock is a single module global, so one still held after the assembly
        returns would stall EVERY later reader, not just that key's.
        """
        await prompts._assemble_skills_catalog(loader, Path("/proj/a"))
        assert (
            not prompts._catalog_assembly_lock.locked()
        ), "the global assembly lock stayed held after completion"


class TestNothingOwesTheCatalogAnInvalidation:
    """The absence of an invalidation surface is the point, so it is asserted."""

    def test_no_invalidator_exists_to_call(self):
        """A join-only design needs no mutator cooperation; keep it that way.

        An earlier revision exposed ``invalidate_skills_catalog`` and called it from
        19 sites across 9 modules -- an obligation on every future catalog mutator,
        and the review finding that removed the stored entry. If a stored result is
        ever reintroduced this fails, forcing that trade to be re-argued rather than
        re-entered quietly.
        """
        assert not hasattr(prompts, "invalidate_skills_catalog"), (
            "an invalidator is back, which means something is being retained that "
            "mutators must now know about"
        )
        for gone in ("_skills_catalog_cache", "_SKILLS_CATALOG_TTL_SECS"):
            assert not hasattr(prompts, gone), f"{gone} is back: the TTL store returned"

    def test_no_module_calls_an_invalidator(self):
        """Repo-wide: nothing imports or calls a catalog invalidator any more."""
        import subprocess

        from kiro_crew.subprocess_utf8 import UTF8_TEXT

        root = Path(prompts.__file__).resolve().parents[3]
        found = subprocess.run(
            ["grep", "-rl", "invalidate_skills_catalog", str(root)],
            capture_output=True,
            **UTF8_TEXT,
        )
        hits = [ln for ln in found.stdout.splitlines() if not ln.endswith(".pyc")]
        assert hits == [], f"invalidation calls survive in: {hits}"
        # Positive control: the same search finds a symbol that IS present, so a
        # clean result above is a fact about the tree rather than a broken grep.
        control = subprocess.run(
            ["grep", "-rl", "_assemble_skills_catalog", str(root)],
            capture_output=True,
            **UTF8_TEXT,
        )
        assert control.stdout.strip(), "the control search found nothing; the grep is broken"


class TestCrossAgentIsolationEndToEnd:
    """Two agents in ONE process must each get their own listing, either order.

    This is the shape a coarsened cache key produces: one caller sees too few
    skills and another too many, decided by which asked first — an
    order-dependent pair that reads like flakiness. Driving both agents through
    the real endpoint in one process pins it directly, so a join that ever shared
    the FILTERED result fails whichever agent asked second.

    ``?agent=`` is applied downstream as a comprehension over the assembled rows,
    so it correctly does NOT belong in the key — this test is what keeps that true
    rather than merely currently-true.
    """

    @pytest.fixture
    def home(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.delenv("KIROCREW_HOME", raising=False)
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        # agent_skill_globs resolves its agents dir from a module constant
        # computed at import time off the REAL home, so $HOME alone would leave
        # it reading the operator's own ~/.kiro/agents and skipping the filter.
        monkeypatch.setattr(
            "kiro_crew.agent_discovery._KIRO_AGENTS_DIR", tmp_path / ".kiro" / "agents"
        )
        return tmp_path

    @staticmethod
    def _state() -> MagicMock:
        from kiro_crew.skills import SkillsLoader

        # A real loader, not a bare MagicMock: _get_skills treats any attribute
        # as "already built", and a mock would be serialized into the response.
        state = MagicMock(_slots={}, context_builder=None)
        state._standalone_skills = SkillsLoader(install_builtins=False)
        return state

    @pytest.mark.asyncio
    @pytest.mark.parametrize("order", [("custom", "plain"), ("plain", "custom")])
    async def test_each_agent_gets_its_own_listing(self, home, order):
        _write_skill(home / ".kiro" / "skills", "alpha")
        _write_skill(home / ".kiro" / "skills", "beta")
        agents_dir = home / ".kiro" / "agents"
        agents_dir.mkdir(parents=True)
        # `custom` maps one skill explicitly -> filtered envelope, {alpha}.
        agents_dir.joinpath("custom.json").write_text(
            json.dumps({"name": "custom", "resources": ["skill://~/.kiro/skills/alpha/SKILL.md"]})
        )
        # `plain` maps none -> legacy bare array, the whole catalog.
        agents_dir.joinpath("plain.json").write_text(json.dumps({"name": "plain"}))

        expected = {"custom": ({"alpha"}, True), "plain": ({"alpha", "beta"}, False)}
        async with TestClient(TestServer(_make_app(self._state()))) as client:
            for position, agent in enumerate(order, start=1):
                resp = await client.get("/api/skills", params={"agent": agent})
                assert resp.status == 200
                payload = await resp.json()
                want_names, want_envelope = expected[agent]
                assert isinstance(
                    payload, dict if want_envelope else list
                ), f"{agent} got the wrong response shape when asked {position} of {len(order)}"
                rows = payload["skills"] if want_envelope else payload
                assert {
                    s["name"] for s in rows
                } == want_names, f"{agent} was served another agent's listing (order {order})"
