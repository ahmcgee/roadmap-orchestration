// Shared unit admission for executor-minted deflake and milestone polish units.
import type { SystemName } from '../core/ids.ts';
import { type ObligationId, type ResourceName, type UnitId, canonicalIds } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type SpecM1, specObligations } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath } from '../core/values.ts';
import { type InputFile, type RoutingBase } from '../input/inforce.ts';
import { type DeflakeOrigin, type PlanM1, type PolishOrigin } from '../input/plan.ts';
import { type DocsPublisher } from '../recover/revision.ts';
import type { RiskTier } from '../routing/types.ts';
import { SpecFileError,parseSpec,specBytes } from '../spec/spec.ts';
import type { AuditContext } from './audit.ts';
import { type Obligations, isExempt } from './types.ts';

export type RevisionContext = AuditContext & Readonly<{ planFile: AbsPath; routingBase: RoutingBase; docs: DocsPublisher; laneEnv: Readonly<Record<string, string | undefined>> }>;
type RawUnit = Record<string, unknown> & {id: string};
export type RawPlan = Record<string, unknown> & {units: RawUnit[]; limits?: Record<string, number>};
export type AdmitEntry = Readonly<{
  id: UnitId; risk: RiskTier; systems: readonly SystemName[]; after: readonly UnitId[]; resources: readonly ResourceName[];
  origin: 'checkpoint' | 'repair' | 'polish' | 'deflake'; polish?: PolishOrigin; deflake?: DeflakeOrigin;
}>;
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

function mappedObligations(obligations: Obligations, systems: readonly SystemName[], declared: readonly ObligationId[]): readonly ObligationId[] {
  const live = new Set(obligations.obligations.filter((o) => !isExempt(o)).map((o) => o.id));
  const mapped = obligations.mapping.systems.filter((m) => systems.includes(m.system)).flatMap((m) => m.obligations).filter((id) => live.has(id));
  return canonicalIds([...declared, ...mapped]);
}

