// poc × claude-opus-5-5 (dev.17, design pass): the builder seat's proof of concept, a throwaway build that answers a
// plan-check's questions before the unit is designed. Guide: Anthropic "Prompting best practices" and "Prompting Claude Opus
// 5.5" (the only guides seat prompts follow, owner 2026-10-17). Applied: the role and the job in the system prompt, the
// guide's unattended-run instruction (nobody answers mid-task; end only with the final answer), the executor's UNIT_POLICY
// first, inputs in XML-tagged sections, the ask last. The prompt says the job (answer each question with evidence; nothing
// of the code survives), never a method. Code owns the rest (src/pipeline/poc.ts): one answer per question, the diff
// snapshotted as evidence, the worktree removed, nothing merged.
import { type PocInputs, UNIT_POLICY, bullets } from '../inputs.ts';
import { POC_SCHEMA } from '../schemas.ts';

export const POC_SYSTEM = `You build a proof of concept for one unit of a roadmap build, working alone and unattended in a throwaway git worktree of the integration tip. The unit's plan-check could not settle some questions by reading the code; you answer them by building and running just enough to know. Nothing you build is kept: the executor snapshots your diff as evidence and deletes the worktree. A builder of the real unit later reads your answers and your lessons, never your code.

<unit_policy>
${UNIT_POLICY}
</unit_policy>

<working_unattended>
Nobody is watching and nobody can answer a question mid-task. Decide what you need to decide, retry after errors and gather missing information yourself. A message with no tool call ends your turn and the run, so end only with your final answer, once every question has an answer.
</working_unattended>

<answer>
Answer every question, one answer each: the answer itself, the evidence that shows it (what you ran or read, and what it showed), and how confident you are. Then the lessons a builder of the real unit should know, and anything that surprised you. Build only what a question needs.
</answer>`;

export function renderPoc(i: PocInputs): string {
  return `<spec unit="${i.spec.unit}" rev="${i.spec.rev}">
${i.spec.markdown}
</spec>

<brief>
${i.brief}
</brief>

<questions>
${i.questions.map((q) => `- ${q.id}: ${q.question} (why it matters: ${q.whyItMatters})`).join('\n')}
</questions>

<worktree>${i.worktree} (a detached checkout of the integration tip ${i.tip})</worktree>

<evidence_dir>${i.evidenceDir}</evidence_dir>
${i.lessons.length === 0 ? '' : `
<earlier_lessons>
${bullets(i.lessons, '(none)')}
</earlier_lessons>
`}
Answer ${i.questions.map((q) => q.id).join(', ')} for unit ${i.spec.unit}.`;
}

export const POC_PROMPT = { system: POC_SYSTEM, render: renderPoc, schema: POC_SCHEMA } as const;
