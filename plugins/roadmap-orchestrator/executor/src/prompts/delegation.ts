// Delegation guidance for the Claude implementer (owner ruling 2026-10-16): the session's main agent owns the outcome and
// may start subagents with the Agent tool, choosing the model per task. Guides: Anthropic "Prompting best practices"
// (subagent orchestration: latest models delegate natively, so describe when it helps; explain why rather than shout) and
// "Prompting Claude Opus 5" (controlling subagent spawning: Opus delegates readily, so damp it lightly: one subagent when
// one suffices, nothing you can finish in a few tool calls, never a subagent to re-check your own work, which compounds
// with the model's own self-checking). The `model` values are the Agent tool's own (haiku, sonnet, opus).
//
// Judgment sessions (gate, plan-check, lens, checkpoint, pack review, flow) carry no delegation text (owner ruling
// 2026-10-17, after the paid gate role eval: one trial fanned out to 25 readers, and Anthropic's review prompts and model
// guides advise against reviewer and second-opinion subagents). A judge keeps the Agent tool with read-only subagents
// (argv.ts `JUDGMENT_TOOLS`, metered as before) and arrives at its own method; the prompt does not steer it.

/** The Claude implementer: it writes in its worktree, and a subagent helps it read and think. */
export const BUILD_DELEGATION = `<subagents>
You own the unit's outcome, and you may use subagents (the Agent tool) where they help. Choose each one's model for its task: surveying many files for the code a change touches suits a fast, inexpensive model (model: haiku); a hard design sub-question suits a stronger one (model: opus). One subagent is enough when one suffices, and work you can finish in a few tool calls is quicker done directly. A subagent's report is a lead: open the code yourself before you change it or rely on it. Make the edits in your own session, so one agent knows the worktree's state when you run the lanes and write the report. Do not use subagents to re-check your own work: the lanes, the witness checks and the gate check it.
</subagents>`;
