"""The over-capacity fork copy states a ceiling; that number must not drift.

The refusal names a bound so a user at the cap is not left guessing. The bound is
hardcoded in localized copy because the client is never told the number, so nothing
but this test ties it to the constant the backend actually enforces.
"""

import json
import pathlib

from kiro_crew.dashboard.state import _MAX_SLOT_MESSAGES

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
_EN = _REPO_ROOT / "website" / "src" / "i18n" / "locales" / "en.manual.json"


class TestForkCeilingCopyMatchesTheSlotCap:
    def test_the_english_refusal_states_the_enforced_ceiling(self) -> None:
        page = json.loads(_EN.read_text(encoding="utf-8"))["pages"]["chatPage"]
        expected = f"{_MAX_SLOT_MESSAGES:,}"
        for key in ("fork_too_large_error_head", "fork_too_large_error_tail"):
            copy = page[key]
            assert expected in copy, (
                f"{key} does not state the enforced ceiling {expected}: {copy!r} — "
                "the cap moved and the localized copy now misinforms the user"
            )
