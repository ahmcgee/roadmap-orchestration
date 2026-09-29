# Backlog

Triaged 2026-09-29 against the 1.0 yardstick: unattended, week-plus convergence on a documented target state.
Rulings that changed behaviour live in SCHEMAS.md, DESIGN-1.0.md and RATIONALE-1.0.md, not here. Items dropped
at triage stay in git history.

## Milestones (DESIGN-1.0.md §10)

### M2

- Flake reruns, host signatures, retryable parks, cross-model cold start for fix rounds. In M1 a red lane is
  red and fix rounds resume the same model. Retryable parks cover every park that has no re-entry today but
  a new unit id: lost build, residue, red candidate, red base, failed salvage, blocked lane, and a Claude build
  killed before the CLI persisted its session (its `--resume` then fails as a process fault and parks; nothing
  in the invocation's files tells that case apart yet).
- DAG scheduling and parallel units (M1 is serial). `arc.ts` already lets a unit-scoped park release later
  units. One arc per host stays the design (owner ruling 2026-09-29).
- `steer <unit>` (DESIGN command table) predates model classes: it should enter a class or a unit-level class
  rebind, never a model.

### M3

- Residue-index compaction at `start`, event-log compaction, `roadmap gc` (also the host dir's
  `supervisor.<token>.*` and `executor.<gen>.*` log files, which accumulate until then).
- Ruling retirement from `constraints.md`, obligation re-derivation at Phase 0, dismissal arc lifetime.
- The holistic layer: obligations, witness protocol, checkpoint authority.
- A read-only Codex judgment profile, kept as an override option (owner, 2026-09-29: vendor standings move).
  Until then Codex judgment triples are `unsupported` and the review digest seat resolves to the Claude low
  judgment seat.
- cgroup containment stays experimental until `contain.cgroup-real` passes on a host with a writable,
  delegated cgroup v2 tree.

### M4

- Debt lifecycle (stable ids, Phase-0 disposition or refuse, the two-arc question). Gate directive overflow
  banking waits on it: today every directive goes to the fix round.
- Issue mode inbound only; outbound projection in 1.1.
- Phase 0 skill text; SKILL.md becomes the full skill.

## Convergence and integrity (unscheduled, wanted)

- **A `respec` gate outcome** (arc-1 item 27b). A gate that finds the spec wrong can only escalate to the
  architect. Wanted: the gate emits spec directives, a fresh plan-check with a handoff proposes a SpecPatch that
  bumps the rev, and the build resumes with the amendment as fix-round input. The biggest remaining reason an
  unattended arc waits on a human.
- **Bind what a judgment read into the approval fingerprint** (item 22). The fingerprint covers cited contracts
  only; a gate that reads an uncited contract from the index does not bind it. Bind reads.json, and hand a later
  round its predecessor's reads.
- **Backend progress watchdog.** Backend calls keep fixed deadlines (judgment 45 min, fresh build 3 h, fix window
  measured). Their JSONL event stream is a progress signal the lane stall watchdog could read, replacing those
  deadlines.
- **Arc-constant documents as a cache boundary** (item 11). Documents in `--system-prompt` read back from cache in a
  fresh session (probe 2026-09-26, Opus 5.5, ~107 KB: write 1,429 / read 44,441). Placement: system prompt = role
  instructions, architecture doc, cited contracts in fixed order, rulings, Direction, byte-identical per (role,
  model); first message = spec, scope, diff, lanes, evidence, prior round; implementer-authored content never in
  the system prompt. Gated on an A/B of one real plan-check under both layouts showing the same verdicts. The one
  item that spends less of the weekly Claude limit directly.

## Do soon (small fixes)

None.

## Watch (act only on the trigger)

- Codex resume collision is matched on `thread already` from arc 1, with no captured sample. Trigger: a sample.
- Adopting a live runner across arcs holds the recovery lock until that runner exits, which can outlast
  `start`'s wait. Trigger: a `start` timeout from it.
- A reopen resets only the redirect bound; revise, red-candidate and stage-retry bounds and routed-up seats carry
  on. Trigger: re-opened units parking on a carried-over count.
- Lane stall threshold (10 min) and backstop (6 h) are unmeasured defaults. Trigger: recorded stalls or long lanes;
  a legitimately silent lane would need a per-lane `stallMin`. If backstop hits prove to be busy-loop product
  bugs, send them to a fix round like a stall.
- Sonnet 5.5 builds at effort `medium` under `claude-only`, unmeasured. Trigger: fix-round counts against Opus;
  `low` is the cheaper step if verification holds. Sonnet has no judgment prompt; write one only if a route wants
  a cheap judge.
- `apply`: the rulings ledger is read live, not kept by hash; `.roadmap/config.json` is read at `start` only, so a
  class rebind needs a restart (and a dry run reads it fresh, so the two can disagree); a build's decisions are
  not appended while a revision of its spec is pending; a suite change is refused while any unit is active past a
  candidate attempt. Trigger: any of these blocking or misleading a real arc.
- Upgrade test variants not yet covered: the previous release crashing mid-op, a backend parked on a usage
  limit across the update, the Claude-only profile, a lane launched by the previous release. Trigger: a record
  change that touches one of them. Also a unit parked by the previous release with a `resume <unit>` queued
  after a rev + 1 edit: the M1 driver stops the arc on the park before the queued resume applies, so
  `apply.upgrade-queued-resume` covers it in process. Trigger: a driver mode that waits on parks.
- An arc 1.0.0-dev.3 started is baselined from its files without the dispatched spec bytes (never kept): a changed
  spec at the recorded rev is taken as `evidence` and one at rev + 1 as a revision, with scope and resources
  unchecked; a log whose last re-pin set a re-opened unit back to its first rev records a spurious pending revision,
  so that unit re-opens once more. Trigger: either seen on a real upgraded arc.

## Scaffolding to delete

- `src/core/upgrade.ts` 1.0.0-dev.1 defaults (launch.json `stallMs`, the lane deadline `laneRecord` derives a
  start from) and the `stallMs === null` branch in `laneRecord`: once no arc started on 1.0.0-dev.1 is in flight.
- The 1.0.0-dev.3 plan-revision scaffolding, once no arc started on 1.0.0-dev.3 is in flight: in
  `src/core/upgrade.ts` `warnPlanFromFile`, `specBytesFromLiveFile`, `repinNamesSpec`, `earlierReleaseBaseline` and
  `unkeptSpecReason`; their callers' branches (the fold's re-pin rule in `src/core/state.ts`, the no-plan-yet branch
  of `settlePlan` in `src/preflight/checks.ts` back to recording the files with no changes, the unkept-spec refusal in
  `src/input/classify.ts`, the live-file fallback of `specBytesOf` in `src/input/inforce.ts`, the file-plan branch of
  `status`); and `JournalView.unitsWithState` if nothing else reads it by then.
- `commandCancelled` in `src/core/upgrade.ts` (a cancelled lane's `process-fault` result.json read as
  `cancelled{reason}`), its call in `runnerFiles().read` and the kept-bytes branch of `writeResult`
  (`src/backends/adapter.ts`): once no arc started on 1.0.0-dev.3 is in flight.
