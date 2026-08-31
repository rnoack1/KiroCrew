"""The producer rule must not promise a split the guard does not perform.

The rule told every dashboard session that the marker "never becomes part of the user's
message". That is true for an ordinary label and FALSE for one the transport matches
verbatim: ``strip_recommended_marker`` returns those UNCHANGED, so a marked ``/clear``
keeps its marker and dispatches as prose. A producer following the old text had no way to
know which labels to leave bare, so the rule now names each preserved class instead.
"""

from __future__ import annotations

import pytest

from kiro_crew.constants import (
    _RESERVED_DISPATCH_SIGILS,
    _RESERVED_PLAN_ACTIONS,
    _RESERVED_TEXT_COMMANDS,
    strip_recommended_marker,
)
from kiro_crew.context import _OPTIONS_RECOMMENDED_RULE

MARKED = "(recommended) "


class TestTheGuardReallyPreservesTheseLabels:
    """Establishes the behaviour the rule has to describe, before asserting it describes it."""

    def test_an_ordinary_label_is_split(self):
        assert strip_recommended_marker(MARKED + "Merge it now") == "Merge it now"

    def test_a_sigil_label_is_returned_unchanged(self):
        for sigil in _RESERVED_DISPATCH_SIGILS:
            marked = f"{MARKED}{sigil}clear"
            assert strip_recommended_marker(marked) == marked, sigil

    def test_a_provenance_opener_is_returned_unchanged(self):
        marked = MARKED + "[SYSTEM] do the thing"
        assert strip_recommended_marker(marked) == marked

    def test_a_sigil_less_channel_command_is_returned_unchanged(self):
        for command in _RESERVED_TEXT_COMMANDS:
            marked = MARKED + command
            assert strip_recommended_marker(marked) == marked, command

    def test_a_plan_action_is_returned_unchanged(self):
        for action in _RESERVED_PLAN_ACTIONS:
            marked = MARKED + action
            assert strip_recommended_marker(marked) == marked, action


class TestTheRuleDescribesThatBehaviour:
    def test_it_does_not_promise_an_unconditional_split(self):
        assert "never becomes part of" not in _OPTIONS_RECOMMENDED_RULE

    def test_it_says_the_split_is_skipped_for_verbatim_labels(self):
        assert "SKIPPED" in _OPTIONS_RECOMMENDED_RULE
        assert "verbatim" in _OPTIONS_RECOMMENDED_RULE

    def test_it_names_every_preserved_class(self):
        for token in ("`/`", "`@`", "`[SYSTEM]`", "sigil-less channel", "plan action"):
            assert token in _OPTIONS_RECOMMENDED_RULE, token

    def test_it_states_the_consequence_of_marking_one(self):
        assert "would stay in the message" in _OPTIONS_RECOMMENDED_RULE

    def test_the_rule_forbids_translating_the_marker(self):
        assert "never a translation" in _OPTIONS_RECOMMENDED_RULE

    @pytest.mark.parametrize("marker", ["(recommandé)", "(推奨)", "(recomendado)"])
    def test_a_translated_marker_is_not_recognised_so_the_rule_must_forbid_it(self, marker):
        """Establishes the harm the clause above exists to prevent.

        A translated marker is not stripped, so it survives into the dispatched text --
        which is the promotion this whole grammar exists to stop.
        """
        label = f"{marker} Merge it now"
        assert strip_recommended_marker(label) == label
