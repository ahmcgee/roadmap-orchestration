# Architecture

A small bookkeeping CLI.

- `src/cli.js`: the command dispatcher (`.roadmap/contracts/ledger.md`, commands); the only module doing I/O, and
  the one that turns refused input into a one-line message and exit 2.
- `src/<module>.js`: one ES module per concern, pure functions, no dependencies.
- `test/unit/<module>.test.js`: that module's `node --test` tests; `npm test` runs them all.
- `journeys/`: end-to-end tests of the CLI (`*.journey.js`), one per obligation, run by the arc lanes (never by
  `npm test`).

## Money

Amounts are amount texts (`.roadmap/contracts/ledger.md`, amounts) until they are rendered: summed by `sumAmounts`
in `src/format.js`, rendered by formatAmount in `src/format.js` or, for display, by formatDisplay in
`src/display.js`.
