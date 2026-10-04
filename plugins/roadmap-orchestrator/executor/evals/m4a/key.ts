// The answer key (answer-key.json) and its postconditions (plan "Planted defects", H19, K21), checked directly against
// the arcs' kept pins, censuses and Phase-0 records, never by file name. Vocabulary:
//   rule               exactly one active pin rule matches `match` and contains none of `exclude` (`census`: its census
//                      state, and for `obligation` the named obligation's activation). With `any: true` at least one
//                      rule matches instead (for a defect that does not own deduplication; D1 does): at least one
//                      matching rule has the census state, and every matching rule with that state has the activation
//   no-rule            no active pin rule matches `match`
//   absent             no pinned file's normalised text contains the planted span (sha256 and length of its
//                      normalised text: every window of that length is hashed)
//   spans-at-most      at most `max` of the planted spans remain in the pinned files
//   divergence         a `corpusDivergences` entry cites the clause and its rules include the rule matching `rule`
//   question           a Phase-0 question bears the rule matching `bears` (in that arc's pin) in state `state`
//   question-answered  the question of arc `askedIn` bearing `bears` is answered, by the same id, in this arc's record
//   curation           a `curation` entry of one of `tiers` names `file` (curation paths are repo-relative, the key's are
//                      corpus-root-relative: both are resolved against the pin's source root before comparing)
// A match is a list of fragment groups over the rule's normalised, lower-cased text: each group matches when the text
// contains any of its alternatives; the rule matches when every group does. A rule may satisfy the positive matchers
// (`rule`) of at most one defect per arc: a rule matching two defects' fails both.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeText } from '../../src/corpus/rules.ts';
import type { CorpusPin } from '../../src/corpus/types.ts';
import type { Obligations } from '../../src/holistic/types.ts';
import type { Phase0Record } from '../../src/phase0/types.ts';
import { ANSWER_KEY } from './transcript.ts';

export type Match = readonly (readonly string[])[];
export type Span = Readonly<{ file: string; sha256: string; length: number }>;
export type ArcNo = 1 | 2;

export type Postcondition =
  | Readonly<{ type: 'rule'; arc: ArcNo; match: Match; exclude?: readonly string[]; any?: true; census?: Readonly<{ state: 'obligation' | 'out-of-slice' | 'untestable' | 'prod-only'; activation?: 'future' | 'must-hold' }> }>
  | Readonly<{ type: 'no-rule'; arc: ArcNo; match: Match }>
  | Readonly<{ type: 'absent'; arc: ArcNo; span: Span }>
  | Readonly<{ type: 'spans-at-most'; arc: ArcNo; max: number; spans: readonly Span[] }>
  | Readonly<{ type: 'divergence'; arc: ArcNo; cites: string; rule: Match }>
  | Readonly<{ type: 'question'; arc: ArcNo; bears: Match; state: 'open' | 'answered' }>
  | Readonly<{ type: 'question-answered'; arc: ArcNo; askedIn: ArcNo; bears: Match }>
  | Readonly<{ type: 'curation'; arc: ArcNo; tiers: readonly string[]; file: string }>;

export type Defect = Readonly<{ id: string; what: string; postconditions: readonly Postcondition[] }>;
export type AnswerKey = Readonly<{ defects: readonly Defect[] }>;

export const readKey = (): AnswerKey => JSON.parse(readFileSync(ANSWER_KEY, 'utf8')) as AnswerKey;

/** An arc as the postconditions read it: its kept pin, the pinned files' text, its obligations (with census) and record. */
export type ArcView = Readonly<{ pin: CorpusPin; files: ReadonlyMap<string, string>; obligations: Obligations; phase0: Phase0Record }>;

const lower = (text: string): string => normalizeText(text).toLowerCase();
export const matches = (m: Match, text: string): boolean => m.every((group) => group.some((alt) => lower(text).includes(alt.toLowerCase())));

/** Whether the normalised text of any pinned file holds the span (every window of its length hashed). */
export function spanPresent(view: ArcView, span: Span): boolean {
  for (const text of view.files.values()) {
    const n = normalizeText(text);
    for (let i = 0; i + span.length <= n.length; i++) {
      if (createHash('sha256').update(n.slice(i, i + span.length)).digest('hex') === span.sha256) return true;
    }
  }
  return false;
}

/** The active rules matching `m` and containing none of `exclude`. */
const rulesMatching = (view: ArcView, m: Match, exclude: readonly string[] = []) =>
  view.pin.rules.filter((r) => matches(m, r.text) && !exclude.some((x) => lower(r.text).includes(x.toLowerCase())));

type Verdict = Readonly<{ pass: boolean; detail: string }>;

function one(view: ArcView, m: Match, exclude: readonly string[] = []): Readonly<{ id: string } | { problem: string }> {
  const hits = rulesMatching(view, m, exclude);
  return hits.length === 1 ? { id: hits[0]!.id } : { problem: `${hits.length} rules match ${JSON.stringify(m)}${hits.length === 0 ? '' : ` (${hits.map((r) => r.id).join(', ')})`}` };
}

function evaluate(p: Postcondition, arcs: Readonly<Record<ArcNo, ArcView>>): Verdict {
  const view = arcs[p.arc];
  switch (p.type) {
    case 'rule': {
      const censusOf = (id: string): Verdict => {
        const c = p.census!;
        const entry = view.obligations.census?.find((e) => e.rule === id);
        if (entry === undefined) return { pass: false, detail: `${id} has no census entry` };
        if (entry.state.type !== c.state) return { pass: false, detail: `${id}'s census state is ${entry.state.type}, not ${c.state}` };
        if (c.activation === undefined) return { pass: true, detail: `${id} ${entry.state.type}` };
        const named = entry.state.type === 'obligation' ? entry.state.id : null;
        const o = view.obligations.obligations.find((x) => x.id === named);
        if (o === undefined) return { pass: false, detail: `${id}'s census names ${named}, which the obligations lack` };
        return { pass: o.activation === c.activation, detail: `${id} → ${o.id} ${o.activation}` };
      };
      if (p.any === true) {
        const hits = rulesMatching(view, p.match, p.exclude);
        if (hits.length === 0) return { pass: false, detail: `no rule matches ${JSON.stringify(p.match)}` };
        if (p.census === undefined) return { pass: true, detail: hits.map((r) => r.id).join(', ') };
        const verdicts = hits.map((r) => ({ id: r.id as string, v: censusOf(r.id), has: view.obligations.census?.find((e) => e.rule === r.id)?.state.type === p.census!.state }));
        const holders = verdicts.filter((x) => x.has);
        if (holders.length === 0) return { pass: false, detail: `none of ${hits.map((r) => r.id).join(', ')} has census state ${p.census.state}` };
        const bad = holders.filter((x) => !x.v.pass);
        return { pass: bad.length === 0, detail: holders.map((x) => x.v.detail).join('; ') };
      }
      const r = one(view, p.match, p.exclude);
      if ('problem' in r) return { pass: false, detail: r.problem };
      return p.census === undefined ? { pass: true, detail: `${r.id}` } : censusOf(r.id);
    }
    case 'no-rule': {
      const hits = rulesMatching(view, p.match);
      return { pass: hits.length === 0, detail: hits.length === 0 ? 'none' : `matched by ${hits.map((r) => r.id).join(', ')}` };
    }
    case 'absent':
      return spanPresent(view, p.span) ? { pass: false, detail: `the planted span of ${p.span.file} remains` } : { pass: true, detail: 'gone' };
    case 'spans-at-most': {
      const left = p.spans.filter((s) => spanPresent(view, s)).map((s) => s.file);
      return { pass: left.length <= p.max, detail: `${left.length} remain${left.length === 0 ? '' : ` (${left.join(', ')})`}` };
    }
    case 'divergence': {
      const r = one(view, p.rule);
      if ('problem' in r) return { pass: false, detail: r.problem };
      const hit = view.phase0.corpusDivergences.find((d) => d.cites.includes(p.cites as never) && d.rules.includes(r.id as never));
      return { pass: hit !== undefined, detail: hit === undefined ? `no corpus divergence cites ${p.cites} with ${r.id}` : hit.what };
    }
    case 'question': {
      const r = one(view, p.bears);
      if ('problem' in r) return { pass: false, detail: r.problem };
      const q = view.phase0.questions.find((x) => x.bears.includes(r.id as never));
      if (q === undefined) return { pass: false, detail: `no question bears ${r.id}` };
      return { pass: q.state.type === p.state, detail: `${q.id} ${q.state.type}` };
    }
    case 'question-answered': {
      const asked = arcs[p.askedIn];
      const r = one(asked, p.bears);
      if ('problem' in r) return { pass: false, detail: `arc ${p.askedIn}: ${r.problem}` };
      const q = asked.phase0.questions.find((x) => x.bears.includes(r.id as never));
      if (q === undefined) return { pass: false, detail: `arc ${p.askedIn} has no question bearing ${r.id}` };
      const now = view.phase0.questions.find((x) => x.id === q.id);
      if (now === undefined) return { pass: false, detail: `${q.id} is not carried into arc ${p.arc}` };
      return { pass: now.state.type === 'answered', detail: `${q.id} ${now.state.type}` };
    }
    case 'curation': {
      const root = view.pin.source.root as string;
      const rel = (f: string): string => (f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f);
      const hit = view.phase0.curation.find((c) => p.tiers.includes(c.tier) && c.files.some((f) => rel(f) === rel(p.file)));
      return { pass: hit !== undefined, detail: hit === undefined ? `no ${p.tiers.join('/')} curation names ${p.file}` : hit.what };
    }
  }
}

export type DefectVerdict = Readonly<{ id: string; pass: boolean; details: readonly string[] }>;

/** Every defect's verdict over the two arcs. */
export function defectVerdicts(key: AnswerKey, arcs: Readonly<Record<ArcNo, ArcView>>): readonly DefectVerdict[] {
  // A rule satisfying two defects' positive matchers fails both.
  const claims = new Map<string, Set<string>>();
  for (const d of key.defects) {
    for (const p of d.postconditions) {
      if (p.type !== 'rule') continue;
      for (const r of rulesMatching(arcs[p.arc], p.match, p.exclude)) {
        const k = `${p.arc}:${r.id}`;
        claims.set(k, (claims.get(k) ?? new Set()).add(d.id));
      }
    }
  }
  return key.defects.map((d) => {
    const details = d.postconditions.map((p, i) => {
      const v = evaluate(p, arcs);
      return { pass: v.pass, text: `${d.id}.${i + 1} ${p.type}(arc ${p.arc}): ${v.pass ? 'ok' : 'FAIL'} ${v.detail}` };
    });
    const shared = [...claims.entries()].filter(([, ds]) => ds.has(d.id) && ds.size > 1).map(([k, ds]) => `rule ${k} also matches ${[...ds].filter((x) => x !== d.id).join(', ')}`);
    return { id: d.id, pass: details.every((x) => x.pass) && shared.length === 0, details: [...details.map((x) => x.text), ...shared] };
  });
}
