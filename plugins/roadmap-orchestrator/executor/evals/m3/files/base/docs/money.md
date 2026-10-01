# Money

## Rounding

The `format` command rounds an amount to the cent on its decimal digits, half to even, the same for negative
amounts: `format 0.125` prints 0.12, `format 2.675` prints 2.68, `format -0.125` prints -0.12.
