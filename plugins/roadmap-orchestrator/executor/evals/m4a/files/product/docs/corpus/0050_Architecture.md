# Architecture

How Tidewater is built. The decisions behind the bigger choices are in `0070_ADRs/`.

## Shape

Tidewater is one Node command, `tidewater` (`src/cli.js`), with no server and no database. It runs on the office
machine and on the kiosk on the quay, which shares the office machine's disk.

```
  skipper / office ──> tidewater (src/cli.js)
                          │
                          ├── tide table      data/tides.json      (read only)
                          ├── berth register  data/berths.json     (read only)
                          ├── vessel register data/vessels.json    (read only)
                          ├── booking ledger  tidewater-ledger.json (read and written)
                          └── outbox          texts for the gateway (written)
```

## Modules

- `src/cli.js` parses the command line, runs the command and turns refusals into a one-line message and exit
  code 2.
- `src/tides.js` reads the tide table and works out the windows.
- `src/registers.js` reads the berth and vessel registers.
- `src/ledger.js` reads and writes the booking ledger.
- `src/errors.js` holds the one error type a refusal uses.

## The booking ledger

All bookings live in one JSON file, the booking ledger. Only the tidewater command writes it; nobody edits it by
hand, not even the office. Each command reads the whole file, makes its change and writes the whole file back.
That is fine at the harbour's size (a few hundred bookings a season) and keeps the file readable.

The ledger's location comes from `TIDEWATER_DATA`; the default is `tidewater-ledger.json` in the current
directory. On the office machine it is set to the shared folder the kiosk also uses.

## Data flowing out

Confirmed bookings leave the system through the PortLink bridge, which relays each one to the regional port
authority's SOAP service every hour. The bridge keeps a queue on disk and retries when the authority's service is
down, which is often on Sunday nights.

Texts to skippers leave through the outbox (see 0040_Notifications.md).

## Errors

Every refusal is a `TidewaterError` with a message written for the skipper. Anything else is a bug and is allowed
to crash with a stack trace, so the office notices and tells us.

## Testing

Unit tests live in `test/unit/` and run with `npm test` (`node --test`). There is no other test setup. Tests
point `TIDEWATER_DATA` at a temporary file so they never touch the real ledger.

## Things we deliberately did not build

- A web server. The kiosk is a terminal; skippers who book from home use the office's remote session.
- A database. The ledger file is enough.
- Accounts and logins. The office machine is in a locked room; the kiosk only runs Tidewater.
