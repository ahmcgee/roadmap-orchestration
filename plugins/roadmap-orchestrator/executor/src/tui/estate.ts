import { planInForce, revisionInForce, keptInput, inputPath, specShaInForce, SPEC_INPUT } from '../input/inforce.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { gitRun } from '../git/git.ts';
import { parseSpec } from '../spec/spec.ts';
import { debtEntries } from './debt-estate.ts';
import { targetDocumentPaths } from '../input/plan.ts';
import { type Entry, type EntryKind, pretty } from './types.ts';

/** Explicit references only: equality of recorded string values, never inferred semantic relationships. */
export function connect(entries: Entry[]): Entry[] {
  const values = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(values)
    : v !== null && typeof v === 'object' ? Object.values(v).flatMap(values) : [];
  for (const e of entries) {
    let refs: string[] = [];
    try { refs = values(JSON.parse(e.body)); } catch { /* prose has no structured links */ }
    e.links = entries.filter((other) => other.id !== e.id && refs.includes(other.id)).map((other) => other.id);
  }
  // A recorded relationship is browsable in both directions, with its original document still visible.
  for (const e of entries) for (const id of [...e.links]) {
    const other = entries.find((x) => x.id === id)!;
    if (!other.links.includes(e.id)) other.links.push(e.id);
  }
  return entries;
}

export function estate(runDir: AbsPath, view: JournalView, repo: AbsPath | null): Entry[] {
  const force = planInForce(runDir, view);
  if (force === null) return [];
  const revision = revisionInForce(runDir, force);
  const entries: Entry[] = [];
  const add = (id: string, label: string, value: unknown, hash: string, state = 'active', kind?: EntryKind, description?: string): void => {
    entries.push({ ...(kind ? { kind } : {}), ...(description ? { description } : {}), id, label, state, body: typeof value === 'string' ? value : pretty(value), links: [], provenance: `revision ${force.rev} sha256 ${hash}` });
  };
  const rows = (v: unknown, hash: string, category: string, parentId?: string): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const row of v) rows(row, hash, category, parentId); return; }
    const obj = v as Record<string, unknown>;
    const existing = entries.some((e) => e.id === obj['id']);
    if (typeof obj['id'] === 'string' && !existing) {
      const state = obj['state'];
      add(obj['id'], category === 'Vision' ? `${obj['id']}${typeof obj['kind'] === 'string' ? ` · ${obj['kind']}` : ''}` : `${category} ${obj['id']}`, v, hash, typeof state === 'string' ? state
        : state !== null && typeof state === 'object' && 'type' in state ? String(state.type) : 'active');
    }
    const id = typeof obj['id'] === 'string' ? obj['id'] : undefined;
    if (parentId && id && !existing) {
      const entry = entries.find((e) => e.id === id)!;
      entry.parentId = parentId;
      if (category === 'Vision') {
        entry.kind = typeof obj['kind'] === 'string' ? 'vision-clause' : 'vision-question';
        if (entry.kind === 'vision-question') entry.label = `${id} · question`;
      }
      if (typeof obj['text'] === 'string') entry.description = obj['text'];
    }
    for (const value of Object.values(obj)) rows(value, hash, category, parentId ? id ?? parentId : undefined);
  };
  const absent = (id: string, label: string, kind: EntryKind, explanation: string): void => {
    entries.push({ id, label: `${label} (not recorded)`, kind, state: 'unavailable',
      description: 'Not recorded for this run.', body: `# ${label}\n\nNot recorded for this run.\n\n${explanation}`,
      links: [], provenance: `revision ${force.rev} · ${label.toLowerCase()} not recorded` });
  };
  if (revision.vision) add('vision', 'Vision', revision.vision.value, revision.vision.sha256, 'active', 'vision',
    'The structured project vision retained for this revision. Arc scope identifies the vision clauses selected for this run.');
  else absent('vision', 'Vision', 'vision', 'This run did not record a structured vision. Recorded arc intent contains the direction supplied with the plan; it is not a substitute for a vision document.');
  if (force.plan.holistic) add('arc-slice', 'Arc scope (selected clauses)', { advances: force.plan.holistic.advances }, force.manifest.planSha256, 'active', 'arc-slice',
    'The part of the project vision selected for this run, as recorded in the applied plan. Related documents links the clauses, vision and retained planning decisions.');
  else absent('arc-slice', 'Arc scope', 'arc-slice', 'The applied plan does not select vision clauses for this arc. The execution plan and recorded intent remain available.');
  add('plan', 'Arc execution plan', force.plan, force.manifest.planSha256, 'active', 'arc-plan', 'The full applied plan: units, dependencies, milestones and checks.');
  add('intent:arc', 'Recorded arc intent', `# Recorded arc intent\n\n${force.plan.direction}\n\nThis direction is retained with the applied arc plan. The executor does not retain the original planning conversation as a separate source brief. See the vision, when recorded, for the target outcomes.`, force.manifest.planSha256, 'active', 'intent', 'The direction recorded in the plan; this is not the original planning conversation.');
  entries.push(...debtEntries(runDir, view, repo, force, revision));
  for (const milestone of force.plan.milestones ?? []) add(milestone.id, `Milestone ${milestone.id}: ${milestone.text}`, milestone, force.manifest.planSha256, 'active', 'milestone', milestone.text);
  for (const milestone of force.plan.milestones ?? []) rows(milestone, force.manifest.planSha256, 'Milestone', milestone.id);
  for (const unit of force.plan.units) {
    const hash = specShaInForce(view, unit.id);
    const bytes = keptInput(runDir, hash, SPEC_INPUT);
    const spec = bytes === null ? null : parseSpec(bytes, inputPath(runDir, hash, SPEC_INPUT));
    add(unit.id, `Unit specification: ${unit.id}`, spec ?? 'Unavailable: retained specification missing', hash,
      view.unit(unit.id).status, 'specification', 'Acceptance criteria, allowed paths, checks and references for this unit.');
    add(`design:${unit.id}`, `Implementation plan: ${unit.id}`, spec?.design ? { unit: unit.id, ...spec.design } :
      'No settled implementation plan is retained in this unit’s current specification. Plan-check results may contain proposals; use Related documents to inspect recorded planning inputs and results.', hash,
      spec?.design ? 'recorded' : 'unavailable', 'implementation-plan', spec?.design ? 'The design settled by plan-check: changes, interfaces, failure modes and verification.' : 'No settled design is retained yet. Recorded plan-check inputs and results are linked when available.');
    for (const witness of spec?.witnesses ?? []) {
      add(`${unit.id}/${witness.id}`, `Witness ${unit.id}/${witness.id}`, { unit: unit.id, ...witness }, hash, witness.state);
      entries.at(-1)!.parentId = unit.id;
    }
  }
  add('rulings', 'Constraints & rulings', revision.ledger.bytes.toString(), revision.ledger.sha256);
  for (const [id, sidecar] of revision.sidecars) {
    add(id, `Ruling ${id}`, sidecar.sidecar, sidecar.sha256, sidecar.sidecar.status);
    entries.at(-1)!.parentId = 'rulings';
  }
  for (const [label, input] of [['Vision', revision.vision], ['Obligations', revision.obligations]] as const) {
    if (input !== null) {
      if (label !== 'Vision') add(label.toLowerCase(), label, input.value, input.sha256);
      rows(input.value, input.sha256, label, label.toLowerCase());
    }
  }
  for (const o of revision.obligations?.value.obligations ?? []) {
    if (o.witness) add(`${o.id}/witness`, `Witness for ${o.id}`, { obligation: o.id, ...o.witness, proofJudgment: o.proofJudgment }, revision.obligations!.sha256, o.state.type);
  }
  if (revision.corpus !== null) {
    const c = revision.corpus;
    add('phase0', 'Planning decisions and slice', c.phase0.value, c.phase0.sha256);
    add('corpus', 'Corpus rules', c.pin.value, c.pin.sha256);
    rows(c.pin.value, c.pin.sha256, 'Rule', 'corpus');
    for (const rule of c.pin.value.retired) {
      const row = entries.find((e) => e.id === rule.id);
      if (row) row.state = 'retired';
    }
    add('corpus-guide', 'Corpus guide', c.guide.bytes.toString(), c.guide.sha256);
  }
  const commit = view.integrationHead() ?? force.plan.baseline;
  const docs = [...force.plan.contracts, '.roadmap/invariants.md', '.roadmap/constraints.md', ...targetDocumentPaths(force.plan)];
  for (const path of new Set(docs)) {
    if (entries.some((e) => e.id === path)) continue;
    const result = repo === null ? null : gitRun(repo, ['cat-file', 'blob', `${commit}:${path}`], { okCodes: [0, 128] });
    entries.push({ kind: 'document', description: force.plan.contracts.some((contract) => contract === path) ? 'Contract captured at the integration commit.' : 'Document captured at the integration commit.', id: path, label: `${force.plan.contracts.some((contract) => contract === path) ? 'Contract' : 'Document'}: ${path}`, state: 'active', links: [], provenance: `commit ${commit}`,
      body: result?.code === 0 ? result.stdout : `Unavailable at ${commit}: ${path}` });
  }
  const nest = (id: string, parentId: string): void => {
    const child = entries.find((e) => e.id === id);
    if (child && entries.some((e) => e.id === parentId)) child.parentId = parentId;
  };
  for (const e of entries) if (e.kind === 'debt-item') nest(e.id, 'debt');
  nest('.roadmap/debt.md', 'debt'); nest('.roadmap/constraints.md', 'rulings'); nest('corpus-guide', 'corpus');
  for (const unit of force.plan.units) {
    nest(`design:${unit.id}`, unit.id);
  }
  for (const o of revision.obligations?.value.obligations ?? []) nest(`${o.id}/witness`, o.id);
  connect(entries);
  const link = (from: string, to: string): void => {
    const a = entries.find((e) => e.id === from); const b = entries.find((e) => e.id === to);
    if (a && b) { if (!a.links.includes(to)) a.links.push(to); if (!b.links.includes(from)) b.links.push(from); }
  };
  link('debt', '.roadmap/debt.md'); link('debt', 'phase0');
  for (const item of entries.filter((e) => e.kind === 'debt-item')) { link('debt', item.id); link(item.id, 'phase0'); }
  for (const entry of entries) if (entry.parentId) link(entry.id, entry.parentId);
  link('vision', 'arc-slice'); link('arc-slice', 'plan'); link('arc-slice', 'phase0');
  link('plan', 'intent:arc'); link('intent:arc', 'vision'); link('plan', 'phase0');
  for (const unit of force.plan.units) { link(unit.id, `design:${unit.id}`); link(unit.id, 'plan'); link(`design:${unit.id}`, 'intent:arc'); }
  return entries;
}
