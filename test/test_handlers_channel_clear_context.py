"""Tests for /api/channels/{id}/clear-context handler."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kiro_crew.dashboard.handlers_channel import api_channel_clear_context


def _make_agent(agent_id: str, role: str, session_key: str):
    agent = MagicMock()
    agent.id = agent_id
    agent.role = role
    agent.session_key = session_key
    return agent


def _make_channel(ch_id: str, agents: dict):
    ch = MagicMock()
    ch.id = ch_id
    ch.members = agents
    ch.messages = [MagicMock(), MagicMock()]
    ch._msg_index = {"msg1": MagicMock(), "msg2": MagicMock()}
    ch.exchange_counts = {("a", "b"): 3}
    ch._save = MagicMock()
    return ch


def _make_request(ch_id: str, body: dict, channel=None, sessions=None):
    request = MagicMock()
    request.match_info = {"id": ch_id}
    request.json = AsyncMock(return_value=body)

    mgr = MagicMock()
    mgr.get.return_value = channel
    request.app = {
        "state": MagicMock(sessions=sessions or AsyncMock()),
        "channel_manager": mgr,
    }
    return request


class TestChannelClearContext:
    @pytest.mark.asyncio
    async def test_returns_404_when_channel_not_found(self):
        request = _make_request("nonexistent", {}, channel=None)
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=None)),
        ):
            resp = await api_channel_clear_context(request)
        assert resp.status == 404

    @pytest.mark.asyncio
    async def test_clears_all_agents(self):
        agents = {
            "a1": _make_agent("a1", "Researcher", "channel:ch1:a1"),
            "a2": _make_agent("a2", "Writer", "channel:ch1:a2"),
        }
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()
        sessions.discard_conversation = AsyncMock()

        request = _make_request("ch1", {"scope": "all"}, channel=ch, sessions=sessions)
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        body = json.loads(resp.body)
        assert body["ok"] is True
        assert set(body["cleared"]) == {"Researcher", "Writer"}
        assert sessions.discard_conversation.call_count == 2
        assert ch.messages == []
        assert ch._msg_index == {}
        assert ch.exchange_counts == {}
        ch._save.assert_called_once()

    @pytest.mark.asyncio
    async def test_clears_single_agent(self):
        agents = {
            "a1": _make_agent("a1", "Researcher", "channel:ch1:a1"),
            "a2": _make_agent("a2", "Writer", "channel:ch1:a2"),
        }
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()
        sessions.discard_conversation = AsyncMock()

        request = _make_request(
            "ch1", {"scope": "agent", "agent_id": "a1"}, channel=ch, sessions=sessions
        )
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        body = json.loads(resp.body)
        assert body["ok"] is True
        assert body["cleared"] == ["Researcher"]
        assert body["busy"] == []
        # skip_if_busy: a turn can be streaming on the channel agent, so forcing the
        # teardown would drop that reply; the refusal is reported in `busy` instead.
        sessions.discard_conversation.assert_called_once_with("channel:ch1:a1", skip_if_busy=True)
        # Messages and exchange_counts NOT cleared for single-agent scope
        assert len(ch.messages) == 2

    @pytest.mark.asyncio
    async def test_a_key_with_no_live_session_counts_as_cleared_not_busy(self):
        """`reset` returning False does not mean a turn is in flight.

        A member whose session is fresh or expired holds a `session_key` with no live
        session, so `reset` answers False for the same reason a busy one does. Counting
        that as busy made the endpoint answer `409 turn_in_flight` for a channel with
        nothing to clear -- a refusal the caller can never satisfy by waiting, because
        no turn is running. `has_session` separates the two.
        """
        agents = {"a1": _make_agent("a1", "Researcher", "channel:ch1:a1")}
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()
        sessions.discard_conversation = AsyncMock(return_value=False)
        sessions.has_session = MagicMock(return_value=False)

        request = _make_request(
            "ch1", {"scope": "agent", "agent_id": "a1"}, channel=ch, sessions=sessions
        )
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        assert resp.status == 200, (
            "a key with no live session is already in the state the caller asked for, so "
            f"it must not answer 409; got {resp.status}"
        )
        body = json.loads(resp.body)
        assert body.get("busy") in (None, []), f"and it must not be reported busy; got {body}"

    @pytest.mark.asyncio
    async def test_a_total_refusal_does_not_destroy_the_shared_message_log(self):
        """The 409 must be answered BEFORE the buffer wipe, not after it.

        `scope="all"` on a channel where every member is mid-turn clears nothing, and
        the wipe below the reset loop is SHARED channel state that `_save()` persists.
        Answering 409 after running it destroyed the transcript the response reports as
        untouched -- silent, irreversible, and the opposite of what the caller is told.
        Asserts the buffers survive AND that nothing was persisted, since either alone
        would pass while the other still lost the log.
        """
        agents = {
            "a1": _make_agent("a1", "Researcher", "channel:ch1:a1"),
            "a2": _make_agent("a2", "Analyst", "channel:ch1:a2"),
        }
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()
        sessions.discard_conversation = AsyncMock(return_value=False)

        request = _make_request("ch1", {"scope": "all"}, channel=ch, sessions=sessions)
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        assert resp.status == 409, f"a clear that cleared nothing must not answer 200; got {resp.status}"
        assert len(ch.messages) == 2, (
            "the shared message log must SURVIVE a total refusal -- the 409 reports it "
            f"untouched, so wiping it makes the response a lie; got {len(ch.messages)}"
        )
        assert len(ch._msg_index) == 2, f"the message index must survive too; got {ch._msg_index}"
        assert ch.exchange_counts == {("a", "b"): 3}, f"and the counts; got {ch.exchange_counts}"
        ch._save.assert_not_called()

    @pytest.mark.asyncio
    async def test_the_broadcast_carries_only_what_its_listener_reads(self):
        """A field no consumer reads is a claim about the wire that nothing checks.

        The gate above the broadcast forces `scope == "all"` and `busy == []`, so a per-agent
        id and a busy list are not merely unread here -- they are empty BY CONSTRUCTION, and a
        later reader trusting either would be reading a constant. The sole listener keys on
        `channel_id` and `scope`; the payload now states exactly that and nothing more.
        """
        agents = {"a1": _make_agent("a1", "Researcher", "channel:ch1:a1")}
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()
        sessions.discard_conversation = AsyncMock(return_value=True)
        sessions.has_session = MagicMock(return_value=True)

        request = _make_request("ch1", {"scope": "all"}, channel=ch, sessions=sessions)
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        assert resp.status == 200
        sent = [c.args for c in ch._broadcast.call_args_list if c.args and c.args[0] == "channel_context_cleared"]
        assert len(sent) == 1, f"a clean clear must announce itself exactly once; got {sent}"
        assert set(sent[0][1]) == {"channel_id", "scope"}, (
            "the payload must carry only the fields the listener reads -- anything else is "
            f"an unchecked wire claim; got {sorted(sent[0][1])}"
        )

    @pytest.mark.asyncio
    async def test_a_partial_clear_does_not_announce_a_wipe_to_other_tabs(self):
        """The broadcast is what OTHER tabs act on, so it must follow the wipe, not the request.

        A listener handles `channel_context_cleared` by REPLACING its retained transcript with an
        empty list. Announcing it unconditionally meant a partial clear -- which deliberately keeps
        the shared log for the busy member -- destroyed that same log in every other tab, out of
        band from the response and with nothing to restore it. The event now follows the wipe.
        """
        agents = {
            "a1": _make_agent("a1", "Researcher", "channel:ch1:a1"),
            "a2": _make_agent("a2", "Analyst", "channel:ch1:a2"),
        }
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()
        sessions.discard_conversation = AsyncMock(side_effect=[True, False])
        sessions.has_session = MagicMock(return_value=True)

        request = _make_request("ch1", {"scope": "all"}, channel=ch, sessions=sessions)
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        assert resp.status == 200
        body = json.loads(resp.body)
        assert body.get("busy"), f"precondition: this must be the partial path; got {body}"
        assert len(ch.messages) == 2, "precondition: the shared log survived the partial clear"
        events = [c.args[0] for c in ch._broadcast.call_args_list if c.args]
        assert "channel_context_cleared" not in events, (
            "a partial clear kept the shared log, so announcing it tells every other tab to "
            f"replace that log with an empty list; broadcast {events}"
        )

    @pytest.mark.asyncio
    async def test_a_partial_clear_leaves_the_shared_log_the_busy_member_still_references(self):
        """A PARTIAL clear-all must not wipe shared state, only a fully clean one may.

        The total refusal answers 409 above the wipe, and a fully clean clear reaches it
        legitimately -- but the PARTIAL case answers 200 and fell through to the same
        unconditional wipe. The busy member keeps the LLM context that quotes the shared
        transcript, so emptying it strands that member: its in-flight reply appends to a
        log the rest of its context still refers to, and no path restores what was lost.
        """
        agents = {
            "a1": _make_agent("a1", "Researcher", "channel:ch1:a1"),
            "a2": _make_agent("a2", "Analyst", "channel:ch1:a2"),
        }
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()
        # a1 clears, a2 is mid-turn: the 200 partial path, not the 409 total one.
        sessions.discard_conversation = AsyncMock(side_effect=[True, False])
        sessions.has_session = MagicMock(return_value=True)

        request = _make_request("ch1", {"scope": "all"}, channel=ch, sessions=sessions)
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        assert resp.status == 200, (
            "a partial clear cleared something, so the contract's 200 stands -- `ok` is what "
            f"marks it incomplete; got {resp.status}"
        )
        body = json.loads(resp.body)
        assert (
            body.get("ok") is False
        ), f"a caller reading only `ok` must see a partial clear as incomplete; got {body}"
        assert body.get("busy"), f"precondition: the partial path must report a busy member; got {body}"
        assert len(ch.messages) == 2, (
            "the shared log must SURVIVE a partial clear -- the member reported busy keeps "
            f"the context that references it; got {len(ch.messages)}"
        )
        assert len(ch._msg_index) == 2, f"the message index must survive too; got {ch._msg_index}"
        assert ch.exchange_counts == {("a", "b"): 3}, f"and the counts; got {ch.exchange_counts}"

    @pytest.mark.asyncio
    async def test_the_refusal_carries_a_machine_readable_code(self):
        """`error` prose is advisory and untranslatable; `code` is the contract.

        The dashboard renders `res.error` verbatim into a localized UI, so a coded
        response is what lets a caller branch on the cause. Pinned here as well as in
        the repo-wide ratchet so the reason is readable at the site that owes it.
        """
        agents = {"a1": _make_agent("a1", "Researcher", "channel:ch1:a1")}
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()
        sessions.discard_conversation = AsyncMock(return_value=False)

        request = _make_request(
            "ch1", {"scope": "agent", "agent_id": "a1"}, channel=ch, sessions=sessions
        )
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        body = json.loads(resp.body)
        assert body.get("code") == "turn_in_flight", (
            "the refusal must carry a machine-readable code, not prose alone; " f"got {body}"
        )

    @pytest.mark.asyncio
    async def test_a_total_refusal_answers_409_not_a_false_success(self):
        """Reporting the refusal into a field nothing reads IS the silent no-op.

        An earlier version answered 200 with a `busy` list and no reader, so the caller
        rendered a clear that never happened -- a success signal that is not proof of
        effect. When NOTHING cleared the endpoint now fails, which reaches the user through
        the caller's existing error path. Declining the reset is still right: forcing it
        would tear down a streaming reply.
        """
        agents = {"a1": _make_agent("a1", "Researcher", "channel:ch1:a1")}
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()
        sessions.discard_conversation = AsyncMock(return_value=False)

        request = _make_request(
            "ch1", {"scope": "agent", "agent_id": "a1"}, channel=ch, sessions=sessions
        )
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        assert resp.status == 409, f"a clear that cleared nothing must not answer 200; got {resp.status}"
        body = json.loads(resp.body)
        assert "Researcher" in body.get("error", ""), (
            "and the error must name what refused, or the user cannot tell what to retry; "
            f"got {body}"
        )
        assert body["busy"] == ["Researcher"]

    @pytest.mark.asyncio
    async def test_returns_404_for_unknown_agent_id(self):
        agents = {"a1": _make_agent("a1", "Researcher", "channel:ch1:a1")}
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()

        request = _make_request(
            "ch1", {"scope": "agent", "agent_id": "nonexistent"}, channel=ch, sessions=sessions
        )
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        assert resp.status == 404

    @pytest.mark.asyncio
    async def test_returns_400_on_missing_body(self):
        """A request with no parseable body returns 400 (not a silent clear-all)."""
        agents = {"a1": _make_agent("a1", "Researcher", "channel:ch1:a1")}
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()

        request = _make_request("ch1", {}, channel=ch, sessions=sessions)
        request.json = AsyncMock(side_effect=Exception("no body"))
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        assert resp.status == 400

    @pytest.mark.asyncio
    async def test_returns_400_when_scope_agent_but_no_agent_id(self):
        """scope=agent without agent_id returns 400 (not a silent clear-all)."""
        agents = {"a1": _make_agent("a1", "Researcher", "channel:ch1:a1")}
        ch = _make_channel("ch1", agents)
        sessions = AsyncMock()

        request = _make_request(
            "ch1", {"scope": "agent"}, channel=ch, sessions=sessions
        )
        with patch(
            "kiro_crew.dashboard.handlers_channel._mgr",
            return_value=MagicMock(get=MagicMock(return_value=ch)),
        ):
            resp = await api_channel_clear_context(request)

        assert resp.status == 400
