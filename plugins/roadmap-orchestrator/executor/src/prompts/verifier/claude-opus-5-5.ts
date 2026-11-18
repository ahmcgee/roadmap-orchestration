import { render as gateInput, system } from './gate-input.ts';
import { boundedDiffText, bullets, documentsXml, laneFailuresText, targetDocument, visionText } from '../inputs.ts';
import type { DiagnosisEvidence, EndgameReviewBrief, PromptModule, ReviewBrief } from '../inputs.ts';
import { methodModules } from '../method/index.ts';
import { GATE_SCHEMA } from '../schemas.ts';
// dev.83 (E2; written against "Prompting Claude Opus 5.5" and "Prompting best practices" alone: plain prose that says why, the
// known evidence before the history, the ask last): a diagnosis answers its own schema (schemas.ts `DIAGNOSIS_SCHEMA`, which
// surface.ts passes in place of GATE_SCHEMA for that mode). <evidence> carries what the executor already knows, so the
// diagnosis starts from the failure, the base comparison and the environment rather than from a directory listing.
// dev.83 (WS-5; written against the same two guides alone): the endgame review is the one review the architect's hand-made
// endgame work gets, since no gate saw it, so its whole brief (what it is, why, what blocks) lives in the endgame mode's
// message and the system text the gate shares is unchanged. It answers its own schema (`ENDGAME_REVIEW_SCHEMA`), passed by
// src/endgame/review.ts in place of GATE_SCHEMA. Only a P1 holds the arc, so the message says what a P1 is.

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

function endgameText(b: EndgameReviewBrief): string {
  const fixes = b.fixes.map((f) => `${f.command} at ${f.commit} closes ${f.closes.join(', ')}: ${f.note}`);
  const publications = b.publications.map((p) => `${p.head} ${p.what}${p.gated ? ' (already gated: its unit passed the gate)' : ' (not gated)'}`);
  return `${b.vision === null ? '' : `<vision>${visionText(b.vision)}</vision>\n`}<endgame>
The arc's planned work is done. What its audits and walks found afterwards was finished by hand by the architect on the endgame branch and landed on the integration branch. No gate reviewed that work, so you are its independent review, over the endgame's own range ${b.range.from}..${b.range.to}.
</endgame>
<fixes>
The fixes the architect recorded, each with what it closes:
${bullets(fixes, '(none recorded)')}
</fixes>
<publications>
What was published in the range. A unit's or a batch's work already passed its gate, so weigh it only where the hand-made work touches it:
${bullets(publications, '(none)')}
</publications>
<active_findings>
${bullets(b.findings, '(none)')}
</active_findings>
${boundedDiffText('endgame', b.diff, null)}
<your_checkout>
${b.checkout} is a detached checkout of ${b.range.to} for you to read and to run local experiments in. Save any evidence you cite under ${b.evidenceDir}.
</your_checkout>
Review the range for real defects: a fix that does not do what it says it closes, a regression it introduces, a test weakened to pass, a contract or obligation it breaks. Give each finding a severity. P1 is a defect the arc must not complete with: the work is wrong or unsafe as it stands. P2 is a real defect that can wait, and P3 a minor one; neither holds the arc. Cite in evidence the paths, lines and experiments each finding rests on. Return an empty findings list when the work is sound.`;
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
      case 'endgame':
        return `<mode>endgame</mode>\n${endgameText(i.brief)}`;
    }
  },
};
