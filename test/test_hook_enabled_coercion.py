"""``ScriptHook.from_dict`` arms a row only if its stored ``enabled`` says on.

``hooks.json`` is hand-editable and ``bool("false")`` is True, so reading the
field raw loaded a row written ``"enabled": "false"`` as a truthy STRING:
``fire`` skips on ``not hook.enabled``, the Hooks page's switch reads
``!hook.enabled``, and ``toggle`` keys on the same, so the row read ARMED and
its command ran.

Coercing the field fixes that spelling and introduces the opposite hazard.
Reading raw also left ``null``, ``0`` and ``""`` falsy, so a coercion defaulting
to True would arm a row an operator had switched off, and the next ``_save``
would write it back as ``true``. The contract is therefore one-directional: the
loader may never arm a row that reading the field raw left off.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kiro_crew.hooks import HOOK_EVENT_USER_PROMPT_SUBMIT, ScriptHookStore


def _load_one(tmp_path: Path, enabled: object, omit: bool = False) -> bool:
    row: dict[str, object] = {
        "id": "h0",
        "name": "n",
        "event": HOOK_EVENT_USER_PROMPT_SUBMIT,
        "command": "true",
        "timeout": 30,
    }
    if not omit:
        row["enabled"] = enabled
    (tmp_path / "hooks.json").write_text(json.dumps({"hooks": [row]}), encoding="utf-8")
    loaded = ScriptHookStore(tmp_path).list_all()
    assert len(loaded) == 1, row
    return loaded[0].enabled


@pytest.mark.parametrize("stored", [None, 0, "", "false", "0", "no", "off", "False"])
def test_a_stored_value_that_does_not_say_on_loads_off(tmp_path: Path, stored: object) -> None:
    assert _load_one(tmp_path, stored) is False


@pytest.mark.parametrize("stored", [True, "true", "1", "yes", "on"])
def test_a_stored_value_that_says_on_loads_on(tmp_path: Path, stored: object) -> None:
    assert _load_one(tmp_path, stored) is True


def test_an_absent_field_still_loads_on(tmp_path: Path) -> None:
    """The one shape the False default must not reach.

    ``data.get("enabled", True)`` hands ``_coerce_bool`` a real bool, which it
    returns as-is, so the default never applies to an absent key. Without this
    the fix would switch off every row written before the field existed.
    """
    assert _load_one(tmp_path, None, omit=True) is True


@pytest.mark.parametrize("stored", [1, "yep", [1]])
def test_a_value_that_is_neither_a_bool_nor_a_known_spelling_loads_off(
    tmp_path: Path, stored: object
) -> None:
    """Narrower than reading raw, and deliberately so.

    Raw truthiness armed these. Nothing writes them -- ``_save`` goes through
    ``asdict`` on a bool field -- so each one is a hand edit whose intent is
    unreadable, and off is the answer that cannot run a command nobody
    confirmed.
    """
    assert _load_one(tmp_path, stored) is False


def test_the_event_is_one_that_fires(tmp_path: Path) -> None:
    """The fixture's own control, so the suite above cannot pass vacuously.

    Six of the authorable events are stored switched off by rule regardless of
    what the row says. A test written on one of those would report every shape
    as off and prove nothing, so every case above uses an event the gateway
    really fires.
    """
    assert _load_one(tmp_path, True) is True
    assert _load_one(tmp_path, "false") is False
