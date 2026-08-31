"""Every doc that enumerates ``DIRECTIVE_TOOLS`` must agree with the set — twice over.

Every member must be NAMED in one block. A list that omits a name lets real drift through,
and that is the drift this file exists for.

Nothing else reported it: ``Docs Lint`` checks index links only. A wheel-bundled copy
carried the enumeration too until the docs refresh removed that file, so the two repo docs
are what remains to keep in step.

Scoped to the ENUMERATION BLOCK rather than the whole file, because these docs also
discuss the tools in prose -- a whole-file check passes on a doc whose list omits a name
that appears in a nearby paragraph, which is the drift that matters. The block is found by
content, a maximal run of consecutive lines each naming a member, so there are no line
numbers to rot.

Membership is read off ``DIRECTIVE_TOOLS`` rather than re-spelled, so a member added later
is required everywhere without touching this file.
"""

import pathlib

from kiro_crew.session_directive import DIRECTIVE_TOOLS

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


def _enumerating_docs() -> dict[str, pathlib.Path]:
    return {
        "session spec": _REPO_ROOT / "docs" / "system-specs" / "modules" / "session.md",
        "mcp architecture": _REPO_ROOT / "docs" / "architecture" / "mcp.md",
    }


def _enumeration_blocks(text: str) -> list[str]:
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in text.split("\n"):
        if any(name in line for name in DIRECTIVE_TOOLS):
            current.append(line)
            continue
        if current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    return ["\n".join(b) for b in blocks]


class TestDirectiveToolsDocParity:
    def test_the_shipped_prompt_offers_every_directive_tool_to_the_agent(self) -> None:
        # This file ships in the wheel and is what tells the agent a capability
        # exists, so a tool missing from it is unreachable, not just undocumented.
        prompt = _REPO_ROOT / "src" / "kiro_crew" / "config" / "prompt.md"
        assert prompt.is_file(), f"shipped prompt not found at {prompt}"
        text = prompt.read_text(encoding="utf-8")
        absent = sorted(name for name in DIRECTIVE_TOOLS if name not in text)
        assert not absent, (
            f"the shipped prompt never names {absent}, so the agent is not told "
            f"they exist; {len(DIRECTIVE_TOOLS) - len(absent)} siblings are named"
        )

    def test_every_enumerating_doc_names_every_directive_tool_in_one_block(self) -> None:
        shortfall: dict[str, list[str]] = {}
        for label, path in _enumerating_docs().items():
            assert path.is_file(), f"{label} not found at {path}"
            blocks = _enumeration_blocks(path.read_text(encoding="utf-8"))
            assert blocks, f"{label} names no directive tool at all"
            best = min(
                blocks,
                key=lambda b: sum(1 for name in DIRECTIVE_TOOLS if name not in b),
            )
            absent = sorted(name for name in DIRECTIVE_TOOLS if name not in best)
            if absent:
                shortfall[label] = absent
        assert not shortfall, f"no single enumeration block names every directive: {shortfall}"
