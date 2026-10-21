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

### Deferred from the dev.12 role evals (evals/roles/)

- Role evals for the lens, plan-check, checkpoint and builder seats, on the gate eval's harness and generator. Bring each in
  with the change it would guard (the plan's deferred lens-chunking removal and builder prompt trim need theirs first).
- The load brake compares token load, not dollars: the CLI reports cost only on its result. Switch to cost if the stream
  starts carrying it per message.
- A look at the plant counts a Read of its file or `.diff` and a Grep that showed it, in any session; a Glob listing or a
  subagent's summary does not. Revisit if a real run grades a legitimate catch `lucky`.
- Rotate the holdout classes after each acceptance that used them (a holdout seen in a failure analysis is half spent).
- **Haiku at the low-risk gate: retry.** The paid gate role eval (2026-10-17, dev set, n 3, `--risk low`) failed Haiku 5.5
  (economy) at gate.low: 4/12 false alarms on clean cells at effort `high` (1/9 at `medium`), all five the same mistake, a
  blocking finding on a tension between the spec (A2 moves the arithmetic helpers to `core/`) and ruling C-1 (helpers live
  in `src/`) when the build did what the spec said; that tension belongs in `premises`, not in a blocking finding. It caught
  no plant Sonnet missed. Sonnet 5.5 high on gate.med: 0/12 false alarms. gate.low reverted to efficient; the economy
  class, its Haiku binding, the Haiku prompt rows, family metering and `--rebind` stay. Trigger: a reason to want the
  cheaper low seat back (a Haiku release, or gate spend becoming the constraint). What to change: the Haiku gate variant
  sends spec-vs-ruling tensions to `premises` (a Haiku-row line, judged by the eval, not a prose test), then rerun the
  low arm with Haiku on gate.low (~$6). The harness rebinds classes only: `--rebind efficient=claude-haiku-5-5:high` would
  also put Haiku on build.low, which has no build prompt, so the retry needs a seat override first (a `--seat
  gate.low=economy` flag writing the repo config's `routing.seats`), then `node evals/roles/run.ts gate --set dev --n 3
  --risk low --seat gate.low=economy` with `--rebind economy=claude-haiku-5-5:<effort>` for the effort arm. Pass bar: the
  clean-cell false-alarm rate matches Sonnet's and the catch rate holds. The plan-check ladder waits on the same answer:
  efficient low and med, frontier high until a plan-check role eval measures a cheaper low seat.
- **Large-diff gate: cheaper departures-only review (built and measured in dev.12; the cost lever deferred).** The
  large-diff gate (DESIGN-1.0.md §4 Gate inputs: over the bounded diff's overflow the gate sits at least at `high`, reads
  the owner's `<large_diff>` method and answers a cluster map code checks covers every changed path exactly once) was
  measured 2026-10-17/18 at `--risk med` (escalated to Opus): G2b/G3b/G3a caught 9/9, 0/9 clean false alarms (G1 x3, and
  G4c/G6c x3 each in the second run), $1.50-33 a trial, about $10 mean on the planted cells. Before it, Sonnet missed
  G2b/G3b 6/6 and Haiku 5/6 (both honest in `unreviewed`); unguided Opus caught 5/6 via subagents inheriting its model
  ($6-61 a trial). The cost driver: Opus labels whole mechanical clusters `routine` whenever Haiku reports any departure,
  so Sonnet reads ~1,000 identical hunks (one trial: $27 of $33). A prompt line steering review onto the departing hunks
  only (matching hunks stand on the description) was measured and reverted: G3b held 3/3 at ~$7.5 flat, clean trials
  ran $1-2, but G2b fell to 1/3. Both misses escalated rather than approved: Opus would not trust the departure lists
  because it could not have them checked (it asked Haiku for a byte-level substitution replay; judgment sessions have no
  shell), and one trial answered while 35 background subagents were still running. Next, together:
  1. **A code-owned rule verifier.** The bounded diff's identifier miner explains 1 of 3,196 files in the G2b fixture
     (a prose doc-comment rewording rides every file), so it cannot certify a sweep. Instead the gate (or a Haiku
     describer) states the sweep as literal before -> after rewrite rules with identifier placeholders (no regex or
     wildcards); code applies them old -> new to every hunk and compares byte for byte; a rule counts only if it
     recurs (N hunks across N files), so a one-off plant cannot be written as a rule; the rules are in the answer and
     reviewed as a contract. Hunks the rules reproduce are explained; every other hunk is a departure and gets a
     reviewer. Directed application also closes the placeholder-merge hole (connected identifiers reading as one).
  2. **The departures-only prompt line** (reverted commit 80e1ac6), on top of the verifier.
  3. **Background subagents:** the gate states as a fact that its answer ends the session and a subagent still running
     is lost, or code holds the answer until they finish.
  Trigger: real arcs show large-diff gate spend that matters (`status` spend by seat), or the next gate batch. Measure on
  G2b/G3b/G3a with clean twins; pass bar: catches hold at 9/9-level, cost per planted trial roughly halves. **Measured
  2026-10-18 (dev.13 gate eval, /var/tmp/roles-gate-dev13):** with the shell, the large-diff gate (Opus) caught G2a/G2b/
  G3a/G3b 3/3 each at about $0.90 a trial (dev.12: about $8.80), reading the change with `git diff` and grep instead of
  reader subagents. The cost lever is met without the verifier; keep this entry only for the background-subagent point.
- **The role eval's per-trial cap undercounts.** `--trial-cap` estimates live spend from the stream, which carries only
  part of the subagents' tokens: one trial read $15 live against $33 reported, so a $25 cap never fired. `--cap` (between
  trials) works. Fix: price the per-agent token totals the monitor already traces, or call the per-trial cap approximate.

### Deferred from dev.13, the gate's shell

- **Cited experiments checked against the session.** A gate finding's `experiments [{command, output}]` is recorded and
  reported, never checked. Code could match each command to a Bash call in the session's stream and its output to that
  call's result, and refuse (repair turn) an answer citing an experiment it never ran. Trigger: a role-eval transcript or a
  real arc shows a gate citing an experiment it did not run, or quoting output its command did not print.
- **A shell for plan-check and the lenses.** Owner 2026-10-18: the gate first; the others by the gate eval's result.
  Trigger: the dev set's `exec-gain` passes (the X cells beat the read-only arm) at a cost per trial the owner accepts, and
  a plan-check or lens miss in a real arc is one an experiment would have caught.
- **A probe row for the gate's acting argv.** `evals/probe.ts` checks the judgment and walkthrough argv against the real
  CLI; the gate's acting call (Bash runs in its cwd, writes stay in its checkout, no MCP server listed in the init event)
  has no row of its own, and the smoke's `CallRequest` has no acting-judge kind yet. Trigger: the next probe batch, or a
  gate call on a real arc that fails to launch.
- **The Fable gate row** inherits the Opus module with a review dated 2026-10-16; the dev.13 `<your_checkout>` section was
  not reviewed against the Fable guide. Trigger: a repo rebinds a class to Fable at a gate seat.
- **Execution-only gate cells that measure the shell (X1–X3 redesign).** Measured 2026-10-18: the read-only gate (Sonnet,
  med) caught all 9 X plants by reading (a lexicographic sort, a lookup table, a dropped remainder are visible in the diff),
  so `exec-gain` cannot pass on them; and every X twin shares its plant's weak tests, so a gate revising for the untested
  spec behaviour is graded a false positive (read-only 5/9, shell 4/9 on X2c/X3c). Wanted: plants a strong reader cannot
  see (behaviour that depends on data or environment the diff does not show) and twins whose tests do cover the behaviour
  the plant breaks. Trigger: the next gate batch, or before a shell is given to plan-check or the lenses.
- **Coverage on a shell gate.** `coverage` counts files a session Read, grepped or named in a Bash command; a bulk
  `git diff` names none, so the large-diff cells read 0% while catching every plant. Trigger: coverage is used for a
  decision (it is INFO only today).
- **Fixture builder: an impossible 'omitted' placement takes about 9 minutes to fail.** Each placement check runs the
  bounded diff on the full repo (about 25 s) and the builder tries 20 candidates. Trigger: another cell hits it; then
  stop early when the sweep cannot overflow the budget.

### Deferred from dev.13, milestones, walkthroughs and the demo

- **Isolate role-eval trials from each other's evidence.** A walker that lost a screenshot ran `find / -name …` and saw
  other trials' evidence under the eval's out dir; the needle guard voided it (2 of 36 dev trials). The prompt fix
  (absolute capture paths, e9b825b) removed the cause; trial dirs could also be made unreadable to the session's peers.
  Trigger: a needle void recurs.
- **Walkthrough fixtures keep finding real defects in their own clean product.** Every dev and holdout round found genuine
  defects in ledgerly's clean product (seven fixed in 1c60f0b, 2c9864c, 71d5d34, c070bd4, 388d8ef), so twin false
  positives measured the fixture as much as the walker. A fixture change needs a fake-free walk of its clean product
  before it counts. Trigger: the next fixture or family change.
- **W12 (CI log text) is the one class boundary the walker still crosses** (dev-6 2/12 trials and holdout-4 1/6 classed
  the plant breaks/journey or contract). 78f2e74 reworded J-8, which had made "find what to fix" the journey's outcome; the
  full re-runs since (dev-7 + dev-7b 12/12 trials, holdout-5 6/6) pass every criterion with 0 false blocks. Trigger: it
  recurs in a real arc's walk; then a sharper example in the prompt's reason.
- **The m5 paid run has not shown a walk-to-repair loop on a real arc.** Run 2 (/var/tmp/m5-dev13-2, 2026-10-19): the
  design unit repaired the planted 2.12:1 contrast before the first walk, the walks found one P2 the checkpoint ruled
  accepted, so no repair or polish unit ran (the loop is covered by the fake-backend integrated tests and the role evals
  only). The plant is now a data row only rendering reveals (an unbreakable URL in the first book's condition, so the page
  scrolls sideways at 320 px; check.ts grades it by rendering, reflow.ts). Run 5 (/var/tmp/m5-dev13-5, 2026-10-20) ran
  the loop on another defect: walk-1 found F-34 (the no-match heading overflows at 320 px), `headings` repaired it,
  walk-2 passed MS-1 (check.ts `repair-loop` grades this on any milestone now). The vision audit lens named the plant
  (F-1) before any walk and the checkpoint folded the fix into a unit's spec; plant-caught now grades the flow (any
  judge's resolved finding naming the planted book, or the plant gone by the first walk), so run 5 passes "prevented
  upstream". Open: no paid run has yet shown a walk itself catch the plant. Trigger: a run where the plant survives to
  the first walk.
- **A direct `demo down` with no live arc.** Demo acts are queued commands; with no executor running they wait for the
  next start. Trigger: the owner wants the demo stopped between arcs.
- **Write-deny rules cover paths existing at call start.** A directory created later beside the path to a writable
  directory is outside the deny list, and Bash is trusted to the prompt (as for builders). Trigger: a real arc shows an
  acting judge writing outside its checkout or evidence dir.
- From the plan (/claude-state/plans/dev13-implementation.md §11): a reference render; visual-regression baselines;
  checkpoint authority over milestones; a cross-model walkthrough judge; Sonnet and Haiku walkthrough variants; desktop
  apps (Electron via Playwright, native via a virtual display); Claude Design in design units (trigger: usable from a
  headless `claude -p`; it was not on CLI 2.1.301); an advisory for human-facing units outside every milestone.

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

- **Builder eval for test strength** (dev.13, 9279c77). The build briefs now ask that tests fail for the two or three most
  plausible wrong versions (the vacuity lens's question). Unmeasured but for the m-fixtures' first-audit vacuity count
  (m5 run 5 baseline: 10 P2 + 3 P3 in the first audit). Bring in a builder role eval with plants a vacuous suite passes.
- **Gate alignment with vacuity** (dev.13, deferred). The gate has one line on vacuity and approves suites the audit
  later finds vacuous; with its shell it could run a mutant or two of the diff against the tests. Trigger: m-fixture
  first-audit vacuity P2s that the builder change does not remove.
- **Builder prompt trim, after the builder eval** (W3, 2026-10-16, deferred). The build briefs restate rules code already
  backs; trim each once a builder eval shows the outcome holds without it. Candidates: the scope paragraph's "the
  executor keeps only changes to paths matching them" (salvage enforces it and the fix round names reverted paths); the
  Opus brief's <lanes> "repeat after fixing until each exits with its expected code" and the Luna success criterion it
  mirrors (the lanes stage reruns them and a red lane comes back as a fix round); "Estate lanes are not yours" (the
  executor runs them, and the unit policy forbids the clusters); the <witnesses> paragraph's lookup by exact id (D1 checks
  it before the gate and the fix directive restates it); "Committing is optional" (salvage commits). W3 dropped only the
  one plain duplicate, <safety>'s "do not kill processes you did not start", which UNIT_POLICY states.
- **Delegation for the Codex builder** (W3, deferred). The Luna/Sol build brief carries no subagent guidance: the role
  prompts' text names Claude Code's Agent tool, which `codex exec` does not have. Revisit if Codex gains a subagent tool
  worth using unattended.

## Do soon (small fixes)

- **Flow seat decorates its station id** (probe, 2026-10-16, dev.11 ladder). The efficient flow seat answered
  `constraint.station: "slot:integration (largest service component suite:suite)"`, refused by `m4b.flow.validate`; a
  rerun passed. In an arc the dev.10 repair turn catches it, at the cost of a call. Tighten the flow prompt: the station is
  a bare StationId, the reasoning goes in `reason`.

- **Lens and flow failures drop their detail** (W2, 2026-10-16). A lens call that fails (a fault, a refusal,
  `context-exceeded`) only marks its audit `abandoned`, and a flow job's `failed` raises nothing; the detail string
  (`verdictOf`'s, which names the role, the call and, for `context-exceeded`, the prompt's size) reaches no record. The
  checkpoint (rejected-invalid) and the pack review (its item) keep it. Record it where each job records its end.

## Watch (act only on the trigger)

- **A rule retired mid-arc leaves no trace in the pin** (2026-10-21; 1.0.0-dev.16). Every re-pin diffs the corpus against
  the baseline's registry, never against the pin in force, so a rule the owner retires mid-arc that the baseline's
  registry never held (every rule of a first corpus arc) is in neither list of the new pin, and the high-water may fall
  below its number. Retiring its obligation is now representable (a retired obligation's anchor is not asked,
  `ruleAnchorResolves`); the close-out registry still omits the rule, and a later re-pin in the same arc could reuse
  its number unrefused. Trigger: a rule id reused within one arc, or a later arc that needs the retired id recorded.
- **Milestone references a unit sums, and references grown at run time** (2026-10-21; 1.0.0-dev.16). Row 11's
  `milestone-references-oversize` checks each milestone's reference dirs at the tip against `MILESTONE_REFERENCES_BUDGET`.
  A unit in several milestones inlines the union of their references, which the row does not sum; and a design unit that
  grows its references past the budget is caught only at the next call's `context-exceeded` park. Trigger: a
  `context-exceeded` park of a milestone unit whose milestones each pass the row.

- **The convergence tail's edges (dev.13, src/holistic/tail.ts).** Deferred while unmeasured; act on a paid run that shows
  the trigger. (1) An admit that addresses a finding below a brake without naming it in `repairs` is not caught (only
  `repairs` is read); trigger: a converted-admit count of 0 while units are still admitted after the settled point.
  (2) A braked P2 whose admit converted is released, not banked, unless the checkpoint also deferred it; trigger: an owner
  finding a substantive defect among `release{regress | settled}` findings. (3) A finding that an obligation is broken is
  under no brake (correctness never banks and is never released; a vacuity finding on an obligation's witness is braked
  and banks when deferred); trigger: a tail of obligation-broken P2s. (4) The settled
  point counts polish and checkpoint (`origin: checkpoint` without a finding repair) units as planned work, so a polish
  round keeps the arc unsettled; trigger: a walk round's polish units holding the brake off while the audit tail grows.
  (5) Walkthrough findings are under no brake (m5 run 6: the last walk settled the arc and the settled brake released its
  five P2 deviations); they are bounded by the walk rounds and the walk and compare attempts only; trigger: a walk round
  that keeps opening P2s after its milestone passed.
- **A disposition contradicting a repair** (dev.13, m5 run 6 F-18). A finding named in the repairs of a unit the decision
  admits or re-enters is never ruled by it: its disposition, whatever it is, is not written (src/holistic/tail.ts
  `tailRulings`). An `accepted` beside the repair is the expected case; a `dismissed`, `deferred` or `released` beside
  one contradicts the admit and is overridden without a reason. Trigger: a decision record showing one: make it a bundle
  reason (the repair turn) instead.

- **Regenerate checks: deferred parts** (1.0.0-dev.12, src/input/derived.ts). (a) The build prompt does not name a touched
  entry's `regenerate` command; a builder learns it from the spec, or from its first red check's evidence (which says what
  to run). Trigger: a paid run or arc where a regenerate red costs a fix round a named command would have saved: add it
  to the build inputs beside the suite lanes. (b) The candidate merge does not re-run it: two units each consistent with
  the generator can merge into outputs that are not (both edit sources; the merge combines the outputs textually).
  Trigger: a candidate whose merged outputs do not regenerate (seen as a later unit's base check going `base-red` on a
  regenerate lane): run the regenerate lanes of the entries the merge touches in the candidate's suite. (c) The lane takes
  the fast tier's `@cpu`, no resources and no cross-SHA reuse. Trigger: a generator heavy enough to matter: let
  `regenerate` declare `cpu`, or reuse with `inputs` = the entry's sources and outputs.

- **Bounded diff heuristics** (1.0.0-dev.12, src/git/boundeddiff.ts). A file's kind is read from its path (test and
  fixture directories and names, a fixed list of source extensions); a package is a top-level directory or two levels
  under a monorepo container, not the nearest manifest; a deletion matches a `removes` entry only as the path, a
  directory above it, or the file name without its extension (a route string or symbol never matches a path). Trigger:
  a gate eval (evals/roles/) or a paid run showing a reviewer misled by a wrong kind, spread or label.
- **Leftover first explains identifier substitutions only** (1.0.0-dev.12, src/git/boundeddiff.ts). A file is explained
  only when each changed line equals its pair once the listed identifier substitutions apply, so a mechanical change of
  another shape (an assertion migration `assert.ok(x === v)` to `assert.equal(x, v)`, a reformat or rewrap after a
  rename, an import line added to every file) leaves its files unexplained; thousands of them fill the budget in kind
  and path order again. Trigger: a gate eval or a paid run whose inlined budget is spent on mechanical changes of one
  shape. Then mine recurring line rewrites (normalised removed and added line pairs) as a second kind of pattern.
- **Bounded diff spawns one process per file** (1.0.0-dev.12). Each content-changed file costs a diff process (and a
  second to write its readable file when not inlined): about 30 s for a 3000-file sweep on the dev host. Trigger: gate
  latency that matters against the gate call itself. Then split one bulk diff per file (rename pairing in a bulk diff
  can differ from a per-file pathspec's, so each readable file must stay what the per-path diff prints).
- **Lens chunks fit by the dev.11 measure** (1.0.0-dev.12). `fitsWhole` (src/holistic/lensdiff.ts) still sizes a chunk by
  the `--no-renames`, three-line-context diff so a resumed dev.11 audit finds its chunks again; the attachment is the
  smaller bounded diff, so chunks are shorter than they need be. Trigger: once no audit a dev.11 executor started is
  running, size chunks by the bounded diff itself (recording the measure on `audit-started` if it must stay stable).
- **Resume overcount crossing the upgrade** (W2, 2026-10-16). A Claude session's reading is charged less what its earlier
  facts charged; a session whose earlier invocation an executor before 1.0.0-dev.12 metered has no `session` on that
  fact, so its first dev.12 reading (a repair turn or a resumed build) is charged whole, once. Nothing to do unless an
  arc's spend matters at that precision.
- **A judge's background subagent** (W2, 2026-10-16). The Agent tool's `run_in_background` lets a judge end a turn while a
  subagent runs; the session then prints an interim result (with `structured_output`) and a later one, and the adapter
  reads the last. Watch for a judge whose deadline kills it while it waits on a background subagent: then tell judges to
  run subagents in the foreground, or treat the last interim answer as the call's.

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
- **A checkpoint op's non-empty `cites` and `evidence`** (W4, 2026-10-16). W4 dropped the per-reason cite rule, the
  unenforced reporting caps and any mandate on `premises`/`interpretations`, but kept the per-op requirement (every bundle op
  cites at least one active `V-n` and non-empty evidence; DESIGN §2.8 checkpoint authority, the traceability the owner
  audits). The evidence strings are not verified, so the requirement is partly method. Trigger: a repair turn or refused
  bundle whose only fault is an op's empty `cites` or `evidence`; then make both may-be-empty and keep resolution only.

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

- **A declared evidence glob matching a symlink** (2026-10-21; 1.0.0-dev.16). The dev.16 fix (SCHEMAS.md "Field fixes:
  snapshot symlinks, restart checks") skips and records a symlink or special file among a checkout's dirty paths;
  a lane's `evidenceGlobs` entry matching one still makes `listEvidence` throw in the lane's `tree` snapshot, which
  crash-loops like the field case did. Trigger: that throw in a field run; then give declared globs the same
  `notRegular` record (the reconciler's re-list must skip alike).

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

- **Builder role eval: the gate's marginal value** (2026-10-17; research notes outside the repo,
  review-pass-research.md). About 30 to 40 trap units on the role-eval harness (an untested spec clause, an
  impossible criterion, the temptation to edit a test, scope-creep bait, false-done bait) plus clean controls, built by
  real builders, in three arms: tests only, + gate, + cross-family gate. For each stratum (risk tier, trap kind) count the
  catches the gate adds over the lanes; drop or thin the gate where that count is zero. Trigger: the paid gate role eval
  settles the gate ladder, or a real arc's gate spend passes its build spend.
- **Deterministic check: removed or skipped tests** (2026-10-17). A unit whose diff removes a test or adds a skip fails
  in code unless its spec allows it (a `removes` entry or a clause naming the test). Trigger: a gate catch, role-eval
  trial or arc where a builder dropped or skipped a test to get green.
- **Time signals for judges and multi-agent work** (Opus 5.5 guide, 2026-10-17): give a judgment session elapsed time
  against its deadline, and the skill's fan-out elapsed time against a budget. Trigger: a judgment killed at its deadline
  with no answer, or a role eval showing a judge spending past its budget on reading it never cites.
- **Effort xhigh only where measured** (Opus 5.5 guide, 2026-10-17: xhigh where it shows a measured gain). The escalation
  seats and the checkpoint run summit (xhigh) unmeasured. Trigger: a role eval for the escalation gate or the checkpoint;
  then compare `--rebind summit=claude-opus-5-5:high` with xhigh and keep xhigh only where it catches more.
- **Three-state verifier** (CONFIRMED / PLAUSIBLE / REFUTED): a separate, evaluated pass over a judge's findings that
  tries to refute each. Only if a false-alarm problem is measured: a role eval or arc where blocking findings that are not
  real cost fix rounds (the 2026-10-17 gate eval saw 0 false alarms in 12 clean trials).
- **Vacuity lens: "the smallest regression this test would miss"** (BMAD-style): have the vacuity lens name, per test it
  judges, the smallest change to the code that the test would still pass. Trigger: a lens role eval, or a real arc where a
  vacuous witness test passed the vacuity lens.

## Scaffolding to delete

- `gateNoteDebtDefault` and `GATE_DEBT_UNRECORDED` (src/core/upgrade.ts), with `gateDebtNotes`' unrecorded arm
  (src/pipeline/gate.ts), once no arc started on 1.0.0-dev.12 is in flight: a dev.12 gate finding has no `debt` and its
  note banks as dev.12 banked it. With them, `debt` becomes required in `gateOutput` and narrows to `GateDebt | null`.
- `gateDiffShownOf`'s absent arm (src/core/upgrade.ts), once no arc started on 1.0.0-dev.11 is in flight: a gate's
  `judgment-inputs` recorded without `diffShown` reads as nothing recorded. With it, `diffShown` becomes required on a
  gate's (src/core/events.ts).
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
- `gateUnreviewedDefault` (src/core/upgrade.ts), once no arc started on 1.0.0-dev.11 is in flight: a dev.11 gate answer
  has no `unreviewed` and reads as null (unknown). With it, `unreviewed` becomes required in `gateOutput` and
  `GateUnreviewed[] | null` narrows to the list.
- `gateLargeDiffOf`'s absent arm and `gateClustersDefault` (src/core/upgrade.ts), once no arc started on 1.0.0-dev.11 is in
  flight: a dev.11 gate's `judgment-inputs` has no `largeDiff` (read as under the threshold) and its answer no `clusters`
  (read as null). With them, `largeDiff` becomes required on a gate's `judgment-inputs` and `clusters` a required key in
  `gateOutput`.
- `RECORDED_DROP_REASONS`' `elevate-early` (src/flow/types.ts), once no arc started on 1.0.0-dev.11 is in flight: a
  dev.11 `flow-ended` may record that drop reason, which dev.12 no longer writes. With it, `flowDropped` reads
  `FLOW_DROP_REASONS` and `checkProposal` returns a plain `FlowDropped`.

- The 1.0.0-dev.7 → M4b default in `src/core/upgrade.ts`, once no arc started on 1.0.0-dev.7 is in flight:
  `dev7ArcRolesDefault` and `arcRolesInForce`'s null arm (src/routing/layers.ts): a routing provenance without
  `arcRoles` reads as the dev.7 role set (no `flow`), the flow loop off (`off-dev7`). With it, `arcRoles` becomes required.
  The M4b rev 3 defaults go with it: `spawnPressureOf` (a spawn result without `pressure` reads null) and
  `startPressureOf` (an `executor-started` without `pressure` reads `unavailable`) and `exitCpuOf` (an exit.json without
  `cpu` reads null); the three fields then become required.
- The `read-denied` outcome (gate and plan-check `STAGE_OUTCOME_KINDS`, its two `retry('read-denied', 'env')` rows in
  src/pipeline/transitions.ts and their rows in test/transitions.test.ts) and `NeedsUserReason` `read-denied`, once no
  arc started on 1.0.0-dev.11 is in flight: nothing records them since 1.0.0-dev.12 (the judge's read surface widened to
  the repository and the run dir; a refused read voids nothing), kept so a dev.11 log whose latest judgment outcome is
  one still folds and retries.
- `buildFinalDefault` (src/core/upgrade.ts), once no build an executor before the report rule (2026-10-11) launched is
  unconsumed: a build answer without `final` reads as final. With it, `final` becomes required in `buildOutputFor`.
- `planCheckScopeGrowthDefault` (src/core/upgrade.ts), once no plan-check call an executor before scope growth
  (2026-10-15) launched is unconsumed: a plan-check answer without `scopeGrowth` reads as none proposed. With it,
  `scopeGrowth` becomes required in `planCheckOutput`.
- `laneTestPathsUndeclared` and `witnessFilesUndeclared` (src/core/upgrade.ts) with Phase-0 row 11's undeclared arm
  (src/phase0/rows.ts `witnessDefects`), once no arc started on 1.0.0-dev.10 is in flight: obligations that declare no
  witness files read as undeclared. With them, `testPaths` and `files` become required in the readers. Until then the
  arm is per lane and per witness (2026-10-21; 1.0.0-dev.16), so an apply on an arc started on dev.11 or later that adds a
  witness without `files` is warned, not refused (no record says which release started an arc).
- `PRE_DEV10_BUILTIN_SEATS` (src/core/upgrade.ts) and its place in `EARLIER_BUILTIN_SEATS`, once no arc started on
  1.0.0-dev.9 is in flight: the built-in seats before the efficient class took the low-risk judgments (2026-10-15), kept
  only so `status` joins an earlier executor's recorded routing revs (`earlierRevAliases`, src/status.ts).
- `PRE_DEV12_BUILTIN_SEATS` (src/core/upgrade.ts) and its place in `EARLIER_BUILTIN_SEATS`, once no arc started on
  1.0.0-dev.11 is in flight: the built-in seats before the gate risk ladder (dev.10 and dev.11's). With both gone,
  `EARLIER_BUILTIN_SEATS`, status's `earlierRevAliases` and `resolveRoutingUnder` (src/routing/layers.ts) go too.
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
