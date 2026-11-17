import { render as gateInput, system } from './gate-input.ts';
import { bullets, documentsXml, laneFailuresText, targetDocument, visionText } from '../inputs.ts';
import type { DiagnosisEvidence, PromptModule, ReviewBrief } from '../inputs.ts';
import { methodModules } from '../method/index.ts';
import { GATE_SCHEMA } from '../schemas.ts';
// dev.82 (E2; written against "Prompting Claude Opus 5.5" and "Prompting best practices" alone: plain prose that says why, the
// known evidence before the history, the ask last): a diagnosis answers its own schema (schemas.ts `DIAGNOSIS_SCHEMA`, which
// surface.ts passes in place of GATE_SCHEMA for that mode). <evidence> carries what the executor already knows, so the
// diagnosis starts from the failure, the base comparison and the environment rather than from a directory listing.

function evidenceText(e: DiagnosisEvidence): string {
  const base = e.baseComparison.map((c) => `${c.lane}: ${c.result === 'fail' ? 'red' : 'green'} on the diff base ${c.base} alone (evidence ${c.evidence})`);
  return `<evidence>
Why this diagnosis is due:
${bullets(e.trigger, '(none)')}
What the failing lanes printed in the unit's latest lanes attempt:
${laneFailuresText(e.failures)}
The same lanes on the unit's diff base alone:
${bullets(base, '(not compared)')}
Probe targets with a tripped breaker:
${bullets(e.environment.tripped, '(none)')}
Outstanding retryable parks in the arc:
${bullets(e.environment.retryableParks, '(none)')}
Host signatures seen on the red runs:
${bullets(e.environment.hostSuspected, '(none)')}
The plan's known defects:
${bullets(e.knownDefects, '(none)')}
Flaky ledger keys on these lanes:
${bullets(e.flaky, '(none)')}
</evidence>`;
}

function reviewText(b: ReviewBrief): string {
  return `${b.vision === null ? '' : `<vision>${visionText(b.vision)}</vision>`}\n${documentsXml([targetDocument(b.target), {source: 'spec', content: b.spec.markdown}, ...b.contracts.map((c) => ({source: c.path, content: c.text}))])}\n<intent>${b.intent}</intent>\n<non_goals>${JSON.stringify(b.nonGoals)}</non_goals>\n<systems>${JSON.stringify(b.systems)}</systems>\n<history>${JSON.stringify(b.history)}</history>\n<standing>${JSON.stringify(b.standing)}</standing>\n${methodModules('verifier', b.method)}`;
}

export const PROMPT: PromptModule<'verifier'> = {
  system, schema: GATE_SCHEMA, fields: ['mode', 'brief'],
  render: (i) => {
    switch (i.mode) {
      case 'gate':
        return `<mode>gate</mode>\n${gateInput(i.brief)}`;
      case 'pre-build':
        return `<mode>pre-build</mode>\n${reviewText(i.brief)}\nReturn findings, reasons and premises; standing responses and rulings are empty outside gate mode.`;
      case 'diagnosis':
        return `<mode>diagnosis</mode>\n${evidenceText(i.brief.evidence)}\n${reviewText(i.brief)}\nReturn the cause, the evidence it rests on, the brief for the next build and your reasons.`;
    }
  },
};
