# ledgerly CLI

`node bin/ledgerly.js <command> [options]` (installed as `ledgerly`). Run from the project root, where `ledgerly.conf` is.

## Command tree

```
ledgerly
  init     [--data <dir>] [--force]                 create an empty ledger
  import   <file.csv> [--data <dir>] [--dry-run]    add a CSV file's entries, all or nothing
  report   --team <id> [--month <YYYY-MM>] [--json] [--data <dir>]
  config   check [--file <path>]                    check ledgerly.conf
  --help | help, --version
```

Every command takes `--help`. `--data` defaults to `$LEDGERLY_DATA`, else `.ledgerly`. Options are long only, spelt as
above; there are no short forms and no prompts, so every command can run in a script.

## Streams and exit codes

Results go to **stdout**: the table, the JSON, the one-line "Added 12 entries" summary. Everything else goes to
**stderr**: progress lines, warnings and errors. A command may print progress lines to stderr while it works; scripts
reading stdout never see them.

| Code | Meaning |
|---|---|
| 0 | done (warnings may have been printed) |
| 1 | a bug in ledgerly; the message is a stack trace, which should never happen |
| 2 | the command line is wrong (unknown command or option, missing value) |
| 3 | a file or value is wrong (CSV row, ledgerly.conf, unknown team, missing ledger) |

## Usage and mistakes

- `ledgerly` with no arguments prints the usage to stderr and exits 2. The usage starts with examples, then the
  commands, then the options.
- An unknown command is never guessed at or run: ledgerly names it, suggests the nearest command when one is close
  ("Did you mean "report"?") and exits 2.
- An unknown option names the command's real options.

## Error voice

`ledgerly: <what is wrong>; <how to fix it>`, on one line, the key fact last when it is a value:

```
ledgerly: samples/2026-09.csv:4: Amount must be a number above zero, like 120 or 120.50, without a currency sign. Nothing was imported.
ledgerly: no team "plaform" in ledgerly.conf; the teams are {{team-ids}}
ledgerly: no ledger in .ledgerly; create one with: ledgerly init --data .ledgerly
```

## The CSV format

A header line `team,month,vendor,amount,note`, then one entry per line. Fields are trimmed and never contain commas or
quotes; `note` may be empty. A file imports whole or not at all.

## report --json

```json
{ "team": "platform", "month": "2026-09", "currency": "EUR", "total": "3410.00", "limit": "4200.00", "state": "near",
  "entries": [{ "id": "e-0003", "vendor": "Hetzner", "amount": "1200.00", "note": "build runners" }] }
```

`state` is `within`, `near` or `over`. Amounts are decimal strings, as in the API.

## Golden transcripts

```
$ node bin/ledgerly.js init --data .ledgerly
Created an empty ledger in .ledgerly.
Next: ledgerly import <file.csv> --data .ledgerly
$ echo $?
0

$ node bin/ledgerly.js import samples/{{month}}.csv --data .ledgerly
Added <n> entries (<total>) to the ledger in .ledgerly: e-0001 to e-<n>.

$ node bin/ledgerly.js report --team platform --month {{month}} --data .ledgerly --json > platform.json
$ echo $?
0

$ node bin/ledgerly.js report --team plaform --data .ledgerly
ledgerly: no team "plaform" in ledgerly.conf; the teams are {{team-ids}}
$ echo $?
3
```
