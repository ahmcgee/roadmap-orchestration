# Contract: the ledger CLI

`ledger` is run as `node src/cli.js <command> [args...]`.

## Commands

- `format <amount>` prints the amount with two decimals.
- `total <amount>...` prints the sum of the amounts for display, with thousands separators.
- `reconcile <YYYY-MM> <file>` prints `<YYYY-MM> balance <amount>`: the sum of the ledger file's entries dated in
  that month, rendered by `formatAmount`.

Unknown commands exit 2 with a one-line error on stderr naming the command. So does a command given the wrong
number of arguments, an argument that is not an amount, a month that is not `YYYY-MM`, or a file it cannot read or
parse: the message names what was refused, and nothing goes to stdout.

## Amounts

An amount is written as digits with an optional leading minus and optional decimals: `12`, `-3.5`, `0.125`. No
exponent, no `+`, no thousands separators. Sums are exact: amounts are added on their decimal digits.

## Ledger file

One entry per line, `YYYY-MM-DD,<amount>,<memo>`; blank lines are skipped, and `\r\n` line ends are accepted. The
date is a real calendar date, the amount as above, the memo non-empty and without commas. A malformed line is
refused with an error naming its 1-based line number.

## Money

`formatAmount(amount)` in `src/format.js` renders an amount with exactly two decimals; `formatDisplay(amount)`
in `src/display.js` renders one for display, two decimals with thousands separators. Every amount the CLI prints
goes through one of them.
