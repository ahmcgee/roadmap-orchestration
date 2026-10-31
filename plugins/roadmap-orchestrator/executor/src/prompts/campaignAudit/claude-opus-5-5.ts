import { PROMPT as lens } from '../lens/claude-opus-5-5.ts';
import { documentsXml, targetDocument, visionText, obligationsText, boundedDiffText, findingViewsText, specsOnlyText } from '../inputs.ts';
import type { PromptModule } from '../inputs.ts';
import { CAMPAIGN_AUDIT_SCHEMA } from '../schemas.ts';
import { methodModules } from '../method/index.ts';
export const PROMPT: PromptModule<'campaignAudit'> = {
  ...lens,
  system: `You audit the whole campaign range at a milestone in a fresh context. Judge invariants, witness vacuity and cross-unit interactions together, with document drift as a short final check. Use the vision, intent, obligations, contracts and pinned corpus. Check seams and plausible wrong implementations against the supplied evidence; a passing test does not establish a claim it never exercises. A finding needs concrete repository or experimental evidence. Distinguish a product defect, a vacuous witness and missing environment evidence. Report findings plus request ops only. You never amend the plan, dispose or waive obligations, or apply a repair. The root decides amendments through apply --reason. A dismissal of a prior finding needs an explicit counter-evidence line. Do not read the rulings ledger. System notes, if encountered, are non-normative build memory. Work unattended to one structured answer; report only what you verified.`,
  schema: CAMPAIGN_AUDIT_SCHEMA,
  fields: ['vision', 'obligations', 'range', 'owners', 'priorFindings', 'contracts', 'target', 'checkout', 'specsOnly'],
  render: (i) => `<vision>${visionText(i.vision)}</vision>\n<obligations>${obligationsText(i.obligations, {serves: true})}</obligations>\n${documentsXml([...i.contracts.map((c) => ({source: c.path, content: c.text})), targetDocument(i.target)])}\n<audited_range audited="${i.range.audited}">${boundedDiffText('range', i.range.diff, null)}</audited_range>\n<owners>${i.owners.map((o) => `${o.unit} ${o.head}\n${boundedDiffText('owner', o.diff, null)}`).join('\n')}</owners>\n<prior_findings>${findingViewsText(i.priorFindings)}</prior_findings>\n<checkout>${i.checkout}</checkout>${specsOnlyText(i.specsOnly)}\n${methodModules('audit', {traits: [], markers: [], unitKind: 'campaign', expensiveLanes: false, ui: false})}`,
};
