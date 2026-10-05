"""A structural check for the test suite: no test may be declared inside another.

CI had been red for six runs on a failure that pointed somewhere unrelated:

    not ok 53 - a control's question text is its own prompt, never the whole form
    error: '4 subtests failed'
    # tests 100  # pass 95  # fail 1  # cancelled 4

node 24 passed all 100 locally. The cause was not a version quirk: adding a test
had inserted it INSIDE the previous test, because that test's closing `});` was
not where the insertion anchor assumed.

    L1191  assert.ok(labelSig.length < longLabel.length, ...);
    L1193  test("the location country is answered, ...", () => {   <-- nested

The counts still balanced - 76 `test(` and 76 top-level `});` - so nothing
looked wrong, and `node --check` passes because the syntax is valid. node 24
tolerates a nested registration by reparenting it after the outer test returns.
node 20 does not: the outer test becomes a parent whose subtests failed, and the
tests after it are cancelled.

Counting braces is not enough to detect this. `{0,40}` inside a regex literal, a
`}` inside a template literal, and a `//` inside a string all shift the count, so
a naive scanner reports nonsense in both directions - it claimed this file's
tests were nested up to line 2063.

So the check scans properly: it tracks line and block comments, single and double
quoted strings, template literals (including nested `${}`), and regex literals
(distinguished from division by the previous significant character), and only then
counts braces. It then asserts every `test(` sits at depth 1.

Run by CI as part of the node job, so a nested test fails loudly where it is
written instead of three runs later as a cancelled subtest somewhere else.
"""

from pathlib import Path

import re
import sys

ROOT = Path(r"E:\Potential-gold\PluseOPS")
SUITE = ROOT / "tests" / "browser-apply-guardrails.test.mjs"

# Characters after which a `/` starts a regex rather than a division. Taken from
# the usual tokenisation rule: a regex may follow an operator, an opening bracket
# or a keyword, and may not follow a value.
REGEX_OK_AFTER = set("(,=:[!&|?{};+-*%~^<>") | {"\n"}


def significant_tokens(src: str):
    """Yield (index, char) for code characters only, skipping all literals."""
    i, n = 0, len(src)
    # Stack for template literals so `${ ... }` is scanned as code.
    prev_significant = ""
    while i < n:
        c = src[i]
        two = src[i : i + 2]
        if two == "//":
            i = src.find("\n", i)
            if i == -1:
                return
            continue
        if two == "/*":
            end = src.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        if c in "\"'":
            quote = c
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                i += 1
            prev_significant = quote
            continue
        if c == "`":
            i += 1
            brace_depth = 0
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "$" and src[i + 1 : i + 2] == "{":
                    brace_depth += 1
                    i += 2
                    continue
                if brace_depth and src[i] == "}":
                    brace_depth -= 1
                    i += 1
                    continue
                if src[i] == "`" and not brace_depth:
                    i += 1
                    break
                i += 1
            prev_significant = "`"
            continue
        if c == "/" and (prev_significant in REGEX_OK_AFTER or prev_significant == ""):
            # A regex literal: consume to its closing unescaped /.
            i += 1
            in_class = False
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "[":
                    in_class = True
                elif src[i] == "]":
                    in_class = False
                elif src[i] == "/" and not in_class:
                    i += 1
                    break
                elif src[i] == "\n":
                    break
                i += 1
            while i < n and src[i].isalpha():  # flags
                i += 1
            prev_significant = "/"
            continue
        yield i, c
        if not c.isspace():
            prev_significant = c
        i += 1


def main() -> int:
    failures = []
    for path in sorted(ROOT.glob("tests/*.test.mjs")):
        src = path.read_text(encoding="utf-8")
        depth = 0
        nested = []
        for idx, ch in significant_tokens(src):
            if ch == "{":
                # A `test(` opening at depth != 1 is declared inside another test.
                head = src[max(0, idx - 8) : idx]
                if re.search(r"\btest\($", head) and depth != 1:
                    nested.append(src[:idx].count("\n") + 1)
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
        if depth != 0:
            failures.append(f"{path.name}: unbalanced braces, final depth {depth}")
        for line in nested:
            failures.append(
                f"{path.name}:{line}: test() is declared inside another test - "
                "node 24 reparents it, node 20 fails it and cancels what follows"
            )

    if failures:
        for f in failures:
            print(f"FAIL {f}", file=sys.stderr)
        return 1
    print(f"ok - {len(list(ROOT.glob('tests/*.test.mjs')))} suites, no test nested in a test")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())