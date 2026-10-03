// Corpus amendments (M4a; plan "Corpus, pin and census" 8, A-M4-4, OR-L7): proposed changes to a corpus arc's corpus,
// recorded as `corpus-amendment` facts and dispositioned by the next arc's Phase 0 (read from this arc's verified ref,
// src/chain.ts `amendmentsOf`). Nothing in the arc edits the corpus. Three sources, each recorded once (the fold refuses a
// second amendment of one source, and `appendAmendment` finds the first):
//   - checkpoint{job, index}: the checkpoint's own `corpusAmendments`, in output order;
//   - issue{job, issue}: a captured issue's intake outcome `amendment` (src/holistic/intake.ts);
//   - divergence{D-n}: code derives one per `target-departed` and `interpretation` divergence: where the arc departed
//     from its target or read the vision where the corpus is silent, the corpus should say so.
// They are written after the decision that carries them (`bundle-decided` or `plan-applied`) by `settleDecided`
// (src/holistic/bundle.ts), keyed by source, so a crash between the decision and them is finished from the consumed output
// (CORPUS_AMENDMENT, crash label `amendment.after-decided`). Validation (`ruleReasons`): an amendment names only rules
// active in the pin in force, and an arc without a corpus proposes none.
import type { Fact } from '../core/events.ts';
import { crashPoint } from '../core/crash.ts';
import type { AmendmentId, JobId, RuleId } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { CorpusPin } from '../corpus/types.ts';
import type { CheckpointOutput } from '../prompts/schemas.ts';

/** A `corpus-amendment` fact before its id. */
export type AmendmentDraft = Omit<Extract<Fact, { kind: 'corpus-amendment' }>, 'kind' | 'id'>;

/** Records `draft` once per source: the amendment of its source when one exists, else a new `M-n`. */
export function appendAmendment(journal: Journal, draft: AmendmentDraft): AmendmentId {
  const key = canonicalJson(draft.source);
  const same = journal.view.holistic().amendments.find((a) => canonicalJson(a.source) === key);
  if (same !== undefined) return same.id;
  const id = journal.view.nextAmendmentId();
  journal.fact({ kind: 'corpus-amendment', id, ...draft });
  crashPoint('amendment.after-decided');
  return id;
}

/** The checkpoint's own proposals, `source: checkpoint{job, index}` (`job`: the checkpoint whose output it is). */
export function checkpointAmendments(job: JobId, output: CheckpointOutput): readonly AmendmentDraft[] {
  return output.corpusAmendments.map((a, index) => ({ source: { type: 'checkpoint', job, index }, rules: a.rules, proposal: a.proposal, why: a.why, evidence: [] }));
}

/** One amendment per `target-departed` and `interpretation` divergence `job` recorded (code-derived, `source: divergence`). */
export function divergenceAmendments(view: JournalView, job: JobId): readonly AmendmentDraft[] {
  return view.holistic().divergences.filter((d) => d.job === job && (d.type === 'target-departed' || d.type === 'interpretation')).map((d) => ({
    source: { type: 'divergence', divergence: d.id },
    rules: [],
    proposal: d.type === 'interpretation'
      ? `Say in the corpus how ${d.from} reads here: ${d.what}`
      : `Reconcile the corpus with the arc's departure from ${d.from}: ${d.what}`,
    why: `${d.id} (${d.type}, ${d.job}, cites ${d.cites.join(', ')})`,
    evidence: d.evidence,
  }));
}

/** Why `rules` may not be amended (`where` names the proposal): an arc without a corpus, or a rule not active in its pin. */
export function ruleReasons(pin: CorpusPin | null, rules: readonly RuleId[], where: string): readonly string[] {
  if (pin === null) return [`${where} proposes a corpus amendment in an arc without a corpus`];
  const active = new Set<string>(pin.rules.map((r) => r.id));
  return rules.flatMap((r) => (active.has(r) ? [] : [`${where} names ${r}, which is no active rule of the pin in force`]));
}

/** The output's own proposals' reasons (see `ruleReasons`). */
export function amendmentReasons(pin: CorpusPin | null, output: CheckpointOutput): readonly string[] {
  return output.corpusAmendments.flatMap((a, i) => ruleReasons(pin, a.rules, `corpus amendment ${i + 1}`));
}
