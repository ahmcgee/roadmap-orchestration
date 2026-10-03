// The corpus pin (`roadmap/corpus-pin-m4`; M4a "Corpus, pin and census" 2–3): derived from the guide, the source at a
// commit and the baseline rules registry, and re-derived from the same inputs at every start and apply, where it must
// equal the recorded pin canonically (`pin-drift`; a guide hashing other than `guideSha256` is drift too).
//
// Derivation: every included file (paths under root, ascending); the vision document must be one of them and may hold
// no rules block (`rules-in-vision`); the rules of every other included `.md` file, ascending by number (src/corpus/
// rules.ts); `retired` and `highWater` from the registry diff (src/corpus/registry.ts).
import { type Sha256Hex, sha256 } from '../core/ids.ts';
import { atomicJson, canonicalJson } from '../core/fsx.ts';
import { sha256Hex } from '../core/json.ts';
import type { AbsPath } from '../core/values.ts';
import type { CorpusProblem } from '../phase0/types.ts';
import type { ReadGuide } from './guide.ts';
import { diffRegistry } from './registry.ts';
import { CorpusFormatError, collectRules, hasRulesBlock, parseRules } from './rules.ts';
import { type OpenedSource, openSource } from './source.ts';
import { CORPUS_PIN_SCHEMA, type CorpusPin, type RulesRegistry, parseCorpusPin } from './types.ts';

export type PinOutcome = Readonly<{ kind: 'pinned'; pin: CorpusPin }> | Readonly<{ kind: 'refused'; problems: readonly CorpusProblem[] }>;

/** The pin of `opened` under `guide`, diffed against `registry`. */
export function derivePin(guide: ReadGuide, opened: OpenedSource, registry: RulesRegistry): PinOutcome {
  const visionPath = guide.guide.vision;
  const vision = opened.files.find((f) => f.path === visionPath);
  if (vision === undefined) throw new CorpusFormatError('.roadmap/corpus.md', `the vision document ${visionPath} is not an included file at ${opened.source.commit}`);
  const problems: CorpusProblem[] = [];
  if (hasRulesBlock(vision.text, vision.path)) problems.push({ type: 'rules-in-vision' });
  const rules = collectRules(opened.files.filter((f) => f !== vision && f.path.endsWith('.md')).map((f) => parseRules(f.text, f.path)));
  const diff = diffRegistry(rules, registry);
  problems.push(...diff.problems);
  if (problems.length > 0) return { kind: 'refused', problems };
  const pin: CorpusPin = {
    schema: CORPUS_PIN_SCHEMA,
    guideSha256: guide.sha256,
    source: opened.source,
    files: opened.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    rules,
    retired: diff.retired,
    highWater: diff.highWater,
    vision: { path: vision.path, sha256: vision.sha256 },
  };
  return { kind: 'pinned', pin: parseCorpusPin(JSON.parse(pinBytes(pin))) };
}

/** The pin file's bytes (canonical JSON); its sha256 is what `plan-applied`, manifests and fingerprints name. */
export const pinBytes = (pin: CorpusPin): string => canonicalJson(pin);
export const pinSha256 = (pin: CorpusPin): Sha256Hex => sha256(sha256Hex(pinBytes(pin)));

/** Writes the pin by atomic rename. */
export function writePin(path: AbsPath, pin: CorpusPin): Sha256Hex {
  atomicJson(path, pin);
  return pinSha256(pin);
}

export type RederiveOutcome = Readonly<{ kind: 'equal'; opened: OpenedSource }> | Readonly<{ kind: 'refused'; problems: readonly CorpusProblem[] }>;

/**
 * Re-derives `pin` from `guide` (null: `guide-missing`) and its source at the pinned commit against `registry`, and
 * requires canonical equality. `equal` carries the source's files for the caller to keep.
 */
export function rederivePin(repo: AbsPath, pin: CorpusPin, guide: ReadGuide | null, registry: RulesRegistry): RederiveOutcome {
  if (guide === null) return { kind: 'refused', problems: [{ type: 'guide-missing' }] };
  if (guide.sha256 !== pin.guideSha256) return { kind: 'refused', problems: [{ type: 'pin-drift' }] };
  const source = openSource(repo, guide.guide, { rev: pin.source.commit, fetch: false });
  if (source.kind === 'refused') return { kind: 'refused', problems: [source.problem] };
  const derived = derivePin(guide, source.opened, registry);
  if (derived.kind === 'refused') return derived;
  return pinBytes(derived.pin) === pinBytes(pin) ? { kind: 'equal', opened: source.opened } : { kind: 'refused', problems: [{ type: 'pin-drift' }] };
}
