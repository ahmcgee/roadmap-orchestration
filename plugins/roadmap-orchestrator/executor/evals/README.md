# Evals

A change is not done until the ladder passes, in order, from `executor/`:

1. `npm run typecheck`: `tsc --noEmit` over `src/`, `test/` and `evals/`.
2. `npm test`: `node --test test/*.test.ts`, pure-module and integrated tests, fake backends only. This tier
   includes `test/evals-m1.test.ts` and `test/evals-m2.test.ts`, which run the M1 and M2 fixtures below end to
   end against the fakes, and `test/upgrade.test.ts`, which starts the M1 fixture on the previous release's
   executor (`PREVIOUS_RELEASE`, extracted with `git archive`), stops or parks it mid-arc and finishes it on HEAD.
3. `node evals/probe.ts`: the targeted probe against the real, authenticated CLIs.
4. The paid fixtures, `evals/m1/` and `evals/m2/`: once per merged batch, never per worktree agent.

## The targeted probe

```sh
node evals/probe.ts
```

Runs the production argv builder, runner and adapter against the real `claude` and `codex` (both must be on
PATH and logged in): the backend smoke, Codex fresh and resume, a real shell lane, the Claude judgment and
implementer argvs, and the Fable id pin. Prints `PASS|FAIL <check> <detail>` per check and `USAGE` lines, keeps
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
