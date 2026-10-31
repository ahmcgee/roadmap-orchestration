P3(c) implements grounded builders, conditional Opus verifier modes, merged milestone experience verdicts, and fresh whole-range campaign audits. Checkpoint amendment execution is removed; audits report findings and root requests. Gate standing items require evidence-backed dispositions, and settled-finding re-raise refusal remains.

M1–M4 are mechanical annotations. M4 uses the isolated 8-build/20-judged-stage signal and moves subsequent default-profile builds to Claude. Diagnosis carries attempt details and evidence locations into kept build notes. `review: always|never` controls review seats. M2 and design units stay on Claude; M1 and capture-only units remain Codex-eligible. Effective builder fallbacks have distinct routing revisions, so historical role usage resolves correctly. A real mid-arc claude-only → default switch is covered.

Both builder prompts share a base and six mechanically selected method modules, each ≤3 KB. Static Claude system text: builder 4,769 B; verifier 3,610 B; experience 1,754 B; audit 1,043 B. Contract documents remain unit changes; system notes are explicitly non-normative memory. Role-eval inputs and fake fixtures use the new shapes; no paid eval ran.

Verification: IN PROGRESS. `npm run typecheck` passes. The 197-file non-serial batch recorded 2,767 passes, 2 failures and 1 NOT RUN; corrected gate/routing whole-file batches passed 49/49 and 41/41. Additional method/audit checks passed 36/36; harness 24/24; catalog 9/9. Locked reruns passed recovery 108/108, timing 54/54, and fixtures/status 28/28. Concurrent matrix: 457/457. Pipeline: 304 passes/11 failures from a fixture queued-record race, now synchronized; full rerun queued. M4a: 10 passes/13 failures from malformed fixture wires, now corrected; full rerun queued. Other completed serial files: calibration 1/1, default-size 1/1, browser 3/3, reflow 1/1. Upgrade, pool/probe/resource recovery and pressure remain queued. `contain.cgroup-real`: NOT RUN, never counted as a pass. No paid eval ran.

Added 16 focused agent-surface cases. The removal inventory below contains 176 individually enumerated named cases (including expanded parameters), plus 34 retired matrix label groups. Generic revision, item-publication, recovery and lane assertions remain; fixture stories now use root CAS apply and current roles. Context-overflow annotation and gate schema cases were migrated. Method-wording checks became input/schema invariants per the task prompt rules. No push, version bump, paid eval, or P4 prose changes.

Removed-test list (excluded from the 500-word report limit)

All paths below are relative to `plugins/roadmap-orchestrator/executor/`. Plan quotations refer to the fully read design delta, 2026-10-31. Each case names its deletion authority.

- **[C]** Agent surface decisions: “drop rolling per-merge lenses; one fresh-context whole-range audit per milestone”. Fable §1: “campaign audit ... replacing lens + checkpoint ... checkpoint BundleOp machinery deleted; root amends via apply --reason”.
- **[P]** Owner sign-off: “plan-check retired as a seat (split/scaffold/poc are root decisions)”.
- **[S]** Fable §4: “delete changedPaths, lanesRun, docsOnlySince (+ docs-only path and verifier role), unreviewed, defect-class refusal”.
- **[L]** Fable §6: “removed from seat inputs” (rulings ledger).
- **[R]** Profile strategy: “a mid-arc profile switch must be a supported, plain routing change”.
- **[A]** Owner sign-off: “pre-build marker review ANNOTATES”.

`test/adapter.test.ts`

- [S] legacy lanesRun is accepted only for builds whose schema no longer declares it; other fields stay strict

`test/amendments.test.ts`

- [C] checkpoint.corpus-inputs: the inputs name the pin in force; the checkpoint and the lens read the materialised pin
- [C] amendment.from-checkpoint: the checkpoint's own proposals are amendments keyed (job, index)
- [C] amendment.from-divergence: code derives one per interpretation (and target-departed) divergence, none for a plan departure
- [C] settling again writes nothing more
- [C] amendment.canonical-rule-order: amendments citing T-42 and T-120, in either order, are recorded ascending by number
- [C] checkpoint.finding-deferred-banked: a deferred P2 without an obligation is banked as finding-deferred debt once; one with an obligation never is
- [C] tail.p3-released-arc (dev.13): a P3 the checkpoint defers or leaves is released by code, never banked; a deferred P2 banks; status counts them
- [C] bundle.split-rule-anchored: a split child anchored at a rule takes its hash from the pin in force and is counted through its parent's census entry; an unpinned rule is invalid
- [C] settlement crashed at B4 amendment.after-decided#1: the decision durable and some of its amendments written: the next run settles it…
- [C] settlement crashed at B4 amendment.after-decided#2: the decision durable and some of its amendments written: the next run settles it…
- [C] settlement crashed at B4 amendment.after-decided#3: the decision durable and some of its amendments written: the next run settles it…

`test/audit.test.ts`

- [S] cadence.triggers: every trigger the log holds is owed and coalesces into one audit-started; N counts unit publications, never a docs-only one
- [C] cadence.exempt-not-unwitnessed (R8, field fix 2026-10-24): a publication selecting deferred, waived or retired obligations left unwitnessed owes no trigger for them; an active future one still does
- [C] cadence.exemption-after-memo: waived removes a previously cached unwitnessed trigger in the same process
- [C] cadence.exemption-after-memo: deferred removes a previously cached unwitnessed trigger in the same process
- [C] cadence.exemption-after-memo: retired removes a previously cached unwitnessed trigger in the same process
- [C] cadence.latch-after-memo: completing a future obligation removes the earlier publication's cached unwitnessed trigger
- [C] cadence.drift-throttled (field fix 2026-10-24): while work remains, drift within DRIFT_THROTTLE_MIN of the latest audit start is owed but runs no audit; once the period passes, or with another fresh trigger, one audit records every drift
- [C] cadence.empty-coverage-and-wall-clock: ordinary triggers need an outstanding selected range; requests and semantic drift inspect an unchanged head; the timer needs a publication since the latest audit started
- [C] cadence.final-outstanding-lenses (H9): with no work left, the final audit runs exactly the lenses in L with an outstanding range
- [C] audit.coverage: an audit covers each lens it ran from its watermark to the audited SHA, its lanes observed there; a lens it did not run keeps its watermark
- [C] audit.one-call-per-lens (paid M4a run 10, R-16): an audit asks each lens of its plan exactly once, the vision first; the spawn's attempt is the lens's ordinal in that order, never a retry
- [C] audit.owed: an audit owed for 2 × the wall-clock period, or for 2N publications, raises one non-blocking audit-owed per episode
- [C] cadence.spec-only-bundle-vision-lens-only: a bundle revision changing only a unit's spec records drift{specsOnly} and runs the vision lens alone over that spec; the code lenses keep their watermarks
- [C] cadence.obligation-bundle-full-drift: a bundle revision changing the obligations drifts fully (L ∩ {drift, vision}), its lenses reading the whole tree
- [C] audit.cross-lens-merge-corroborated: a second lens's draft with the same repo evidence paths, obligation and cause corroborates the first lens's finding (its claim kept), opening none; a resumed audit writes it once
- [C] audit.cross-lens-different-cause-separate: drafts differing in cause or in repo evidence paths stay separate findings; a vacuity draft whose mutant cannot be made is refused at admission, recorded, asked once more, and takes the repair turn in its own session; refused again it leaves its lens uncovered (findings.mutant-refused)
- [C] audit.range-chunked: a range over the budget is reviewed chunk by chunk in one audit; a lens failing a later chunk keeps what it reported, and the next audit drains the rest

`test/checkpoint-rev3.test.ts`

- [C] bundle.decision-persists-conversions: an unrelated admit converts beside an applied op: the revision's source holds the classes and conversions, the amendment follows
- [C] bundle.opportunity-joins-advances: honest work outside the slice, with its witness, is opportunity O-1; its clause joins holistic.advances in the same revision
- [C] bundle.opportunity-unwitnessed-converts (paid M4b runs 3 and 5): an opportunity with no obligation its unit delivers converts unwitnessed, spends no budget, and the rest applies
- [C] bundle.admit-targets-checked (LR-m): a declared out-of-slice target without an out-of-slice cite is invalid; the honest retry is O-1
- [C] bundle.all-converted-no-op: a bundle whose only op converts is a no-op carrying its conversions; its amendment follows; no revision
- [C] bundle.recovery-no-reclassify: killed after the commit, then the slice changes: settlement reads the recorded conversion, never classifies again
- [C] bundle.follow-up-overrun-converts-with-debt (LR-k): O-1 merges; a finding on its code; the first repair follows O-1 up, the second converts with an amendment and a debt item naming O-1
- [C] admits.architecture-doc-arc-unclassified (LR-h): an architecture-doc arc's bundle records no admit classes
- [C] bundle.split-census-out-of-slice-moved: a child anchored at an out-of-slice rule, serving the slice, moves that rule's census to the child
- [C] bundle.split-census-other-state-reason: a child anchored at an untestable rule is invalid, naming the rule, its state and the fix
- [C] checkpoint.schema-closed-ids (paid M4b run 5, ckpt-4): the call's schema enumerates the arc lanes and obligations, so a split child on a lane that is no arc lane is a schema violation of the answer, never a bundle
- [C] bundle.busy-live-attempt / checkpoint.busy-waits-for-boundary / classify.open-attempt-running-vs-abandoned
- [C] checkpoint.busy-redecide-stale-falls-back (arc feedback 2026-10-24): a held bundle the arc moved under is decided stale at its re-decide, with no call; the trigger then asks a fresh call
- [C] checkpoint.capture-waits-for-publication: a due checkpoint captures nothing while a unit is at gate or approved before its candidate; it captures the head the unit published
- [C] checkpoint.capture-waits-for-plan-check (R-20): a due checkpoint captures nothing while a unit is in plan-check, which may patch a spec it reads; it captures once the plan-check decides
- [C] checkpoint.capture-wait-bounded: a trigger that has waited CAPTURE_WAIT_MAX_MIN captures with the publication still in flight
- [L] checkpoint.manifest-content-addressed / checkpoint.specs-embedded-with-occupied-ids / checkpoint.next-ruling-id
- [C] checkpoint.skipped-nothing-new (arc feedback 2026-10-16): after a settled checkpoint, an audit that finds nothing new has no checkpoint call: checkpoint-skipped records why, its generation is quiescent and status lists it; an audit opening a finding has its checkpoint again
- [C] checkpoint.refused-carried-across-triggers (paid M4a run 12): a later trigger's checkpoint reads the proposals refused under the plan rev and why; a new plan rev drops them
- [C] checkpoint.resumed-equal-capture: an older captured audit job settles through checkpoint-skipped at an equal decided snapshot, with no call and no repeated settlement
- [C] checkpoint.final-unchanged-skipped: a decided checkpoint at the same head, plan, vision and active findings suppresses the final call; a new plan rev still receives its final checkpoint
- [C] bundle.merged-since-capture-stale: a spec op on a unit that merged after the checkpoint captured is stale (naming the unit), not invalid
- [C] bundle.merged-at-capture-invalid: a spec op on a unit already merged at capture stays invalid (the model was shown it merged)

`test/checkpoint.test.ts`

- [C] bundle.no-op: a no-op decides once, writes no revision, and makes its generation quiescent
- [C] noop.interpretation-divergence (H12): an interpretation-only no-op records its divergence (job, 0), no revision, still quiescent; the digest binds it
- [C] bundle.partial (A18): a two-op bundle whose second op is invalid applies neither; the trigger re-evaluates once; a second invalid bundle goes to the owner
- [C] bundle.stale: an architect apply between capture and activation that changes the plan rejects the plan-touching bundle whole; the re-evaluation applies
- [C] apply.warns-running-checkpoint (dev.17, arc feedback 2026-10-23 item 8): an apply while a checkpoint runs is applied, never blocked, and its receipt warns that the checkpoint's bundle goes stale and its spend is wasted; with none running, no warning
- [C] checkpoint.superseded-by-plan-revision (paid M4b run 3, ckpt-7): an apply that changes the plan cancels the call in flight, which never finishes; the job decides stale and the re-capture on the new rev reads why
- [C] bundle.vision-always-read (H3): a vision revision between capture and activation rejects a bundle that touches no vision-derived artifact
- [C] bundle.finding-closed-moot (paid M4b run 5, ckpt-2): a finding a publication resolves during the call leaves its disposition moot; the bundle applies, the finding stays resolved
- [C] bundle.finding-closed-rests-on-stale: a decision whose op names a finding resolved during the call is stale; the next job reads why
- [C] bundle.evidence-drift-witnessed (paid M4b run 3, ckpt-4): the head moves under the call to a tree no lane ran on; the cited lane is witnessed there before the activation, which applies the same decision with no second call
- [C] bundle.evidence-drop: a cited observation the moved head contradicts still rejects the bundle on its evidence; each later job of the trigger reads every rejection before it, with its reason and detail (paid M4b run 3)
- [C] bundle.repair-turn-applies: an invalid bundle goes back once to the same session with every reason; the corrected answer applies, no invalid decision recorded
- [C] bundle.draining-request: while draining, a bundle that admits becomes a non-blocking bundle request; acknowledged `apply`, the next job enacts it without asking again
- [C] bundle.nested-owner-only (H10): an admit whose lane runs a program no lane in force runs and passes a new env prerequisite raises one blocking owner request; nothing applies
- [C] bundle.owner-request-not-repeated (arc feedback 2026-10-24): a later checkpoint asking exactly an open request decides on that item and raises none; another request, or the same once answered, raises its own
- [C] bundle.withdrawn-cite-invalid (H16): an op citing a withdrawn clause is invalid
- [L] bundle.admit-widens-obligations (lead ruling, paid M3 run 5): a checkpoint admit whose spec omits an obligation the mapping selects for its scope applies, its declaration completed by code
- [C] bundle.lane-unrunnable-invalid (paid M4b run 3, OP-3): an admit whose lane cannot resolve its argv[0] on its own PATH is invalid through the apply core's lane row; nothing applies
- [C] convergence.bound-k: at K applied bundles one non-blocking convergence-bound is raised; while open the next bundle is a request; acknowledged, bundles apply again
- [C] convergence.bound-identity: a second material change of one causal identity (F-1 @ arc) becomes a bundle request and raises convergence-identity; units are not held
- [C] bundle.compensating: `reverse` of an applied bundle's divergence restores the plan it departed from, through the apply core
- [C] digest.binds-ids (H11): a digest binds the ids uncovered when raised; later divergences wait while it is open; its acknowledgement covers exactly its ids and the next digest binds the rest
- [C] divergence.preimage-no-inverse (H13): a spec patch's divergence records the spec rev it departed from and a hint, no inverse; `reverse` builds the compensation fresh
- [C] divergence.patch-of-introduced-unit (a real arc's crash loop): a bundle re-entering u1 as u1-r2 and patching u1-r2's spec applies; the patch departs from the plan rev, as the re-entry does
- [C] ckpt.park-diagnosis-and-unchanged-reentry (arc feedback 2026-10-16; dev.12): a park checkpoint reads the lineage's failures with their references; a re-entry naming no failure is refused, and the repair turn that cites the design park applies the re-entry unchanged
- [C] bundle.fault-decided: an exception judging a bundle is decided invalid, naming the fault, never crashing; the recorded output is not judged again and the trigger re-evaluates
- [C] ckpt.design-park-respec-first: a design park goes to the checkpoint first (its item held back); the respec applies; a second design park on the lineage raises respec-second
- [C] bundle.p1-left-to-repair: a checkpoint accepting a P1 is invalid; left undispositioned and named in an admitted repair's repairs, the bundle applies, the repair owns it, merges and resolves it
- [C] tail.settled-brake-arc: with every planned unit merged (no milestones), a repair admitted for a P2 converts settled-brake; the P2 is released by code; the checkpoint was shown the brake; status counts both
- [C] tail.repaired-accepted-arc: a P2 named in an admitted repair's repairs and disposed accepted in the same decision is not ruled; the repair owns it and resolves it when it publishes (m5 run 6, F-18)
- [C] ckpt.park-cause: a candidate-red park reaches the checkpoint as an executor-side cause, with the spent bound and the obligation its candidate left red, never as a design question
- [C] checkpoint crashed at B2 checkpoint.after-inputs: checkpoint-inputs durable, nothing asked: the job resumes as ckpt-1 from its rec…
- [C] checkpoint crashed at B2 checkpoint.after-inputs#2 (the arc's second checkpoint): checkpoint-inputs durable, nothing asked: the job resumes as ckpt-1 from its rec…
- [C] checkpoint crashed at B4 checkpoint.after-call: the call read, nothing decided: the job resumes, consumes the recorded call (no …
- [C] checkpoint crashed at B4 checkpoint.after-call#2 (the arc's second checkpoint): the call read, nothing decided: the job resumes, consumes the recorded call (no …
- [C] checkpoint crashed at B4 bundle.after-decided: decided (a no-op) or applied, its aftermath not written: the next run settles it…
- [C] checkpoint crashed at B4 bundle.after-decided#2 (the arc's second checkpoint): decided (a no-op) or applied, its aftermath not written: the next run settles it…
- [C] checkpoint crashed at B4 bundle.after-applied: decided (a no-op) or applied, its aftermath not written: the next run settles it…
- [C] checkpoint crashed at B4 bundle.after-applied#2 (the arc's second checkpoint): decided (a no-op) or applied, its aftermath not written: the next run settles it…
- [C] checkpoint.checkout-reused-after-two-crashes: a checkpoint killed in its call twice is asked a third time on a checkout made afresh

`test/closeout.test.ts`

- [C] closeout.declined-ack-refused: an ack of an item the executor declined is rejected, and nothing is written

`test/design.test.ts`

- [P] design.record-lands: an approve lands its pinned design record on the spec's next revision, by the plan-check's own patch
- [P] design.unmapped-repair: a failure mode proven by no lane the unit has is refused through the repair turn; the corrected answer approves
- [P] design.reachability-defect: a test item in a lane the design's systems never select is a plan defect: the repair turn, then an uncharged park
- [P] design.clause-unexercised: a clause exercised only by a lane that cannot run before the unit merges is a plan defect: the repair turn, then an uncharged park naming the fixes
- [P] design.clause-unnamed: a clause no lane is named for is refused through the repair turn; the answer naming a runnable lane approves
- [P] design.oversize-split: an oversize design is refused; the split of mixed concerns lands as one revision, skeleton first, the dependent on both children
- [P] design.split-systems: a declared child system outside its parent is a plan defect
- [P] design.split-defect: a split whose children do not partition the parent's items is refused twice: an uncharged plan-defect park
- [P] design.scaffold-not-in-force: a scaffold decision in an arc of an earlier role set is refused through the repair turn
- [P] design.poc: a PoC builds in a throwaway checkout, its report goes to a fresh plan-check, a third is refused, and the build gets the lessons
- [P] split.crash.split.after-hold: the restart lands the split once from the recorded answer, never asking again
- [P] split.crash.split.after-commit: the restart lands the split once from the recorded answer, never asking again
- [P] poc.crash.poc.after-report: the next attempt records the PoC from its report; the builder is asked once, its checkout gone
- [P] poc.crash.poc.after-cleanup: the next attempt records the PoC from its report; the builder is asked once, its checkout gone
- [P] split.revision-race: a concurrent revision is preserved, the split retries and emits a nonblocking revision notice

`test/dispatch.test.ts`

- [P] dispatch.risk-raise: a plan-check that raises the risk records a new dispatch fact; every later seat follows it

`test/evals-m3.test.ts`

- [C] evals-m3.partial-bundle (A18, G19): the two-op bundle whose second op is invalid applies neither; its one re-evaluation applies the admit alone
- [C] evals-m3.tamper-digest: a digest the driver did not acknowledge fails divergence-digest-bound
- [C] evals-m3.prevented: branch P (as paid run 3); tidy is stopped upstream and cut, the repair merges, the arc completes, and every criterion passes

`test/lifecycle.test.ts`

- [R] reroute.routing-changed-park: resume is rejected while the implementer seat stays moved; once its routing is restored, resume re-pins the unit and re-enters it at the stage it parked at, no spec edit

`test/m4b-schemas.test.ts`

- [C] checkpointIdsOf: the arc lanes, the active obligations a split may name, every obligation a dispose may name; none outside an arc with obligations
- [C] an unknown witness lane, a split of an obligation not active, a dispose of one not in force: schema violations; the known ones conform
- [C] no ids known (null, or an empty set): any id, the prompt module's schema; the bundle's validation refuses an unknown one

`test/polish-loop.test.ts`

- [C] checkpoint.walk-trigger: a walk P1 nobody weighed triggers the checkpoint, its evidence dir readable and named; once weighed, nothing is due
- [C] checkpoint.walk-trigger: a walk P2 nobody weighed triggers the checkpoint, its evidence dir readable and named; once weighed, nothing is due

`test/repair.test.ts`

- [P] findings.plan-check-vision-conflict: each vision conflict opens a P3 plan-check finding from its attempt, never a redirect by itself; a re-check reporting it again merges; a conflict citing no active clause is malformed
- [P] plancheck.reads-captured-spec: an exported evidence edit auto-bumps pending revision; the captured redirect patches its pinned spec without overwriting that pending edit

`test/report.test.ts`

- [S] report.claude-legacy-lingers: a reported answer with removed lanesRun is refused by the current reader
- [S] report.codex-legacy-lingers: a reported answer with removed lanesRun is refused by the current reader

`test/review.test.ts`

- [S] review.defect-required: a blocking finding without a defect is refused through the repair turn; the repaired one enters the ledger open
- [S] review.docs-only-code: a fix that adds only whole-line comments, claimed docs-only since the certified tree, carries the lane passes over by code alone; a lane reading comments runs again
- [S] review.docs-only-verifier: a doc comment code cannot clear goes to the verifier (role verifier, Haiku), which clears it; the passes carry over
- [S] review.docs-only-template-literal: a comment-looking line added inside a multi-line template literal is no comment; code leaves it to the verifier
- [S] review.docs-only-code-certain: code clears a comment hunk only on a lexer pass it is certain of; strings spanning lines, heredocs, configuration comments and Go example output go to the verifier
- [S] review.docs-only-refused: the verifier finds a behaviour change; the claim is refused and the lanes run as normal, uncharged

`test/roles-gate.test.ts`

- [S] roles.unreviewed: the gate's claimed unreviewed parts beside what it really looked at; silent = not-inlined files neither read nor declared

`test/roles-scaffold.test.ts`

- [P] roles.scaffold-cells: four cells over four families; each reference skeleton lies within its new system, its test paths and its manifest files, holds every entry point and names the load test; no cell names the eval
- [P] roles.scaffold-summary: each run lands 3/4 or better, half first-try, voids at most a quarter, holdout gap; refusals classified by code's reasons
- [P] roles.scaffold-fakes: an oracle writer lands every cell first-try through the production scaffold stage; fix-on-retry lands on the retry, told why; outside and nothing park plan-defect and fail
- [P] roles.scaffold-caps: --trial-cap kills an overspending writer (void cap, its estimate kept); --cap starts no trial past the spend
- [P] roles.scaffold-seat: the arm is the scaffold seat (economy, Haiku 5.5 high); --rebind moves it through the repo config; a seat with no scaffold prompt is refused
- [P] roles.scaffold-triggers: the scaffold prompt, stage and eval trigger the scaffold eval alone; the shared harness and routing every role

`test/roles-verifier.test.ts`

- [S] roles.verifier-cells: unique ids, every family, clear and not-clear keys; each key names one expectation per hunk of the diff; every hunk is one code leaves to the verifier; no file names the eval
- [S] roles.verifier-summary: no false accept, false refusals within the bar, stability, voids, holdout gap; false accepts and refusals counted per trial and per hunk
- [S] roles.verifier-fakes: through the production docs-only check, an oracle passes; clear-all false-accepts every not-clear cell; refuse-all false-refuses every clear one
- [S] roles.verifier-caps: --trial-cap kills an overspending verifier (void cap, its estimate kept); --cap starts no trial past the spend
- [S] roles.verifier-arm: the arm is the verifier seat (economy, Haiku 5.5 high); --rebind moves it through the repo config; a Codex seat is refused
- [S] roles.verifier-triggers: the verifier's prompt, the docs-only check and its eval trigger the verifier eval alone; shared paths every role

`test/scaffold.test.ts`

- [P] scaffold.commits: the scaffold writer's skeleton passes code's checks and the dry run, and is the unit's first executor-authored commit
- [P] scaffold.refused-then-fixed: a skeleton missing an entry point is refused; the retry, told why, passes
- [P] scaffold.plan-defect: a load test that fails its dry run twice parks the unit plan-defect, uncharged, with nothing committed
- [P] scaffold.crash.scaffold.after-commit: the next attempt finds the committed skeleton and records it, the writer asked once

`test/scheduler-m3.test.ts`

- [C] sched.declined-request-quiescent (paid M3 run 5): an invalid-twice bundle request acknowledged without `apply` ends its trigger's decision; the generation is quiescent and close-out and completion follow
- [C] sched.close-out-declines-request (run 10, E): an unanswered non-blocking bundle request never holds completion: the close-out declines it (no amendment outside a corpus arc), then publishes and completes
- [C] sched.design-park-checkpoint (OR-Q1): a design park goes to the checkpoint with its item held back; a respec re-opens the unit; its second design park raises respec-second
- [C] sched.design-park-no-op (OR-Q1): a checkpoint that decides nothing for a design park raises the park's own item after its decision

`test/serial/pipeline-matrix.test.ts`

- [C] admit conversions: a follow-up overrun's settlement crashed at each of the row's labels settles once from its decision record

`test/stages.test.ts`

- [P] stages.redirect-then-approve: a redirect patches the spec (rev+1), a fresh session re-checks and approves
- [P] session.plan-check-repair: a refused answer goes back once, in the same session; refused again it is malformed, and the retry is a new session
- [P] redirect.no-widen: a redirect that widens the envelope or lowers the risk is refused and routes up
- [P] plan-check.checkouts: the judge reads a detached checkout of the tip and one of the unit branch, both removed once read; its approving notes reach the build
- [P] plan-check.prior-round: after its applied redirect, the next check gets the patch, the premises and the premise files changed since
- [L] plan-check.cites: a redirect may add a ledger ruling to the cites, which the next check embeds in full; an unknown cite is malformed
- [L] library.withdrawn-not-embedded: a cited ruling that is withdrawn is never embedded in full; its id is indexed as withdrawn

`test/status-rev3.test.ts`

- [C] status.checkpoint-busy-wait: a checkpoint rejected busy shows "waiting for <unit> <stage> boundary" until the attempt closes
- [C] status.drift-indicator / brief.admits-and-opportunities: an oversight, an opportunity and a converted admit; a finding outside the slice on the oversight's merge is drift, a mixed one is not; the brief carries the admits, the opportunity, the drift and the converted admit under its amendment

`test/walk-job.test.ts`

- [C] checkpoint.milestone-boundary: K=default 2 counts retired milestones after their walks; a P2 checkpoints audit and walk findings immediately without resetting the interval
- [C] checkpoint.milestone-boundary: K=1 counts retired milestones after their walks; a P2 checkpoints audit and walk findings immediately without resetting the interval
- [C] checkpoint.milestone-equal-snapshot: an immediate P1 walk checkpoint weighs accumulated audit findings without consuming milestones; its equal milestone boundary is skipped and settles once
- [C] checkpoint.milestone-equal-snapshot: an immediate P2 walk checkpoint weighs accumulated audit findings without consuming milestones; its equal milestone boundary is skipped and settles once
- [C] checkpoint.walk-vision-edit: a decided walk trigger reopens under a revised vision, after a clean drift audit
- [C] checkpoint.walk-vision-edit: a skipped walk trigger reopens under a revised vision, after a clean drift audit
- [C] checkpoint.final-before-quorum: the final audit gets its checkpoint when fewer than K milestones retired
- [C] checkpoint.final-capture-before-retirement: an ordinary audit covering the final head waits for the last walk, then checkpoints its findings even below K
- [C] checkpoint.audit-p1-escape: a milestone arc checkpoints an unweighed audit P1 immediately, before any milestone retires
- [C] walk.deviation-loop: P2 checkpoints below K, admits a repair, holds the round until it merges, and re-walks merged code

`test/walk.test.ts`

- [C] brake.checkpoint-pending: an open P1 finding of the round waits for a checkpoint that weighed it (captured it, decided, under the vision in force); one that admits nothing settles it
- [C] brake.checkpoint-pending: an open P2 finding of the round waits for a checkpoint that weighed it (captured it, decided, under the vision in force); one that admits nothing settles it
- [C] brake.checkpoint-pending: an open P3 finding of the round waits for a checkpoint that weighed it (captured it, decided, under the vision in force); one that admits nothing settles it

`test/audit.test.ts`

- [C] audit crashed at B3 audit.after-lens#2 (the former second lens)
- [C] audit.chunk-crash-resume: crashed at the runner exit of chunk 2's call, the job resumes and asks no chunk twice

`test/blocker-wake.test.ts`

- [P] blocker.plan-check: an adopted ordering park wakes only after all blockers merge; an unrelated design park stays parked

`test/closeout.test.ts`

- [C] CLOSE_OUT_SETTLEMENT B4 closeout.after-request-amendment#1

Retired dynamic crash cells, all [C]. These are parameterized cell families; fact-specific log occurrences are identified by their original owner and fact kind. The generic labels remain exercised in surviving rows.

- `test/serial/concurrent-matrix.test.ts`: the removed `bundle` row, owner `job:ckpt-1`; every former sampled occurrence for each label below (log append labels expand over each checkpoint-owned non-meter fact).

CONCURRENT_BUNDLE

- [C] B1 log.append.before-write
- [C] B1 log.append.after-partial-write
- [C] B2 log.append.after-fsync
- [C] B2 checkpoint.after-inputs
- [C] B2 revision.commit.after-intent
- [C] B2 needsuser.raise.before-publish
- [C] B2 worktree.create.act-start
- [C] B2 resource.after-intent
- [C] B2 spawn.after-intent
- [C] B2 evidence.act-start
- [C] B2 worktree.remove.act-start
- [C] B3 plan.apply.after-inputs
- [C] B3 worktree.add.inside
- [C] B3 launch.after-launch-json
- [C] B3 launch.after-spawn
- [C] B3 worktree.remove.inside
- [C] B4 checkpoint.after-call
- [C] B4 revision.commit.after-fact
- [C] B4 bundle.after-applied
- [C] B4 needsuser.raise.after-publish
- [C] B4 spawn.after-runner-exit
- [C] B4 spawn.after-result
- [C] B4 spawn.after-usage
- [C] B4 evidence.act-end
- [C] B5 resource.after-done
- [C] B5 spawn.after-done

PIPELINE_HOLISTIC

- [C] B2 checkpoint.after-inputs
- [C] B4 checkpoint.after-call
- [C] B4 bundle.after-applied
- [C] B4 bundle.after-decided
- [C] B4 amendment.after-decided
- [C] B4 bundle.after-conversion-amendment

ADMIT_CONVERSIONS

- [C] B4 bundle.after-conversion-amendment
- [C] B4 bundle.after-overrun-debt

The holistic pipeline also drops samples whose context is `job:ckpt`, and log samples of retired checkpoint/divergence/corpus-amendment facts. Its remaining generic `plan.apply`, `revision.commit`, and `needsuser.raise` labels are restored with root CAS apply and a nonblocking builder split proposal. Audit whole-range call recovery remains covered; only the second-lens and second-chunk instances disappeared.
