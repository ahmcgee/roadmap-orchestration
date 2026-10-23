// Delegation guidance for the Claude implementer (owner ruling 2026-10-16): the session's main agent owns the outcome and
// may start subagents with the Agent tool, choosing the model per task (the owner's priced-subagents ruling; the `model`
// values are the Agent tool's own: haiku, sonnet, opus). Re-derived 2026-10-17 from the 5.5-generation guides alone
// (owner ruling: earlier-generation guides do not bind): "Prompting best practices" (subagent orchestration: current
// models delegate natively and recognise when a task benefits; its overuse warning names Opus 4.6 and Opus 5 only) and
// "Prompting Claude Opus 5.5" (long autonomous work runs well with parallel subagents). So the text says what a subagent
// is for and that its report is a lead, and no longer damps delegation: the Opus 5 lines ("one subagent when one
// suffices", "never a subagent to re-check your own work") are gone. The Sonnet 5.5 guide's reviewer-subagent caution
// applies at xhigh and max effort, where no build seat runs. Edits stay in the main session so one agent knows the
// worktree's state when it runs the lanes and reports (our own invariant: the report is the session's).
//
// Judgment sessions (gate, plan-check, lens, checkpoint, pack review, flow) carry no delegation text (owner ruling
// 2026-10-17, after the paid gate role eval: one trial fanned out to 25 readers for $32, against ~$2.7 for a typical
// trial). Nothing tells the judge to delegate or not to. A judge keeps the Agent tool with read-only subagents
// (argv.ts `JUDGMENT_TOOLS`, metered as before) and arrives at its own method; the prompt does not steer it. One exception
// (1.0.0-dev.12): a gate whose diff is over the large-diff threshold gets the owner's delegation method in its own module
// (src/prompts/gate/claude-opus-5-5.ts <large_diff>), since one context cannot cover that diff.
//
// dev.17 (BACKLOG watch W2, triggered in the field 2026-10-23): every judgment session ends its system text with
// JUDGE_SUBAGENTS, a constraint of the call, not a method: whether to delegate stays the judge's. A judge that ended its turn
// while background subagents ran printed a result per later turn; a gate's first result was the session limit, its
// subagents' failures came after, and the executor read the last, empty one. The executor reads one answer per call.

/** The Claude implementer: it writes in its worktree, and a subagent helps it read and think. */
export const BUILD_DELEGATION = `<subagents>
You own the unit's outcome, and you may use subagents (the Agent tool) where they help. Choose each one's model for its task: surveying many files for the code a change touches suits a fast, inexpensive model (model: haiku); a hard design sub-question suits a stronger one (model: opus). A subagent's report is a lead: open the code yourself before you change it or rely on it. Make the edits in your own session, so one agent knows the worktree's state when you run the lanes and write the report.
</subagents>`;

/** Every judgment session (dispatch.ts `judgeSystem`): its subagents, if any, report before its answer. */
export const JUDGE_SUBAGENTS = `<subagents>
If you start subagents (the Agent tool), run each in the foreground, never in the background, and answer once their reports are in; several started in one turn still run in parallel. Your answer ends the call: a subagent still running then is cut off, and one that fails afterwards can leave the call with no answer.
</subagents>`;
