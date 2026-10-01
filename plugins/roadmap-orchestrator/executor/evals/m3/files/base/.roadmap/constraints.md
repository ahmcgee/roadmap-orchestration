# Constraints (C-nn ledger)

C-1 — Every module under src/ is a dependency-free ES module; only src/cli.js does I/O.
C-2 — Every exported function is covered by node --test tests under test/unit/, one test file per module.
C-3 — Amounts are rendered only through formatAmount (src/format.js) or formatDisplay (src/display.js).
C-4 — Input the ledger cannot read exactly is refused with a one-line message naming it, never guessed at.
