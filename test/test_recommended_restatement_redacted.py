"""The recommended restatement must not carry an unredacted credential into the body.

The choices LISTING is redacted on its way to a transport, so a key split by markup was
already caught there. The restatement line was not: it was built from the marked label
verbatim and appended to the BODY, which is past the byte-level stream redactor and only
sees table conversion afterwards. A transport whose markdown collapses the emphasis then
renders the whole key -- so one message redacted the listing and leaked the same label a
few lines above it.
"""

from __future__ import annotations

from kiro_crew.discord.transport import DISCORD_CAPABILITIES
from kiro_crew.messaging.renderer import split_options_trailer

# Emphasis SPLITS this key, so a byte-level scan for the contiguous form cannot see it
# while a markdown renderer that collapses the emphasis shows it whole.
SPLIT_KEY = "AKIA**IOSF**ODNN7EXAMPLE"
CONTIGUOUS = "AKIAIOSFODNN7EXAMPLE"


class TestTheRestatementIsRedacted:
    def test_the_split_key_does_not_reach_the_body(self):
        body, _choices = split_options_trailer(
            f"Do it.\n\n[OPTIONS: (recommended) run {SPLIT_KEY} | cancel]",
            capabilities=DISCORD_CAPABILITIES,
        )
        assert "Recommended:" in body, body
        assert SPLIT_KEY not in body, body
        assert CONTIGUOUS not in body, body

    def test_a_contiguous_key_does_not_reach_the_body_either(self):
        body, _choices = split_options_trailer(
            f"Do it.\n\n[OPTIONS: (recommended) run {CONTIGUOUS} | cancel]",
            capabilities=DISCORD_CAPABILITIES,
        )
        assert CONTIGUOUS not in body, body

    def test_an_innocuous_label_is_restated_unchanged(self):
        # Guards over-redaction: the fix must not mangle an ordinary label.
        body, choices = split_options_trailer(
            "Do it.\n\n[OPTIONS: (recommended) Merge it | Hold]", capabilities=DISCORD_CAPABILITIES
        )
        assert "Recommended: Merge it" in body, body
        assert choices == ["Merge it", "Hold"]

    def test_the_choices_themselves_are_untouched_by_the_redaction(self):
        # The dispatched value must stay verbatim -- redaction is for the restatement only.
        _body, choices = split_options_trailer(
            f"Do it.\n\n[OPTIONS: (recommended) run {SPLIT_KEY} | cancel]",
            capabilities=DISCORD_CAPABILITIES,
        )
        assert choices == [f"run {SPLIT_KEY}", "cancel"]
