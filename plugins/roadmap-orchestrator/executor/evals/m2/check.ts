// The M2 paid fixture, step 3: `node evals/m2/check.ts <dir>` grades a finished run (setup → driver) from the
// log, the repo, the run and host dirs, the pool's instance dirs and report.json. Agent-facing output: one JSON
// line `{pass, criteria[{name, pass, detail}], notExercised[], cannotShow[]}`, then the two lists as lines.
// Exits 1 when any criterion fails.
//
// M2 criteria (plan "Fixture evals/m2/"):
//   no-overlap           replaying every resource.transition: no unit is reserved or reclaimed while another
//                        holder has it or its residue is undisposed; no pool instance beyond the pool's size, no
//                        `@cpu` token beyond plan.capacity.cpu (so neither pool is ever over its size)
//   single-owner         every instance dir's history.log (estate.ts) shows one owner at a time, no conflict
//   aging                the graded property (F17): folding the log event by event, every grant made while a
//                        waiter U is promoted, of a resource U waits for, goes to a unit promoted before U
//                        (older by `compareRank`). Vacuous when no waiter was promoted (listed not exercised)
//   cleanup-survival     a cleanup failed on the live path and one in recovery's cleanup of a killed holder; each
//                        residue: on the live path its stage parked retryable on that instance, in recovery its
//                        killed attempt has no outcome; the residue's attempt's `retry` holder reclaimed and
//                        released it, a probe pass covers the park (live) or the residue's fail seq (recovery),
//                        the host index disposes it `cleaned`, the unit ran the stage again and merged (or its
//                        lineage did); nothing is left undisposed or cleanup-failed; the respawn after the driver's
//                        SIGKILL started (executor-started of its generation) and was not refused
//   reentry              the driver's merge-tree conflict; `right2` re-entered `right` (plan-applied), prepared
//                        `conflicted`, ran its resolve round as a fresh session, merged with both registrations
//                        on the shared line; `right` superseded; `right2` took `right`'s counters as they were;
//                        `top` dispatched only after `right2` published, and merged
//   no-duplicate-writer  per unit, its backend and lane invocations never overlap (from each op's first intent
//                        to its done); each stage attempt has at most one outcome and consumed at most one
//                        successful backend result
// M1 criteria (evals/m1/check.ts, over this run):
//   run-ended, units-settled (every unit merged, or superseded by a merged unit), head-is-candidate,
//   diff-product-only, snapshot-verifies, judgment-fresh, meter-covers-calls, no-model-ids
//
// The non-exercised list names what this run's journal shows no trace of, from: flake, host signature, D4
// escalation, backend capacity park, backend outage park, aging promotion. Each has a fake integrated test in
// `npm test`; this run is evidence only for what it took.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { type Event, type Fact, type Holder, type IntentOf, prevHash, parseEventLine, probeTargetKey } from '../../src/core/events.ts';
import { type ArcId, type OpId, type UnitId, arcId, invocationId, parseOpId, unitId } from '../../src/core/ids.ts';
import type { JournalView } from '../../src/core/interfaces.ts';
import { canonicalJson } from '../../src/core/json.ts';
import { readJournal } from '../../src/core/log.ts';
import { RUNNER_FILE_READERS, type ResultFile } from '../../src/core/records.ts';
import { Fold } from '../../src/core/state.ts';
import { type AbsPath, absPath, repoPath } from '../../src/core/values.ts';
import { REJECTION_FILE } from '../../src/executor.ts';
import { candidateRef } from '../../src/git/candidate.ts';
import { git, refTarget, revParse } from '../../src/git/git.ts';
import { snapshotRef, verifySnapshot } from '../../src/git/snapshot.ts';
import { transientViolations } from '../../src/git/transient.ts';
import { outputSignatures } from '../../src/host/signatures.ts';
import { readResidues, undispositioned } from '../../src/host/residues.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import { type PlanM1, parsePlan } from '../../src/input/plan.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { resourceTable } from '../../src/resources/reserve.ts';
import { MODEL_IDS } from '../../src/routing/types.ts';
import { effectiveDependency } from '../../src/schedule/graph.ts';
import { nextStage, rankOf } from '../../src/schedule/ready.ts';
import { type Rank, compareRank } from '../../src/schedule/types.ts';
import { loadSpec } from '../../src/spec/spec.ts';
import type { Report } from './driver.ts';
import { CPU_CAPACITY, MAIN, POOL, POOL_SIZE, REENTRY, SHARED_FILE, layout } from './layout.ts';

type Verdict = Readonly<{ pass: boolean; detail: string }>;
export type Criterion = Readonly<{ name: string }> & Verdict;
export type CheckResult = Readonly<{ pass: boolean; criteria: readonly Criterion[]; notExercised: readonly Branch[]; cannotShow: readonly string[] }>;

/** What a real run may leave untaken, in the order the report lists them. */
export const BRANCHES = ['flake', 'host signature', 'D4 escalation', 'backend capacity park', 'backend outage park', 'aging promotion'] as const;
export type Branch = (typeof BRANCHES)[number];

export const CANNOT_SHOW = ['real cgroup containment', 'crash boundaries under real models', 'usage-limit hits under parallel burn', 'week-long reliability'] as const;

type Run = Readonly<{
  repo: AbsPath;
  input: string;
  runDir: AbsPath;
  hostDir: AbsPath;
  estate: string;
  arc: ArcId;
  plan: PlanM1;
  report: Report;
  events: readonly Event[];
  view: JournalView;
}>;

const facts = (run: Run): readonly Fact[] => run.events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const factsOf = <K extends Fact['kind']>(run: Run, kind: K): readonly (Extract<Fact, { kind: K }> & { seq: number })[] =>
  run.events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [{ ...(e.fact as Extract<Fact, { kind: K }>), seq: e.seq }] : []));
const transitions = (run: Run) => run.events.flatMap((e) => (e.type === 'intent' && e.kind === 'resource.transition' ? [e] : []));
const spawnIntents = (run: Run) => run.events.flatMap((e) => (e.type === 'intent' && e.kind === 'proc.spawn' ? [e] : []));
const outcomes = (run: Run) => factsOf(run, 'stage-outcome');

/**
 * Folds the run's log event by event, calling `visit` with each event and the view as it stood just before
 * it (what the executor decided on).
 */
function replay(run: Run, visit: (event: Event, before: JournalView) => void): void {
  const fold = new Fold(run.arc);
  for (const line of readFileSync(join(run.runDir, 'events.jsonl'), 'utf8').split('\n')) {
    if (line === '') continue;
    const event = parseEventLine(line);
    visit(event, fold);
    fold.apply(event, prevHash(Buffer.from(`${line}\n`)));
  }
}

// ---------------------------------------------------------------------------------------------------
// M2 criteria

/** Every resource unit's holder over the log; problems where a grant finds it taken. */
function noOverlap(run: Run): Verdict {
  const state = new Map<string, string>();
  const problems: string[] = [];
  let maxPool = 0;
  let maxCpu = 0;
  const cpuCap = run.plan.capacity?.cpu ?? CPU_CAPACITY;
  for (const i of transitions(run)) {
    const holder = canonicalJson(i.expect.holder);
    const edge = i.expect.edge;
    for (const u of i.expect.resources) {
      const now = state.get(u) ?? 'free';
      const instance = /^(.+)#([0-9]+)$/.exec(u);
      if (instance !== null && instance[1] === POOL && Number(instance[2]) > POOL_SIZE) problems.push(`${u} is beyond the pool's size ${POOL_SIZE}`);
      if (instance !== null && instance[1] === '@cpu' && Number(instance[2]) > cpuCap) problems.push(`${u} is beyond the @cpu pool's size ${cpuCap}`);
      switch (edge.type) {
        case 'reserve':
          if (now !== 'free') problems.push(`seq ${i.seq}: ${u} reserved by ${holder} while ${now}`);
          state.set(u, holder);
          break;
        case 'reclaim':
          if (now !== 'cleanup-failed') problems.push(`seq ${i.seq}: ${u} reclaimed by ${holder} while ${now}`);
          state.set(u, holder);
          break;
        case 'fail':
          if (now !== holder) problems.push(`seq ${i.seq}: ${u} failed by ${holder}, which does not hold it (${now})`);
          state.set(u, 'cleanup-failed');
          break;
        case 'release':
          if (now !== holder) problems.push(`seq ${i.seq}: ${u} released by ${holder}, which does not hold it (${now})`);
          state.set(u, 'free');
          break;
        case 'run':
        case 'clean':
          if (now !== holder) problems.push(`seq ${i.seq}: ${u} ${edge.type} by ${holder}, which does not hold it (${now})`);
          break;
      }
    }
    const held = [...state.entries()].filter(([, s]) => s !== 'free');
    maxPool = Math.max(maxPool, held.filter(([u]) => u.startsWith(`${POOL}#`)).length);
    maxCpu = Math.max(maxCpu, held.filter(([u]) => u.startsWith('@cpu#')).length);
  }
  const left = [...state.entries()].filter(([, s]) => s !== 'free').map(([u, s]) => `${u} ${s}`);
  if (left.length > 0) problems.push(`not free at the end: ${left.join(', ')}`);
  return {
    pass: problems.length === 0 && maxPool === POOL_SIZE,
    detail: problems.length > 0 ? problems.join('; ') : `${POOL} at most ${maxPool}/${POOL_SIZE} in use (both instances at once: ${maxPool === POOL_SIZE}); @cpu at most ${maxCpu}/${cpuCap}`,
  };
}

function singleOwner(run: Run): Verdict {
  const problems: string[] = [];
  const lines: string[] = [];
  for (let n = 1; n <= POOL_SIZE; n++) {
    const path = join(run.estate, `${POOL}#${n}`, 'history.log');
    const history = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l !== '') : [];
    let owner: string | null = null;
    let owners = 0;
    for (const line of history) {
      const [event, label] = line.split(' ') as [string, string];
      if (event === 'enter') {
        if (owner !== null) problems.push(`${POOL}#${n}: ${label} entered while ${owner} held it`);
        owner = label;
        owners += 1;
      } else if (event === 'leave') {
        if (owner !== label) problems.push(`${POOL}#${n}: ${label} left, but ${owner} held it`);
        owner = null;
      } else if (event.startsWith('conflict:')) {
        problems.push(`${POOL}#${n}: ${label} found it held by ${event.slice('conflict:'.length)}`);
      } else if (event !== 'teardown-failed') {
        throw new Error(`${path}: unknown event ${JSON.stringify(line)}`);
      }
    }
    if (owner !== null) problems.push(`${POOL}#${n}: ${owner} never left`);
    lines.push(`${POOL}#${n}: ${owners} holds`);
  }
  return { pass: problems.length === 0, detail: problems.length > 0 ? problems.join('; ') : lines.join(', ') };
}

/** The resource kind a waiter's next stage requests first: the integration slot for a candidate, else `@cpu`. */
const requestKind = (stage: string): string => (stage === 'candidate' ? 'integration-slot' : '@cpu');
const kindOf = (u: string): string => (u.startsWith('@cpu#') ? '@cpu' : u);

/** Whether `unit` waits for its entry reservation in `view`: active, admissible, its dependencies met, not granted yet. */
function waiting(view: JournalView, plan: PlanM1, id: UnitId, granted: ReadonlyMap<UnitId, number>, rank: Rank): string | null {
  const u = view.unit(id);
  if (u.status !== 'active' || u.open !== null) return null;
  const next = nextStage(u);
  if (next === null || next.kind !== 'admission' || next.stage === 'prepare') return null;
  const control = view.control();
  if (control.pausedAll || control.pausedUnits.includes(id)) return null;
  const only = view.runOnly();
  if (only !== null && !only.includes(id)) return null;
  const unit = plan.units.find((p) => p.id === id);
  if (unit === undefined) return null;
  if (!unit.after.every((d) => view.unit(effectiveDependency(view, d)).status === 'retired')) return null;
  if (!unit.contingent.every((e) => view.edgeResolved(e.id) !== null)) return null;
  if ((granted.get(id) ?? 0) > rank.waitStartSeq) return null;
  return next.stage;
}

function aging(run: Run): Readonly<Verdict & { promoted: number }> {
  const granted = new Map<UnitId, number>();
  const problems: string[] = [];
  let checked = 0;
  let promoted = 0;
  replay(run, (e, view) => {
    if (e.type !== 'intent' || e.kind !== 'resource.transition' || e.expect.edge.type !== 'reserve') return;
    const holder: Holder = e.expect.holder;
    if (holder.type !== 'stage' && holder.type !== 'publication') return;
    const plan = requirePlanInForce(run.runDir, view).plan;
    const to = rankOf(view, plan, holder.unit);
    const kinds = new Set(e.expect.resources.map(kindOf));
    for (const unit of plan.units) {
      if (unit.id === holder.unit) continue;
      const rank = rankOf(view, plan, unit.id);
      const stage = waiting(view, plan, unit.id, granted, rank);
      if (stage === null || !kinds.has(requestKind(stage))) continue;
      checked += 1;
      if (!rank.promoted) continue;
      promoted += 1;
      if (!to.promoted || compareRank(to, rank) >= 0) {
        problems.push(`seq ${e.seq}: ${e.expect.resources.join(',')} granted to ${holder.unit} (${JSON.stringify(to)}) while ${unit.id} waited promoted (${JSON.stringify(rank)})`);
      }
    }
    granted.set(holder.unit, e.seq);
  });
  const detail = problems.length > 0
    ? problems.join('; ')
    : promoted === 0 ? `vacuous: ${checked} grants passed a waiter, none promoted` : `${promoted} grants passed a promoted waiter, each to an older promoted unit (${checked} checked)`;
  return { pass: problems.length === 0, detail, promoted };
}

function cleanupSurvival(run: Run): Verdict {
  const problems: string[] = [];
  const lines: string[] = [];
  const all = transitions(run);
  const fails = all.filter((i) => i.expect.edge.type === 'fail');
  const residues = readResidues(run.hostDir);
  const paths = { live: 0, recovery: 0 };
  for (const f of fails) {
    const holder = f.expect.holder;
    if (holder.type !== 'stage' || f.expect.edge.type !== 'fail') {
      problems.push(`seq ${f.seq}: a cleanup of ${canonicalJson(holder)} failed, which is no stage's (a residue no probe reclaims)`);
      continue;
    }
    // The live path parks the attempt on the instance; recovery's cleanup of a killed holder (parent arc) parks
    // nothing, and the residue is probed on its own (covered by its fail seq).
    const path = f.parent.type === 'arc' ? 'recovery' : 'live';
    paths[path]++;
    const park = outcomes(run).find((o) => o.unit === holder.unit && o.stage === holder.stage && o.attempt === holder.attempt);
    for (const r of f.expect.edge.residues) {
      const where = `${path} ${holder.unit} ${holder.stage} ${holder.attempt} ${r.resource}`;
      let covered: number;
      if (path === 'live') {
        if (park?.outcome !== 'cleanup-failed' || park.park?.class !== 'retryable' || !park.park.targets.some((t) => t.type === 'resource' && t.instance === r.resource)) {
          problems.push(`${where}: the attempt did not park retryable on ${r.resource} (${JSON.stringify(park)})`);
          continue;
        }
        covered = park.seq;
      } else {
        if (park !== undefined) problems.push(`${where}: the killed attempt has an outcome (${JSON.stringify(park)})`);
        covered = parseOpId(f.op).seq;
      }
      const retry = all.filter((i) => i.seq > f.seq && i.expect.holder.type === 'retry' && i.expect.resources.includes(r.resource));
      if (retry.some((i) => canonicalJson(i.expect.holder) !== canonicalJson({ ...holder, type: 'retry' }))) {
        problems.push(`${where}: reclaimed under ${retry.map((i) => canonicalJson(i.expect.holder)).join(', ')}, not the residue's attempt`);
      }
      const edges = retry.map((i) => i.expect.edge.type);
      if (edges[0] !== 'reclaim' || !edges.includes('release')) problems.push(`${where}: the retry holder's edges are ${edges.join(', ') || 'none'}, not reclaim … release`);
      const pass = factsOf(run, 'probe').find((p) => p.result === 'pass' && probeTargetKey(p.target) === `resource:${r.resource}` && p.covers.includes(covered));
      if (pass === undefined) problems.push(`${where}: no passing probe covers seq ${covered}`);
      const cleaned = residues.some((d) => d.type === 'disposition' && d.disposition === 'cleaned' && d.key.arc === run.arc && d.key.resource === r.resource && d.key.inv === r.teardown);
      if (!cleaned) problems.push(`${where}: the host index never disposed residue ${r.teardown} cleaned`);
      const again = outcomes(run).find((o) => o.unit === holder.unit && o.stage === holder.stage && o.attempt > holder.attempt);
      if (again === undefined) problems.push(`${where}: the unit never ran ${holder.stage} again`);
      const merged = run.view.unit(holder.unit).status === 'retired' || run.view.unit(run.view.unit(holder.unit).supersededBy ?? holder.unit).status === 'retired';
      if (!merged) problems.push(`${where}: the unit did not merge`);
      lines.push(`${where}: ${path === 'live' ? 'parked' : 'failed'} seq ${covered}, probe pass seq ${pass?.seq}, re-ran as ${again?.stage} ${again?.attempt} (${again?.outcome})`);
    }
  }
  if (paths.live === 0) problems.push('no cleanup failed on the live path: the teardown device did not fire');
  if (paths.recovery === 0) problems.push('no cleanup failed in recovery: the respawn device did not fire');
  const undisposed = undispositioned(run.hostDir).filter((k) => k.arc === run.arc);
  if (undisposed.length > 0) problems.push(`undisposed residues at the end: ${undisposed.map((k) => `${k.unit} ${k.resource} ${k.inv}`).join(', ')}`);
  const dirty = [...resourceTable(run.view).entries()].filter(([, e]) => e.status.state === 'cleanup-failed').map(([u]) => u);
  if (dirty.length > 0) problems.push(`cleanup-failed at the end: ${dirty.join(', ')}`);
  const { kill, respawn } = run.report.devices;
  if (kill === null || respawn === null) problems.push('the driver never killed the executor, or never saw its respawn');
  else {
    const started = factsOf(run, 'executor-started').some((f) => f.generation === respawn.generation);
    if (!started) problems.push(`no executor-started for the respawned generation ${respawn.generation}`);
    if (existsSync(join(run.runDir, REJECTION_FILE))) problems.push(`${REJECTION_FILE} exists: a start was refused`);
    lines.push(`generation ${kill.generation} killed, ${respawn.generation} respawned`);
  }
  return { pass: problems.length === 0, detail: [...problems, ...lines].join('; ') };
}

function reentry(run: Run): Verdict {
  const problems: string[] = [];
  const right = unitId('right');
  const right2 = unitId(REENTRY);
  const mt = run.report.devices.mergeTree;
  if (mt === null || !mt.conflict || !mt.paths.includes(SHARED_FILE)) problems.push(`the driver saw no conflict on ${SHARED_FILE}: ${JSON.stringify(mt)}`);
  // The device's order: run-only kept `urgent` out from the first dispatch until `right` was held.
  const only = factsOf(run, 'run-only');
  const firstWork = Math.min(...[...factsOf(run, 'dispatch'), ...transitions(run)].map((e) => e.seq));
  if (only[0] === undefined || only[0].seq > firstWork || only[0].units?.includes(unitId('urgent')) !== false) problems.push(`the first run-only ${JSON.stringify(only[0])} did not keep urgent out before seq ${firstWork}`);
  const joined = only.find((f) => f.units?.includes(unitId('urgent')));
  const urgentFirst = Math.min(...[
    ...factsOf(run, 'dispatch').filter((f) => f.record.unit === 'urgent'),
    ...transitions(run).filter((i) => 'unit' in i.expect.holder && i.expect.holder.unit === 'urgent'),
  ].map((e) => e.seq));
  const held = outcomes(run).find((o) => o.unit === right && o.class === 'hold');
  if (held === undefined || joined === undefined || !(held.seq < joined.seq && joined.seq < urgentFirst)) {
    problems.push(`urgent's first work (seq ${urgentFirst}) is not after right was held (seq ${held?.seq}) and urgent joined run-only (seq ${joined?.seq})`);
  }
  const applied = factsOf(run, 'plan-applied').find((f) => f.changes.some((c) => c.type === 'unit-reentered' && c.unit === right2 && c.reenters === right));
  if (applied === undefined) problems.push(`no plan-applied re-enters ${right} as ${right2}`);
  const prepared = outcomes(run).find((o) => o.unit === right2 && o.stage === 'prepare');
  if (prepared?.outcome !== 'conflicted') problems.push(`${right2}'s preparation was ${prepared?.outcome ?? 'never recorded'}, not conflicted`);
  const resolve = spawnIntents(run).find((i) => i.parent.type === 'stage' && i.parent.unit === right2 && i.parent.stage === 'build' && i.expect.subject.purpose === 'backend');
  if (resolve === undefined) problems.push(`${right2} ran no resolve round`);
  else {
    const t = launchOf(run, resolve).launch.terminal;
    if (t.type !== 'backend' || t.session.mode !== 'fresh') problems.push(`${right2}'s resolve round is not a fresh session: ${JSON.stringify(t)}`);
  }
  if (run.view.unit(right).status !== 'superseded' || run.view.unit(right).supersededBy !== right2) problems.push(`${right} is ${run.view.unit(right).status}, not superseded by ${right2}`);
  if (run.view.unit(right2).status !== 'retired') problems.push(`${right2} is ${run.view.unit(right2).status}, not merged`);
  const line = git(run.repo, ['show', `refs/heads/${run.plan.integrationBranch}:${SHARED_FILE}`]);
  if (!line.includes("'urgent'") || !line.includes("'right'")) problems.push(`integration's ${SHARED_FILE} does not hold both registrations: ${JSON.stringify(line)}`);
  // The lineage's counters: right's just before the re-entry is applied, right2's just after.
  let inherited: string | null = null;
  if (applied !== undefined) {
    let before: string | null = null;
    replay(run, (e, view) => {
      if (e.seq === applied.seq) before = canonicalJson(view.unit(right).counters);
      if (e.seq === applied.seq + 1) {
        const after = canonicalJson(view.unit(right2).counters);
        inherited = after;
        if (after !== before) problems.push(`${right2}'s counters ${after} are not ${right}'s ${before} at the re-entry`);
      }
    });
    const lineage = run.view.unit(right2).lineage;
    if (lineage?.root !== right || lineage.reenters !== right || !lineage.prepared) problems.push(`${right2}'s lineage is ${JSON.stringify(lineage)}`);
  }
  const published = run.events.find((e) => e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'published' && ffIntent(run, e.op).parent.type === 'stage'
    && (ffIntent(run, e.op).parent as { unit: string }).unit === right2);
  const topDispatch = factsOf(run, 'dispatch').find((f) => f.record.unit === 'top');
  if (published === undefined || topDispatch === undefined || topDispatch.seq < published.seq) {
    problems.push(`top dispatched at seq ${topDispatch?.seq} before ${right2} published (seq ${published?.seq})`);
  }
  if (run.view.unit(unitId('top')).status !== 'retired') problems.push('top did not merge');
  return {
    pass: problems.length === 0,
    detail: problems.length > 0 ? problems.join('; ') : `${right2} prepared conflicted on ${SHARED_FILE}, resolved fresh, merged; counters ${inherited} inherited; top dispatched at seq ${topDispatch?.seq} after ${right2} published at ${published?.seq}`,
  };
}

function noDuplicateWriter(run: Run): Verdict {
  const problems: string[] = [];
  const done = new Map<OpId, number>();
  for (const e of run.events) if (e.type === 'done' && e.kind === 'proc.spawn') done.set(e.op, e.seq);
  const intervals = new Map<string, { op: OpId; from: number; to: number }[]>();
  for (const i of spawnIntents(run)) {
    const s = i.expect.subject;
    if ((s.purpose !== 'backend' && s.purpose !== 'lane') || i.parent.type !== 'stage') continue;
    const list = intervals.get(i.parent.unit) ?? [];
    const found = list.find((x) => x.op === i.op);
    const to = done.get(i.op) ?? Number.POSITIVE_INFINITY;
    if (found === undefined) list.push({ op: i.op, from: i.seq, to });
    intervals.set(i.parent.unit, list);
  }
  let count = 0;
  for (const [unit, list] of intervals) {
    count += list.length;
    const sorted = [...list].sort((a, b) => a.from - b.from);
    sorted.forEach((x, k) => {
      const next = sorted[k + 1];
      if (next !== undefined && next.from < x.to) problems.push(`${unit}: ${x.op} (seq ${x.from}..${x.to}) overlaps ${next.op} (from seq ${next.from})`);
    });
  }
  const perAttempt = new Map<string, number>();
  for (const o of outcomes(run)) {
    const key = `${o.unit} ${o.stage} ${o.attempt}`;
    perAttempt.set(key, (perAttempt.get(key) ?? 0) + 1);
  }
  for (const [key, n] of perAttempt) if (n > 1) problems.push(`${key}: ${n} stage outcomes`);
  const successes = new Map<string, number>();
  for (const i of spawnIntents(run)) {
    if (i.expect.subject.purpose !== 'backend' || i.parent.type !== 'stage') continue;
    const result = resultOf(run, i);
    if (result === null || result.type !== 'backend' || result.outcome.kind !== 'success') continue;
    const key = `${i.parent.unit} ${i.parent.stage} ${i.parent.attempt}`;
    successes.set(key, (successes.get(key) ?? 0) + 1);
  }
  for (const [key, n] of successes) if (n > 1) problems.push(`${key}: ${n} successful backend results`);
  return { pass: problems.length === 0 && count > 0, detail: problems.length > 0 ? problems.join('; ') : `${count} workload ops over ${intervals.size} units, disjoint per unit; ${perAttempt.size} attempts, one outcome and at most one result each` };
}

// ---------------------------------------------------------------------------------------------------
// M1 criteria over this run

function runEnded(run: Run): Verdict {
  const { endedBy, start, generation, exit } = run.report;
  const pass = endedBy === 'exit' && start.code === 0 && exit !== null && exit.kind === 'complete';
  return { pass, detail: `endedBy=${endedBy} start=${start.code} generation=${generation} reason=${JSON.stringify(exit)}${run.report.devices.failed === null ? '' : ` device failed: ${run.report.devices.failed}`}` };
}

function unitsSettled(run: Run): Verdict {
  const problems: string[] = [];
  const lines: string[] = [];
  for (const unit of run.plan.units) {
    const u = run.view.unit(unit.id);
    if (u.status === 'retired') lines.push(`${unit.id} merged`);
    else if (u.status === 'superseded' && u.supersededBy !== null && run.view.unit(u.supersededBy).status === 'retired') lines.push(`${unit.id} superseded by ${u.supersededBy}`);
    else problems.push(`${unit.id}: ${u.status} at ${u.stage}`);
  }
  return { pass: problems.length === 0, detail: [...problems, ...lines].join('; ') };
}

function ffIntent(run: Run, op: OpId): IntentOf<'integration.ff'> {
  const found = run.events.flatMap((e) => (e.type === 'intent' && e.kind === 'integration.ff' && e.op === op ? [e] : [])).at(-1);
  if (found === undefined) throw new Error(`no integration.ff intent for ${op}`);
  return found;
}

function headIsCandidate(run: Run): Verdict {
  const integration = revParse(run.repo, `refs/heads/${run.plan.integrationBranch}`);
  const last = run.events.flatMap((e) => (e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'published' ? [e] : [])).at(-1);
  if (last === undefined) return { pass: false, detail: `nothing published; integration at ${integration}` };
  const ff = ffIntent(run, last.op);
  if (ff.parent.type !== 'stage') return { pass: false, detail: `the ff ${ff.op} has no stage parent` };
  const unit = ff.parent.unit;
  const approval = facts(run).filter((f) => f.kind === 'approval' && f.unit === unit).at(-1);
  if (approval === undefined || approval.kind !== 'approval') return { pass: false, detail: `no approval fact for ${unit}` };
  const problems: string[] = [];
  if (integration !== ff.expect.new) problems.push(`integration ${integration} is not the published candidate ${ff.expect.new}`);
  if (revParse(run.repo, `${integration}^1`) !== ff.expect.old) problems.push(`head^1 is not T ${ff.expect.old}`);
  const second = revParse(run.repo, `${integration}^2`);
  if (second !== approval.fingerprint.unitCommit) problems.push(`head^2 ${second} is not the approved unit commit ${approval.fingerprint.unitCommit}`);
  if (revParse(run.repo, `${integration}^{tree}`) !== revParse(run.repo, `${candidateRef(run.arc, unit)}^{tree}`)) problems.push('head tree is not the candidate ref\'s tree');
  return { pass: problems.length === 0, detail: problems.length > 0 ? problems.join('; ') : `integration ${integration} = candidate of ${unit}, second parent ${second}` };
}

function diffProductOnly(run: Run): Verdict {
  const out = git(run.repo, ['diff', '--name-only', '-z', `${MAIN}...${run.plan.integrationBranch}`]);
  const paths = out.split('\0').filter((p) => p !== '').map((p) => repoPath(p));
  const evidenceGlobs = run.plan.units.flatMap((u) => loadSpec(absPath(join(run.input, u.spec))).lanes.flatMap((l) => l.evidenceGlobs));
  const violations = transientViolations({ evidenceGlobs }, paths);
  return { pass: violations.length === 0, detail: violations.length > 0 ? violations.map((v) => `${v.path} (${v.rule})`).join(', ') : `${paths.length} product paths: ${paths.join(', ')}` };
}

function snapshotVerifies(run: Run): Verdict {
  const ref = snapshotRef(run.arc);
  const at = refTarget(run.repo, ref);
  const lastFf = run.events.filter((e) => e.type === 'done' && e.kind === 'integration.ff').at(-1);
  if (at === null) return { pass: false, detail: `${ref} is absent` };
  const v = verifySnapshot(run.repo, at);
  if (v.kind !== 'verified') return { pass: false, detail: `${ref} at ${at}: ${v.detail}` };
  const floor = lastFf?.seq ?? 0;
  return { pass: v.manifest.highWater >= floor, detail: `${ref} at ${at}: high-water ${v.manifest.highWater}, last integration.ff done at seq ${floor}` };
}

const JUDGMENT_ROLES: ReadonlySet<string> = new Set(['planCheck', 'gate']);

function backendRole(i: IntentOf<'proc.spawn'>): string | null {
  const s = i.expect.subject;
  if (s.purpose === 'backend') return s.role;
  if (s.purpose === 'smoke' && s.target.type === 'backend') return s.target.role;
  return null;
}

function launchOf(run: Run, i: IntentOf<'proc.spawn'>) {
  const inv = invocationId(i.op, i.ordinal);
  const path = join(invocationDir(run.runDir, inv), 'launch.json');
  return { inv, launch: RUNNER_FILE_READERS['launch.json'](JSON.parse(readFileSync(path, 'utf8')), path) };
}

function resultOf(run: Run, i: IntentOf<'proc.spawn'>): ResultFile | null {
  const path = join(invocationDir(run.runDir, invocationId(i.op, i.ordinal)), 'result.json');
  return existsSync(path) ? RUNNER_FILE_READERS['result.json'](JSON.parse(readFileSync(path, 'utf8')), path) : null;
}

function judgmentFresh(run: Run): Verdict {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const i of spawnIntents(run)) {
    const role = backendRole(i);
    if (role === null || !JUDGMENT_ROLES.has(role)) continue;
    const { inv, launch } = launchOf(run, i);
    if (launch.argv.includes('--resume')) problems.push(`${inv}: judgment argv resumes`);
    const t = launch.terminal;
    if (t.type !== 'backend' || t.session.mode !== 'fresh' || !('id' in t.session)) {
      problems.push(`${inv}: judgment session is not a fresh named session`);
      continue;
    }
    const other = seen.get(t.session.id);
    if (other !== undefined) problems.push(`${inv} reuses session ${t.session.id} of ${other}`);
    seen.set(t.session.id, inv);
  }
  return { pass: problems.length === 0 && seen.size > 0, detail: problems.length > 0 ? problems.join('; ') : `${seen.size} judgment invocations, ${seen.size} distinct fresh sessions` };
}

function meterCoversCalls(run: Run): Verdict {
  const open = new Set<string>(run.view.openIntents().map((i) => invocationId(i.op, i.ordinal)));
  const backend = new Set(spawnIntents(run).filter((i) => backendRole(i) !== null).map((i) => invocationId(i.op, i.ordinal) as string));
  const counts = new Map<string, number>();
  for (const f of facts(run)) if (f.kind === 'meter' || f.kind === 'usage-unavailable') counts.set(f.inv, (counts.get(f.inv) ?? 0) + 1);
  const problems: string[] = [];
  for (const inv of backend) {
    const n = counts.get(inv) ?? 0;
    if (n !== 1 && !(n === 0 && open.has(inv))) problems.push(`${inv}: ${n} usage facts`);
  }
  for (const inv of counts.keys()) if (!backend.has(inv)) problems.push(`usage fact for ${inv}, which is no backend invocation`);
  return { pass: problems.length === 0 && backend.size > 0, detail: problems.length > 0 ? problems.join('; ') : `${backend.size} backend invocations, one usage fact each` };
}

function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
}

/** The state.no-model-ids scope (SCHEMAS.md, owner ruling 2): launch inputs and captured backend output are out. */
function inScope(path: string): boolean {
  const name = basename(path);
  if (name === 'stdout' || name === 'stderr' || name === 'last.json') return false;
  return !(path.startsWith('inv/') && name === 'launch.json');
}

function noModelIds(run: Run): Verdict {
  const hits: string[] = [];
  let checked = 0;
  const scan = (where: string, text: string): void => {
    checked += 1;
    for (const model of MODEL_IDS) if (text.includes(model)) hits.push(`${model} in ${where}`);
  };
  for (const path of filesUnder(run.runDir).filter(inScope)) scan(path, readFileSync(join(run.runDir, path), 'utf8'));
  const ref = snapshotRef(run.arc);
  if (refTarget(run.repo, ref) !== null) {
    for (const path of git(run.repo, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter((p) => p !== '')) scan(`${ref}:${path}`, git(run.repo, ['show', `${ref}:${path}`]));
  }
  return { pass: hits.length === 0, detail: hits.length > 0 ? hits.join('; ') : `${checked} files scanned` };
}

const CRITERIA: readonly (readonly [string, (run: Run) => Verdict])[] = [
  ['no-overlap', noOverlap],
  ['single-owner', singleOwner],
  ['aging', aging],
  ['cleanup-survival', cleanupSurvival],
  ['reentry', reentry],
  ['no-duplicate-writer', noDuplicateWriter],
  ['run-ended', runEnded],
  ['units-settled', unitsSettled],
  ['head-is-candidate', headIsCandidate],
  ['diff-product-only', diffProductOnly],
  ['snapshot-verifies', snapshotVerifies],
  ['judgment-fresh', judgmentFresh],
  ['meter-covers-calls', meterCoversCalls],
  ['no-model-ids', noModelIds],
];

// ---------------------------------------------------------------------------------------------------
// What the run did not exercise

function exercised(run: Run, promoted: number): ReadonlySet<Branch> {
  const out = new Set<Branch>();
  const lanes = new Map<string, IntentOf<'proc.spawn'>[]>();
  for (const i of spawnIntents(run)) {
    const s = i.expect.subject;
    if (s.purpose !== 'lane' || i.parent.type !== 'stage' || i.ordinal !== 1) continue;
    const key = `${i.parent.unit} ${i.parent.stage} ${i.parent.attempt} ${s.lane}`;
    lanes.set(key, [...(lanes.get(key) ?? []), i]);
  }
  for (const runs of lanes.values()) {
    const [first, rerun] = runs;
    if (first === undefined || rerun === undefined) continue;
    const dir = invocationDir(run.runDir, invocationId(first.op, first.ordinal));
    out.add(outputSignatures([join(dir, 'stdout'), join(dir, 'stderr')]).length > 0 ? 'host signature' : 'flake');
  }
  if (facts(run).some((f) => f.kind === 'implementer-escalated')) out.add('D4 escalation');
  for (const f of factsOf(run, 'backend-park')) {
    if (f.class === 'capacity') out.add('backend capacity park');
    if (f.class === 'outage') out.add('backend outage park');
  }
  if (promoted > 0) out.add('aging promotion');
  return out;
}

// ---------------------------------------------------------------------------------------------------

export function check(dir: string): CheckResult {
  const l = layout(dir);
  if (!existsSync(l.report)) throw new Error(`${l.report} is missing: run evals/m2/driver.ts first`);
  const report = JSON.parse(readFileSync(l.report, 'utf8')) as Report;
  const plan = parsePlan(JSON.parse(readFileSync(l.plan, 'utf8')));
  if (plan.arc !== l.arc) throw new Error(`${l.plan} names arc ${plan.arc}, but the fixture dir ${dir} is arc ${l.arc}: was it moved after setup?`);
  const arc = arcId(plan.arc);
  const runDir = absPath(l.runDir);
  const { view, events } = readJournal(runDir, arc);
  const run: Run = { repo: absPath(l.repo), input: l.input, runDir, hostDir: absPath(report.hostDir), estate: l.estate, arc, plan, report, events, view };
  let promoted = 0;
  const criteria = CRITERIA.map(([name, grade]): Criterion => {
    try {
      const v = grade(run);
      if ('promoted' in v) promoted = v.promoted as number;
      return { name, pass: v.pass, detail: v.detail };
    } catch (error) {
      return { name, pass: false, detail: `threw: ${(error as Error).message}` };
    }
  });
  const done = exercised(run, promoted);
  return { pass: criteria.every((c) => c.pass), criteria, notExercised: BRANCHES.filter((b) => !done.has(b)), cannotShow: CANNOT_SHOW };
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m2/check.ts <dir>');
  const result = check(resolve(dir));
  const list = (xs: readonly string[]): string => (xs.length === 0 ? '(none)' : xs.join(', '));
  process.stdout.write(`${JSON.stringify(result)}\nNOT EXERCISED: ${list(result.notExercised)}\nCANNOT SHOW: ${list(result.cannotShow)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}
