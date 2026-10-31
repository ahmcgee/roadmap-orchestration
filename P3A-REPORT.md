P3(a) adds JSON `status --summary`, optional non-binding USD expectations, progress/spend/milestones/captures, caught totals and job verdicts. Four advisory waste detectors raise non-blocking `waste-finding` items with durable, replay-safe `Parent{type:waste,key}` causes. Grinding uses 8 builds/20 judged stages.

The active M4b scheduler track, proposal/proof/apply machinery, CLI commands and status calculation are retired. CPU admission back-off and starvation handling remain; memory PSI and available RAM now participate in the host brake. Passive flow evidence readers remain but schedule no work.

Codex token usage produces meter facts, including partial readings. Missing prices use the complete routed-model table and `costEstimated: true`; native prices survive. Estimates use standard rates because aggregate CLI usage cannot identify long-context requests. SIGKILL exit evidence includes PSI, meminfo, OOM-counter deltas and readable kernel matches within the executor lifetime; absent proof remains external-unknown.

P3c merge note: preserve `jobStageOutcome` when combining roles. `stage-outcome` also accepts `{stage: experience-verdict|campaign-audit, job, milestone|null, verdict, findings:{P1,P2,P3,total}}`. Walkthrough, polish comparison and audit emit it idempotently before their terminal facts. Existing meter/stage-outcome/proc.spawn/lane-reused events remain.

Verification: `npm run typecheck`; 84 non-serial files, 1,526 unique cases passed (`--test-concurrency=4`); locked serial pipeline-matrix 362/362, concurrent-matrix 501/501; M4a rerun, pressure and probe-crash pending the shared lock. Added 17 direct cases, two waste-notice pipeline crash cells and integration assertions in existing audit/walk/polish/supervisor/M4a cases. No paid evals, full npm test, version bump or process-doc edits; reference CLI forms only. cgroup-real: NOT RUN.

Reruns: an import-cleanup defect caused three 60-second apply timeouts; restored imports, typecheck and locked apply rerun passed (10/10). M3 was interrupted at its obsolete flow barrier; corrected fixture passed locked (10/10). Two TUI cases failed from the worktree-root CLI path; the executor-cwd locked rerun passed (66/66). Initial pipeline passed 3/4: its bumpy reference omitted the new advisory; expected notice corrected, duplicate-cause oracle unchanged. M4a initially passed 21/22: two new advisory wakes changed the turn list; explicit once-only/non-blocking checks now surround the original story and merge assertions. Deleted-flow expectations in focused tests were updated.

Removed: 103 cases (95 static across nine deleted files, four flow job/series crash cells, one other case, three whole-pipeline flow-series cells), two paid probe scenarios, and only flow-feature assertions in nine surviving mixed cases. Every removal is listed below.

Removed-test authorization for every entry below: design delta, Fable judgment §8: “Retire M4b flow loop (src/flow ~3.5 KLOC) this batch; keep host:cpu back-off as code.” Execution phases P3(a) assigns flow-loop retirement to this worker.

`test/flow-apply.test.ts`:

- flow.proof-preserved-applied: =1 → =3 over three timer files is preserved (equal records, faster), then applied under the fence; the owner's plan file is never written
- flow.proof-changed: on a shared ledger dir the parallel argv fails a test: changed, refused and remembered
- flow.proof-unprovable: a lane env setting NODE_OPTIONS clashes with the node-test reporter: unprovable, nothing run, remembered
- flow.proof-red: a red baseline is proved again once by a fresh proof job, then refused unremembered
- flow.apply-crash: SIGKILLed after the flow revision is committed, the next tick journals flow-applied from it and commits nothing twice
- flow.decide: a rejection is remembered by its RC-9 key and acks the item; decisions are idempotent by proposal id; unknown, dropped and contrary decisions are refused
- flow.request: flow-requested once per command, with its reason
- flow.given: a host given is written once under this host's fingerprint; the same given again is the one there
- flow.proof-timeout: the old side enforces the lane wall limit and keeps timeout evidence

`test/flow-job.test.ts`:

- flow.job-proposal-item: a request starts a run from kept inputs; its surviving proposal raises one non-blocking flow-proposal item, once
- flow.host-and-dropped: host advice raises flow-host; a proposal targeting held time is dropped with its reason and raises nothing
- flow.invalid-repair: an answer the reader refuses takes the repair turn in its own session, told why; refused again, the run ends invalid with a flow-invalid item
- flow.track-non-holistic: the track runs on an arc without the holistic layer; the series is kept right before arc-completed
- flow.off-dev7: an arc whose revisions carry no role set (1.0.0-dev.7) runs with the loop off: no run, no series; status says off-dev7
- flow.verdict-at-completion: an applied proposal's window the completion closes gets its verdict once, before the series (too few samples: inconclusive)
- flow.ruler-changed-reading: command revisions after the first dispatch that move the ruler; not before it, not a lever, not a vision apply
- flow.ruler-changed: an apply after the first admission reseating a judgment raises one non-blocking ruler-changed item, listed in status
- flow job crash B2 flow.after-started
- flow job crash B4 flow.after-call
- flow job crash B4 flow.after-ended
- flow series crash B4 flow.series-before-completed

`test/flow-trigger.test.ts`:

- nothing without evidence; a request; the floor at 10 merges since the last run
- constraint-shift: the first label once 3 points exist, then a change of the label the last run recorded
- the cooldown: 120 minutes from the last start; one requested bypass per window, coalescing what is due
- under an open window only verdict-closed, buffer-red and requested fire
- buffer-red: the latest point red and merged since; an in-flight unit red now and not at the last start; none without limits
- fires with units in flight once a unit was held for host pressure since the last run's start; fires before any merge
- only holds after the last run's start count, and the cooldown and an open window hold it like the others

`test/flow-levers.test.ts`:

- each lever's revision differs from the plan exactly at its own paths, and the preimage tells absent from set
- a forged revision touching anything outside the action's instantiated paths throws
- a resource gaining a pool, or a reorder of a keyed list, diffs outside every lever
- code derives the verdict metric and the ToC step from the lever (G7)
- RC-9: the key is (station, lever, target), never the value
- only the --test-concurrency value changes in place
- passes the plant proposal
- target
- given
- rejected-before (RC-9)
- verdict-open
- no step order (dev.12): an elevate lever needs no exploit verdict first
- argv-shape and lane-cpu
- concurrency-cpus
- sequence-repair-waiting and sequence-high-set
- build-class-step: one class step, never below the built-in (RC-8)
- every lever but host advice is measured by pressure and subordinates; host advice stays elevate with no metric
- a decrease of the arc's own load is kept, with no exploit verdict first (it subordinates)
- direction: an increase, or a lever that decreases no load, is dropped
- host:cpu is a target whatever code's constraint (dev.12); the direction check still binds there
- names the ruler paths a revision touched, and nothing for a lever change

`test/flow-givens.test.ts`:

- the file lives at <common>/roadmap/givens.json; absent reads as none
- declarations append G-1, G-2 and keep earlier entries; an equal one returns the existing entry
- a host given is enforced while its fingerprint matches the host, else stale; repo givens follow, always enforced
- repo givens: none without a config or a flow block

`test/flow-constraint.test.ts`:

- none before the first point
- the largest wait at 10 % of mean lead or more names the station it waits for
- a wait in front of the slot names the slot and its largest component
- below 10 %, the largest service: the slot competes as its components' sum; held never counts
- the finding wait, when it is the largest wait, is the constraint itself (diagnostic)
- reads the last ten points only
- a window mean pressure at the threshold or above names host:cpu, ahead of the wait and service rules
- the mean reads the window's measured points only; none measured (no schedstat) turns the rule off

`test/flow-series.test.ts`:

- cuts a merged unit's lead into disjoint waits, services and slot components summing to it
- an attempt a restart cut short is service of the next one; its stray ops after an outcome start nothing
- holds the partition summing to lead over random logs (pauses, parks, drains, reruns)
- a pause, a stop until the next start and an ARC-scope drain are held inside waits, never inside service
- the whole wait after a hold or park outcome is held; another unit's pause is not
- in flight: a parked or paused unit's clock stops, a stuck one's runs on
- splits the candidate wait: an active P1 over a selected obligation is wait:finding, held time stays held, the rest the slot's
- a unit owning the finding repairs it and is never held by it; a ruling ends it; no approval selects nothing
- a red candidate's T-alone rerun is rework in the candidate's rest, never suite service; stand-ins are suite service, other journeys arc lanes
- a repair batch's suite runs are `batch` on its candidate and `rerun` on the tip; its members are out of the points and in T
- splits first-held obligations by the advances they serve; T, WIP and OE per hour of the log
- a non-holistic arc has no T split; a log no start fingerprinted has no host
- a unit's cost is its seat calls', null when one reported none
- lists each leaf and the slot's sum, means over the points, largest first; the leaves' shares sum to one
- a point's pressure is the time-weighted mean of its measured service intervals, per station too; none measured is null
- the station table weighs each point's measured station pressure by its minutes; the slot by its components; null when none is
- reads the kept series when its v is this release's, else recomputes from the ref's events
- seeds only from completed arcs, newest completion first

`test/flow-verdict.test.ts`:

- before: the last 5 completed at or before the revision; after: units admitted after it; a straddling unit is neither
- a suite lane's per-run service: runs of that lane only, after the revision
- samples the units' interval pressure on each side; a unit without one is no sample; lead stays a guard
- at the fifth sample, taking at most 5
- after 6 h of non-idle time: a drain stops the clock, an ongoing one holds the window open
- at arc-completed, with what it has; samples after the close are not taken
- improved, worse or no-effect by the after-mean against centre ∓ 2.66·mR̄/√n
- lead is tested on the log scale
- below 3 samples inconclusive; any guard breach worse, whatever the samples
- none on a calm window
- lead beyond its upper limit on 2 samples, only when lead is not the metric
- rework and first-run reds: one more per three merges
- an obligation un-held, and cost per merge above the before-window's upper limit, in FLOW_GUARDS order

`test/flow-spc.test.ts`:

- centre is the mean, the limit the mean plus 2.66 mean moving ranges
- seeds from the newest 20 points of completed arcs on an equal host, oldest first, naming the arcs
- self-seeds from the first five merges when previous arcs give fewer than five; none before five
- zones: green up to the centre, yellow up to the limit, red above
- rule 1: the latest point or an in-flight age above the limit is buffer-red
- rule 2: two of the last three beyond 2σ, the latest among them, is yellow-worsening; one alone is common cause
- the chart zones the recent points and the in-flight ages

Other removed cases (same §8 authorization):

- `test/serial/evals-m4a.test.ts`: evals-m4a.flow-loop: arc 1 proves a bait changed and applies the plant lane at six files a time with an improved verdict; arc 2 carries it and rejects a build-class step.
- `test/serial/pipeline-matrix.test.ts`: straight, bumpy and holistic crash cells at flow.series-before-completed (three cases). Their other crash cells remain.

Flow-only assertions removed from surviving mixed cases (same §8 authorization):

- `test/m4b-schemas.test.ts`: routing role-set case retained: preserve legacy revision, class binding and every provenance/refusal assertion; update only retired flow-seat activation, hashing and rebind expectations.
- `test/m4b-schemas.test.ts`: “the revision source, hold cause and proof spawn arms; the flow commands”: flow-command parsing assertions only.
- `test/prompts.test.ts`: prompts.every-supported-seat-renders: replace the deleted flow seat expectation with an assertion that flow is never seated; retain every other role/render/schema assertion.
- `test/routing.test.ts`: routing.rev-stable: exclude the retired flow seat from the active-seat hash-change loop.
- `test/status.test.ts`: “no-owner when nothing has run: every field present, nothing to report”: remove flow:null.
- `test/status.test.ts`: “after a completed run: state, owner, units, spend by role and by model, containment and its narrowed guarantee”: remove the flow field from the expected key set.
- `test/serial/evals-m4a.test.ts`: evals-m4a.fake: remove flow-proposal wake/rejection and flow-revision-notice assertions.
- `test/serial/evals-m4a.test.ts`: evals-m4a.vision-silent: remove the flow-ended/wait-for-flow assertions and flow-constraint criterion.
- `test/evals-m3.test.ts`: evals-m3.setup-valid: remove the one-flow-run count; preserve all unit, smoke, review, audit, checkpoint and product assertions. The fake repair no longer waits for the deleted flow job.

The shared `flow-series-per-completion` oracle and two flow-specific matrix rows retire with their feature; every other oracle assertion remains. Scripted M4a flow requests/steps retire with it. Removed paid probe scenarios (same §8 authorization): `evals/probe.ts` m4b.flow (including m4b.flow.answer) and m4b.proof. Neither was run.
