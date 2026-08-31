"""The embedded-skill-token fence must not be narrower than the expander it fences.

``$name`` resolves to a skill body ANYWHERE in a dispatched message, so a leading-sigil test
cannot see ``Run the $deploy skill``. Quick-send refuses such a label on one click, and the
pattern it refuses with has to admit everything the expander would resolve -- a fence narrower
than the thing it fences is the defect, not a conservative choice.
"""

from __future__ import annotations

from kiro_crew.constants import _EMBEDDED_SKILL_TOKEN_RE
from kiro_crew.skills import _DOLLAR_SKILL_PATTERN


class TestTheFenceTracksTheExpander:
    # Every shape here is one the expander's own pattern accepts, including the two that
    # read like counter-examples: a digit-leading token and a path-ish tail.
    ACCEPTED = (
        "$deploy",
        "Run the $deploy skill",
        "trailing token $a",
        "$40",
        "$a/b_c-d",
    )
    # A doubled sigil is not a token on either side -- the expander's lookbehind excludes it.
    REJECTED = ("$$deploy", "mid$word", "plain prose", "$")

    def test_the_fence_accepts_what_the_expander_accepts(self):
        for text in self.ACCEPTED:
            assert _DOLLAR_SKILL_PATTERN.search(text), "expander changed: %r" % text
            assert _EMBEDDED_SKILL_TOKEN_RE.search(text), "fence narrower than expander: %r" % text

    def test_neither_side_matches_a_non_token(self):
        for text in self.REJECTED:
            assert not _DOLLAR_SKILL_PATTERN.search(text), "expander widened: %r" % text
            assert not _EMBEDDED_SKILL_TOKEN_RE.search(text), "fence wider than expander: %r" % text
