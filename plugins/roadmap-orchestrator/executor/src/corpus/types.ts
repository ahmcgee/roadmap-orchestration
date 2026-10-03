// The corpus records (M4a, frozen in step 0a; SCHEMAS.md "M4a"): the corpus guide's block, the corpus pin and the
// published rules registry. Types, readers and pure helpers only; A1 owns the behaviour (src/corpus/{rules,guide,
// source,pin,materialise,registry}.ts): parsing rules blocks, resolving the source, deriving and re-deriving the pin.
//
// Paths in a guide and a pin are relative to the source's `root` (a path "under root"), never to the product repo,
// so one shape serves every source kind. For a same-repo source the product path of a corpus file is `root/path`.
import { type RuleId, type Sha, type Sha256Hex, ruleId, ruleSeq, sha, sha256 } from '../core/ids.ts';
import { type Read, SchemaError, arrayOf, assertUnique, literal, nat, nullable, object, sortedBy, str, tagged } from '../core/validate.ts';
import { type AbsPath, type RepoPath, type RepoPattern, absPath, repoPath, repoPattern } from '../core/values.ts';

const pathR: Read<RepoPath> = (v, p) => repoPath(v, p);
const sha256R: Read<Sha256Hex> = (v, p) => sha256(v, p);
const ruleR: Read<RuleId> = (v, p) => ruleId(v, p);

/** Rule ids strictly ascending by number (`T-2` before `T-10`), so equal sets serialise equally. */
export function rulesAscending<T>(item: Read<T>, id: (t: T) => RuleId): Read<readonly T[]> {
  const read = arrayOf(item);
  return (value, path) => {
    const out = read(value, path);
    for (let i = 1; i < out.length; i++) {
      if (!(ruleSeq(id(out[i - 1] as T)) < ruleSeq(id(out[i] as T)))) throw new SchemaError(`${path}[${i}]`, 'rule ids strictly ascending by number', value);
    }
    return out;
  };
}

// ---------------------------------------------------------------------------------------------------
// The corpus guide (`.roadmap/corpus.md`, R2): agent-facing prose plus exactly one fenced `json roadmap-corpus` block.

export const CORPUS_GUIDE_SCHEMA = 'roadmap/corpus-guide-m4';
export const CORPUS_GUIDE_FENCE = 'json roadmap-corpus';
export const CORPUS_GUIDE_FILE = 'corpus.md';

/**
 * Where the corpus lives. `same-repo`: under `root` of the product repo; `other-repo`: under `root` of the git repo at
 * `path`; `checkout`: under `root` of a clone the CLI owns at `$(git-common-dir)/roadmap/corpus/<sha256 of the
 * canonical remote>/` (H22: its write-once `remote.json` must equal `remote` before every fetch).
 */
export type CorpusSource =
  | Readonly<{ kind: 'same-repo'; root: RepoPath }>
  | Readonly<{ kind: 'other-repo'; path: AbsPath; root: RepoPath }>
  | Readonly<{ kind: 'checkout'; remote: string; root: RepoPath }>;
export type CorpusSourceKind = CorpusSource['kind'];

export type CorpusGuide = Readonly<{
  schema: typeof CORPUS_GUIDE_SCHEMA;
  source: CorpusSource;
  /** The corpus files, relative to `root`, non-empty. */
  include: readonly RepoPattern[];
  /** The vision document, a path under `root`; it may hold no rules block (`rules-in-vision`). */
  vision: RepoPath;
}>;

const corpusSource: Read<CorpusSource> = tagged('kind', {
  'same-repo': object((f): CorpusSource => ({ kind: f.get('kind', literal('same-repo')), root: f.get('root', pathR) })),
  'other-repo': object((f): CorpusSource => ({ kind: f.get('kind', literal('other-repo')), path: f.get('path', (v, p) => absPath(v, p)), root: f.get('root', pathR) })),
  checkout: object((f): CorpusSource => ({ kind: f.get('kind', literal('checkout')), remote: f.get('remote', str), root: f.get('root', pathR) })),
});

export const corpusGuide: Read<CorpusGuide> = object((f) => {
  const out: CorpusGuide = {
    schema: f.get('schema', literal(CORPUS_GUIDE_SCHEMA)),
    source: f.get('source', corpusSource),
    include: f.get('include', arrayOf((v, p) => repoPattern(v, p), { nonEmpty: true })),
    vision: f.get('vision', pathR),
  };
  assertUnique(out.include, (p) => p, `${f.path}.include`);
  return out;
});

/** Reads the guide block's parsed JSON (A1's guide.ts finds the one fenced block). */
export function parseCorpusGuide(value: unknown): CorpusGuide {
  return corpusGuide(value, 'corpusGuide');
}

// ---------------------------------------------------------------------------------------------------
// Rules (`src/corpus/rules.ts`, A1): a fenced `rules` block holds one `T-<n>: <claim>` per line.

export const RULES_FENCE = 'rules';

/**
 * One active rule as pinned. `textSha256`: sha256 of the text trimmed with whitespace collapsed (`normalizeText`,
 * shared with `debtKey`); `file`: its file under root; `section`: the nearest preceding heading's text, null when no
 * heading precedes the block.
 */
export type PinnedRule = Readonly<{ id: RuleId; textSha256: Sha256Hex; text: string; file: RepoPath; section: string | null }>;
/** A rule by identity only: what obligations, the registry and retired lists bind. */
export type RuleRef = Readonly<{ id: RuleId; textSha256: Sha256Hex }>;

export const ruleRef: Read<RuleRef> = object((f) => ({ id: f.get('id', ruleR), textSha256: f.get('textSha256', sha256R) }));
const pinnedRule: Read<PinnedRule> = object((f) => ({
  id: f.get('id', ruleR), textSha256: f.get('textSha256', sha256R), text: f.get('text', str), file: f.get('file', pathR), section: f.get('section', nullable(str)),
}));

// ---------------------------------------------------------------------------------------------------
// The corpus pin (`roadmap corpus pin`; `plan.corpus` names it). Re-derived at every start and apply and required to
// equal its canonical form (`corpus-invalid{pin-drift}`).

export const CORPUS_PIN_SCHEMA = 'roadmap/corpus-pin-m4';

/** The source at the pinned commit: the guide's source with the commit it was read at. */
export type PinSource =
  | Readonly<{ kind: 'same-repo'; commit: Sha; root: RepoPath }>
  | Readonly<{ kind: 'other-repo'; commit: Sha; path: AbsPath; root: RepoPath }>
  | Readonly<{ kind: 'checkout'; commit: Sha; remote: string; root: RepoPath }>;

export type CorpusFile = Readonly<{ path: RepoPath; sha256: Sha256Hex }>;

export type CorpusPin = Readonly<{
  schema: typeof CORPUS_PIN_SCHEMA;
  /** The guide's bytes the pin was derived from: a guide hashing otherwise is drift too. */
  guideSha256: Sha256Hex;
  source: PinSource;
  /** Every included file (the vision document among them), ascending by path. */
  files: readonly CorpusFile[];
  /** The active rules, ascending by number. */
  rules: readonly PinnedRule[];
  /** Rules the registry held that the corpus no longer does, ascending by number; never active again. */
  retired: readonly RuleRef[];
  /** The highest rule number ever allocated (active, retired or the baseline registry's). */
  highWater: number;
  vision: CorpusFile;
}>;

const shaR: Read<Sha> = (v, p) => sha(v, p);
const pinSource: Read<PinSource> = tagged('kind', {
  'same-repo': object((f): PinSource => ({ kind: f.get('kind', literal('same-repo')), commit: f.get('commit', shaR), root: f.get('root', pathR) })),
  'other-repo': object((f): PinSource => ({
    kind: f.get('kind', literal('other-repo')), commit: f.get('commit', shaR), path: f.get('path', (v, p) => absPath(v, p)), root: f.get('root', pathR),
  })),
  checkout: object((f): PinSource => ({ kind: f.get('kind', literal('checkout')), commit: f.get('commit', shaR), remote: f.get('remote', str), root: f.get('root', pathR) })),
});
const corpusFile: Read<CorpusFile> = object((f) => ({ path: f.get('path', pathR), sha256: f.get('sha256', sha256R) }));

export const corpusPin: Read<CorpusPin> = object((f) => {
  const out: CorpusPin = {
    schema: f.get('schema', literal(CORPUS_PIN_SCHEMA)),
    guideSha256: f.get('guideSha256', sha256R),
    source: f.get('source', pinSource),
    files: f.get('files', sortedBy(corpusFile, (c) => c.path, { nonEmpty: true })),
    rules: f.get('rules', rulesAscending(pinnedRule, (r) => r.id)),
    retired: f.get('retired', rulesAscending(ruleRef, (r) => r.id)),
    highWater: f.get('highWater', nat),
    vision: f.get('vision', corpusFile),
  };
  const files = new Map(out.files.map((c) => [c.path, c.sha256]));
  if (files.get(out.vision.path) !== out.vision.sha256) throw new SchemaError(`${f.path}.vision`, 'one of the pinned files, with its hash', out.vision);
  out.rules.forEach((r, i) => {
    if (!files.has(r.file)) throw new SchemaError(`${f.path}.rules[${i}].file`, 'a pinned file', r.file);
    if (r.file === out.vision.path) throw new SchemaError(`${f.path}.rules[${i}].file`, 'a file other than the vision document (rules-in-vision)', r.file);
  });
  const active = new Set(out.rules.map((r) => r.id));
  out.retired.forEach((r, i) => {
    if (active.has(r.id)) throw new SchemaError(`${f.path}.retired[${i}]`, 'a rule not active in this pin', r.id);
  });
  const max = Math.max(0, ...out.rules.map((r) => ruleSeq(r.id)), ...out.retired.map((r) => ruleSeq(r.id)));
  if (out.highWater < max) throw new SchemaError(`${f.path}.highWater`, `at least ${max} (the highest rule number pinned)`, out.highWater);
  return out;
});

export function parseCorpusPin(value: unknown): CorpusPin {
  return corpusPin(value, 'corpusPin');
}

/** The rule identities a pin holds active, keyed by id. */
export const activeRules = (pin: CorpusPin): ReadonlyMap<RuleId, PinnedRule> => new Map(pin.rules.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------------------------------
// The rules registry (R3): a second fenced block in the published `invariants.md`, info string `json roadmap-rules`.
// What the next arc's pin and `phase0 check` diff against.

export const RULES_REGISTRY_FENCE = 'json roadmap-rules';

export type RulesRegistry = Readonly<{ highWater: number; active: readonly RuleRef[]; retired: readonly RuleRef[] }>;

export const rulesRegistry: Read<RulesRegistry> = object((f) => {
  const out: RulesRegistry = {
    highWater: f.get('highWater', nat),
    active: f.get('active', rulesAscending(ruleRef, (r) => r.id)),
    retired: f.get('retired', rulesAscending(ruleRef, (r) => r.id)),
  };
  const active = new Set(out.active.map((r) => r.id));
  out.retired.forEach((r, i) => {
    if (active.has(r.id)) throw new SchemaError(`${f.path}.retired[${i}]`, 'a rule not also active', r.id);
  });
  const max = Math.max(0, ...out.active.map((r) => ruleSeq(r.id)), ...out.retired.map((r) => ruleSeq(r.id)));
  if (out.highWater < max) throw new SchemaError(`${f.path}.highWater`, `at least ${max}`, out.highWater);
  return out;
});

export function parseRulesRegistry(value: unknown): RulesRegistry {
  return rulesRegistry(value, 'rulesRegistry');
}
