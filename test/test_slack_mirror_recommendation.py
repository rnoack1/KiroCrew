"""Slack has no badge, so a mirrored recommendation must be restated in the message.

The dashboard-only producer rule tells an agent to MARK a chip instead of naming its
pick in prose, and the dashboard renders that marker as a badge. Slack renders no badge
and the label is stripped before dispatch, so without a substitute a dashboard turn
mirrored into a linked Slack thread shows identical buttons under prose that never says
which one is recommended -- worse than before the marker existed, when the raw marker at
least appeared in the label.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from kiro_crew.slack import format as fmt
from kiro_crew.slack.format import build_options_blocks, extract_options_with_recommendation

SRC = Path(__file__).resolve().parents[1] / "src" / "kiro_crew"


def _texts(blocks: list[dict]) -> str:
    out = []
    for block in blocks:
        for element in block.get("elements", []):
            if isinstance(element, dict) and element.get("type") == "mrkdwn":
                out.append(element.get("text", ""))
            for option in (element.get("options") or []) if isinstance(element, dict) else []:
                out.append(option.get("text", {}).get("text", ""))
    return "\n".join(out)


class TestReadingTheOutOfBandTag:
    def test_it_reports_the_label_the_tag_names(self):
        text = "Body.\n<!-- recommended:1 -->\n[OPTIONS: Merge it now | Hold it]"
        assert extract_options_with_recommendation(text)[2] == "Merge it now"

    def test_it_can_name_a_later_choice(self):
        text = "Body.\n<!-- recommended:2 -->\n[OPTIONS: Merge it now | Hold it]"
        assert extract_options_with_recommendation(text)[2] == "Hold it"

    def test_an_in_label_marker_is_just_label_text_now(self):
        # Nothing is stripped, so this is a choice whose text happens to open with a
        # parenthetical -- and a click sends exactly that.
        text = "Body.\n[OPTIONS: (recommended) Merge it now | Hold it]"
        cleaned, choices, recommended = extract_options_with_recommendation(text)
        assert choices == ["(recommended) Merge it now", "Hold it"]
        assert recommended is None

    def test_an_untagged_list_reports_nothing(self):
        assert (
            extract_options_with_recommendation("Body.\n[OPTIONS: Merge it now | Hold it]")[2]
            is None
        )

    def test_no_options_at_all_reports_nothing(self):
        assert extract_options_with_recommendation("Just prose.")[2] is None

    def test_an_index_the_menu_cannot_honour_reports_nothing(self):
        # A producer bug degrades to "no recommendation", never to a wrong restatement.
        for n in (0, 3, 99):
            text = "Body.\n<!-- recommended:%d -->\n[OPTIONS: Merge it now | Hold it]" % n
            assert extract_options_with_recommendation(text)[2] is None, n

    def test_the_tag_does_not_survive_into_the_body(self):
        # Slack mrkdwn renders an HTML comment literally, so a surviving tag is visible junk.
        text = "Body.\n<!-- recommended:1 -->\n[OPTIONS: Merge it now | Hold it]"
        cleaned = extract_options_with_recommendation(text)[0]
        assert "recommended:1" not in cleaned
        assert cleaned.strip() == "Body."

    def test_a_command_shaped_choice_is_nameable_now(self):
        # Previously unreachable: the strip declined such a label, so it could carry no
        # recommendation. Out of band the label is untouched and the tag names it freely.
        text = "Body.\n<!-- recommended:1 -->\n[OPTIONS: /clear | Hold it]"
        cleaned, choices, recommended = extract_options_with_recommendation(text)
        assert choices == ["/clear", "Hold it"]
        assert recommended == "/clear"


class TestTheMirrorRestatesItAboveTheButtons:
    def test_the_recommendation_is_rendered(self):
        blocks = build_options_blocks(["Merge it now", "Hold it"], recommended="Merge it now")
        assert "*Recommended:* Merge it now" in _texts(blocks)

    def test_it_sits_above_the_controls(self):
        blocks = build_options_blocks(["Merge it now", "Hold it"], recommended="Merge it now")
        kinds = [b.get("type") for b in blocks]
        assert kinds.index("context") < kinds.index("actions")

    def test_the_dispatched_value_never_carries_the_marker(self):
        # The restatement is display only: what a click sends must stay the clean label.
        blocks = build_options_blocks(["Merge it now", "Hold it"], recommended="Merge it now")
        values = [
            option["value"]
            for block in blocks
            for element in block.get("elements", [])
            for option in (element.get("options") or [])
        ]
        assert values == ["Merge it now", "Hold it"]

    def test_an_unmarked_turn_adds_no_line(self):
        blocks = build_options_blocks(["Merge it now", "Hold it"])
        assert "Recommended:" not in _texts(blocks)
        assert [b.get("type") for b in blocks] == ["actions"]


class TestTheRestatedLabelCannotFireASlackEntity:
    """The restatement is the only mrkdwn field here, so it is the only one Slack parses.

    A label is model-authored and reachable by injected external content, and the strip
    happily returns `<!channel>` because `<` is not a reserved dispatch sigil. The
    checkbox label is `plain_text` and the button `value` is echoed back to the session,
    so neither may be escaped -- which is exactly why escaping belongs at this sink.
    """

    ENTITIES = ["<!channel>", "<!here>", "<@U024BE7LH>", "<!everyone>"]

    @pytest.mark.parametrize("entity", ENTITIES)
    def test_the_raw_entity_never_reaches_the_mrkdwn_field(self, entity):
        blocks = build_options_blocks([entity, "Hold it"], recommended=entity)
        mrkdwn = "\n".join(
            element["text"]
            for block in blocks
            for element in block.get("elements", [])
            if isinstance(element, dict) and element.get("type") == "mrkdwn"
        )
        assert mrkdwn, "no mrkdwn field found -- did the block move?"
        assert entity not in mrkdwn, mrkdwn
        assert "&lt;" in mrkdwn, mrkdwn

    def test_the_ampersand_is_escaped_first(self):
        # Escaping `<` before `&` would double-escape into `&amp;lt;`. The marked label is
        # ALSO a choice, which is the only shape that renders a restatement.
        blocks = build_options_blocks(["Tom & <!here>"], recommended="Tom & <!here>")
        text = blocks[0]["elements"][0]["text"]
        assert "&amp;lt;" not in text, text
        assert "&amp; &lt;!here&gt;" in text, text

    def test_the_dispatched_value_is_left_unescaped(self):
        # The value is read back as the user's message, so an escaped entity would
        # change the answer they picked.
        blocks = build_options_blocks(["<!channel> deploy"], recommended="<!channel> deploy")
        values = [
            option["value"]
            for block in blocks
            for element in block.get("elements", [])
            for option in (element.get("options") or [])
        ]
        assert values == ["<!channel> deploy"]


class TestTheMirrorPathIsActuallyWiredToIt:
    """Building the block is not the same as the mirror sending it.

    The reported regression is the WIRING: the mirror can strip the marker and post
    buttons with no substitute while every block-level assertion above still passes.
    """

    def _mirror_region(self) -> str:
        source = (SRC / "dashboard" / "chat_runner.py").read_text(encoding="utf-8")
        start = source.index("mirror response to linked Slack thread")
        return source[start : start + 4000]

    def test_the_region_is_found_at_all(self):
        # Guards the guard: a moved region would make both assertions below vacuous.
        region = self._mirror_region()
        assert "build_options_blocks(" in region
        assert "extract_options_with_recommendation(" in region

    def test_it_reads_the_marker_in_the_same_parse_as_the_strip(self):
        region = self._mirror_region()
        assert "extract_options_with_recommendation(" in region

    def test_it_passes_the_recommendation_into_the_blocks(self):
        region = self._mirror_region()
        call = region[region.index("build_options_blocks(") :]
        assert "recommended=" in call[:400], call[:400]


class TestTheTrailerIsParsedExactlyOnce:
    """The two readers must not drift, which is what a second parse would allow."""

    VECTORS = [
        "body\n<!-- recommended:1 -->\n[OPTIONS: Ship it | Hold]",
        "body\n<!-- recommended:2 -->\n[OPTIONS: Ship it | Hold]",
        "body\n<!-- recommended:1 -->\n[OPTIONS: /deploy | Hold]",
        "body\n<!-- recommended:9 -->\n[OPTIONS: Ship it | Hold]",
        "body\n[OPTIONS: Ship it | Hold]",
        "body with no trailer at all",
        "body\n<!-- recommended:1 -->\n[OPTIONS:  | Hold |  ]",
    ]

    @pytest.mark.parametrize("text", VECTORS)
    def test_the_parse_is_self_consistent(self, text):
        cleaned, choices, recommended = fmt.extract_options_with_recommendation(text)
        assert fmt.extract_options_with_recommendation(text) == (cleaned, choices, recommended)

    def test_the_narrower_call_is_the_one_the_wider_one_delegates_to(self):
        # A two-value `extract_options` exists again -- upstream reads it directly -- so the
        # anti-drift property cannot be "there is nothing narrower to pick". It is that the
        # wider call DERIVES from the narrower one, which is why one trailer search covers
        # both and a seam picking either gets the same span and the same cleaned text.
        assert hasattr(fmt, "extract_options")
        text = "body\n<!-- recommended:2 -->\n[OPTIONS: Ship it | Hold]"
        narrow_cleaned, narrow_choices = fmt.extract_options(text)
        wide_cleaned, wide_choices, recommended = fmt.extract_options_with_recommendation(text)
        assert wide_choices == narrow_choices
        assert recommended == "Hold"
        # The wider call additionally removes the tag, so the two cleaned texts differ by
        # exactly that -- pinned so a future edit cannot leave the tag in the body.
        assert "recommended:2" in narrow_cleaned
        assert "recommended:2" not in wide_cleaned

    def test_the_module_searches_the_trailer_once(self):
        source = (SRC / "slack" / "format.py").read_text(encoding="utf-8")
        assert source.count("_OPTIONS_RE.search") == 1, "the trailer is parsed twice again"
