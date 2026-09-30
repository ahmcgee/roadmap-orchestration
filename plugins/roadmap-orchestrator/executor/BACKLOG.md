# Backlog

Triaged 2026-09-29 against the 1.0 yardstick: unattended, week-plus convergence on a documented target state.
Rulings that changed behaviour live in SCHEMAS.md, DESIGN-1.0.md and RATIONALE-1.0.md, not here. Items dropped
at triage stay in git history.

## Milestones (DESIGN-1.0.md §10)

### M2 (done: plan `/claude-state/plans/m2-dag-resources.md`, rev 2.1; 1.0.0-dev.5, merged at be76132)

- Flake reruns, host signatures, retryable parks, cross-model cold start for fix rounds. In M1 a red lane is
  red and fix rounds resume the same model. Retryable parks cover every park that has no re-entry today but
  a new unit id: lost build, residue, failed salvage, blocked lane, and a Claude build killed before the CLI
  persisted its session (re-run once, uncharged, as a fresh session). Red candidate and red base stay operator
  parks (A7).
- DAG scheduling and parallel units, capacity pools and `@cpu`, aging, `reenter` and `cut` (edit classes of
  `apply`), `resolve-edge`, `run-only`. One arc per host stays the design (owner ruling 2026-09-29).

### Deferred from M2 (the plan's "Deferred" list)

- `merge-in`, `route`, `limits`, and `steer` (with `--class <efficient|frontier|summit>` as a per-unit routing
  layer, A13) and the `repair` origin: taken into M3 (LR-a).
- Preview's own estate slot: specified with preview in M4 (F23).
- A memory capacity class.
- Handing adopted runners to unit tasks.
- Async git (git runs through `spawnSync` and blocks the event loop).
- cgroup CPU enforcement of `@cpu`.
- Token-cost calibration (`CPU_COST` is unmeasured).
- Event-log compaction: deferred again by M3 (LR-e).
- Per-lane `stallMin`.
- Usage-limit hits under parallel burn: measured in arc 2 (owner ruling D4, 2026-09-30).
- Persisted arbiter tickets, if exact post-recovery grant order is ever required (F20).

### M3 (in progress: plan `/claude-state/plans/m3-holistic.md`, rev 2.1; step 0a done in 1.0.0-dev.6)

- Scope (LR-a): DESIGN-1.0.md §10 M3 and the holistic layer (the vision as the root record, OR-V; obligations,
  witness protocol, impact mapping, journey lanes, the held-claims brake, lenses, the checkpoint with bundles,
  divergences and brakes, findings and repair, arc states and completion); `rule`, `reverse`, `steer --class`,
  `route` and `limits` (apply edit classes), `merge-in`, `audit`, `close-admissions`, the `repair` origin.
- Growth controls: residue-index compaction at `start`, `roadmap gc` (sealed arcs only; also the host dir's
  `supervisor.<token>.*` and `executor.<gen>.*` log files, which accumulate until then), ruling retirement from
  `constraints.md`, obligation re-derivation at Phase 0, dismissal arc lifetime.
- Out (LR-a): the Codex judgment profile, cgroup containment, everything M4 owns.
- cgroup containment stays experimental until `contain.cgroup-real` passes on a host with a writable,
  delegated cgroup v2 tree.

### Deferred from M3 (the plan's "Deferred" list)

- Event-log compaction (LR-e). Its trigger is surfaced as `status.host.log{bytes, events, foldMs}`: 50 MB or 2 s.
- A read-only Codex judgment profile, kept as an override option (owner, 2026-09-29: vendor standings move).
  Until then Codex judgment triples are `unsupported` and the review digest seat resolves to the Claude low
  judgment seat.
- `explore` (A11); `--adversarial` (withdrawn, A12: a unit routing layer expresses it); `contractRequests` and
  `owedAfterMerge` (A13: M4).
- More witness reporters, and a capture from a real `go test -json` (`go-test-json` is tested on hand-written
  streams only; no `go` on this host).
- Glob-overlap precision (spec `obligations` against the mapping is prefix-conservative).
- Lens parallelism (lenses run serially, one `@cpu` each).
- Vision playback verification (M4); the in-tree home of the vision for the next arc (M4).
- Code-level enforcement of implementer boundaries beyond the unit policy and containment (H10's stated limit).
  Trigger: an implementer acting outside the sandbox.

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

- **Backend parks do not escalate at 6 h.** A retryable `backend-park` (`capacity`, `outage`) is probed with the
  same backoff as a unit park, but only unit parks and residues raise `park-escalated`. Trigger: an outage that
  outlasts a working day with nobody noticing.
- **The paid M2 fixture's aging criterion is vacuous** (no waiter reaches promotion in its story; the free
  `prio.bypass-promotion` test covers the rule). Trigger: a real arc where a planned unit waits behind more than
  3 merges, or a change to rank.
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
- A `sweep` whose teardown fails leaves the instance cleaning under the sweep with its residue undisposed. That
  residue is not a probe target (only cleanup-failed or retry-held ones are), so the arc stays `blocked` short of
  `complete` until another sweep cleans it, with no escalation item. Trigger: a sweep failing on a real arc; the
  fix would let the prober take a sweep-held residue or have the sweep hand it back as cleanup-failed.

## Scaffolding to delete

- The 1.0.0-dev.5 → M3 defaults in `src/core/upgrade.ts`, once no arc started on 1.0.0-dev.5 is in flight:
  `revisionSourceOf` (a `plan-applied` without `source`, and the field's optionality), `transientRulesOf` and the
  dev.5 transient rules it selects (the five `.roadmap/` entries, no scope check; step A4's branch), `applyInputsOf`
  and the `PlanManifest` arm of `ApplyManifest` (the legacy apply manifest, G15), `rulingsFromLiveFile` (a revision
  without `rulingsSha256`), and `routingProvenanceOf`'s rebuild of a dev.5 revision's routing (H7).
- Interim M3 shims (step 0a), deleted by the step named: the `NOT_YET` rejections of `rule` (A4), `reverse` (A2),
  `steer` and `merge-in` (A3), `audit` and `close-admissions` (B7) in `src/commands/apply.ts`; `gc` failing in
  `src/cli/main.ts` (A5b); the lens and checkpoint rows `unsupported` in `src/prompts/index.ts` (`ARC_ROLE_UNSUPPORTED`,
  B4); the recovery throws for `docs.commit` (A4), `mutant.apply` (B3) and `revision.commit` (A2) in
  `src/recover/recover.ts`; the `docs` (A4), `batch` (B2) and `job` (A4) holder throws in `settleHolder`
  (`src/recover/resource.ts`); the `reproduce` stage throw in `runStage` (`src/pipeline/unit.ts`, B3); the preempted
  lane throw in `src/pipeline/lanes.ts` (A4); the job-usage throw in `meterOf` (`src/meter.ts`, B9);
  `stageResidueHolder`'s throw for a job-owned residue and its callers in `src/park/{probe,schedule}.ts` (A4);
  `unitFfFingerprint`'s throw for a docs or batch `ff` in `src/git/ff.ts` and `src/recover/ff.ts` (A4, B2).

- The 1.0.0-dev.4 → M2 defaults in `src/core/upgrade.ts`, once no arc started on 1.0.0-dev.4 (or a dev.3 arc
  baselined after dispatch) is in flight: `legacyParkRecord` (a park without `park`) and its call in the fold's
  stage-outcome case; `rerouteAsUnpark` and the `rerouted` fact kind (reader, fold case, `Fact` member);
  `isLegacy`, `legacyNext` and `legacySettled`, with the legacy branches of readiness and resources; the
  cause-less-hold release in the fold's `resumed{backend}` (`#releaseBackendHolds(..., legacy)`); and the
  `scheduling` field's absent case (every arc then writes `dag`).
- Interim M2 shims, deleted by the step named: `namedResource` calls in `src/commands/apply.ts`,
  `src/pipeline/unit.ts`, `src/recover/{residue,resource}.ts` and `test/reserve.test.ts` (step 1, once
  reservations take pool instances and `@cpu`); the executor's rejection of `resolve-edge` and `run-only`
  commands (step 5); `outcomeFact` writing no `park` for a retryable row whose stage names no targets (step 7a).

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
