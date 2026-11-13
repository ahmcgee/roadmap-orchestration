# Watching a run: web console, TUI and launcher

Three read-only ways to see what an arc is doing. None of them can change a run, and closing any of them leaves
execution running.

| Tool | Where | Start it with |
|---|---|---|
| [Web console](#web-console) | Browser, normally `http://localhost:4747` | Starts with the arc |
| [TUI](#tui) | A second terminal | `roadmap tui --repo <path> --arc <id>` |
| The architect | Your Claude Code conversation | Ask it; it reads `status` and `brief` |

After startup and at completion, the architect shares the console URL and an arc-pinned TUI command.

## Web console

> **No authentication.** The console exposes plans, state, spend, questions and selected logs/results to anyone who
> can reach the port. On an exposed host, [bind it to loopback](#binding-and-ports).

### Views

The landing page follows this repo's live run, or its latest retained run. To pin a browser tab to one arc, use
`#/arcs/<arc>/<view>`.

| View | Shows |
|---|---|
| **Graph** | The milestone line map and full dependency graph. Open a node for the unit's purpose, rounds, agent histories and check output. Milestone nodes show executor gates, including when all member units have passed. |
| **Timeline** | When each agent and command ran, and when a backend was unavailable. |
| **Activity** | Recent journal events, plus audits, findings and root decisions. Successful housekeeping steps stay behind a toggle; failures remain visible. |
| **Effort** | Work finished and time spent waiting, by unit, role or systems. |
| **Resources** | Who holds shared resources now and who held them before; CPU reservations; recorded waiting by reason. |
| **Attention** | Decisions waiting for you, with the exact terminal commands for human responses. |

**Agent histories.** Open an agentic activity from its unit to read the retained brief, thoughts, tool
inputs/results and final report. Active histories grow live and follow the tail until you scroll up. "Show earlier"
and explicit expansion keep long transcripts bounded. Deterministic activities keep their step logs.

**How to read the numbers.**

- Times are relative, with local time on hover. Stopped or completed runs retain their recorded time range.
- Missing measurements are labelled as missing.
- Time charts show partial recorded effort, not wall-time coverage. Overlapping waiting reasons are never summed,
  and mixed-category waiting stays unallocated.
- CPU shows recorded reservations and measured run/wall averages, without invented utilization histories, peaks or
  test-case counts.
- The page retains timestamped content and reports "Disconnected/stale" after five seconds without a verified
  observation.
- The console keeps what it derived from inputs that have not changed, and checks it now and then, when idle,
  against a derivation from nothing. A difference fails that arc's views with `console derivation diverged at
  <path>` and logs it; the arc keeps running, and `roadmap console stop` then `start` derives it afresh.

### Lifecycle

The console is a detached service, controlled independently of the executor and watch:

```
roadmap console start|stop|status --repo <path>
```

- Arc startup ensures the console is running and prints its URL on stderr, without changing JSON stdout.
- Normal stop, completion, parking and supervisor death leave it available.
- An explicit `console stop` persists until another start.

**When the console cannot start,** arc work keeps running. Bind failures, startup or mutex timeouts, conflicts with
a running console and failed termination produce one loud warning naming the cause and the fix
(`.roadmap/config.json` `webConsole.port`, or `roadmap console stop`). A direct `roadmap console start` refuses
these failures instead. Invalid configuration and programming errors still refuse arc startup, and a nonzero
configured port never falls back to another port.

### Binding and ports

Settings live under `webConsole` in the repo's `.roadmap/config.json`. Missing fields take their defaults without
rewriting the file.

| Setting | Default | Notes |
|---|---|---|
| `host` | `0.0.0.0` | Must be an IP literal. The default makes the console reachable from the host through the devcontainer's network interface. |
| `port` | `4747` | `0` binds any free port, useful when several repos share one container. |

- **Loopback only:** `{"webConsole":{"host":"127.0.0.1","port":4747}}`
- **Finding the actual URL:** the lease records the bound port. `roadmap console status` and the start/resume
  console line show it.
- **LAN sharing:** replace the printed loopback address with the host's reachable hostname or IP.
- **Changing the binding:** a zero port reuses the current live console. Other binding changes need
  `console stop` then `start`. Conflicting settings across worktrees are refused.

Service metadata lives under the realpath Git common directory's `roadmap-console/`, shared across worktrees and
outside arc GC. Assets ship with the plugin; there is no runtime package installation or asset download.

## TUI

```
roadmap tui --repo <path> --arc <id>
```

Works for live and retained arcs. It refreshes without runtime writes.

| Key | Does |
|---|---|
| `1`–`4`, `Tab`, arrows | Switch between Dependency map, Activity, Estate and Exceptions |
| `x` / `g` / `a` | Expand Activity / toggle map context / reveal retained history |
| `c` / `m` / `r` / `R` | Show settled map nodes / next milestone / next or previous running item |
| `Enter` / `Space` | Open selected logs or document; expand an Estate collection |
| `/`, `n`, `N`, `Esc` | Search, jump forward/back; clear search then return |
| `r` in details; `b` | Raw/readable record; original repair input when retained |
| `?` | Contextual controls |

- The header separates executor liveness, active workloads and signed-in Claude five-hour/weekly usage (a read-only
  five-minute observation with cached fallback). A stopped executor gets a STOPPED banner.
- Map selection links Activity by recorded unit/milestone/lineage; rows retain the actual unit.
- Estate leads with vision, slice and plan, then naturally ordered document collections and debt.
- Documents and logs use recorded revision/commit identities, so unapplied working-tree edits are excluded.
- Missing evidence stays explicit. Historical future-obligation checks say pre-delivery, and mutation detections
  remain distinct from product failures.
- Informational viewer diagnostics do not become runtime exceptions.

To try the TUI without a real arc, run `node test/fixtures/tui-lineage-demo.ts` from
`plugins/roadmap-orchestrator/executor/`. It prints a launcher for inspecting a replacement lineage.

## The `roadmap` launcher

The `orchestrate` skill installs a managed `/usr/local/bin/roadmap` launcher inside the executor container and
refreshes it on each skill session. It points to the installed plugin and the current Node executable, so no global
npm package or copied executor is required.

To install it by hand:

```
node "<plugin root>/executor/bin/install-roadmap"                      # may need container administrator rights
node "<plugin root>/executor/bin/install-roadmap" --bin-dir <directory>  # any writable directory on PATH
```

Unrelated commands are never overwritten. Keep the plugin installed, and refresh the launcher after plugin updates
or container rebuilds.
