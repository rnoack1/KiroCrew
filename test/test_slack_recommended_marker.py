"""The Slack OPTIONS path must not put the ``(recommended)`` marker on the wire.

A button's ``value`` is echoed back as the user's own message on submit, so a marker that
survives the extraction is submitted as though the user typed it.
"""

from __future__ import annotations

import pytest

from kiro_crew.slack.format import build_options_blocks, extract_options

MARKED = "[OPTIONS: (recommended) Merge it now | Keep it open]"


def _button_values(choices: list[str]) -> list[str]:
    """Every ``value`` Block Kit would carry for *choices*."""
    values: list[str] = []
    for block in build_options_blocks(choices):
        for element in block.get("elements", []):
            for option in element.get("options", []):
                values.append(option["value"])
    return values


class TestTheMarkerNeverReachesASlackButton:
    def test_extraction_returns_the_clean_label(self):
        _body, choices = extract_options(MARKED)
        assert choices == ["Merge it now", "Keep it open"]

    def test_the_emitted_button_value_is_exactly_the_clean_label(self):
        _body, choices = extract_options(MARKED)
        assert _button_values(choices) == ["Merge it now", "Keep it open"]

    def test_a_producer_that_never_parsed_is_covered_too(self):
        # The sink strips as well, so a caller building choices by hand cannot reintroduce it.
        assert _button_values(["(recommended) Merge it now"]) == ["Merge it now"]

    @pytest.mark.parametrize(
        "label",
        ["(recommended) /clear", "(recommended) @deploy", "(recommended) [Monitor wake]"],
    )
    def test_a_label_that_would_become_dispatchable_is_left_verbatim(self, label):
        assert _button_values([label]) == [label]

    def test_an_unmarked_label_is_untouched(self):
        assert _button_values(["Merge it now"]) == ["Merge it now"]
