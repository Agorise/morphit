#!/usr/bin/env python3
"""
Morphit — renumber the brag list body so entries are sequential
1..N in the order they actually appear in the file.

Run:  python3 scripts/renumber-brag-list.py

When to use:  If `brag-list-trailer-invariants-smoke` fails on
invariant I-5 (entries out of sequential order), run this
script.  It rewrites MORPHIT-BRAG-LIST.md in place with
sequential numbering, updates the trailer count, and writes a
.pre-renumber.bak alongside the original.

What it leaves alone:
  - The table-of-contents block at the top (1..18 are section
    numbers, not entry numbers)
  - The `## N. Title` section headings
  - Everything else (quotes, code blocks, prose)

The renumber is purely cosmetic — it does NOT touch any cross-
reference to entry numbers because Morphit's brag list
deliberately has no internal "see entry #N" cross-references.
If that policy ever changes, this script will need to be made
aware of them.
"""

from __future__ import annotations
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "MORPHIT-BRAG-LIST.md"


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found", file=sys.stderr)
        return 2

    lines = SRC.read_text().splitlines(keepends=True)

    # Find the first `## 1.` heading — body starts there.
    body_start: int | None = None
    for i, line in enumerate(lines):
        if re.match(r"^## 1\. ", line):
            body_start = i
            break
    if body_start is None:
        print("ERROR: Could not find the `## 1. ` heading", file=sys.stderr)
        return 2

    counter = 0
    out = lines[:]
    for i in range(body_start, len(out)):
        m = re.match(r"^(\d+)\.\s\*\*", out[i])
        if m:
            counter += 1
            old_prefix = f"{m.group(1)}."
            new_prefix = f"{counter}."
            if old_prefix != new_prefix:
                out[i] = out[i].replace(old_prefix, new_prefix, 1)

    # Trailer: "*N specific selling points..."
    trailer_pat = re.compile(r"^\*\d+ specific selling points")
    for i, line in enumerate(out):
        if trailer_pat.match(line):
            out[i] = re.sub(r"^\*\d+", f"*{counter}", line, count=1)
            break

    bak = SRC.with_suffix(SRC.suffix + ".pre-renumber.bak")
    shutil.copy(SRC, bak)
    SRC.write_text("".join(out))
    print(f"Renumbered {counter} entries 1..{counter}")
    print(f"Backup: {bak}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
