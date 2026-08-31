"""A Slack button's ``value`` must be exactly the label the producer wrote.

The value is echoed back as the user's own message on submit, so anything the pipeline adds
or removes on the way is submitted as though the user typed it.

This used to be a strip obligation: the recommendation was a ``(recommended)`` prefix inside
the label, and the extractor had to remove it before the label reached a button -- while
REFUSING to remove it whenever doing so would expose a command. Out of band there is nothing
to remove, so the obligation inverts: the pipeline must leave the label alone, and the tag
must not reach the wire.
"""

from __future__ import annotations

import pytest

from kiro_crew.slack.format import (
    build_options_blocks,
    extract_options_with_recommendation,
)

TAGGED = "<!-- recommended:1 -->\n[OPTIONS: Merge it now | Keep it open]"


def _button_values(choices: list[str]) -> list[str]:
    """Every ``value`` Block Kit would carry for *choices*."""
    values: list[str] = []
    for block in build_options_blocks(choices):
        for element in block.get("elements", []):
            for option in element.get("options", []):
                values.append(option["value"])
    return values


class TestTheLabelReachesTheButtonUnchanged:
    def test_extraction_returns_the_labels_verbatim(self):
        _body, choices, recommended = extract_options_with_recommendation(TAGGED)
        assert choices == ["Merge it now", "Keep it open"]
        assert recommended == "Merge it now"

    def test_the_emitted_button_value_is_exactly_the_label(self):
        _body, choices, _ = extract_options_with_recommendation(TAGGED)
        assert _button_values(choices) == ["Merge it now", "Keep it open"]

    def test_the_tag_never_becomes_a_choice(self):
        # It is a control tag on its own line, so the trailer parse must not see it as a label.
        _body, choices, _ = extract_options_with_recommendation(TAGGED)
        assert all("recommended:" not in c for c in choices), choices

    def test_the_tag_never_reaches_the_body_either(self):
        body, _choices, _ = extract_options_with_recommendation(TAGGED)
        assert "recommended:1" not in body

    @pytest.mark.parametrize(
        "label",
        ["/clear", "@deploy", "[Monitor wake]", "action::approve", "Run the $deploy skill"],
    )
    def test_a_dispatchable_label_is_carried_verbatim(self, label):
        # No longer a refusal: nothing is stripped, so there is no case in which the pipeline
        # has to CHOOSE between a badge and a safe dispatch. Both hold at once.
        text = "<!-- recommended:1 -->\n[OPTIONS: %s | Hold it]" % label
        _body, choices, recommended = extract_options_with_recommendation(text)
        assert choices == [label, "Hold it"]
        assert recommended == label
        assert _button_values(choices) == [label, "Hold it"]

    def test_a_label_that_merely_looks_like_the_old_marker_is_left_alone(self):
        # The one shape the old extractor DID rewrite. It is ordinary text now.
        assert _button_values(["(recommended) Merge it now"]) == ["(recommended) Merge it now"]

    def test_an_ordinary_label_is_untouched(self):
        assert _button_values(["Merge it now"]) == ["Merge it now"]
