# Backlog after M1

Deferred deliberately during M1 (2026-09-25/26). Each item is either a plan milestone already named in
DESIGN-1.0.md §10 or a follow-up found while building M1. Rulings that changed behaviour are recorded in
SCHEMAS.md and RATIONALE-1.0.md, not here.

## M2 (from the plan)

- Flake reruns, host signatures, retryable parks, cross-model cold start for fix rounds. In M1 a red lane is
  red and fix rounds resume the same model.
- Receipts and needs-user acks are created under their final name and written after; a `status` read between
  create and write sees an empty file. Move them to temp-and-link like command files.
- DAG scheduling and parallel units (M1 is serial). `arc.ts` already lets a unit-scoped park release later
  units.
- A lost build without tree effects that is re-run after a crash gets a fresh deadline rather than the
  inherited one (the live retry path inherits it).

## M3 (from the plan)

- Residue-index compaction at `start`, event-log compaction, `roadmap gc` (also clears the host dir's
  `supervisor.<token>.*` and `executor.<gen>.*` log files).
- Ruling retirement from `constraints.md`, obligation re-derivation at Phase 0, dismissal arc lifetime.
- The holistic layer: obligations, witness protocol, checkpoint authority.
- A read-only Codex judgment profile; until then Codex judgment triples are `unsupported` and the review
  digest seat resolves to the Claude low judgment seat.
- cgroup containment stays experimental until `contain.cgroup-real` passes on a host with a writable,
  delegated cgroup v2 tree.

## M4 (from the plan)

- Debt lifecycle (stable ids, Phase-0 disposition or refuse, the two-arc question).
- Issue mode inbound only; outbound projection in 1.1.
- Phase 0 skill text; SKILL.md becomes the full skill.

## Found while building M1

- Transient check: DESIGN's "ignored patterns" rule is not implemented; salvage never commits ignored files,
  so nothing ignored can reach the candidate today.
- Gate directive overflow banking: every directive goes to the fix round because M1 has no debt ledger.
- Codex resume collision: the message is matched on `thread already` from arc 1; no captured sample exists.
- `launch.graceMs` has a floor of 1000 ms because the backstop fires at deadline plus twice the grace and the
  runner polls every 500 ms; make the relation explicit in one place if the poll interval ever changes.
- `start` prints `ready` once the executor is alive and reconciling; a backend smoke refusal after that shows
  in `status` and exits `refused`. A `--wait` that also covers the smoke would need readiness split in two.
- Adopting a live runner across arcs holds the recovery lock until that runner exits, which can outlast
  `start`'s wait.
- Host directory log files accumulate until `gc` (M3).

## Found fixing interrupted rounds (2026-09-26)

- A `continue` round gets the full window of the round it continues, not the time the interrupted attempt
  had left. A remaining-time deadline would read the interrupted invocation's launch and end times.
- A Claude build killed before the CLI persisted its session (a pause within its first moments) is continued
  with `--resume` of an id the CLI never saved; that call fails as a process fault and parks the unit. Nothing
  in the invocation's files tells the two cases apart today.
- Decisions an interrupted or malformed attempt wrote to its own evidence dir are never appended: its
  evidence stage never runs. CONTINUE_DIRECTIVE asks the session to rewrite decisions.json complete in the
  new dir; the resume after a malformed report relies on the same rule in the build prompt.

## Deferred from arc-1 feedback (2026-09-26)

- Backends (items 5, 19, 22, 24):
  - No arc-private Claude config dir. Claude Code 2.1.283 writes `.credentials.json` by temp file and
    rename, so a symlink to the operator's file would be replaced by a private copy at the first OAuth
    refresh, and the rotated refresh token would leave the operator's own login dead. Calls keep the
    operator's `CLAUDE_CONFIG_DIR`; context is cut by flags and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` instead
    (backends/argv.ts). If an isolated dir is still wanted: a long-lived `claude setup-token` token the
    operator stores for the executor, passed as `CLAUDE_CODE_OAUTH_TOKEN`, never refreshed by the CLI.
  - The logged-in account's email still reaches every Claude session in a user-context block; no flag
    removes it.
  - reads.json is audit only (item 22, second half). The approval fingerprint covers the cited contracts
    only; a gate that reads an uncited contract from the index does not bind it. Binding what a judgment read
    (reads.json) into the fingerprint, and handing a later round its predecessor's reads, is the follow-up.
  - A cancelled command (a lane paused or stopped mid-run) still records verdict `process-fault` in
    result.json; lanes read the reason from cancel.json (`cancelledFor`). Backend calls record
    `cancelled{reason}` and `verdictOf` reads that.
  - Arc 1's all-`usage-unavailable` meter was not reproduced: the reader read the current result shape
    (captured 2026-09-26, 2.1.283, plain `json` and `stream-json` alike) as `known`, as did this host's
    probe runs. The arc's own invocation dirs were not available; the new captures pin the shape, and
    `status.spend` now carries turns and cost, so a recurrence shows at once.
- Lifecycle (reopen, pause, `after`):
  - Parks outside plan-check and gate (lost build, residue, red candidate, red base, failed salvage, blocked
    lane) are not re-openable: `resume <unit>` rejects them and their needs-user names the re-entry under a new
    unit id. Retryable parks are M2.
  - A reopen resets only the redirect bound. The gate's revise bound, the red-candidate bound, per-stage retries
    and routed-up seats carry on, so a unit re-opened after a revise-bound park escalates at its next revise.
    Reset them too if re-opened units keep parking on a carried-over count.
  - The spec-edit rule is enforced only at resume: an in-flight edit to anything but evidence plumbing
    (`evidenceGlobs`, `evidenceExcludes`, which may change at the current rev) goes undetected; later stages read
    the edited file and the gate's fingerprint binds whatever rev is on disk. Enforce it by recording a spec
    content hash that excludes `evidenceGlobs` and `evidenceExcludes`, and checking it at each stage start.
  - A reopen does not re-pin routing: a unit re-opened under a changed routing table meets the pinned
    `routingRev` check at its plan-check like any other dispatched unit.
  - `resume <unit>` of a unit that is both paused and parked clears the pause only; a second `resume` re-opens.
  - `run.state` shows `held` while the next unit waits on `after` for another unit's open needs-user, though
    what it waits on is that item; `units[].status` (`held-after:<ids>`) names the units.
  - Shared-resource owner leases are a documented probe convention (SKILL.md), not executor code.
- Judgment (cites, round handoff, caching):
  - **Arc-constant documents as a cache boundary** (item 11). The executor sends spec, documents and diff as one
    stdin text block, and the API caches only at content-block boundaries, so today only the tools and the
    role's `--system-prompt` prefix are reused across sessions. A probe on 2026-09-26 (Opus 5.5, ~107 KB of
    contracts) showed documents in `--system-prompt` read back from cache in a fresh session (write 1,429 / read
    44,441, $0.025 against $0.371). Placement: system prompt = role instructions, architecture doc (or digest),
    cited contracts in fixed sorted order, rulings, Direction, byte-identical per (role, model); first message =
    spec, scope, diff, lane ledger, evidence dirs, prior round; implementer-authored content never in the system
    prompt. Deferred until an A/B of one real plan-check under both layouts on a unit with known findings shows
    the same verdicts and reasons; the saving is modest (~190k tokens move from cache-write to cache-read per
    hit, hits mostly in redirect and re-gate bursts), and cites already shrink the documents.
  - **A `respec` gate outcome** (item 27b). M1 has no gate→planner path: a gate that finds the spec wrong can only
    escalate. Wanted: the gate emits spec directives, the architect or a fresh plan-check with a handoff proposes
    a SpecPatch that bumps the spec rev, and the build resumes its session with the amendment as fix-round input.
    Until then the architect's reopen of a parked unit after a spec edit covers it by hand.
- Routing (classes, escalation seat):
  - The DESIGN command table's `steer <unit> --model <m>` (M2+) predates model classes: when steer lands it
    should enter a class (or a unit-level class rebind), since routing layers never name a model.
  - One binding per class, and a Codex binding carries its effort: a second Codex effort would be a new class.
    None is needed yet.

## Found fixing the fixture restart (2026-09-26)

- Runner identity is `ROADMAP_INV=<arc>/<seq>#<n>`, scanned machine-wide, and is unique only because the host
  lock allows one run per machine. Two concurrent runs sharing an arc name under different host dirs (as the
  fake fixtures did before they got per-dir arcs) see each other's runners and crash, or would kill them. Key the
  identity on the run dir too (e.g. `ROADMAP_INV_DIR`) if runs ever share a machine outside the host lock;
  touches containment, recovery and reattach lookups.

## Upgrade in place (2026-09-26)

- `test/upgrade.test.ts` covers a stop mid-build and a reopen stopped mid-plan-check. Not yet: the previous
  release crashing mid-op (HEAD recovering its open intents), a backend parked on a usage limit across the
  update, the Claude-only profile. Add a variant when a record change touches one of them. Nor a lane the
  previous release launched being read back by HEAD (neither variant stops mid-lanes); the launch.json
  `stallMs` default is covered by `records.test.ts` and `lanes.dev1-launch` instead.
- `src/core/upgrade.ts` is the read-time defaulting module (first entry: launch.json `stallMs`, and the
  1.0.0-dev.1 lane deadline `laneRecord` derives a lane's start from). Delete it, and the `stallMs === null`
  branch in `laneRecord`, once no arc started on 1.0.0-dev.1 is in flight. Its warning goes to the executor's
  stderr only, once per process per kind; `status` does not surface it yet, since the status process never reads
  invocation files. Surface it (a per-run-dir record the executor writes) if an upgrade default ever matters
  to the operator.

## Lane stall watchdog (2026-09-26)

- The 10-min stall threshold and the 6 h backstop are defaults, unmeasured. Re-derive once arcs have recorded
  stalls and long lanes. A lane whose suite is legitimately silent and idle for over 10 min (waiting on an
  external service with its own long timeout) would need a per-lane `stallMin` in spec.json; add it only when
  one exists.
- Backend calls keep fixed deadlines (judgment 45 min, fresh build 3 h, fix window measured). Their JSONL event
  stream is a progress signal the same watchdog could read, replacing those deadlines too. Take it up if a
  healthy long build or judgment is ever cut short.
- A lane that hits the 6 h backstop is `blocked`, retried once at the lanes stage (another 6 h), parked at
  the candidate. If backstop hits turn out to be busy-loop product bugs, send them to a fix round like a stall.
