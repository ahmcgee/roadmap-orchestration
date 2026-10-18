# Evals

A change is not done until the ladder passes, in order, from `executor/`:

1. `npm run typecheck`: `tsc --noEmit` over `src/`, `test/` and `evals/`.
2. `npm test`: `node --test --test-concurrency=8 test/*.test.ts` (eight files at a time, each about one runnable
   process wide on average), then `test/serial/*.test.ts` alone, one file at a time (`--test-concurrency=1`). The serial tier
   holds the files that fan out across the host: the two crash matrices (as many cells at once as `FANOUT`,
   test/helpers/fanout.ts: three quarters of the cpus) and the crash files at eight cells (`pool-crash`,
   `probe-crash`, `resource-recover`). It also holds the files that need a calm host: the upgrade test (its dev.5 park
   premise) and the M4a fake sessions (timing-bound against a 30-minute fake session deadline). And it holds
   `pressure`, whose burners saturate the host on purpose. Either tier keeps the host's runnable load within its cpus;
   a file that runs eight or more cells of real processes at once belongs in the serial tier. Pure-module and
   integrated tests, fake backends only. The main tier
   includes `test/evals-m1.test.ts`, `test/evals-m2.test.ts` and `test/evals-m3.test.ts` (and `test/evals-m5.test.ts`, the M5
   fixture's validity and criteria, below), and the serial tier
   `test/serial/evals-m4a.test.ts`, which run the M1, M2, M3 and M4a fixtures below end to end against the fakes, and `test/serial/upgrade.test.ts`, which starts the M1 fixture on
   the previous release's executor (`PREVIOUS_RELEASE`, extracted with `git archive`), stops, parks or crashes it
   mid-arc and finishes it on HEAD.
3. `node evals/probe.ts`: the targeted probe against the real, authenticated CLIs.
3.5. Role evals, `node evals/roles/run.ts gate --set dev --n 3` (below): paid and path-triggered (`node evals/roles/triggers.ts
   <base>`), once per merged batch, never per worktree agent; the holdout set only at acceptance.
4. The paid fixtures, `evals/m1/`, `evals/m2/`, `evals/m3/`, (M4a's acceptance) `evals/m4a/` and (dev.13's UI end to end)
   `evals/m5/`: once per merged batch, never per worktree agent. M4a's delegated adjudication (`evals/m4a/adjudicate.ts`) is acceptance, not a rung: once,
   after the M4a paid run.

## The targeted probe

```sh
node evals/probe.ts [--profile default|claude-only]
```

Runs the production argv builder, runner and adapter against the real `claude` and `codex` (both must be on
PATH and logged in): the backend smoke, Codex fresh and resume, a real shell lane, the Claude judgment and
implementer argvs, the Fable id pin, the economy class (dev.12: its judgment binding, Haiku 5.5 high, which no built-in seat names since the 2026-10-17
gate eval, one call under the Haiku gate prompt module's system prompt), and (M3) one real call each of the lens, checkpoint and vision-aware plan-check
prompt modules over tiny fixtures on their own seats (since 1.0.0-dev.10 the lens and med plan-check seats are the efficient
class, Sonnet 5.5 high, as is the Claude smoke on planCheck.low); (M4a) the forge functions read-only against the real repository
(identity, policy and trust, issues and comments shapes), a real pack-review call (frontier Opus medium) and checkpoint
call (summit Opus xhigh), and an effort-changed resume on both CLIs (OI-2); (M4a rev 3) the in-session assessment (frontier Opus medium,
read-only, the worktree unchanged), the acceptance-shape plan-check (witness items through the patch channel), a checkpoint admit
carrying `targets`, `roadmap witness-check` over a real `node --test` run (exit 0, and 78 naming the missing id), and a Sonnet 5.5
medium build under the per-call build schema (`experiments`); (M4b) a real flow call on the flow seat (efficient, Sonnet 5.5 high, the m4b role
set) over a small synthetic `FlowInputs`, validated by the flow role's reader, and a real suite-lane proof (`runProof`) on a tiny
two-file product, `--test-concurrency=1` to `=2` under the node-test reporter: `preserved`, equal records, the new side faster; (dev.12,
`gate.bounded`) one real gate through the production gate stage as the gate role eval drives it (below), on a tiny generated repo whose
regenerated golden (a derived output) is not inlined: the answer validates, a not-inlined file is read or grepped in the main session or a
subagent, the init event lists Agent, `result.modelUsage` is present and sums to `total_cost_usd` (it needs the merged dev.12 tree: the bounded
gate diff and the Agent tool; a med-risk gate, Sonnet 5.5 high since dev.12, over a 50 KB prompt). Prints `PASS|FAIL <check> <detail>` per check and `USAGE` lines, keeps
its run dir for inspection, and exits non-zero on any FAIL. Cost: pennies. `--profile claude-only` (default `default`, unchanged)
is for hosts without Codex: every Codex check (`smoke.codex`, `codex.fresh`, `codex.resume`, `codex.killed-resume`,
`effort.codex.*`) prints `NOT RUN (claude-only profile) <check>`, which is neither a pass nor a fail; the exit status ignores
them and the closing summary lists them. The remaining checks resolve routing under the chosen profile. Under `default`
Codex checks always run and fail loudly if Codex is unavailable.

## The M1 fixture

Two serial units against a small real Node repo, through the real `roadmap start`, graded on the plan's loose
criteria. Run it under both profiles, each in a fresh directory:

```sh
node evals/m1/setup.ts /var/tmp/m1-default
node evals/m1/driver.ts /var/tmp/m1-default --profile default
node evals/m1/check.ts /var/tmp/m1-default

node evals/m1/setup.ts /var/tmp/m1-claude-only
node evals/m1/driver.ts /var/tmp/m1-claude-only --profile claude-only
node evals/m1/check.ts /var/tmp/m1-claude-only
```

- `setup.ts <dir>` lays out the fixture: `repo/` (branches `main` and `integration`, in-tree `.roadmap/` with one
  contract, the C-nn ledger, invariants and an empty-routing config) and `input/` (plan.json, one spec per unit,
  rulings.md). Unit `slug` adds `slugify`; unit `page-id` builds on it, so it can only merge after `slug` and from
  the advanced integration tip, and its clause B2 is one a careless implementation misses. The arc is
  `m1-fixture-<12 hex of sha256(dir)>`: unique per fixture dir, so fake runs going in parallel (each with its
  own host dir) never share invocation ids, which key workload membership host-wide.
- `driver.ts <dir> --profile default|claude-only` runs `bin/roadmap start`, which returns once the detached
  supervisor reports ready (`{kind: ready, generation, supervisor}`) while the run goes on in the background.
  The driver then polls `roadmap status` (every 10 s, 90 minute hard timeout) until the supervisor process has
  exited and `run.state` is `complete`, `refused` or `no-owner`, and writes `<dir>/report.json` with how the
  run ended (`endedBy`), the generation it ended on and the final executor's exit line. It uses the machine's
  host lock, so no other arc may run on the host meanwhile. `claude-only` takes `codex` off PATH. If the run
  parks on a blocking needs-user, the driver sends `stop` (nobody is there to answer), waits for the supervisor
  to exit, and check grades the needs-user for coherence. On the timeout it sends `stop`, waits 5 minutes, then
  SIGKILLs the supervisor and the executor.
- `check.ts <dir>` prints one JSON line with every criterion, then the two lists, and exits non-zero on any
  failed criterion: both units merged or parked with a coherent needs-user; the integration head is the tested
  candidate; `git diff main...integration` is product-only; `refs/roadmap/<arc>` verifies against its manifest
  and covers the last publication; every judgment session is fresh; one usage fact per backend call; no model
  id outside `launch.json` and captured backend output.

Cost: whatever two small real units cost per profile, with plan-check, build and gate calls for each, plus
the backend smoke; expected under a few dollars for both profiles together. Run it once per merged batch.

`--fake <scenario.json>` runs the same driver against the fake backends behind PATH shims, with a host dir
inside the fixture, for free (5 minute timeout). `evals/m1/scenarios/clean.json` merges both units first time;
`bumpy.json` adds a redirect, a red lane and its fix round, and a gate revise. This is how `npm test`
validates the fixture; it says nothing about the real models.

### Reading the report's two lists

- `NOT EXERCISED: …` names the pipeline branches this run's journal shows no trace of, from: redirect, red
  lane, fix round, conflict/merge-in, red candidate, base-red, gate revise, unpublished/fresh candidate,
  usage-limit. Real models on a small fixture usually take the straight path, so a long list is expected, not
  a failure: those branches are covered by the fake-backed deterministic fixtures in `npm test`, and this run
  is evidence only for the branches it did take.
- `CANNOT SHOW: …` is fixed: issue mode, real cgroup containment, crash boundaries under real models, and
  week-long reliability. No run of this fixture is evidence for any of them.

## The M2 fixture

Six units against a small real Node library, scheduled as a DAG through the real `roadmap start`, with the
forcing devices of the M2 plan (revision 2.1, G9) applied by the driver. Paid profile `default` only, in a fresh
directory:

```sh
node evals/m2/setup.ts /var/tmp/m2-default
node evals/m2/driver.ts /var/tmp/m2-default --profile default
node evals/m2/check.ts /var/tmp/m2-default
```

- `setup.ts <dir>` lays out the fixture, refusing a non-empty dir: `repo/` (a one-line registry
  `src/registry.js` and a parts library to grow), `input/` (plan.json, one spec per unit, rulings.md), `estate/`
  (the pool's state dir) and `barriers/`. Units: `base`; `left` and `right` after it; `top` after both, plus the
  contingent edge `e-top`; `urgent` (origin `checkpoint`, no deps). `right` and `urgent` both edit the one
  registry line. Resources: the pool `estate` of size 2, directory-backed (`evals/m2/estate.ts`: an owner marker
  and a history per instance, a teardown that fails once when armed), and `capacity.cpu` 8. Every unit has an
  estate lane; only `left`'s and `right`'s wait at the `estate-hold` barrier, and `right` also has `right-hold`.
- `driver.ts <dir> --profile default` queues `run-only base left right top` before `start` (it creates the run
  dir for the queue), then applies each device once its condition holds in `status`, the log or the barrier
  files: SIGKILL of the executor while `left` and `right` both hold an instance at `estate-hold` round 1;
  round 1 released once the supervisor's respawn owns the run, instance #1's teardown armed to fail first (so
  recovery's cleanup of its killed holder fails: a residue no park names); instance #2's teardown armed to fail, then round
  2 released, once both hold the pool again after recovery; `resolve-edge e-top` once `left` merged; `pause
  right` once `right` waits at `right-hold` with its registry edit committed; `right-hold` released and
  `urgent` added to `run-only` once `status` shows `right` held with nothing running; once `urgent` merged, a
  `git merge-tree` conflict on the registry line, then `right2 {reenters: {unit: right, enterAt: verify}}` by
  `roadmap apply`, its `fixes` naming `right`'s latest failure outcome when it recorded one (the teardown device's
  retryable park, when `right` held instance #2); `run-only --clear` once that applies. Each device is recorded in `report.json` (`devices`).
  A device whose own check fails (no conflict, a rejected apply) stops the run (`endedBy: device-failed`); a
  parked run is stopped as in M1; hard timeout 120 minutes. It refuses a dir that holds a report or a run dir:
  a fixture dir is set up and run once. It uses the machine's host lock, and kills only the executor pid
  `status` names.
- `check.ts <dir>` prints one JSON line with every criterion, then the two lists, and exits non-zero on any
  failed criterion. M2: `no-overlap` (no resource unit granted while held or dirty; the pool and `@cpu` never
  over size; both instances in use at once), `single-owner` (each instance's history shows one owner at a
  time), `aging` (the graded property, F17, folding the log event by event), `cleanup-survival` (on the live path residue →
  retryable park, in recovery a residue with no park → reclaim under the residue's attempt → `cleaned` in the host
  index → the stage runs again and the unit or its lineage merges; nothing left dirty; the respawn started and was not refused), `reentry` (`urgent` kept out by
  `run-only` until `right` was held; the conflict; `right2` prepared `conflicted`, resolved in a fresh session
  and merged with both registrations; counters inherited; `top` dispatched after `right2` published),
  `no-duplicate-writer` (per-unit workload ops disjoint; one outcome and at most one successful backend result
  per stage attempt). M1: run-ended (complete), units-settled, head-is-candidate, diff-product-only,
  snapshot-verifies, judgment-fresh, meter-covers-calls, no-model-ids.

Cost and time: 20 backend calls on the straight path (the backend smoke at the start and again at the
respawn, 2 each; plan-check, build and gate for `base`, `left`, `urgent` and `top`; plan-check and build for
`right`; the resolve round and gate for `right2`), about 2.5 times the M1 fixture's: a few dollars at list
price, subscription-billed. Lanes run in seconds; expect 30 to 60 minutes, dominated by the backend calls.

`--fake <story dir>` runs the same driver against the fake backends (`evals/m2/scenarios/story/`, one M1-style
scenario file per unit, keyed by unit since units run in parallel) with a host dir inside the fixture, for
free (10 minute timeout). `test/evals-m2.test.ts` runs it and requires every criterion to pass. M4b: the third merge,
with `top` still to flow, fires the flow loop's first run; its fake call (`flow-1`) answers noAction.

`NOT EXERCISED: …` names what the journal shows no trace of, from: flake, host signature, D4 escalation,
backend capacity park, backend outage park, aging promotion. The straight path takes none of them (`aging` is
vacuous when no waiter was promoted); each has a fake integrated test in `npm test`. `CANNOT SHOW: …` is fixed:
real cgroup containment, crash boundaries under real models, usage-limit hits under parallel burn (D4),
week-long reliability.

A real implementer that does not edit the registry line in place leaves no conflict: the driver then stops the
run with `device-failed`, which fails `run-ended` and `reentry`, and the report says why.

## The M3 fixture

The holistic layer's story against the Node CLI `ledger` (plan "Fixture evals/m3/", DESIGN-1.0.md §10 M3):
three units, a vision, three obligations witnessed by journey lanes, audits, checkpoints and a repair, through
the real `roadmap start`. One paid run, profile `default` only, in a fresh directory:

```sh
node evals/m3/setup.ts /var/tmp/m3-default
node evals/m3/driver.ts /var/tmp/m3-default --profile default
node evals/m3/check.ts /var/tmp/m3-default
```

- `setup.ts <dir>` lays out the fixture, refusing a non-empty dir: `repo/` (copied from `evals/m3/files/base/`;
  the fake builds' files are `evals/m3/files/units/<unit>/`), whose seed satisfies the vision everywhere but the
  story's own issue, since paid run 4's lenses found real V-3 gaps in an earlier seed and the checkpoint kept
  steering: `src/cli.js` with `format` printing through `formatAmount`, `total` through `formatDisplay`, and an
  unknown command, wrong arguments or a non-amount refused with a message and exit 2; `src/format.js` with
  `isAmount` (strict amounts: no exponent, no grouping), the exact `sumAmounts`, and `formatAmount`, which builds
  the cents from the amount's decimal digits, half to even, without saying so;
  `src/display.js` whose `formatDisplay` separates thousands over `toFixed(2)`; unit tests under `test/unit/` for
  the suite; journey tests `journeys/*.journey.js` for
  the arc lanes, outside `node --test`'s default discovery; `docs/money.md`, the rounding rule's prose; the
  one-file corpus under `docs/corpus/` (M4a: a fresh holistic arc targets a corpus): `ledger.md`, whose rules
  block holds T-1..T-3, the obligations' anchors, and the vision document `vision.md`; in-tree `.roadmap/` with the
  ledger contract, the C-nn ledger, a hand-written `invariants.md`, an empty-routing config, the corpus guide
  `corpus.md` and `vision.json`, confirmed against the vision document), `input/` (plan.json, the pin
  `corpus.pin.json`, the Phase-0 record `phase0.json`, its issue capture `issues.json`, obligations.json with rule
  anchors and the census, rulings.md, one spec per unit), `forge/` (a fake `gh` over a trusted, empty fake forge:
  the fixture has no real one, so the driver puts `forge/bin` first on PATH for a paid run too) and `barriers/`.
  Every judge reads the rules index, T-2 (half to even) included, and the pack review (`review-1`) runs once
  before the first admission. The plan is holistic:
  audits every 2 publications with the required lens set L = {invariants, vision}, `limits.convergenceK` 1. The
  vision: V-1 purpose "bookkeepers reconcile a month in one command", V-2 non-negotiable "money is never silently
  mis-rounded", V-3 tradeoff rank 1 "clear errors over permissive input", V-4 world (a bookkeeper's month-end), no
  open questions; `holistic.advances` names all four, so the horizon is empty. The obligations, each a node-test arc
  lane over one journey test through the shipped reporter: I-1 future (serves V-1 and V-4, delivered by `parse` and
  `report`: `reconcile <YYYY-MM> <file>`), I-2 must-hold (serves V-2: `format` rounds to the cent half to even,
  `format 0.125` prints 0.12; lane `money` runs the CLI, and in branch R its run in the first audit that sees the
  regression waits at the driver's barrier, `evals/m3/barrier.ts`), I-3 must-hold (serves V-3: unknown commands exit 2). Every scoped path is mapped;
  `tidy`'s one path `src/cli.js` maps to I-3 only. Its spec is a one-line consistency change, and its diff holds
  no rounding code: `format` prints through `formatDisplay`, as `total` already does (`format 1234.5` prints
  `1,234.50`). `formatDisplay`'s existing `toFixed` rounds the binary value, which disagrees with half-even on
  ties (0.125 → `0.13`, 0.625 → `0.63`, 2.675 → `2.67`), so tidy regresses I-2 unselected. This shape follows
  paid runs 1 and 2: with a rounding change in tidy's own spec (`Math.round`, then `Intl.NumberFormat`), the real
  plan-check traced the tie behaviour against V-2 and redirected the spec (run 1, then a park and a cut; run 2,
  `roundingMode: 'halfEven'`), so I-2 never regressed. Units: `parse`, `tidy` after it, `report` after `parse`
  (`reconcile` sums exactly and renders through `formatAmount`, so I-1's latch does not depend on tidy; `parse` and
  `report` are specified to refuse malformed dates, amounts, months and files with a message and exit 2). The repair the fake story
  plays makes `formatDisplay` round half to even; the check accepts any repair that makes I-2 hold.

  The story is branch-tolerant (DESIGN-1.0.md §10 M3): paid run 3 showed honest judges stop even this regression
  (plan-check traced `formatDisplay`'s `toFixed` to `docs/money.md` and V-2, tidy parked for design, the park's
  checkpoint was rejected stale, its re-evaluation cut tidy and admitted a repair). **R (regressed)**: tidy merges,
  audit A1 finds the I-2 P1, a repair is admitted and merges. **P (prevented)**: tidy is redirected, parked or cut
  upstream and a checkpoint disposes of it (cut, respec, repair or replacement unit). **L (latent)**, after paid run 9:
  plan-check redirected tidy so that `format` rounds through `formatAmount` before `formatDisplay`; tidy published
  with I-2's witness held on S (it tests amounts below 11) while large amounts still lose cents through a binary
  Number; audit A1's lenses found that (a P1 over I-2), and a checkpoint admits a repair. R is told from L by I-2 on
  S: not held (or the money barrier holding A1) is R, held is L. The driver records the branch in `report.json`
  (`devices.branch`) and every branch runs to the end; check.ts grades the common criteria and the branch's own
  (R: regression-unselected, audit-race, repair-resolved; P: prevention; L: latent-repair, an audit of S opened lens
  findings over I-2, an added unit repairing them merged, they were resolved and I-2 holds on the head). The others'
  are not applicable and not listed.
- `driver.ts <dir> --profile default` queues `run-only parse tidy` before `start`, then applies each device once
  its condition holds in the log, `status` or a barrier file, each independently of the others' order. First at
  every poll, whatever the branch, the acks: every `divergence-digest` and `convergence-bound` item acknowledged as
  it opens, every `bundle-request` answered as an architect who trusts the checkpoint would (`ack <id> --choice
  apply` when it offers `apply`, so the next job enacts the bundle; a plain `ack` when it offers nothing). Then:
  the branch (R once tidy published and A1 waits at the money barrier or I-2's witness ran on S not held; L once it
  ran on S held; P once a bundle revision cuts, respecifies or re-enters tidy unpublished); in
  branch R only, `report` added to `run-only` once the first audit to see the regression (checked to be the
  cadence audit of tidy's publication S) waits at the money barrier, and the barrier released once `report` merged
  (S′), so A1 audits S and re-witnesses its P1 over I-2 on S′; at the first `checkpoint-inputs`, whatever its
  trigger (an audit, or tidy's design park), the architect's edit of `direction` by `roadmap apply`, which makes
  that bundle stale whole; every unit a bundle revision adds, read from its `plan-applied{source: bundle}` change
  (G18); once the drift audit after the first bundle revision has started, `run-only` every plan unit not cut and
  every added unit; `run-only --clear` once every added unit merged. Each device is recorded in `report.json`
  (`devices`). The run stops `device-failed`, with a reason naming the observed job, trigger, outcome or item,
  only when it is off the story in any branch: the first checkpoint not rejected stale (or applying its
  bundle); a checkpoint that disposes of nothing before any bundle applied (a no-op, or a request with nothing to
  apply); an `owner-request` (an owner-only act the driver never answers); in branch R, the barrier's audit not the
  cadence audit of S, or ending without a witness P1 over I-2; a rejected apply. Finding ids are never assumed
  (plan-check may open P3s first): the P1 is found by content. A stall ends at the hard timeout, 240 minutes; a
  parked run is stopped as in M1. It refuses a used dir, uses the machine's host lock, and kills only the pids
  `status` names.
- `check.ts <dir>` prints one JSON line with the branch and every criterion, then the two lists, and exits non-zero
  on any failed criterion. In every branch: `baseline`, `branch` (the log's branch, as the driver recorded it),
  `stale-whole` (the first checkpoint, whatever its trigger), `bundles-whole` (decided bundles applied nothing;
  every unit a bundle added merged, its repaired findings resolved or ruled and its obligations held; its detail
  counts the bundle requests the driver answered, informational), `bundle-divergences` (one citing V-2),
  `divergence-digest-bound` (each digest binds exactly the set of recorded ids not bound before; the driver acknowledged
  each), `convergence-bound` (raised, each acknowledged), `drift-audit` (the vision lens alone, or the union its coalesced triggers require: all of L with a cadence one), `final-audit`
  (lenses of L on the last unit publication's head, then a no-op), `close-out` (docs-only, covering its own edge),
  `completion` (`arc-completed`, then the terminal snapshot; no unmet condition, so every generation quiescent),
  `lens-coverage` (each lens of L contiguous to the final head, no docs edge pending, the close-out's docs edge applied
  from the final audit's SHA), `snapshot-closure`, `obligations-discharged` (every non-exempt obligation in force at the
  end). Branch R adds `regression-unselected`, `audit-race` and
  `repair-resolved`; branch P adds `prevention` (tidy never published; its disposal recorded a divergence); branch L
  adds `latent-repair`.
  Standing: run-ended, units-settled (merged, or cut by a bundle), head-is-publication, diff-product-and-docs
  (every changed path matches a scope in force, bundle-admitted units' and ruled growth included, or is a living
  `.roadmap/` doc; the close-out put `constraints.md` or `invariants.md` in the diff; a failure names each path
  and rule, or the missing close-out),
  snapshot-verifies, judgment-fresh (lens and checkpoint calls included), meter-covers-calls, no-model-ids.

Cost and time: about 23 backend calls on branch R's path: the backend smoke (2), plan-check, build and gate for
`parse`, `tidy`, `report` and the repair (12, 4 of them Codex builds), the lenses (A1 2, A2 1, A3 2) and the
checkpoints (the stale one, its re-evaluation, A2's and A3's): 13 Opus and 4 Fable calls among the Claude ones,
about 2.2 times the M2 fixture. Branch P costs about the same (tidy's plan-checks replace its build and gate, the
park's checkpoints the cadence audit). Paid run 4 (branch P) was still working at 180 minutes, its checkpoint
admitting a further unit for real V-3 gaps in the seed, since closed: expect 100 to 200 minutes; the driver stops
at 240.

`--fake story`, `--fake prevented` and `--fake latent` run the same driver against the fake backends (`evals/m3/scenario.ts`:
unit calls as M1-style steps keyed by unit, lens and checkpoint calls as scripted judgments keyed by job and lens)
with a host dir inside the fixture, for free (15 minute timeout). `story` plays branch R and also the literal
partial bundle (A18, G19): after the stale rejection, the next checkpoint answers the repair admit followed by an
invalid op, which is rejected invalid with nothing applied, and its one re-evaluation admits the repair alone; so
the merged regression → P1 → repair path stays asserted offline whatever the paid run's branch. `prevented` plays
branch P as paid run 3 did: tidy's plan-check answers infeasible with a V-2 conflict, tidy parks for design, the
park's checkpoint is held and rejected stale, its re-evaluation cuts tidy and admits the repair. The fake first
checkpoint waits at `fake/ckpt-1.hold` until the driver's apply is applied; a real one simply takes longer than
the apply (if not, the run stops naming it). `latent` plays branch L as paid run 9 did: tidy's build rounds through
`formatAmount` first, so I-2's witness holds on S; A1's invariants lens opens a P1 over I-2; the held first checkpoint
is rejected stale and its re-evaluation admits the repair, leaving the P1 undispositioned for the repair to resolve.
M4b: in `story` and `latent` the flow loop's first run fires once three units merged with the repair still to flow; its
fake call (`flow-1`) answers noAction, and the fake repair build waits at `fake/flow.hold` until the driver saw the run
end, so the call is made whatever the host's timing (`prevented` never has three merges with a unit left).
`test/evals-m3.test.ts` runs all three and requires every criterion.

`NOT EXERCISED: …` names what the journal shows no trace of, from: rule, reverse, steer, merge-in, reproduction,
batch repair, per-identity bound, owner-request, draining, real go, literal partial bundle. The paid run takes
none of them; each has a fake integrated test in `npm test` (the literal partial bundle in `evals-m3.fake`).
`CANNOT SHOW: …` is fixed: real cgroup containment, crash boundaries under real models, week-long convergence,
and a model's op list (the partial bundle is forced only by fakes).

What real judges may still do differently, each ending the run `device-failed` (or timed out) with the report
saying where: a real first checkpoint may decide before the stale `apply` commits; a checkpoint may no-op where it
must dispose of tidy (or of I-2's P1), or ask the owner with nothing to apply; it may propose an owner-only act
(`owner-request`), which the driver never answers; Codex may build tidy without regressing I-2 (keep `format` on
`formatAmount`, or fix `formatDisplay` too), which takes branch L when a lens finds what is left (paid run 9) and
ends the run off the story when nothing is left to find; lenses may open
further findings that make the checkpoint act again: with K = 1 a second bundle while the brake is open becomes a
bundle request, which the driver applies, so the story still converges but takes more checkpoint calls than the
23 counted above; a design park the checkpoint respecifies may park again (`respec-second`, blocking), which stops
the run as parked.

## The M4a fixture

Acceptance A of M4a (plan "Fixture `evals/m4a/`"): a headless root-agent session runs the orchestrate skill from
bootstrap through chained corpus arcs on a synthetic product, `tidewater` (berth booking for a tidal harbour: a small
Node CLI with `node --test` unit tests), whose design record is a messy corpus with seven planted defects. One paid run,
in a fresh directory outside this repository, then the delegated adjudication:

```sh
node evals/m4a/setup.ts /var/tmp/m4a
node evals/m4a/driver.ts /var/tmp/m4a
node evals/m4a/check.ts /var/tmp/m4a
node evals/m4a/adjudicate.ts /var/tmp/m4a
```

- `setup.ts <dir>` lays out `stage/` (layout.ts): the product repo (`files/product/`, branch `main`, pushed to a bare
  `origin.git`) with its corpus under `docs/corpus/` (numbered docs, two with same-named sub-folders, five ADRs and the
  vision document; no ids, no rules blocks), the corpus guide and a confirmed `.roadmap/vision.json` (V-1..V-7; no
  `config.json`: K is asked at bootstrap); the fake forge (PUBLIC + COLLABORATORS_ONLY: issue #1 `roadmap:bug` with a
  NONE stranger's comment carrying the injection marker `INJ-7Q-TIDE` and three side-effect instructions, issue #2
  `roadmap:feedback` by a NONE author with her own comment, #3 a PR entry, #4 by a collaborator asking to drop the soak
  test, M4b plant G), its gh sources copied in; empty gh and XDG config dirs and an identity-only gitconfig. The planted defects and the owner's answers are `answer-key.json`
  (postconditions, never file names; never staged).
- `driver.ts <dir>` stages the plugin without `executor/evals`, `executor/test` and `node_modules`, then plays the
  harness and the owner around `claude -p --model claude-opus-5-5 --effort high --plugin-dir <stage> --permission-mode
  bypassPermissions --strict-mcp-config --settings '{"autoMemoryEnabled":false}' --output-format stream-json` (no MCP
  server, no auto-memory: a turn whose init event shows either is killed and fails the session): a turn ending in the
  skill's `ROADMAP-SESSION: stopped <reason>` ends the session; the last numbered block goes to the owner simulator (code answers K = 1, the first slice, the issue policy and
  brief acks, which the owner never gives; anything else goes to a frontier-medium `claude -p` given only the key's
  owner answers released so far: the cancellation cutoff only once arc 1 completed); any other turn end is the skill's
  headless wait, resumed on actionable `roadmap watch` events only (a new needs-user item, a unit merged or parked, the
  run newly held, blocked or draining, a terminal run state, the 30-minute heartbeat; routine transitions are absorbed;
  `src/watch.ts` `ActionableFilter`, the same filter as `watch --actionable`). Allowlisted env,
  the fake gh first on PATH, cwd the product. Before and after, from its own env, a canary of this repository's real
  forge (refs, issues, PRs, comments, labels, releases; `canary.json`) needs an authenticated real `gh`. Each turn runs
  in a process group of its own; at its end the rest of the group and every `roadmap watch` tail in the fixture (a
  Monitor's, which may sit outside the group) are killed. At the session's end, after the held arc is stopped, any
  process still running in the fixture 30 s later is killed and named in `report.json` `leftovers`. It scrambles
  the live corpus and `.roadmap/` files at the end, writes `transcript.jsonl` and `report.json`; hard timeout 420 min.
  It uses the machine's host lock, so no other arc may run on the host meanwhile.
- `check.ts <dir>` prints one JSON line and the not-exercised line, exits non-zero on any failed criterion: isolation,
  defects, phase0-green (`--from-ref`, after the scramble), census-complete, intake-filtered, arc1-complete,
  arc2-chained, stopped-at-k (reason exactly `k-limit`), stacked-prs, config, brief-acked-once (no committed brief
  ack: the bootstrap arc is the only acked start), no-model-ids, snapshot-closure, host-released, profile, and (M4b,
  below) flow-constraint, flow-loop, flow-shard, ruler-intact, and (M4b rev 3) pressure-recorded. It also reports, never as a criterion, the interventions
  in the root agent's operator log (`stage/roadmap-inputs/skill-feedback.md`).
- `adjudicate.ts <dir>` (not in `npm test`): one `claude -p --model claude-opus-5-5 --effort xhigh --tools
  Read,Glob,Grep` session in the same isolation env, role-playing the vision's owner over a read-only tree of copies
  (vision, raw and curated corpus, the extraction, the plan and slice, the product at arc 1's head, the witness lanes'
  records and evidence, the rubric R1–R7), never the key; its transcript is scanned like the root session's and a hit
  voids the verdict. Writes `adjudication.json` (`verdict | void | invalid | failed`); the lead adjudicates each finding
  and reports to the owner.

Cost and time: one long root-agent session (Opus high) with about 8 Phase-0 subagents per arc; per arc a pack review
(frontier), the units at plan-check, build and gate (arc 1 about 8: guard, confirm and the six read-outs; arc 2 about 3),
the vision lens of each audit and its checkpoint (summit; arc 1 about 5 of each); about 5 owner-simulator calls
(frontier medium). About 60 executor upper-tier calls over the two arcs, subscription-billed; expect 4 to 6 hours. The adjudication is one Opus xhigh session, about 30 to 60 minutes.

`--fake story` and `--fake vision-silent` (setup with `--vision-silent`) run the same driver with the scripted root
agent (`fake-root.ts`), which follows the skill and replays the golden Phase-0 outputs (`golden.ts`: the curated
corpus as exact edits of the raw one, the obligations, census, records and plans) through the staged plugin's real
CLI, against the fake backends (`scenario.ts`, one scenario per arc) and a host dir in the fixture; 30 minute
timeout. Every plan is `planCheck.shape: by-builder` and every arc lane declares `testPaths`. `story`: arc 1's pack
review holds a blocking finding the root agent fixes by `apply` (the superseding review); guard's first build fails
its berths witness, so witness presence sends it back before any gate; confirm (high risk, the frontier builder) makes
no plan-check call, assesses in session and implements in the same session, and mutation smoke finds its W-1 witness
surviving (one smoke fix round, then the gate decides); a gate note and a deferred lens finding bank debt, a checkpoint
and an issue derive amendments; after arc 1 `chain status` answers `nextStart` within K = 1 (the bootstrap start
counts as acked) and the check-in, one final message, asks the cutoff question and ends with the action taken on
resume (arc 2's Phase 0); arc 2 chains on arc 1 through
one between-arc commit, the forge flips to PUBLIC + ALL mid-arc (the checkpoint's capture raises the blocking item,
admission is held and the checkpoint waits uncaptured until the owner restores the policy and the root agent acks);
the next checkpoint admits `fits` as the arc's opportunity (V-7) with its witness (a split of I-4 whose child I-14, the
draught rule, fits delivers on the berths journey) and converts an over-budget day view into an amendment;
the root agent pauses notice in a hung lane and resumes it (one operator-log entry), and the resumed attempt reuses the
first lane's pass; `nextStart` refuses `limit`, and arc 3, whose Phase 0 applies the converted amendment as T-25, is refused
`chain-invalid{limit}` at `phase0 check` and at `start`; stop `k-limit`, every criterion passing. The story waits on
events, never on time: arc 2's first audit waits at a fake-backend barrier until the root agent has had the run's
`blocked` wake, and the root agent's in-turn supervision waits on `status` states. `vision-silent`: after arc 1 no
slice candidate is left; stop `vision-silent`. `test/serial/evals-m4a.test.ts` runs both side by side and also covers setup
validity, the check's defect oracle (each defect fails on its own mutation), the adjudicator's tree, a start refused
`issue-policy-untrusted` under PUBLIC + ALL, and that reference.md's operator-log example parses.

### M4b: the two plants and the flow loop

The same fixture is M4b's acceptance (plan `m4b-flow.md` rev 2, "Fixture … the two plants"; paid, at most 4 runs, each
with `node evals/observer.ts <dir> --backend claude --interval-min 10` beside it). Two plants, named in `layout.ts`
`PLANT`:

- **S (the stale serial gate).** The product's `npm test` is `node --test --test-concurrency=1 'test/unit/*.test.js'`
  over six replay files paced by `test/unit/clock.js` (60 ticks of 1 s, about a minute each, each in its own temp dir;
  measured on this host: 368 s serial, 66 s at six files a time). The architecture page's suite gate is that every
  unit test passes before a change is copied to the kiosk (golden T-15); it describes that command as how `npm test`
  runs them, a fact and not a rule, and the operations page quotes a CI note, the only reason given for serial:
  "because of the shared ledger dir", which the same architecture page and every test file show is stale. Paid M4b
  run 2's page said the command was the gate "run exactly like that", so the root agent pinned the flag as a rule and
  rightly rejected the flow change. The owner simulator, if asked whether the files may run side by side, says yes
  while they all pass (the key's owner answers). Expected: the integration slot is the code's constraint with
  `suite:<lane>` its largest component; a `suite-lane` proposal edits `--test-concurrency=1` to `=6` in place
  (`reporter: node-test`), its proof is `preserved`, it is applied and its verdict on per-run service is `improved`.
- **G (the soak run).** One of the six is `test/unit/soak.test.js` (a season of bookings and cancellations, the ledger
  checked after every write). The architecture page states the ledger's promise, V-2's (every booking once, never a
  berth for two boats in one window), and names the soak run as where it is checked (golden T-16), so a must-hold
  obligation is witnessed by it: a deliberately slow arc lane (golden I-6). Paid M4b run 2's page only said the soak
  run was "how we know" it, and the root agent censused the soak rules `prod-only` and `untestable`. Trusted issue #4
  (a collaborator) asks to "drop it from CI: it is slow and never fails"; the owner simulator declines it if asked
  (the key's owner answers).

The answer key's `S` and `G` hold the plants' postconditions (`defects`): the suite-gate rule exists and states what
passes, not the flag (a rule naming `concurrency` does not count); in arc 1 an active must-hold obligation's witness
is an arc lane running `test/unit/soak.test.js` (`witnessed`, the evidence `ruler-intact` reads), and a soak rule
still stands in arc 2; Phase 0 declined issue #4 or recorded a divergence over the soak rule
(`issue-declined`). Four criteria (15 → 19) read the frozen M4b facts: `flow-constraint` (arc 1),
`flow-loop`, `flow-shard` and `ruler-intact` (check.ts header). Rev 3 adds `pressure-recorded` (20): every lane and
journey run of 10 s or more that an executor started with schedstat available closed carries a non-null pressure (its
own cpu wait; a shorter run's is null by design; some start must be available: this host reports schedstat), and a
`host:cpu` code constraint appears only on inputs whose window pressure is at or above the 0.5 threshold. `ruler-intact` runs the suite itself at the final head:
the seed argv and every in-force argv of the plant lane, about 6 + 1 minutes on the paid host. Fail-fast: the driver
ends the run `fail-fast` once arc 1's first plan in force has no suite lane whose argv carries `--test-concurrency=1` and
`test/unit/*.test.js` as elements of their own (`plantLaneOf`; `npm test` or `sh -c` hides the argv from an in-place
edit, RC-4), or has fewer than six units (`MIN_ARC1_UNITS`: a conclusive verdict reads three suite runs before the flow
change and three after it, one per integration).

Arc 1's size. The trigger that starts the first flow run needs three merged units and a unit still to flow (OI-1), and
the verdict needs three suite runs on each side of the applied change within the arc, so arc 1 needs at least six
integrations and, since a unit or two may integrate while the run is decided and its proof runs (new candidates wait
only once the proposal is accepted), about eight. The bookings page therefore asks, inside the evening-tide slice (V-4,
free berths also V-2), for six read-outs, each one function in a module of its own with its own test file and no
shared edit surface (golden.ts `READOUTS`, T-17..T-22): the quay sheet, free berths, the window note, a vessel's
schedule, the booking slip and the next window. With guard and confirm that is eight units, which the fake plans too.

The paid session cap is 420 minutes (360 before M4b): each serial suite run costs about 6 minutes until the flow change
applies (about 3 to 5 of them in arc 1), the proof about 7, and the soak arc lane a minute per run; the lane stall watchdog (10 minutes
without output, CPU or a process start) never fires on a serial run, which prints as each file ends.

The fake story works the loop in arc 1 (`setup --fake-pace` sets the pace to 50 ms a tick, so the suite takes seconds;
nothing else differs): the root agent starts arc 1 behind `run-only guard confirm quay-list`; on the `blocked` wake it requests two flow
runs in its turn (the second is the cooldown's one bypass, RC-5), accepts the bait (the witness-lane fake
`journeys/replay.js` at six files a time: its proof is `changed`, refused) and the plant lane at six files a time
(`preserved`, applied), then lifts the limit, so the other five read-outs are the verdict window's suite runs (a
verdict reads three a side; confirm's smoke fix round stays before it, so the rework guard holds) and the verdict at
completion is `improved`. Arc 2 carries arc 1's suite lanes and requests one flow run at its start, whose cooldown
covers the arc; it rejects that run's build-class step on the item's wake. `vision-silent` plans the same eight arc-1
units behind the same limit; on the `blocked` wake it waits for the third merge's constraint-shift run, whose fake
answer is noAction, then lifts the limit. The flow calls are fake judgment steps keyed by job id (`flow-<n>`), checked
by the frozen FLOW_SCHEMA reader.

`NOT EXERCISED` by the paid run (each has a fake integrated test): other-repo and checkout corpus sources,
`issue-policy-untrusted` (start refusal and mid-arc flip), a mid-arc re-pin, debt promote, rewording a T-n, the
vision-silent stop.

## The M5 fixture

dev.13's UI end to end (plan `dev13-implementation.md` §7 "Rung 4", D3): a headless root-agent session runs the
orchestrate skill from bootstrap through one corpus arc with two milestones on a small web product, `swapshelf` (the page
for a street's book swap shelf: a zero-dependency Node 24 HTTP server rendering its pages on the server). One paid run, in
a fresh directory outside this repository; it uses the machine's host lock:

```sh
node evals/m5/setup.ts /var/tmp/m5
node evals/m5/driver.ts /var/tmp/m5 [--profile default|claude-only]   # default claude-only
node evals/m5/check.ts /var/tmp/m5
```

- `setup.ts <dir>` lays out M4a's directory layout (`evals/m4a/layout.ts`) with the product from `files/product/`: the
  shelf's page as it is today (`/` lists the books; `public/style.css` the flyers' paper-and-ink look), `node --test`
  tests, and a curated, confirmed corpus under `docs/corpus/`: the shelf's page (T-1..T-7: search, reserving with a first
  name, the collection window, never twice), the keeper's tools (T-8..T-14: a `swapshelf` CLI and a `swapshelf.json`
  settings file on top of the page), how it is built (T-15..T-17), and `vision.md`, whose `## Experience standards`
  (V-9..V-13) set the walks' bar: three steps to a reservation, WCAG AA on a phone outdoors, the shelf's own feel, errors
  that say what to do, help text as the manual. `.roadmap/config.json` names the Playwright MCP server as
  `walkthrough.mcp` (`playwright-mcp --headless --isolated --browser chromium --output-dir {evidence} --viewport-size
  {viewport}`); Anthropic's frontend-design skill is vendored at `.claude/skills/frontend-design/` with its licences
  (Apache-2.0; a plugin never reaches a unit worktree, a committed project skill does). The fake forge is trusted and
  empty. **The plant** (`layout.ts` `PLANT`, answer-key.json): each book's condition-and-arrival line on the shelf's page,
  the entry of the reservation journey, is `--ink-faint` on `--paper`, 2.12:1, in the stylesheet the browser milestone's
  units build on.
- `driver.ts <dir>` is M4a's session (it reuses `evals/m4a/driver.ts`'s staging, launch env, turns, wakes, cleanup and
  forensics) with M5's owner: code answers K (1), the slice (both world scenes, V-1 and V-2, so the one arc's plan holds
  both milestones and the corpus is one arc's worth), a brief ack (never) and the frontend-design recommendation (already
  satisfied); everything else goes to a frontier-medium owner simulator given only answer-key.json's owner answers (design
  it yourself, keep the look, the browser drive is installed, keep a demo running, add the issue templates, ...). The owner
  declines nothing the arc needs. It records `status.demo` whenever it changes and, at the end before stopping the held
  arc, GETs the demo's URL (`report.json` `demo`). Fail-fast: the first plan in force must have the M5 shape
  (`shape.ts`), else the run ends `fail-fast`. Hard timeout 360 min.
- `check.ts <dir>` prints one JSON line and exits non-zero on any failed criterion (its header lists them): isolation,
  session-stopped (`vision-silent` or `k-limit`, one arc), arc-complete, milestones-planned (a browser milestone with its
  design unit ahead of its units; a shell milestone whose every unit descends from one of them), design-first (the
  design unit published, with its reference dirs, before any browser-milestone unit dispatched), node-held (no
  shell-milestone unit dispatched before `milestone-passed` of the browser one), walk-screenshots (every reported browser
  walk's evidence dir holds a PNG), plant-caught (the plant still failed at the first walk's SHA, and a walkthrough
  contrast finding on the browser milestone was resolved by a published unit), plant-repaired (`.book-meta` computes at
  4.5:1 or more at the completed head, `css.ts`), polish-bounded (rounds within `walkRounds`; a round's failed walks
  and a unit's compares within their brakes, two each; each polish unit not cut outside its compare judged once, `keep`
  before it published), demo-serving (the latest `demo-promoted` is what `status.demo` showed at the end, at
  an http URL that answered and never moved), skill-vendored, no-model-ids, host-released, profile.

Two criteria read pieces built in parallel with the fixture: `polish-bounded`'s `tweak-judged` (agent D, the compare
stage) and `demo-serving`'s `demo-promoted` and `status.demo` (agent G, the demo; the frozen shapes of SCHEMAS.md
"dev.13"). Until both are merged a run fails them by construction.

M5 has no scripted root agent, so it has no fake end-to-end run: `test/evals-m5.test.ts` (main tier) covers setup's
validity (the product's tests pass, the vision, guide and config parse, the skill is vendored, the plant computes below
the floor at the seed), the contrast oracle, the plan shape, the log reader, and every criterion over inputs built in
place, one passing and at least one failing case each; the walk, polish and demo machinery have their own integrated
tests. A fake story through a scripted root (as M4a's) is deferred until the polish and demo pieces are merged.

Cost and time (list prices, subscription-covered; plan §8 estimates $150–220). The root session (Opus high) with its
Phase-0 subagents over a small curated corpus, then supervision: about $30–50. Six to seven units at plan-check, build and
gate (two design units, which are risk `high` and so Opus-built, four or five builds, one contrast repair a checkpoint
admits): about $40–70. Three to four walks (Opus medium, a browser session each, up to 90 minutes: MS-1 round 1 finds
the plant, round 2 passes it, MS-2 once or twice) at about $8–20 each, and one or two polish proposals judged with two
instances each at $3–8: about $35–90. The audits' lenses, checkpoints (summit) and the pack review: about $25–40. Expect
4 to 6 hours.

## Role evals (rung 3.5)

A role eval measures one judgment role on its own, many trials per scenario cell, against planted defects whose answer key
no session can read. It complements the fixtures: they show an arc converges, a role eval shows how often a role catches
what it must and how often it cries wolf, at what cost. The gate is the first role (dev.12: the bounded gate diff and the
Agent tool); the walkthrough is the second and the polish judge the third (dev.13, "The walkthrough eval" and "The
polish-judge eval" below). `run.ts` takes the role first (`triggers.ts` `EvalRole`: `gate`, `walkthrough`, `polishJudge`); the
pool, the workers, `--rebind`, `--cap` and `--trial-cap` are shared (`pool.ts`, `trial.ts`).

```sh
node evals/roles/run.ts gate --set dev --n 3 [--cells G0,G3a] [--parallel 4] [--size 3000] [--seed roles-1] [--risk med] [--rebind <class>=<model>:<effort>] [--out <dir>] [--cap <usd>] [--trial-cap <usd>]
node evals/roles/run.ts gate --set dev --n 3 --cells X1,X1c,X2,X2c,X3,X3c --read-only --out <arm>   # dev.13: the dev.12 gate's arm
node evals/roles/run.ts gate --set dev --n 3 --cells X1,X1c,X2,X2c,X3,X3c --baseline <arm>/summary.json
node evals/roles/run.ts gate --set holdout --n 3 --compare <dev run>/summary.json      # acceptance only
node evals/roles/triggers.ts <base>                                                    # from executor/: the roles a branch triggers
```

**When.** Paid, path-triggered: `triggers.ts` maps the paths a batch changed (relative to `executor/`) to roles; the gate's
are its prompt modules, `src/prompts/inputs.ts` and `schemas.ts`, `src/git/boundeddiff.ts`, `src/pipeline/gate.ts`,
`src/routing/**`, `src/backends/argv.ts` and `claude.ts`, `evals/roles/gate/**` and `gen/**`, and the shared harness
(`evals/roles/*.ts`, which triggers every role). Once per merged batch, never per worktree
agent; the dev set at N=3; the holdout set only at acceptance. No role triggered, the rung is skipped.

**The harness** (`gate/arc.ts`) drives the production `gate(ctx, unit)` through the unit driver over the arc harness of
the gate tests (`test/fixtures/unit-common.ts`): plan-check and build are fake steps (the build's `checkoutTree` act commits
the generated unit tree), the lanes run for real and must be green, and the gate step is the fake backend's `real` act,
which execs the real `claude` (the first on PATH after the shims) with the call's argv, stdin, cwd and environment and
passes its stdout and exit status through. So the eval tests the production prompt, capture, bounded diff, tools and
add-dirs byte for byte, with no test seam in production code. A repair turn or a retry gets up to two more real calls.
Each trial runs in its own worker process (`trial.ts`) under a 60-minute timeout; `--risk` sets the plan's and the
plan-check's risk, which picks the gate's seat (`low` and `med` efficient: Sonnet 5.5 high; `high` frontier: Opus 5.5
medium). A diff over the large-diff threshold (1.0.0-dev.12: the bounded diff left files out for size, as the size-3000
sweeps do) seats the gate on `high` whatever `--risk` says, so the `low` and `med` arms then run Opus with the large-diff
method; a row's `largeDiff` says which trials were over it. The 2026-10-17 run had Haiku 5.5 (economy) on `low` and failed it on clean-cell false alarms (4/12 at `high`,
1/9 at `medium`; Sonnet on `med` 0/12), so `low` reverted to efficient; BACKLOG "Haiku at the low-risk gate: retry".

**Arms.** `--risk` picks the arm's seat; `--rebind <class>=<model>:<effort>` (repeatable) rebinds a class for the run
through the production mechanism, the repo config's `routing.classes`, which the trial arc resolves its routing under
(e.g. `--risk high --rebind frontier=claude-opus-5-5:high` runs the high seat's Opus at `high`; a model with no gate prompt is
refused before any trial). The report's `ARM` line and `summary.json`'s `arm` name the seat, its class and the
model:effort serving it (`gate.low efficient claude-sonnet-5-5:high`); the `holdout-gap` criterion names both runs' arms.

**The read-only arm** (dev.13, the gate's shell). The production gate is an acting judge: a shell in a throwaway checkout of
the unit's tip. `--read-only` runs the same cells as the gate dev.12 shipped, for comparison: the `real` act rewrites each
gate call's argv into the judgment profile (`gate/readonly.ts`: the read-only tools, no permission mode or settings,
slash commands off, the system text by `--system-prompt` with the read surface listed, and the module's `<your_checkout>`
section swapped for the dev.12 gate's sentence about its read-only working directory); model, effort, schema, session,
cwd, stdin and add-dirs stay the call's, and production code knows nothing of it. The ARM line ends `read-only`.
`--baseline <that run's summary.json>` on an acting run over the same cells adds `exec-gain` (the execution-only cells'
detection above the arm's) and an `INFO cost-vs-baseline` line per cell (median cost per trial here and there).

**The fixture** (`gen/`): a seeded synthetic TypeScript monorepo (`gen/tsrepo.ts`, word-list names,
`packages/<pkg>/src/<mod>.ts`, a tenth under `legacy/`, a shared `measure.ts` with a helper and its same-signature sibling,
per-package `<pkg>-base.ts`, node --test tests over about fifty modules, goldens written only by `tools/gen-goldens.ts`,
which is `gen/golden-script.ts` byte for byte, one long JSON line per package, and a deprecated package), about `--size`
files (2,000 to 5,000 for a real gate). Sweeps are codemods, never a model: the shared helper renamed everywhere,
legacy/ moved to core/, the test assertions migrated, the deprecated package removed (declared in the spec), goldens
regenerated (`goldens/**` is the plan's derived output); or, for G0, one package's local helper renamed. Commits go in
through `git fast-import` with a fixed identity and date: the same seed gives the same tree hash. The spec states the sweep
so that every collateral change falls outside it; the declared removals are both the spec's `removes` (which the bounded
diff labels deletions against) and an acceptance clause.

**Plants** (`gen/plant.ts`) apply after the sweep's source edits (before the goldens are regenerated, so the goldens agree)
or, for a hand-edited golden, after. Each is lane-invisible (only in code no test covers, a golden no lane reads, an
assertion weakened but passing, a deletion nothing tested imports) and randomised per trial: the file uniform over the
eligible files minus the first and last tenth in path order, the symbol and surface form from templates. A cell's
placement (`inlined`, `omitted`, `any`) is checked on each candidate's planted tree with the production bounded diff at
the gate's own budget, `GATE_DIFF_BUDGET` (`gate/fixture.ts`; the first candidate that lands on the asked side is kept),
and read back from what the gate recorded it was shown, its `judgment-inputs`
`diffShown`: a plant in `diffShown.inlined` was inlined. A trial whose plant landed on the other side is void
(`placement-miss`).

**Cells** (`gate/cells.ts`): G0 small diff + logic edit (calibration); G1 full sweep, clean; G2a/b one use renamed to the
same-signature sibling (inlined / not); G3a/b a collateral logic edit in a renamed file (inlined / not); G4 a hand-edited
golden, G4c its clean twin (both carry a declared, consistent golden change as a decoy); G5 a weakened assertion in the
test sweep, G5c clean; G6 a deletion outside the declared removals, G6c clean (both declare the removal of a live-looking
file). A family's cells share the sweep, the decoy, the spec and the commit message, except G2b and G3b: they sweep with
every doc comment reworded as well (`REWORDED_SWEEP`), since the bounded diff inlines first what the sweep's
substitutions do not explain (1.0.0-dev.12), so a plant in a pure rename always lands inlined and lands not inlined only
when such changes outgrow the budget. The holdout set is untracked
(`evals/roles/holdout/cells.ts`, gitignored, exporting `HOLDOUT_CELLS`): one defect class the dev cells lack and a mixed
sweep, so no prompt is tuned against it.

**Execution-only cells** (dev.13, `gen/exec.ts`): a unit that adds one function and its test to a package of the base repo
(goldens regenerated), the defect plausible code that only running it reveals, each with its clean twin, the same code with
the planted line correct. X1 wrong-but-passing logic (a default `sort()`, lexicographic, where the spec asks for numeric
order; the tests use single-digit values); X2 special-casing on the visible tests' inputs (a table of exactly the tested
values in front of a general formula that is off); X3 an edge case no test covers (the Gregorian century rule, a short last
chunk). Three variants per family; a trial's variant and package come from `<seed>/<family>/<trial>`, so a plant's trial k
and its twin's add the same function to the same package. The visible tests pass on both, so the lanes are green; each
variant's probe (hidden inputs, never in the fixture repo) fails on the plant and passes on the twin. The two-file diff is
inlined. A row's `experiments` counts the experiments its answer's findings cite, and CELL lines the trials that cited one.

**Grading** (`gate/grade.ts`). Caught: revise or escalate with a blocking finding localised to the plant's path. Looked
at: the plant inlined, or a Read of its file or `.diff` in the main session or any subagent (stream-json events carry
`parent_tool_use_id`), or a Grep whose output carried the planted text; a deletion is looked at when the prompt names it.
A catch without a look is `lucky`, a failure. Other blocking findings are spurious. On a clean cell any decision but
approve is a false positive. Coverage: of the files the gate recorded as not inlined (`diffShown.notInlined`: changed
content not inlined, and deletions; a pure move is neither), the share the session read or grepped. Clusters (the
large-diff gate): of the paths the answer's cluster map had to cover (the diff's paths, renames by their new path), how
many no cluster covers and how many more than one does, and the files per review depth (`description`, `routine`,
`close`); reported per cell as `clusters=<complete>/<over the threshold> mapped=<answers with a map>` and `mix=`, never
failed (code already refuses an incomplete map). The answer key (`<trial>/key.json`) lives only in the eval run dir, outside every dir the gate can read; the
transcript's tool traffic is scanned for the run dir, the trial dir, `evals/roles` and this repository's paths
(`evals/m4a/transcript.ts scanTranscript`), and any hit voids the trial (`needle`).

**Criteria** (`gate/summary.ts`, PASS|FAIL lines; exit 1 on any FAIL): planted detection at least 80% (Wilson interval
reported); zero lucky; clean false positives at most 1/12; precision (blocking findings localised to the plant, on planted
trials) at least 50%; voids at most a quarter of the trials; every call's per-model costs summing to its `total_cost_usd`;
with `--compare`, holdout detection within 15 points of dev; with `--baseline`, `exec-gain`. Coverage (median, target 90%), cluster coverage and the
review-depth mix, and method (tools by name, subagents with model and tokens, time to the first Read and Agent) are
reported, never failed.

**Cost.** Per model from `result.modelUsage` (subagents included; the top-level `usage` excludes them), cross-checked
against `total_cost_usd`: CELL lines carry the median and p90 cost, the cost per caught defect, wall time and turns; COST
lines the median and p90 per cell and model; USAGE lines the totals per model.

**Early inspection and brakes.** Every 30 s a running trial prints a TRACE line (tools by name, subagents with model and
tokens, time to the first Read and Agent, coverage so far, token load, denials, calls of unavailable tools). The harness,
never the gate, brakes a trial as `runaway` (the session killed, the trial void): no Read, Grep or Agent in 3 minutes while
the prompt left files out;
coverage flat over 8 tool turns; token load over 3x the cell's median so far (token load stands in for cost, which the CLI
reports only at the end).

**Spend caps** (inside the arm; the 2026-10-17 run overran because a cap was checked only between arms). `--cap <usd>`:
no new trial starts once the spend of the trials finished so far reaches the cap; running trials finish, and a `CAP` line,
an `INFO cap` line and `summary.json`'s `capped` count the trials not started. `--trial-cap <usd>`: the monitor's live
spend of the trial (every gate call so far, main session and subagents, each assistant message's tokens at list price,
`transcript.ts` `PRICES`) over the cap kills the session and voids the trial as `cap` (a `BRAKE … cap` line; the TRACE
line shows `spent=`). A trial's spend is the larger of its CLI-reported cost and that estimate, so a trial killed before
its result still counts what it spent (row `estimatedUsd`). Without the flags nothing is capped; a paid run sets both.

**Output.** `<out>/trials.jsonl` (a row per trial as it finishes), `<out>/summary.json`, and per trial `key.json`,
`prompt.txt`, `gate-<n>.jsonl` (each call's raw stdout), `transcript.jsonl`, `answer.json` and `row.json`. The trials'
repos and arc dirs are scratch, removed when the worker exits.

**Free tier.** `test/roles-gen.test.ts` (determinism, plants inside the diff and away from the ends, twins identical,
omitted placement really omitted, lanes green on every planted tree, goldens consistent with the generator except a hand
edit) and `test/roles-gate.test.ts` (run.ts end to end on degenerate fake gates via `--fake`: approve-all catches nothing,
revise-all is 100% false positives and fails precision, cite-every-path fails precision; a gate citing a not-inlined plant
without reading it is lucky; the transcript and cost parser on a captured subagent run; the `real` and `checkoutTree`
acts; the triggers; `--cap` stopping new trials, `--trial-cap` killing the `overspend` fake gate (a session that streams
one $20 message and hangs), the live price estimate, and the cluster grading). `--fake <kind>` runs the same harness on a
degenerate gate for free; over the large-diff threshold a fake answers one cluster over everything.
`test/roles-gate-exec.test.ts` (dev.13): every execution-only variant's plant passes its visible tests and fails its
probe while its twin passes both, the two differing in the planted line alone; the X cells' fixtures (lane green, goldens
the generator's, the module inlined, plant and twin sharing spec and package, the probe telling them apart in the unit's
tree); fake-gate trials over them; the read-only arm's argv rewrite and `real` act; `exec-gain`.

### The walkthrough eval (dev.13)

```sh
node evals/roles/run.ts walkthrough --set dev --n 3 [--cells S1,S2] [--parallel 2] [--rebind <class>=<model>:<effort>] [--out <dir>] [--cap <usd>] [--trial-cap <usd>]
node evals/roles/run.ts walkthrough --set holdout --n 3 --compare <dev run>/summary.json     # acceptance only
node evals/roles/run.ts walkthrough --set dev --n 1 --fake oracle                              # free: the harness's own check
```

**When.** Paid, path-triggered like the gate's: `src/prompts/walkthrough/**`, the walk job (`src/walk/**` but the polish
judge's `compare.ts` and `polish.ts`), its MCP
config (`src/backends/mcp.ts`), the prompt inputs and schemas, `src/routing/**`, the `claude-acting-judge` argv and the Claude reader (`src/backends/argv.ts`,
`claude.ts`), `evals/roles/walkthrough/**` and the shared harness.

**The product** (`walkthrough/ledgerly/`, `product.ts`): `ledgerly`, a spend ledger for platform teams, zero-dependency
Node, real files with `{{hook}}` places that the generator fills per trial. Surfaces: a server-rendered dashboard (one
token file, `design/tokens.css`, served as `/static/tokens.css`), a CLI (`init`, `import`, `report`, `config check`), an
HTTP API (`/api/v1`, RFC 9457 problems, cursor pagination, idempotency keys), a hand-edited `ledgerly.conf`, a CI
pipeline (`ci/pipeline.yml` and its local runner `ci/run.js`) and a README quickstart. Its committed design reference,
`design/` (research §D): `DESIGN.md` (subject, audience, primary job, principles, named anti-patterns, the one memorable
thing, layouts as wireframes, flows with states and step budgets, components, copy, the walkthrough script seed),
`tokens.css`, `api.md` (style guide, problem catalogue, auth, example sessions), `cli.md` (command tree, streams and exit
codes, error voice, golden transcripts), `config.md` (keys, defaults, mistakes, minimal and full examples) and `ci.md`.
A seed draws the data (the team `platform` and two more, budgets, alert shares, a currency, a month and the one before,
each month's entries, this month one team within, one near and one over its limit). The milestone (`fixture.ts`) has a
bring-up (`init`, the server on `{port:web}` with a `/healthz` probe, two imports) and nine journeys (three browser:
record an entry, change a limit, print a statement; six shell: CLI import, CLI report as JSON, API, config, CI, README);
the vision has experience clauses.

**Slots and families** (`families.ts`, `slots.ts`, `cells.ts`): 13 slots per product, each its family's plant or its
clean twin (the near-miss the reference sanctions), W1 to W13 as in the plan's table. W1 takes a browser journey's last
step (the record form, the limit form, the print link): its plant posts or links to a path nothing serves, its twin to
an old path that redirects. W2 to W7 take one page each (W2's twin is always the print view, which DESIGN.md "Print
views" makes plain), W7 a form, W6 a page with a primary action; W8 a CLI command, W13 a quickstart command; W9 to W12
are fixed. One slot per page, and no slot behind W1's dead end, so no plant masks another. A seeded backtracking search
draws the assignment. The four dev seeds (S1 to S4) plant each family in exactly two of them (26 plants, 26 twins): at
n = 3, 156 slot observations, 78 of each, six planted trials per family. The holdout set is untracked
(`evals/roles/holdout/walkthrough.ts`, exporting `HOLDOUT_WALK_CELLS`).

**The harness** (`walkthrough/arc.ts`) runs each trial through the production walk job, as the gate eval runs the
production gate: a holistic arc whose repository is the product and whose plan has the one milestone, owner-supplied
design, over one unit u1 (its spec's acceptance states what each surface delivers to its reference). u1 merges through
the arc harness (fake plan-check, build and gate; its lanes, the product's own tests, run for real), which makes the walk
due; then `runWalk` (src/walk/walk.ts) runs walk-1 exactly as an arc does: the capture, the detached checkout, the
bring-up (src/walk/bringup.ts, logs under the evidence dir), the inputs, the acting-judge call on the walkthrough seat
(frontier, Opus 5.5 medium; `--rebind` through the repo config) with this repository's walkthrough MCP config
(`fixture.ts` `WALK_MCP`: Playwright MCP, `--headless --isolated --browser chromium`, `--output-dir` the evidence dir,
`--viewport-size 1280x800`, substituted by src/backends/mcp.ts; pages over HTTP, never `file:`), the reading
(`validateWalkthroughOutput` and `walkRefusals`) with its one repair turn, minting and teardown. The call goes through the
fake backend's PATH shim (`real` acts, a second for the repair turn). A walk abandoned after its repair turn voids the
trial (`invalid`, with the job's reasons); a failed bring-up voids it (`bring-up`).

**Grading** (`walkthrough/grade.ts`). A finding belongs to the slot, among those on its journey, it localises to best:
3 for a path among the slot's files, 1 per marker (the page's route, the family's words) its claim or cause matches; ties
go to a planted slot, then family order; a finding matching nothing is stray. A planted slot is `caught` with a finding of
at least its expected class (`breaks` for W1, W5, W6, W13; `deviates` or either for the rest), `misclassed` when a `breaks`
plant got only `deviates`, `missed` with nothing, and `lucky` when caught though the transcript shows no exercise of its
journey (a page visited, a command run, a request sent: any tool traffic but Read, Grep and Glob). A `breaks` where
`deviates` was expected is false-blocking. A twin with a finding is a false positive (false-blocking when `breaks`). A
stray `breaks` is false-blocking too: the clean product has nothing that breaks. Polish proposals are counted, never
false positives. The answer key (`<trial>/key.json`) stays in the run dir; the transcript's tool traffic is scanned for the
run dir, `evals/roles` and this repository's paths, and a hit voids the trial (`needle`).

**Criteria** (`walkthrough/summary.ts`): recall (caught of planted slot observations) at least 80%, Wilson bound reported;
every family caught at least twice; zero lucky; twin false positives at most 3/78; false-blocking 0; stability (one
verdict in every graded trial) for at least 80% of (seed, slot) pairs graded twice or more; voids at most a quarter;
cost-check; with `--compare`, holdout recall within 15 points of dev. Reported: per seed (CELL), per family (FAMILY),
misclassed, stray findings, polish, browser and shell calls, screenshots, evidence missing, and cost as the gate's (COST,
USAGE, TOTAL, cost per catch).

**Brakes and caps.** A TRACE line every 30 s (tools, browser calls, shell calls, subagents, load, spend). The harness
kills the session (its process group: the MCP server and browser with it) and voids the trial on a token load over 3x the
seed's median (`runaway`), past 45 minutes (`runaway`), or when the trial's calls together pass `--trial-cap` (`cap`);
`--cap` starts no trial past the run's spend. The walk job tears the product down.

**Cost.** An estimate, not a measurement (no paid trial has run): a walk of nine journeys, three in the browser at two
widths, is roughly 150 to 250 turns with a context growing to 100k to 150k tokens; on Opus 5.5 list prices that is about
$3 to $5 of cache reads, $3 to $5 of cache writes and $2 to $3 of output, so $8 to $15 a trial, about $100 to $180 for
the dev set at n = 3, in line with the plan's budget. A paid run sets `--trial-cap 20 --cap 180` and starts with one trial
whose transcript is read before scaling.

**Output.** `<out>/trials.jsonl`, `<out>/summary.json`, and per trial `key.json`, `prompt.txt`, `argv.json`, `mcp.json`,
`walk-<n>.jsonl` (each call's raw stdout: the report, then its repair turn), `transcript.jsonl`, `answer.json`,
`evidence/` (the session's screenshots and notes, the product's logs under `server/`) and `row.json`.

**Free tier.** `test/roles-walkthrough.test.ts`: the generator's determinism and hygiene (no unresolved hook, no word
that names the eval in any product file); the dev cells' balance; the slot rules over 40 random draws; every slot's
predicted effect checked on each dev seed's running product (the dead end and the redirect, the 404 stylesheet, the
off-token colour and off-grid gutter, the script that throws, the contrast ratios computed from the token file, the
missing focus indicator, the vague form error, the CLI's streams and exit codes, the 200 error body against the problem
document, the silent and the warned unknown key, the stack trace and the silent typo against the usage, the CI report,
the README run as written); grading and the summary over scripted answers; run.ts end to end on the fake walkers
(`oracle` passes every criterion; `clean-report`, `cite-plants`, `flag-everything`, `breaks-everything` each fail theirs;
`refused` takes the repair turn and voids `invalid`); the caps; the seat; the triggers. The products of the plants check
are brought up by the production bring-up.

### The polish-judge eval (dev.13)

```sh
node evals/roles/run.ts polishJudge --set dev --n 3 [--cells SP-B,HI-W] [--parallel 2] [--rebind <class>=<model>:<effort>] [--out <dir>] [--cap <usd>] [--trial-cap <usd>]
node evals/roles/run.ts polishJudge --set holdout --n 3 --compare <dev run>/summary.json     # acceptance only
node evals/roles/run.ts polishJudge --set dev --n 1 --fake oracle                              # free: the harness's own check
```

**When.** Paid, path-triggered: `src/prompts/polishJudge/**`, the compare job (`src/walk/compare.ts`) and the bring-up it
shares (`src/walk/bringup.ts`), the polish revision (`src/walk/polish.ts`), the MCP config (`src/backends/mcp.ts`), the
prompt inputs and schemas, `src/routing/**`, the acting-judge argv and the Claude reader, `evals/roles/polish/**`, the
walkthrough eval's product and harness (`evals/roles/walkthrough/**`, which this eval runs on) and the shared harness.
`compare.ts` and `polish.ts` trigger the polish judge alone; the rest of `src/walk/` the walkthrough.

**Cells** (`polish/families.ts`, `cells.ts`). Four families on the walkthrough eval's `ledgerly` (one seed, every slot its
clean twin), each a starting state a walk proposes polish for and three after-states of the same step, 12 cells:

| Family | Journey | Before | Better (keep) | Worse (drop) | Neutral (drop) |
|---|---|---|---|---|---|
| spacing (SP) | J-1 record an entry | the form's fields 4 px apart | `--space-5` (24 px), as the form's other gaps | 2 px, off the 4 px grid, "to fit the fold" | the same 4 px as `calc(var(--space-2) / 2)` |
| hierarchy (HI) | J-2 change a limit | Change limit a quiet button: no primary action | Change limit the page's primary button | the entries table before the card: the figure no longer first | the table's heading reworded ("September 2026 entries") |
| CLI help (CH) | J-5 report as JSON | `--help` lists commands alphabetically | in the order a ledger uses them, as cli.md's command tree | options first, examples last | descriptions reworded to the third person |
| error copy (EC) | J-4 import a bad file | "bad.csv:2: amount is not valid" | the field's own message: what is wrong and how to fix it | "import failed (line 2)": no field, no file | "bad.csv, line 2: …", the same facts reworded |

Each cell is a proposal text (what a walk would write, citing the walk's note of what it saw) and its after-state: edits
to the product and to the reference `design/` (the reference diff the judge sees in its bounded tweak diff), as a polish
unit's build commits them. Every after-state touches the reference, so code never drops one `reference-untouched`
before the judge is asked. A worse or neutral after-state's reference edit only redescribes the product to the tweak
(the prompt's "a reference change that only redescribes the product … does not make the after more faithful"). The
holdout set is untracked (`evals/roles/holdout/polish.ts`, exporting `HOLDOUT_POLISH_CELLS`: six cells on the dev
families, their own proposals and after edits, other seeds).

**The harness** (`polish/arc.ts`) runs each trial through the production compare job, as the walkthrough eval runs the
production walk: the walkthrough eval's milestone arc over the cell's before product (`setupMilestoneArc`); u1 merges
through the arc harness; walk-1 runs through the production walk job with a scripted walker whose one proposal is the
cell's (unit u2, its scope the reference and the product); the production polish revision admits u2; u2 runs its pipeline
(a fake build commits the after-state, the product's own tests run for real as its lanes, a fake gate approves) and waits
at its candidate admission; then `runCompare` runs compare-1 as an arc does: the capture under the fence, two detached
checkouts brought up side by side on their own ports, the polishJudge call through `callActingJudge` (the polishJudge
seat, frontier: Opus 5.5 medium; Playwright MCP for the two browser families, this repository's walkthrough servers),
validation with its one repair turn, teardown, `tweak-judged`. A compare abandoned after its repair turn voids the trial
(`invalid`); an after-state that does not come up voids it (`bring-up`). The monitor, brakes and needle scan are the
walkthrough eval's.

**Grading and criteria** (`polish/summary.ts`). Correct: `keep` on a better after-state, `drop` on a worse or neutral one;
a void is not correct. Every run (trial index; the queue runs run by run, so a capped run leaves whole runs behind)
holds at least 10 of its 12 cells correct (`accuracy`; a run over a subset of cells needs the same share); no worse
after-state is ever kept (`worse-kept`: the costly error, a kept regression lands); one decision in every graded trial
for at least 80% of the cells graded twice (`stability`); voids at most a quarter; cost-check; with `--compare`, holdout
accuracy within 15 points of dev. Reported: RUN per run, KEEP rates per variant (a neutral keep rate is how much churn
lands), FAMILY accuracy, and per cell the decisions, repair turns, browser and shell calls, screenshots and cost (COST,
USAGE, TOTAL).

**Cost.** An estimate, not a measurement (no paid trial has run). A compare walks one journey twice: a browser cell at
two widths on each side is roughly 40 to 80 turns with screenshots and crops, its context growing to 60k to 100k tokens;
on Opus 5.5 list prices about $1.50 to $3 a trial (cache reads and writes dominate, as in a walk). A shell cell is half
that or less ($0.50 to $1.50). The dev set at n = 3 is 18 browser and 18 shell trials: roughly $40 to $80. Each trial
also runs u1's and u2's pipelines and three bring-ups, all free (fake build and gate, real lanes): about a minute of
wall time before the judge starts. A paid run sets `--trial-cap 6 --cap 90` and starts with one browser and one shell
trial (`--n 1 --cells SP-B,EC-W`) whose transcripts are read before scaling; the holdout's 6 cells at n = 3 are about
half the dev set's cost.

**Output.** `<out>/trials.jsonl`, `<out>/summary.json`, and per trial `key.json` (cell, variant, the expected decision),
`prompt.txt`, `argv.json`, `mcp.json` (browser families), `compare-<n>.jsonl` (each call's raw stdout: the answer, then
its repair turn), `transcript.jsonl`, `answer.json`, `evidence/` (the judge's captures and notes, both instances' logs
under `server-before/` and `server-after/`, the bounded diff under `diff/`) and `row.json`.

**Free tier.** `test/roles-polish.test.ts`: the cells' shape and hygiene (12 cells, every after-state editing the product
and the reference, no word that names the eval in a proposal or a changed file, an edit that drifts from the product
failing loud); every family's before and after-states checked on the running product (the fields' gap resolved from the
served stylesheet and tokens: 4, 24, 2 px off the grid, 4 px rewritten; the budget page's primary action, card order and
heading; the usage's sections and command order; the import error's text, field, fix and file); the summary's bar over
scripted rows (oracle passes; always-keep 4/12 and always-drop 8/12 each fail; 10/12 passes, 9/12 fails, one worse kept
fails, one bad run of three fails; voids; stability; holdout gap); run.ts end to end on the fake judges through the
production compare (`oracle` passes every criterion over all 12 cells, MCP only for the browser families; `keep-all`
and `drop-all` fail; `refused` takes the repair turn and voids `invalid`); the caps; the seat. The triggers are in
`test/roles-walkthrough.test.ts` (`roles.walk-triggers`).

## The run observer

```sh
node evals/observer.ts /var/tmp/m4a [--backend codex|claude] [--interval-min 10] [--model gpt-5.6-luna] [--max-hours 7] [--host-dir /var/tmp/roadmap] [--once]
```

A background watcher for a paid fixture run (start it beside the driver, e.g. under a Monitor). Each tick it gathers
the delta since `<dir>/observer/cursor.json` (new events by seq for every arc under
`stage/product/.git/roadmap-runtime/`, new needs-user files, new root-session `transcript.jsonl` lines summarised
to tool calls and results, new bytes of the newest host `executor.*.err` / `supervisor.*.err`, and a `status`
snapshot), capped at 200 KB with the newest kept, and asks a read-only session (20 minute timeout) for NEW
issues only: defects, and efficiency opportunities (kind `efficiency`: the constraint, redundant calls, avoidable waits,
with an estimate of recoverable minutes or spend). Replies are JSON lines `{severity: abort|high|note, kind, summary, evidence, suggestion}`; valid ones
are appended to `<dir>/observer/observations.jsonl` with `{tick, at}`, invalid lines are recorded as `{invalid}`.
stdout carries `OBSERVER abort: ...` / `OBSERVER high: ...` lines and one `OBSERVER tick <n> ok <count>` per tick
(`OBSERVER tick <n> error <backend>-failed` retries the same delta next tick). It stops when `<dir>/report.json` exists
or after `--max-hours`; at `report.json` it runs one deep retro pass over the whole run into `<dir>/observer/retro.md`
(90 minute timeout; `--no-retro` skips it). It never touches the run. Two failed ticks in a row emit an `OBSERVER abort: [harness]` line.
`--backend codex` (default) runs `codex exec -s read-only` (default model `gpt-5.6-luna`). `--backend claude` runs a headless
`claude -p --model <model> --effort high --output-format text` (default model `claude-sonnet-5-5`) in the fixture dir with
`--allowedTools Read,Glob,Grep`, every other built-in tool disallowed, `--strict-mcp-config` and settings
`{"autoMemoryEnabled": false}`; same prompt, same JSON-line contract, same retro path. Free test: `test/observer.test.ts` (fake
`codex` and fake `claude` on PATH).
