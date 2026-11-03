// Propagation in code (dev.17, experience-won E; DESIGN-1.0.md §2.7 "Plan, specs and certification lanes"; SCHEMAS.md "Specs and design"), the
// pure half: what a revision leaves stale. Boundary reopening gives unfinished units the revised inputs.
//
//   stale set     at every revision (the apply core, src/commands/apply.ts `evaluateRevision`): its targets are the
//                 requirements whose normative rev rose, any supplied changed contracts, and the vision
//                 clauses the owner edited or withdrew. Transitively, by code: a changed vision clause reaches the active
//                 obligations serving it that the revision did not revise (an `obligation` link, the checkpoint's to
//                 reconcile); every unmerged unit's links to a changed requirement (pinned below its new rev, or unpinned), to an
//                 obligation a changed clause reached, or to a changed contract (its cites, its spec pins; its design record's
//                 failure modes and contract interfaces) are stale; the merged artifacts are the declared witness files of each
//                 changed requirement and of each active obligation binding a changed contract (`witness`). A witness without
//                 declared `files` (an arc started before dev.11) names none, so nothing merged is re-witnessed for it.
import type { ObligationId, UnitId, VisionClauseId } from '../core/ids.ts';

import { canonicalJson } from '../core/json.ts';
import { UNPINNED } from '../core/pins.ts';
import { type SpecM1,specPinOf,specRequirementLinks } from '../core/records.ts';
import { type StaleCause, type StaleLink, type StaleSet, type StaleTarget } from '../core/stale.ts';
import type { RepoPath } from '../core/values.ts';
import type { Obligations,Vision } from './types.ts';

// ---------------------------------------------------------------------------------------------------
// The stale set

/** What a revision's stale set is computed from: the inputs before and after it, and the unmerged units' specs after it. */
export type StaleInputs = Readonly<{
  obligations: Readonly<{ before: Obligations | null; after: Obligations | null }>;
  vision: Readonly<{ before: Vision | null; after: Vision | null }>;
  /** Changed contract paths, empty for schema-2 revisions (units edit product contracts). */
  contracts: readonly RepoPath[];
  /** Every unit neither merged, cut nor superseded, in plan order, with its spec after the revision (read only when a target changed). */
  units: () => readonly Readonly<{ id: UnitId; spec: SpecM1 }>[];
}>;

/** The targets of a revision: what it changed that a link may name. */
function targetsOf(i: StaleInputs): readonly StaleTarget[] {
  const out: StaleTarget[] = [];
  const before = new Map((i.obligations.before?.obligations ?? []).map((o) => [o.id, o]));
  for (const o of i.obligations.after?.obligations ?? []) {
    const was = before.get(o.id);
    if (was !== undefined && o.rev > was.rev) out.push({ type: 'requirement', id: o.id, from: was.rev, to: o.rev });
  }
  for (const path of [...new Set(i.contracts)].sort()) out.push({ type: 'contract', path });
  const { before: vb, after: va } = i.vision;
  if (vb !== null && va !== null) {
    for (const c of vb.clauses) {
      const now = va.clauses.find((x) => x.id === c.id);
      if (now === undefined || canonicalJson(now) !== canonicalJson(c)) out.push({ type: 'vision-clause', id: c.id, visionRev: va.rev });
    }
  }
  return out;
}

/** A revision's stale set (see the header), or null when it changes no target. */
export function staleSetOf(i: StaleInputs): StaleSet | null {
  const targets = targetsOf(i);
  if (targets.length === 0) return null;
  const requirements = new Map(targets.flatMap((t) => (t.type === 'requirement' ? [[t.id, t.to] as const] : [])));
  const contracts = new Set(targets.flatMap((t) => (t.type === 'contract' ? [t.path] : [])));
  const clauses = new Set(targets.flatMap((t) => (t.type === 'vision-clause' ? [t.id] : [])));
  const obligations = i.obligations.after?.obligations ?? [];
  const links: StaleLink[] = [];

  // A changed clause reaches the active obligations serving it that the revision did not revise.
  const reached = new Map<ObligationId, VisionClauseId>();
  for (const o of obligations) {
    if (o.state.type !== 'active' || requirements.has(o.id)) continue;
    for (const c of [...o.serves].sort()) {
      if (!clauses.has(c)) continue;
      links.push({ type: 'obligation', obligation: o.id, cause: { type: 'vision-clause', id: c } });
      if (!reached.has(o.id)) reached.set(o.id, c);
    }
  }

  for (const { id: unit, spec } of i.units()) {
    for (const id of specRequirementLinks(spec)) {
      const to = requirements.get(id);
      const clause = reached.get(id);
      if (to === undefined && clause === undefined) continue;
      const pinned = specPinOf(spec, { type: 'requirement', id });
      if (to !== undefined && pinned !== UNPINNED && pinned.rev >= to) continue;
      const cause: StaleCause = to !== undefined ? { type: 'requirement', id } : { type: 'vision-clause', id: clause! };
      links.push({ type: 'spec', unit, target: { type: 'requirement', id }, pinned, cause });
    }
    for (const path of spec.cites.contracts) {
      if (contracts.has(path)) links.push({ type: 'spec', unit, target: { type: 'contract', path }, pinned: specPinOf(spec, { type: 'contract', path }), cause: { type: 'contract', path } });
    }
    for (const m of spec.design?.failureModes ?? []) {
      for (const r of m.requirements) {
        const to = requirements.get(r.id);
        if (to !== undefined && r.rev < to) links.push({ type: 'failure-mode', unit, failureMode: m.id, requirement: r.id, pinned: r.rev, cause: { type: 'requirement', id: r.id } });
      }
    }
    for (const x of spec.design?.interfaces ?? []) {
      if (contracts.has(x.path)) links.push({ type: 'interface', unit, path: x.path, pinned: x.blob, cause: { type: 'contract', path: x.path } });
    }
  }

  // Merged artifacts: the declared witness files of each changed requirement and of each active obligation binding a changed contract.
  for (const o of obligations) {
    const files = o.state.type === 'active' ? o.witness?.files : undefined;
    if (files === undefined) continue;
    if (requirements.has(o.id)) links.push({ type: 'witness', obligation: o.id, files, cause: { type: 'requirement', id: o.id } });
    for (const path of [...o.contracts].sort()) if (contracts.has(path)) links.push({ type: 'witness', obligation: o.id, files, cause: { type: 'contract', path } });
  }
  return { targets, links };
}

// Code edges

/** What a unit's spec links that a propagation edge reads: its requirements, its contracts and the files its design breaks. */
export type SpecLinks = Readonly<{ requirements: ReadonlySet<ObligationId>; contracts: ReadonlySet<RepoPath>; breaks: readonly RepoPath[] }>;

export function specLinksOf(spec: SpecM1): SpecLinks {
  const design = spec.design;
  return {
    requirements: new Set([...specRequirementLinks(spec), ...(design?.failureModes ?? []).flatMap((m) => m.requirements.map((r) => r.id))]),
    contracts: new Set([...spec.cites.contracts, ...(design?.interfaces ?? []).flatMap((x) => (x.type === 'contract' ? [x.path] : []))]),
    breaks: design === undefined ? [] : [...design.breaks.tests, ...design.breaks.docs].map((b) => b.path),
  };
}

