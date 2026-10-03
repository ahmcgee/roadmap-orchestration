// TEMPORARY SCAFFOLDING (SCHEMAS.md "Record evolution"): read-time defaults for records written by the previous
// release (1.0.0-dev.6, the only one adopted: OR-L4), so HEAD adopts an arc it started. Delete each default (and its
// BACKLOG entry) once no arc started on that release is in flight. Nothing here rewrites a file.
//
// Each defaulted kind warns once per process on stderr (the executor's stderr is the supervisor's
// `supervisor.<token>.err` in the host dir).
import type { ClassCatalogue } from '../routing/classes.ts';
import type { CensusEntry, ConfirmationRef, Obligations } from '../holistic/types.ts';

const warned = new Set<string>();

function warnDefaulted(kind: string, detail: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  process.stderr.write(`roadmap: upgrade default (${kind}): ${detail}\n`);
}

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.6 → M4a (1.0.0-dev.7). Byte-preserving (G14): the readers validate a record's canonical raw bytes with
// its new fields absent and return it as written; these helpers normalise it for the code that reads it, so a default
// never enters a hash, a chain or a comparison.
// Delete with the holistic `architecture-doc` variant once no dev.6 arc is in flight (BACKLOG "Scaffolding to delete").

/**
 * An obligations file's census (M4a): a dev.6 file (docRef obligations) has none, which reads as M3 semantics: the
 * census checks are vacuous for it. A corpus arc's file always carries one (the reader requires it beside rule anchors).
 */
export function censusOf(o: Obligations): readonly CensusEntry[] | null {
  if (o.census !== undefined) return o.census;
  warnDefaulted('obligations.census', 'an obligations file without a census (docRef obligations, a 1.0.0-dev.6 arc): census checks are vacuous');
  return null;
}

/**
 * Whether a vision's confirmation can be verified against the pinned corpus (OR-V+): the `corpus:` form can; the M3
 * form `vision.md#sha256:<hex>` an adopted dev.6 arc carries is not verified (R18), warned once.
 */
export function visionVerifiable(ref: ConfirmationRef): ref is Extract<ConfirmationRef, { form: 'corpus' }> {
  if (ref.form === 'corpus') return true;
  warnDefaulted('vision.confirmation', `the vision's confirmation ${ref.path}#sha256:… is the M3 form (a 1.0.0-dev.6 arc); it is not verified`);
  return false;
}

/**
 * A checkpoint answer's `corpusAmendments` and `issueIntake` (M4a): a recorded dev.6 answer (`upgrade.dev6-checkpoint-open`)
 * has neither, read as none. Step B1 makes both required of the model's schema.
 */
export function checkpointOutputM4Default(key: 'corpusAmendments' | 'issueIntake'): readonly never[] {
  warnDefaulted(`checkpoint.${key}`, `a checkpoint answer without ${key} (written before 1.0.0-dev.7); read as none`);
  return [];
}

/** A split child's `rule` (M4a): absent on a recorded dev.6 answer, whose children are docRef-anchored; read as null. */
export function splitChildRuleDefault(): null {
  warnDefaulted('checkpoint.splitChild.rule', 'a split child without rule (a checkpoint answer written before 1.0.0-dev.7); read as null');
  return null;
}

/**
 * The class catalogue 1.0.0-dev.6 bound (frontier Opus 5.5 `high`, summit Fable 5.1 `high`), kept only so `status`
 * can join a dev.6 meter row's recorded `routingRev` (K12, src/status.ts `dev6RevAlias`). OR-L3: nothing routes under
 * it; HEAD binds every revision through `CLASS_CATALOGUE` (src/routing/classes.ts). A dev.6 dispatch record needs no
 * decoder: its `implementerSeatRev` reads back through `seatTripleOf` (src/pipeline/dispatch.ts) like any other.
 */
export const DEV6_CLASS_CATALOGUE: ClassCatalogue = {
  default: {
    efficient: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
    frontier: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    summit: { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' },
  },
  'claude-only': {
    efficient: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    frontier: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    summit: { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' },
  },
};
