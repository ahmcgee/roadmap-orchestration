---
name: roadmap-orchestrate
description: Execute or resume a product roadmap to a cut line in Codex with an Astra lead, native subagents, isolated unit worktrees, independent review, and shared .roadmap state compatible with the Claude Code orchestrator. Use for multi-unit roadmap execution or a driver handoff, not a single unrelated edit. Requires Codex native subagent tools, Node, Git, and a POSIX shell; no Claude runtime.
---

# Roadmap orchestration in Codex

Deliver a tested integration branch for the requested roadmap slice. Use **GPT-6 Astra as an
architect and a direct implementer**. Astra should implement the hardest, highest-stakes units:
foundational architecture, security/correctness-critical changes, migrations, difficult concurrency,
and fixes requiring deep cross-unit reasoning. High-risk units default to direct lead implementation;
use the same judgment for difficult medium-risk work. Delegate independent routine units, exploration,
verification, and review to native Codex subagents. This skill explicitly requests that delegation.

Subagents inherit the lead's model by default. Use a different worker model only when the user has
configured/requested it; keep the difficult implementation and architectural decisions on Astra.
If the current lead is not Astra, establish an Astra lead using the host's supported model selection
or an explicitly configured Astra agent; do not claim the skill frontmatter changes the model.
Never invoke Claude agents, the Claude Workflow tool, or the legacy conductor on this path.

Read [the shared protocol](references/protocol.md) before writing state. Use the shipped
`scripts/roadmap.mjs` helper, with a JSON request file, for lifecycle mutations. Native agent threads
are temporary execution context; the files and Git history are the durable record. Keep thread IDs,
raw transcripts and usage measurements in the runtime directory returned by `status`, not in specs.

## Start or resume

1. Resolve the roadmap sources, cut line and project constraints. Read the project's applicable
   instructions and check for `.roadmap/state.json`. Its presence means resume, never overwrite it
   with a fresh plan. Read living constraints, debt and user feedback; archived contracts are history.
2. Confirm native agent tools, Node, Git, and the necessary test/browser tools work. Use the current
   host's permissions; do not prescribe a sandbox bypass or invoke a second Codex CLI as a conductor.
3. For an existing arc, acquire ownership as `codex`. If another driver owns it, stop that run and
   all its workers first. A capacity limit is not proof that its processes stopped. Follow the
   explicit takeover request in the protocol; then recover and reconcile. Dirty worktrees are
   preserved: inspect their diffs and checkpoint useful work before retrying reconciliation.
4. Before dispatch, resolve an untriaged boundary, a contract amendment, or a contingent edge from
   the prior driver. Read every quarantine dossier and outstanding `owed` job. Retain budgets and
   debt. Re-run checks with no trustworthy evidence for the current commit.
   For an imported plan, configure `config.codexNative.integrationTestCommand` from its brief before
   setup. This also enables shared retry accounting in the updated Claude driver. Census active specs
   and unit branches against the plan; adjudicate unlisted work instead of silently omitting it.

## Phase 0

Decompose the sources into a dependency DAG of independently verifiable units. Preserve source
traceability, cut-line ancestor closure, and file-overlap ordering. Specs must name goals, exact
scope and exclusions, frozen contract/design references, individually gradeable acceptance clauses,
test seams, runnable done-when commands, and open decisions. For refactors, include a preserve-list.
Size units around coherent outcomes rather than artificial token limits.

Write `.roadmap/brief.md` with actual build/test/lint commands, provisioning and the module map;
contracts; specs; and `architect-log.md` beginning with direction, tie-breaking preferences and
non-goals. Copy adoptable design assets into the product tree; comparison images may live under
`.roadmap/design/`. Cite binding designs from each relevant unit.

Delegate a source-to-plan fidelity audit and a contract-vs-code check to independent readers.
Resolve omissions and contradictions before execution. Ask the user only for decisions that affect
scope or cannot reasonably be inferred. Reuse existing authorization; this step does not require
approval for every routine technical choice.

Create the shared plan/state with `init`. Set the integration-suite command under
`plan.config.codexNative.integrationTestCommand` from the brief. Record the raw roadmap paths in
the brief. Before unit work starts, create the integration branch at the recorded tip if absent,
attach it to the dedicated `worktreeRoot/__integration` worktree, and copy/commit the initial
`.roadmap/` pack there. Keep the primary checkout's branch and tip unchanged. Run `reconcile` to
record that plan-pack commit, then begin the first wave. Central `.roadmap/` remains authoritative;
give every worker its absolute path so it cannot mistake a fork's snapshot for live state.

Use file mode by default. If a usable GitHub remote and authentication exist, the same issue mode
is available; follow [issue tracking](references/issue-tracking.md). Issue writes require the user's
authorization to publish that tracking; do not infer permission from authentication alone. Local
state is authoritative in both modes.

## Execute waves

Start a wave through the helper. Default to at most three active unit lanes, further limited by
available native agent slots. Keep a slot available for independent review while the lead implements.
List eligible units; call `setup` before any delegation or direct editing. It checkpoints intent,
creates/adopts `unit/<id>` in `worktreeRoot/<id>`, and provisions it. All edits and tests must name
that absolute worktree explicitly; spawning a subagent does not automatically isolate its filesystem.
Workers must not change sibling worktrees, integration, shared `.roadmap/`, or branches they don't own.

For each unit:

1. **Plan-check.** Read the spec, contracts and existing code. For fresh work, record an implementation
   plan and obtain a separate feasibility/scope review before `transition` to `implement`. Escalate
   contract contradictions to the lead; do not weaken an acceptance clause to make a check pass.
   Adopted work enters verification, with its existing diff as the pinned scope in the `scopePath`
   returned by setup. Give that path to implementers and reviewers alongside the spec's scope.
2. **Implement.** Astra directly implements high-risk and difficult work in its assigned worktree.
   Delegate bounded routine units when independent work can run concurrently. Commit useful progress
   at milestones so a sudden interruption loses only in-flight reasoning. Return changed files,
   commit SHA, tests, open concerns, and evidence paths. Checkpoint the stage before dispatching work.
3. **Verify and review independently.** Run the spec's actual verification lanes. A separate reviewer
   inspects the diff, acceptance clauses, contracts, scope growth, preservation requirements and
   design fidelity. The implementer may run tests but must not author its own approval or exit gate.
   When Astra implements, delegate those judgments to a fresh Astra reviewer context. A review
   summary is evidence, not a substitute for reading a high-risk diff.
4. **Fix within bounds.** Record a `fix` round before dispatching a fix; use `opusGate` for first-pass
   gate revision rounds and `gate` for escalated rounds (legacy names, not model requirements).
   Defaults are two fixes, two first-pass rounds, three escalated rounds. At the cap, obtain a closing
   judgment on the last changes; quarantine with a dossier if unresolved. Tool/provider failures
   park or block work with commits intact, rather than treating absent verification as a code defect.
5. **Approve and merge.** Save commit-addressed verifier/reviewer/gate reports in central
   `.roadmap/evidence/<id>/` using the protocol shapes. Call `approve`, then `merge`. The helper runs
   the integrated suite on a candidate merge before advancing the integration branch. A failed
   candidate stays available for diagnosis. Fix the unit branch, then repeat review; never advance
   integration manually past a failed suite. A changed integration tip or spec invalidates approval.

The helper's raw `checkpoint` is for boundary documents and planning changes, not a replacement
for lifecycle commands. Only the lead writes central state or invokes those commands. Native worker
messages cannot grant approval for a different commit. Host limits are resumable pauses; persist
after every completed stage, stop workers, and release ownership when switching drivers.

## Boundaries and finish

At every wave boundary, including the final wave, use independent health and runtime-exploration
agents against the integration tip. Read the architect log first. Run design reconciliation for
design-cited units, and rerun flaky suites when needed. For previews, use a dedicated `__preview`
worktree and record the owned process group; stop only that group. Preview failure never proves a
unit defective. Record unavailable jobs as `owed` with reason and wave, never as successful checks.

Triage boundary findings, user feedback, quarantine dossiers and debt together. Contract amendments,
contingent replans and scope changes belong to Astra. Admit useful consolidation work while planned
work remains; debt alone must not create endless new waves. Bank residue with one of
`out-of-scope-file`, `needs-migration-or-ruling`, or `pre-existing-untouched`. Correctness failures
inside the unit scope cannot pass as debt. Resolve/waive owed jobs explicitly in the architect log.
Move consumed feedback to `feedback/triaged/<wave>/` and checkpoint the disposition, `boundary.triaged`,
revised plan, debt ledger and journal together. Do not silently drop held findings or unbanked debt.
With workers stopped between waves, synchronize and commit revised plan/spec/contract snapshots
to the integration worktree and reconcile its new tip before dispatch. Commit only the intended
roadmap/design artifacts; preserve unrelated primary-checkout changes.

Never retry a quarantined specification unchanged. Respec with a new ID, `supersedes`, and optionally
`existingBranch: "unit/<old-id>"` to retain good work. Two failed units in the same replacement lineage
require a lead redesign decision. For verification-tooling failures, the first block can be retried
next wave; a second block needs an environment dossier; two units blocked by the same host problem
pause the wave. Persist `rounds.verifyBlocked` across drivers. User feedback steers at boundaries,
not by silently changing an in-flight worker's spec.

Finish with a cross-unit integration review, including every contract amendment and every owed job.
Report merged/quarantined/blocked/deferred units, evidence and dossier paths, debt, pending feedback,
and actual available usage (unknown usage stays unknown). Census the handoff report against Git and
state with an independent reader. Deliver an integration branch, or one PR when authorized; retain
the existing user-controlled merge to the default branch. After that merge, archive arc files,
preserve living constraints/debt/orchestrator feedback, and remove only clean merged worktrees and
branches. Keep quarantined work and its evidence. Stop workers and release ownership before archiving
`state.json`; absence of top-level state is the fresh-arc marker.
