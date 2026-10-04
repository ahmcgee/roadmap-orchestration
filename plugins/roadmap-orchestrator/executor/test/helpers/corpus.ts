// A corpus builder for tests (M4a step 0b): markdown docs with `rules` blocks, a vision doc without one, and the guide
// (`.roadmap/corpus.md`) whose one fenced `json roadmap-corpus` block names them. It builds FILES (a FileSet for
// makeRepo / commit acts) and the rules it wrote; it never derives the pin (A1's `roadmap corpus pin` does), so a test
// compares the pin against `expected`, not against the builder's own idea of one.
import { CORPUS_GUIDE_FENCE, CORPUS_GUIDE_SCHEMA, RULES_FENCE, type CorpusSource } from '../../src/corpus/types.ts';
import type { FileSet } from './repo.ts';

export type CorpusRule = Readonly<{ n: number; text: string }>;
/** A heading with prose and, optionally, a `rules` block under it. */
export type CorpusSection = Readonly<{ heading: string; prose?: string; rules?: readonly CorpusRule[] }>;
export type CorpusDoc = Readonly<{ path: string; title: string; sections: readonly CorpusSection[] }>;

export type CorpusSpec = Readonly<{
  /** Where the corpus lives under its source's root (same-repo: under the product repo); default `docs/corpus`. */
  root?: string;
  docs: readonly CorpusDoc[];
  /** The vision document under root: prose only; a rules block in it is refused by the pin, so the builder takes none. */
  vision?: Readonly<{ path: string; text: string }>;
  /** Guide `include` patterns, relative to root; default `**\/*.md`. */
  include?: readonly string[];
  /** Default same-repo at `root`. */
  source?: CorpusSource;
  /** Extra prose the guide opens with (access, standards). */
  guideProse?: string;
}>;

/** A rule as the builder wrote it: where a test finds it in the pin. */
export type ExpectedRule = Readonly<{ id: string; text: string; file: string; section: string }>;

export type BuiltCorpus = Readonly<{
  /** Product-repo paths to contents: the corpus files for a same-repo source, plus `.roadmap/corpus.md`. */
  files: FileSet;
  /** The corpus files alone, by path under root (what an other-repo or checkout source repo holds). */
  corpusFiles: FileSet;
  /** The guide's path in the product repo and its text. */
  guidePath: string;
  guide: string;
  /** Every rule written, ascending by number, with its file (under root) and section. */
  expected: readonly ExpectedRule[];
}>;

export const DEFAULT_CORPUS_ROOT = 'docs/corpus';

const docText = (doc: CorpusDoc): string => {
  const parts = [`# ${doc.title}`, ''];
  for (const s of doc.sections) {
    parts.push(`## ${s.heading}`, '');
    if (s.prose !== undefined) parts.push(s.prose, '');
    if (s.rules !== undefined) parts.push(`\`\`\`${RULES_FENCE}`, ...s.rules.map((r) => `T-${r.n}: ${r.text}`), '```', '');
  }
  return parts.join('\n');
};

export function buildCorpus(spec: CorpusSpec): BuiltCorpus {
  const root = spec.root ?? DEFAULT_CORPUS_ROOT;
  const corpusFiles: Record<string, string> = {};
  const expected: ExpectedRule[] = [];
  for (const doc of spec.docs) {
    corpusFiles[doc.path] = docText(doc);
    for (const s of doc.sections) for (const r of s.rules ?? []) expected.push({ id: `T-${r.n}`, text: r.text, file: doc.path, section: s.heading });
  }
  if (spec.vision !== undefined) corpusFiles[spec.vision.path] = spec.vision.text;
  expected.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  const block = {
    schema: CORPUS_GUIDE_SCHEMA,
    source: spec.source ?? { kind: 'same-repo', root },
    include: spec.include ?? ['**/*.md'],
    vision: spec.vision?.path ?? spec.docs[0]?.path ?? 'vision.md',
  };
  const guide = [
    '# Corpus guide',
    '',
    spec.guideProse ?? 'The corpus is the target state: claims live in `rules` blocks, prose is rationale.',
    '',
    `\`\`\`${CORPUS_GUIDE_FENCE}`,
    JSON.stringify(block, null, 2),
    '```',
    '',
  ].join('\n');
  const guidePath = '.roadmap/corpus.md';
  const files: Record<string, string> = { [guidePath]: guide };
  if (block.source.kind === 'same-repo') for (const [p, t] of Object.entries(corpusFiles)) files[`${root}/${p}`] = t;
  return { files, corpusFiles, guidePath, guide, expected };
}

/** The sample corpus's two docs: rules T-1..T-3 in `0010_Overview.md` and `0020_Berths.md`. */
export const SAMPLE_DOCS: readonly CorpusDoc[] = [
  { path: '0010_Overview.md', title: 'Overview', sections: [{ heading: 'Scope', prose: 'What the harbour system does.', rules: [{ n: 1, text: 'A berth is never double-booked.' }] }] },
  {
    path: '0020_Berths.md',
    title: 'Berths',
    sections: [
      { heading: 'Booking', rules: [{ n: 2, text: 'A booking names one berth and one tide window.' }, { n: 3, text: 'A cancelled booking frees its berth at once.' }] },
      { heading: 'Rationale', prose: 'Why bookings are strict.' },
    ],
  },
];

/** A small two-doc corpus with a vision doc: `SAMPLE_DOCS` (rules T-1..T-3) and `0005_Vision.md`. */
export function sampleCorpus(overrides: Partial<CorpusSpec> = {}): BuiltCorpus {
  return buildCorpus({
    docs: SAMPLE_DOCS,
    vision: { path: '0005_Vision.md', text: '# Vision\n\nA calm harbour where every vessel has a berth.\n' },
    ...overrides,
  });
}
