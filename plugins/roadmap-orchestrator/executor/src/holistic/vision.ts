// The vision record's rules (OR-V, A14, H16; M3 step A1): the citation check every new bundle op, ruling and
// obligation passes, the vision edit rules the classifier applies, and the coverage report (`status.vision.coverage`,
// every lens and checkpoint prompt). Pure.
//
// - A new citation must name an active clause of the vision in force: an unknown or withdrawn clause is refused.
//   Existing citations of a clause withdrawn since stay, and are reported in `withdrawnCited`.
// - A vision edit (source `command` only, the classifier's check): every clause id stays (a withdrawn clause stays in
//   the file), a withdrawn clause stays withdrawn with its kind and text (ids are never reused), and a changed vision
//   takes the next `rev`.
// - Coverage runs both directions and is reported, never refused: active clauses no non-exempt obligation serves,
//   and non-exempt obligations serving no active clause.
import type { ObligationId, VisionClauseId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type Obligations, type Vision, type VisionCoverage, isExempt } from './types.ts';

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
  return out;
}

/**
 * Vision coverage: unserved active clauses, non-exempt obligations serving no active clause, and every withdrawn
 * clause still cited, with its citers (obligation, ruling and divergence ids) ascending.
 */
export function visionCoverage(
  vision: Vision, obligations: Obligations | null, citers: readonly Readonly<{ id: string; cites: readonly VisionClauseId[] }>[],
): VisionCoverage {
  const active = new Set(vision.clauses.filter((c) => c.state === 'active').map((c) => c.id));
  const all = obligations?.obligations ?? [];
  const live = all.filter((o) => !isExempt(o));
  const served = new Set(live.flatMap((o) => o.serves));
  const withdrawnCited = vision.clauses.filter((c) => c.state === 'withdrawn').flatMap((c) => {
    const citedBy = [...all.map((o) => ({ id: o.id as string, cites: o.serves })), ...citers].filter((x) => x.cites.includes(c.id)).map((x) => x.id);
    return citedBy.length === 0 ? [] : [{ clause: c.id, citedBy: [...new Set(citedBy)].sort() }];
  });
  return {
    unservedClauses: [...active].filter((c) => !served.has(c)).sort(),
    obligationsServingNone: live.filter((o) => !o.serves.some((c) => active.has(c))).map((o): ObligationId => o.id).sort(),
    withdrawnCited: withdrawnCited.sort((a, b) => (a.clause < b.clause ? -1 : 1)),
  };
}
