// The run-9 admit replay (M4a rev 3, B "admits.run9-exact", the free-tier gate 3): the exact records of paid M4a run 9
// (test/fixtures/run9-admits.json, copied by the N2 extractor; the synthetic Tidewater domain) replayed checkpoint by
// checkpoint through `classifyAdmits`. Each checkpoint's world is the log as it stood at that checkpoint's capture: the
// findings it was given (active at capture), the audits ended and the units published before it, the classes this replay
// gave the earlier admits. The recorded answers predate `targets` (LR-m) and classify on the structural floor; a
// synthetic variant (`declare`) gives an admit its targets and cites. A `dishonest-citation` reason (an out-of-slice rule
// targeted, no clause outside the slice cited) is answered as the retry the prompt asks for (N4: "cite every clause
// it advances"): the same output with the clauses the targeted out-of-slice rules advance added to the op's cites,
// classified again. Code holds no rule→clause map, so the replay takes the honest clauses from the records that name
// them: the out-of-slice world clauses the Phase-0 record's questions bear beside those rules, and those its repaired
// findings carry (lens context). None found: no retry (the admit stays invalid).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FindingId, JobId, ObligationId, RuleId, Sha, UnitId, VisionClauseId } from '../../src/core/ids.ts';
import {
  type AdmitClassification, type AdmitFinding, type AdmitOp, type AdmitWorld, type AuditRange, type RecordedAdmit, admitOpOf, classifyAdmits,
} from '../../src/holistic/admits.ts';
import { type FindingSource, type FindingLens, parseObligations, parseVision } from '../../src/holistic/types.ts';
import { validateCheckpointOutput } from '../../src/prompts/schemas.ts';
import { parseSpec } from '../../src/spec/spec.ts';
import { absPath } from '../../src/core/values.ts';


type Json = Record<string, unknown>;
type Pub = Readonly<{ op: string; seq: number; subject: 'unit' | 'docs'; unit: string | null; old: string; new: string; paths: readonly string[] }>;
type Ckpt = Readonly<{ job: string; seq: number; headSha: string; findings: readonly string[]; planRev: number; output: Json }>;
type Fixture = Readonly<{
  phase0Questions: readonly Readonly<{ bears: readonly string[] }>[];
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
    census: new Map((obligations.census ?? []).map((e) => [e.rule, e.state.type])),
    findings: new Map(f.findings.filter((x) => x.seq < c.seq).map((x): [FindingId, AdmitFinding] => [x['id'] as FindingId, {
      id: x['id'] as FindingId, active: captured.has(x['id'] as string), captured: captured.has(x['id'] as string), visionClauses: x['visionClauses'] as VisionClauseId[],
      obligation: x['obligation'] as ObligationId | null, lens: x['lens'] as FindingLens, source: x['source'] as FindingSource,
      paths: (x['evidence'] as { path: string }[]).map((e) => e.path),
    }])),
    audits: new Map(f.audits.filter((a) => a.seq < c.seq).map((a) => [a.job as JobId, a.covered.map((r): AuditRange => ({ lens: r.lens as AuditRange['lens'], from: pos(r.from as Sha), to: pos(r.to as Sha) }))])),
    merges: pubs.flatMap((p, i) => (p.subject === 'unit' ? [{ unit: p.unit as UnitId, position: i + 1, paths: p.paths }] : [])),
  };
}

/**
 * What a synthetic variant declares for an admit the records hold (LR-m): its `targets` and the cites it would then
 * give; the recorded answers predate `targets` and read as none.
 */
export type Declared = Readonly<Record<string, Readonly<{ targets: readonly string[]; cites: readonly string[] }>>>;

/** Every admit of the run-9 bundles, replayed in log order (see the header), with `declare` overriding admits by unit. */
export function replayRun9(f: Fixture = loadRun9(), declare: Declared = {}): readonly Replayed[] {
  const recorded: RecordedAdmit[] = [];
  const out: Replayed[] = [];
  for (const c of f.checkpoints) {
    const output = validateCheckpointOutput(c.output);
    const obligations = parseObligations(f.obligations);
    const ops: AdmitOp[] = output.ops.flatMap((op, index) => (op.op === 'admit'
      ? [admitOpOf(index, op, parseSpec(Buffer.from(op.spec, 'utf8'), absPath(`/run9/${op.unit.id}.json`)), obligations)]
      : [])).map((o) => {
      const d = declare[o.unit];
      return d === undefined ? o : { ...o, targets: d.targets as RuleId[], cites: d.cites as VisionClauseId[] };
    });
    const w = worldAt(f, c, recorded);
    const first = classifyAdmits(w, ops);
    const slice = new Set(f.advances);
    const world = new Set(w.world);
    const honest = (op: AdmitOp): readonly VisionClauseId[] => {
      const reason = first.reasons.find((r) => r.startsWith(`op ${op.index + 1} (admit ${op.unit})`) && r.includes('dishonest-citation'));
      if (reason === undefined) return [];
      const rules = new Set((/out-of-slice rules ([T0-9, -]+) and/.exec(reason)?.[1] ?? '').split(', ') as RuleId[]);
      const fromQuestions = f.phase0Questions.filter((q) => q.bears.some((b) => rules.has(b as RuleId))).flatMap((q) => q.bears.filter((b) => b.startsWith('V-')));
      const fromFindings = op.repairs.flatMap((r) => (r.startsWith('F-') ? w.findings.get(r as FindingId)?.visionClauses ?? [] : []));
      return [...new Set([...fromQuestions, ...fromFindings])].filter((v) => world.has(v as VisionClauseId) && !slice.has(v)).sort() as VisionClauseId[];
    };
    const added = new Map(ops.map((o) => [o.index, honest(o)]));
    const retry = [...added.values()].every((x) => x.length === 0) ? null
      : classifyAdmits(w, ops.map((o) => ({ ...o, cites: [...new Set([...o.cites, ...added.get(o.index)!])].sort() as VisionClauseId[] })));
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
