You are a senior architect of agentic software systems. Your specialty is designing Claude Code skills that orchestrate large multi-agent workflows economically — getting frontier-model judgment only where it changes outcomes, and pushing everything else onto cheaper models or plain code.

I want you to design a general, reusable approach — an architecture and control model, not a finished implementation — for a Claude Code skill I'll call the roadmap orchestrator. Reason deeply about the tradeoffs; this is a design review, and I care more about a correct, economical control model than about code.

What the skill must do

Given three inputs:


A target-state architecture and a roadmap / arc of deliverables — in whatever form it arrives (prose doc, checklist, issue tracker export, RFC, mixed). Assume it is not pre-structured.
Direction from the user about where in that roadmap the current session should end (the target milestone / cut line).
The existing codebase it operates on.


…the skill should collapse what would normally be several independent, human-driven sessions into a single orchestrated arc: rationalize how the roadmap decomposes into independently develop-able units up to the session's target, set up an isolated git worktree per unit, stand up a dynamic workflow per unit that owns its own implementation / testing / verification, and integrate the results back to main — coherently and without races. It must be general and reusable across projects and roadmap formats, and efficient in the sense defined below.

The economic objective (this is the core constraint)

The orchestrating model (you, Fable) is metered at API rates and dominated by output-token cost. Sub-frontier models (Opus / Sonnet / Haiku) are effectively free at the margin within a generous subscription allowance. Therefore the design's primary optimization target is minimizing frontier-tier output tokens, not minimizing total tokens.

Concretely, design so that:


Frontier-tier judgment is confined to bounded, roughly O(1)-per-unit design/planning acts and to a small number of O(1) cross-cutting judgment points — never to O(N)-per-leaf work and never to high-volume generation.
All high-volume generation (writing code, writing fixes, per-file review) and all mechanical work runs on sub-frontier models.
Coordination, tracking, and bookkeeping cost zero model tokens wherever they can be expressed as code.
Escalation from a cheap model to the frontier tier is demand-gated by an explicit predicate, and the predicate is evaluated by a cheap model. Treat that predicate as the skill's spend dial and design it deliberately.


State, per component of your design, which model tier runs it and why.

Substrate (my current understanding — correct me where I'm wrong)

Claude Code dynamic workflows: a JavaScript orchestration script is the coordinator; it runs in an isolated runtime; agents are spawned from the script; intermediate results live in script variables, not in a model's context, and only final results surface. Primitives roughly like agent(), pipeline(), parallel(); the script can assign which model tier each agent uses; git worktrees give parallel agents isolated working copies. A key limitation: workflows take no mid-run human input — an agent proceeds on the context it was given at launch.

Treat all of the above as my belief, not ground truth. Explicitly separate "what I'm assuming about the platform" from "my design," and for each load-bearing assumption, state how you'd verify it and design a fallback if it's false. In particular I do not know, and need you to reason about both branches for: (a) whether a workflow can launch other full workflows (true nesting) versus only spawning agents; (b) the per-run ceilings on agent count, concurrency, and wall-clock duration; and (c) whether a roadmap slice will exceed a single run's budget, forcing waves + checkpoint/resume across runs.

Strawman architecture — pressure-test and improve this, don't just ratify it

Here is my current thinking. Tell me clearly where you agree, where you disagree, and why; replace any part with something better. I expect you to find weaknesses.


The root is code, not a living frontier agent. A frontier pass, upfront, decomposes the roadmap, builds a dependency DAG, and designs each unit's work into artifacts. Then a plain harness loop dispatches work, polls status, marks units done, checks whether dependents' prerequisites are met, and launches the next — with no frontier tokens spent on tracking. The frontier model is the author of the harness and the plans, not a resident orchestrator.
One parameterized workflow template, instantiated per unit from its plan — rather than authoring a bespoke harness per unit. Only genuinely structurally-different units get bespoke treatment.
Per-unit review/fix runs on the cheap tier, with demand-gated escalation to frontier only when the cheap reviewer flags something it can't resolve. Consider splitting review (low output, occasionally worth a low-effort frontier pass) from fix-generation (high output, keep cheap).
No autonomous per-workflow merge. Units produce tested, verified, merge-ready branches. The harness runs a serial merge queue that runs the test suite on the integrated result after each merge. The one guaranteed frontier pass sits at this post-integration gate, because cross-unit semantic incompatibility (two units each locally valid, jointly broken) is invisible to every unit-level agent and is the failure that actually matters.
Bounded give-up: after N failed review rounds a unit is quarantined and surfaced for re-design in a later pass, never looped on forever.
Structured state: parse the roadmap once (during the frontier design pass) into a DAG with per-unit status; run all tracking over that structured derivative with schema-bound handoffs; regenerate the human-readable roadmap view from it. Never re-parse prose with a model on every poll.
Independence check is load-bearing: if units are truly independent, all unit designs can be front-loaded and overlapped freely. If designing unit N needs unit N−1's output, that's contingent judgment that can't be front-loaded, and you need an outer re-planning loop (frontier reads a checkpoint, authors the next wave) — a legitimate but costlier shape. Make the design explicit about detecting which regime a given roadmap is in.


What I want you to produce

A design document covering, at minimum:


Decomposition & dependency model — how the skill turns an arbitrary roadmap into independently develop-able units and a DAG; the heuristics for cut points; how it detects and handles inter-unit dependencies and the independent-vs-contingent regime distinction.
Model-tier allocation map — every component labeled with its tier and a one-line cost rationale; a rough per-run cost shape as a function of unit count.
The code/model split — precisely what is deterministic harness code vs. a frontier act vs. a cheap-model act.
Per-unit workflow template — its stages, its review/verify loop, its bounded give-up, and how it's parameterized from a unit plan. Illustrative pseudocode is welcome; a full implementation is not.
Verification & escalation ladder — the demand-gated escalation predicate design, and where (if anywhere) frontier judgment is guaranteed vs. conditional.
Integration strategy — the serial merge queue, the post-integration test gate, and how cross-unit semantic conflict is detected and resolved.
Failure & quarantine handling — runaway-loop prevention, partial-arc completion, and how a quarantined unit re-enters.
Cross-run execution — waves, checkpointing, and resume, assuming a roadmap slice may exceed one run's limits; how "end the session here" is honored across waves.
State & schema — the structured roadmap/DAG representation and the schema-bound handoffs between stages.
Skill interface — how the user supplies inputs, targets the session endpoint, and inspects progress.
Platform assumptions & fallbacks — the separated list of assumptions (especially nesting, run ceilings, resume), how to verify each, and the fallback design if each is false.
Risks & where it breaks at scale — the parts you're least confident in, and what you'd prototype first to de-risk the whole thing.


Working style

Challenge my framing wherever a simpler or cheaper design dominates — I would rather you tell me the whole approach is wrong in some respect than tidy up a flawed strawman. Show your reasoning on the consequential tradeoffs. Keep the output at the level of a general, actionable approach: architecture, control flow, state model, and illustrative pseudocode — not a finished codebase. End with the single most important open question you'd want answered before building.
