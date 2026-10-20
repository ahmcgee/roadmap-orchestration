// A walkthrough's report, held to its inputs and minted (dev.13, plan §2 "Output", "Minting"; SCHEMAS.md "dev.13",
// "Outputs"). The schema reader (src/prompts/schemas.ts `validateWalkthroughOutput`) holds the answer to its shape and
// the rules inside it; `walkRefusals` adds what needs the walk's inputs, each reason one sentence for the one repair turn
// every judgment takes (read as lenses are):
//   - every journey of the milestone is reported, and no other;
//   - every cited evidence file exists, inside the evidence dir (a relative path is read from it);
//   - a `design` or `contract` finding's path lies inside one of the milestone's references;
//   - a cited vision clause (`vision`, or a floor's source) exists and is active, and a floor's is non-negotiable (a
//     floor whose source is a repository file is read as given: the reference's quality-floor section);
//   - a polish unit's scope covers one of the milestone's references, its spec is the unit's own (`unit` its id, rev 1),
//     and its id is no unit of the plan.
// Minting (`mintWalk`): `breaks` opens a P1, `deviates` a P2 (lens `walkthrough`, the milestone named, no obligation),
// through the one findings store (dedupe `findingKey('walkthrough', null, cause)`); each polish proposal is a
// `polish-proposed` fact carrying its unit (agent D's code-applied polish revision consumes them), never a finding and
// never debt. A failed bring-up's P1 is code's (`bringUpDraft`).
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { WalkFact } from '../core/events.ts';
import { type FindingId, type JobId, type PolishId, type Sha, type UnitId, type VisionClauseId, canonicalIds } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import { specM1 } from '../core/records.ts';
import type { AbsPath, RepoPath, RepoPattern } from '../core/values.ts';
import { catFileType, revParse } from '../git/git.ts';
import { type FindingDraft, openFinding } from '../holistic/findings.ts';
import type { FindingEvidence, Vision } from '../holistic/types.ts';
import type { Milestone, PlanM1 } from '../input/plan.ts';
import type { WalkFinding, WalkthroughOutput } from '../prompts/schemas.ts';

/** What a report is held to: the milestone, the plan in force, the vision in force and the evidence dir. */
export type WalkCheck = Readonly<{ milestone: Milestone; plan: PlanM1; vision: Vision; evidenceDir: AbsPath }>;

/** A cited evidence file's absolute path, or null when it lies outside the evidence dir. */
export function evidencePath(evidenceDir: AbsPath, cited: string): string | null {
  const path = isAbsolute(cited) ? cited : resolve(evidenceDir, cited);
  const rel = relative(evidenceDir, path);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : path;
}

/** Whether `path` lies at or under one of `references`. */
const inside = (references: readonly RepoPath[], path: string): boolean => references.some((r) => path === r || path.startsWith(`${r}/`));

/** A scope pattern's literal directory part: everything before its first glob character, without a trailing slash. */
const literalPart = (p: RepoPattern): string => {
  const i = p.search(/[*?[{]/);
  return (i === -1 ? p : p.slice(0, i)).replace(/\/+$/, '');
};

/** Whether `scope` covers one of `references`: a pattern inside a reference dir, or one whose literal part holds one. */
export function coversReference(references: readonly RepoPath[], scope: readonly RepoPattern[]): boolean {
  return scope.some((p) => {
    const base = literalPart(p);
    return references.some((r) => base === r || base.startsWith(`${r}/`) || (base === '' || r.startsWith(`${base}/`)));
  });
}

/** Every reason the report cannot be minted as given (see the header); empty when it can. */
export function walkRefusals(c: WalkCheck, out: WalkthroughOutput): readonly string[] {
  const reasons: string[] = [];
  const { milestone: m } = c;
  const expected = m.journeys.map((j) => j.id);
  const reported = out.journeys.map((j) => j.journey);
  const missing = expected.filter((j) => !reported.includes(j));
  const unknown = reported.filter((j) => !expected.includes(j));
  if (missing.length > 0) reasons.push(`journey${missing.length > 1 ? 's' : ''} ${missing.join(', ')} of ${m.id} ${missing.length > 1 ? 'are' : 'is'} not reported: report every journey, blocked or completed`);
  if (unknown.length > 0) reasons.push(`${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} no journey of ${m.id} (its journeys: ${expected.join(', ')})`);
  const cite = (where: string, list: readonly string[]): void => {
    for (const e of list) {
      const path = evidencePath(c.evidenceDir, e);
      if (path === null) reasons.push(`${where} cites ${e}, which is outside the evidence dir ${c.evidenceDir}: keep evidence there and cite it by its path`);
      else if (!existsSync(path) || !statSync(path).isFile()) reasons.push(`${where} cites ${e}, which is no file in the evidence dir ${c.evidenceDir}`);
    }
  };
  for (const j of out.journeys) cite(`journey ${j.journey}`, j.evidence);
  const clauses = new Map(c.vision.clauses.map((x) => [x.id as string, x]));
  const activeClause = (where: string, id: VisionClauseId): boolean => {
    const clause = clauses.get(id);
    if (clause === undefined) reasons.push(`${where} cites vision clause ${id}, which the vision in force does not have`);
    else if (clause.state !== 'active') reasons.push(`${where} cites vision clause ${id}, which is ${clause.state}`);
    return clause?.state === 'active';
  };
  out.findings.forEach((f, i) => {
    const where = `finding ${i + 1} ("${f.claim}")`;
    cite(where, f.evidence);
    if ((f.against.type === 'design' || f.against.type === 'contract') && !inside(m.references, f.against.path)) {
      reasons.push(`${where} measures against ${f.against.path}, which is inside none of ${m.id}'s references (${m.references.join(', ')})`);
    }
    if (f.against.type === 'vision') activeClause(where, f.against.clause);
    if (f.against.type === 'floor' && /^V-[0-9]+$/.test(f.against.source)) {
      const id = f.against.source as VisionClauseId;
      const kind = clauses.get(id)?.kind;
      if (activeClause(where, id) && kind !== 'non-negotiable') {
        reasons.push(`${where} takes vision clause ${id} as a floor, but its kind is ${kind}: a floor is a non-negotiable clause or a reference's quality-floor section; a finding measured against any other clause is deviates, against vision`);
      }
    }
  });
  const planned = new Set<string>(c.plan.units.map((u) => u.id));
  out.polish.forEach((x, i) => {
    const where = `polish proposal ${i + 1} (unit ${x.unit.id})`;
    cite(where, x.evidence);
    if (!coversReference(m.references, x.unit.scope)) reasons.push(`${where}: its scope (${x.unit.scope.join(', ')}) covers none of ${m.id}'s references (${m.references.join(', ')})`);
    if (planned.has(x.unit.id)) reasons.push(`${where}: ${x.unit.id} is already a unit of the plan; name a new unit`);
    const spec = specM1(JSON.parse(x.unit.spec), `${where}.spec`);
    if (spec.unit !== x.unit.id || spec.rev !== 1) reasons.push(`${where}: its spec is unit ${spec.unit} rev ${spec.rev}; a proposal's spec is its own unit's, rev 1`);
  });
  return reasons;
}

/** The blob `path` names at `sha`, or null when it names no file there. */
function blobAt(repo: AbsPath, sha: Sha, path: RepoPath): FindingEvidence {
  return { path, blob: catFileType(repo, `${sha}:${path}`) === 'blob' ? revParse(repo, `${sha}:${path}`) : null };
}

/** The finding draft of a report's finding: the product paths it localises to (their blobs at the walked SHA), then its evidence files. */
export function walkDraft(x: Readonly<{ repo: AbsPath; job: JobId; sha: Sha; milestone: Milestone; evidenceDir: AbsPath }>, f: WalkFinding): FindingDraft {
  const clauses: VisionClauseId[] = [];
  if (f.against.type === 'vision') clauses.push(f.against.clause);
  if (f.against.type === 'floor' && /^V-[0-9]+$/.test(f.against.source)) clauses.push(f.against.source as VisionClauseId);
  return {
    lens: 'walkthrough',
    severity: f.class === 'breaks' ? 'P1' : 'P2',
    obligation: null,
    visionClauses: canonicalIds(clauses),
    claim: `${f.journey}: ${f.claim}`,
    cause: f.cause,
    evidence: [
      ...f.paths.map((p) => blobAt(x.repo, x.sha, p)),
      ...f.evidence.map((e): FindingEvidence => ({ path: evidencePath(x.evidenceDir, e)!, blob: null })),
    ],
    mutant: null,
    source: { type: 'job', job: x.job },
    gateHadPassed: true,
    milestone: x.milestone.id,
  };
}

/** Code's P1 for a bring-up that failed (no model call): it cites the failed step's output. */
export function bringUpDraft(job: JobId, m: Milestone, step: string, detail: string, logs: readonly AbsPath[]): FindingDraft {
  return {
    lens: 'walkthrough', severity: 'P1', obligation: null, visionClauses: [],
    claim: `Milestone ${m.id}'s product did not come up for ${job}: its bring-up step ${step} failed (${detail}).`,
    cause: `bring-up: ${step} failed`,
    evidence: logs.map((path): FindingEvidence => ({ path, blob: null })),
    mutant: null, source: { type: 'job', job }, gateHadPassed: true, milestone: m.id,
  };
}

/**
 * Mints a validated report of walk `job`: its findings through the store (opened or merged; a suppressed one by a
 * dismissal is left out), then its polish proposals as `polish-proposed` facts, skipping those the walk already
 * recorded (a resumed walk mints the same report again). Returns the walk's findings (id order) and proposals (log order).
 */
export function mintWalk(
  journal: Journal, x: Readonly<{ repo: AbsPath; job: JobId; sha: Sha; milestone: Milestone; evidenceDir: AbsPath }>, out: WalkthroughOutput,
): Readonly<{ findings: readonly FindingId[]; proposals: readonly PolishId[] }> {
  const ids = new Set<FindingId>();
  for (const f of out.findings) {
    const o = openFinding(journal, walkDraft(x, f));
    if (o.kind !== 'suppressed') ids.add(o.id);
  }
  const recorded = (): readonly Extract<WalkFact, { kind: 'polish-proposed' }>[] =>
    journal.view.walkFacts().flatMap((w) => (w.fact.kind === 'polish-proposed' && w.fact.job === x.job ? [w.fact] : []));
  const had = new Set<UnitId>(recorded().map((p) => p.unit.id));
  for (const p of out.polish) {
    if (had.has(p.unit.id)) continue;
    journal.fact({
      kind: 'polish-proposed', id: journal.view.nextPolishId(), job: x.job, milestone: x.milestone.id, journey: p.journey,
      evidence: p.evidence.map((e) => evidencePath(x.evidenceDir, e)!), text: p.text,
      unit: { id: p.unit.id, scope: [...p.unit.scope].sort(), spec: p.unit.spec },
    });
  }
  return { findings: canonicalIds(ids), proposals: recorded().map((p) => p.id) };
}
