"""An overlapping close must not be reported as a definitive refusal.

A "definitive, retry" answer tells the client the slot is provably still open. While a
second close of the same object can still pop it, that advice can aim the retry at whatever
holds the key next -- a same-key replacement the other close is about to hand over.

The count lives on the SLOT, so the surviving row can also PUBLISH it: a read reporting
``closing=False`` is the terminal outcome that lets a withheld row be released once every
close of that object has finished without popping it.
"""

from __future__ import annotations

import asyncio

import pytest

from kiro_crew.dashboard import chat_handlers


class _Slot:
    def __init__(self, in_flight: int = 0) -> None:
        self._closes_in_flight = in_flight

    def cancel_close(self) -> None:
        return None


class _State:
    def __init__(self, slots: dict[str, object]) -> None:
        self._slots = slots

    def get_slot(self, name: str) -> object | None:
        return self._slots.get(name)

    def push_slots_update(self) -> None:
        return None


def test_presence_is_not_definitive_while_another_close_can_still_pop() -> None:
    slot = _Slot(2)
    state = _State({"chat-1": slot})

    assert chat_handlers._slot_present_and_ours(state, "chat-1", slot) is False


def test_presence_is_never_definitive_for_a_replaced_object() -> None:
    state = _State({"chat-1": _Slot(1)})

    assert chat_handlers._slot_present_and_ours(state, "chat-1", _Slot(1)) is False


def test_a_replacements_own_closes_never_count_as_overlapping() -> None:
    original = _Slot(1)
    replacement = _Slot(5)
    state = _State({"chat-1": original})
    assert replacement._closes_in_flight == 5

    assert chat_handlers._slot_present_and_ours(state, "chat-1", original) is True


def test_close_slot_counts_overlapping_closes_on_the_slot(monkeypatch) -> None:
    """Driven through production ``close_slot``: the count is ITS behaviour, not a wrapper's.

    The counting is inline rather than a decorator because
    :func:`kiro_crew._facade_compose.compose` carries ``__closure__`` across untouched, so
    a decorated body would keep running on its owner module's globals. Pinning the
    invariant through the real entry point is what survives that choice.
    """
    seen: list[bool] = []
    release = asyncio.Event()

    async def _inner(state: object, slot: object, name: str, **_kw: object) -> None:
        seen.append(chat_handlers._overlapping_close(slot))
        await release.wait()

    monkeypatch.setattr(chat_handlers, "_close_slot", _inner)

    slot = _Slot()
    tracked = _State({"chat-1": slot})

    async def drive() -> None:
        first = asyncio.create_task(chat_handlers.close_slot(tracked, slot, "chat-1"))
        second = asyncio.create_task(chat_handlers.close_slot(tracked, slot, "chat-1"))
        await asyncio.sleep(0)
        release.set()
        await asyncio.gather(first, second)

    asyncio.run(drive())

    assert seen[0] is False
    assert seen[1] is True
    assert slot._closes_in_flight == 0


def test_a_failed_close_republishes_once_the_count_has_drained(monkeypatch) -> None:
    """A failure arm pushes its terminal frame before the tracker decrements."""
    slot = _Slot()
    state = _State({"chat-1": slot})
    state.pushed = []
    state.push_slots_update = lambda: state.pushed.append(slot._closes_in_flight)

    async def _inner(state: object, slot: object, name: str, **_kw: object) -> None:
        state.push_slots_update()
        raise RuntimeError("close failed")

    monkeypatch.setattr(chat_handlers, "_close_slot", _inner)

    with pytest.raises(RuntimeError):
        asyncio.run(chat_handlers.close_slot(state, slot, "chat-1"))

    assert state.pushed == [1, 0], state.pushed


@pytest.mark.parametrize("in_flight", [0, 1])
def test_a_lone_close_leaves_presence_usable(in_flight: int) -> None:
    slot = _Slot(in_flight)
    state = _State({"chat-1": slot})

    assert chat_handlers._slot_present_and_ours(state, "chat-1", slot) is True
