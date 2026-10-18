# ledgerly

A spend ledger for platform teams. Record what each team pays its vendors, watch every team's monthly limit, and get a
statement at the end of the month. One small Node program with no dependencies: a web dashboard, a CLI and an HTTP API
over the same ledger.

## Quickstart

You need Node 24. From a fresh checkout this takes about two minutes.

1. Create an empty ledger in `.ledgerly`:

   ```sh
{{qs-init}}
   ```

2. Import the sample month:

   ```sh
   node bin/ledgerly.js import samples/{{month}}.csv --data .ledgerly
   ```

3. See where a team stands:

   ```sh
{{qs-report}}
   ```

4. Start the dashboard, then open http://127.0.0.1:4600:

   ```sh
   LEDGERLY_DATA=.ledgerly LEDGERLY_API_TOKEN=dev node server/main.js
   ```

## What is where

| You want to | Use | Reference |
|---|---|---|
| Record spend, check budgets, read statements | the dashboard (`node server/main.js`) | [design/DESIGN.md](design/DESIGN.md) |
| Import a month or script a report | the CLI (`node bin/ledgerly.js --help`) | [design/cli.md](design/cli.md) |
| Record or list entries from another tool | the API, `/api/v1` | [design/api.md](design/api.md) |
| Add a team or change a budget | `ledgerly.conf` | [design/config.md](design/config.md) |
| Run CI before you push | `node ci/run.js` | [design/ci.md](design/ci.md) |

The server reads three environment variables: `LEDGERLY_PORT` (default 4600), `LEDGERLY_DATA` (default `.ledgerly`) and
`LEDGERLY_API_TOKEN` (the API answers 503 without it). Amounts in this checkout are in {{currency}}.

## Development

```sh
node --test test/*.test.js   # the unit tests
node ci/run.js               # every CI step, in order, as CI runs them
```
