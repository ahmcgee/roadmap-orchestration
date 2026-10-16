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

### M4a (done: plan `/claude-state/plans/m4a-convergence.md`, rev 2.1; 1.0.0-dev.7, merged at b55ad88)

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
- Paid run 12 fixes (2026-10-07): `nextStart` (code owns the chain arithmetic; the skill reads it), the check-in as one
  final message ending with the next action or the stop, `refused` proposals in every checkpoint's inputs (scoped to the
  plan rev, not the audit generation: run 12's ckpt-4 was generation 2 and re-proposed generation 1's refusal), and
  readers after the start never parse the live `.roadmap/config.json`.
- Owner-answer channel (paid runs 12-14, D4 failed three times: answers only reached the session at turn ends, and a
  root agent that never ends a turn never got one): `roadmap answer` into a write-once answer log, listed by
  `status`, the brief and `chain status`, an `answer` watch event, and the `answer-unapplied` start row.

### M4b (in progress: plan `/claude-state/plans/m4b-flow.md`, rev 2; 1.0.0-dev.8, branch `feat/m4b-flow`)

- Records frozen in step 0a (SCHEMAS.md "M4b: the flow loop"); step 0a placed placeholder modules at every final path
  (`src/flow/*`, `src/commands/flow.ts`, the Opus flow prompt) behind `src/core/notyet.ts`, which step C deletes.
- The flow loop, SPC, the flow role, givens, proposals and verdicts, the ruler fence (judgment-seat effort is part of
  the ruler, OR-Q17), test-set-preserving lane edits, the two plants. Seeded from M4a arcs' refs (LR-c).
- First observation for the loop (M4a development, 2026-10-03): host contention is the ladder's constraint. The
  concurrent crash matrix takes ~21 min alone and was cancelled by its 45-min parent timeout when worktree agents and
  the probe shared the host (load ~46); per-cell 30 s and 180 s timeouts in `resource-recover` and `res.lock-order`
  tripped the same way. Candidate levers: serialize heavy files against agent work, or shard the matrix.
- Second observation (paid M4a fixture run 15, 2026-10-08, 15/15 pass): executor spend $131 against $50 for run 14.
  Arc 2 alone ran 14 checkpoint calls ($23.5) and 31 lens calls ($18.3). The 4 cost rows with no arc or role ($23.5)
  are the eval harness's own: three `root` turn rows (the root agent's spend, per transcript turn) and the `totals` row
  (the harness transcript export: `rootCosts`, `costTotals`, `exportCosts`), not executor spend. Checkpoint triggering and lens
  cadence are ruler (RC-1), so the flow role diagnoses judgment cost and never tunes it.
- Answer delivery latency: Claude Code sessions can message each other locally. Once the `roadmap answer` channel
  is proven, measure whether messaging the live root session beats the `watch --actionable` answer wake. A delivery
  layer only; the answer log stays canonical.

### Deferred from M4b (the plan's "Deferred" list)

- Spec-lane levers (RC-3: spec lanes are planner-authored per unit; they often repeat the suite argv).
- `flow revert` (RC-6: a `worse` verdict raises `flow-worse` with the preimage; the root reverts by `apply`).
- A rope (WIP) lever (RC-7: drum-buffer-rope's rope is diagnosed only).
- Judgment-cost levers (RC-1: checkpoint triggering and lens cadence are ruler). Partly addressed in code, not as a flow
  lever (arc feedback 2026-10-16: eleven checkpoints, $78, mostly small spec patches): an audit that finds nothing new
  after a settled checkpoint has none (`checkpoint-skipped`), and a design park's checkpoint is aimed by the executor's
  diagnosis of the lineage, its re-entries citing the failure they fix. Lens cadence and the flow role's view of
  judgment cost stay ruler. Still open:
  - A park checkpoint's diagnosis names salvage's reverted paths but not the lane command a red test belongs to, nor
    whether a red test is in any lane the unit runs (the u1a pattern: 21 attempts against tests its lane never runs).
    Phase 0's witness-in-lane row is the first defence; add it to the diagnosis when a park still shows the pattern.
- Journalled resource waits (the arbiter's waits are in memory; the series reads stage and slot spans only).
- A cost chart and SPC run rule 4.
- Ranking pools by utilisation.
- Feeding `ruler-changed` items into the audit lens inputs (narrowed to the brief and `status.flow`).
- More than one open verdict window arc-wide.
- Host-pressure charging (RC-11, H2) for the D1/D2 checks' lanes, journey lanes and jobs' calls: they keep the handling
  without pressure. Bring in when a paid run shows one of them blocked or red under a saturated host.
- `status` has no tick history, so it shows a host-pressure hold waiting until its 30-min bound even after the host
  calmed (the executor releases it on its own ticks). Bring in (the scheduler publishing its host cpu wait in sched.json)
  when an operator is misled by it.

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

- **Auto-ingest PR review and CI into fix units** (owner ruling 2026-10-16, deferred). Post-completion PR fixes are
  first-class (a reopened arc, or priority units of the next arc with `roadmap pr --supersede-previous`), but the root
  agent turns a red CI run or an owner's review request into fix units by hand. Wanted once that path is proven: the
  executor reads the arc PR's CI status and review threads and proposes the fix units itself.
- **Pack-review advisory on critical-path length** (arc feedback 2026-10-15, item 5, deferred). The pack review
  judges the pack's content, not its shape: a plan whose `after` chain is long serialises the arc whatever the
  capacity. Wanted: a code-computed critical-path length (units and median stage time) beside the pack review's
  notes, as an advisory the architect may act on before admission, never a refusal.

## Do soon (small fixes)

- **Flow seat decorates its station id** (probe, 2026-10-16, dev.11 ladder). The efficient flow seat answered
  `constraint.station: "slot:integration (largest service component suite:suite)"`, refused by `m4b.flow.validate`; a
  rerun passed. In an arc the dev.10 repair turn catches it, at the cost of a call. Tighten the flow prompt: the station is
  a bare StationId, the reasoning goes in `reason`.

## Watch (act only on the trigger)

- **`proofJudgment` → execution evidence** (dev.12 gate method redesign, deferred). An obligation's `proofJudgment` is
  graded by a judge reading the proof; the owner's philosophy (code owns invariants, models own method, evals own trust)
  wants it backed by something executed (a witness run, a mutant) with a role eval measuring the judge. Trigger: the
  role-eval harness (evals/roles/) covers a judgment role beyond the gate.
- **Builder prompt trim** (dev.12, deferred). The builder prompt still carries method instructions accreted run by run;
  trim it to responsibility, resources and the report contract. Trigger: a builder role eval exists to show the trim
  does not cost quality.
- **Lens chunking removal** (dev.12, deferred; the lens-range fix of 2026-10-16). With the bounded diff and readable
  `<not_inlined>` files, one lens call may cover a whole range. Trigger: a lens role eval shows a reader covers a whole
  range in one call; then delete `nextChunk`/`chunkEnd` and the chunk numbering in src/holistic/audit.ts.

- **Apply rebase merges arrays of plain values whole** (2026-10-16). `merge3` merges objects per key and arrays of
  keyed objects per element, but an array of strings (scope patterns, `holistic.advances`, cites, a lane's argv) both
  sides changed is a conflict, never a set merge (an argv's order is its meaning). Trigger: conflicts on id lists such as
  `advances` or `cites.rulings` in an arc's apply receipts; then set-merge the canonical-order id lists only.
- **`rule` does not rebase under the fence** (2026-10-16). A ruling that another revision overtakes while `rule` waits
  for the fence is rejected (`the arc moved`), and its `consistency` is stale anyway (G21). Trigger: an owner `rule`
  rejected that way; then rebuild its proposal under the fence as `apply` does (`commitRebased`).

- **The fast suite is not a flow lever at the lanes stage** (2026-10-15). A fast suite lane's time counts as
  `stage:lanes` service, but a suite-lane lever targets only the integration slot or host cpu, so a slow lane left
  `fast` that makes lanes the constraint has no proposal. Trigger: a flow verdict naming `stage:lanes` while fast suite
  spawns dominate its service time; then let the suite-lane lever target the lanes stage (or propose moving it to
  `estate`).
- **Paid m4a early abort ignores the plant lane's tier** (2026-10-15). `plantLaneOf` in the m4a driver does not check
  that the root agent declared the slow suite lane `estate`; a `fast` one makes lanes the constraint and fails
  `flow-constraint` only hours in. Trigger: the next paid m4a run; add the tier to the early-abort check before it.
- **The fast suite at the lanes stage** (2026-10-15 batch, deferred while unproven). Each lanes attempt runs the fast
  suite afresh: no reuse of an earlier certified pass (F1a covers spec lanes only), a base check's verdict lives in
  memory for the run (a restart runs it again; a candidate's tip-alone run is never read as one), and a plan known
  defect matches spec lanes only, so a fast suite red naming one charges. Triggers: the fast suite's share of
  `stage:lanes` service time shows on the flow chart; a restart re-running base checks costs measurably; a known defect
  whose lane is a suite lane. Then: reuse by lane identity as F1a does, journal the base verdict, extend `knownDefectHit`.
- **Hold cycles beyond the first blocker** (arc feedback 2026-10-15). The cycle graph follows each waiting repair's
  first blocking P1 only (`findingBlock`); a member that a second P1, owned outside the cycle, also holds leaves the
  cycle unbatched, waiting as before. Trigger: an arc whose repairs wait at their candidates with no cycle batch while
  every blocker's owner is approved; then follow every blocker and batch the closure.
- **The dev.9 resume crash** (arc feedback 2026-10-15). The stuck unit's crash on `resume` was not reproduced: the
  startup's recovery hold closes its attempt, and a resumed held unit re-runs from its decision as an abandoned
  attempt always did. Trigger: a resume of a recovery-held unit that still throws; read the throw site from its
  stderr.
- **Scope growth beyond the uniform plan-check** (2026-10-15). Deferred: (a) the in-session assessment of a frontier or
  summit builder under `planCheck.shape: by-builder` proposes no `scopeGrowth` (it makes no plan-check call); (b) a
  builder's `scope growth: <path>` blocker reaches only the gate (it reads the build report), never a hold of its own,
  unless salvage reverted that path on its last two build rounds (plan defects, 2026-10-16: then the unit holds at lanes
  with that path as the proposal); a blocker naming a path the builder never edited still waits for the gate;
  (c) `start` writes Phase-0 row 10's advisories to the executor's stderr only (`phase0 check` and `apply` print them).
  Trigger: a unit under `by-builder` needs growth its assessment cannot propose, or a gate escalation that a held
  proposal would have saved.
- **Plan defects beyond Phase 0** (2026-10-16). (a) A checkpoint's split child is checked against its lane (its
  declared files, required when the parent declared them), not for reach: a child whose file no deliverer can create is
  caught by the next `apply`'s row 11 or by the run-time `plan-defect` park. (b) A flow lever that rewrites an arc
  lane's argv is not re-checked against the witness files of that lane; the run-time diagnosis catches the first
  witness it hides. (c) Spec witness items (`W-n`) declare no file: only obligations' witnesses are checked. (d) Derived
  outputs widen a dispatched unit's scope with no ruling and no classifier rule on later `derived` edits. Triggers: a
  `plan-defect` park whose cause one of these would have refused earlier; a flow proposal that moves a witness out of
  its lane; a spec witness item that is never run; a `derived` edit that hands a unit someone else's file.

- **Executor faults outside bundle judging** (real arc 2026-10-12: a `reenter` + `patch-spec` of the re-entered unit
  threw in the divergence step and crash-looped the executor to sup-4-4). The fix contains only `decide`'s judging
  (steps 0–9): it decides the bundle invalid and records it, so a restart never replays it. A deterministic throw in
  `settleDecided`, the scheduler or any other job resumed from a recorded model output would still replay on every
  restart until the supervisor gives up. Trigger: a second crash loop of that shape; then decide on a general rule
  (a job's fault is recorded against the job before the throw escapes).

- **Checkpoint reads refused** (paid M4b run 5): the checkpoint call inv 2174 was refused reads of the runtime's
  `inputs/*.plan.json` (outside its `--add-dir`s) and still answered `bundle`. The gate and plan-check void an approve
  after a refused read (`readRefused`, src/pipeline/stages.ts); the checkpoint does not yet. Trigger: a checkpoint
  decision that rests on a refused read, or a second run whose checkpoint reads.json shows `denied`; then decide whether
  to add the readable dirs it reached for, or to void its answer the same way.
- **`nextStart` reads K at the chain head's baseline** (paid run 12 fix): a K the owner commits after that baseline is
  seen only by the next start itself (the live file at `start`), not by `chain status`. Trigger: a session stopping
  `k-limit` while the owner's newer committed K would allow the start.
- **No check criterion grades check-in shape on paid runs** (paid run 12: "waiting for your answers" with no questions).
  The fake story asserts it; a paid run only shows it as a nudge turn. Trigger: a paid run with a nudge after a check-in.

- **A lens that answers invalid abandons its audit, retried only after `wallClockMin`** (run 10 round 2, R-16 review):
  since dev.12 an invalid report first takes its repair turn inside the audit; refused again, `runAudit` asks the
  remaining lenses, ends `abandoned`, and the cadence's `retry` waits the period (default 360 min), a final audit
  included, then asks every owed lens again, those that reported on the same (head, vision, obligations) included. Not
  seen in run 10 (every audit completed). Trigger: an `abandoned` audit in a paid run; then drop from a retry the lenses
  whose key is unchanged.
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

- The dev.11 adoption arms of the one judgment repair turn (dev.12), once no arc started on 1.0.0-dev.11 is in flight:
  `repairTurnOf`'s `--no-session-persistence` arm (src/pipeline/dispatch.ts: a dev.11 gate, lens, pack-review or flow
  call's unpersisted session takes no repair turn) and the lens loop's recorded-call rule (src/holistic/audit.ts: a
  recorded dev.11 fresh re-ask of a refused draft is consumed as the repair turn's answer; after a malformed report a
  call recorded at the next number that is not its repair, `isRepairTurnOf`, is another's). With them, a recorded call at
  a repair turn's number is always its repair turn.

- `auditDiffBudgetOf`'s absent arm (src/core/upgrade.ts) with `nextChunk`'s unchunked branch (src/holistic/audit.ts),
  once no audit a dev.10 executor started is running: such an audit reads each range in one call. With it,
  `audit-started.diffBudget` becomes required.
- `applyExpectRevDefault` (src/core/upgrade.ts), once no arc started on 1.0.0-dev.10 is in flight: an apply command
  queued before the apply rebase carries `expectRev` and reads as base null. With it, `base` is the only field read.
- `applyVisionEditDefault` (src/core/upgrade.ts), once no arc started on 1.0.0-dev.10 is in flight: an apply command
  queued before `--vision-edit` carries no `visionEdit` and reads as a declared vision edit. With it, `visionEdit` becomes
  required.
- `reenterFixesDefault` and `FIXES_UNRECORDED` (src/core/upgrade.ts), with the bundle proposer's `fixesUnrecorded`
  (src/holistic/bundle.ts `proposerOf`, src/input/classify.ts `Proposer`, `fixesReasons`' first line), once no arc
  started on 1.0.0-dev.10 is in flight (every later checkpoint reads the arc's applied answers): a checkpoint `reenter`
  op recorded without `fixes` is adopted as recorded. With it, `fixes` becomes required in `bundleOp`. (`plan.json`'s
  `reenters.fixes` stays optional: re-entries in force before it are lasting records.)
- `RECORDED_DROP_REASONS`' `elevate-early` (src/flow/types.ts), once no arc started on 1.0.0-dev.11 is in flight: a
  dev.11 `flow-ended` may record that drop reason, which dev.12 no longer writes. With it, `flowDropped` reads
  `FLOW_DROP_REASONS` and `checkProposal` returns a plain `FlowDropped`.

- The 1.0.0-dev.7 → M4b default in `src/core/upgrade.ts`, once no arc started on 1.0.0-dev.7 is in flight:
  `dev7ArcRolesDefault` and `arcRolesInForce`'s null arm (src/routing/layers.ts): a routing provenance without
  `arcRoles` reads as the dev.7 role set (no `flow`), the flow loop off (`off-dev7`). With it, `arcRoles` becomes required.
  The M4b rev 3 defaults go with it: `spawnPressureOf` (a spawn result without `pressure` reads null) and
  `startPressureOf` (an `executor-started` without `pressure` reads `unavailable`) and `exitCpuOf` (an exit.json without
  `cpu` reads null); the three fields then become required.
- `readsDeniedOf` (src/core/upgrade.ts), once no gate call an executor before paid M4b run 5's fix closed is unconsumed: a
  reads.json without `denied` reads as none refused. With it, `denied` becomes required.
- `buildFinalDefault` (src/core/upgrade.ts), once no build an executor before the report rule (2026-10-11) launched is
  unconsumed: a build answer without `final` reads as final. With it, `final` becomes required in `buildOutputFor`.
- `planCheckScopeGrowthDefault` (src/core/upgrade.ts), once no plan-check call an executor before scope growth
  (2026-10-15) launched is unconsumed: a plan-check answer without `scopeGrowth` reads as none proposed. With it,
  `scopeGrowth` becomes required in `planCheckOutput`.
- `laneTestPathsUndeclared` and `witnessFilesUndeclared` (src/core/upgrade.ts) with Phase-0 row 11's undeclared arm
  (src/phase0/rows.ts `witnessDefects`), once no arc started on 1.0.0-dev.10 is in flight: obligations that declare no
  witness files read as undeclared. With them, `testPaths` and `files` become required in the readers.
- `PRE_DEV10_BUILTIN_SEATS` (src/core/upgrade.ts) with status's `preDev10RevAlias` and `resolveRoutingUnder`
  (src/routing/layers.ts), once no arc started on 1.0.0-dev.9 is in flight: the built-in seats before the efficient
  class took the low-risk judgments (2026-10-15), kept only so `status` joins an earlier executor's recorded routing revs.
- `lensPatchMutantDefault` (src/core/upgrade.ts) and `LensMutant`'s `kind: patch` arm with `admitMutant`'s `checkPatch`
  branch, once no audit an executor before paid M4b run 3's fix started is running: a recorded lens answer's mutant
  `{patch, lane}` (a hand-written diff) reads as written. With it, a lens mutant is edits only.
- The 1.0.0-dev.6 layer below is no longer adopted (1.0.0-dev.8 adopts dev.7 only; no dev.6 arc was in flight at M4b
  step 0a, which moved `PREVIOUS_RELEASE` to b55ad88 and dropped the dev.6 upgrade cases). Step 0a deleted the
  self-contained part: `checkpointOutputM4Default`, `splitChildRuleDefault` (a checkpoint answer now needs
  `corpusAmendments`, `issueIntake` and each split child's `rule`), `DEV6_CLASS_CATALOGUE` and status's `dev6RevAlias`
  (with `resolveRoutingUnder`). The rest goes in one dedicated step with the corpus migration of the M3 fixtures below.

- Holistic `architecture-doc` arcs (adopted dev.6 arcs only; a fresh one is refused, D0). With them go the
  `architecture-doc` arm of the holistic code paths and the M3 fixtures that put such a plan in force as revision 1
  by `recordPlan` (adopted-arc coverage, lead ruling LR-D0b): `brake-common` (`holisticArc`), `audit-common`,
  `checkpoint-common`, `repair-common`, `batch-common` and their tests (audit, baseline, batch, brake, checkpoint,
  repair, scheduler-m3, publish, gate, revision, snapshot, status-m3, startup-checks). Migrate those tests to corpus
  arcs (`test/fixtures/corpus-target.ts`) when deleting, once no dev.6 arc is in flight.

- The 1.0.0-dev.6 → M4a defaults left in `src/core/upgrade.ts` (no dev.6 arc is adopted since 1.0.0-dev.8):
  - `censusOf`: an obligations file without a census (docRef obligations; census checks vacuous).
  - `legacyIdOrder` and `idsAscending`'s `legacyStringOrder` option (with `sortedBy`'s `legacyKey`): a numbered-id list in
    pre-dev.7 string order. Also needs every arc started on feat/m4a-convergence before the fix finished, and the
    repo-authored vision, obligations, ruling and Phase-0 files re-sorted (a string-ordered one is refused once it goes).
    With it goes the dev.7 sentence in `canonicalFingerprint`'s comment (src/pipeline/gate.ts); the set comparison stays.
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
