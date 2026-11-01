# roadmap-orchestration

A **roadmap-orchestrator** for Claude Code. Give it a detailed target-state document, a cut line and a codebase;
it decomposes the work into independently verifiable units, builds each in an isolated git worktree, and
converges the codebase on the documented target state, unattended, for a week or more at a time.

## Status

**1.0 is in prerelease on `main`** (`1.0.0-dev.33`). The command-center release uses runtime schema 2.
Arcs started on dev.32 or earlier are refused, not adopted; finish them with their original executor.
The last 0.x release is at tag `v0.20.0`.

## What 1.0 is

- A Node 24 executor (TypeScript, no runtime dependencies) that owns processes, deadlines, resources and git
  operations, with write-ahead recovery.
- A unit DAG with resource pools, system-based responsibility, executable witnesses and candidate-first publication.
- Five roles: build, verifier (pre-build/gate/diagnosis), pack review, milestone experience verdict and campaign audit.
- A root architect who authors and revises the target/plan through exported compare-and-swap inputs, supervises
  unattended work and brings the owner a canonical brief.
- Revisioned routing: `default` mixes eligible Codex builds with Claude judgments; `claude-only` needs no Codex CLI.

The binding design is [`DESIGN-1.0.md`](DESIGN-1.0.md); exact contracts are in
[`SCHEMAS.md`](plugins/roadmap-orchestrator/executor/SCHEMAS.md).

## Install

```
/plugin marketplace add ahmcgee/roadmap-orchestration
/plugin install roadmap-orchestrator@roadmap-orchestration
```

Then, in the repo you want to build in, run:

```
/roadmap-orchestrator:orchestrate
```

The first run bootstraps the repo and distils the vision with you (it runs the `vision` skill itself). Run
`/roadmap-orchestrator:vision` on its own later, between arcs, to recalibrate the vision, and
`/roadmap-orchestrator:estate-compaction` at any time to prune what the arcs have accumulated.

The skill installs a managed `/usr/local/bin/roadmap` launcher inside the executor container and refreshes
it on each skill session. Developers can then use `roadmap tui` in another terminal. After startup and at
completion, the skill supplies a command pinned to that arc for inspection. The launcher points to the
installed plugin and the current Node executable; no global npm package or copied executor is required.
For manual setup, run `node "<plugin root>/executor/bin/install-roadmap"` (with container administrator
rights if needed), or pass `--bin-dir <directory>` for a writable PATH directory. Unrelated commands are
never overwritten. Keep the plugin installed; refresh the launcher after updates or container rebuilds.

For local testing before pushing: `/plugin marketplace add ./path/to/this/repo`.

## How an arc runs

![The owner sets the target; the architect authors and steers; the executor builds, certifies, audits and publishes](docs/flow.svg)

The detailed process uses BPMN events, tasks, gateways and message flows: [docs/flow-bpmn.svg](docs/flow-bpmn.svg).

The **owner** confirms the vision, resolves questions only they can answer, and sets how far the architect may
chain arcs beyond the last acknowledged brief. The **architect** is the root agent in that conversation. The
**executor** runs detached and owns every workload, resource, evidence directory and integration ref.

1. **Bootstrap and Phase 0.** The architect curates the target corpus into stable T-n rules, compiles the confirmed
   vision, selects a useful slice and writes the pack outside the product tree: plan, specs, obligations, witnesses,
   census and Phase-0 record. Every unit names systems; every spec states intent and non-goals. Existing behavior is
   must-hold, future behavior names its delivering units. Milestones define usable end-to-end experiences with
   design references, bring-up, journeys and selected integration lanes. Phase 0 checks typed inputs, committed
   target bytes, proof reachability and readiness; system overlap, possible future-witness vacuity, spanning proof and design ordering advise judgment.
2. **Start and review.** Startup validates the pack, claims the host and smokes its routed backends. A fresh pack
   review checks it against the target and census. The architect adjudicates blocking findings. The supervisor
   restarts crashed executors; runners keep workloads and terminal evidence durable across recovery.
3. **Build and certify.** Ready units get isolated worktrees and atomic resource/CPU reservations. A conditional
   independent pre-build review annotates risky traits, non-local proof or changed meaning. Builders ground their
   specs first, implement, run targeted checks and report evidence. The executor quiesces workloads, captures evidence,
   salvages changes and tears resources down before running full lanes and witnesses. A fresh gate judges the diff,
   actual reach against intent/non-goals, and evidence-backed responses to standing findings. Failed checks and gate
   revisions feed fix rounds with original evidence and base comparisons.
4. **Publish the tested head.** An approved unit gets a candidate on the current integration tip. Candidate lanes
   retain unit attribution; only a green exact head is fast-forwarded. Snapshots and retirement follow. A spike
   answers a declared question and retires its gated report without merging. Cheap local checks run early;
   expensive local checks run on candidates, with scarce shared/cross-system checks at batch/milestone boundaries.
5. **Judge the experience and campaign.** Once milestone units retire, its selected lanes run and one experience
   role walks its journeys and judges polish comparisons. Breaks hold downstream work; deviations can be repaired
   alongside it. Fresh whole-range campaign audits run at milestones, on request and at the final boundary, judging
   invariants, vacuity, interactions and document drift together. Audits report findings and root requests; the
   architect changes the plan and alone authorizes obligation dispositions. Audit dismissal requests await the root;
   `dismiss F-n --counter-evidence "<line>"` records its evidence-backed decision, including for P1 findings.
6. **Supervise from the command center.** The architect watches actionable events and reads `status --summary` for
   progress, spend versus expectations, milestone verdicts, caught counts and waste. To change inputs, export the
   current pack, edit it, then `apply --from <dir> --rev <N> --reason "<line>"`. Edited files must still match their
   exported base; untouched files take current bytes, and edited specs advance automatically. Steer cancels an
   unfinished unit into a directed round; note informs its next build without interruption. Successful subject
   actions close their notices; dismissal closes settled finding requests and suppresses the same finding on unchanged code. Ack is only for offered options. External witnesses are explicit root attestations
   with head-bound file/URL evidence. No output matching substitutes for proof.
7. **Close out and check in.** Final audit, witnesses, batch lanes, document publication and snapshots settle before
   completion. The architect prepares the stacked PR, presents `brief` and the demo/rough edges, then acknowledges
   the exact brief only after the owner does. Another arc starts only within the chain bound and while the vision
   calls for work.

Diagnosis begins at 8 builds or 20 judged build/lanes/gate attempts, counting interrupted and uncharged work. It
supplies a note and moves remaining mixed-profile builds to Claude. The fixed 16-build/40-stage boundary raises an
attempt-cap item for the architect. Spend expectations are forecasts, never caps. Usage limits park a backend until
explicit resume. Non-blocking waste findings advise the architect; they do not rewrite the plan.

System responsibility is not a file fence: paths beyond declared systems become gate input. Protected roadmap and
pinned corpus paths remain guarded. `docs/systems/<system>.md` (configurable) is non-normative build memory, edited
through ordinary gated diffs; normative claims stay in the corpus. Commit bodies retain captured summaries and
structured decisions, making later work and crash recovery intelligible.

The `vision` skill owns target dialogue and confirmation. The `estate-compaction` skill records owner-approved
reductions of rules, obligations, root ledger text and debt for the next Phase 0.

## Layout

```
.claude-plugin/marketplace.json     # this marketplace
plugins/roadmap-orchestrator/
  .claude-plugin/plugin.json
  executor/                         # the 1.0 executor (TypeScript on Node 24)
  skills/orchestrate/               # SKILL.md, reference.md (every command), RATIONALE-1.0.md
  skills/vision/                    # SKILL.md: distil and calibrate the arc's vision in dialogue
  skills/estate-compaction/         # SKILL.md: prune the accumulated estate with you, applied at Phase 0
docs/flow.svg                       # how an arc runs: simplified overview
docs/flow-bpmn.svg                  # how an arc runs: the detailed process in BPMN
DESIGN-1.0.md                       # binding 1.0 design brief
```

## Development

From `plugins/roadmap-orchestrator/executor/`: `npm run typecheck` → `npm test` → `node evals/probe.ts` (real
CLIs) → the role evals in `evals/roles/` that the batch's changes trigger → the paid fixtures (`evals/m1/`, and
`evals/m5/`, the UI end to end, when milestones, walks, design units or the demo changed), once per merged batch.
See `CLAUDE.md`.
