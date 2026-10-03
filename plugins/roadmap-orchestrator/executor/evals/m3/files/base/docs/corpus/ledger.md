# The ledger CLI: target state

The claims the arc converges toward. Rationale is prose; the claims live in the `rules` block.

## Ledger

```rules
T-1: `node src/cli.js reconcile <YYYY-MM> <file>` prints the month's balance of the ledger file in one command.
T-2: `format <amount>` prints the amount rounded to the cent on its decimal digits, half to even.
T-3: Unknown commands exit 2.
```
