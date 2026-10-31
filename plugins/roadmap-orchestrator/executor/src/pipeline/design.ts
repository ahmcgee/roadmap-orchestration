import { type DesignChange, type DesignRecord, type FailureMode, type TestItemRef, designSize } from '../core/design.ts';
import { type ClauseId, type LaneId, type ObligationId, type Sha, type SystemName, type UnitId, clauseId, sha } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type LaneDef, type SpecM1, specForces, specWitnesses } from '../core/records.ts';
import type { ContractPin, FilePin, RequirementPin } from '../core/pins.ts';
import { type RepoPath, type RepoPattern, matchesPattern } from '../core/values.ts';
import { gitRun } from '../git/git.ts';
import { laneUnreachable } from '../holistic/witnessfiles.ts';
import { environmentUnavailable } from '../resources/environments.ts';
import { arcRolesOf } from '../input/inforce.ts';
import { type SystemsMap, dependentsClosure } from '../input/systems.ts';
import type { DesignAnswer } from '../prompts/schemas.ts';
import { GATE_DIFF_BUDGET } from './gate.ts';
import { mapInForce } from './lanes.ts';
import type { StageContext } from './dispatch.ts';
import { holisticInForce } from './stages.ts';

/** The changed lines in one system above which its change is substantial, not seam-sized. A first guess (BACKLOG). */
export const SUBSTANTIAL_SYSTEM_LINES = 200;
/** The bytes one changed line takes in the gate's attached diff, context included: what turns its byte budget into lines. */
export const DIFF_BYTES_PER_LINE = 100;
/** The design estimate above which the unit's diff would overflow the gate's inline budget (`GATE_DIFF_BUDGET`); a function, as gate.ts imports this module's importers. */
export const gateInlineLines = (): number => Math.floor(GATE_DIFF_BUDGET / DIFF_BYTES_PER_LINE);
/** Proofs of concept per unit, uncharged. */


/** Why code refuses a design: plain reasons (a repair turn, then malformed) and plan defects (a repair turn, then a park). */
export type DesignFaults = Readonly<{ reasons: readonly string[]; defects: readonly string[] }>;
const NO_FAULTS: DesignFaults = { reasons: [], defects: [] };
const join = (a: DesignFaults, b: DesignFaults): DesignFaults => ({ reasons: [...a.reasons, ...b.reasons], defects: [...a.defects, ...b.defects] });

/** The blob id of `path` at `tip`, or null when the tip has no such file. */
function blobAt(ctx: Pick<StageContext, 'repo'>, tip: Sha, path: RepoPath): Sha | null {
  const r = gitRun(ctx.repo, ['rev-parse', '--verify', '-q', `${tip}:${path}`], { okCodes: [0, 1, 128] });
  return r.code === 0 ? sha(r.stdout.trim()) : null;
}

/** The record `answer` pins at `tip` (see the header), or why it cannot be pinned. */
export function pinDesign(
  ctx: Pick<StageContext, 'repo' | 'plan' | 'journal' | 'runDir'>, answer: DesignAnswer, tip: Sha,
): Readonly<{ kind: 'pinned'; record: DesignRecord }> | Readonly<{ kind: 'refused'; reasons: readonly string[] }> {
  const reasons: string[] = [];
  const file = (path: RepoPath, what: string): FilePin | null => {
    const blob = blobAt(ctx, tip, path);
    if (blob === null) reasons.push(`the design record's ${what} ${path} names no file at the integration tip ${tip}`);
    return blob === null ? null : { type: 'file', path, blob };
  };
  const contracts = new Set<string>(ctx.plan().contracts);
  const interfaces = answer.interfaces.flatMap((i): (ContractPin | FilePin)[] => {
    if (i.type === 'contract' && !contracts.has(i.path)) {
      reasons.push(`the design record names ${i.path} as a contract interface, which is no plan contract (name it as a file)`);
      return [];
    }
    const pinned = file(i.path, 'interface');
    return pinned === null ? [] : [i.type === 'contract' ? { type: 'contract', path: pinned.path, blob: pinned.blob } : pinned];
  });
  const breaks = { tests: answer.breaks.tests.flatMap((p) => file(p, 'broken test') ?? []), docs: answer.breaks.docs.flatMap((p) => file(p, 'broken doc') ?? []) };
  const obligations = holisticInForce(ctx).obligations?.obligations ?? [];
  const requirement = (id: ObligationId): RequirementPin | null => {
    const o = obligations.find((x) => x.id === id);
    if (o === undefined) reasons.push(`a failure mode names requirement ${id}, which is no obligation in force`);
    return o === undefined ? null : { type: 'requirement', id, rev: o.rev };
  };
  const failureModes = answer.failureModes.map((m): FailureMode => ({ id: m.id, mode: m.mode, proof: m.proof, requirements: m.requirements.flatMap((r) => requirement(r) ?? []) }));
  const map = mapInForce(ctx.journal.view);
  for (const c of answer.changes) {
    if (c.system !== null && (map === null || !Object.hasOwn(map.systems, c.system))) reasons.push(`a change names system ${c.system}, which the systems map in force does not declare (use null)`);
  }
  if (reasons.length > 0) return { kind: 'refused', reasons };
  return {
    kind: 'pinned',
    record: {
      kind: answer.kind, changes: answer.changes, interfaces, failureModes, clauses: answer.clauses, breaks, experiments: answer.experiments,
      ...(answer.newSystem === null ? {} : { newSystem: answer.newSystem }), ...(answer.verification === null ? {} : { verification: answer.verification }),
    },
  };
}

/** The changed lines per system of a record (a change with no system counts under null). */
function linesBySystem(changes: readonly DesignChange[]): ReadonlyMap<SystemName | null, number> {
  const out = new Map<SystemName | null, number>();
  for (const c of changes) out.set(c.system, (out.get(c.system) ?? 0) + c.lines);
  return out;
}

/** The systems a record changes substantially (over `SUBSTANTIAL_SYSTEM_LINES`), ascending. */
export const substantialSystems = (changes: readonly DesignChange[]): readonly SystemName[] =>
  [...linesBySystem(changes)].flatMap(([s, n]) => (s !== null && n > SUBSTANTIAL_SYSTEM_LINES ? [s] : [])).sort();

/** Mixed concerns: two or more systems each changed substantially. */
export const mixedConcerns = (changes: readonly DesignChange[]): boolean => substantialSystems(changes).length >= 2;

/** Why a record is oversize (a plan defect, fixed by a split), or null. */
export function oversize(record: Pick<DesignRecord, 'changes'>): string | null {
  const mixed = substantialSystems(record.changes);
  if (mixed.length >= 2) return `oversize: the design changes ${mixed.join(' and ')} substantially (each over ${SUBSTANTIAL_SYSTEM_LINES} lines), mixed concerns: split it, the skeleton (contracts, wiring, the spanning test) first`;
  const size = designSize(record as DesignRecord);
  if (size > gateInlineLines()) return `oversize: the design estimates ${size} changed lines, over the ${gateInlineLines()} the gate reads inline: split it`;
  return null;
}

/** A lane a test item may name: the spec's active lanes, the plan's suite lanes and the arc lanes in force, by id. */
function lanesInForce(ctx: Pick<StageContext, 'plan' | 'journal' | 'runDir'>, spec: SpecM1): ReadonlyMap<LaneId, LaneDef> {
  const arc = holisticInForce(ctx).obligations?.lanes ?? [];
  return new Map<LaneId, LaneDef>([...arc, ...ctx.plan().suite.lanes, ...spec.lanes.filter((l) => l.state === 'active')].map((l) => [l.id, l]));
}

/** Whether a lane listing systems is selected by a change of `changes` (any change without a system: every lane, fail-safe). */
export function designSelects(map: SystemsMap | null, lane: Pick<LaneDef, 'systems'>, changes: readonly DesignChange[]): boolean {
  if (map === null || lane.systems === undefined) return true;
  if (changes.some((c) => c.system === null)) return true;
  const touched = dependentsClosure(map, changes.map((c) => c.system as SystemName));
  return lane.systems.some((s) => touched.has(s));
}

/** The lane and test a test item names, in words. */
const itemText = (t: TestItemRef): string => (t.type === 'witness' ? `witness item ${t.item}` : `test ${JSON.stringify(t.testId)} of lane ${t.lane}`);

/**
 * The faults of a pinned record against the spec it lands on (see the header: failure modes, reachability, kind, size).
 * `forced`: the lanes the unit's spec forces. `items`: the unit's active witness items (W-n), the ones a witness proof may
 * name and every one of which must be reachable.
 */
export function designFaults(
  ctx: Pick<StageContext, 'plan' | 'journal' | 'runDir'>, spec: SpecM1, record: DesignRecord,
): DesignFaults {
  const reasons: string[] = [];
  const defects: string[] = [];
  const lanes = lanesInForce(ctx, spec);
  const map = mapInForce(ctx.journal.view);
  const forced = new Set<LaneId>(specForces(spec));
  const witnesses = specWitnesses(spec).filter((w) => w.state === 'active');
  const laneOf = (t: TestItemRef): LaneId | null => (t.type === 'test' ? t.lane : witnesses.find((w) => w.id === t.item)?.lane ?? null);
  // Failure modes: each proven by a test item the unit has, or untested with a reason.
  for (const m of record.failureModes) {
    if (m.proof.type === 'untested') continue;
    const t = m.proof.test;
    if (t.type === 'witness' && !witnesses.some((w) => w.id === t.item)) reasons.push(`failure mode ${m.id} is unmapped: ${itemText(t)} is no active witness item of the spec`);
    else if (t.type === 'test' && !lanes.has(t.lane)) reasons.push(`failure mode ${m.id} is unmapped: ${itemText(t)} names no spec, suite or arc lane in force`);
  }
  // Reachability: every test item runs at or before the candidate merge.
  const items: readonly TestItemRef[] = [
    ...record.failureModes.flatMap((m) => (m.proof.type === 'test' ? [m.proof.test] : [])),
    ...witnesses.map((w): TestItemRef => ({ type: 'witness', item: w.id })),
  ];
  const seen = new Set<string>();
  for (const t of items) {
    const id = laneOf(t);
    const lane = id === null ? undefined : lanes.get(id);
    const key = itemText(t);
    if (lane === undefined || seen.has(key)) continue;
    seen.add(key);
    const miss = laneUnreachable(lane, forced.has(lane.id), designSelects(map, lane, record.changes));
    if (miss === 'cadence') defects.push(`${key} sits in lane ${lane.id}, a batch lane that never runs before the unit merges: force it in the spec (\`forces\`), or prove it in an earlier lane`);
    if (miss === 'systems') defects.push(`${key} sits in lane ${lane.id}, which lists systems (${(lane.systems ?? []).join(', ')}) the design's changes never select`);
    const env = miss === null && lane.environment !== undefined ? environmentUnavailable(ctx.journal.view, lane.environment) : null;
    if (env !== null) defects.push(`${key} sits in lane ${lane.id}, which cannot run in this arc: ${env}`);
  }
  const clauses = clauseFaults(spec, record, lanes, (lane) => cannotRun(ctx.journal.view, lane, forced.has(lane.id), designSelects(map, lane, record.changes)));
  reasons.push(...clauses.reasons);
  defects.push(...clauses.defects);
  // Kind: an integration unit spans systems and is proven by a spanning lane.
  if (record.kind === 'integration') {
    const systems = [...new Set(record.changes.flatMap((c) => (c.system === null ? [] : [c.system])))];
    if (systems.length < 2 && !record.changes.some((c) => c.system === null)) defects.push(`an integration unit changes two or more systems; this design changes ${systems.join(', ') || 'none'}`);
    const spanning = record.failureModes.some((m) => {
      if (m.proof.type !== 'test') return false;
      const lane = lanes.get(laneOf(m.proof.test) ?? ('' as LaneId));
      if (lane === undefined || (lane.cadence !== 'candidate' && lane.cadence !== 'batch')) return false;
      if (lane.cadence === 'batch' && !forced.has(lane.id)) return false;
      return lane.systems === undefined || lane.systems.filter((s) => systems.includes(s)).length >= 2;
    });
    if (!spanning) defects.push('an integration unit is proven by a spanning test: a failure mode proven in a candidate or batch lane spanning two or more of its systems (or the whole tree), forced when batch');
  }
  const big = oversize(record);
  if (big !== null) defects.push(big);
  return { reasons, defects };
}

/** Why `lane` cannot run for the unit in this arc before it merges (its cadence, its systems, its environment), or null. */
function cannotRun(view: JournalView, lane: LaneDef, forced: boolean, selected: boolean): string | null {
  const miss = laneUnreachable(lane, forced, selected);
  if (miss === 'cadence') return `${lane.id} is a batch lane the spec does not force: it never runs before the unit merges`;
  if (miss === 'systems') return `${lane.id} lists systems (${(lane.systems ?? []).join(', ')}) the design's changes never select`;
  return lane.environment === undefined ? null : environmentUnavailable(view, lane.environment);
}

/**
 * Item 10 (2026-10-23): every active acceptance clause is exercised by a lane that can run in this arc before the unit
 * merges. A clause's lanes are those of the spec's active witness items naming it and those the record's `clauses` entry
 * names. An entry naming no active acceptance clause, or a lane not in force, is a plain reason; a clause with no lane, or
 * none that can run (`why`: src/pipeline/design.ts `cannotRun`), is a plan defect whose fixes are a static harness witness
 * in a lane that runs, a split putting the clause in its own unit, or its explicit deferral.
 */
export function clauseFaults(
  spec: SpecM1, record: Pick<DesignRecord, 'clauses'>, lanes: ReadonlyMap<LaneId, LaneDef>, why: (lane: LaneDef) => string | null,
): DesignFaults {
  const reasons: string[] = [];
  const defects: string[] = [];
  const active = spec.acceptance.filter((a) => a.state === 'active');
  for (const c of record.clauses) {
    if (!active.some((a) => a.id === c.clause)) reasons.push(`the design record's clauses name ${c.clause}, which is no active acceptance clause of the spec`);
    const unknown = c.lanes.filter((l) => !lanes.has(l));
    if (unknown.length > 0) reasons.push(`the design record's clauses entry for ${c.clause} names ${unknown.join(', ')}, no spec, suite or arc lane in force`);
  }
  const witnesses = specWitnesses(spec).filter((w) => w.state === 'active');
  for (const a of active) {
    const named = [...new Set([...witnesses.filter((w) => w.clause === a.id).map((w) => w.lane), ...(record.clauses.find((c) => c.clause === a.id)?.lanes ?? [])])];
    const defs = named.flatMap((l) => lanes.get(l) ?? []);
    const fix = `add a static harness witness in a lane that runs here (a witness item, or a test in a lane the design's clauses name), split ${a.id} into its own unit, or defer it (a redirect deferring ${a.id})`;
    if (named.length === 0) {
      defects.push(`acceptance clause ${a.id}'s behaviour is exercised by no lane: name its lanes in the design record's clauses, or ${fix}`);
      continue;
    }
    if (defs.length < named.length) continue; // a lane not in force: a plain reason above
    const blocked = defs.map((l) => why(l));
    if (blocked.every((b) => b !== null)) defects.push(`acceptance clause ${a.id}'s behaviour is exercised by no lane that can run in this arc before the unit merges (${blocked.join('; ')}): ${fix}`);
  }
  return { reasons, defects };
}

/**
 * The builder's departures from a design record (dev.17): of `changed` (existing files the build modified or deleted), the
 * tests (a system's `tests` glob) and docs (the map's docs class) the record's `breaks` does not list, each as a decision the
 * executor appends to the spec beside decisions.json: recorded, never refused. None without a systems map (nothing tells a
 * test or a doc then) or without a record.
 */
export function departures(map: SystemsMap | null, record: DesignRecord | undefined, changed: readonly RepoPath[]): readonly Readonly<{ id: ClauseId; text: string }>[] {
  if (map === null || record === undefined) return [];
  const listed = new Set<string>([...record.breaks.tests, ...record.breaks.docs].map((b) => b.path));
  const tests = Object.values(map.systems).flatMap((s) => s.tests);
  const kind = (p: RepoPath): 'test' | 'doc' | null => (tests.some((g) => matchesPattern(p, g)) ? 'test' : map.docs.some((g) => matchesPattern(p, g)) ? 'doc' : null);
  return [...changed].sort().flatMap((p) => {
    const k = kind(p);
    if (k === null || listed.has(p)) return [];
    return [{ id: clauseId(`departure.${sha256Hex(p).slice(0, 12)}`), text: `Departure from the design record: the build changed the existing ${k} ${p}, which its breaks do not list.` }];
  });
}
