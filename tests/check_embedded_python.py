"""Parse every embedded Python block, and forbid stray backticks.

`node --check` cannot see inside a `String.raw` template, so a Python block can be
syntactically broken JavaScript-wise and still pass every check. The project's
own history records three separate bugs that got through that way: a dropped
`LIMIT 100`, a mis-indented `elif` chain, and a stale `max_tokens`.

Two more arrived in one session:

  - `LIMIT \"\"\" + str(ROW_CAP) + '\"\"\"` asked Python for a JavaScript name:

        File "<string>", line 175, in <module>
        NameError: name 'ROW_CAP' is not defined
        [DB] eligible-jobs load failed
        [DB] queue is empty - nothing eligible to apply to right now

    which is indistinguishable from there being no work.

  - a backtick inside a python comment TERMINATED the String.raw literal:

        SyntaxError: Unexpected identifier 'node'

    so a `#` comment must never contain one.

Run by CI alongside the tests, because this is the class of defect that unit
tests cannot reach.
"""

from pathlib import Path
import ast
import re
import sys

TARGETS = [
    Path(r"E:\Potential-gold\PluseOPS\apps\browser-apply\apply.mjs"),
]

problems = []
checked = 0

for path in TARGETS:
    src = path.read_text(encoding="utf-8")
    blocks = re.findall(r"String\.raw`([^`]*)`\s*;", src, re.S)
    for n, code in enumerate(blocks, 1):
        checked += 1
        if "`" in code:
            problems.append(f"{path.name} block {n}: backtick inside a String.raw block")
        try:
            ast.parse(code)
        except SyntaxError as e:
            line = (code.split("\n")[e.lineno - 1] if e.lineno else "")[:100]
            problems.append(f"{path.name} block {n}: line {e.lineno}: {e.msg}\n    {line}")

if problems:
    for p in problems:
        print(f"FAIL {p}", file=sys.stderr)
    sys.exit(1)

print(f"ok - {checked} embedded python blocks parse, no stray backticks")