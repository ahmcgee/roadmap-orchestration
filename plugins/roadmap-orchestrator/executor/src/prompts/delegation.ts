// Delegation guidance (owner ruling 2026-10-16), one text per kind of session, in every Claude role prompt: the session's
// main agent owns the outcome and may start subagents with the Agent tool, choosing the model per task. Guides: Anthropic
// "Prompting best practices" (subagent orchestration: latest models delegate natively, so describe when it helps; explain
// why rather than shout) and "Prompting Claude Opus 5" (controlling subagent spawning: Opus delegates readily, so damp it
// lightly: one subagent when one suffices, nothing you can finish in a few tool calls, never a subagent to re-check your
// own work, which compounds with the model's own self-checking). A judge's subagents are read-only like the judge: the
// judgment launcher grants the Agent tool and keeps its subagents read-only (gate method redesign, W2). The `model` values
// are the Agent tool's own (haiku, sonnet, opus).

/** A judgment session (gate, plan-check, lens, checkpoint, pack review, flow): read-only, one structured answer. */
export const JUDGE_DELEGATION = `<subagents>
You own this answer, and you may use subagents (the Agent tool) where they help. They are read-only, as you are. Choose each one's model for its task: bulk reading, such as many files or a long diff file, suits a fast, inexpensive model (model: haiku); a hard sub-question you want weighed on its own suits a stronger one (model: opus). One subagent is enough when one suffices, and a question you can settle in a few reads of your own is quicker settled directly.
A subagent's answer is a lead, not evidence. Every finding, premise and approval you return rests on files you opened yourself, or on lines a subagent quoted to you with their file and line, so ask for quotes. Do not use subagents to re-check your own conclusions: you already check your work, and a second pass of the same judgment adds cost without catching more.
</subagents>`;

/** The Claude implementer: it writes in its worktree, and a subagent helps it read and think. */
export const BUILD_DELEGATION = `<subagents>
You own the unit's outcome, and you may use subagents (the Agent tool) where they help. Choose each one's model for its task: surveying many files for the code a change touches suits a fast, inexpensive model (model: haiku); a hard design sub-question suits a stronger one (model: opus). One subagent is enough when one suffices, and work you can finish in a few tool calls is quicker done directly. A subagent's report is a lead: open the code yourself before you change it or rely on it. Make the edits in your own session, so one agent knows the worktree's state when you run the lanes and write the report. Do not use subagents to re-check your own work: the lanes, the witness checks and the gate check it.
</subagents>`;
