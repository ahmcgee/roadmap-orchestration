// The run-9 admit replay (M4a rev 3, B "admits.run9-exact", the free-tier gate 3): the exact records of paid M4a run 9
// (test/fixtures/run9-admits.json, copied by the N2 extractor; the synthetic Tidewater domain) replayed checkpoint by
// checkpoint through `classifyAdmits`. Each checkpoint's world is the log as it stood at that checkpoint's capture: the
// findings it was given (active at capture), the audits ended and the units published before it, the classes this replay
// gave the earlier admits. A `dishonest-citation` reason is answered as the retry the prompt asks for (N4: "cite every
// clause it advances"): the same output with the named clauses added to the op's cites, classified again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FindingId, JobId, ObligationId, Sha, UnitId, VisionClauseId } from '../../src/core/ids.ts';
import { specRepairs } from '../../src/core/records.ts';
import {
  type AdmitClassification, type AdmitFinding, type AdmitOp, type AdmitWorld, type AuditRange, type RecordedAdmit, classifyAdmits,
} from '../../src/holistic/admits.ts';
import { type FindingSource, type FindingLens, parseObligations, parseVision } from '../../src/holistic/types.ts';
import { validateCheckpointOutput } from '../../src/prompts/schemas.ts';
import { parseSpec } from '../../src/spec/spec.ts';
import { absPath } from '../../src/core/values.ts';


type Json = Record<string, unknown>;
type Pub = Readonly<{ op: string; seq: number; subject: 'unit' | 'docs'; unit: string | null; old: string; new: string; paths: readonly string[] }>;
type Ckpt = Readonly<{ job: string; seq: number; headSha: string; findings: readonly string[]; planRev: number; output: Json }>;
type Fixture = Readonly<{
  vision: Json; advances: readonly string[]; obligations: Json; findings: readonly (Json & { seq: number })[];
  audits: readonly Readonly<{ job: string; covered: readonly Readonly<{ lens: string; from: string; to: string }>[]; seq: number }>[];
  publications: readonly Pub[]; checkpoints: readonly Ckpt[];
}>;

export const RUN9_FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'run9-admits.json');
export const loadRun9 = (): Fixture => JSON.parse(readFileSync(RUN9_FIXTURE, 'utf8')) as Fixture;

/** One replayed admit: its checkpoint and unit, the first classification, and the honest retry's when the first was dishonest. */
export type Replayed = Readonly<{ job: string; unit: string; first: AdmitClassification; retry: AdmitClassification | null; final: AdmitClassification }>;

/** The world at checkpoint `c`, with `recorded` the classes replayed so far. */
function worldAt(f: Fixture, c: Ckpt, recorded: readonly RecordedAdmit[]): AdmitWorld {
  const vision = parseVision(f.vision);
  const obligations = parseObligations(f.obligations);
  const pubs = f.publications.filter((p) => p.seq < c.seq);
  const positions = new Map<string, number>();
  positions.set(f.publications[0]!.old, 0);
  pubs.forEach((p, i) => {
    if (!positions.has(p.new)) positions.set(p.new, i + 1);
  });
  const pos = (sha: string): number => {
    const p = positions.get(sha);
    if (p === undefined) throw new Error(`run 9: ${sha} is no published head before ${c.job}`);
    return p;
  };
  const captured = new Set(c.findings);
  return {
    world: vision.clauses.filter((x) => x.kind === 'world' && x.state === 'active').map((x) => x.id),
    advances: f.advances as VisionClauseId[],
    recorded,
    rootOf: (u) => u,
    // Run 9's admits repair findings only: no obligation ref needs a verdict, and no admitted unit delivers one.
    obligations: new Map(obligations.obligations.map((o) => [o.id, { def: o, holding: true, history: [] }])),
    findings: new Map(f.findings.filter((x) => x.seq < c.seq).map((x): [FindingId, AdmitFinding] => [x['id'] as FindingId, {
      id: x['id'] as FindingId, active: captured.has(x['id'] as string), captured: captured.has(x['id'] as string), visionClauses: x['visionClauses'] as VisionClauseId[],
      obligation: x['obligation'] as ObligationId | null, lens: x['lens'] as FindingLens, source: x['source'] as FindingSource,
      paths: (x['evidence'] as { path: string }[]).map((e) => e.path),
    }])),
    audits: new Map(f.audits.filter((a) => a.seq < c.seq).map((a) => [a.job as JobId, a.covered.map((r): AuditRange => ({ lens: r.lens as AuditRange['lens'], from: pos(r.from as Sha), to: pos(r.to as Sha) }))])),
    merges: pubs.flatMap((p, i) => (p.subject === 'unit' ? [{ unit: p.unit as UnitId, position: i + 1, paths: p.paths }] : [])),
  };
}

/** Every admit of the run-9 bundles, replayed in log order (see the header). */
export function replayRun9(f: Fixture = loadRun9()): readonly Replayed[] {
  const recorded: RecordedAdmit[] = [];
  const out: Replayed[] = [];
  for (const c of f.checkpoints) {
    const output = validateCheckpointOutput(c.output);
    const ops: AdmitOp[] = output.ops.flatMap((op, index) => (op.op === 'admit'
      ? [{ index, unit: op.unit.id, cites: op.cites, repairs: specRepairs(parseSpec(Buffer.from(op.spec, 'utf8'), absPath(`/run9/${op.unit.id}.json`))) }]
      : []));
    const w = worldAt(f, c, recorded);
    const first = classifyAdmits(w, ops);
    const dishonest = first.reasons.flatMap((r) => /dishonest-citation: (V-\d+)/.exec(r)?.[1] ?? []) as VisionClauseId[];
    const retry = dishonest.length === 0 ? null : classifyAdmits(w, ops.map((o) => ({ ...o, cites: [...new Set([...o.cites, ...dishonest])].sort() as VisionClauseId[] })));
    const final = retry ?? first;
    for (const x of final.classes) recorded.push({ job: c.job as JobId, ...x });
    for (const o of ops) out.push({ job: c.job, unit: o.unit, first, retry, final });
  }
  return out;
}

/** A replayed admit's outcome in one word: its class (with its opportunity), its conversion, or `invalid`. */
export function outcomeOf(r: Replayed): string {
  const cls = r.final.classes.find((x) => x.unit === r.unit)?.class;
  if (cls !== undefined) return cls.type === 'opportunity' ? `opportunity ${cls.id} ${cls.clauses.join(',')}` : cls.type === 'repair' ? `repair${cls.followUp === null ? '' : ` follow-up ${cls.followUp}`}` : cls.type;
  const conv = r.final.conversions.find((x) => x.unit === r.unit);
  if (conv !== undefined) return `converted ${conv.reason}${conv.opportunity === null ? '' : ` ${conv.opportunity}`}`;
  return `invalid: ${r.final.reasons.join('; ')}`;
}
