// The design pass's code checks (dev.17; DESIGN-1.0.md "Design pass"; SCHEMAS.md "dev.17: the design pass"). A plan-check
// writes a design record (src/core/design.ts) with its approve, scaffold or split; code binds it only as far as code can check,
// and refuses an answer through the judgment repair turn, every reason together, before anything of it is applied:
//
//   pinning          `pinDesign`: the record's interfaces and broken files at their blobs and its requirements at their revs,
//                    at the tip the check read. A path that names no file there, a contract interface that is no plan
//                    contract, a requirement that is no obligation in force, or a change naming a system the map does not
//                    declare: a reason.
//   failure modes    every failure mode is proven by a test item the unit has (an active witness item of its spec, or a test
//                    of a spec, suite or arc lane in force) or is `untested` with a reason; an unmapped one blocks the approve.
//   reachability     every test item (failure-mode proofs and the spec's active witness items, W-n) sits in a lane that runs
//                    at or before the unit's proof point, the candidate merge: a batch lane only when the spec forces it, a
//                    lane listing systems only when the design's systems select it (src/holistic/witnessfiles.ts
//                    `laneUnreachable`). A plan defect.
//   kind             an `integration` unit changes two or more systems and is proven by a spanning lane: a test of a
//                    candidate or batch lane listing two or more of its systems, or none (the whole tree); forced when
//                    batch. A plan defect.
//   size             oversize is a plan defect: mixed concerns (two or more systems each over `SUBSTANTIAL_SYSTEM_LINES`) or
//                    an estimate over the gate's inline diff budget (`gateInlineLines`). The fix is a `split`.
//   scope            the record's change paths outside the unit's effective scope join its scope-growth proposals (the
//                    existing verified growth, src/pipeline/stages.ts `verifiedGrowth`), never a refusal by themselves.
//   split            `splitReasons`: children within the parent's effective scope, the parent's active acceptance and
//                    witness items partitioned exactly, obligations a subset of the parent's, each child sized (its own design
//                    record passing the checks above against its own items), edges acyclic; a mixed-concerns split has a
//                    skeleton every other child runs after, whose design proves a failure mode in the skeleton's spanning
//                    lane. A plan defect.
//   scaffold         only where the `scaffold` role is in force (an arc of the `dev17` role set); its new system's paths and
//                    the record's agree; its load test's lane is an arc lane in force (whose reporter shows the test ran).
//   poc              at most `POC_LIMIT` proofs of concept per unit (a plain refusal past it).
//
// Plan defects take the repair turn like any refusal; an answer refused again for one parks the unit `plan-defect`, uncharged
// (src/pipeline/stages.ts `planCheckRead`). The thresholds are first guesses to re-derive from a measured arc (BACKLOG).
import { type DesignChange, type DesignRecord, type FailureMode, type TestItemRef, designSize } from '../core/design.ts';
import { type ClauseId, type LaneId, type ObligationId, type Sha, type SystemName, type UnitId, clauseId, sha } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type LaneDef, type SpecM1, specForces, specWitnesses } from '../core/records.ts';
import type { ContractPin, FilePin, RequirementPin } from '../core/pins.ts';
import { type RepoPath, type RepoPattern, matchesPattern } from '../core/values.ts';
import { gitRun } from '../git/git.ts';
import { laneUnreachable } from '../holistic/witnessfiles.ts';
import { withinEnvelope } from '../input/envelope.ts';
import { arcRolesOf } from '../input/inforce.ts';
import { type SystemsMap, dependentsClosure } from '../input/systems.ts';
import type { DesignAnswer, ScaffoldDecision, SplitDecision } from '../prompts/schemas.ts';
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
export const POC_LIMIT = 2;

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
      kind: answer.kind, changes: answer.changes, interfaces, failureModes, breaks, experiments: answer.experiments,
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
  }
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

/** The record's change paths outside `scope` (the effective scope), ascending: what joins the answer's scope growth. */
export const designUnscoped = (changes: readonly DesignChange[], scope: readonly RepoPattern[]): readonly RepoPattern[] =>
  [...new Set(changes.flatMap((c) => c.paths).filter((p) => !withinEnvelope(p, scope)))].sort();

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

/** Whether the `scaffold` role is in force: an arc of the `dev17` role set (src/routing/layers.ts `unitRolesInForce`). */
export const scaffoldInForce = (view: JournalView): boolean => arcRolesOf(view.planApplied()) === 'dev17';

/** Why a `scaffold` decision cannot run (see the header). */
export function scaffoldReasons(ctx: Pick<StageContext, 'plan' | 'journal' | 'runDir'>, decision: ScaffoldDecision, design: DesignAnswer): readonly string[] {
  const reasons: string[] = [];
  if (!scaffoldInForce(ctx.journal.view)) reasons.push('the scaffold role is not in force in this arc (started before 1.0.0-dev.17): approve, and let the build write the skeleton');
  if (design.newSystem === null || JSON.stringify(design.newSystem) !== JSON.stringify(decision.newSystem)) {
    reasons.push('the design record\'s newSystem and the scaffold decision\'s newSystem differ: they name the one system the scaffold writes');
  }
  const arc = holisticInForce(ctx).obligations?.lanes ?? [];
  if (!arc.some((l) => l.id === decision.loadTest.lane)) reasons.push(`the load test's lane ${decision.loadTest.lane} is no arc lane in force (its reporter is what shows the load test ran)`);
  return reasons;
}

/** Why a `poc` decision cannot run: the unit has had its proofs of concept (`UnitState.pocs`). */
export const pocReasons = (view: JournalView, unit: UnitId): readonly string[] =>
  view.unit(unit).pocs >= POC_LIMIT ? [`the unit has run its ${POC_LIMIT} proofs of concept: decide with what they answered`] : [];

/** Whether `edges` among `nodes` hold a cycle. */
function cyclic(nodes: readonly UnitId[], edges: readonly Readonly<{ from: UnitId; to: UnitId }>[]): boolean {
  const state = new Map<UnitId, 'open' | 'done'>();
  const visit = (n: UnitId): boolean => {
    if (state.get(n) === 'done') return false;
    if (state.get(n) === 'open') return true;
    state.set(n, 'open');
    const found = edges.filter((e) => e.from === n).some((e) => visit(e.to));
    state.set(n, 'done');
    return found;
  };
  return nodes.some((n) => visit(n));
}

/** Whether `to` runs after `from` through `edges`. */
function after(edges: readonly Readonly<{ from: UnitId; to: UnitId }>[], from: UnitId, to: UnitId): boolean {
  const seen = new Set<UnitId>();
  const walk = (n: UnitId): boolean => {
    if (n === to) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    return edges.filter((e) => e.from === n).some((e) => walk(e.to));
  };
  return edges.filter((e) => e.from === from).some((e) => walk(e.to));
}

/**
 * The faults of a split of `parent` (its spec in force and effective scope): every one a plan defect, besides the pinning
 * reasons of a child's design. `childSpec` builds a child's spec as code will land it (src/pipeline/split.ts), against which
 * the child's design is checked as its own plan-check would.
 */
export function splitFaults(
  ctx: Pick<StageContext, 'plan' | 'journal' | 'runDir' | 'repo'>, parent: SpecM1, scope: readonly RepoPattern[], split: SplitDecision, tip: Sha,
  childSpec: (child: SplitDecision['children'][number], design: DesignRecord) => SpecM1,
): DesignFaults {
  const defects: string[] = [];
  let faults = NO_FAULTS;
  const planned = new Set<UnitId>(ctx.journal.view.plannedUnits());
  const ids = split.children.map((c) => c.unit);
  for (const c of split.children) {
    if (planned.has(c.unit)) defects.push(`child ${c.unit} is a unit id the plan used before; a split names new ids`);
    const outside = c.scope.filter((p) => !withinEnvelope(p, scope));
    if (outside.length > 0) defects.push(`child ${c.unit}'s scope ${outside.join(', ')} lies outside the parent's effective scope`);
    const stray = c.obligations.filter((o) => !(parent.obligations ?? []).includes(o));
    if (stray.length > 0) defects.push(`child ${c.unit} declares ${stray.join(', ')}, which the parent does not`);
  }
  // The parent's active acceptance and witness items, partitioned exactly.
  const items = [...parent.acceptance, ...specWitnesses(parent)].filter((i) => i.state === 'active').map((i) => i.id as string);
  const taken = split.children.flatMap((c) => c.items);
  const twice = [...new Set(taken.filter((id, i) => taken.indexOf(id) !== i))];
  const unknown = [...new Set(taken.filter((id) => !items.includes(id)))];
  const dropped = items.filter((id) => !taken.includes(id));
  if (twice.length > 0) defects.push(`the children take ${twice.join(', ')} more than once; each of the parent's items goes to exactly one child`);
  if (unknown.length > 0) defects.push(`the children take ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is no' : 'are no'} active acceptance or witness item of the parent`);
  if (dropped.length > 0) defects.push(`no child takes the parent's ${dropped.join(', ')}; the children partition its active items exactly`);
  if (cyclic(ids, split.edges)) defects.push('the edges among the children hold a cycle');
  // Each child sized: its design pinned and passing the checks against its own spec.
  const designs = new Map<UnitId, DesignRecord>();
  for (const c of split.children) {
    const pinned = pinDesign(ctx, c.design, tip);
    if (pinned.kind === 'refused') {
      faults = join(faults, { reasons: pinned.reasons.map((r) => `child ${c.unit}: ${r}`), defects: [] });
      continue;
    }
    designs.set(c.unit, pinned.record);
    const own = designFaults(ctx, childSpec(c, pinned.record), pinned.record);
    faults = join(faults, { reasons: own.reasons.map((r) => `child ${c.unit}: ${r}`), defects: own.defects.map((d) => `child ${c.unit}: ${d}`) });
  }
  // Integrate first: a mixed-concerns split lands a skeleton first.
  const all = split.children.flatMap((c) => c.design.changes);
  if (mixedConcerns(all)) {
    const sk = split.skeleton;
    if (sk === null) defects.push('a split of mixed concerns lands a skeleton first (contracts, wiring and the spanning test): name it in skeleton');
    else {
      const lane = lanesInForce(ctx, parent).get(sk.lane);
      if (lane === undefined || (lane.cadence !== 'candidate' && lane.cadence !== 'batch')) defects.push(`the skeleton's lane ${sk.lane} is no candidate or batch lane in force: its spanning test runs where systems meet`);
      const record = designs.get(sk.unit);
      const proves = record?.failureModes.some((m) => m.proof.type === 'test' && m.proof.test.type === 'test' && m.proof.test.lane === sk.lane) ?? false;
      if (record !== undefined && !proves) defects.push(`the skeleton ${sk.unit}'s design proves no failure mode in its spanning lane ${sk.lane}`);
      const loose = ids.filter((u) => u !== sk.unit && !after(split.edges, sk.unit, u));
      if (loose.length > 0) defects.push(`${loose.join(', ')} ${loose.length === 1 ? 'does' : 'do'} not run after the skeleton ${sk.unit}`);
    }
  }
  return join(faults, { reasons: [], defects });
}
