// The vision record's rules (OR-V, A14, H16; M3 step A1): the citation check every new bundle op, ruling and
// obligation passes, the vision edit rules the classifier applies, and the coverage report (`status.vision.coverage`,
// every lens and checkpoint prompt). Pure.
//
// - A new citation must name an active clause of the vision in force: an unknown or withdrawn clause is refused.
//   Existing citations of a clause withdrawn since stay, and are reported in `withdrawnCited`.
// - A vision edit (source `command` only, the classifier's check): every clause and question id stays (a withdrawn
//   clause and a closed question stay in the file), a withdrawn clause stays withdrawn with its kind and text and a
//   closed question stays closed as it was (ids are never reused), and a changed vision takes the next `rev`.
// - The plan's slice (`holistic.advances`), wherever plan and vision meet (startup, every classified revision): each
//   id an active clause of the vision, at least one a `world` clause.
// - Coverage runs both directions and is reported, never refused: advanced clauses no non-exempt obligation serves
//   (a gap), the horizon (active clauses the arc does not advance; expected), and non-exempt obligations serving no
//   active clause.
import { type NumberedId, type ObligationId, type Sha256Hex, type VisionClauseId, canonicalIds, compareIds } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import type { CorpusPin } from '../corpus/types.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { type Obligations, type Vision, type VisionCoverage, isExempt, parseConfirmationRef } from './types.ts';

/** Why citing `cites` is refused under `vision` (`what` names the citer in the reasons); empty when every clause is active. */
export function citeReasons(vision: Vision | null, cites: readonly VisionClauseId[], what: string): readonly string[] {
  return cites.flatMap((id) => {
    const clause = vision?.clauses.find((c) => c.id === id);
    if (clause === undefined) return [`${what} cites ${id}, which is not a clause of the vision in force`];
    return clause.state === 'withdrawn' ? [`${what} cites ${id}, which is withdrawn (a withdrawn clause may not be newly cited)`] : [];
  });
}

/** Why a vision edit from `prev` to `next` is refused; empty when it is allowed (or unchanged). */
export function visionEditReasons(prev: Vision | null, next: Vision): readonly string[] {
  if (prev === null) return next.rev === 1 ? [] : [`a new vision starts at rev 1, not ${next.rev}`];
  if (canonicalJson(prev) === canonicalJson(next)) return [];
  const out: string[] = [];
  if (next.rev !== prev.rev + 1) out.push(`a changed vision takes rev ${prev.rev + 1}, not ${next.rev}`);
  for (const was of prev.clauses) {
    const now = next.clauses.find((c) => c.id === was.id);
    if (now === undefined) out.push(`vision clause ${was.id} was removed (a clause stays in the file; withdraw it instead)`);
    else if (was.state === 'withdrawn' && (now.state !== 'withdrawn' || now.kind !== was.kind || now.text !== was.text)) {
      out.push(`vision clause ${was.id} is withdrawn and stays as it was (ids are never reused; add a new clause)`);
    }
  }
  for (const was of prev.questions) {
    const now = next.questions.find((q) => q.id === was.id);
    if (now === undefined) out.push(`vision question ${was.id} was removed (a question stays in the file; close it instead)`);
    else if (was.state === 'closed' && canonicalJson(now) !== canonicalJson(was)) {
      out.push(`vision question ${was.id} is closed and stays as it was (ids are never reused; add a new question)`);
    }
  }
  return out;
}

/** Why the plan's `holistic.advances` does not fit `vision`; empty when every id is an active clause and one is a world clause. */
export function advancesReasons(vision: Vision, advances: readonly VisionClauseId[]): readonly string[] {
  const out = advances.flatMap((id) => {
    const clause = vision.clauses.find((c) => c.id === id);
    if (clause === undefined) return [`holistic.advances names ${id}, which is not a clause of the vision`];
    return clause.state === 'withdrawn' ? [`holistic.advances names ${id}, which is withdrawn (the arc advances only active clauses)`] : [];
  });
  const world = vision.clauses.some((c) => c.kind === 'world' && c.state === 'active' && advances.includes(c.id));
  return world ? out : [...out, 'holistic.advances names no active world clause (the arc advances at least one)'];
}

/**
 * Vision coverage: the advanced active clauses no non-exempt obligation serves, the horizon (active clauses outside
 * `advances`), non-exempt obligations serving no active clause, and every withdrawn clause still cited, with its
 * citers (obligation, ruling and divergence ids) ascending.
 */
export function visionCoverage(
  vision: Vision, advances: readonly VisionClauseId[], obligations: Obligations | null,
  citers: readonly Readonly<{ id: NumberedId; cites: readonly VisionClauseId[] }>[],
): VisionCoverage {
  const active = new Set(vision.clauses.filter((c) => c.state === 'active').map((c) => c.id));
  const all = obligations?.obligations ?? [];
  const live = all.filter((o) => !isExempt(o));
  const served = new Set(live.flatMap((o) => o.serves));
  const withdrawnCited = vision.clauses.filter((c) => c.state === 'withdrawn').flatMap((c) => {
    const citedBy = [...all.map((o): Readonly<{ id: NumberedId; cites: readonly VisionClauseId[] }> => ({ id: o.id, cites: o.serves })), ...citers].filter((x) => x.cites.includes(c.id)).map((x) => x.id);
    return citedBy.length === 0 ? [] : [{ clause: c.id, citedBy: canonicalIds(citedBy) }];
  });
  return {
    unservedAdvanced: [...active].filter((c) => advances.includes(c) && !served.has(c)).sort(compareIds),
    horizon: [...active].filter((c) => !advances.includes(c)).sort(compareIds),
    obligationsServingNone: live.filter((o) => !o.serves.some((c) => active.has(c))).map((o): ObligationId => o.id).sort(compareIds),
    withdrawnCited: withdrawnCited.sort((a, b) => compareIds(a.clause, b.clause)),
  };
}

/**
 * Why a corpus arc's vision is not confirmed against its pin (OR-V+), or null when it is: no confirmation (`ref` null),
 * or a ref whose sha256 is not the pinned file's at its path (`actual` null: the pin holds no such file; the M3 form
 * `<file>#sha256:<hex>` names no corpus file). A malformed ref is a SchemaError (the caller's `plan-invalid`).
 */
export function visionUnconfirmed(vision: Vision, pin: CorpusPin): Extract<StartupRejection, { kind: 'vision-unconfirmed' }> | null {
  if (vision.confirmation === null) return { kind: 'vision-unconfirmed', ref: null, expected: null, actual: null };
  const ref = parseConfirmationRef(vision.confirmation.ref);
  const actual: Sha256Hex | null = ref.form === 'corpus' ? pin.files.find((f) => f.path === ref.path)?.sha256 ?? null : null;
  return actual === ref.sha256 ? null : { kind: 'vision-unconfirmed', ref: vision.confirmation.ref, expected: ref.sha256, actual };
}

/**
 * The active world clauses whose census rules are not all held on the baseline (R15): a clause some non-exempt `future`
 * obligation serves (not yet held), or that no non-exempt obligation serves at all (nothing shows it held). Ascending.
 * What the root agent may pick the next slice from; none justifiable is the vision-silent stop.
 */
export function sliceCandidates(vision: Vision, obligations: Obligations | null): readonly VisionClauseId[] {
  const live = (obligations?.obligations ?? []).filter((o) => !isExempt(o));
  return vision.clauses.filter((c) => c.kind === 'world' && c.state === 'active').map((c) => c.id).filter((id) => {
    const serving = live.filter((o) => o.serves.includes(id));
    return serving.length === 0 || serving.some((o) => o.activation === 'future');
  }).sort(compareIds);
}
