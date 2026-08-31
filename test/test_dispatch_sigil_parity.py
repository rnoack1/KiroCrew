"""The dispatch vocabulary exists on both surfaces and must not diverge.

The backend decides what a dispatched message MEANS; the frontend refuses to quick-send a
label that would become one. A sigil added to one side and not the other reopens the
one-click dispatch the refusal exists to prevent, silently.

This is no longer about a marker. The recommendation is carried out of band, so no label is
rewritten and nothing can be promoted by removing a prefix -- the suites that pinned that
strip against provenance openers, plan actions and stop words are gone with it. What is left
is the vocabulary of forms that RUN, which quick-send needs on its own account.
"""

from __future__ import annotations

import re
from pathlib import Path

from kiro_crew.constants import (
    _RECOMMENDED_TAG_RE,
    _RESERVED_DISPATCH_SIGILS,
    extract_recommended_index,
)

_ROOT = Path(__file__).resolve().parents[1]
_FRONTEND = _ROOT / "website" / "src" / "app-sdk" / "protocol" / "recommendation.ts"
_DECL_RE = re.compile(
    r"const RESERVED_DISPATCH_SIGILS = \[(?P<body>[^\]]*)\] as const",
)


def _frontend_sigils() -> tuple[str, ...]:
    source = _FRONTEND.read_text(encoding="utf-8")
    match = _DECL_RE.search(source)
    assert match, "frontend sigil list not found -- was it renamed or reshaped?"
    return tuple(re.findall(r"'((?:[^'\\]|\\.)*)'", match.group("body")))


class TestDispatchSigilListsAgree:
    def test_the_frontend_declares_a_list_this_test_can_read(self):
        # Guards the guard: a silently unreadable list would make every comparison vacuous.
        assert _frontend_sigils(), "extracted an EMPTY frontend list"

    def test_neither_surface_carries_a_sigil_the_other_lacks(self):
        assert _frontend_sigils() == tuple(_RESERVED_DISPATCH_SIGILS)

    def test_the_backend_list_is_not_empty(self):
        assert _RESERVED_DISPATCH_SIGILS


class TestTheActionProtocolIsPinnedToItsRouter:
    """``action::`` opens a Slack action route, so quick-send must never dispatch one.

    A single-character sigil tuple cannot express it, so the frontend spells it as a literal.
    It is held to the ROUTER's own prefix rather than to a backend copy: the router is the
    ground truth, and a second copy would only be one more thing to keep in step.
    """

    def test_the_frontend_guard_tests_the_action_prefix(self):
        source = _FRONTEND.read_text(encoding="utf-8")
        assert "dispatched.startsWith('action::')" in source

    def test_the_literal_is_the_routers_own_prefix(self):
        from kiro_crew.slack.interactions import _ACTION_PREFIX

        assert _ACTION_PREFIX == "action::"


class TestTheRecommendedTagGrammarAgrees:
    """Both surfaces read the SAME out-of-band tag, so a shape one accepts the other must.

    This is the parity that replaced the marker-grammar vector table. It is a far smaller
    obligation: one tag shape, and an index whose only validation is a bounds check --
    where the in-band form needed every dispatch form the product recognises mirrored here.
    """

    SAMPLES = (
        ("body\n<!-- recommended:2 -->", 2),
        ("body\n<!-- RECOMMENDED:1 -->", 1),
        ("body\n<!--   recommended:  3   -->", 3),
        ("body\n<!-- recommended:notanumber -->", None),
        ("body with no tag at all", None),
    )

    def test_the_backend_reads_each_sample(self):
        for text, expected in self.SAMPLES:
            _, index = extract_recommended_index(text)
            assert index == expected, text

    def test_the_frontend_declares_a_tag_pattern_this_test_can_find(self):
        source = _FRONTEND.read_text(encoding="utf-8")
        assert "const RECOMMENDED_TAG_RE" in source
        assert "readRecommendedIndex" in source

    def test_both_patterns_admit_the_same_bounds(self):
        # The index is capped at three digits and the whitespace runs at 16 on both sides;
        # a bound widened on one surface alone is a shape one reads and the other shows raw.
        frontend = _FRONTEND.read_text(encoding="utf-8")
        assert r"(\d{1,3})" in frontend
        assert r"(\d{1,3})" in _RECOMMENDED_TAG_RE.pattern
        assert frontend.count("{0,16}") >= 3
        assert _RECOMMENDED_TAG_RE.pattern.count("{0,16}") >= 3

    def test_the_tag_is_removed_from_the_text_it_was_read_from(self):
        # It must not survive into a plain-text projection: Slack mrkdwn shows an HTML
        # comment literally.
        cleaned, index = extract_recommended_index("body\n<!-- recommended:2 -->")
        assert index == 2
        assert "recommended:2" not in cleaned
        assert cleaned.startswith("body")
