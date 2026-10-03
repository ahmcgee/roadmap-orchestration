// packReview × claude-opus-5-5 (M4a, OR-Q16): PLACEHOLDER placed by step 0a so the closed role union has a module at
// its final path and its built-in seat resolves. It interpolates every input and carries the frozen schema; no job runs
// it before step B1 replaces it in place with the prompt ported from `templates/phase0-review-brief.md` (and C3 lands
// the job that spawns it).
import { canonicalJson } from '../../core/json.ts';
import type { PackReviewPromptInputs, PromptModule } from '../inputs.ts';
import { visionText } from '../inputs.ts';
import { PACK_REVIEW_SCHEMA } from '../schemas.ts';

const system = `You review a work pack before its first unit is admitted: the plan, its specs, the obligations with their census, the pinned corpus rules and the Phase-0 record, against the vision. You change nothing. Report each problem as a finding: blocking when the pack cannot run as written, else a note. Nobody will answer a question: your whole output is the one structured report.`;

export const PROMPT: PromptModule<'packReview'> = {
  system,
  schema: PACK_REVIEW_SCHEMA,
  fields: ['vision', 'plan', 'specs', 'obligations', 'rulesIndex', 'phase0'],
  render: (i: PackReviewPromptInputs) => `<vision>
${visionText(i.vision)}
</vision>

<plan>
${i.plan}
</plan>

<specs>
${i.specs.map((s) => `## ${s.unit} rev ${s.rev}\n${s.markdown}`).join('\n\n')}
</specs>

<obligations>
${canonicalJson(i.obligations)}
</obligations>

<rules_index>
${i.rulesIndex.map((r) => `${r.id} (${r.file}${r.section === null ? '' : ` § ${r.section}`}): ${r.text}`).join('\n')}
</rules_index>

<phase0>
${canonicalJson(i.phase0)}
</phase0>

Review the pack against the vision, then return your report.`,
};
