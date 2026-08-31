"""A cut restatement must show that it was cut, and cut where the checkbox does.

The `*Recommended:*` line sliced the label at 150 characters with no marker, so a long
label produced a line that reads as complete and no longer matches the checkbox text
verbatim -- the reader cannot find the option the line names. Slack caps a context
element, so the cut itself has to stay. It also has to fall at the checkbox's own
visible cap, or the two surfaces show different text for the same option.
"""

from __future__ import annotations

from kiro_crew.slack.format import _CHECKBOX_TEXT_CAP, build_options_blocks

LONG = "Take the out-of-band control tag " + "and delete every deny list " * 8
SHORT = "Merge it now"


def _context_texts(blocks: list[dict]) -> str:
    out = []
    for block in blocks:
        for element in block.get("elements", []):
            if isinstance(element, dict) and element.get("type") == "mrkdwn":
                out.append(element.get("text", ""))
    return "\n".join(out)


def _checkbox_texts(blocks: list[dict]) -> list[str]:
    out = []
    for block in blocks:
        for element in block.get("elements", []):
            for option in (element or {}).get("options", []) if isinstance(element, dict) else []:
                out.append(option.get("text", {}).get("text", ""))
    return out


class TestALongRecommendationIsMarkedAsCut:
    def test_the_fixture_is_actually_longer_than_the_cap(self):
        # Guards the guard: a short fixture would make the assertions below vacuous.
        assert len(LONG) > _CHECKBOX_TEXT_CAP

    def test_the_line_ends_with_an_ellipsis(self):
        text = _context_texts(build_options_blocks([LONG, SHORT], recommended=LONG))
        assert "*Recommended:*" in text, text
        assert "..." in text, text

    def test_the_kept_prefix_is_still_the_labels_own_opening(self):
        text = _context_texts(build_options_blocks([LONG, SHORT], recommended=LONG))
        assert LONG[:40] in text, text


class TestTheLineCutsWhereTheCheckboxDoes:
    def test_the_shown_label_equals_the_checkbox_text(self):
        blocks = build_options_blocks([LONG, SHORT], recommended=LONG)
        boxes = _checkbox_texts(blocks)
        assert boxes, "no checkbox options rendered -- re-anchor this scan"
        box = next(b for b in boxes if b.startswith(LONG[:20]))

        line = next(t for t in _context_texts(blocks).splitlines() if "*Recommended:*" in t)
        shown = line.split("*Recommended:* ", 1)[1]
        # A containment test would pass on any wider cut, since the narrower cut is its
        # prefix -- only equality pins the two surfaces to the same width.
        assert shown.startswith(box) and len(shown) == len(box) + len("..."), (shown, box)


class TestAShortRecommendationIsNotMarked:
    def test_no_ellipsis_is_added_when_nothing_was_cut(self):
        text = _context_texts(build_options_blocks([SHORT, "Hold it"], recommended=SHORT))
        assert f"*Recommended:* {SHORT}" in text, text
        assert "..." not in text, text
