// polishJudge × claude-opus-5-5 (dev.13, plan §4 "Polish units" step 3, §6). An acting judge at a polish unit's compare:
// two instances of the milestone's product run side by side, before (the integration tip) and after (the unit's approved
// commit), and the judge walks the proposal's journey on both and decides whether the after is an improvement on the
// proposal's own terms and the design reference. Keep lands the tweak; drop cuts it, and nothing lands.
// Guides: "Prompting Claude Opus 5.5" (platform.claude.com, read 2026-10-18) and "Prompting best practices" as it applies to
// current models; earlier-generation guides do not bind (owner ruling 2026-10-17).
// Applied from "Prompting Claude Opus 5.5": state the judgment boundary directly, explain its consequence and contrast
// easily confused cases (<judging>, polish mode only, so the shared system prompt's walkthrough block cannot crowd it out);
// no "think carefully" lines, since effort is the routing's.
// From "Prompting best practices": the role in the system prompt; XML sections; long inputs first (the references, the
// diff), the ask last; the vision first, as in every arc role (A14).
// Owner and plan requirements: keep iff the after is an improvement on the proposal's own terms and the reference; a worse
// or merely different after is dropped (the calibration: a kept regression is the costly error, so a tie drops); same
// session, viewport and settings on both sides; evidence cited by path (code refuses a citation of a missing file); the
// checkouts are never modified. No subagent method (a subagent inherits the session's model).
import type { ProductInstance, PromptModule, PolishJudgeInputs } from '../inputs.ts';
import { bullets, boundedDiffText, documentsXml, visionText } from '../inputs.ts';
import { POLISH_JUDGE_SCHEMA } from '../schemas.ts';

function instanceText(side: string, p: ProductInstance & Readonly<{ entry: string }>): string {
  const ports = Object.entries(p.ports).map(([name, port]) => `${name}: port ${port}`);
  const env = Object.entries(p.env).map(([k, v]) => `${k}=${v}`);
  return `<${side}>\ncheckout: ${p.checkout}\nentry: ${p.entry}\nports:\n${bullets(ports, '(none: nothing long-lived)')}\nenv:\n${bullets(env, '(none)')}\n</${side}>`;
}

export const render = (i: PolishJudgeInputs) => `<vision>
${visionText(i.vision)}
</vision>

<references>
${documentsXml(i.references.map((r) => ({ source: `design reference ${r.path} (after)`, content: r.text })))}
</references>

<tweak_diff>
${boundedDiffText('the tweak (before..after)', i.referenceDiff, null)}
</tweak_diff>

<milestone id="${i.milestone.id}">
${i.milestone.text}
</milestone>

<journey id="${i.journey.id}" via="${i.journey.via}">
${i.journey.text}${i.journey.budget === null ? '' : `\nBudget: ${i.journey.budget.steps} steps, ${i.journey.budget.seconds} s.`}
</journey>

<proposal id="${i.proposal.id}" unit="${i.proposal.unit}">
${i.proposal.text}
Evidence of the current state, in the original walk's evidence directory ${i.walkEvidenceDir}:
${bullets(i.proposal.evidence, '(none)')}
</proposal>

${instanceText('before', i.before)}

${instanceText('after', i.after)}

<evidence_dir>${i.evidenceDir}</evidence_dir>

<judging>
Keep only when the after is better for someone doing ${i.journey.id}, observed on both instances, and nothing on the journey got worse. A tweak that also edits the design reference does not prove itself by matching the rule it added: judge whether the experience improved. An after that is different but not better, such as reworded copy in another voice, a reordered section or a restyle of the same information, is neutral: drop it. A tradeoff counts against keeping: when any step of the journey becomes slower, longer or harder to find, drop it even though the proposal's complaint is fixed. A kept regression costs more than a dropped improvement, so drop on a tie or when unsure.
For example, a primary action relabelled from "Save" to "Store" is different, not better. Moving that action below the fold to make room for a requested banner is worse, even though the banner arrived. A form error that now names the field to fix is better.
</judging>

Walk ${i.journey.id} on the before instance and on the after instance, keep your evidence in ${i.evidenceDir}, then return your decision on proposal ${i.proposal.id}.`;
