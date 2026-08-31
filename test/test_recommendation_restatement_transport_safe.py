"""The recommendation restatement defangs mentions only where the platform parses one.

The restatement joins the message BODY, so it needs the display-form credential pass. It
used to take the channel-neutral ``display_safe``, which inserts a zero-width space after
every ``@`` unconditionally. On Webex that corrupts the payload rather than protecting it:
Webex parses no broadcast mention AND its allow-list IS email addresses, so every address
in a marked label came out uncopyable.

``capabilities`` is a REQUIRED argument rather than an optional one. A default would let a
new transport inherit the corrupting path silently, which is the failure this pins shut.
"""

from __future__ import annotations

import inspect

import pytest

from kiro_crew.discord.transport import DISCORD_CAPABILITIES
from kiro_crew.messaging.renderer import split_options_trailer
from kiro_crew.teams.transport import TEAMS_CAPABILITIES
from kiro_crew.telegram.transport import TELEGRAM_CAPABILITIES
from kiro_crew.webex.transport import WEBEX_CAPABILITIES

ZWSP = "\u200b"
ADDRESS = "ops@example.com"
TRAILER = f"Body here\n\n[OPTIONS: (recommended) Email {ADDRESS} | Skip it]"


class TestWebexKeepsAMarkedAddressCopyable:
    def test_webex_declares_no_mention_grammar(self):
        # Establishes the premise the fix turns on, so the assertions below are not vacuous.
        assert WEBEX_CAPABILITIES.mention_grammars is False

    def test_the_restatement_carries_no_zero_width_space(self):
        body, _ = split_options_trailer(TRAILER, capabilities=WEBEX_CAPABILITIES)
        assert ZWSP not in body, repr(body)

    def test_the_address_survives_verbatim(self):
        body, _ = split_options_trailer(TRAILER, capabilities=WEBEX_CAPABILITIES)
        assert ADDRESS in body, repr(body)


class TestAMentionParsingTransportStillDefangs:
    """The control: suppressing the defang everywhere would be a mass-notify regression."""

    @pytest.mark.parametrize(
        "capabilities",
        [DISCORD_CAPABILITIES, TELEGRAM_CAPABILITIES, TEAMS_CAPABILITIES],
        ids=["discord", "telegram", "teams"],
    )
    def test_the_defang_is_preserved(self, capabilities):
        assert capabilities.mention_grammars is True
        body, _ = split_options_trailer(TRAILER, capabilities=capabilities)
        assert ZWSP in body, repr(body)


class TestTheChoicesAreTransportIndependent:
    def test_the_dispatched_labels_do_not_vary_by_transport(self):
        webex, _ = (
            split_options_trailer(TRAILER, capabilities=WEBEX_CAPABILITIES)[1],
            None,
        )
        discord = split_options_trailer(TRAILER, capabilities=DISCORD_CAPABILITIES)[1]
        assert webex == discord == [f"Email {ADDRESS}", "Skip it"]


class TestCapabilitiesCannotBeOmitted:
    def test_it_is_a_required_keyword(self):
        params = inspect.signature(split_options_trailer).parameters
        assert params["capabilities"].default is inspect.Parameter.empty
        assert params["capabilities"].kind is inspect.Parameter.KEYWORD_ONLY

    def test_calling_without_it_is_a_type_error(self):
        with pytest.raises(TypeError):
            split_options_trailer(TRAILER)
