# ledgerly.conf

The one configuration file, edited by hand, at the project root. The CLI and the server read it at start;
`ledgerly config check` reads it the same way and reports.

## Format

`key = value` lines, `[team.<id>]` sections, `#` comments to the end of a line. Blank lines are ignored. A team id is
lowercase letters, digits and dashes, starting with a letter.

## Keys

| Where | Key | Value | Default |
|---|---|---|---|
| top | `currency` | `EUR`, `USD` or `GBP` | `EUR` |
| `[team.<id>]` | `name` | the display name | the id |
| `[team.<id>]` | `budget` | the monthly limit, a whole amount without a currency sign | required |
| `[team.<id>]` | `alert_at` | the share of the limit at which the team turns amber, above 0 and at most 1 | `0.8` |

The dashboard can override a team's limit; `budget` stays the starting value.

## Mistakes

Every message names the file, the line, the key and the fix:

- A wrong value is an error (`config check` exits 3, other commands refuse to run):
  `ledgerly.conf:9: budget must be a whole amount above zero without a currency sign, for example "budget = 4000", got "4k"`
- A team without a budget, a team defined twice, or an unknown section is an error.
- An unknown key is a warning, never silently dropped: ledgerly ignores the line, says so on stderr with the file, line,
  key and the nearest known key, and carries on (`config check` still exits 0):
  `warning: ledgerly.conf:12: unknown key "alerts_at" in [team.data], ignored; did you mean "alert_at"?`

## Minimal

```
[team.platform]
budget = 4000
```

## Full

```
# Spend is recorded in euros.
currency = EUR

[team.platform]
name = Platform
budget = 4200
alert_at = 0.8

[team.data]
name = Data
budget = 2600
alert_at = 0.75
```
