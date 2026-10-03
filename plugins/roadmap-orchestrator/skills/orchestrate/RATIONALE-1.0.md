# Roadmap Orchestrator 1.0: rationale

Why 1.0 is shaped the way it is. Nothing loads this file at runtime. `SKILL.md` tells the architect agent
what to do; this file tells a maintainer why, so a change can be made without undoing a lesson that cost a
week to learn. The binding design is `DESIGN-1.0.md` at the repo root, and the frozen shapes are in
`executor/SCHEMAS.md`. The 0.x reasoning and its incident record (`RATIONALE.md`) live in git history at tag
`v0.20.0`.

Each section names the evidence it rests on and the decision it justifies, and is marked **[M1]** when the
behaviour ships in the M1 build or **[M2]**, **[M3]** or **[M4]** when it is design intent for a later
milestone (M4a is marked **[M4]**). Evidence citations: Obs = the arc-1 observations file, §3.n = the defect write-ups in
`calibration-0.20.0.md`, D§ = `DESIGN-1.0.md`.

## 0. The evidence base: arc 1

0.16.0 through 0.20.0 drove one greenfield platform build from 2026-09-12 to 2026-09-25. The numbers
(Obs §1, and queries over the arc's `.roadmap/` bundle):

| Measure | Value |
|---|---|
| Waves | 39 |
| Units merged / quarantined / pending | 74 / 24 / 10 |
| Codex runs | 683 |
| Courier-tier agent calls | 1,630 |
| Upper-tier Claude calls | about 220: 99 Opus, 121 Fable; 61 gate rounds and 49 plan-checks among them |
| Degradations logged | 53, of which 44 were host or supervision faults |
| Orchestrator defects written up | 23 (§3.1 to §3.23), several recurring two to four times |

Two findings shape everything below. First, the courier tier was the largest source of recorded failures,
and no courier decision needed judgment (Obs §6). Second, the system was good at local quality and poor at
holistic quality. Per-unit gates passed work that a whole-tree read later broke: one independent read after
28 waves found five P1s, three P2s and an authority bypass, every one past its unit gate (Obs §3).

The yardstick is the owner's: a run goes unattended for a week and converges on a documented target
state (D§1). Wall-clock, not money, was arc 1's binding constraint (Obs §6).

## 1. The executor owns processes [M1]

**Evidence.** 0.x ran inside Claude Code Dynamic Workflows. That host has no shell and cannot background a
process. Every wait is an agent turn with a budget, and a workflow resumes by position (D§5, Obs §2). So a
model launched each Codex run and a model decided when it had finished. Its patience was wrong. Couriers
reported healthy runs as "still in progress" at 11, 22, 23 and 40 minutes. The harness then reaped them,
once discarding seven of eight green lanes, about 50 minutes of work, or it moved on while the builder was
still writing. The architect committed a killed builder's leftovers by hand three times (Obs §4.1, §3.9,
§3.15, §3.16). Meanwhile the late-arc progress came from the one place that could background and wait: the
main session, running Codex under a Monitor (Obs §5).

**Decision.** A plain Node process, launched detached under a supervisor, owns every subprocess, deadline,
lock and evidence directory. One executor per single-UID host, claimed by `link()` on
`/var/tmp/roadmap/host.lock`. The supervisor restarts it with backoff and stops at three crashes an hour
with a needs-user. The architect's session keeps judgment and the command queue, and nothing else. The
rule that falls out: nothing code can do exactly is done by a model (D§2).

## 2. Couriers, not janitors, in its 1.0 form [M1]

**Evidence.** 0.x §19 recorded the August 2026 ledger. The script handed the cheapest tier *goals*: "clean
up leftover listeners", "make the checkout work". Every incident was that tier reaching for the biggest
tool that satisfied the goal, `kill -9` of every node process or `rm -f` over untracked state. A "never do
X" clause did not help. 0.13.0 answered with two rules: the cheap tier gets a closed command list the script
composed, never a goal; and every wave-level brake lives in code, because waves 18 and 19 grew the plan for
twelve hours after it drained while the only brake was prose in a triage prompt. Those rules held, but the
couriers stayed, and arc 1 made 1,630 courier calls, the largest failure source, none needing judgment.

**Decision.** The first half of §19 is gone because its subject is gone: no model runs a command on the
executor's behalf. The second half is now the general rule. Brakes live in code, and a prompt carries a
goal only where a model's judgment is the point: plan-check, build, gate. In M1 that means the chargeable
bound (a unit's third design-class failure parks it), a dispatch pin that no redirect can widen or
lower in risk, the transient check on every candidate, the approval fingerprint, and backend errors
classified only from structured error events. A prompt may inform a brake. It never is one.

## 3. Peer backends behind one process interface [M1]

**Evidence.** Environment facts from Obs §2 and the ledgers. Codex exits 0 when its sandbox fails to
start, so a smoke that runs no shell command passes on a host where every real run fails. A prompt passed
as an argument hangs Codex on stdin; two 40-minute drafts were lost that way. Codex kills its children
when its turn ends (§3.18). A grep over the event log read the orchestrator's own documentation, which a
builder had printed, as a usage limit and halted a wave (§3.1). Log capture under umask 077 broke a
fixture's chmod assertions (skill-feedback 0.18).

**Decision.** `codex exec` and `claude -p` are ordinary processes behind one interface: prompt on stdin,
declared environment, umask 022, JSON events out. Each invocation runs under a small runner that writes
stdout and stderr to files, never pipes, so the executor can die and reattach. The runner waits for the
workload to be empty, writes `exit.json`, and exits. Only then does the executor run the adapter, which is
pure over those files and so can be re-run at recovery, and writes `result.json`. `outcome` and `usage` are
separate fields: missing usage never invalidates a judgment. The arc-start smoke runs a real shell command
and grades exit code and output. `claude -p` billing was verified subscription-covered on 2026-09-25 (D§2),
which settled the 0.x worry that headless Claude could not host judgment.

## 4. The write-ahead log is the only authority [M1]

**Evidence.** Disk as the source of truth worked in arc 1: compaction, restarts, a host resize and a driver
handoff were all recoverable (Obs §3). But 0.x reached disk through a model and a replay script. Role
directories keyed on the wave number replayed stale results and halted a wave (§3.6). And arc 1 measured
almost nothing: no per-call token counts for any Claude model, and per-lane timestamps in exactly one
evidence file across the whole arc.

**Decision.** `events.jsonl` is append-only, one canonical JSON line per record, each line carrying the
sha256 of the line before it. A complete intent is durable before every act; a `done` records the verified
postcondition. `state.json` is derived and never read for a decision. A torn final line is saved and
discarded; any earlier corruption refuses start. Every operation kind has a reconciler that re-reads its
postcondition, and a test crashes at every write-ahead boundary and asserts the exact replay. Counters are
monotonic across retries and re-entry. Measurement is in the log from the first line: meter facts per
invocation, lane start, end and exit.

## 5. A DAG with resource locks instead of waves [M2; M1 ships the serial lifecycle]

**Evidence.** Wave batching added little: with one estate lane at a time, units ran serially anyway (Obs
§4.5). Of the merges the state tagged by wave, 43 came from one bulk adoption in wave 12. Wave boundaries
were the only point where rulings, spec edits and sweeps could happen, so the architect acted outside the
machine to keep waves alive (Obs §4.5, §5). On 4 vCPU, load reached 15 to 36. Lanes with fixed cluster and
container names collided, and a killed lane stranded its clusters (§3.3, §3.4, §3.7, §3.12).

**Decision.** A unit starts when its dependencies are merged and its stage's resources are acquirable.
Resources are named or capacity, taken all-or-none in one global order. A reservation covers probe, cleanup,
run and cleanup again, and releases only after confirmed cleanup. A failed teardown becomes a residue in
the host index before anything is released, and `start` refuses until every residue is swept or
dispositioned. M1 ships the reservation cycle, the occupancy probe, residues, `sweep` and the serial
integration slot for one unit. DAG dispatch, capacity scheduling, aging and retryable parks are M2.

## 6. Candidate-first merge and exact-head publication [M1]

**Evidence.** 0.x merged and then tested, with a revert after publication. A merge report without the
suite's exit status triggered a paid integration-fix call that discovered the suite had passed (Obs §4.1).
Reviews diffed against the moved tip reported phantom 9,000-line reversals (§3.5). An adopted branch
entered verify 18 commits behind integration, missing the dependency its edge existed for (§3.23).

**Decision.** In the integration slot the executor makes a `--no-ff` candidate on the current tip, held on
`refs/roadmap-run/<arc>/candidate/<unit>`. The transient check refuses paths outside the pinned scope and
denylisted paths. Suite lanes run on the candidate. On green, integration fast-forwards to that exact
commit, so the tested head is the published head. The approval fingerprint is recomputed against the tip
before the fast-forward, and a mismatch re-gates. Every diff is `merge-base(tip, branch)..branch`,
recomputed after any merge-in. Merged means second-parent reachable.

## 7. Clean PRs [M1]

**Evidence.** One integration pass carried 1,219 roadmap-file changes, and raw evidence buried the product
in the diff (Obs §4.5).

**Decision.** In-tree `.roadmap/` holds only the living docs a later arc reads: `contracts/`,
`constraints.md`, `invariants.md`, `debt.md`, `config.json`. Plan, specs, ledgers and results are
snapshotted one way to `refs/roadmap/<arc>` with a sha256 manifest. Raw evidence stays in the run dir and
only its hashes reach the ref. A 0.x layout is refused at start, never converted.

## 8. Roles, not models; prompts keyed per (role, model) [M1]

**Evidence.** Models moved under arc 1 while it ran: 0.20.0 put Opus 5.5 into the low and medium frontier
seats and removed Sonnet from gates. 0.x state counted spend by model name, so every model change rotted
the records that cited it.

**Decision.** Owner ruling, 2026-09-25: every record the executor writes names the role an actor filled and
the `routingRev` in force, never a model id. Model ids appear only in routing configuration, which is
revisioned, and in the argv of a per-invocation `launch.json`. The `state.no-model-ids` test enforces it.
Prompts are code and are keyed by model, because a prompt tuned for one model is wrong for another. Each
role's table is `Record<ModelId, Prompt>`, so adding a model fails compilation until every role has a
prompt or a dated, reviewed `inheritsFrom`. Two profiles ship: `default`, and `claude-only`, which resolves
no role to Codex and skips the Codex smoke.

## 9. Independence is a clean context, not a different model [M1]

**Evidence.** 0.x learned that coldness is epistemic: resume for fixing, never for judging. The early 1.0
brief also proposed a brake requiring the gate's model family to differ from the implementer's. That brake
could not hold under peer routing or a `claude-only` profile, and the distillation found it contradicted
0.x's own layout, where the pre-gate reviewer shared the implementer's family.

**Decision.** The owner's ruling, quoted from D§4: "A clean context, not a different model (owner,
2026-09-25): every judgment role (plan-check, digest, gate, consult, lenses, checkpoint) runs in a fresh
session under the judgment profile, inputs snapshotted by revision, no implementer transcript." And: "The
same model may implement and judge." Code enforces it. Judgment and implementer session ids are distinct
types, and only the implementer type can be resumed. Fix rounds do resume the build session, because fresh
rounds in arc 1 surfaced one defect per round and continuous context is what worked late (Obs §4.3, §5).
Codex judgment seats are unsupported until a read-only Codex judgment profile exists.

## 10. No spend cap; usage limits park [M1]

**Evidence.** About 220 upper-tier calls over 74 merged units: roughly three per merged unit, spent where
work can be rejected, which Obs §6 calls the clearest return. Codex volume never constrained the arc.
Outage classification by text misread both documentation and a "model at capacity" message as usage
limits (§3.1).

**Decision.** Meter every call by role and routing revision; brake on none of it (D§7, D5). A usage-limit error
event marks that backend limited arc-wide. Running work finishes, stages needing it hold, one needs-user is
raised, and nothing retries. `resume --backend` re-runs that backend's smoke before unparking. The 0.x
rule survives: an outage is a human act to clear, and routing never fails over to hide it.

## 11. Session containment and its narrowed guarantee [M1; cgroup mode experimental]

**Evidence.** "Still running" was accepted while an orphan child kept editing the worktree (§3.16, wave 39).
A strong build was killed at 3h42 by a signal nobody identified (§3.15). 0.x built a pidfile, exit-code-file
and TERM-trap apparatus because processes went through a model's Bash tool.

**Decision.** The runner is the controller and never a workload member. The workload is every process
carrying `ROADMAP_INV=<inv>` in its environment or sharing the child's session. Kill stops members, rescans
until the set is stable, then TERM, then KILL, then rescans until empty. No stage advances, no resource is
released and no output is certified while the set is non-empty. The guarantee is stated narrowly in
`status.host`: a descendant that calls `setsid()` and execs with a cleared environment escapes. The
verification-tree assertion and the occupancy probe catch part of that; the rest is documented, not
closed. cgroup mode would close it, but the development host's cgroup v2 is read-only, so cgroup mode is
not selectable until a real-kernel test passes elsewhere. Its test reports NOT RUN, never pass.

## 12. The holistic layer [M3]

**Evidence.** Local good, holistic poor. The wave-33 audit found two P1s and two P2s that seven unit gates
had passed. Drift appeared in four of six audits, and there were eight vacuity rows (D§2.5). A gate recorded
an invariant "witnessed and held" when the witness injected its own checker. The wave-38 audit ran no
tests. An alignment audit found 15 rulings contradicting the architecture document, and one hostname
ruling broke cookie isolation (Obs §4.5).

**Decision.** Obligations are every checkable claim extracted from the target-state document, approved by
the owner. Each names a witness that emits per-test records; no record means `unwitnessed`, never passed.
A `must-hold` obligation that goes red makes a candidate red, in code. Frontier-class lenses report; a summit-class
checkpoint then rules toward the target, not the original plan. Its authority is bounded by the delegation
envelope: it may amend implementation contracts, respec, re-route or cut. The vision is the root record
(owner ruling OR-V): the checkpoint may also weaken an obligation when it cites active vision clauses and
evidence, reconciling silently and consulting the owner afterwards; every departure is a divergence with its
preimage, and only owner-only acts (outside the sandbox, cost over $10, legal) go to the owner first. Bundles
apply all-or-none against a revision vector, and a convergence bound (default 3) hands control back before
the checkpoint can churn. 0.x invariant 8,
"feedback never steers", becomes "feedback accumulates until a checkpoint; checkpoints steer". M1's
approval fingerprint has no `obligationRevs` yet; M3 adds them.

## 13. The eval ladder [M1]

**Evidence.** 0.x kept its paid fixtures green by making issue-mode prompts byte-identical to file mode,
and a paid run could not reach the host behaviour that actually failed in arc 1: reaps, residue, crashes.

**Decision.** Four rungs, in order. `tsc --noEmit`. Unit and integrated tests with real processes, real git
and fake backends behind PATH shims, including a crash at every write-ahead boundary; `crashPoint(label)` is
the only test seam in production code. A targeted probe against the real CLIs, for pennies. The paid
fixture, once per merged batch under both profiles. The paid fixture is integration evidence, not the hard
assertion. One model-driven run cannot prove a recovery property; the deterministic tier can, because it
chooses where to crash. The paid run shows the parts meet real models and lists what it did not exercise.

## 14. What 1.0 dropped from 0.x

- **Dynamic Workflows as host**, with its `.mjs` scripts, `persist.mjs` replay and position-based resume.
- **The courier tier**, with closed command lists, `cd` guards, `STRICT`, `rc=` wrappers and the spec-write,
  merge, dossier, census and `gh` couriers.
- **Waves**, `maxWavesPerRun`, the 1000-call guard and wave-keyed directories. A contingent edge now holds
  only its dependent.
- **The three-tier boundary ladder**: Haiku census, Opus triage, Fable boundary, then root. Cadence audits
  and the checkpoint replace it [M3].
- **Verifier-as-agent.** The executor runs lanes verbatim and grades by exit code.
- **The outbound issue projection.** Issue mode becomes inbound only, `roadmap:bug` and `roadmap:feedback`
  read at Phase 0 and checkpoints [M4]; the projection is deferred to 1.1.
- **The dual-driver protocol**, the post-publication revert, text-grep outage detection and the spend cap.

What stays is the judgment that worked: frozen contracts, C-nn rulings, plan-checks that redirect,
gates with rejection authority over scope and debt, and Phase 0 as the architect's highest-leverage act
(§17).

## 15. A failing lane keeps its ignored output [M1]

**Evidence.** A lane runs in a checkout the executor deletes after the series. A script that writes its logs
into a gitignored dir, with no `evidenceGlobs` for them, loses them there, and its fix round reads stdout and
stderr alone. Nothing showed the gap: the ledger said nothing of files a lane wrote but no one kept.

**Decision.** Every lane's gitignored writes are counted, and the gate's ledger names what was not kept and
why. A lane that does not pass also gets its undeclared ignored output captured, since a failure is when the
fix round needs it. The capture is capped, and it skips build output and key material by default, because
the run dir must not fill with dependency trees or keep credentials. Declaring `evidenceGlobs` stays the
contract. Since the evidence globs grade nothing, the architect may correct them on a unit in flight without
a spec revision (`roadmap apply`).

## 16. Plan edits go in through `apply` [M1]

**Evidence.** Before 1.0.0-dev.4 the plan and specs were read from the files: once per start for the plan, at
every stage for a spec. Changing the plan meant `stop` and `start`, and a stop kills live backends and lanes. A
crash restart loaded whatever the files held by then, and a removed unit that still had an open intent threw in
recovery, which crash-looped the supervisor. Nothing stopped an in-flight spec edit; a stage read it mid-unit.

**Decision.** The plan in force is a fold of the log: `roadmap apply` hashes the files, and the executor, at the
next stage boundary, re-checks them, classifies every change against what each unit has done, keeps the bytes
by hash and records a new revision. A refused change refuses the whole apply with every reason. Stages load the
spec bytes the log names, so an unapplied edit has no effect, also after a restart. A spec revision of an
in-flight unit waits for a boundary where the unit can re-enter plan-check with its work intact. Nothing live
is killed for an edit. DESIGN's `admit` and `patch-spec` are edit classes of `apply`, so there is one way to
change what the executor runs (owner ruling 2026-09-29).

## 17. A pinned corpus, Phase 0 in session, and chained arcs [M4]

**Evidence.** M3 steered by one architecture document named by path. Nothing pinned it, nothing gave its claims
ids, and an obligation pointed at a quoted anchor that any edit could break. Real targets are not one document:
the owner's are a sprawl of numbered docs and ADRs that restate, contradict and outlive each other. Phase 0 had
been the highest-leverage act in arc 1, yet it ran as prose the architect followed by hand, and its pack review
went out to an external reviewer through templates the architect filled in. The yardstick asks for a week unattended, which no single arc fills; and an
unattended week is only safe if the owner can see, in one place, everything decided since they last looked.

**Decision.** Owner rulings OR-Q9 to Q22, recorded 2026-10-02/03 (DESIGN-1.0.md draft 9, §2.8 to §2.11):

- **The corpus is the target, and readability comes first.** The root agent curates it in session through a
  guide (`.roadmap/corpus.md`); code never edits it. Normative claims live in `rules` blocks as `T-n` ids, global
  and never reused, so an obligation anchors at `{T-n, text hash}` instead of a quoted span, and a census says
  for every rule whether the arc holds it, defers it or cannot test it. Curation runs in tiers: structural and
  fact-currency edits are the agent's to make and report; a contradiction the vision resolves is resolved and
  recorded as a reversible divergence; one the vision is silent on becomes a ranked question with a working
  assumption, never a guess the owner cannot see.
- **The executor reads only a pin.** `corpus pin` writes the files, rules and vision path by hash; `start` and
  `apply` re-derive it and refuse drift, and the snapshot keeps every byte, so a judge's view of the target is
  reproducible from the ref alone. The vision document lives in the corpus, and its confirmation is now checked
  against the pinned bytes instead of stored on trust.
- **Phase 0 is the agent's, checked by code.** The agent fans the reading out to subagents; `phase0 check` runs
  the same rows `start` runs, so a Phase 0 is green before it costs a start. The pack review became an executor
  job on the frontier class with kept inputs, holding admission until a review matches the current pack.
- **Issues are trusted or refused.** Owner ruling L6: a repository whose policy lets anyone open issues refuses
  `start`; there is no confirmation path and no injection filter to maintain. Under a trusted policy, issues are
  owner context, rendered as pasted data, and every captured issue gets exactly one recorded outcome.
- **Chaining with a brake the owner sets.** Arcs run back to back as stacked branches and PRs. One code-rendered
  brief, hashed whole, covers everything since the owner's last acknowledgement across the chain; K bounds how
  many starts may pass without one, and only the owner changes K. The root agent never merges `main`; the owner
  merges the stack with merge commits.
- **Routing.** OR-Q17 and L3: the frontier and summit classes bind one model at different efforts, retroactively,
  with no routing generations; an effort-only change of a build seat re-pins and resumes its session.
- **Efficiency waits for M4b.** M4a only measures stage timings; the root agent reports slowdowns as
  observations and changes nothing that grades the work.

