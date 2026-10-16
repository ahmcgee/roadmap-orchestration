// Grading one gate trial from what really happened: what the gate recorded it was shown (its `judgment-inputs` `diffShown`:
// the files the bounded diff inlined and those with changed content it did not, deletions included, pure moves neither),
// the prompt it was given (the fake's calls.jsonl), its transcript (stream-json, main session and subagents) and its
// answer, against the answer key, which only the eval run dir holds.
//
// - Placement: the plant's file is inlined when `diffShown.inlined` holds it. A planted trial whose plant landed on the
//   other side of its cell's placement is void (`placement-miss`).
// - Looked at: the plant inlined, or a Read (any session) of its file or of its .diff, or a Grep whose output carried the
//   needle; a deletion is looked at when the prompt names its path.
// - Caught: decision revise or escalate with a blocking finding localised to the plant's path (its `path`, or a pathless
//   finding whose text names it). Caught without a look is `lucky`, a failure. Every other blocking finding is spurious.
// - Clean trials: any decision but approve is a false positive.
// - Coverage: of `diffShown.notInlined`, the share the session Read (file or .diff) or saw in a Grep.
import type { DiffShown } from '../../../src/core/events.ts';
import type { GateOutput } from '../../../src/prompts/schemas.ts';
import type { Placement } from './cells.ts';
import type { AnswerKey } from './fixture.ts';
import { type Transcript, grepResults, readPaths } from '../transcript.ts';

export type Verdict = 'caught' | 'missed' | 'lucky' | 'clean-pass' | 'false-positive';

export type Graded = Readonly<{
  verdict: Verdict;
  /** Where the plant's diff really was (null for a clean trial). */
  placement: 'inlined' | 'omitted' | null;
  placementMiss: boolean;
  looked: boolean | null;
  localised: boolean;
  blocking: number;
  spurious: number;
  coverage: Readonly<{ omitted: number; covered: number; share: number | null }>;
}>;

/** A Read of `path` (or of its .diff) in any session, or a Grep whose output names it. */
export function touched(t: Transcript, path: string): boolean {
  return readPaths(t).some((p) => p === path || p.endsWith(`/${path}`) || p.endsWith(`/${path}.diff`)) || grepResults(t).some((r) => r.includes(path));
}

const localisedTo = (f: GateOutput['findings'][number], path: string): boolean => (f.path === null ? f.text.includes(path) : f.path.includes(path));

/** Grades a trial whose gate gave a valid answer (one without is void as an error, never graded). */
export function grade(key: AnswerKey, shown: DiffShown, prompt: string, t: Transcript, answer: GateOutput): Graded {
  const inlined = new Set<string>(shown.inlined);
  const omitted = shown.notInlined;
  const covered = omitted.filter((p) => touched(t, p)).length;
  const coverage = { omitted: omitted.length, covered, share: omitted.length === 0 ? null : covered / omitted.length };
  const blockingFindings = answer.findings.filter((f) => f.severity === 'blocking');
  const flagged = answer.decision !== 'approve';
  if (key.plant === null) {
    return {
      verdict: flagged ? 'false-positive' : 'clean-pass', placement: null, placementMiss: false, looked: null, localised: false,
      blocking: blockingFindings.length, spurious: blockingFindings.length, coverage,
    };
  }
  const p = key.plant;
  const placement = inlined.has(p.path) ? 'inlined' : 'omitted';
  const looked = placement === 'inlined'
    || (p.deletion && prompt.includes(p.path))
    || readPaths(t).some((r) => r.endsWith(`/${p.path}`) || r.endsWith(`/${p.path}.diff`) || r === p.path)
    || grepResults(t).some((r) => r.includes(p.needle));
  const local = blockingFindings.filter((f) => localisedTo(f, p.path));
  const caught = flagged && local.length > 0;
  return {
    verdict: caught ? (looked ? 'caught' : 'lucky') : 'missed',
    placement, placementMiss: !placementHolds(p.intended, placement), looked, localised: local.length > 0,
    blocking: blockingFindings.length, spurious: blockingFindings.length - local.length, coverage,
  };
}

const placementHolds = (intended: Placement, actual: 'inlined' | 'omitted'): boolean => intended === 'any' || intended === actual;
