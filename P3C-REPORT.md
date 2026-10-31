P3(c) implements grounded builders, conditional Opus verifier modes, merged milestone experience verdicts, and fresh whole-range campaign audits. Checkpoint amendment execution is removed; audits report findings and root requests. Gate standing items require evidence-backed dispositions, and settled-finding re-raise refusal remains.

M1–M4 are mechanical annotations. M4 uses the isolated 8-build/20-judged-stage signal and moves subsequent default-profile builds to Claude. Diagnosis carries attempt details and evidence locations into kept build notes; `diagnosisDue()` is the P3b attempt-source adapter. `review: always|never` controls review seats. M2 and design units stay on Claude; M1 and capture-only units remain Codex-eligible. Effective builder fallbacks have distinct routing revisions, so historical role usage resolves correctly. A real mid-arc claude-only → default switch is covered.

Both builder prompts share a base and six mechanically selected method modules, each ≤3 KB. Static Claude system text: builder 4,769 B; verifier 3,610 B; experience 1,754 B; audit 1,043 B. Contract documents remain unit changes; system notes are explicitly non-normative memory. Role-eval inputs and fake fixtures use the new shapes; no paid eval ran.

Verification: `npm run typecheck` passed in the executor package. A root-directory attempt found no package and ran no checks. The 197 affected non-serial files have **2,769 distinct passing cases and 1 NOT RUN**. The bulk run initially had 2,767 passes/2 failures/1 NOT RUN; corrected whole-file batches passed 49/49 and 41/41. Other final batches: methods/audit 36/36, harness 24/24, catalog 9/9. Locked timing reruns: recovery 108/108, timing 54/54, fixtures/status 28/28.

All 12 serial files passed individually under the shared lock: **921 tests**.

| Serial file | Passed |
| --- | ---: |
| `pipeline-matrix.test.ts` | 318 |
| `concurrent-matrix.test.ts` | 457 |
| `evals-m4a.test.ts` | 23 |
| `calibrate.test.ts` | 1 |
| `evals-m5-reflow.test.ts` | 1 |
| `walk-browser.test.ts` | 3 |
| `upgrade.test.ts` | 1 |
| `pool-crash.test.ts` | 37 |
| `probe-crash.test.ts` | 16 |
| `resource-recover.test.ts` | 62 |
| `pressure.test.ts` | 1 |
| `roles-default-size.test.ts` | 1 |

Earlier runs: migration batch 2,639 passes/106 failures/9 cancellations/1 NOT RUN; concurrent 283 passes/174 failures; pipeline two enumeration failures, then 304 passes/11 failures from the queued-record race; M4a 10 passes/13 failures, then 20 passes/3 failures. The listed final reruns are green. `contain.cgroup-real` is **NOT RUN**, never a pass. No paid eval ran.

Added 16 focused agent-surface cases. The removal inventory below contains 168 individually enumerated named cases after the restorations and retained-case correction recorded below (including expanded parameters), plus 34 retired matrix label groups. Generic revision, item-publication, recovery and lane assertions remain; fixture stories now use root CAS apply and current roles. Context-overflow annotation and gate schema cases were migrated. Method-wording checks became input/schema invariants per the task prompt rules. No push, version bump, paid eval, or P4 prose changes.

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
- [C] bundle.busy-live-attempt / checkpoint.busy-waits-for-boundary
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

Surviving `evals-m4a.fake`, `.brief`, and `.opportunity` cases now check root apply confirmation and empty checkpoint artifacts. Their checkpoint-only digest/amendment subassertions were replaced under [C]; debt, chain, witness, pause/reuse, and root-apply ordering assertions remain.

P3c audit fixes

The pre-audit verification above is historical; this section records the continuation. Deleted the plan-check decision pipeline, scaffold and PoC stages, checkpoint runner and no-op callers, retired prompt directories, output readers and seats. Pre-build is a conditional verifier annotation; unmarked units start at build, including recovery of a completed first call. Root `apply` now exercises retained design pin/reachability/clause/verification checks and split validation; the held split proposer path is gone.

Fix rounds render findings with their evidence and experiments, failing lane evidence, notes, remaining certification allowance and chargeable/build/stage counts. The base-comparison slot is rendered as null until P3b supplies it. Cheap probes name live roles and actual seats. The free M4a scenario supplies plan risk to its fake-step translator, so its high-risk confirmation build uses Claude in both profiles. Verifier prompt/schema/method changes trigger gate-mode and pre-build evaluations. Pre-build and campaign audit each have three dev cells; both CLI dry-runs passed all nine trials without backend calls.

Added or restored **26 cases**: seven audit regressions, eleven design cases, the routing park/resume case, two direct-build recovery crash cases, and five free surface-eval harness cases. Restored the original park assertions for dispatch, route and executor routing changes. The concurrent matrix now races root `command.apply`, `revision.commit` and `needsuser.raise` against live builders. The row spans campaign-request publication and root apply's priority edit and subject closure while both builders remain live.

Audit verification: `npm run typecheck` passes. All **208 non-serial files** ran via `node --test --test-concurrency=4 test/*.test.ts`: 2,799 tests, 2,797 passes, one status-fixture failure and one cgroup NOT RUN. The corrected whole status file passes 9/9, giving **2,798 distinct passing cases and one NOT RUN**. The fixture explicitly marks both review-dependent units `review: always`; every assertion survives. Final whole-file supplements pass: retained-suite cohort 139/139, judge validation 4/4, evidence 9/9, matrix index 6/6 and free eval fixtures 41/41 and 22/22. The locked timing rerun passes 36/36 (apply execution, scheduler and executor), including the earlier timeout and routing park failures.

All **12 serial files pass individually under the shared lock: 937 tests**, zero failures, cancellations or skips. The concurrent run covers 472 crash cells (120 job cells), 16 more cells than the pre-audit run. Both matrices passed again after the shared oracle was updated to require an open root apply to reconcile its receipt and subject closure.

| Serial file | Passed |
| --- | ---: |
| `pipeline-matrix.test.ts` | 318 |
| `concurrent-matrix.test.ts` | 473 |
| `evals-m4a.test.ts` | 23 |
| `calibrate.test.ts` | 1 |
| `evals-m5-reflow.test.ts` | 1 |
| `walk-browser.test.ts` | 3 |
| `upgrade.test.ts` | 1 |
| `pool-crash.test.ts` | 37 |
| `probe-crash.test.ts` | 16 |
| `resource-recover.test.ts` | 62 |
| `pressure.test.ts` | 1 |
| `roles-default-size.test.ts` | 1 |

Earlier audit runs: the first pipeline and concurrent attempts each failed reference/enumeration before cells ran. The next concurrent run had 468 passes/5 failures (four root-command oracle cells and the parent); its final rerun passes 473/473. M4a progressed from 12 passes/11 failures (high-risk fixture still on Codex), to 20/3 (retired pre-build response causing a repair call), then 22/1 (a late `ruler-changed` notice alongside `units:held`). The unchanged locked timing rerun passed 23/23; the wake assertion was retained unchanged. Exploratory non-serial runs had 2,288 passes/63 failures/10 cancellations/one NOT RUN, then 2,776 passes/20 failures/one NOT RUN; the final batch and corrected whole-file reruns above replace them. No paid eval/probe, push, version bump or P4 prose change. `contain.cgroup-real` remains NOT RUN.

Removal inventory correction: seven earlier named removals are restored/adapted: `design.record-lands`, `design.unmapped-repair`, `design.reachability-defect`, `design.clause-unexercised`, `design.clause-unnamed`, `design.oversize-split`, and `reroute.routing-changed-park`. The original inventory also incorrectly listed `classify.open-attempt-running-vs-abandoned`; it remains covered in `revision-evidence.test.ts` and is excluded from the removal count. The retained split-system guard is tested through root apply. Seven evidence-comparison cases moved from `checkpoint-rev3.test.ts` to `revision-evidence.test.ts`; their assertions survive. Two full-spec wire cases now exercise experience-verdict proposals. Mutant/witness schema assertions and witness-draft assertions survive; only the retired vision-conflict/capture arms were removed.

The corrected phase inventory is **204 removed named cases** (168 earlier + 36 audit removals), plus **49 deleted transition-row assertions**. The earlier 34 retired dynamic matrix label groups remain enumerated above. This audit also removes 11 obsolete row descriptors from the canonical matrix index; the root-apply concurrent row replaces the old bundle family's generic revision/item crash coverage. These categories overlap in feature coverage and are not summed as test-run counts.

Additional named removals (all paths relative to the executor):

`test/prompts.test.ts`

- [P] planCheck: patch only with redirect; lane env.set converts to the spec map
- [C] the checkpoint conveys OR-V: steer to the vision, cite V-n plus evidence per op, optimistic interpretations, owner-only acts only as requests
- [C] the checkpoint lists the ruling sidecar's required schema value and every closed enum from the reader's constants (paid m3 run 7: invalid rulings twice)
- [C] the checkpoint never accepts, defers or releases a P1: dismissed, or left to the repair that names it (paid m3 run 9; dev.13 released)
- [C] the checkpoint states anchors as anchorSection reads them: #<heading-slug> or literal text on exactly one line (paid m3 run 9)
- [C] the lens prompt carries exactly one `lens: <kind>` marker, and each kind its own brief
- [P] pre-build (R17): the vision as read-only context, and visionConflict never a redirect by itself
- [P] prompts.stale-links (dev.17 propagation): the pre-build is given its stale links, each by its key, and answers them in a required staleLinks field
- [C] checkpoint corpus: amendments proposed for the next Phase 0; rule-anchored children and rulings; no issues section
- [C] checkpoint schema: corpusAmendments required of the model, issueIntake gone; a dev.6 answer without amendments is refused
- [P] pre-build: the failure matrix before a transaction ordering, earlier repairs carried in; clock and entry-point defects (F03, D3)
- [C] prompts.checkpoint-failure-matrix: a matrix of each step against process death before admitting an ordering repair, prior repairs of the transaction carried in, put in the spec
- [C] checkpoint admits (OR-A1, LR-k, LR-m, R35): code classifies from declared targets; honest citation; one opportunity, one follow-up; the rest converts to amendments
- [C] checkpoint inputs (H4, H5, C3, C6): the manifest, never live roadmap-inputs; every spec with its held ids; add vs replace; the next ruling id; the evidence note; the diagnosis right after a park trigger
- [C] prompts.lens-brief-last: the vision opens the lens message and the lens brief sits after the data, just before the ask

`test/dev17-records.test.ts`

- [P] split: two or more distinct children, edges between distinct children, a skeleton among them
- [P] scaffold and poc

`test/m3-schemas.test.ts`

- [C] checkpoint: every op cites active-looking clauses and evidence; ops exactly on a bundle; owner-only acts only as a request (A16)

`test/m4a-schemas.test.ts`

- [C] checkpoint-inputs: corpusSha256 round-trips; a dev.6 fact without it reads as written
- [C] milestone cadence: positive optional plan knob, additive trigger, and byte-preserving audit-only skips
- [C] a checkpoint answer requires corpusAmendments and exactly one anchor on every split child
- [C] a checkpoint answer's lists come in any order and read canonical, so no fact built from them is refused for order

`test/m4a-rev3-schemas.test.ts`

- [C] bundle-decided: an all-converted no-op lists its conversions; a busy rejection names the open attempts

`test/fakes-m3.test.ts`

- [C] scripts a two-op bundle whose second op is invalid, and an interpretation-only no-op, per job
- [C] a checkpoint answer the reader refuses is never built
- [C] a checkpoint prompt that lists findings (which name lenses) still takes its own job's step

`test/fakes-m4a.test.ts`

- [C] carries corpusAmendments in the frozen shape through the shim
- [C] an answer always carries corpusAmendments (the schema requires it), empty unless its spec names some

`test/revision.test.ts`

- [C] split.checkpoint-drop-divergence: a checkpoint split may drop text only citing clauses; code records a `split-dropped` divergence with its preimage

`test/m3-fold.test.ts`

- [C] a checkpoint decides once: a bundle outcome, or the plan revision its bundle applied

`test/tail.test.ts`

- [C] a P3 the decision does not fix is released whatever its disposition; one an admit repairs keeps it
- [C] tail.repaired-unruled: a finding the decision repairs is never ruled, whatever its disposition: its unit owns it and resolves it on publication
- [C] a P2 below a brake: deferred banks (the checkpoint's call), accepted while nothing fixes it is released, undisposed is released
- [C] a P2 under no brake, a dismissal, a P1, an owned P3 and a finding no longer active are left as they are
- [C] the dispositions come first, in order, then the releases of the shown findings, in order

`test/apply.test.ts`

- [P] classify.pre-build-shape-dropped (dev.17): the removed `planCheck.shape` is read and dropped, so adding it changes nothing

Deleted transition rows in `test/transitions.test.ts` ([P] owner: “plan-check retired as a seat (split/scaffold/poc are root decisions)”; [A] owner: “pre-build marker review ANNOTATES”). The generic table, park, hold, charge and live-stage assertions remain.

- [P/A] `['pre-build', 'redirect', {}, 'pre-build@med', 'redirect', { redirects: 1 }],`
- [P/A] `['pre-build', 'redirect', { counters: { redirects: 1 } }, 'pre-build@med', 'redirect', { redirects: 1 }],`
- [P/A] `['pre-build', 'redirect', { counters: { redirects: 2 } }, 'pre-build@escalation', 'route-up', {}],`
- [P/A] `['pre-build', 'redirect', { counters: { redirects: 2 }, routedUp: ['pre-build'] }, 'park:escalation', 'park', {}],`
- [P/A] `['pre-build', 'redirect', { counters: { redirects: 3 }, redirectBase: 2, routedUp: ['pre-build'] }, 'pre-build@escalation', 'redirect', { redirects: 1 }],`
- [P/A] `['pre-build', 'redirect', { counters: { redirects: 4 }, redirectBase: 2, routedUp: ['pre-build'] }, 'park:escalation', 'park', {}],`
- [P/A] `['pre-build', 'infeasible', {}, 'pre-build@escalation', 'route-up', {}],`
- [P/A] `['pre-build', 'infeasible', { routedUp: ['pre-build'] }, 'park:escalation', 'park', {}],`
- [P/A] `['pre-build', 'escalate', {}, 'pre-build@escalation', 'route-up', {}],`
- [P/A] `['pre-build', 'escalate', { risk: 'high' }, 'pre-build@escalation', 'route-up', {}],`
- [P/A] `['pre-build', 'risk-lowered', {}, 'pre-build@escalation', 'route-up', {}],`
- [P/A] `['pre-build', 'scope-widened', {}, 'pre-build@escalation', 'route-up', {}],`
- [P/A] `['pre-build', 'scope-widened', { routedUp: ['pre-build'] }, 'park:escalation', 'park', {}],`
- [P/A] `['pre-build', 'refusal', {}, 'pre-build@escalation', 'route-up', {}],`
- [P/A] `['pre-build', 'refusal', { routedUp: ['pre-build'] }, 'park:refusal', 'park', {}],`
- [P/A] `['pre-build', 'malformed', {}, 'pre-build@med', 'retry', { 'retries.pre-build': 1 }],`
- [P/A] `['pre-build', 'malformed', { counters: { 'retries.pre-build': 1 } }, 'park:malformed', 'park', {}],`
- [P/A] `['pre-build', 'read-denied', {}, 'pre-build@med', 'retry', { 'retries.pre-build': 1 }],`
- [P/A] `['pre-build', 'read-denied', { counters: { 'retries.pre-build': 1 } }, 'park:read-denied', 'park', {}],`
- [P/A] `['pre-build', 'process-fault', {}, 'park:process-fault', 'park', {}],`
- [P/A] `['pre-build', 'routing-changed', {}, 'park:routing-changed', 'park', {}],`
- [P/A] `['pre-build', 'in-session', {}, 'pre-build@med', 'advance', {}],`
- [P/A] `['pre-build', 'context-exceeded', {}, 'park:context-exceeded', 'park', {}],`
- [P/A] `['pre-build', 'context-exceeded', { counters: { 'retries.pre-build': 1, chargeableFailures: 2 } }, 'park:context-exceeded', 'park', {}],`
- [P/A] `['pre-build', 'split', {}, 'hold', 'hold', {}],`
- [P/A] `['pre-build', 'scaffold', {}, 'scaffold', 'advance', {}],`
- [P/A] `['pre-build', 'poc', {}, 'poc', 'advance', {}],`
- [P/A] `['pre-build', 'plan-defect', {}, 'park:plan-defect', 'park', {}],`
- [P/A] `['scaffold', 'scaffolded', {}, 'build/fresh@med', 'advance', {}],`
- [P/A] `['scaffold', 'refused', {}, 'scaffold', 'advance', {}],`
- [P/A] `['scaffold', 'plan-defect', {}, 'park:plan-defect', 'park', {}],`
- [P/A] `['scaffold', 'refusal', {}, 'park:refusal', 'park', {}],`
- [P/A] `['scaffold', 'process-fault', {}, 'park:process-fault', 'park', {}],`
- [P/A] `['scaffold', 'lost', {}, 'park:process-fault', 'park', {}],`
- [P/A] `['scaffold', 'interrupted', {}, 'hold', 'hold', {}],`
- [P/A] `['scaffold', 'routing-changed', {}, 'park:routing-changed', 'park', {}],`
- [P/A] `['scaffold', 'context-exceeded', {}, 'park:context-exceeded', 'park', {}],`
- [P/A] `['scaffold', 'occupied', {}, 'park:occupancy-unlabelled', 'park', {}],`
- [P/A] `['scaffold', 'cleanup-failed', {}, 'park:residue', 'park', {}],`
- [P/A] `['scaffold', 'executor-fault', {}, 'park:executor-fault', 'park', {}],`
- [P/A] `['poc', 'answered', {}, 'pre-build@med', 'advance', {}],`
- [P/A] `['poc', 'unanswered', {}, 'pre-build@med', 'advance', {}],`
- [P/A] `['poc', 'process-fault', {}, 'park:process-fault', 'park', {}],`
- [P/A] `['poc', 'interrupted', {}, 'hold', 'hold', {}],`
- [P/A] `['poc', 'routing-changed', {}, 'park:routing-changed', 'park', {}],`
- [P/A] `['poc', 'context-exceeded', {}, 'park:context-exceeded', 'park', {}],`
- [P/A] `['poc', 'occupied', {}, 'park:occupancy-unlabelled', 'park', {}],`
- [P/A] `['poc', 'cleanup-failed', {}, 'park:residue', 'park', {}],`
- [P/A] `['poc', 'executor-fault', {}, 'park:executor-fault', 'park', {}],`

Canonical matrix rows removed (the same [C] and [P] deletion authorities above):

- [C] `CHECKPOINT_JOB` (`test/checkpoint.test.ts`).
- [C] `BUNDLE_ACTIVATE` (`test/checkpoint.test.ts`).
- [C] `NOOP_DIVERGENCE` (`test/checkpoint.test.ts`).
- [C] `CORPUS_AMENDMENT` (`test/amendments.test.ts`).
- [C] `ADMIT_CONVERSIONS` (`test/serial/pipeline-matrix.test.ts`).
- [P] `FIXTURE_REDIRECT` (`test/stages.test.ts`).
- [C] `FIXTURE_CHECKPOINT_BUSY` (`test/status-rev3.test.ts`).
- [C] `FIXTURE_CONVERTED_NO_OP` (`test/checkpoint-rev3.test.ts`).
- [P] `DESIGN_SPLIT` (`test/design.test.ts`).
- [P] `SCAFFOLD_STAGE` (`test/scaffold.test.ts`).
- [P] `POC_STAGE` (`test/design.test.ts`).

Partial feature-arm removals: the legacy positive `planCheck.shape` reader assertion now asserts rejection; pre-build redirect/refusal counter exercises use gate revise/refusal instead; removed checkpoint capture requirements from divergence fixtures while retaining numbering, duplicate, digest and status assertions; removed checkpoint fields from empty-state snapshots; park-table totals changed from 22 rows/10 stage keys to 16/7 for the deleted pre-build/scaffold/PoC retry rows. The fake lens P0 refusal assertion moved into the retained fake-audit case. No retained assertion was dropped with a deleted wrapper. Removed ten empty `describe` wrappers left by the retired cases (two in `audit`, one each in `fakes-m4a`, `m4a-rev3-schemas`, `m4a-schemas`, `phase0-apply`, `repair`, `judge-validation`, and two in `revision-evidence`); these contained no test cases or assertions.


## Continuation 3

The campaign audit is one fresh role judging invariants, vacuity and cross-unit interaction together. This follows Agent surface decisions: “drop rolling per-merge lenses; one fresh-context whole-range audit per milestone (invariants + vacuity + cross-unit interaction, doc drift as cheap tail)”. Bounded diff attachments and durable partial coverage remain useful inside that one campaign, so `lensdiff.ts` and `lensCoverage` stay with runtime coverage. Restored real publication chunking, both chunk runner-exit recovery boundaries, partial failure followed by draining, and a single-call audit exercising all three concerns. Removed cross-lens keys, corroboration facts and merge machinery. `AUDIT_RETRY_MIN` names the abandoned-job backoff; the old publication/time-based audit-owed notification and checkpoint milestone knob are deleted, including their readers. Cadence's header now documents its actual milestone/request/final triggers.

Fable §1 says “campaign audit ... replacing lens + checkpoint, findings + request ops only, never amends the plan (checkpoint BundleOp machinery deleted; root amends via apply --reason)”. Accordingly, deleted tail/brake/admit classification, obsolete bundle sources and their readers, and the unwritten corpus-amendment chain (fact/fold, ids, chain/Phase-0 obligations, brief/status/PR payloads). Shared unit admission used by deflake and polish now lives in `holistic/admission.ts`. Historical run-9 classification helpers, their unused JSON fixture, and checkpoint-only evidence comparators go with the deleted producer. Generic revision, notice recovery, owner-head audit coverage, census, debt and chain assertions remain. The three tail-file cases exercising live released-finding suppression, P1 release refusal and gate debt selection moved into `findings.test.ts` and `gate.test.ts`.

Owner sign-off: “plan-check retired as a seat (split/scaffold/poc are root decisions)”. Added root split CAS refusal against an intervening revision and explicit deflake split refusal; restored clause-unexercised through root apply and the P2 root-repair/merge/re-walk loop. The retired checkpoint part of the latter stays deleted. The schema hard cut is explicit in Cross-cutting: “SCHEMA_VERSION 2, pre-break run dir refused loud at startup”; deleted redirect round/counters/bounds, stale-answer input/output helpers and old in-session build outcomes, with schema refusal assertions replacing acceptance of those outcomes. Existing stale-set writing and boundary reopening remain.

Agent surface decisions: “PlanUnit.review?: 'always'|'never' root override”; Fable §5: “Fix rounds: findings + evidence, failing lane evidence, red-on-unit/green-on-base, notes, cap state”. Added full-pipeline tests for `review: always` without any M1–M4 marker and a gate-revise fix build receiving finding/experiment evidence and the live cap/allowance JSON. No production test seam was added. Removed stale implementation comments and the empty `gate` eval trigger entry; retained CLI eval aliases. No changes to `src/prompts/flow/`, CLAUDE.md, version, external prose, or paid evals.

Verification is recorded below after completion. Initial focused runs: 322 passes/10 failures (first affected batch), 50 passes/3 failures (depth batch), and 225 passes/7 failures (second affected batch). Failures exposed stale fixtures/assertions during migration; all final outcomes and any locked timing reruns are listed below. The new split race was corrected to hash the actual split proposal before the concurrent revision, so it exercises CAS rather than input-integrity refusal.

Removed cases in this continuation: **57 named cases plus 2 parameterized transition rows = 59 cases**. The following [C] authority applies individually to every listed case: Fable §1, “campaign audit ... replacing lens + checkpoint ... checkpoint BundleOp machinery deleted; root amends via apply --reason”; for `findings.cross-key`, also Agent surface decisions, “drop rolling per-merge lenses; one fresh-context whole-range audit per milestone”. Root-authored census, evidence and debt assertions from mixed cases survive; only checkpoint amendment/classification/corroboration portions were removed. The deleted Phase-0 amendment-disposition/id cases additionally follow the same §1 removal of amendment proposals as audit output; the root now changes normative inputs through apply.

- [C] `test/admits-run9.test.ts` — admits.run9-exact: the recorded run-9 admits classify on the structural floor: every in-slice repair stays a repair
- [C] `test/admits-run9.test.ts` — admits.run9-declared-targets: cancel-texts declaring T-44 (citing V-5) is O-1; cancel-text-first its follow-up; cancel-text-staged converts
- [C] `test/admits-run9.test.ts` — admits.run9-declared-ordering: draught-refusal declaring its out-of-slice draught rules takes O-1 first; cancel-texts converts over-budget
- [C] `test/admits-run9.test.ts` — admits.run9-unwitnessed-opportunity: draught-refusal with no obligation serving V-7 converts unwitnessed, spending no budget; cancel-texts takes O-1
- [C] `test/admits.test.ts` — admits.table-row-1: an invalid repair ref is a reason, never a class
- [C] `test/admits.test.ts` — admits.table-row-2: a repair attributed wholly to opportunity O-1, out ⊆ OC(O-1), no follow-up yet → O-1 follow-up
- [C] `test/admits.test.ts` — admits.table-row-3: the same with O-1 already followed up → converted follow-up-overrun naming O-1 (LR-k)
- [C] `test/admits.test.ts` — admits.table-row-4: a repair touching only the slice, no lineage → repair{followUp: null}
- [C] `test/admits.test.ts` — admits.table-row-5 / admits.dishonest-citation-invalid: targeting out-of-slice T-2 without citing a clause outside the slice is invalid
- [C] `test/admits.test.ts` — admits.table-row-6: honest work outside the slice with the budget spent → converted over-budget
- [C] `test/admits.test.ts` — admits.table-row-7: the same with the budget left but no witness → converted unwitnessed (paid M4b runs 3 and 5)
- [C] `test/admits.test.ts` — admits.table-row-8: honest work outside the slice, the budget left, witnessed → opportunity O-1, its cited clauses joining advances
- [C] `test/admits.test.ts` — admits.table-row-9: no repairs, in-slice clauses only → oversight
- [C] `test/admits.test.ts` — admits.table-row-10: no repairs and no world clause touched → converted unrelated
- [C] `test/admits.test.ts` — admits.table-total: every generated combination of refs, attribution, out-of-slice touch, follow-ups and budget lands on exactly one row
- [C] `test/admits.test.ts` — admits.opportunity-clause-without-lineage-spends: work on O-1's clause V-3 without its lineage spends budget (over-budget), never a free follow-up
- [C] `test/admits.test.ts` — budgets count earlier ops of the same bundle: a second opportunity in one bundle converts over-budget
- [C] `test/admits.test.ts` — admits.ref-holds-invalid: repairing an obligation that holds on the head is invalid
- [C] `test/admits.test.ts` — admits.ref-exempt-invalid: repairing a deferred obligation is invalid
- [C] `test/admits.test.ts` — admits.ref-resolved-invalid: repairing a finding the checkpoint was not given is invalid; an unheld obligation is a valid ref
- [C] `test/admits.test.ts` — admits.impact-mapped-not-touched: an obligation the impact mapping selects for the scope is no declared target (admitOpOf)
- [C] `test/admits.test.ts` — admits.split-child-out-of-slice-targets: an obligation the admit delivers (a split child at T-2) targets T-2
- [C] `test/admits.test.ts` — admits.exempt-delivered-not-touched: a waived obligation the admit delivers is no target
- [C] `test/admits.test.ts` — admits.finding-clauses-are-context (LR-m): a finding over [V-1, V-3] repaired citing V-1 is a repair; its V-3 is no scope
- [C] `test/admits.test.ts` — a repaired finding's obligation is a target: F-1 on I-3 at out-of-slice T-2
- [C] `test/admits.test.ts` — admits.declared-target-out-of-slice (LR-m): declaring T-2 is opportunity work; declaring T-1 or T-3 is not
- [C] `test/admits.test.ts` — admits.target-unknown-invalid: a target no active rule of the pin is a reason
- [C] `test/admits.test.ts` — admits.attr-audit-lens-range: an audit lens finding names the units merged in that lens's range touching its paths
- [C] `test/admits.test.ts` — admits.attr-witness-union-range: a witness finding reads the union of its audit's ranges
- [C] `test/admits.test.ts` — admits.attr-pre-build-ambiguous: a pre-build finding is unattributable, so its repair never follows up an opportunity
- [C] `test/admits.test.ts` — admits.attr-absolute-paths-ignored: absolute (evidence-dir) paths name no unit
- [C] `test/admits.test.ts` — admits.attr-obligation-held-window: an obligation names the units after its last held head up to its first not-held one
- [C] `test/admits.test.ts` — admits.attr-shared-file-ambiguous: a path two lineages touched is a partial overlap: no follow-up
- [C] `test/admits.test.ts` — re-entries share their lineage: a fix of O-1's re-entered unit is O-1's follow-up
- [C] `test/admits.test.ts` — admits.follow-up-overrun-converts-with-debt: the overrun converts and banks one debt item naming O-1, idempotent by source
- [C] `test/admits.test.ts` — admits.conversion-referenced-is-invalid: another op naming a converted admit makes the bundle invalid
- [C] `test/findings.test.ts` — findings.cross-key (H7): the lens and absolute paths are left out; obligation, cause and repo paths (set, sorted) count
- [C] `test/ids.test.ts` — amendmentRefKey orders by arc, then by number
- [C] `test/m4a-rev3-schemas.test.ts` — a bundle revision's source carries its admit classes and conversions, together or not at all (dev.13: a brake's conversions alone)
- [C] `test/phase0.test.ts` — phase0.amendment-undispositioned: every amendment of the previous arc's verified ref needs a disposition
- [C] `test/revision-evidence.test.ts` — revision.evidence-head-superset-accepted: the head records every cited test with its outcome, and more
- [C] `test/revision-evidence.test.ts` — revision.evidence-equal-results-new-inv: equal results under another invocation and tree hold (the records' hashes differ)
- [C] `test/revision-evidence.test.ts` — revision.evidence-outcome-changed-rejected
- [C] `test/revision-evidence.test.ts` — revision.evidence-test-removed-rejected
- [C] `test/revision-evidence.test.ts` — revision.evidence-malformed-or-empty-rejected
- [C] `test/revision-evidence.test.ts` — revision.evidence-selection-loss-rejected
- [C] `test/revision-evidence.test.ts` — revision.evidence-env-or-rev-differs-rejected
- [C] `test/revision.test.ts` — classify.advances-bundle-opportunity-only: a bundle adds exactly the clauses of the opportunities it admits, and removes none
- [C] `test/tail.test.ts` — an admit whose every repair is below a brake converts: settled when each is below the settled brake, else regress
- [C] `test/tail.test.ts` — an admit naming one beside other repairs is a reason, never a silent drop
- [C] `test/tail.test.ts` — tail.regress-attribution: a lens finding whose attribution (its lens's range, its evidence paths) is wholly finding-origin is below the regress brake
- [C] `test/tail.test.ts` — tail.regress-range: with no attribution, the lens's covered range holding only finding-origin merges decides
- [C] `test/tail.test.ts` — tail.exempt: no brake for a P1, a finding that an obligation is broken or a walkthrough finding; the settled brake spares a non-negotiable clause
- [C] `test/tail.test.ts` — finding-origin: origin repair, or a spec repairing a finding
- [C] `test/tail.test.ts` — every milestone passed and every unit not finding-origin merged or cut; a plan without milestones needs the second alone
- [C] `test/tail.test.ts` — tail.release-reader: code's release names its job and reason, and only ever releases

The two removed `test/transitions.test.ts` rows are `build/infeasible` and `build/risk-raised` (old in-session plan-check assessment). Each follows Owner sign-off “plan-check retired as a seat” plus Cross-cutting “pre-break run dir refused loud at startup”. Mixed state snapshots drop only redirect fields, and mixed schema cases now assert these removed build outcomes are refused. No other test case is removed. Previously removed kept behavior restored/adapted here: `audit.range-chunked`, `audit.coverage`, `audit.one-call-per-lens` → one campaign seat, `design.clause-unexercised`, `split.revision-race`, and `walk.deviation-loop`. `audit.cross-lens-merge-corroborated`, audit-owed and checkpoint milestone cadence remain deleted with their corresponding features.


The first full non-serial batch completed with 1,244 passes, 158 failures and 1 NOT RUN. A stale `runOrder` import introduced during cleanup made newly spawned executor/test processes fail module loading; subsequent routing/resume cases timed out. The import was removed and typecheck rerun successfully before the final reruns. This failed batch is not counted as final verification.


Locked rerun of `test/apply-exec.test.ts`: **10/10 passed**, no skips or cancellations. The preceding bulk run had four failures in that file (queued rejected-receipt recovery, routing park, resume boundary, and respawn ignoring edited files). All four pass on the locked rerun. The initial bulk run's partial-chunk retry test also exposed a fixture mismatch: it requested an audit and then expected the retry to carry `final`; the retained test now starts naturally from the final trigger, preserving its chunk/coverage/draining assertions.


Additional removed case under [C]: `test/m4a-rev3-schemas.test.ts` — “a specs-only drift names its units; absent is a full drift”. Agent surface decisions require “one fresh-context whole-range audit per milestone”, superseding the specs-only vision-lens path. Deleted the unused specs-only seat input/renderer and journal payload field together; added a schema-2 refusal case for that retired payload. The mixed cause-format prompt test keeps its cause assertion and now verifies whole-campaign inputs; only its retired cross-lens merge/specs-only assertions are removed. The M3 record/payload tests use a live `walk` revision source and explicitly refuse `bundle`; the unit-over-plan bounds test uses live `reviseRounds` and explicitly refuses removed `redirects`. No retained record, payload, routing or bounds assertion is dropped.


The corrected full non-serial batch ran all 205 files: **2,745 passed / 6 failed / 1 NOT RUN**. The six failures were stale expectations in `m3-schemas.test.ts` (3), `prompts.test.ts` (1), `route.test.ts` (1), and `scheduler-m3.test.ts` (1). The complete affected-file rerun below verifies their corrections. The route case drops only the deleted redirect field from its expected bounds; every backend-window, revise-round, re-pin and spent-bound assertion remains. The scheduler case again expects the live `audit-owed` completion predicate; it uses a live `revision-notice` only for the generic nonblocking-item assertion. This distinguishes outstanding audit work from the retired audit-owed notification.


Final non-serial verification: the complete nine-file affected batch (`audit`, `agent-surface`, `m3-schemas`, `m4a-rev3-schemas`, `prompts`, `roles-surface`, `route`, `scheduler-m3`, `probe`) passed **178/178** at concurrency 4, no skips or cancellations. Together with the full 205-file batch, this establishes **2,751 distinct passing non-serial cases and 1 NOT RUN**, with every failed retained case rerun in its complete file. `contain.cgroup-real` is **NOT RUN** because cgroup v2 is read-only; it is never counted as a pass. Final `npm run typecheck` passed. All serial files run separately under the shared flock, at concurrency 1; their counts follow.
