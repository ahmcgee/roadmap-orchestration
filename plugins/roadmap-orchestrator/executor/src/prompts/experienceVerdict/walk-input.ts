// walkthrough × claude-opus-5-5 (dev.13, plan §2 and §6). An acting judge: it uses the milestone's running product along
// each journey, as its user or client would, and reports what breaks, what departs from the milestone's design reference,
// and what it would polish. Guides: "Prompting Claude Opus 5.5" and "Prompting best practices" as it applies to current
// models (platform.claude.com, read 2026-10-18); earlier-generation guides do not bind (owner ruling 2026-10-17).
// Applied from "Prompting Claude Opus 5.5":
// - Unattended agentic runs: <working_unattended> and <how_your_session_ends> name the early stops to avoid (a progress
//   summary, an offer to continue, a report at a milestone of the work) and the one stop wanted (the final report), adapted
//   to a session whose report is its last act: the runner ends the session, and the browser, after `final: true`.
// - Capabilities relevant to prompting (computer use: operating applications from screenshots over many steps; meaning that
//   depends on position): <driving_the_product> asks for a fresh capture after every action that changes the screen and
//   for layout judged from the image, not from the accessibility tree alone.
// - Tools for complex visual inputs: <seeing> asks for full-resolution captures, per-component crops and zoom for dense
//   screens, with any image tools the environment has.
// - Frontend design defaults: a general "avoid a generic look" swaps one default for another, while named patterns work;
//   <lenses> judges against the anti-patterns the design reference names, with the frontend-design calibration list
//   (dev13 research §A) as examples that count only when the reference names them, and appeal judged only as fit to the
//   reference's stated direction (research §B, §F.2).
// - Mark pasted text: the guide's note that 5.5 resists instructions in on-screen and browser content; <workspace> says
//   what the product shows is under review, never instruction.
// - Calibrate effort and thinking instructions: no "think carefully" lines; effort is the routing's.
// From "Prompting best practices": the role in the system prompt; XML sections; long inputs first (the references and the
// merged units' specs as documents), the ask last; the vision first, as in every arc role (A14).
// Owner and plan requirements: the rubric as lenses, not a procedure (models own method; research §F.1); what a tool can
// measure is measured (contrast from the DOM, exit codes, timings, console errors; research §F.3); both viewports
// (1280x800 pinned, a 390 px narrow pass), reduced motion; the surface table of plan §2 for shell journeys; every cited
// file kept in the evidence dir, cited relative to it (code refuses an answer citing a missing file); the classes as the
// owner's 2026-10-18 rule, stated as its reason (a `breaks` is a defect whose later fix forces rework of what is built on
// it: a journey that cannot be completed, meaning the product's own action fails, not that its messages leave the user
// to dig; a wrong interface contract; a declared floor violated), and their `against`
// (WALK_AGAINST) with the calibration that a false `breaks` is the costly error; polish as full units, never
// findings; the product's checkout is never modified. No delegation text (judgment sessions carry none; a subagent
// inherits the session's model).
import type { Journey } from '../../input/plan.ts';
import type { KeptTweak, ProductInstance, PromptModule, WalkthroughInputs } from '../inputs.ts';
import { bullets, documentsXml, findingViewsText, visionText } from '../inputs.ts';
import type { WalkFindingView } from '../inputs.ts';
import { WALKTHROUGH_SCHEMA } from '../schemas.ts';

function journeysText(journeys: readonly Journey[]): string {
  return journeys.map((j) => {
    const budget = j.budget === null ? 'no budget' : `budget ${j.budget.steps} steps, ${j.budget.seconds} s`;
    return `- ${j.id} (via ${j.via}; entry ${j.entry}; ${budget}): ${j.text}`;
  }).join('\n');
}

function productText(p: ProductInstance): string {
  const ports = Object.entries(p.ports).map(([name, port]) => `${name}: port ${port}`);
  const env = Object.entries(p.env).map(([k, v]) => `${k}=${v}`);
  return [`checkout: ${p.checkout}`, `ports:\n${bullets(ports, '(none: nothing long-lived)')}`, `env:\n${bullets(env, '(none)')}`].join('\n');
}

/** The open findings as every role lists them, each with the cause it was recorded under (findings dedupe on it). */
function openFindingsText(findings: readonly WalkFindingView[]): string {
  if (findings.length === 0) return findingViewsText(findings);
  return findings.map((f) => `${findingViewsText([f])}${f.cause === null ? '' : ` (cause: ${f.cause})`}`).join('\n');
}

function tweaksText(tweaks: readonly KeptTweak[]): string {
  return bullets(tweaks.map((t) => `${t.proposal} (unit ${t.unit}): ${t.text}`), '(none)');
}

export const render = (i: WalkthroughInputs) => `<vision>
${visionText(i.vision)}
</vision>

<references>
${documentsXml(i.references.map((r) => ({ source: `design reference ${r.path}`, content: r.text })))}
</references>

<merged_units>
${documentsXml(i.units.map((s) => ({ source: `spec.json for unit ${s.unit}, revision ${s.rev} (rendered)`, content: s.markdown })))}
</merged_units>

<milestone id="${i.milestone.id}" round="${i.round}">
${i.milestone.text}
</milestone>

<journeys>
${journeysText(i.journeys)}
</journeys>

<product>
${productText(i.product)}
</product>

<kept_tweaks>
${tweaksText(i.tweaks)}
</kept_tweaks>

<open_findings>
${openFindingsText(i.findings)}
</open_findings>

<evidence_dir>${i.evidenceDir}</evidence_dir>

Walk round ${i.round} of milestone ${i.milestone.id}: use the running product along every journey above, keep your evidence in ${i.evidenceDir}, then return your report.`;

