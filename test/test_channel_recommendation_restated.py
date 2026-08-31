"""A channel with no badge must still be told which option the agent recommended.

`split_options_trailer` strips the marker before the label is dispatched, and the four
channels reached through it render no badge. Without a restatement the steer disappears
completely -- worse than before the badge existed, when the marker was at least visible in
the label. This pins the restatement at the one shared seam so it cannot regress per
channel.
"""

from __future__ import annotations

from kiro_crew.discord.transport import DISCORD_CAPABILITIES
from kiro_crew.messaging.renderer import recommended_restatement, split_options_trailer


def _split(*labels: str) -> tuple[str, list[str]]:
    return split_options_trailer(
        "Answer.\n\n[OPTIONS: " + " | ".join(labels) + "]", capabilities=DISCORD_CAPABILITIES
    )


class TestTheStripRestatesTheRecommendation:
    def test_a_marked_option_is_restated_in_the_body(self):
        body, choices = _split("(recommended) Merge it now", "Hold it")
        assert body == "Answer.\n\nRecommended: Merge it now"
        assert choices == ["Merge it now", "Hold it"]

    def test_an_unmarked_list_adds_nothing(self):
        body, choices = _split("Merge it now", "Hold it")
        assert body == "Answer."
        assert choices == ["Merge it now", "Hold it"]

    def test_the_restatement_names_the_cleaned_label(self):
        body, _ = _split("(recommended) Merge it now")
        assert recommended_restatement("Merge it now") in body
        assert "(recommended)" not in body

    def test_first_wins_when_a_producer_marks_several(self):
        body, _ = _split("(recommended) First", "(recommended) Second")
        assert body.endswith("Recommended: First")

    def test_a_guard_declined_label_is_not_restated(self):
        # Nothing was stripped, so the marker is still visible in the label itself and a
        # restatement would duplicate it.
        body, choices = _split("(recommended) /clear")
        assert body == "Answer."
        assert choices == ["(recommended) /clear"]

    def test_the_restatement_carries_no_markup(self):
        # One string ships to platforms with different dialects, or none.
        note = recommended_restatement("Merge it now")
        assert not any(ch in note for ch in "*_`~<>[]")

    def test_a_body_less_turn_still_restates(self):
        body, _ = split_options_trailer(
            "[OPTIONS: (recommended) Merge it now]", capabilities=DISCORD_CAPABILITIES
        )
        assert body == "Recommended: Merge it now"
