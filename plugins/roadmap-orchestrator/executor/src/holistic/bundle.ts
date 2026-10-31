import type { SystemName } from '../core/ids.ts';
import { type JobId, type ObligationId, type ResourceName, type Sha, type UnitId, canonicalIds } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { bundleClassesOf } from '../core/projections.ts';
import { type SpecM1, specObligations } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath } from '../core/values.ts';
import { git,revParse } from '../git/git.ts';
import { type InForce, type InputFile, type InputFiles, type RevisionInForce, type RoutingBase } from '../input/inforce.ts';
import { type DeflakeOrigin, type PlanM1, type PolishOrigin, contractOpDocuments } from '../input/plan.ts';
import { rulingContextAt } from '../pipeline/publish.ts';
import { type DocsPublisher } from '../recover/revision.ts';
import type { RiskTier } from '../routing/types.ts';
import { SpecFileError,parseSpec,specBytes } from '../spec/spec.ts';
import { type AuditRange, type RecordedAdmit, type UnitMerge } from './admits.ts';
import type { AuditContext } from './audit.ts';
import { publishedHeads } from './coverage.ts';
import { type Observation } from './observe.ts';
import { type Obligations, type RevisionVector, isExempt } from './types.ts';


export type CheckpointContext = AuditContext & Readonly<{ planFile: AbsPath; routingBase: RoutingBase; docs: DocsPublisher; laneEnv: Readonly<Record<string, string | undefined>> }>;
type RawUnit = Record<string, unknown> & {id: string};
export type RawPlan = Record<string, unknown> & {units: RawUnit[]; limits?: Record<string, number>};
const readerOf = (ctx: CheckpointContext) => ({journal: ctx.journal, runDir: ctx.runDir, planFile: ctx.planFile, repo: ctx.repo});
export type AdmitEntry = Readonly<{
  id: UnitId; risk: RiskTier; systems: readonly SystemName[]; after: readonly UnitId[]; resources: readonly ResourceName[];
  origin: 'checkpoint' | 'repair' | 'polish' | 'deflake'; polish?: PolishOrigin; deflake?: DeflakeOrigin;
}>;
export function vectorAt(ctx: CheckpointContext, inForce: InForce, revision: RevisionInForce, files: InputFiles, head: ReturnType<typeof revParse>): RevisionVector {
  if (revision.vision === null) throw new Error('a checkpoint outside a holistic revision in force');
  const specs: Record<UnitId, number> = {};
  for (const u of [...inForce.plan.units].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const f = files.specs.get(u.id);
    if (f?.bytes === null || f === undefined) throw new Error(`unit ${u.id} is in force without a spec`);
    specs[u.id] = parseSpec(f.bytes, f.path).rev;
  }
  const blobs = rulingContextAt(readerOf(ctx), head);
  return {
    plan: inForce.rev,
    specs,
    obligationsSha256: revision.manifest.obligations,
    ledgerSha256: revision.ledger.sha256,
    visionSha256: revision.vision.sha256,
    contracts: contractOpDocuments(inForce.plan).flatMap((path) => {
      const blob = blobs.blobAt(path);
      return blob === null ? [] : [{ path, blob }];
    }),
  };
}

export function admitUnit(plan: RawPlan, specs: Map<UnitId, InputFile>, entry: AdmitEntry, specText: string, specPath: AbsPath, at: string): Readonly<{ spec: SpecM1 }> | Readonly<{ reasons: readonly string[] }> {
  if (plan.units.some((u) => u.id === entry.id)) return { reasons: [`${at}: unit ${entry.id} is already planned`] };
  let spec: SpecM1;
  try {
    spec = parseSpec(Buffer.from(specText, 'utf8'), specPath);
  } catch (error) {
    if (!(error instanceof SpecFileError || error instanceof SchemaError)) throw error;
    return { reasons: [`${at}: its spec is not a unit spec: ${error.message}`] };
  }
  if (spec.unit !== entry.id || spec.rev !== 1) return { reasons: [`${at}: its spec names unit ${spec.unit} rev ${spec.rev}, not ${entry.id} rev 1`] };
  plan.units.push({
    id: entry.id, spec: `${entry.id}.json`, risk: entry.risk, systems: entry.systems, resources: entry.resources, after: entry.after, origin: entry.origin,
    ...(entry.polish === undefined ? {} : { polish: entry.polish }), ...(entry.deflake === undefined ? {} : { deflake: entry.deflake }),
    ...(entry.polish === undefined ? {} : { polish: entry.polish }),
  });
  specs.set(entry.id, { path: specPath, bytes: specBytes(spec) });
  return { spec };
}

export function fillMappedObligations(obligations: Obligations | null, plan: PlanM1, specs: Map<UnitId, InputFile>, authored: ReadonlySet<UnitId>): void {
  if (obligations === null) return;
  for (const id of [...authored].sort()) {
    const u = plan.units.find((x) => x.id === id);
    const f = specs.get(id);
    if (u === undefined || f?.bytes == null) continue;
    const spec = parseSpec(f.bytes, f.path);
    const widened = mappedObligations(obligations, u.systems, specObligations(spec));
    if (widened.length > 0 && canonicalJson(widened) !== canonicalJson(specObligations(spec))) specs.set(id, { path: f.path, bytes: specBytes({ ...spec, obligations: widened }) });
  }
}

export function evidenceDiffers(cited: Observation, head: Observation): string | null {
  if (cited.key.laneRev !== head.key.laneRev || cited.key.envId !== head.key.envId) {
    return `ran under lane rev ${cited.key.laneRev} in env ${cited.key.envId}, the head's under ${head.key.laneRev} in ${head.key.envId}`;
  }
  if (cited.record.malformed) return 'is malformed';
  if (head.record.malformed) return 'is malformed on the head';
  if (cited.record.records.length === 0) return 'records no test';
  const onHead = new Map(head.record.records.map((r) => [r.testId, r]));
  for (const r of cited.record.records) {
    const h = onHead.get(r.testId);
    if (h === undefined) return `test ${JSON.stringify(r.testId)} is not in the head's record`;
    if (h.outcome !== r.outcome) return `test ${JSON.stringify(r.testId)} was ${r.outcome}, is ${h.outcome} on the head`;
    if (h.selected < r.selected) return `test ${JSON.stringify(r.testId)} selected ${r.selected}, ${h.selected} on the head`;
  }
  return null;
}

export function integrationHistory(view: JournalView, repo: AbsPath, tip: Sha): Readonly<{
  positions: ReadonlyMap<Sha, number>; merges: readonly UnitMerge[]; audits: ReadonlyMap<JobId, readonly AuditRange[]>;
}> {
  const heads = publishedHeads(view);
  const positions = new Map<Sha, number>();
  positions.set(heads.length > 0 ? heads[0]!.old : tip, 0);
  heads.forEach((h, i) => {
    if (!positions.has(h.head)) positions.set(h.head, i + 1);
  });
  // An audit reads the branch, so its range can end on a commit the owner put there by hand (a vision edit, dev.13
  // arc): that commit merges no unit, so it sits at its nearest published first-parent ancestor's position.
  const positionOf = (sha: Sha, what: string): number => {
    const p = positions.get(sha) ?? git(repo, ['rev-list', '--first-parent', sha]).split('\n').map((x) => positions.get(x as Sha)).find((x) => x !== undefined);
    if (p === undefined) throw new Error(`${what} names ${sha}, which descends from no head of the integration history`);
    return p;
  };
  const ffs = new Map(view.opsOf('integration.ff').map((i) => [i.op, i]));
  const merges = heads.flatMap((h, i): UnitMerge[] => {
    const parent = ffs.get(h.op)?.parent;
    if (h.subject !== 'unit' || parent?.type !== 'stage') return [];
    const paths = git(repo, ['diff', '--name-only', '--no-renames', h.old, h.head]).split('\n').filter((x) => x !== '');
    return [{ unit: parent.unit, position: i + 1, paths }];
  });
  const audits = new Map(view.holistic().audits.flatMap((x) => (x.ended === null ? [] : [[x.started.job, x.ended.covered.map((r): AuditRange => ({
    lens: r.lens, from: positionOf(r.from, `${x.started.job}'s ${r.lens} range`), to: positionOf(r.to, `${x.started.job}'s ${r.lens} range`),
  }))] as const])));
  return { positions, merges, audits };
}

function mappedObligations(obligations: Obligations, systems: readonly SystemName[], declared: readonly ObligationId[]): readonly ObligationId[] {
  const live = new Set(obligations.obligations.filter((o) => !isExempt(o)).map((o) => o.id));
  const mapped = obligations.mapping.systems.filter((m) => systems.includes(m.system)).flatMap((m) => m.obligations).filter((id) => live.has(id));
  return canonicalIds([...declared, ...mapped]);
}

export function recordedAdmits(view: JournalView): readonly RecordedAdmit[] {
  return view.opsOf('revision.commit').flatMap((commit) => {
    const source = commit.expect.source;
    if (source.type !== 'bundle' || view.doneOf(commit.op) === null) return [];
    const classes = bundleClassesOf(source);
    return classes === 'unclassified' ? [] : classes.admits.map((x) => ({ job: source.job, ...x }));
  });
}
