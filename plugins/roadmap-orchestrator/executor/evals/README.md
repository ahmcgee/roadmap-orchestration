# Evals

A change is not done until the ladder passes, in order, from `executor/`:

1. `npm run typecheck`: `tsc --noEmit` over `src/`, `test/` and `evals/`.
2. `npm test`: `node --test test/*.test.ts`, then `test/serial/*.test.ts` alone (the upgrade test's dev.5 park premise needs a calm host), pure-module and integrated tests, fake backends only. This tier
   includes `test/evals-m1.test.ts`, `test/evals-m2.test.ts` and `test/evals-m3.test.ts`, which run the M1, M2
   and M3 fixtures below end to end against the fakes, and `test/serial/upgrade.test.ts`, which starts the M1 fixture on
   the previous release's executor (`PREVIOUS_RELEASE`, extracted with `git archive`), stops, parks or crashes it
   mid-arc and finishes it on HEAD.
3. `node evals/probe.ts`: the targeted probe against the real, authenticated CLIs.
4. The paid fixtures, `evals/m1/`, `evals/m2/` and `evals/m3/`: once per merged batch, never per worktree agent.

## The targeted probe

```sh
node evals/probe.ts
```

Runs the production argv builder, runner and adapter against the real `claude` and `codex` (both must be on
PATH and logged in): the backend smoke, Codex fresh and resume, a real shell lane, the Claude judgment and
implementer argvs, the Fable id pin, and (M3) one real call each of the lens, checkpoint and vision-aware plan-check
prompt modules over tiny fixtures on their own seats. Prints `PASS|FAIL <check> <detail>` per check and `USAGE` lines, keeps
its run dir for inspection, and exits non-zero on any FAIL. Cost: pennies.

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
  `roadmap apply`; `run-only --clear` once that applies. Each device is recorded in `report.json` (`devices`).
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
free (10 minute timeout). `test/evals-m2.test.ts` runs it and requires every criterion to pass.

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

- `setup.ts <dir>` lays out the fixture, refusing a non-empty dir: `repo/` (`src/cli.js` with `format` printing
  through `formatAmount`, `total` through `formatDisplay`, and an unknown command exiting 2; `src/format.js` whose
  `formatAmount` builds the cents from the amount's decimal digits, half to even, without saying so;
  `src/display.js` whose `formatDisplay` separates thousands over `toFixed(2)`; unit tests under `test/unit/` for
  the suite; journey tests `journeys/*.journey.js` for
  the arc lanes, outside `node --test`'s default discovery; `docs/money.md`, the rounding rule, which only I-2's
  docRef names; in-tree `.roadmap/` with the ledger contract, the C-nn ledger, a hand-written `invariants.md`
  and an empty-routing config), `input/`
  (plan.json, vision.json, obligations.json, rulings.md, one spec per unit) and `barriers/`. The plan is holistic:
  audits every 2 publications with the required lens set L = {invariants, vision}, `limits.convergenceK` 1. The
  vision: V-1 purpose "bookkeepers reconcile a month in one command", V-2 non-negotiable "money is never silently
  mis-rounded", V-3 tradeoff rank 1 "clear errors over permissive input". The obligations, each a node-test arc
  lane over one journey test through the shipped reporter: I-1 future (serves V-1, delivered by `parse` and
  `report`: `reconcile <YYYY-MM> <file>`), I-2 must-hold (serves V-2: `format` rounds to the cent half to even,
  `format 0.125` prints 0.12; lane `money` runs the CLI and waits at the driver's barrier in audit-1's run only,
  `evals/m3/barrier.ts`), I-3 must-hold (serves V-3: unknown commands exit 2). Every scoped path is mapped;
  `tidy`'s one path `src/cli.js` maps to I-3 only. Its spec is a one-line consistency change, and its diff holds
  no rounding code: `format` prints through `formatDisplay`, as `total` already does (`format 1234.5` prints
  `1,234.50`). `formatDisplay`'s existing `toFixed` rounds the binary value, which disagrees with half-even on
  ties (0.125 → `0.13`, 0.625 → `0.63`, 2.675 → `2.67`), so tidy regresses I-2 unselected. This shape follows
  paid runs 1 and 2: with a rounding change in tidy's own spec (`Math.round`, then `Intl.NumberFormat`), the real
  plan-check traced the tie behaviour against V-2 and redirected the spec (run 1, then a park and a cut; run 2,
  `roundingMode: 'halfEven'`), so I-2 never regressed. Units: `parse`, `tidy` after it, `report` after `parse`
  (`reconcile` renders through `formatAmount`, so I-1's latch does not depend on tidy). The repair the fake story
  plays makes `formatDisplay` round half to even; the check accepts any repair that makes I-2 hold.
- `driver.ts <dir> --profile default` queues `run-only parse tidy` before `start`, then applies each device once
  its condition holds in the log, `status` or a barrier file, each independently of the others' order: `report`
  added to `run-only` once audit-1 (checked to be the cadence audit of tidy's publication S) waits at the money
  barrier; the barrier released once `report` merged (S′), so A1 audits S and re-witnesses its P1 over I-2 on S′;
  at the first `checkpoint-inputs`, whatever its trigger, the architect's edit of `direction` by `roadmap apply`,
  which makes that bundle stale whole; the repair's id read from the `plan-applied{source: bundle}` change (G18)
  and added to `run-only` once the drift audit that revision triggers has started; every `divergence-digest` and
  `convergence-bound` item acknowledged as it opens; `run-only --clear` once the repair merged. Each device is
  recorded in `report.json` (`devices`). As soon as the log leaves the story the run stops (`endedBy:
  device-failed`) with a reason naming the observed job, trigger and outcome: the first checkpoint not rejected
  stale (or applying its bundle), a bundle revision other than one repair admit, a checkpoint that no-ops or asks
  the owner before the repair is admitted, audit-1 not the cadence audit of S or ending without a witness P1 over
  I-2, a rejected apply. Finding ids are never assumed (plan-check may open P3s first): the P1 is found by content.
  A parked run is stopped as in M1; hard timeout 180 minutes.
  It refuses a used dir, uses the machine's host lock, and kills only the pids `status` names.
- `check.ts <dir>` prints one JSON line with every criterion, then the two lists, and exits non-zero on any
  failed criterion. M3: `baseline`, `regression-unselected`, `audit-race`, `stale-whole`, `bundles-whole`,
  `repair-divergence` (plan-departed citing V-2), `divergence-digest-bound` (each digest binds exactly the
  recorded ids not bound before; the driver acknowledged each), `convergence-bound`, `repair-resolved`,
  `drift-audit` (the vision lens alone, then a no-op), `final-audit` (L, then a no-op), `close-out` (docs-only,
  covering its own edge), `completion` (`arc-completed`, then the terminal snapshot), `lens-coverage` (each lens
  of L contiguous to the final head, the docs edge applied only from the final audit's SHA), `snapshot-closure`
  (the terminal ref verifies as a closure carrying every witness record and payload), `obligations-discharged`.
  Standing: run-ended, units-settled, head-is-publication, diff-product-and-docs (units' scopes plus the living
  `.roadmap/` docs, `constraints.md` and `invariants.md` included), snapshot-verifies, judgment-fresh (lens and
  checkpoint calls included), meter-covers-calls, no-model-ids.

Cost and time: about 23 backend calls on the story's path: the backend smoke (2), plan-check, build and gate for
`parse`, `tidy`, `report` and the repair (12, 4 of them Codex builds), the lenses (A1 2, A2 1, A3 2) and the
checkpoints (the stale one, its re-evaluation, A2's and A3's): 13 Opus and 4 Fable calls among the Claude ones,
about 2.2 times the M2 fixture. Expect 80 to 130 minutes; the driver stops at 180.

`--fake story` runs the same driver against the fake backends (`evals/m3/scenario.ts`: unit calls as M1-style
steps keyed by unit, lens and checkpoint calls as scripted judgments keyed by job and lens) with a host dir
inside the fixture, for free (15 minute timeout). The fake story also plays the literal partial bundle (A18,
G19): after the stale rejection, the next checkpoint answers the repair admit followed by an invalid op, which is
rejected invalid with nothing applied, and its one re-evaluation admits the repair alone. The fake first
checkpoint waits at `fake/ckpt-1.hold` until the driver's apply is applied; a real one simply takes longer than
the apply (if not, the check fails `stale-whole`). `test/evals-m3.test.ts` runs it and requires every criterion.

`NOT EXERCISED: …` names what the journal shows no trace of, from: rule, reverse, steer, merge-in, reproduction,
batch repair, per-identity bound, owner-request, draining, real go, literal partial bundle. The paid run takes
none of them; each has a fake integrated test in `npm test` (the literal partial bundle in `evals-m3.fake`).
`CANNOT SHOW: …` is fixed: real cgroup containment, crash boundaries under real models, week-long convergence,
and a model's op list (the partial bundle is forced only by fakes).

What real judges may still do differently, each ending the run `device-failed` (or timed out) with the report
saying where: tidy's plan-check or gate may read `src/display.js`'s `toFixed` and `docs/money.md` through its
checkout, connect them to V-2 and redirect or revise (runs 1 and 2 did, with the rounding in the spec itself);
Codex may keep `format` on `formatAmount` or fix `formatDisplay` too, so I-2 never regresses and audit-1 opens
no P1 over it; a real first checkpoint may decide before the stale `apply` commits; a real checkpoint may no-op,
cut `tidy`, patch a spec or write a repair spec that cannot be admitted instead of admitting a repair; lenses
may open further findings that make the checkpoint act again, and with K = 1 a second applied bundle turns the
rest into bundle requests the driver does not answer.
