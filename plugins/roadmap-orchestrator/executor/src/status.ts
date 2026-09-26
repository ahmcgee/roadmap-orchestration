// `roadmap status`: the M1 subset of DESIGN-1.0.md §2.4, as one agent-facing JSON object.
//
// Read only, from anywhere, while an executor runs or when none does: the log is folded without the host
// lock (`readJournal`: no tail repair, no fact, no cache write), and the run dir's files are only read.
// Nothing here names a model except `spend.byModel`, which looks each seat's model up in its revision's
// routing table at render time: the tables are re-resolved from the latest start's plan and repo config
// (`start.json`) under every built-in profile, and a revision none of them yields is listed as unresolved.
// `routing` is the routing the latest start's profile resolves to under the current repo config and plan,
// as classes per seat with the layer that named each and where each class's binding came from: no model.
//
// `run.state` (§2.10, M1 subset):
//   running    a live executor owns the run and nothing below holds it
//   parked     a live executor waits on a blocking needs-user nobody has acknowledged that holds the arc: an
//              arc-wide one, or one naming the unit that runs next, or any once no unit is left to run (the
//              executor's own rule, `holdsArc`); a unit-scoped park while later units run is `running`
//   held       a live executor waits on a pause, a held unit or a parked backend
//   refused    no live executor, and the latest start was refused (`rejection` says why)
//   complete   no live executor; every unit merged or parked, and no blocking needs-user open
//   no-owner   no live executor, and work remains
//
// `needsUser` lists every unacknowledged item: those the log raised, and the file-only ones outside it (the
// supervisor's `sup-<gen>-<n>`, a refused claim's `host-<kind>-<n>`), read from `needs-user/`; an item is
// acknowledged once the log holds its ack fact, as the executor reads it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { terminalReceipt, readCommand } from './commands/queue.ts';
import { JUDGMENT_STAGES, type JudgmentStage } from './core/events.ts';
import { readJson } from './core/fsx.ts';
import { type ArcId, type CommandId, type NeedsUserId, type RoutingRev, type UnitId, commandId } from './core/ids.ts';
import type { JournalView } from './core/interfaces.ts';
import { readJournal } from './core/log.ts';
import {
  type CommandBody, type ContainmentMode, type NeedsUserReason, type Receipt, type RunStart, type Stage, heartbeat, runStart,
} from './core/records.ts';
import type { AbsPath, IsoTime } from './core/values.ts';
import {
  HEARTBEAT_FILE, REJECTION_FILE, START_FILE, fileNeedsUser, holdsArc, nextUnit, openBlockingItems, recordOf,
} from './executor.ts';
import { type PlanM1, parsePlan } from './input/plan.ts';
import { type ModelTotal, type RoleTotal, byModel, meterOf } from './meter.ts';
import { readRepoConfig } from './preflight/checks.ts';
import { type RejectionFile, rejectionFile } from './preflight/startup.ts';
import { judgmentSeat } from './pipeline/transitions.ts';
import { type SeatSources, arcStack, resolveRouting } from './routing/layers.ts';
import {
  type Backend, type ClassSource, type ClassTable, type ModelClass, PROFILES, type ProfileName, type RiskTier, type SeatRef,
  type RoutingTable,
} from './routing/types.ts';
import { type OwnerState, ownerState } from './watch.ts';

export type ArcState = 'running' | 'held' | 'parked' | 'complete' | 'refused' | 'no-owner';

/**
 * Session containment's narrowed guarantee (plan "Runtime components"), stated as the plan states it. cgroup
 * mode is not selectable in M1 builds.
 */
export const SESSION_GUARANTEE = 'Every process that keeps ROADMAP_INV in its exec-time environment, or stays in the workload session, is '
  + 'stopped and killed before output is certified, resources are released or a stage advances. Not guaranteed: a descendant '
  + 'that calls setsid() and execs with a cleared environment; it may keep writing the original unit worktree, touch external '
  + 'resources, or write after every check. Partial backstops: the verification-tree dirty assertion and the occupancy probe. '
  + 'Original-worktree writes, external undeclared residue and delayed writes are not caught.';

export type UnitStatusLine = Readonly<{
  unit: UnitId;
  stage: Stage;
  status: string;
  attempts: number;
  chargeableFailures: number;
  risk: RiskTier | null;
  /** The seat the unit's current stage dispatches on, when that stage calls a backend and the unit is dispatched. */
  seat: SeatRef | null;
}>;

/** The routing in force for the latest start, as classes: never a model. */
export type RoutingView = Readonly<{
  profile: ProfileName;
  rev: RoutingRev;
  seats: ClassTable;
  sources: SeatSources;
  bindings: { readonly [C in ModelClass]: ClassSource };
}>;

export type Status = Readonly<{
  arc: ArcId;
  run: Readonly<{ state: ArcState; owner: OwnerState; heartbeatAt: IsoTime | null }>;
  units: readonly UnitStatusLine[];
  /** Raised and not acknowledged, ascending id: the log's items and the file-only `sup-*` / `host-*` ones. */
  needsUser: readonly Readonly<{ id: NeedsUserId; reason: NeedsUserReason; blocking: boolean }>[];
  commands: Readonly<{
    /** Submitted, no terminal receipt yet, in submission order. */
    pending: readonly Readonly<{ id: CommandId; type: CommandBody['type'] }>[];
    /** The latest terminal receipts, oldest first. */
    receipts: readonly Receipt[];
  }>;
  spend: Readonly<{
    byRole: readonly RoleTotal[];
    byModel: Readonly<{ models: readonly ModelTotal[]; unresolvedRevs: readonly RoutingRev[] }>;
  }>;
  host: Readonly<{ containment: Readonly<{ mode: ContainmentMode | null; guarantee: string }> }>;
  parkedBackends: readonly Backend[];
  /** Null before any start. */
  routing: RoutingView | null;
  rejection: RejectionFile | null;
}>;

/** How many terminal receipts `status` shows. */
export const RECEIPTS_SHOWN = 10;

const readIf = <T>(path: string, read: (value: unknown, path: string) => T): T | null => (existsSync(path) ? read(readJson(path), path) : null);

function seatOf(view: JournalView, unit: UnitId): UnitStatusLine['seat'] {
  const u = view.unit(unit);
  if (u.risk === null) return null;
  if ((JUDGMENT_STAGES as readonly string[]).includes(u.stage)) {
    const stage = u.stage as JudgmentStage;
    return { role: stage === 'plan-check' ? 'planCheck' : 'gate', tier: judgmentSeat(u, stage) };
  }
  return u.stage === 'build' ? { role: 'build', tier: u.risk } : null;
}

function commandsOf(runDir: AbsPath, arc: ArcId): Status['commands'] {
  const dir = join(runDir, 'commands', 'incoming');
  const ids = existsSync(dir) ? readdirSync(dir).flatMap((n) => (/^cmd-[0-9a-f]{16}\.json$/.test(n) ? [commandId(n.slice(0, -5))] : [])).sort() : [];
  const pending: { id: CommandId; type: CommandBody['type'] }[] = [];
  const receipts: Receipt[] = [];
  for (const id of ids) {
    const r = terminalReceipt(runDir, id);
    if (r === null) pending.push({ id, type: readCommand(runDir, id, arc).file.body.type });
    else receipts.push(r);
  }
  return { pending, receipts: receipts.slice(-RECEIPTS_SHOWN) };
}

/** Every built-in profile's table over the latest start's plan and repo config, by revision. */
function routingTables(start: Readonly<{ record: RunStart; plan: PlanM1 }> | null): ReadonlyMap<RoutingRev, RoutingTable> {
  if (start === null) return new Map();
  const { record, plan } = start;
  const config = readRepoConfig(record.repo);
  return new Map(PROFILES.map((profile) => {
    const r = resolveRouting(arcStack(profile, config, plan.routing ?? null));
    return [r.rev, r.table] as const;
  }));
}

function routingView(start: Readonly<{ record: RunStart; plan: PlanM1 }> | null): RoutingView | null {
  if (start === null) return null;
  const r = resolveRouting(arcStack(start.record.profile, readRepoConfig(start.record.repo), start.plan.routing ?? null));
  return { profile: start.record.profile, rev: r.rev, seats: r.classes, sources: r.sources, bindings: r.bindings };
}

function stateOf(runDir: AbsPath, view: JournalView, units: readonly UnitId[], owner: OwnerState, rejection: RejectionFile | null): ArcState {
  const open = openBlockingItems(runDir, view);
  const blocking = open.length > 0;
  if (owner.state === 'alive') {
    const next = nextUnit(units, view);
    if (open.some((id) => holdsArc(recordOf(runDir, id), next))) return 'parked';
    const c = view.control();
    const held = c.pausedAll || c.pausedUnits.length > 0 || view.parkedBackends().length > 0 || units.some((u) => view.unit(u).status === 'held');
    return held ? 'held' : 'running';
  }
  if (rejection !== null) return 'refused';
  const settled = units.length > 0 && units.every((u) => ['retired', 'park-pending'].includes(view.unit(u).status));
  return settled && !blocking ? 'complete' : 'no-owner';
}

export function status(runDir: AbsPath, arc: ArcId, hostDir: AbsPath): Status {
  const { view, events } = readJournal(runDir, arc);
  const record = readIf(join(runDir, START_FILE), runStart);
  const start = record === null ? null : { record, plan: parsePlan(JSON.parse(readFileSync(record.planFile, 'utf8'))) };
  const units = start?.plan.units.map((u) => u.id) ?? [];
  const rejection = readIf(join(runDir, REJECTION_FILE), rejectionFile);
  const owner = ownerState(runDir, hostDir);

  const meter = meterOf(events);
  const tables = routingTables(start);
  const resolvable = meter.bySeat.filter((t) => tables.has(t.routingRev));
  const unresolvedRevs = [...new Set(meter.bySeat.filter((t) => !tables.has(t.routingRev)).map((t) => t.routingRev))].sort();

  return {
    arc,
    run: { state: stateOf(runDir, view, units, owner, rejection), owner, heartbeatAt: readIf(join(runDir, HEARTBEAT_FILE), heartbeat)?.at ?? null },
    units: units.map((id) => {
      const u = view.unit(id);
      return { unit: id, stage: u.stage, status: u.status, attempts: u.counters.attempts, chargeableFailures: u.counters.chargeableFailures, risk: u.risk, seat: seatOf(view, id) };
    }),
    needsUser: [
      ...view.needsUser().filter((n) => n.ack === null).map((n) => ({ id: n.id, reason: recordOf(runDir, n.id).reason, blocking: n.blocking })),
      ...fileNeedsUser(runDir, view).map((r) => ({ id: r.id, reason: r.reason, blocking: r.blocking })),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    commands: commandsOf(runDir, arc),
    spend: { byRole: meter.byRole, byModel: { models: byModel(resolvable, tables), unresolvedRevs } },
    host: { containment: { mode: view.containmentMode(), guarantee: SESSION_GUARANTEE } },
    parkedBackends: view.parkedBackends(),
    routing: routingView(start),
    rejection,
  };
}
