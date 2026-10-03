// The M1 paid fixture, step 3: `node evals/m1/check.ts <dir>` grades a finished run (setup → driver) on the
// plan's loose criteria, from the repo, the run dir and report.json. Agent-facing output: one JSON line
// `{pass, criteria[{name, pass, detail}], notExercised[], cannotShow[]}`, then the two lists as lines
// (`NOT EXERCISED: …`, `CANNOT SHOW: …`). Exits 1 when any criterion fails.
//
// Criteria:
//   run-ended            start exited 0 (ready), and the run's final executor left an exit reason other than
//                        refused, not by the driver's hard timeout
//   units-settled        every unit merged, or parked with a coherent needs-user (the file exists, its reason is
//                        one of the frozen reasons, and status lists it open and blocking), or never started
//                        because a unit it runs `after` is parked so (D1: merged-only edges)
//   head-is-candidate    integration head = the last published ff's candidate; head^1 = its T; head^2 = the
//                        unit commit the latest approval fact names; head's tree = the candidate ref's tree
//   diff-product-only    `git diff main...integration` passes the transient check (src/git/transient.ts)
//   snapshot-verifies    refs/roadmap/<arc> verifies against its own manifest (verifySnapshot) and its
//                        high-water mark is at or after the last integration.ff done
//   judgment-fresh       no judgment invocation's launch argv resumes; every judgment session id is distinct
//   meter-covers-calls   exactly one usage fact (meter or usage-unavailable) per backend invocation, none other
//   no-model-ids         no model id in any run-dir file outside inv/*/launch.json and captured backend output
//                        (stdout, stderr, the Codex -o file), nor
//                        in the snapshot ref's files in that scope (the state.no-model-ids scope)
//
// The non-exercised list names the branches of the pipeline this run's journal shows no trace of; the
// cannot-show list is fixed: what no run of this fixture can demonstrate.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Event, Fact, IntentOf, StageOutcomeFact } from '../../src/core/events.ts';
import { type ArcId, type OpId, arcId, invocationId } from '../../src/core/ids.ts';
import type { JournalView } from '../../src/core/interfaces.ts';
import { readJournal } from '../../src/core/log.ts';
import { RUNNER_FILE_READERS } from '../../src/core/records.ts';
import { type AbsPath, absPath, repoPath } from '../../src/core/values.ts';
import { candidateRef } from '../../src/git/candidate.ts';
import { git, refTarget, revParse } from '../../src/git/git.ts';
import { snapshotRef, verifySnapshot } from '../../src/git/snapshot.ts';
import { transientViolations } from '../../src/git/transient.ts';
import { ROADMAP_DIR_ALLOWED } from '../../src/preflight/checks.ts';
import { type PlanM1, parsePlan } from '../../src/input/plan.ts';
import { readNeedsUser } from '../../src/needsuser.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { MODEL_IDS } from '../../src/routing/types.ts';
import { loadSpec } from '../../src/spec/spec.ts';
import type { Report } from './driver.ts';
import { MAIN, layout } from './layout.ts';

type Verdict = Readonly<{ pass: boolean; detail: string }>;
export type Criterion = Readonly<{ name: string }> & Verdict;
export type CheckResult = Readonly<{ pass: boolean; criteria: readonly Criterion[]; notExercised: readonly Branch[]; cannotShow: readonly string[] }>;

/** The branches a real run may avoid, in the order the report lists them. */
export const BRANCHES = [
  'redirect', 'red lane', 'fix round', 'conflict/merge-in', 'red candidate', 'base-red', 'gate revise', 'unpublished/fresh candidate', 'usage-limit',
] as const;
export type Branch = (typeof BRANCHES)[number];

export const CANNOT_SHOW = ['issue mode', 'real cgroup containment', 'crash boundaries under real models', 'week-long reliability'] as const;

type Run = Readonly<{
  repo: AbsPath;
  /** The run-input dir: plan.json and the specs. */
  input: string;
  runDir: AbsPath;
  arc: ArcId;
  plan: PlanM1;
  report: Report;
  events: readonly Event[];
  view: JournalView;
}>;

const facts = (run: Run): readonly Fact[] => run.events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const spawnIntents = (run: Run): readonly IntentOf<'proc.spawn'>[] => run.events.flatMap((e) => (e.type === 'intent' && e.kind === 'proc.spawn' ? [e] : []));

// ---------------------------------------------------------------------------------------------------
// Criteria

function runEnded(run: Run): Verdict {
  const { endedBy, start, generation, exit } = run.report;
  const pass = endedBy !== 'timeout' && start.code === 0 && exit !== null && exit.kind !== 'refused';
  return { pass, detail: `endedBy=${endedBy} start=${start.code} generation=${generation} reason=${JSON.stringify(exit)}` };
}

function unitsSettled(run: Run): Verdict {
  const problems: string[] = [];
  const lines: string[] = [];
  for (const unit of run.plan.units) {
    const line = run.report.status.units.find((u) => u.unit === unit.id);
    if (line === undefined) {
      problems.push(`${unit.id}: not in status`);
      continue;
    }
    if (line.status === 'retired') {
      lines.push(`${unit.id} merged`);
      continue;
    }
    if (line.status === 'park-pending' || line.status === 'stop-pending') {
      const raised = run.view.needsUser().flatMap((n) => {
        const record = readNeedsUser(run.runDir, n.id);
        return record !== null && record.subject.type === 'unit' && record.subject.unit === unit.id ? [record] : [];
      });
      if (raised.length === 0) problems.push(`${unit.id}: ${line.status} with no needs-user file for it`);
      for (const r of raised) {
        const listed = run.report.status.needsUser.find((n) => n.id === r.id);
        if (listed === undefined || listed.reason !== r.reason || !listed.blocking) problems.push(`${unit.id}: needs-user ${r.id} (${r.reason}) is not listed open and blocking in status`);
        lines.push(`${unit.id} parked ${r.id} ${r.reason}`);
      }
      continue;
    }
    const parkedAfter = unit.after.filter((d) => run.report.status.units.find((u) => u.unit === d)?.status === 'park-pending');
    if (line.attempts === 0 && parkedAfter.length > 0) {
      lines.push(`${unit.id} waits after ${parkedAfter.join(', ')}`);
      continue;
    }
    problems.push(`${unit.id}: ${line.status} at ${line.stage}, neither merged nor parked`);
  }
  return { pass: problems.length === 0, detail: [...problems, ...lines].join('; ') };
}

function headIsCandidate(run: Run): Verdict {
  const integration = revParse(run.repo, `refs/heads/${run.plan.integrationBranch}`);
  const published = run.events.flatMap((e) => (e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'published' ? [e] : []));
  const last = published.at(-1);
  if (last === undefined) {
    const merged = run.report.status.units.some((u) => u.status === 'retired');
    return { pass: !merged, detail: merged ? 'a unit retired, but no integration.ff published' : `nothing published; integration at ${integration}` };
  }
  const ff = ffIntent(run, last.op);
  if (ff.parent.type !== 'stage') return { pass: false, detail: `the ff ${ff.op} has no stage parent` };
  const unit = ff.parent.unit;
  const approval = facts(run).filter((f) => f.kind === 'approval' && f.unit === unit).at(-1);
  if (approval === undefined || approval.kind !== 'approval') return { pass: false, detail: `no approval fact for ${unit}` };
  const problems: string[] = [];
  if (integration !== ff.expect.new) problems.push(`integration ${integration} is not the published candidate ${ff.expect.new}`);
  const first = revParse(run.repo, `${integration}^1`);
  if (first !== ff.expect.old) problems.push(`head^1 ${first} is not T ${ff.expect.old}`);
  const second = revParse(run.repo, `${integration}^2`);
  if (second !== approval.fingerprint.unitCommit) problems.push(`head^2 ${second} is not the approved unit commit ${approval.fingerprint.unitCommit}`);
  const headTree = revParse(run.repo, `${integration}^{tree}`);
  const candTree = revParse(run.repo, `${candidateRef(run.arc, unit)}^{tree}`);
  if (headTree !== candTree) problems.push(`head tree ${headTree} is not the candidate ref's tree ${candTree}`);
  return { pass: problems.length === 0, detail: problems.length > 0 ? problems.join('; ') : `integration ${integration} = candidate of ${unit}, second parent ${second}` };
}

/** The latest intent (highest ordinal) of the integration.ff op `op`. */
function ffIntent(run: Run, op: OpId): IntentOf<'integration.ff'> {
  const found = run.events.flatMap((e) => (e.type === 'intent' && e.kind === 'integration.ff' && e.op === op ? [e] : [])).at(-1);
  if (found === undefined) throw new Error(`no integration.ff intent for ${op}`);
  return found;
}

function diffProductOnly(run: Run): Verdict {
  const out = git(run.repo, ['diff', '--name-only', '-z', `${MAIN}...${run.plan.integrationBranch}`]);
  const paths = out.split('\0').filter((p) => p !== '').map((p) => repoPath(p));
  const specs = run.plan.units.map((u) => loadSpec(absPath(join(run.input, u.spec))));
  // The whole arc's diff: the in-tree `.roadmap/` entries docs publications own (ROADMAP_DIR_ALLOWED) are allowed; every
  // other path is under the transient rules, bounded by the union of the units' scopes.
  const published = (p: string): boolean => p.startsWith('.roadmap/') && (ROADMAP_DIR_ALLOWED as readonly string[]).includes(p.split('/')[1]!);
  const violations = transientViolations(
    { evidenceGlobs: specs.flatMap((s) => s.lanes.flatMap((l) => l.evidenceGlobs)), scope: specs.flatMap((s) => s.scope) },
    paths.filter((p) => !published(p)),
  );
  return {
    pass: violations.length === 0,
    detail: violations.length > 0 ? violations.map((v) => `${v.path} (${v.rule})`).join(', ') : `${paths.length} product paths: ${paths.join(', ')}`,
  };
}

function snapshotVerifies(run: Run): Verdict {
  const ref = snapshotRef(run.arc);
  const at = refTarget(run.repo, ref);
  const lastFf = run.events.filter((e) => e.type === 'done' && e.kind === 'integration.ff').at(-1);
  if (at === null) return { pass: lastFf === undefined, detail: lastFf === undefined ? 'nothing published, no snapshot' : `${ref} is absent after integration.ff done at seq ${lastFf.seq}` };
  const v = verifySnapshot(run.repo, at);
  if (v.kind !== 'verified') return { pass: false, detail: `${ref} at ${at}: ${v.detail}` };
  const floor = lastFf?.seq ?? 0;
  return {
    pass: v.manifest.highWater >= floor,
    detail: `${ref} at ${at}: high-water ${v.manifest.highWater}, last integration.ff done at seq ${floor}`,
  };
}

const JUDGMENT_ROLES: ReadonlySet<string> = new Set(['planCheck', 'gate']);

/** The role of a backend invocation (a pipeline backend or a backend smoke), or null for commands. */
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
  const open = new Set(run.view.openIntents().map((i) => invocationId(i.op, i.ordinal)));
  const backend = new Set(spawnIntents(run).filter((i) => backendRole(i) !== null).map((i) => invocationId(i.op, i.ordinal) as string));
  const counts = new Map<string, number>();
  for (const f of facts(run)) if (f.kind === 'meter' || f.kind === 'usage-unavailable') counts.set(f.inv, (counts.get(f.inv) ?? 0) + 1);
  const problems: string[] = [];
  for (const inv of backend) {
    const n = counts.get(inv) ?? 0;
    if (n !== 1 && !(n === 0 && open.has(inv as never))) problems.push(`${inv}: ${n} usage facts`);
  }
  for (const inv of counts.keys()) if (!backend.has(inv)) problems.push(`usage fact for ${inv}, which is no backend invocation`);
  return { pass: problems.length === 0 && backend.size > 0, detail: problems.length > 0 ? problems.join('; ') : `${backend.size} backend invocations, one usage fact each` };
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
}

/**
 * The state.no-model-ids scope (SCHEMAS.md, owner ruling 2): launch inputs and captured backend output are out. The snapshot ref mirrors run-dir paths, so one scope serves both.
 */
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
    for (const path of git(run.repo, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter((p) => p !== '' && inScope(p))) scan(`${ref}:${path}`, git(run.repo, ['show', `${ref}:${path}`]));
  }
  return { pass: hits.length === 0, detail: hits.length > 0 ? hits.join('; ') : `${checked} files scanned` };
}

const CRITERIA: readonly (readonly [string, (run: Run) => Verdict])[] = [
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

/** The outcomes whose next stage is a fix round (`build('fix')` in the transition table). */
const FIX_TRIGGERS: ReadonlySet<string> = new Set(['lanes:red', 'lanes:not-certified', 'gate:revise', 'candidate:red', 'candidate:transient-violation']);

export function exercised(events: readonly Event[]): ReadonlySet<Branch> {
  const out = new Set<Branch>();
  const outcomes = events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' ? [e.fact] : []));
  const seen = new Set(outcomes.map((f) => `${f.stage}:${f.outcome}`));
  const mark = (branch: Branch, ...keys: string[]): void => {
    if (keys.some((k) => seen.has(k))) out.add(branch);
  };
  mark('redirect', 'plan-check:redirect');
  mark('red lane', 'lanes:red');
  mark('conflict/merge-in', 'candidate:conflict');
  mark('red candidate', 'candidate:red');
  mark('base-red', 'candidate:base-red');
  mark('gate revise', 'gate:revise');
  mark('unpublished/fresh candidate', 'ff:cas-stale');
  if (events.some((e) => e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'unpublished')) out.add('unpublished/fresh candidate');
  if (events.some((e) => e.type === 'fact' && e.fact.kind === 'backend-park' && e.fact.class === 'usage-limit')) out.add('usage-limit');
  // A fix round: a build stage right after (in the unit's own sequence) an outcome that decides one.
  const byUnit = new Map<string, StageOutcomeFact[]>();
  for (const f of outcomes) if (f.class !== 'hold') byUnit.set(f.unit, [...(byUnit.get(f.unit) ?? []), f]);
  for (const seq of byUnit.values()) {
    seq.forEach((f, i) => {
      const prev = seq[i - 1];
      if (f.stage === 'build' && prev !== undefined && FIX_TRIGGERS.has(`${prev.stage}:${prev.outcome}`)) out.add('fix round');
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------

export function check(dir: string): CheckResult {
  const l = layout(dir);
  if (!existsSync(l.report)) throw new Error(`${l.report} is missing: run evals/m1/driver.ts first`);
  const report = JSON.parse(readFileSync(l.report, 'utf8')) as Report;
  const plan = parsePlan(JSON.parse(readFileSync(l.plan, 'utf8')));
  if (plan.arc !== l.arc) throw new Error(`${l.plan} names arc ${plan.arc}, but the fixture dir ${dir} is arc ${l.arc}: was it moved after setup?`);
  const arc = arcId(plan.arc);
  const runDir = absPath(l.runDir);
  const { view, events } = readJournal(runDir, arc);
  const run: Run = { repo: absPath(l.repo), input: l.input, runDir, arc, plan, report, events, view };
  // A criterion that throws (say, a tampered object git cannot read) fails with the error as its detail.
  const criteria = CRITERIA.map(([name, grade]): Criterion => {
    try {
      return { name, ...grade(run) };
    } catch (error) {
      return { name, pass: false, detail: `threw: ${(error as Error).message}` };
    }
  });
  const done = exercised(events);
  return {
    pass: criteria.every((c) => c.pass),
    criteria,
    notExercised: BRANCHES.filter((b) => !done.has(b)),
    cannotShow: CANNOT_SHOW,
  };
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m1/check.ts <dir>');
  const result = check(resolve(dir));
  const list = (xs: readonly string[]): string => (xs.length === 0 ? '(none)' : xs.join(', '));
  process.stdout.write(`${JSON.stringify(result)}\nNOT EXERCISED: ${list(result.notExercised)}\nCANNOT SHOW: ${list(result.cannotShow)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}
