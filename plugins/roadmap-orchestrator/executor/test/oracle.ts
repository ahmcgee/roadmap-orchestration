// The semantic oracle of a finished run (plan "Tests", Oracle, R24): what a run dir and its repo must show
// once an arc has ended, however it got there, and the exact recovery trace a crashed cell may leave. Each
// criterion is a pure function of the run returning a Verdict, so evals/m1/check.ts can reuse the ones it
// grades too (publication provenance, snapshot, usage per invocation, no model ids); `oracle` runs them all
// against an expectation and `assertOracle` fails a test on the first that does not hold.
//
// The product tree is compared by tree id: git ids are content addresses, so two trees are equal exactly
// when their content is. Commit SHAs are never compared across runs (their dates differ).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { type Event, type Fact, type IntentOf, type RecoveredBy, unitFfFingerprint } from '../src/core/events.ts';
import { type ArcId, type UnitId, invocationId } from '../src/core/ids.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import { readJournal } from '../src/core/log.ts';
import { needsUserRecord } from '../src/core/records.ts';
import type { AbsPath } from '../src/core/values.ts';
import { git, refTarget, revParse } from '../src/git/git.ts';
import { snapshotRef, verifySnapshot } from '../src/git/snapshot.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { MODEL_IDS } from '../src/routing/types.ts';

export type Verdict = Readonly<{ pass: boolean; detail: string }>;
export type Criterion = Readonly<{ name: string }> & Verdict;

/** What every criterion reads: the repo, the run dir and its log. evals/m1/check.ts's `Run` has these fields. */
export type OracleRun = Readonly<{ repo: AbsPath; runDir: AbsPath; arc: ArcId; events: readonly Event[]; view: JournalView }>;

export function oracleRun(repo: AbsPath, runDir: AbsPath, arc: ArcId): OracleRun {
  const { events, view } = readJournal(runDir, arc);
  return { repo, runDir, arc, events, view };
}

const facts = (run: OracleRun): readonly Fact[] => run.events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const spawns = (run: OracleRun): readonly IntentOf<'proc.spawn'>[] => run.events.flatMap((e) => (e.type === 'intent' && e.kind === 'proc.spawn' ? [e] : []));
const verdict = (problems: readonly string[], ok: string): Verdict => ({ pass: problems.length === 0, detail: problems.length > 0 ? problems.join('; ') : ok });

// ---------------------------------------------------------------------------------------------------
// Product and publication

/** The integration head's tree is `tree` (a content address: equal ids, equal content). */
export function productTree(run: OracleRun, integration: string, tree: string): Verdict {
  const actual = revParse(run.repo, `refs/heads/${integration}^{tree}`);
  return { pass: actual === tree, detail: `${integration}^{tree} is ${actual}, expected ${tree}` };
}

/** The published integration.ff dones, in log order, with their intents. */
function publications(run: OracleRun): readonly IntentOf<'integration.ff'>[] {
  return run.events.flatMap((e) => {
    if (e.type !== 'done' || e.kind !== 'integration.ff' || e.outcome.kind !== 'published') return [];
    const intent = run.view.latestIntent(e.op);
    if (intent.kind !== 'integration.ff') throw new Error(`${e.op}: an integration.ff done over a ${intent.kind} intent`);
    return [intent];
  });
}

/** The unit whose latest approval before `seq` names `unitCommit`, or null. */
function approvedUnit(run: OracleRun, seq: number, unitCommit: string): string | null {
  const latest = new Map<string, string>();
  for (const e of run.events) {
    if (e.seq >= seq) break;
    if (e.type === 'fact' && e.fact.kind === 'approval') latest.set(e.fact.unit, e.fact.fingerprint.unitCommit);
  }
  return [...latest].find(([, c]) => c === unitCommit)?.[0] ?? null;
}

/**
 * A batch ff's members (M3 B2): its chained candidate runs from `new` down to its T along first parents, each commit
 * merging (second parent) one member's approved unit commit; the members in chain order, and the problems found (a chain
 * that never reaches T fails loud at the root, whose first parent git cannot name).
 */
function batchMembers(run: OracleRun, ff: IntentOf<'integration.ff'>): Readonly<{ units: readonly string[]; problems: readonly string[] }> {
  const { old } = ff.expect;
  const seq = run.events.find((e) => e.type === 'intent' && e.op === ff.op)?.seq ?? Infinity;
  const units: string[] = [];
  const problems: string[] = [];
  for (let c = ff.expect.new; c !== old; c = revParse(run.repo, `${c}^1`) as typeof c) {
    const unit = approvedUnit(run, seq, revParse(run.repo, `${c}^2`));
    if (unit === null) problems.push(`${ff.op}: ${c}^2 is no member's approved unit commit`);
    else units.unshift(unit);
  }
  if (units.length < 2) problems.push(`${ff.op}: a batch of ${units.length} member(s)`);
  return { units, problems };
}

/**
 * Publication provenance: every published ff made `new` from its T (`old`): a unit's ff has first parent T and
 * second parent the unit commit its approval named, which is the unit's latest approval fact before the ff; a docs
 * ff (M3) has first parent T and names its job; a batch ff (M3) is its chained candidate, from `new` down to T along
 * first parents, each commit merging one member's approved unit commit. The first-parent chain from the head passes
 * through every publication in order (new, then down to its T), down to `baseline`, so integration only ever moved
 * forward through the published candidates (and commits others made on top of them); the head is the last
 * publication (or `baseline` when nothing was published), and that commit is the candidate its lanes tested,
 * every one at it passing: a unit's suite lanes, or a docs or batch job's own lanes.
 */
export function provenance(run: OracleRun, integration: string, baseline: string): Verdict {
  const head = revParse(run.repo, `refs/heads/${integration}`);
  const published = publications(run);
  const problems: string[] = [];
  const chain = git(run.repo, ['rev-list', '--first-parent', head]).split('\n').filter((c) => c !== '');
  if (!chain.includes(baseline)) problems.push(`the first-parent chain of ${head} does not reach the baseline ${baseline}`);
  for (const ff of published) {
    const { old } = ff.expect;
    const next = ff.expect.new;
    const i = chain.indexOf(next);
    if (ff.expect.subject?.type === 'batch') {
      problems.push(...batchMembers(run, ff).problems);
      if (i === -1 || chain.indexOf(old) <= i) problems.push(`${ff.op}: ${next} then, down its chain, ${old} are not on the first-parent chain of ${head}`);
    } else {
      if (revParse(run.repo, `${next}^1`) !== old) problems.push(`${ff.op}: ${next}^1 is not T ${old}`);
      if (i === -1 || chain[i + 1] !== old) problems.push(`${ff.op}: ${next} then ${old} are not on the first-parent chain of ${head}`);
    }
    if (ff.expect.subject !== undefined) {
      const job = ff.expect.subject.type === 'docs' ? ff.expect.subject.pub : ff.expect.subject.job;
      if (ff.parent.type !== 'job' || ff.parent.job !== job) problems.push(`${ff.op} of ${job} is not parented by its job`);
      continue;
    }
    const fingerprint = unitFfFingerprint(ff.expect);
    if (revParse(run.repo, `${next}^2`) !== fingerprint.unitCommit) problems.push(`${ff.op}: ${next}^2 is not the approved unit commit ${fingerprint.unitCommit}`);
    if (ff.parent.type !== 'stage') {
      problems.push(`${ff.op} has no stage parent`);
      continue;
    }
    const unit = ff.parent.unit;
    const intentSeq = run.events.find((e) => e.type === 'intent' && e.op === ff.op)?.seq ?? Infinity;
    const approval = run.events.filter((e) => e.seq < intentSeq && e.type === 'fact' && e.fact.kind === 'approval' && e.fact.unit === unit).at(-1);
    if (approval?.type !== 'fact' || approval.fact.kind !== 'approval' || approval.fact.fingerprint.unitCommit !== fingerprint.unitCommit) {
      problems.push(`${ff.op}: the unit commit it publishes is not ${unit}'s latest approval before it`);
    }
  }
  // rev-list lists the newest first, so a later publication sits nearer the head.
  const order = published.map((ff) => chain.indexOf(ff.expect.new));
  if (order.some((i, k) => k > 0 && i >= order[k - 1]!)) problems.push(`the publications are not in log order along the first-parent chain: ${order.join(', ')}`);
  const last = published.at(-1);
  if (last === undefined) {
    if (head !== baseline) problems.push(`nothing was published, but ${integration} moved from ${baseline} to ${head}`);
    return verdict(problems, `nothing published; ${integration} at the baseline`);
  }
  if (head !== last.expect.new) problems.push(`the head ${head} is not the last publication ${last.expect.new}`);
  const subject = last.expect.subject;
  const byJob = subject === undefined ? null : subject.type === 'docs' ? subject.pub : subject.job;
  const tested = spawns(run).filter((i) => {
    const s = i.expect.subject;
    if (byJob !== null) return s.purpose === 'journey' && s.owner.type === 'job' && s.owner.job === byJob && s.at === head;
    return s.purpose === 'lane' && s.set === 'suite' && s.at === head;
  });
  if (tested.length === 0) problems.push(`no ${byJob === null ? 'suite lane' : `lane of ${byJob}`} ran at the head ${head}`);
  for (const lane of tested) {
    const inv = invocationId(lane.op, lane.ordinal);
    const result = runnerFiles(invocationDir(run.runDir, inv), inv).read('result.json');
    if (result === null || result.type !== 'command' || result.verdict !== 'pass') problems.push(`lane ${inv} at the head did not pass`);
  }
  return verdict(problems, `${published.length} publication(s); head ${head} is the last, tested by ${tested.length} passing lane(s)`);
}

/** Each unit published exactly `expected[unit]` times (1 for a merged unit, 0 otherwise), by its own ff or as a batch member. */
export function publicationsPerUnit(run: OracleRun, expected: Readonly<Record<string, number>>): Verdict {
  const counts = new Map<string, number>();
  const count = (unit: string): void => void counts.set(unit, (counts.get(unit) ?? 0) + 1);
  for (const ff of publications(run)) {
    if (ff.parent.type === 'stage') count(ff.parent.unit);
    if (ff.expect.subject?.type === 'batch') for (const u of batchMembers(run, ff).units) count(u);
  }
  const problems = Object.entries(expected).flatMap(([unit, n]) => ((counts.get(unit) ?? 0) === n ? [] : [`${unit} published ${counts.get(unit) ?? 0} times, expected ${n}`]));
  for (const unit of counts.keys()) if (!(unit in expected)) problems.push(`${unit} published but is not expected`);
  return verdict(problems, `publications per unit ${JSON.stringify(Object.fromEntries(counts))}`);
}

/** refs/roadmap/<arc> verifies against its own manifest and its high-water mark covers the last integration.ff done. */
export function snapshotVerifies(run: OracleRun): Verdict {
  const ref = snapshotRef(run.arc);
  const at = refTarget(run.repo, ref);
  const lastFf = run.events.filter((e) => e.type === 'done' && e.kind === 'integration.ff').at(-1);
  if (at === null) return { pass: lastFf === undefined, detail: lastFf === undefined ? 'nothing published, no snapshot' : `${ref} is absent after integration.ff done at seq ${lastFf.seq}` };
  const v = verifySnapshot(run.repo, at);
  if (v.kind !== 'verified') return { pass: false, detail: `${ref} at ${at}: ${v.detail}` };
  const floor = lastFf?.seq ?? 0;
  return { pass: v.manifest.highWater >= floor, detail: `${ref} at ${at}: high-water ${v.manifest.highWater}, last integration.ff done at seq ${floor}` };
}

// ---------------------------------------------------------------------------------------------------
// State

export type UnitEnd = 'merged' | 'parked' | 'held';

const STATUS_OF: Readonly<Record<string, UnitEnd>> = { retired: 'merged', 'park-pending': 'parked', held: 'held' };

/** Each unit's state as the fold derives it. */
export function unitStates(run: OracleRun, expected: Readonly<Record<string, UnitEnd>>): Verdict {
  const problems = Object.entries(expected).flatMap(([unit, want]) => {
    const status = run.view.unit(unit as UnitId).status;
    return STATUS_OF[status] === want ? [] : [`${unit} is ${status}, expected ${want}`];
  });
  return verdict(problems, JSON.stringify(expected));
}

/** Every stage-outcome of each unit, as `stage:outcome`, in log order. */
export function outcomesOf(run: OracleRun, unit: string): readonly string[] {
  return facts(run).flatMap((f) => (f.kind === 'stage-outcome' && f.unit === unit ? [`${f.stage}:${f.outcome}`] : []));
}

/** The units' stage-outcome sequences are exactly `expected`: no stage decided twice, none missing. */
export function stageOutcomes(run: OracleRun, expected: Readonly<Record<string, readonly string[]>>): Verdict {
  const problems = Object.entries(expected).flatMap(([unit, want]) => {
    const got = outcomesOf(run, unit);
    return JSON.stringify(got) === JSON.stringify(want) ? [] : [`${unit}: ${got.join(' ')}; expected ${want.join(' ')}`];
  });
  return verdict(problems, 'stage outcomes as expected');
}

/** Every needs-user raised (journal and file items), by reason, is exactly `expected` (a multiset): no duplicates. */
export function needsUserExactly(run: OracleRun, expected: readonly string[]): Verdict {
  const dir = join(run.runDir, 'needs-user');
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.ack.json')) : [];
  const reasons = names.map((n) => needsUserRecord(JSON.parse(readFileSync(join(dir, n), 'utf8')), n).reason).sort();
  const raised = run.view.needsUser().map((n) => n.id);
  const problems: string[] = [];
  if (JSON.stringify(reasons) !== JSON.stringify([...expected].sort())) problems.push(`needs-user reasons ${reasons.join(', ') || 'none'}, expected ${[...expected].sort().join(', ') || 'none'}`);
  if (new Set(raised).size !== raised.length) problems.push(`a needs-user id raised twice: ${raised.join(', ')}`);
  const causes = run.view.opsOf('needsuser.raise').map((i) => JSON.stringify(i.parent));
  if (new Set(causes).size !== causes.length) problems.push(`one cause raised twice: ${causes.join(' ')}`);
  return verdict(problems, `needs-user ${reasons.join(', ') || 'none'}`);
}

/** The role of a backend invocation (a pipeline backend, a job's lens or checkpoint call, or a backend smoke), or null for commands. */
function backendRole(i: IntentOf<'proc.spawn'>): string | null {
  const s = i.expect.subject;
  if (s.purpose === 'backend' || s.purpose === 'arc-backend') return s.role;
  if (s.purpose === 'smoke' && s.target.type === 'backend') return s.target.role;
  return null;
}

/** Exactly one usage fact (meter or usage-unavailable) per closed backend invocation (smokes included), none other. */
export function usagePerInvocation(run: OracleRun): Verdict {
  const open = new Set<string>(run.view.openIntents().map((i) => invocationId(i.op, i.ordinal)));
  const backend = new Set<string>(spawns(run).filter((i) => backendRole(i) !== null).map((i) => invocationId(i.op, i.ordinal)));
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

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
}

/** The state.no-model-ids scope (SCHEMAS.md, owner ruling 2): launch inputs and captured backend output are out. */
function inScope(path: string): boolean {
  const name = basename(path);
  if (name === 'stdout' || name === 'stderr' || name === 'last.json') return false;
  return !(path.startsWith('inv/') && name === 'launch.json');
}

/** No model id in any run-dir file outside inv/*\/launch.json and captured backend output, nor in the snapshot ref. */
export function noModelIds(run: OracleRun): Verdict {
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

// ---------------------------------------------------------------------------------------------------
// The recovery trace

/**
 * What recovery may have done in a cell. `recoveredBy`: the values a done may carry besides live (null);
 * `required`: at least one done carries one of them (an op was open at the crash); `tailDiscarded`: the
 * crash left a torn line, so exactly one tail-discarded fact exists (else none).
 */
export type Trace = Readonly<{ recoveredBy: readonly Exclude<RecoveredBy, null>[]; required: boolean; tailDiscarded: boolean }>;

/** A run no crash touched: every done live, no tail discarded. */
export const UNCRASHED: Trace = { recoveredBy: [], required: false, tailDiscarded: false };

/**
 * The recovery trace is `expected`, and retries stayed bounded: an op has at most two invocations, a retry
 * inherits its op's deadline, and the run has no open intent left.
 */
export function recoveryTrace(run: OracleRun, expected: Trace): Verdict {
  const problems: string[] = [];
  const by = run.events.flatMap((e) => (e.type === 'done' && e.recoveredBy !== null ? [`${e.kind}:${e.recoveredBy}`] : []));
  const values = new Set(by.map((b) => b.split(':')[1]));
  for (const v of values) if (!(expected.recoveredBy as readonly string[]).includes(v!)) problems.push(`recoveredBy ${v} is not allowed here (${by.join(', ')})`);
  if (expected.required && by.length === 0) problems.push(`no done was recovered, expected one of ${expected.recoveredBy.join('|')}`);
  const torn = facts(run).filter((f) => f.kind === 'tail-discarded').length;
  if (torn !== (expected.tailDiscarded ? 1 : 0)) problems.push(`${torn} tail-discarded facts, expected ${expected.tailDiscarded ? 1 : 0}`);
  for (const i of spawns(run)) {
    if (i.ordinal > 2) problems.push(`${i.op} has invocation ${i.ordinal}: retries are bounded at one`);
    if (i.ordinal > 1 && i.deadlineAt !== spawns(run).find((s) => s.op === i.op && s.ordinal === 1)?.deadlineAt) problems.push(`${i.op}#${i.ordinal} does not inherit its op's deadline`);
  }
  const open = run.view.openIntents();
  if (open.length > 0) problems.push(`intents left open: ${open.map((i) => `${i.kind} ${i.op}`).join(', ')}`);
  return verdict(problems, by.length === 0 ? 'nothing recovered' : `recovered ${by.join(', ')}`);
}

// ---------------------------------------------------------------------------------------------------
// All of it

export type Expected = Readonly<{
  integration: string;
  baseline: string;
  /** The integration head's tree id. */
  tree: string;
  units: Readonly<Record<string, UnitEnd>>;
  outcomes: Readonly<Record<string, readonly string[]>>;
  /** Reasons of every needs-user raised, as a multiset. */
  needsUser: readonly string[];
  trace: Trace;
}>;

export function oracle(run: OracleRun, expected: Expected): readonly Criterion[] {
  const merged = Object.fromEntries(Object.entries(expected.units).map(([u, s]) => [u, s === 'merged' ? 1 : 0]));
  const criteria: readonly (readonly [string, () => Verdict])[] = [
    ['product-tree', () => productTree(run, expected.integration, expected.tree)],
    ['provenance', () => provenance(run, expected.integration, expected.baseline)],
    ['publications-per-unit', () => publicationsPerUnit(run, merged)],
    ['snapshot-verifies', () => snapshotVerifies(run)],
    ['unit-states', () => unitStates(run, expected.units)],
    ['stage-outcomes', () => stageOutcomes(run, expected.outcomes)],
    ['needs-user', () => needsUserExactly(run, expected.needsUser)],
    ['usage-per-invocation', () => usagePerInvocation(run)],
    ['no-model-ids', () => noModelIds(run)],
    ['recovery-trace', () => recoveryTrace(run, expected.trace)],
  ];
  return criteria.map(([name, grade]) => ({ name, ...grade() }));
}

export function assertOracle(run: OracleRun, expected: Expected): void {
  const failed = oracle(run, expected).filter((c) => !c.pass);
  assert.deepEqual(failed, [], `oracle: ${failed.map((c) => `${c.name}: ${c.detail}`).join(' | ')}`);
}
