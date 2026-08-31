"""The restatement follows the marked choice past the checkbox cap.

Slack caps a checkboxes element, so choices past the cap are chunked to plain text in an
overflow block. Suppressing the restatement there dropped the recommendation silently on a
long list, which is the worse failure: the marked choice is still READABLE in the overflow,
so the line now names it and points at where to find it and says how to pick it. A recommendation naming no choice
at all is still suppressed -- there is nothing to point to.
"""

from __future__ import annotations

from kiro_crew.slack.format import build_options_blocks


def _texts(blocks: list[dict]) -> str:
    out = []
    for block in blocks:
        for element in block.get("elements", []):
            if isinstance(element, dict) and element.get("type") == "mrkdwn":
                out.append(element.get("text", ""))
    return "\n".join(out)


def _labels(blocks: list[dict]) -> list[str]:
    out = []
    for block in blocks:
        for element in block.get("elements", []):
            if not isinstance(element, dict):
                continue
            for option in element.get("options") or []:
                out.append(option.get("text", {}).get("text", ""))
    return out


# Past any plausible checkbox cap, so the tail is certain to be chunked to text.
MANY = [f"Choice {i}" for i in range(1, 15)]


class TestTheRestatementFollowsTheControls:
    def test_a_rendered_recommendation_is_restated(self):
        blocks = build_options_blocks(MANY, recommended="Choice 1")
        assert "Choice 1" in _labels(blocks), "fixture wrong: expected a control for Choice 1"
        assert "Recommended:" in _texts(blocks)

    def test_an_overflowed_recommendation_is_restated_with_a_pointer(self):
        blocks = build_options_blocks(MANY, recommended=MANY[-1])
        assert MANY[-1] not in _labels(blocks), "fixture wrong: expected the tail to overflow"
        text = _texts(blocks)
        assert "Recommended:" in text, text
        assert (
            "(reply with it as a message — listed in full below, not clickable above)" in text
        ), text

    def test_a_dropped_marked_label_over_the_cap_is_cut_but_readable_in_full_below(self):
        """The restatement is cut at the checkbox cap, so the copy must point somewhere it is not.

        Cutting the line and telling the user to reply with "it" names text the message
        never shows in full anywhere the copy points to.
        """
        long_label = "Merge the release branch " + "x" * 90
        blocks = build_options_blocks(MANY + [long_label], recommended=long_label)
        assert long_label not in _labels(blocks), "fixture wrong: expected the label to overflow"
        text = _texts(blocks)
        assert "..." in text, "fixture wrong: expected the restatement to be cut"
        assert long_label in text, "the full label must be readable in the listing below"
        assert "listed in full below" in text, text

    def test_a_kept_recommendation_carries_no_pointer(self):
        blocks = build_options_blocks(MANY, recommended="Choice 1")
        text = _texts(blocks)
        assert "Recommended:" in text, text
        assert (
            "(reply with it as a message — listed in full below, not clickable above)" not in text
        ), text

    def test_a_recommendation_naming_no_choice_at_all_is_not_restated(self):
        blocks = build_options_blocks(["Alpha", "Beta"], recommended="Gamma")
        assert "Recommended:" not in _texts(blocks), _texts(blocks)

    def test_the_controls_are_unaffected_by_the_suppression(self):
        blocks = build_options_blocks(MANY, recommended=MANY[-1])
        assert _labels(blocks) == MANY[: len(_labels(blocks))]
