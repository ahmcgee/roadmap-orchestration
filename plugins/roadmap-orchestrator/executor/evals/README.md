# Evals

A change is not done until the ladder passes, in order, from `executor/`:

1. `npm run typecheck`: `tsc --noEmit` over `src/`, `test/` and `evals/`.
2. `npm test`: `node --test test/*.test.ts`, then `test/serial/*.test.ts` alone (the upgrade test's dev.5 park premise needs a calm host), pure-module and integrated tests, fake backends only. This tier
   includes `test/evals-m1.test.ts`, `test/evals-m2.test.ts`, `test/evals-m3.test.ts` and `test/evals-m4a.test.ts`,
   which run the M1, M2, M3 and M4a fixtures below end to end against the fakes, and `test/serial/upgrade.test.ts`, which starts the M1 fixture on
   the previous release's executor (`PREVIOUS_RELEASE`, extracted with `git archive`), stops, parks or crashes it
   mid-arc and finishes it on HEAD.
3. `node evals/probe.ts`: the targeted probe against the real, authenticated CLIs.
4. The paid fixtures, `evals/m1/`, `evals/m2/`, `evals/m3/` and (M4a's acceptance) `evals/m4a/`: once per merged batch,
   never per worktree agent. M4a's delegated adjudication (`evals/m4a/adjudicate.ts`) is acceptance, not a rung: once,
   after the M4a paid run.

## The targeted probe

```sh
node evals/probe.ts
```

Runs the production argv builder, runner and adapter against the real `claude` and `codex` (both must be on
PATH and logged in): the backend smoke, Codex fresh and resume, a real shell lane, the Claude judgment and
implementer argvs, the Fable id pin, and (M3) one real call each of the lens, checkpoint and vision-aware plan-check
prompt modules over tiny fixtures on their own seats; (M4a) the forge functions read-only against the real repository
(identity, policy and trust, issues and comments shapes), a real pack-review call (frontier Opus medium) and checkpoint
call (summit Opus xhigh), and an effort-changed resume on both CLIs (OI-2). Prints `PASS|FAIL <check> <detail>` per check and `USAGE` lines, keeps
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
  `roadmap:feedback` by a NONE author with her own comment, #3 a PR entry), its gh sources copied in; empty gh and XDG
  config dirs and an identity-only gitconfig. The planted defects and the owner's answers are `answer-key.json`
  (postconditions, never file names; never staged).
- `driver.ts <dir>` stages the plugin without `executor/evals`, `executor/test` and `node_modules`, then plays the
  harness and the owner around `claude -p --model claude-opus-5-5 --effort high --plugin-dir <stage> --permission-mode
  bypassPermissions --strict-mcp-config --settings '{"autoMemoryEnabled":false}' --output-format stream-json` (no MCP
  server, no auto-memory: a turn whose init event shows either is killed and fails the session): a turn ending in the
  skill's `ROADMAP-SESSION: stopped <reason>` ends the session; the last numbered block goes to the owner simulator (code answers K = 1, the first slice, the issue policy and
  brief acks, which the owner never gives; anything else goes to a frontier-medium `claude -p` given only the key's
  owner answers released so far: the cancellation cutoff only once arc 1 completed); any other turn end is the skill's
  headless wait, resumed on `roadmap watch` events (new needs-user items, the run reaching complete). Allowlisted env,
  the fake gh first on PATH, cwd the product. Before and after, from its own env, a canary of this repository's real
  forge (refs, issues, PRs, comments, labels, releases; `canary.json`) needs an authenticated real `gh`. It scrambles
  the live corpus and `.roadmap/` files at the end, writes `transcript.jsonl` and `report.json`; hard timeout 360 min.
  It uses the machine's host lock, so no other arc may run on the host meanwhile.
- `check.ts <dir>` prints one JSON line and the not-exercised line, exits non-zero on any failed criterion: isolation,
  defects, phase0-green (`--from-ref`, after the scramble), census-complete, intake-filtered, arc1-complete,
  arc2-chained, stopped-at-k (reason exactly `k-limit`), stacked-prs, config, brief-acked-once (no committed brief
  ack: the bootstrap arc is the only acked start), no-model-ids, snapshot-closure.
- `adjudicate.ts <dir>` (not in `npm test`): one `claude -p --model claude-opus-5-5 --effort xhigh --tools
  Read,Glob,Grep` session in the same isolation env, role-playing the vision's owner over a read-only tree of copies
  (vision, raw and curated corpus, the extraction, the plan and slice, the product at arc 1's head, the witness lanes'
  records and evidence, the rubric R1–R7), never the key; its transcript is scanned like the root session's and a hit
  voids the verdict. Writes `adjudication.json` (`verdict | void | invalid | failed`); the lead adjudicates each finding
  and reports to the owner.

Cost and time: one long root-agent session (Opus high) with about 8 Phase-0 subagents per arc; per arc a pack review
(frontier), about 2 to 3 units at plan-check, build and gate, the vision lens of each audit and 2 to 3 checkpoints
(summit); about 5 owner-simulator calls (frontier medium). About 35 executor upper-tier calls over the two arcs,
subscription-billed; expect 3 to 5 hours. The adjudication is one Opus xhigh session, about 30 to 60 minutes.

`--fake story` and `--fake vision-silent` (setup with `--vision-silent`) run the same driver with the scripted root
agent (`fake-root.ts`), which follows the skill and replays the golden Phase-0 outputs (`golden.ts`: the curated
corpus as exact edits of the raw one, the obligations, census, records and plans) through the staged plugin's real
CLI, against the fake backends (`scenario.ts`, one scenario per arc) and a host dir in the fixture; 30 minute
timeout. `story`: arc 1's pack review holds a blocking finding the root agent fixes by `apply` (the superseding
review), a gate note and a deferred lens finding bank debt, a checkpoint and an issue derive amendments; after arc 1
the cutoff question goes to the owner stub; arc 2 chains on arc 1 through one between-arc commit, the forge flips to
PUBLIC + ALL mid-arc (the checkpoint's capture raises the blocking item, admission is held and the checkpoint waits
uncaptured until the owner restores the policy and the root agent acks), and with K = 1 arc 3 is refused
`chain-invalid{limit}` at `phase0 check` and at `start`; stop `k-limit`, every criterion passing. `vision-silent`: after
arc 1 no slice candidate is left; stop `vision-silent`. `test/evals-m4a.test.ts` runs both side by side and also covers
setup validity, the check's defect oracle (each defect fails on its own mutation), the adjudicator's tree, and a start
refused `issue-policy-untrusted` under PUBLIC + ALL.

`NOT EXERCISED` by the paid run (each has a fake integrated test): other-repo and checkout corpus sources,
`issue-policy-untrusted` (start refusal and mid-arc flip), a mid-arc re-pin, debt promote, rewording a T-n, the
vision-silent stop.

## The run observer

```sh
node evals/observer.ts /var/tmp/m4a [--interval-min 10] [--model gpt-6-astra] [--max-hours 7] [--host-dir /var/tmp/roadmap] [--once]
```

A background watcher for a paid fixture run (start it beside the driver, e.g. under a Monitor). Each tick it gathers
the delta since `<dir>/observer/cursor.json` (new events by seq for every arc under
`stage/product/.git/roadmap-runtime/`, new needs-user files, new root-session `transcript.jsonl` lines summarised
to tool calls and results, new bytes of the newest host `executor.*.err` / `supervisor.*.err`, and a `status`
snapshot), capped at 200 KB with the newest kept, and asks a read-only `codex exec` (20 minute timeout) for NEW
issues only. Replies are JSON lines `{severity: abort|high|note, kind, summary, evidence, suggestion}`; valid ones
are appended to `<dir>/observer/observations.jsonl` with `{tick, at}`, invalid lines are recorded as `{invalid}`.
stdout carries `OBSERVER abort: ...` / `OBSERVER high: ...` lines and one `OBSERVER tick <n> ok <count>` per tick
(`OBSERVER tick <n> error codex-failed` retries the same delta next tick). It stops when `<dir>/report.json` exists
or after `--max-hours`. It never touches the run. Free test: `test/observer.test.ts` (fake `codex` on PATH).
