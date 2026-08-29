"""The spec and the client code must not disagree about the ordering redundancy.

The spec states the conclusion directly rather than quoting the code comment: a quoted
comment goes stale the moment the comment is reworded, so the two surfaces are pinned by
their shared conclusion instead of by one citing the other's wording.

This lives in pytest rather than vitest because vite refuses to read a file outside the
website root, so a frontend test cannot see the spec markdown at all.
"""

from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SLICE = REPO / "website" / "src" / "store" / "dashboardSlice.ts"
SPEC = REPO / "docs" / "system-specs" / "modules" / "session-control.md"

STALE_QUOTE = '"redundant now the wire stamps a generation"'


def test_code_denies_plain_redundancy():
    assert "NOT simply redundant" in SLICE.read_text(encoding="utf-8")


def test_spec_confines_redundancy_to_the_server_half():
    text = SPEC.read_text(encoding="utf-8")
    assert "Redundancy therefore holds only for the server-versus-server half" in text
    assert "kept deliberately" in text


def test_spec_does_not_quote_the_comment():
    text = SPEC.read_text(encoding="utf-8")
    # Positive control: the spec is the right surface and does discuss the module.
    assert "dashboardSlice.ts" in text
    assert STALE_QUOTE not in text
