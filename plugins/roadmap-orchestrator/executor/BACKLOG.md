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

### M3 (implemented, in PR: plan `/claude-state/plans/m3-holistic.md`, rev 2.1; 1.0.0-dev.6)

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

- Event-log compaction (LR-e). Trigger: `status.host.log.compactionDue` (50 MB or a 2 s fold).
- A read-only Codex judgment profile, kept as an override option (owner, 2026-09-29: vendor standings move).
  Until then Codex judgment triples are `unsupported` and the review digest seat resolves to the Claude low
  judgment seat. Trigger: the weekly Claude limit binding on judgments, or a Codex model the owner wants judging.
- `explore` (A11). Trigger: arc 2's finding metrics showing a defect class the four lenses miss.
  `--adversarial` is withdrawn (A12: a unit routing layer expresses it); `contractRequests` and `owedAfterMerge`
  go to M4 (A13).
- More witness reporters, and a capture from a real `go test -json` (`go-test-json` is tested on hand-written
  streams only; no `go` on this host). Trigger: a target repo whose tests are neither `node --test` nor a jsonl
  wrapper, or a host with `go`.
- Glob-overlap precision (spec `obligations` against the mapping is prefix-conservative). Trigger: an apply
  refused for an obligation whose pattern cannot in fact overlap the unit's scope.
- Lens parallelism (lenses run serially, one `@cpu` each). Trigger: audit wall time delaying completion or
  raising `audit-owed`.
- Vision playback verification and the vision's in-tree home for the next arc: M4.
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
- `apply`: `.roadmap/config.json` is read at `start` only, so a
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
- `gc` then compaction: residue-index pairs keyed to an arc whose run dir `gc` removed are kept by every later
  compaction (an unreadable arc retains its pairs). `gc` could compact first (threshold 1) while it holds the claim.
  Trigger: the residue index growing with gc'd arcs' pairs.
- `gc` keeps the generation files that open needs-user items of `--repo`'s arcs cite, not those another repo's arcs
  on the same host cite. Archive retention is "the first K on the chain", no finer rule. Trigger: `gc` on a host
  that has served arcs of more than one repo.
- The node-test witness reporter reaches the lane through `NODE_OPTIONS` by its absolute path, space-joined
  (src/holistic/witness.ts `witnessEnv`): a plugin install path containing whitespace breaks every node-test lane.
  Trigger: such an install path (the fix quotes the path).
- `status.convergence` shows K, the counter and the open brake items, not the per-identity counts: those need each
  applied bundle's ops, which `appliedBundles` (src/holistic/checkpoint.ts) reads through a `CheckpointContext`.
  A `{journal, runDir}` reader would let `status` show them. Trigger: a `convergence-identity` the owner could not
  see coming.
- The queue and receipts (`commands/`) are not in the snapshot closure: once `gc` removes a run dir, its ref shows
  the revisions commands made, not the commands, their receipts or rejections. Trigger: needing a rejected
  command's reasons after `gc`.
- `stop` waits for a running docs publication's lanes (a revision's or the close-out's run to their end). Trigger:
  a stop held long by a publication's lane series.
- A job's no-verdict episode, and so its 6 h `park-escalated` clock, is held in memory: every executor restart starts
  a new episode. Trigger: a job lane without a verdict across restarts that nobody saw.
- The paid M3 fixture leaves untaken (its `NOT EXERCISED` list, evals/m3/check.ts `BRANCHES`): `rule`, `reverse`,
  `steer`, `merge-in`, mutant reproduction, batch repair, the per-identity bound, `owner-request`, `draining`, a real
  `go` lane and the literal partial bundle. Each has a fake integrated test in `npm test`. Trigger: the first real
  arc to take one; read its log against the fake test.

## Scaffolding to delete

- `completeArc`'s branch for an arc with no `plan-applied` (started before 1.0.0-dev.3: it completes without
  `arc-completed`, src/schedule/scheduler.ts), with the 1.0.0-dev.3 plan-revision scaffolding below.
- The 1.0.0-dev.5 → M3 defaults in `src/core/upgrade.ts`, each with its callers' branch and the optional field it
  reads, once no arc started on 1.0.0-dev.5 is in flight:
  - `revisionSourceOf`: a `plan-applied` without `source`.
  - `transientRulesOf` and the `dev5` rules it selects in src/git/transient.ts (`ROADMAP_ALLOWLIST`, no scope check).
  - `applyInputsOf` and the `PlanManifest` arm of `ApplyManifest` (the legacy apply manifest, G15).
  - `rulingsFromLiveFile`: a revision without `rulingsSha256` reads the live ledger (src/pipeline/stages.ts,
    src/input/inforce.ts).
  - `routingProvenanceOf`'s rebuild of a dev.5 revision's routing (H7).
  - `judgmentFingerprintDefault`: a gate's `judgment-inputs` without `fingerprint` (src/pipeline/gate.ts).
  - `planCheckVisionConflict`: a plan-check answer without `visionConflict`.
- The 1.0.0-dev.5 → M3 reads outside `src/core/upgrade.ts`, with them: the routing-provenance adoption
  (`adoptLegacyProvenance`, `readLegacyProvenance`, `routing-provenance/<rev>.json` in src/git/snapshot.ts; its
  run in `runChecks`; `adoptedProvenance` in src/executor.ts; status's read of it); `sched.json`'s absent `jobQueue`
  read as empty (`schedFile`, src/schedule/scheduler.ts); `rule`'s ledger preimage for a dev.5 previous revision
  (`keepLegacyPreimage`, `legacyPreimage`, `commands/rule-preimages/`, src/commands/rule.ts). A dev.5 snapshot
  manifest (no `namedBy`, verified by allowlist: `legacyAllowlisted`, `warnLegacy`) is read while a ref it
  wrote may still be verified (`gc`, recovery): delete once no `refs/roadmap/<arc>` last written by 1.0.0-dev.5 is left.

- The 1.0.0-dev.4 → M2 defaults in `src/core/upgrade.ts`, once no arc started on 1.0.0-dev.4 (or a dev.3 arc
  baselined after dispatch) is in flight: `legacyParkRecord` (a park without `park`) and its call in the fold's
  stage-outcome case; `rerouteAsUnpark` and the `rerouted` fact kind (reader, fold case, `Fact` member);
  `judgmentInputsDefault` (a judgment attempt without `judgment-inputs`, src/pipeline/gate.ts);
  `isLegacy`, `legacyNext` and `legacySettled`, with the legacy branches of readiness and resources; the
  cause-less-hold release in the fold's `resumed{backend}` (`#releaseBackendHolds(..., legacy)`); and the
  `scheduling` field's absent case (every arc then writes `dag`).
- Interim M2 shim: `outcomeFact` writing no `park` for a retryable row whose stage names no targets (step 7a,
  src/pipeline/transitions.ts).

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
