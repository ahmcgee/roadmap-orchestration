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
- Preview's own estate slot: specified with preview, deferred to 1.1 (F23, OR-Q15).
- A memory capacity class.
- Handing adopted runners to unit tasks.
- Async git (git runs through `spawnSync` and blocks the event loop).
- cgroup CPU enforcement of `@cpu`.
- Token-cost calibration (`CPU_COST` is unmeasured).
- Event-log compaction: deferred again by M3 (LR-e).
- Per-lane `stallMin`.
- Usage-limit hits under parallel burn: measured in arc 2 (owner ruling D4, 2026-09-30).
- Persisted arbiter tickets, if exact post-recovery grant order is ever required (F20).

### M3 (done: plan `/claude-state/plans/m3-holistic.md`, rev 2.1; 1.0.0-dev.6, merged at 0a58349)

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
  are withdrawn in M4a (OR-V+: corpus amendments, rulings or debt carry them).
- More witness reporters, and a capture from a real `go test -json` (`go-test-json` is tested on hand-written
  streams only; no `go` on this host). Trigger: a target repo whose tests are neither `node --test` nor a jsonl
  wrapper, or a host with `go`.
- Glob-overlap precision (spec `obligations` against the mapping is prefix-conservative). Trigger: an apply
  refused for an obligation whose pattern cannot in fact overlap the unit's scope.
- Lens parallelism (lenses run serially, one `@cpu` each). Trigger: audit wall time delaying completion or
  raising `audit-owed`.
- Code-level enforcement of implementer boundaries beyond the unit policy and containment (H10's stated limit).
  Trigger: an implementer acting outside the sandbox.

### M4a (in progress: plan `/claude-state/plans/m4a-convergence.md`, rev 2.1; 1.0.0-dev.7, branch `feat/m4a-convergence`)

- Scope (LR-a): the pinned corpus as the target (guide, sources, `T-n` rules, pin, census), the vision's in-tree home
  and playback verification, `roadmap phase0 check`, the debt lifecycle, the forge (issue policy, intake, push, stacked
  PRs), `roadmap brief`, chaining with K, the routing rebinding (frontier Opus medium, summit Opus xhigh), the pack
  review, prompt notes, the full skill, and the deletion of every pre-dev.6 scaffolding layer (OR-L4, step X0).
- Records frozen in step 0a (SCHEMAS.md "M4a"); step 0a placed placeholder modules at every final command path, each
  replaced by its landing step (C4 the last, deleting `src/core/notyet.ts`).
- Directive overflow is not banked (R7): every directive still goes to the fix round.
- Revision 3.1 (the run-10 batch, steps N0–N9, 2026-10-06): records frozen in step N0 (SCHEMAS.md "M4a rev 3"); N0
  placed placeholders at every new module path behind `src/core/notyet.ts` again; N2, N3 and N6 replaced them, and N6
  deleted `notyet.ts`.

### M4b (after M4a)

- The flow loop, SPC, the flow role, givens, proposals and verdicts, the ruler fence (judgment-seat effort is part of
  the ruler, OR-Q17), test-set-preserving lane edits, the two plants. Seeded from M4a arcs' refs (LR-c).
- First observation for the loop (M4a development, 2026-10-03): host contention is the ladder's constraint. The
  concurrent crash matrix takes ~21 min alone and was cancelled by its 45-min parent timeout when worktree agents and
  the probe shared the host (load ~46); per-cell 30 s and 180 s timeouts in `resource-recover` and `res.lock-order`
  tripped the same way. Candidate levers: serialize heavy files against agent work, or shard the matrix.

### Deferred from M4a

- Preview (the root agent starts the app from integration on request): 1.1 (OR-Q15).
- Flow series: not recorded (LR-c); M4b derives any series from `events.jsonl` in M4a arcs' refs.
- Issue mode outbound projection: 1.1.
- The Codex judgment profile and cgroup containment stay out (LR-a).

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

- **A lens that answers invalid abandons its audit, retried only after `wallClockMin`** (run 10 round 2, R-16 review):
  `runAudit` asks the remaining lenses, ends `abandoned`, and the cadence's `retry` waits the period (default 360 min),
  a final audit included, then asks every owed lens again, those that reported on the same (head, vision, obligations)
  included. Not seen in run 10 (every audit completed). Trigger: an `abandoned` audit in a paid run; then retry the
  invalid lens once with its reasons inside the audit, and drop from a retry the lenses whose key is unchanged.
- **The checkpoint capture wait bound** (`CAPTURE_WAIT_MAX_MIN`, 15 min, R-15) is a guess from run 10's gate-to-ff of
  about 1 min. Trigger: a paid run where a checkpoint waited the full bound, or captured stale with the bound spent.

- **gpt-5.6-sol is not available on a ChatGPT Codex account** (400 `invalid_request_error`, 2026-10-06). No class binds
  it; a repo rebind to sol would fail at the preflight smoke. Trigger: a routing that seats sol, or the account
  changing; then probe sol again or drop it from `CODEX_MODELS`.
- **`log.test` "10x the lines costs under 15x the CPU"** fails under heavy host load (seen once in a full run with
  agents active; passes alone). Trigger: a failure on a calm host.

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
  class rebind or (M4a) a new chain K needs a restart, acceptable between arcs (and a dry run reads it fresh, so the two can disagree); a build's decisions are
  not appended while a revision of its spec is pending; a suite change is refused while any unit is active past a
  candidate attempt. Trigger: any of these blocking or misleading a real arc.
- Upgrade test variants not yet covered: a backend parked on a usage limit across the update, the Claude-only
  profile, a lane launched by the previous release, a unit parked by the previous release with a `resume <unit>`
  queued after a rev + 1 edit (the M1 driver stops the arc on the park before the queued resume applies). Trigger: a
  record change that touches one of them, or a driver mode that waits on parks.
- Rule ids can run out of order inside a rules block (ids are global; topical order is allowed), M4a paid run 6.
  Cosmetic. Trigger: a real corpus session shows it hurting readability.
- Code shipped by checkpoint-admitted repair units sits outside `deliveredBy` accounting (M4a paid run 6). Trigger:
  a real corpus session shows a repair unit delivering a rule no obligation credits.
- A witness can pass whichever side of the distinction its obligation draws (M4a paid run 6: one obligation's
  witness could not fail on it); proof judgment did not catch it. Trigger: a real corpus session shows it.
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

- **Partial revalidation of a stale-spec bundle** (F09): revalidate only the ops a patch delta touches. Trigger: stale
  rejections > 2 per paid run.
- **External-state identity for estate-lane reuse across SHAs** (Q13 remainder: toolchain versions, image digests,
  service state). Trigger: estate lane time > 20% of a real arc's wall clock.
- **Shared execution for non-identical but equivalent suite and witness lanes** (F13 remainder). Trigger: duplicate
  execution > 10% of candidate lane time in a paid run.
- **Debt and finding provenance** (F23): branch, head and time; historical vs current; effective vs declared
  activation. Trigger: a real-arc drift finding on generated records.
- **Stable defect lineage across audits and lenses** beyond equal causes (F24 remainder; within one audit, equal causes
  merge). Trigger: the run-10 analysis shows ≥3 same-defect findings across audits.
- **Deterministic safety fixtures for the plan-check shape** (understated risk, infeasible specs) beyond unit tests
  (Q27 remainder). Trigger: `by-builder` reverted after run 10, or a missed-risk term fires.

## Scaffolding to delete

- Holistic `architecture-doc` arcs (adopted dev.6 arcs only; a fresh one is refused, D0). With them go the
  `architecture-doc` arm of the holistic code paths and the M3 fixtures that put such a plan in force as revision 1
  by `recordPlan` (adopted-arc coverage, lead ruling LR-D0b): `brake-common` (`holisticArc`), `audit-common`,
  `checkpoint-common`, `repair-common`, `batch-common` and their tests (audit, baseline, batch, brake, checkpoint,
  repair, scheduler-m3, publish, gate, revision, snapshot, status-m3, startup-checks). Migrate those tests to corpus
  arcs (`test/fixtures/corpus-target.ts`) when deleting, once no dev.6 arc is in flight.

- The 1.0.0-dev.6 → M4a defaults in `src/core/upgrade.ts`, once no arc started on 1.0.0-dev.6 is in flight:
  - `censusOf`: an obligations file without a census (docRef obligations; census checks vacuous).
  - `checkpointOutputM4Default`: a checkpoint answer without `corpusAmendments` or `issueIntake`.
  - `splitChildRuleDefault`: a split child without `rule`.
  - `legacyIdOrder` and `idsAscending`'s `legacyStringOrder` option (with `sortedBy`'s `legacyKey`): a numbered-id list in
    pre-dev.7 string order. Also needs every arc started on feat/m4a-convergence before the fix finished, and the
    repo-authored vision, obligations, ruling and Phase-0 files re-sorted (a string-ordered one is refused once it goes).
    With it goes the dev.7 sentence in `canonicalFingerprint`'s comment (src/pipeline/gate.ts); the set comparison stays.
  - `DEV6_CLASS_CATALOGUE` (K2, step A2) and status's `dev6RevAlias` (K12, step A2), which joins a dev.6 meter row's
    recorded `routingRev` through it.
  - M4a rev 3 (step N0): `HOST_SIGNATURES_DEV6` and the classification of unstamped (no `redRev`) lane and journey runs
    by it; `mutantSubjectDefault` and the dev.6 `finding` arms of the mutant spawn subject and `mutant.apply`
    (`Dev6MutantSubject`, `MutantApplyExpect`); `buildExperimentsDefault` (a build answer without `experiments`);
    `minimalLaneRev` and `laneRevMatches`'s minimal-form arm; `bundleClassesOf`'s `unclassified` reading (with the
    `architecture-doc` variant below); `dev6SmokeBounds` and `BoundsRecord`'s optional smoke bounds;
    `admitTargetsDefault` (a checkpoint admit op recorded without `targets`, before LR-m: read as none);
    `admitSpecTextDefault` (run 10: a checkpoint admit op whose `spec` is JSON text, read as written).
  - With them, the holistic `architecture-doc` variant and the `docRef` obligation arm in holistic arcs: anchor checks
    at the tip, `contractRevs` carrying the architecture doc, an `apply` adding `holistic` to an `architecture-doc` arc.
    Lasting, not scaffolding: the `architecture-doc` variant of a non-holistic arc, `target-kind-changed`, a fingerprint
    without `corpus`, and a sidecar's doc-ref arm for contract docRefs.
- Interim M2 shim: `outcomeFact` writing no `park` for a retryable row whose stage names no targets (step 7a,
  src/pipeline/transitions.ts), and the fold's reading of such a fact as an operator park (`unclassedParkRecord`,
  src/core/state.ts). A behaviour shim, not a release layer (kept by M4a step X0).
