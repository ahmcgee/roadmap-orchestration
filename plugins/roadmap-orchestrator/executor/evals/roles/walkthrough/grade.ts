// Grading one walkthrough trial: its validated report against the answer key's 13 slots, and its transcript for whether
// each slot's journey was really exercised (plan §7, "Grading").
//
// - Localising: a finding belongs to the slot, among those reported on the finding's journey, that it localises to best:
//   3 for one of its `paths` among the slot's files, 1 per slot marker its claim or cause matches (the page's route, the
//   family's words). A finding scoring nothing on every slot of its journey is stray. Ties go to a planted slot (the twin
//   is good behaviour; an ambiguous finding is about the defect), then to family order.
// - A planted slot: `caught` with a finding of at least the expected class (`breaks` for W1, W5, W6, W13; `deviates` or
//   either for the rest); `misclassed` when its findings are all `deviates` and `breaks` was expected; `missed` with none;
//   `lucky` when caught but its journey shows no exercise in the transcript (no page visited, command run or request
//   sent, outside Read, Grep and Glob). A `breaks` finding on a slot expecting `deviates` is caught and false-blocking.
// - A twin slot: `false-positive` with any finding on it (false-blocking too when one is `breaks`), else `clean`.
// - Stray findings are counted, and a stray `breaks` is false-blocking: the clean product has nothing that breaks.
// - Polish proposals are counted (the polish rate), never false positives.
import type { WalkthroughOutput } from '../../../src/prompts/schemas.ts';
import type { Transcript } from '../transcript.ts';
import { FAMILY_IDS, type FamilyId, type SlotState } from './families.ts';
import type { SlotKey } from './fixture.ts';

export type SlotVerdict = 'caught' | 'misclassed' | 'missed' | 'lucky' | 'clean' | 'false-positive';

export type SlotGrade = Readonly<{
  family: FamilyId;
  state: SlotState;
  verdict: SlotVerdict;
  falseBlocking: boolean;
  /** The report's findings localised to this slot, by index. */
  findings: readonly number[];
  exercised: boolean;
}>;

export type WalkGraded = Readonly<{
  slots: readonly SlotGrade[];
  findings: number;
  stray: Readonly<{ findings: number; breaks: number }>;
  polish: number;
  blocked: number;
}>;

const INSPECT = new Set(['Read', 'Grep', 'Glob']);

/** Whether the session's tool traffic, outside Read, Grep and Glob, matches one of `patterns`. */
export function exercised(t: Transcript, patterns: readonly string[]): boolean {
  const res = patterns.map((p) => new RegExp(p, 'i'));
  return t.calls.some((c) => !INSPECT.has(c.name) && res.some((re) => re.test(`${JSON.stringify(c.input)}\n${c.result ?? ''}`)));
}

/** How well `finding` localises to `slot`: 0 when it does not. */
export function localise(finding: WalkthroughOutput['findings'][number], slot: SlotKey): number {
  if (!slot.journeys.includes(finding.journey)) return 0;
  const text = `${finding.claim}\n${finding.cause}`;
  const paths = finding.paths.filter((p) => slot.files.includes(p)).length > 0 ? 3 : 0;
  return paths + slot.markers.filter((m) => new RegExp(m, 'i').test(text)).length;
}

/** The slot index each finding belongs to, or null (stray). */
export function assignFindings(findings: WalkthroughOutput['findings'], slots: readonly SlotKey[]): readonly (number | null)[] {
  return findings.map((f) => {
    let best: number | null = null;
    let bestScore = 0;
    slots.forEach((s, i) => {
      const score = localise(f, s);
      if (score === 0) return;
      const better = best === null || score > bestScore
        || (score === bestScore && s.state === 'plant' && slots[best]!.state === 'twin')
        || (score === bestScore && s.state === slots[best]!.state && FAMILY_IDS.indexOf(s.family) < FAMILY_IDS.indexOf(slots[best]!.family));
      if (better) {
        best = i;
        bestScore = score;
      }
    });
    return best;
  });
}

export function gradeWalk(slots: readonly SlotKey[], t: Transcript, answer: WalkthroughOutput): WalkGraded {
  const owner = assignFindings(answer.findings, slots);
  const graded = slots.map((s, i): SlotGrade => {
    const mine = answer.findings.flatMap((f, k) => (owner[k] === i ? [k] : []));
    const classes = mine.map((k) => answer.findings[k]!.class);
    const breaks = classes.includes('breaks');
    const ex = exercised(t, s.exercise);
    if (s.state === 'twin') return { family: s.family, state: s.state, verdict: mine.length > 0 ? 'false-positive' : 'clean', falseBlocking: breaks, findings: mine, exercised: ex };
    if (mine.length === 0) return { family: s.family, state: s.state, verdict: 'missed', falseBlocking: false, findings: mine, exercised: ex };
    const reached = s.expected === 'breaks' ? breaks : true;
    const verdict: SlotVerdict = !reached ? 'misclassed' : ex ? 'caught' : 'lucky';
    return { family: s.family, state: s.state, verdict, falseBlocking: s.expected === 'deviates' && breaks, findings: mine, exercised: ex };
  });
  const stray = answer.findings.filter((_, k) => owner[k] === null);
  return {
    slots: graded, findings: answer.findings.length,
    stray: { findings: stray.length, breaks: stray.filter((f) => f.class === 'breaks').length },
    polish: answer.polish.length, blocked: answer.journeys.filter((j) => j.outcome === 'blocked').length,
  };
}
