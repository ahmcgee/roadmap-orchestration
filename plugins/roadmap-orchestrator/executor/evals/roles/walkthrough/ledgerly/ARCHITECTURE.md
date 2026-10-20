# Architecture

One module per surface over one shared core:

- `src/`: the core (the ledger file, money, months, entry validation, `ledgerly.conf`) and the CLI's commands;
- `bin/ledgerly.js`: the CLI;
- `server/`: one HTTP server for the dashboard (`web/`, server-rendered HTML) and the API (`server/api.js`);
- `ci/`: the pipeline and its local runner.

The ledger is one JSON file in the data directory, replaced whole on every write. No dependencies; Node 24.
