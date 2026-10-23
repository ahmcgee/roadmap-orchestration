// The flaky ledger (dev.17, lane topology; DESIGN-1.0.md §4 "Flaky ledger", SCHEMAS.md "dev.17: the flaky ledger"). Pure
// over the log's view and the plan in force; the minting revision and its items are src/pipeline/deflakemint.ts.
//
// A flake is a lane run red, then green on its diagnostic rerun (src/pipeline/redlane.ts): the same tree, the same
// environment. The series that saw it writes `flake-observed{owner, lane, set, event, forgiven}` once (`observeFlake`)
// before the lane's record is read. The event's `tree` is the lane's input on the commit (its reuse key's `inputSha`), `env`
// its environment id, `failing` the test ids the red run's reporter named (an arc lane's; a spec or suite lane names none).
// A stochastic lane (k-of-n) never takes the red-lane protocol, so it is never flaky and never deflaked.
//
// The ledger (`flakyLedger`) is arc-wide, one entry per key: (lane, testId) for each failing test, or the lane when the
// reporter named none. Each entry holds its events in log order and the deflake units minted for it (the plan's units of
// origin `deflake` whose keys name it, in plan order).
//
// Forgiveness: a flaky lane counts as passed (its green rerun's verdict) for every owner but a deflake unit of one of the
// event's keys, which must fix it. So an in-flight unit keeps its one-rerun forgiveness while the deflake unit works; the
// flake is the ledger's to fix, never the unit's.
//
// Minting (`deflakeDue`, applied by deflakemint.ts): a key with no open or parked deflake whose events since its deflakes
// settled (the latest's publication when merged; its admission when cut, which fixed nothing) are not empty: its first
// deflake when it has none, a second (told of the first) after one, and after two a non-blocking `flake-recurring` item,
// no third. Never quarantine, never skip: the lane keeps running everywhere.
//
// Code edges (`deflakeHold`): a unit that has not been dispatched yet and whose lanes include an open deflake's lane (its
// spec lanes, the suite lanes it forces, its witness lanes, and the plan's suite lanes up to `candidate` its scope may
// select) waits at its first admission until that deflake merges. A deflake unit is never held by an edge. A parked
// deflake holds nothing (its item is `deflake-parked`), nor does a cut one.
//
// Verification (`verificationReasons`): a deflake unit's approving plan-check carries `verification` in its design record:
// `reproduce-then-fix` (the induced condition fails the old tree and passes the new), or `repeat` with a rationale. Its
// `runs` times the lane's measured median duration (the ledger's red and green runs of the key) must fit the verification
// budget: `limits.verification.lanes[lane]` lane-minutes, else for a batch lane `BATCH_VERIFICATION_RUNS` runs, else
// `limits.verification.laneMinutes` (default 30). Over it, the plan-check's repair turn names the cost. The lanes stage then
// runs the deflake unit's lane `runs` times, every run passing (`verify` on its spawns, src/pipeline/lanes.ts).
import { type LaneOwner, type FlakyFact, type FlakyLaneSet } from '../core/events.ts';
import type { DesignRecord, Verification } from '../core/design.ts';
import { type FlakyEvent, type FlakyKey, type FlakyLedgerEntry, flakyKeyOf } from '../core/flaky.ts';
import type { InvocationId, LaneId, SystemName, UnitId } from '../core/ids.ts';
import type { FlakeAt, Journal, JournalView } from '../core/interfaces.ts';
import { cadenceAtOrBefore, type LaneDef, type SpecM1, specForces } from '../core/records.ts';
import { flakyLedgerDefault } from '../core/upgrade.ts';
import type { AbsPath, RepoPattern } from '../core/values.ts';
import { lineageMembers } from '../input/envelope.ts';
import { BATCH_VERIFICATION_RUNS, DEFAULT_VERIFICATION_LANE_MINUTES, type PlanM1, type PlanUnit } from '../input/plan.ts';
import { type SystemDef, type SystemsMap, dependentsClosure } from '../input/systems.ts';
import { mayOverlap } from '../input/classify.ts';
import { runnerFiles } from '../runner/files.ts';
import { invocationDir } from './invoke.ts';

/** The ledger keys of one flake: one per failing test, or the lane when its reporter named none. */
export const flakyKeysOf = (lane: LaneId, failing: readonly string[]): readonly FlakyKey[] =>
  failing.length === 0 ? [{ type: 'lane', lane }] : [...new Set(failing)].sort().map((testId) => ({ type: 'test', lane, testId }));

const keyText = (k: FlakyKey): string => flakyKeyOf(k);

// ---------------------------------------------------------------------------------------------------
// Deflake units

/** The plan's deflake units, in plan order. */
export const deflakeUnits = (plan: PlanM1): readonly PlanUnit[] => plan.units.filter((u) => u.origin === 'deflake');

/** Where a deflake unit's lineage stands: its head merged, parked, cut, or still open. */
export type DeflakeState = 'open' | 'parked' | 'merged' | 'cut';

export function deflakeState(view: JournalView, unit: UnitId): DeflakeState {
  const head = lineageMembers(view, unit).at(-1)!;
  switch (view.unit(head).status) {
    case 'retired':
      return 'merged';
    case 'cut':
      return 'cut';
    case 'park-pending':
      return 'parked';
    case 'active':
    case 'held':
    case 'stop-pending':
      return 'open';
    case 'superseded':
      throw new Error(`deflake unit ${unit}: its lineage head ${head} is superseded`);
  }
}

/**
 * The seq after which a settled deflake's key flaking again counts: a merged one's publication (its fix is in every later
 * tree), a cut one's admission (it fixed nothing); null while it is open or parked.
 */
function settledSeq(view: JournalView, unit: UnitId): number | null {
  const state = deflakeState(view, unit);
  if (state === 'merged') {
    const head = lineageMembers(view, unit).at(-1)!;
    const pub = view.publications().find((p) => p.unit === head);
    if (pub === undefined) throw new Error(`deflake unit ${head} is retired without a publication`);
    return pub.seq;
  }
  if (state === 'cut') {
    const added = view.addedSeq(unit);
    if (added === null) throw new Error(`deflake unit ${unit} is in the plan, but no plan-applied fact named it`);
    return added;
  }
  return null;
}

/** The deflake units of `plan` whose keys name `key`, in plan order. */
const deflakesOf = (plan: PlanM1, key: string): readonly UnitId[] =>
  deflakeUnits(plan).filter((u) => u.deflake!.keys.some((k) => keyText(k) === key)).map((u) => u.id);

/** The deflake keys of `unit` or of its lineage (a re-entry of a deflake unit is one too); empty for any other unit. */
function ownKeys(view: JournalView, plan: PlanM1, unit: UnitId): ReadonlySet<string> {
  const byId = new Map(plan.units.map((u) => [u.id as string, u]));
  const out = new Set<string>();
  for (const u of plan.units) {
    if (u.deflake === undefined) continue;
    if (lineageMembers(view, u.id).includes(unit)) for (const k of u.deflake.keys) out.add(keyText(k));
  }
  for (const k of byId.get(unit)?.deflake?.keys ?? []) out.add(keyText(k));
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The ledger

/** One ledger entry with the seqs of its events (the flakes' facts), for the minting decision. */
export type LedgerEntry = FlakyLedgerEntry & Readonly<{ at: readonly FlakeAt[]; set: FlakyLaneSet }>;

/**
 * The arc's flaky ledger: one entry per key, in the order its first flake was observed. An arc whose revision in force a
 * release before 1.0.0-dev.17 applied ran without one: its ledger starts empty at the upgrade (warned once).
 */
export function flakyLedger(view: JournalView, plan: PlanM1): readonly LedgerEntry[] {
  if (view.planApplied()?.systemsMap === undefined) flakyLedgerDefault();
  const entries = new Map<string, { key: FlakyKey; at: FlakeAt[]; set: FlakyLaneSet }>();
  for (const x of view.flakes()) {
    for (const key of flakyKeysOf(x.fact.lane, x.fact.event.failing)) {
      const k = keyText(key);
      const e = entries.get(k) ?? { key, at: [], set: x.fact.set };
      e.at.push(x);
      entries.set(k, e);
    }
  }
  return [...entries.entries()].map(([k, e]) => ({ key: e.key, events: e.at.map((x) => x.fact.event), deflakes: deflakesOf(plan, k), at: e.at, set: e.set }));
}

// ---------------------------------------------------------------------------------------------------
// Observation and forgiveness

/** Whether `owner` is forgiven a flake of `keys`: every owner but a deflake unit of one of them. */
export function flakeForgiven(view: JournalView, plan: PlanM1, owner: LaneOwner, keys: readonly FlakyKey[]): boolean {
  if (owner.type === 'job') return true;
  const own = ownKeys(view, plan, owner.unit);
  return !keys.some((k) => own.has(keyText(k)));
}

/**
 * Records one flake (`flake-observed`), once per red run: whether its lane counts as passed. Called by the series that ran
 * the diagnostic rerun, before it reads the lane's record.
 */
export function observeFlake(
  ctx: Readonly<{ journal: Journal; plan: () => PlanM1 }>, owner: LaneOwner, lane: LaneId, set: FlakyLaneSet, event: FlakyEvent,
): boolean {
  const view = ctx.journal.view;
  const known = view.flakes().find((x) => x.fact.event.red === event.red);
  if (known !== undefined) return known.fact.forgiven;
  const forgiven = flakeForgiven(view, ctx.plan(), owner, flakyKeysOf(lane, event.failing));
  const fact: FlakyFact = { kind: 'flake-observed', owner, lane, set, event, forgiven };
  ctx.journal.fact(fact);
  return forgiven;
}

/** The `flake-observed` fact of red run `red`, if one was written: a read-back of a series reads its forgiveness here. */
export const flakeOf = (view: JournalView, red: InvocationId): FlakyFact | null => view.flakes().find((x) => x.fact.event.red === red)?.fact ?? null;

// ---------------------------------------------------------------------------------------------------
// What is due

/** Keys of one lane due a deflake unit at the same count (`previous` the deflakes they had), and the flakes behind them. */
export type MintGroup = Readonly<{ lane: LaneId; set: FlakyLaneSet; keys: readonly FlakyKey[]; previous: readonly UnitId[]; flakes: readonly FlakeAt[] }>;
/** A key that flaked again after two deflake units: its item names the flake (`flake-recurring`). */
export type Recurring = Readonly<{ key: FlakyKey; deflakes: readonly UnitId[]; flake: FlakeAt }>;
export type DeflakeDue = Readonly<{ mint: readonly MintGroup[]; recurring: readonly Recurring[] }>;

/** The deflake units a key may have (a third flake after them raises `flake-recurring`). */
export const DEFLAKE_LIMIT = 2;

/** What the ledger asks for now (see the header). */
export function deflakeDue(view: JournalView, plan: PlanM1): DeflakeDue {
  const groups = new Map<string, { lane: LaneId; set: FlakyLaneSet; keys: FlakyKey[]; previous: UnitId[]; flakes: FlakeAt[] }>();
  const recurring: Recurring[] = [];
  for (const e of flakyLedger(view, plan)) {
    const states = e.deflakes.map((d) => settledSeq(view, d));
    if (states.some((s) => s === null)) continue;
    const since = Math.max(0, ...(states as number[]));
    const fresh = e.at.filter((x) => x.seq > since);
    if (fresh.length === 0) continue;
    if (e.deflakes.length >= DEFLAKE_LIMIT) {
      recurring.push({ key: e.key, deflakes: e.deflakes, flake: fresh[0]! });
      continue;
    }
    const g = `${e.key.lane}#${e.deflakes.length}`;
    const group = groups.get(g) ?? { lane: e.key.lane, set: e.set, keys: [], previous: [], flakes: [] };
    group.keys.push(e.key);
    for (const d of e.deflakes) if (!group.previous.includes(d)) group.previous.push(d);
    for (const x of fresh) if (!group.flakes.includes(x)) group.flakes.push(x);
    groups.set(g, group);
  }
  return { mint: [...groups.values()], recurring };
}

/** Whether anything is due (the scheduler's question). */
export const deflakePending = (view: JournalView, plan: PlanM1): boolean => {
  const due = deflakeDue(view, plan);
  return due.mint.length > 0 || due.recurring.length > 0;
};

// ---------------------------------------------------------------------------------------------------
// Code edges

/** The spec-side lanes of a unit (`SpecFacts.lanes`, src/schedule/ready.ts): active spec lanes, forces, witness lanes. */
export function specLaneIds(spec: SpecM1): ReadonlySet<LaneId> {
  return new Set([
    ...spec.lanes.filter((l) => l.state === 'active').map((l) => l.id),
    ...specForces(spec),
    ...(spec.witnesses ?? []).filter((w) => w.state === 'active').map((w) => w.lane),
  ]);
}

/**
 * Whether the plan's suite lane `lane` may run for a unit of `scope` (cadence up to `candidate`; a batch lane is off the
 * merge path): with no map or no systems, always; else when a scope pattern may overlap a path or test glob of a system the
 * lane names or depends on, or of no system at all (unmapped: every lane, fail-safe).
 */
function suiteMaySelect(map: SystemsMap | null, lane: LaneDef, scope: readonly RepoPattern[]): boolean {
  if (!cadenceAtOrBefore(lane.cadence, 'candidate')) return false;
  if (map === null || lane.systems === undefined) return true;
  const touched = new Set<SystemName>();
  for (const s of scope) {
    const hit = (Object.entries(map.systems) as [SystemName, SystemDef][]).filter(([, d]) => [...d.paths, ...d.tests].some((p) => mayOverlap(s, p))).map(([n]) => n);
    if (hit.length === 0 && !map.docs.some((d) => mayOverlap(s, d))) return true;
    for (const n of hit) touched.add(n);
  }
  const closure = dependentsClosure(map, touched);
  return lane.systems.some((s) => closure.has(s));
}

/**
 * The code edge holding `unit` now (see the header), or null: it has not been dispatched, is no deflake unit, and an open
 * deflake's lane is among its lanes (`specLanes`, read only when an open deflake exists).
 */
export function deflakeHold(
  view: JournalView, plan: PlanM1, map: SystemsMap | null, unit: PlanUnit, specLanes: () => ReadonlySet<LaneId>,
): Readonly<{ type: 'deflake'; deflake: UnitId; lane: LaneId }> | null {
  if (unit.origin === 'deflake' || view.unit(unit.id).spec !== null) return null;
  const open = deflakeUnits(plan).filter((d) => deflakeState(view, d.id) === 'open');
  if (open.length === 0) return null;
  const lanes = specLanes();
  for (const d of open) {
    const lane = d.deflake!.keys[0]!.lane;
    const suite = plan.suite.lanes.find((l) => l.id === lane);
    if (lanes.has(lane) || (suite !== undefined && suiteMaySelect(map, suite, unit.scope))) return { type: 'deflake', deflake: d.id, lane };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Verification

/** A run's wall duration in minutes, from its runner files (launch.json's start, exit.json's end); null without both. */
function runMinutes(runDir: AbsPath, inv: InvocationId, deadlineMs: number): number | null {
  const files = runnerFiles(invocationDir(runDir, inv), inv);
  const launch = files.read('launch.json');
  const exit = files.read('exit.json');
  if (launch === null || exit === null) return null;
  const start = Date.parse(launch.deadlineAt) - deadlineMs;
  return Math.max(0, Date.parse(exit.endedAt) - start) / 60_000;
}

/** The median duration in minutes of the ledger's runs of `keys` (their red and green runs); null when none was measured. */
export function medianLaneMinutes(runDir: AbsPath, view: JournalView, plan: PlanM1, keys: readonly FlakyKey[], deadlineMs: number): number | null {
  const wanted = new Set(keys.map(keyText));
  const invs = new Set<InvocationId>();
  for (const e of flakyLedger(view, plan)) if (wanted.has(keyText(e.key))) for (const ev of e.events) invs.add(ev.red).add(ev.green);
  const minutes = [...invs].flatMap((inv) => {
    const m = runMinutes(runDir, inv, deadlineMs);
    return m === null ? [] : [m];
  }).sort((a, b) => a - b);
  if (minutes.length === 0) return null;
  const mid = Math.floor(minutes.length / 2);
  return minutes.length % 2 === 1 ? minutes[mid]! : (minutes[mid - 1]! + minutes[mid]!) / 2;
}

/** The lane a deflake unit's keys name, as its spec or the plan defines it (null: an arc lane, defined by the obligations). */
function keyLaneDef(plan: PlanM1, spec: SpecM1, lane: LaneId): LaneDef | null {
  return spec.lanes.find((l) => l.id === lane) ?? plan.suite.lanes.find((l) => l.id === lane) ?? null;
}

/** What a lane's verification may cost: lane-minutes, or (a batch lane without its own entry) runs. */
export type VerificationCap = Readonly<{ type: 'minutes'; minutes: number }> | Readonly<{ type: 'runs'; runs: number }>;

export function verificationCap(plan: PlanM1, lane: LaneId, def: LaneDef | null): VerificationCap {
  const budget = plan.limits?.verification;
  const own = budget?.lanes?.[lane];
  if (own !== undefined) return { type: 'minutes', minutes: own };
  if (def?.cadence === 'batch') return { type: 'runs', runs: BATCH_VERIFICATION_RUNS };
  return { type: 'minutes', minutes: budget?.laneMinutes ?? DEFAULT_VERIFICATION_LANE_MINUTES };
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * Why an approving plan-check's design record of deflake unit `unit` is refused (see the header); empty for any other unit.
 * `design`: the record its answer carries (absent: none).
 */
export function verificationReasons(
  ctx: Readonly<{ runDir: AbsPath; journal: Readonly<{ view: JournalView }> }>, plan: PlanM1, unit: PlanUnit, spec: SpecM1, design: DesignRecord | undefined, deadlineMs: number,
): readonly string[] {
  if (unit.deflake === undefined) return [];
  // An answer without a design record is the design pass's to refuse; one with a record must give the verification.
  if (design === undefined) return [];
  const v: Verification | undefined = design.verification;
  if (v === undefined) {
    return [`deflake unit ${unit.id} approves only with its verification in the design record: reproduce-then-fix (the condition you induce fails the old tree and passes the new) or repeat with a rationale, and its runs`];
  }
  const reasons: string[] = [];
  if (v.type === 'repeat' && v.rationale.trim() === '') reasons.push('a repeat verification needs a rationale: why the flake cannot be induced and reproduced');
  const { lane } = unit.deflake.keys[0]!;
  const cap = verificationCap(plan, lane, keyLaneDef(plan, spec, lane));
  if (cap.type === 'runs') {
    if (v.runs > cap.runs) reasons.push(`verification of ${v.runs} runs of batch lane ${lane} is over its budget of ${cap.runs} runs`);
    return reasons;
  }
  const median = medianLaneMinutes(ctx.runDir, ctx.journal.view, plan, unit.deflake.keys, deadlineMs);
  if (median === null) return reasons;
  const cost = v.runs * median;
  if (cost > cap.minutes) {
    reasons.push(`verification of ${v.runs} runs of lane ${lane} costs ${fmt(cost)} lane-minutes (${v.runs} × the lane's median ${fmt(median)} minutes), over the verification budget of ${cap.minutes} lane-minutes`);
  }
  return reasons;
}

/**
 * The verification runs a deflake unit's lanes stage gives each lane of its keys (two or more; a spec or suite lane):
 * empty for any other unit, or for one verifying with a single run.
 */
export function verifyRunsOf(unit: PlanUnit, verification: Verification | null): ReadonlyMap<LaneId, number> {
  if (unit.deflake === undefined || verification === null || verification.runs < 2) return new Map();
  return new Map([[unit.deflake.keys[0]!.lane, verification.runs]]);
}

/** The text of a key, for items and spec seeds. */
export const keyLabel = (k: FlakyKey): string => (k.type === 'test' ? `test ${k.testId} of lane ${k.lane}` : `lane ${k.lane}`);

/** The ids of `flakes`' red and green runs, for an item's or a spec's facts. */
export const flakeRuns = (flakes: readonly FlakeAt[]): readonly string[] => flakes.map((x) => `${x.fact.event.red} red, then ${x.fact.event.green} green (tree ${x.fact.event.tree})`);
