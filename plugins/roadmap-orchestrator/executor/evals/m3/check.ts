// The M3 paid fixture, step 3: `node evals/m3/check.ts <dir>` grades a finished run (setup → driver) from the log,
// the repo, the run dir and report.json. Agent-facing output: one JSON line `{pass, criteria[{name, pass, detail}],
// notExercised[], cannotShow[]}`, then the two lists as lines. Exits 1 when any criterion fails.
//
// The story is branch-tolerant (DESIGN-1.0.md §10 M3): branch R (regressed), P (prevented) or L (latent), read from the
// log (R: tidy published and I-2 not shown held on S; L: tidy published and I-2 held on S every time its lane ran there;
// P: a bundle revision disposed of tidy before it published) and matched with the driver's record. Each branch grades
// only its own criteria; the others' are not applicable. M3 criteria in every branch (the story's steps in brackets):
//   baseline                the baseline job witnessed every arc lane on the baseline before any unit was dispatched,
//                           and raised no `obligation-baseline`: I-2 and I-3 held, I-1 not
//   branch                  the log shows branch R, P or L, and the driver recorded the same
//   stale-whole             [4] the first checkpoint, whatever its trigger, was rejected stale whole: the driver's apply
//                           committed between its capture and its decision, and nothing of its bundle applied
//   bundles-whole           every bundle decided rejected or requested applied nothing; at least one bundle revision;
//                           every unit a bundle added merged, each finding it repairs resolved or ruled and each
//                           obligation it serves held; the bundle requests the driver answered (informational)
//   bundle-divergences      [5] every bundle revision recorded divergences, one citing V-2
//   divergence-digest-bound [5] each digest binds exactly (as a set) the divergences recorded before it that no earlier digest
//                           bound; the driver acknowledged each; none is left uncovered
//   convergence-bound       [6] K = 1: `convergence-bound` was raised, each one acknowledged by the driver
//   drift-audit             [8] an audit triggered by a bundle revision's drift ran the vision lens alone, or with the
//                           triggers coalesced into it the union they require (a cadence one: all of L), completed
//   final-audit             [9] the last audit was `final`, ran lenses of L on the last unit publication's head; its
//                           checkpoint no-oped
//   close-out               [10] the close-out publication is docs-only (the rendered `.roadmap/` files) and records
//                           `docs-covered` for its own edge
//   completion              [11] `arc-completed` names the plan in force, the head and every merged unit; then the
//                           terminal snapshot (its high-water past the completion); status shows the completion active
//                           with no unmet condition (every generation quiescent under the vision)
//   lens-coverage           every lens of L has a contiguous watermark at the final head (status.audit), no docs edge
//                           pending, the docs edges after the final audit applied from its SHA, nothing outstanding
//   snapshot-closure        the terminal ref verifies as a closure (every file named by a record), and carries each
//                           witness record and each kept revision payload the log names
//   obligations-discharged  status: every non-exempt obligation in force at the end (not the seed) holds on the head,
//                           none pending
// Branch R only:
//   regression-unselected   [2] tidy's approval selected I-3 and not I-2; I-2 not held on the tree tidy published (S)
//   audit-race              [3] the first audit ran L on S; report published inside it (S′) and latched I-1; the audit's
//                           code opened a P1 over I-2, and re-witnessed I-2 on S′ (not held)
//   repair-resolved         [7] a unit repairing that P1 (or I-2) merged, the P1 was resolved, and I-2 holds on the head
// Branch L only:
//   latent-repair           tidy published with I-2 held on S; an audit of S opened lens findings over I-2; a bundle
//                           admitted a unit repairing them, it merged, they were resolved, and I-2 holds on the head
// Branch P only:
//   prevention              tidy never published; a bundle revision cut, respecified or re-entered it, recording a
//                           divergence citing an active clause
// M1/M2 standing criteria, over this run:
//   run-ended (complete), units-settled (merged, or cut or superseded by a bundle), head-is-publication (the head is the last publication's commit: a unit's
//   tested candidate or the docs commit), diff-product-and-docs (units' scopes plus the living `.roadmap/` docs,
//   constraints.md, invariants.md and the corpus arc's debt.md included), snapshot-verifies, judgment-fresh (plan-check, gate, lens and
//   checkpoint calls), meter-covers-calls (unit and arc calls), no-model-ids
//
// The non-exercised list names what this run's journal shows no trace of, from: rule, reverse, steer, merge-in,
// reproduction, batch repair, per-identity bound, owner-request, draining, real go, literal partial bundle. The paid
// run takes none of them (the fake story takes the literal partial bundle); each has a fake integrated test.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Event, Fact, IntentOf } from '../../src/core/events.ts';
import { type ArcId, type CommandId, type NeedsUserId, type OpId, type UnitId, arcId, invocationDirName, invocationId } from '../../src/core/ids.ts';
import type { JournalView } from '../../src/core/interfaces.ts';
import { readJournal } from '../../src/core/log.ts';
import { RUNNER_FILE_READERS, type ResultFile } from '../../src/core/records.ts';
import { type AbsPath, absPath, matchesPattern, repoPath } from '../../src/core/values.ts';
import { candidateRef } from '../../src/git/candidate.ts';
import { git, refTarget, revParse } from '../../src/git/git.ts';
import { snapshotRef, verifySnapshot, witnessDir } from '../../src/git/snapshot.ts';
import { verdictOf } from '../../src/holistic/observe.ts';
import { type Obligations, type ObservationVerdict, isExempt, parseObligations, witnessRecord } from '../../src/holistic/types.ts';
import { WITNESS_RECORD_FILE } from '../../src/holistic/witness.ts';
import { OBLIGATIONS_INPUT, keptInput, requirePlanInForce } from '../../src/input/inforce.ts';
import { type PlanM1, parsePlan } from '../../src/input/plan.ts';
import { readNeedsUser } from '../../src/needsuser.ts';
import { pendingCommandIds, readCommand } from '../../src/commands/queue.ts';
import { DEBT_DOC } from '../../src/docs/debt.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { MODEL_IDS } from '../../src/routing/types.ts';
import { parseSpec } from '../../src/spec/spec.ts';
import type { Report } from './driver.ts';
import { LENSES, MAIN, MONEY_LANE, type StoryBranch, layout } from './layout.ts';

type Verdict = Readonly<{ pass: boolean; detail: string }>;
export type Criterion = Readonly<{ name: string }> & Verdict;
export type CheckResult = Readonly<{ pass: boolean; branch: StoryBranch | null; criteria: readonly Criterion[]; notExercised: readonly Branch[]; cannotShow: readonly string[] }>;

/** What the paid run leaves untaken (plan "Fixture evals/m3/", not exercised), in the order the report lists them. */
export const BRANCHES = [
  'rule', 'reverse', 'steer', 'merge-in', 'reproduction', 'batch repair', 'per-identity bound', 'owner-request', 'draining', 'real go', 'literal partial bundle',
] as const;
export type Branch = (typeof BRANCHES)[number];

export const CANNOT_SHOW = ['real cgroup containment', 'crash boundaries under real models', 'week-long convergence', 'a model\'s op list (the partial bundle is forced only by fakes)'] as const;

type Run = Readonly<{
  repo: AbsPath;
  input: string;
  runDir: AbsPath;
  arc: ArcId;
  plan: PlanM1;
  obligations: Obligations;
  report: Report;
  events: readonly Event[];
  view: JournalView;
}>;

type Seq<F> = F & { seq: number };
const facts = (run: Run): readonly Fact[] => run.events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const factsOf = <K extends Fact['kind']>(run: Run, kind: K): readonly Seq<Extract<Fact, { kind: K }>>[] =>
  run.events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [{ ...(e.fact as Extract<Fact, { kind: K }>), seq: e.seq }] : []));
const spawnIntents = (run: Run): readonly IntentOf<'proc.spawn'>[] => run.events.flatMap((e) => (e.type === 'intent' && e.kind === 'proc.spawn' ? [e] : []));
const ffIntents = (run: Run): readonly IntentOf<'integration.ff'>[] => run.events.flatMap((e) => (e.type === 'intent' && e.kind === 'integration.ff' ? [e] : []));
const itemReason = (run: Run, id: NeedsUserId): string => readNeedsUser(run.runDir, id)?.reason ?? '(no record)';
const items = (run: Run, reason: string) => run.view.needsUser().filter((n) => itemReason(run, n.id) === reason);
const treeOf = (run: Run, commit: string): string => revParse(run.repo, `${commit}^{tree}`);
const obligation = (run: Run, id: string) => {
  const o = run.obligations.obligations.find((x) => x.id === id);
  if (o === undefined) throw new Error(`no obligation ${id} in force`);
  return o;
};

/** A published integration.ff: its intent, the seq of its done, and whose it was. */
type Publication = Readonly<{ op: OpId; seq: number; old: string; new: string; subject: 'docs' | 'batch' | 'unit'; unit: UnitId | null; pub: string | null }>;

function publications(run: Run): readonly Publication[] {
  const intents = new Map(ffIntents(run).map((i) => [i.op, i]));
  return run.events.flatMap((e): Publication[] => {
    if (e.type !== 'done' || e.kind !== 'integration.ff' || e.outcome.kind !== 'published') return [];
    const i = intents.get(e.op);
    if (i === undefined) throw new Error(`integration.ff ${e.op} done without an intent`);
    const subject = i.expect.subject;
    if (subject === undefined) {
      if (i.parent.type !== 'stage') throw new Error(`the unit ff ${i.op} has no stage parent`);
      return [{ op: i.op, seq: e.seq, old: i.expect.old, new: i.expect.new, subject: 'unit', unit: i.parent.unit, pub: null }];
    }
    return [{ op: i.op, seq: e.seq, old: i.expect.old, new: i.expect.new, subject: subject.type, unit: null, pub: subject.type === 'docs' ? subject.pub : null }];
  });
}
const unitPublication = (run: Run, unit: string): Publication | undefined => publications(run).find((p) => p.unit === unit);

/** The verdict of `id`'s witness in the record a `witnessed` fact names. */
function witnessVerdict(run: Run, f: Extract<Fact, { kind: 'witnessed' }>, id: string): ObservationVerdict {
  const witness = obligation(run, id).witness;
  if (witness === null) throw new Error(`${id} has no witness`);
  const path = join(witnessDir(run.runDir, f), WITNESS_RECORD_FILE);
  return verdictOf(witnessRecord(JSON.parse(readFileSync(path, 'utf8')), path), witness);
}

const laneOf = (run: Run, id: string): string => {
  const w = obligation(run, id).witness;
  if (w === null) throw new Error(`${id} has no witness`);
  return w.lane;
};

/** The P1 over I-2 that code opened on an audit snapshot (`lens: witness`). */
const moneyP1 = (run: Run) => factsOf(run, 'finding-opened').find((f) => f.lens === 'witness' && f.severity === 'P1' && f.obligation === 'I-2');

/** Every bundle revision, in log order. */
const bundleRevisions = (run: Run) => factsOf(run, 'plan-applied').filter((f) => f.source?.type === 'bundle');

/** The units bundle revisions added, with the revision that added each. */
const addedUnits = (run: Run) => bundleRevisions(run).flatMap((b) => b.changes.flatMap((c) => (c.type === 'unit-added' ? [{ unit: c.unit, rev: b }] : [])));

/** A unit's spec in force (its latest recorded spec). */
function specOf(run: Run, unit: UnitId) {
  const spec = run.view.unit(unit).spec;
  if (spec === null) throw new Error(`${unit} has no recorded spec`);
  return parseSpec(readFileSync(join(run.runDir, 'inputs', `${spec.sha256}.spec.json`)), `${unit}.json` as never);
}

/** The changes by which a bundle revision disposes of tidy (branch P). */
const DISPOSALS: readonly string[] = ['unit-cut', 'unit-changed', 'spec', 'unit-reentered', 'unit-removed'];

/** The witness runs of I-2's lane on tidy's published tree S (none before an audit of S ran it). */
function moneyOnS(run: Run, s: Publication): readonly Seq<Extract<Fact, { kind: 'witnessed' }>>[] {
  const tree = treeOf(run, s.new);
  return factsOf(run, 'witnessed').filter((f) => f.lane === MONEY_LANE && f.treeSha === tree && f.purpose === 'witness');
}

/**
 * The branch the log shows: once tidy published, L when I-2's witness ran on S and held there every time, else R; P
 * when a bundle disposed of tidy unpublished; else null.
 */
function branchOf(run: Run): Readonly<{ branch: StoryBranch; detail: string }> | null {
  const pub = unitPublication(run, 'tidy');
  if (pub !== undefined) {
    const onS = moneyOnS(run, pub);
    if (onS.length > 0 && onS.every((f) => witnessVerdict(run, f, 'I-2') === 'held')) {
      return { branch: 'L', detail: `tidy published ${pub.new}, and I-2 is held there (seq ${onS.map((f) => f.seq).join(', ')})` };
    }
    return { branch: 'R', detail: `tidy published ${pub.new}, and I-2 is not shown held there` };
  }
  for (const b of bundleRevisions(run)) {
    const d = b.changes.find((x) => DISPOSALS.includes(x.type) && 'unit' in x && x.unit === 'tidy');
    if (d !== undefined && b.source?.type === 'bundle') return { branch: 'P', detail: `${b.source.job}'s revision ${b.rev} made ${d.type} of tidy, which never published` };
  }
  return null;
}

/** The checkpoint that ran on audit `job`, and its decision (`applied` for a bundle revision). */
function checkpointOf(run: Run, job: string): Readonly<{ job: string; decision: string }> | null {
  const inputs = factsOf(run, 'checkpoint-inputs').filter((f) => f.trigger.type === 'audit' && f.trigger.job === job);
  const last = inputs.at(-1);
  if (last === undefined) return null;
  const decided = factsOf(run, 'bundle-decided').find((f) => f.job === last.job);
  if (decided !== undefined) return { job: last.job, decision: decided.outcome.kind === 'rejected' ? `rejected:${decided.outcome.reason}` : decided.outcome.kind };
  return factsOf(run, 'plan-applied').some((f) => f.source?.type === 'bundle' && f.source.job === last.job) ? { job: last.job, decision: 'applied' } : { job: last.job, decision: 'undecided' };
}

const verdict = (problems: readonly string[], ok: string): Verdict => ({ pass: problems.length === 0, detail: problems.length > 0 ? problems.join('; ') : ok });

// ---------------------------------------------------------------------------------------------------
// M3 criteria

function baseline(run: Run): Verdict {
  const problems: string[] = [];
  const firstDispatch = factsOf(run, 'dispatch')[0]?.seq ?? Infinity;
  const witnessed = factsOf(run, 'witnessed').filter((f) => f.for.type === 'job' && f.for.job.startsWith('baseline-') && f.seq < firstDispatch);
  const tree = treeOf(run, run.plan.baseline);
  const lanes = new Set(witnessed.filter((f) => f.treeSha === tree).map((f) => f.lane as string));
  for (const l of run.obligations.lanes) if (!lanes.has(l.id)) problems.push(`lane ${l.id} not witnessed on the baseline before the first dispatch`);
  const expect: Readonly<Record<string, ObservationVerdict>> = { 'I-1': 'not-held', 'I-2': 'held', 'I-3': 'held' };
  for (const [id, want] of Object.entries(expect)) {
    const f = witnessed.find((w) => w.lane === laneOf(run, id) && w.treeSha === tree);
    if (f !== undefined && witnessVerdict(run, f, id) !== want) problems.push(`${id} is ${witnessVerdict(run, f, id)} on the baseline, not ${want}`);
  }
  if (items(run, 'obligation-baseline').length > 0) problems.push('an obligation-baseline item was raised');
  return verdict(problems, `${witnessed.length} baseline witness runs on ${tree}, before the first dispatch (seq ${firstDispatch})`);
}

function regressionUnselected(run: Run): Verdict {
  const problems: string[] = [];
  const approval = factsOf(run, 'approval').filter((f) => f.unit === 'tidy').at(-1);
  const selected = (approval?.fingerprint.obligationRevs ?? []).map((o) => o.id as string);
  if (approval === undefined) problems.push('tidy has no approval');
  else if (!selected.includes('I-3') || selected.includes('I-2')) problems.push(`tidy's approval selected ${JSON.stringify(selected)}: I-3 and not I-2 expected`);
  const s = unitPublication(run, 'tidy');
  if (s === undefined) return verdict([...problems, 'tidy never published'], '');
  const tree = treeOf(run, s.new);
  const onS = factsOf(run, 'witnessed').filter((f) => f.lane === MONEY_LANE && f.treeSha === tree && f.purpose === 'witness');
  if (onS.length === 0) problems.push(`I-2's lane never ran on tidy's tree ${tree}`);
  for (const f of onS) if (witnessVerdict(run, f, 'I-2') !== 'not-held') problems.push(`I-2 is ${witnessVerdict(run, f, 'I-2')} on S (seq ${f.seq})`);
  const onCandidate = factsOf(run, 'witnessed').filter((f) => f.lane === MONEY_LANE && f.for.type === 'candidate' && f.for.unit === 'tidy');
  if (onCandidate.length > 0) problems.push('tidy\'s candidate ran I-2\'s lane: it was selected');
  return verdict(problems, `tidy selected ${JSON.stringify(selected)}; published S = ${s.new}; I-2 not held there`);
}

function auditRace(run: Run): Verdict {
  const problems: string[] = [];
  const [a1] = factsOf(run, 'audit-started');
  const s = unitPublication(run, 'tidy');
  const r = unitPublication(run, 'report');
  if (a1 === undefined || s === undefined || r === undefined) return { pass: false, detail: `audit ${a1?.job}, tidy ${s?.new}, report ${r?.new}: missing` };
  const ended = factsOf(run, 'audit-ended').find((f) => f.job === a1.job);
  if (JSON.stringify(a1.lenses) !== JSON.stringify(LENSES)) problems.push(`${a1.job} ran ${JSON.stringify(a1.lenses)}, not L`);
  if (a1.integrationSha !== s.new) problems.push(`${a1.job} audited ${a1.integrationSha}, not S ${s.new}`);
  if (ended === undefined || ended.outcome !== 'completed') problems.push(`${a1.job} did not complete`);
  if (!(r.seq > a1.seq && ended !== undefined && r.seq < ended.seq)) problems.push(`report published at seq ${r.seq}, not inside ${a1.job} (${a1.seq}..${ended?.seq})`);
  const latch = factsOf(run, 'obligation-latched').find((f) => f.obligation === 'I-1');
  if (latch === undefined || latch.unit !== 'report' || latch.seq < r.seq) problems.push(`I-1 latched ${JSON.stringify(latch)}, not by report after its publication`);
  const p1 = moneyP1(run);
  if (p1 === undefined || p1.source.type !== 'job' || p1.source.job !== a1.job) problems.push(`no P1 over I-2 opened by ${a1.job}: ${JSON.stringify(p1)}`);
  const s2 = treeOf(run, r.new);
  const rewitness = factsOf(run, 'witnessed').find((f) => f.lane === MONEY_LANE && f.for.type === 'job' && f.for.job === a1.job && f.treeSha === s2);
  if (rewitness === undefined) problems.push(`${a1.job} did not re-witness I-2 on S′ ${r.new}`);
  else if (witnessVerdict(run, rewitness, 'I-2') !== 'not-held') problems.push(`the re-witness on S′ is ${witnessVerdict(run, rewitness, 'I-2')}`);
  return verdict(problems, `${a1.job} on S ${s.new}; report published S′ ${r.new} at seq ${r.seq} inside it; I-1 latched; ${p1?.id} opened and re-witnessed on S′`);
}

function staleWhole(run: Run): Verdict {
  const [first] = factsOf(run, 'checkpoint-inputs');
  const apply = run.report.devices.staleApply;
  if (first === undefined || apply === null) return { pass: false, detail: `first checkpoint ${first?.job}, stale apply ${JSON.stringify(apply)}` };
  const problems: string[] = [];
  const decided = factsOf(run, 'bundle-decided').find((f) => f.job === first.job);
  if (decided === undefined || decided.outcome.kind !== 'rejected' || decided.outcome.reason !== 'stale') problems.push(`${first.job} decided ${JSON.stringify(decided?.outcome)}, not rejected{stale}`);
  const committed = factsOf(run, 'plan-applied').find((f) => f.source?.type === 'command' && f.source.command === apply.command);
  if (committed === undefined) problems.push(`the driver's apply ${apply.command} committed no revision`);
  else if (decided !== undefined && !(committed.seq > first.seq && committed.seq < decided.seq)) problems.push(`the apply's revision (seq ${committed.seq}) is not between ${first.job}'s capture (${first.seq}) and decision (${decided.seq})`);
  if (factsOf(run, 'plan-applied').some((f) => f.source?.type === 'bundle' && f.source.job === first.job)) problems.push(`${first.job}'s bundle applied`);
  return verdict(problems, `${first.job} captured at seq ${first.seq}; the apply's revision ${committed?.rev} at seq ${committed?.seq}; rejected stale at seq ${decided?.seq}`);
}

function bundlesWhole(run: Run): Verdict {
  const problems: string[] = [];
  const applied = bundleRevisions(run);
  for (const d of factsOf(run, 'bundle-decided')) {
    if (applied.some((f) => f.source?.type === 'bundle' && f.source.job === d.job)) problems.push(`${d.job} decided ${d.outcome.kind} and applied`);
  }
  if (applied.length === 0) problems.push('no bundle revision');
  const held = new Map(run.report.status.nowTrue.map((o) => [o.obligation as string, o.verdict]));
  const lines: string[] = [];
  for (const { unit, rev } of addedUnits(run)) {
    const u = run.view.unit(unit);
    if (u.status !== 'retired') {
      problems.push(`${unit} (added by revision ${rev.rev}) is ${u.status} at ${u.stage}, not merged`);
      continue;
    }
    const spec = specOf(run, unit);
    for (const r of spec.repairs ?? []) {
      if (r.startsWith('I-')) {
        if (held.get(r) !== 'held') problems.push(`${unit} repairs ${r}, which is ${held.get(r) ?? 'absent'} on the head`);
        continue;
      }
      const last = factsOf(run, 'finding-transition').filter((t) => t.id === r).at(-1);
      if (last === undefined || (last.to.state !== 'resolved' && last.to.state !== 'ruled')) problems.push(`${unit} repairs ${r}, which ended ${last?.to.state ?? 'open'}`);
    }
    for (const o of spec.obligations ?? []) if (held.get(o) !== 'held') problems.push(`${unit} serves ${o}, which is ${held.get(o) ?? 'absent'} on the head`);
    lines.push(`${unit} (rev ${rev.rev}, repairs ${JSON.stringify(spec.repairs ?? [])}) merged`);
  }
  const requests = run.report.devices.acks.filter((a) => a.reason === 'bundle-request');
  const answered = requests.map((a) => `${a.needsUser}:${a.choice ?? 'ack'}`).join(', ');
  return verdict(problems, `bundle revisions ${applied.map((b) => b.rev).join(', ')}; ${lines.join('; ') || 'no unit added'}; ${factsOf(run, 'bundle-decided').length} decided bundles applied nothing; ${requests.length} bundle requests answered by the driver${requests.length === 0 ? '' : ` (${answered})`} (informational)`);
}

function bundleDivergences(run: Run): Verdict {
  const problems: string[] = [];
  let v2 = false;
  for (const b of bundleRevisions(run)) {
    if (b.source?.type !== 'bundle') continue;
    const job = b.source.job;
    const ds = factsOf(run, 'divergence').filter((d) => d.job === job);
    if (ds.length === 0) problems.push(`${job}'s revision ${b.rev} recorded no divergence`);
    if (ds.some((d) => d.cites.includes('V-2' as never))) v2 = true;
  }
  if (!v2) problems.push('no bundle divergence cites V-2');
  const all = factsOf(run, 'divergence').map((d) => `${d.id} ${d.type} [${d.cites.join(', ')}]`);
  return verdict(problems, all.join('; '));
}

function prevention(run: Run): Verdict {
  const b = branchOf(run);
  if (b?.branch !== 'P') return { pass: false, detail: `not branch P: ${b?.detail ?? 'no branch'}` };
  const problems: string[] = [];
  const disposer = bundleRevisions(run).find((r) => r.changes.some((x) => DISPOSALS.includes(x.type) && 'unit' in x && x.unit === 'tidy'));
  const job = disposer?.source?.type === 'bundle' ? disposer.source.job : null;
  const ds = factsOf(run, 'divergence').filter((d) => d.job === job);
  if (ds.length === 0) problems.push(`${job}'s disposal of tidy recorded no divergence`);
  const upstream = factsOf(run, 'stage-outcome').filter((o) => o.unit === 'tidy').map((o) => `${o.stage}:${o.outcome}`);
  return verdict(problems, `${b.detail}; tidy's outcomes ${upstream.join(', ')}; divergences ${ds.map((d) => d.id).join(', ')}`);
}

function branchMatches(run: Run): Verdict {
  const b = branchOf(run);
  const recorded = run.report.devices.branch?.branch ?? null;
  if (b === null) return { pass: false, detail: `the log shows no branch (driver recorded ${recorded})` };
  return { pass: b.branch === recorded, detail: `branch ${b.branch}: ${b.detail}; the driver recorded ${recorded}` };
}

function divergenceDigestBound(run: Run): Verdict {
  const problems: string[] = [];
  const bound = new Set<string>();
  const digests = factsOf(run, 'divergence-digest');
  for (const g of digests) {
    // The binding is a set: compared sorted, with the executor's own comparator (string order: D-10 before D-9).
    const expected = factsOf(run, 'divergence').filter((d) => d.seq < g.seq && !bound.has(d.id)).map((d) => d.id as string).sort();
    if (JSON.stringify([...g.ids].sort()) !== JSON.stringify(expected)) problems.push(`digest ${g.needsUser} binds ${JSON.stringify(g.ids)}, not ${JSON.stringify(expected)}`);
    for (const id of g.ids) bound.add(id);
  }
  const acks = run.report.devices.acks;
  if (digests.length === 0) problems.push('no digest was raised');
  // A digest raised in the arc's last turns may be acknowledged only after the arc completed: the driver's ack is then
  // a command no executor is left to apply (`afterCompletion`). Its ids stay uncovered, and that is the only way they may.
  const late = new Set<string>();
  for (const g of digests) {
    if (!acks.some((a) => a.needsUser === g.needsUser && a.reason === 'divergence-digest')) problems.push(`the driver did not acknowledge the digest ${g.needsUser}`);
    else if (run.view.needsUser().find((n) => n.id === g.needsUser)?.ack == null) {
      if (afterCompletion(run, g.needsUser)) for (const id of g.ids) late.add(id);
      else problems.push(`${g.needsUser} is not acknowledged`);
    }
  }
  const uncovered = run.report.status.divergences.map((d) => d.id).filter((id) => !late.has(id));
  if (uncovered.length > 0) problems.push(`uncovered divergences ${JSON.stringify(uncovered)}`);
  if (factsOf(run, 'divergence').length === 0) problems.push('no divergence recorded');
  return verdict(problems, `${digests.length} digests: ${digests.map((x) => `${x.needsUser} [${x.ids.join(', ')}]`).join('; ')}; each acknowledged by the driver${late.size > 0 ? ` (${[...late].join(', ')} after completion)` : ''}`);
}

/** The driver's ack of `needsUser` was queued after `arc-completed`: no executor ran to apply it. */
function afterCompletion(run: Run, needsUser: string): boolean {
  const done = run.events.findLast((e) => e.type === 'fact' && e.fact.kind === 'arc-completed');
  if (done === undefined) return false;
  const ack = run.report.devices.acks.find((a) => a.needsUser === needsUser);
  if (ack === undefined) return false;
  const file = join(run.runDir, 'commands', 'incoming', `${ack.ack}.json`);
  return existsSync(file) && statSync(file).mtimeMs > Date.parse(done.at);
}

function convergenceBound(run: Run): Verdict {
  const raised = items(run, 'convergence-bound');
  const acks = run.report.devices.acks;
  const problems: string[] = [];
  if (raised.length === 0) problems.push('no convergence-bound item was raised');
  for (const item of raised) {
    if (!acks.some((a) => a.needsUser === item.id && a.reason === 'convergence-bound') || item.ack === null) problems.push(`${item.id} is not acknowledged by the driver`);
  }
  return verdict(problems, `${raised.map((n) => n.id).join(', ')} raised, each acknowledged by the driver`);
}

function repairResolved(run: Run): Verdict {
  const problems: string[] = [];
  const p1Id = moneyP1(run)?.id;
  const repair = addedUnits(run).map((a) => a.unit).find((u) => (specOf(run, u).repairs ?? []).some((r) => r === p1Id || r === 'I-2')) ?? null;
  if (repair === null) return { pass: false, detail: `no added unit repairs the I-2 P1 (${p1Id}) or I-2` };
  const pub = unitPublication(run, repair);
  if (pub === undefined) problems.push(`${repair} never published`);
  const p1 = moneyP1(run);
  const resolved = factsOf(run, 'finding-transition').find((t) => t.id === p1?.id && t.to.state === 'resolved');
  if (p1 === undefined || resolved === undefined) problems.push(`the P1 over I-2 (${p1?.id}) was not resolved`);
  const i2 = run.report.status.nowTrue.find((o) => o.obligation === 'I-2');
  if (i2?.verdict !== 'held') problems.push(`I-2 is ${i2?.verdict ?? 'absent'} on the head`);
  return verdict(problems, `${repair} published ${pub?.new}; ${p1?.id} resolved at seq ${resolved?.seq}; I-2 held`);
}

/**
 * Branch L: an audit of S opened lens findings over I-2 (the witness held there, so code opened none); a bundle admitted
 * a unit repairing them (or I-2), it merged, the findings it names were resolved, and I-2 holds on the head.
 */
function latentRepair(run: Run): Verdict {
  const s = unitPublication(run, 'tidy');
  if (s === undefined) return { pass: false, detail: 'tidy never published' };
  const audits = new Set(factsOf(run, 'audit-started').filter((a) => a.integrationSha === s.new).map((a) => a.job as string));
  const found = factsOf(run, 'finding-opened').filter((f) => f.obligation === 'I-2' && f.lens !== 'witness' && f.source.type === 'job' && audits.has(f.source.job));
  if (found.length === 0) return { pass: false, detail: `no lens finding over I-2 opened by an audit of S ${s.new} (${[...audits].join(', ') || 'none'})` };
  const ids = new Set(found.map((f) => f.id as string));
  const repair = addedUnits(run).map((a) => a.unit).find((u) => (specOf(run, u).repairs ?? []).some((r) => ids.has(r) || r === 'I-2')) ?? null;
  if (repair === null) return { pass: false, detail: `no added unit repairs ${[...ids].join(', ')} or I-2` };
  const problems: string[] = [];
  const pub = unitPublication(run, repair);
  if (pub === undefined) problems.push(`${repair} never published`);
  const named = (specOf(run, repair).repairs ?? []).filter((r) => ids.has(r));
  for (const id of named) {
    if (!factsOf(run, 'finding-transition').some((t) => t.id === id && t.to.state === 'resolved')) problems.push(`${id} was not resolved`);
  }
  const i2 = run.report.status.nowTrue.find((o) => o.obligation === 'I-2');
  if (i2?.verdict !== 'held') problems.push(`I-2 is ${i2?.verdict ?? 'absent'} on the head`);
  return verdict(problems, `lens findings ${found.map((f) => `${f.id} (${f.lens}, ${f.severity})`).join(', ')} on S ${s.new}; ${repair} repairs ${JSON.stringify(named)}, published ${pub?.new}; resolved; I-2 held`);
}

/**
 * The lenses an audit's coalesced triggers require (src/holistic/cadence.ts): drift L ∩ {drift, vision} (here the vision
 * lens); cadence, unwitnessed and wall-clock all of L; a request its lenses ∩ L. `final` adds the lenses still
 * outstanding, which the log does not record: with it, the required set is a floor and L the ceiling.
 */
function requiredLenses(run: Run, triggers: Extract<Fact, { kind: 'audit-started' }>['triggers']): Readonly<{ floor: readonly string[]; exact: boolean }> {
  const out = new Set<string>();
  for (const t of triggers) {
    if (t.type === 'drift') out.add('vision');
    else if (t.type === 'requested') {
      const q = factsOf(run, 'audit-requested').find((f) => f.command === t.command);
      for (const l of LENSES) if (q?.lenses == null || q.lenses.includes(l)) out.add(l);
    } else if (t.type !== 'final') for (const l of LENSES) out.add(l);
  }
  return { floor: LENSES.filter((l) => out.has(l)), exact: !triggers.some((t) => t.type === 'final') };
}

function driftAudit(run: Run): Verdict {
  const revs = new Set(bundleRevisions(run).map((b) => b.rev as number));
  const audit = factsOf(run, 'audit-started').find((a) => a.triggers.some((t) => t.type === 'drift' && revs.has(t.planRev)));
  if (audit === undefined) return { pass: false, detail: `no audit triggered by the drift of bundle revisions ${[...revs].join(', ')}` };
  const problems: string[] = [];
  // A drift trigger alone runs the vision lens; coalesced with a cadence (or other) trigger the audit runs the union.
  const { floor, exact } = requiredLenses(run, audit.triggers);
  const ran: readonly string[] = [...audit.lenses].sort();
  const fits = exact ? JSON.stringify(ran) === JSON.stringify([...floor].sort()) : floor.every((l) => ran.includes(l)) && ran.every((l) => (LENSES as readonly string[]).includes(l));
  if (!ran.includes('vision') || !fits) problems.push(`${audit.job} (${JSON.stringify(audit.triggers)}) ran ${JSON.stringify(audit.lenses)}, not what its triggers require (${exact ? '' : 'at least '}${JSON.stringify(floor)})`);
  if (factsOf(run, 'audit-ended').find((e) => e.job === audit.job)?.outcome !== 'completed') problems.push(`${audit.job} did not complete`);
  const ck = checkpointOf(run, audit.job);
  return verdict(problems, `${audit.job} (${JSON.stringify(audit.triggers)}) ran ${audit.lenses.join(', ')}, as its triggers require; ${ck?.job} ${ck?.decision}`);
}

function finalAudit(run: Run): Verdict {
  const last = factsOf(run, 'audit-started').at(-1);
  if (last === undefined) return { pass: false, detail: 'no audit' };
  const problems: string[] = [];
  if (!last.triggers.some((t) => t.type === 'final')) problems.push(`the last audit ${last.job} was triggered by ${JSON.stringify(last.triggers)}, not final`);
  if (last.lenses.length === 0 || last.lenses.some((x) => !(LENSES as readonly string[]).includes(x))) problems.push(`${last.job} ran ${JSON.stringify(last.lenses)}, not lenses of L`);
  const lastUnit = publications(run).filter((p) => p.subject !== 'docs').at(-1);
  if (lastUnit === undefined || last.integrationSha !== lastUnit.new) problems.push(`${last.job} audited ${last.integrationSha}, not the last unit publication ${lastUnit?.new}`);
  if (factsOf(run, 'audit-ended').find((e) => e.job === last.job)?.outcome !== 'completed') problems.push(`${last.job} did not complete`);
  const ck = checkpointOf(run, last.job);
  if (ck?.decision !== 'no-op') problems.push(`its checkpoint ${ck?.job} decided ${ck?.decision}`);
  return verdict(problems, `${last.job} final on ${last.integrationSha}, ran ${last.lenses.join(', ')}; ${ck?.job} no-op`);
}

/** The executor-rendered `.roadmap/` files a docs-only publication may carry (debt.md: a corpus arc's, M4a). */
const RENDERED: readonly string[] = ['.roadmap/constraints.md', '.roadmap/invariants.md', DEBT_DOC];

function closeOut(run: Run): Verdict {
  const published = factsOf(run, 'docs-published').filter((f) => f.source === 'close-out');
  const [p] = published;
  if (p === undefined || published.length !== 1) return { pass: false, detail: `${published.length} close-out publications` };
  const problems: string[] = [];
  const ff = publications(run).find((x) => x.pub === p.pub);
  if (ff === undefined) return { pass: false, detail: `no published docs ff of ${p.pub}` };
  const changed = git(run.repo, ['diff', '--name-only', ff.old, ff.new]).split('\n').filter((x) => x !== '');
  const beyond = changed.filter((x) => !RENDERED.includes(x));
  if (beyond.length > 0 || changed.length === 0) problems.push(`the close-out changed ${JSON.stringify(changed)}`);
  const covered = factsOf(run, 'docs-covered').find((f) => f.pub === p.pub);
  if (covered === undefined || covered.from !== ff.old || covered.to !== ff.new) problems.push(`docs-covered of ${p.pub}: ${JSON.stringify(covered)}, not ${ff.old}→${ff.new}`);
  return verdict(problems, `${p.pub}: ${ff.old}→${ff.new}, ${changed.join(', ')}; docs-covered its own edge`);
}

function completion(run: Run): Verdict {
  const done = factsOf(run, 'arc-completed');
  const [c] = done;
  if (c === undefined || done.length !== 1) return { pass: false, detail: `${done.length} arc-completed facts` };
  const problems: string[] = [];
  const head = revParse(run.repo, `refs/heads/${run.plan.integrationBranch}`);
  if (c.head !== head) problems.push(`arc-completed head ${c.head} is not the integration head ${head}`);
  if (c.planRev !== run.view.planApplied()?.rev) problems.push(`arc-completed names rev ${c.planRev}, not the plan in force`);
  const units = requirePlanInForce(run.runDir, run.view).plan.units.filter((u) => run.view.unit(u.id).status === 'retired').map((u) => u.id as string).sort();
  if (JSON.stringify([...c.units].sort()) !== JSON.stringify(units)) problems.push(`arc-completed units ${JSON.stringify(c.units)}, not the merged ${JSON.stringify(units)}`);
  const at = refTarget(run.repo, snapshotRef(run.arc));
  const v = at === null ? null : verifySnapshot(run.repo, at);
  if (v === null || v.kind !== 'verified' || v.manifest.highWater < c.seq) problems.push(`the terminal snapshot does not follow arc-completed (seq ${c.seq}): ${v === null ? 'no ref' : v.kind === 'verified' ? `high-water ${v.manifest.highWater}` : v.detail}`);
  // The only command that may be pending is a driver ack queued after the arc completed (see afterCompletion).
  const lateAcks = new Set(run.report.devices.acks.filter((a) => afterCompletion(run, a.needsUser)).map((a) => a.ack));
  const unmet = run.report.status.completion.unmet.filter((u) => u !== 'pending-commands' || !pendingAre(run, lateAcks));
  if (!run.report.status.completion.active || unmet.length > 0) problems.push(`status completion not active and met: ${JSON.stringify(run.report.status.completion)}`);
  return verdict(problems, `arc-completed at seq ${c.seq} on ${c.head}, rev ${c.planRev}; terminal snapshot verified`);
}

function lensCoverage(run: Run): Verdict {
  const audit = run.report.status.audit;
  if (audit === null) return { pass: false, detail: 'status has no audit view' };
  const head = revParse(run.repo, `refs/heads/${run.plan.integrationBranch}`);
  const problems: string[] = [];
  for (const lens of LENSES) {
    const c = audit.coverage.find((x) => x.lens === lens);
    if (c === undefined) problems.push(`${lens}: no coverage`);
    else if (c.coveredTo !== head || c.outstanding || c.pendingDocs.length > 0) problems.push(`${lens}: covered to ${c.coveredTo}, outstanding ${c.outstanding}, pending docs ${JSON.stringify(c.pendingDocs)}`);
  }
  if (audit.uncovered.length > 0) problems.push(`uncovered ${JSON.stringify(audit.uncovered)}`);
  // Mid-arc revisions publish docs edges of their own (a checkpoint's bundle); only the close-out's, after the final
  // audit, must start at its SHA. Status grades the earlier ones (pending only while a gap is open).
  const last = factsOf(run, 'audit-started').at(-1);
  const after = factsOf(run, 'docs-covered').filter((d) => last === undefined || d.seq > last.seq);
  if (after.length === 0) problems.push('no docs edge after the final audit');
  for (const d of after) if (last === undefined || d.from !== last.integrationSha) problems.push(`the docs edge ${d.from}→${d.to} does not start at the final audit's SHA ${last?.integrationSha}`);
  return verdict(problems, `${LENSES.join(', ')} covered to ${head}; docs edge from ${last?.integrationSha}`);
}

function snapshotClosure(run: Run): Verdict {
  const at = refTarget(run.repo, snapshotRef(run.arc));
  if (at === null) return { pass: false, detail: 'no snapshot ref' };
  const v = verifySnapshot(run.repo, at);
  if (v.kind !== 'verified') return { pass: false, detail: v.detail };
  const problems: string[] = [];
  if (v.manifest.files.some((f) => f.namedBy === null)) problems.push('the manifest is an allowlist (no namedBy), not a closure');
  const paths = new Set(v.manifest.files.map((f) => f.path as string));
  for (const f of factsOf(run, 'witnessed')) {
    if (f.seq > v.manifest.highWater) continue;
    const p = `witness/${invocationDirName(f.inv)}.json`;
    if (!paths.has(p)) problems.push(`witness record ${p} (seq ${f.seq}) is not in the snapshot`);
  }
  for (const f of factsOf(run, 'plan-applied')) {
    if (f.payloadSha256 === undefined || f.seq > v.manifest.highWater) continue;
    const p = `inputs/${f.payloadSha256}.revision.json`;
    if (!paths.has(p)) problems.push(`payload ${p} of rev ${f.rev} is not in the snapshot`);
  }
  return verdict(problems, `${v.manifest.files.length} files, every one named by a record; high-water ${v.manifest.highWater}`);
}

/** The obligations in force at the end: the last revision's kept obligations file (checkpoints split and add along the way). */
function obligationsInForce(run: Run): Obligations {
  const sha = factsOf(run, 'plan-applied').at(-1)?.obligationsSha256;
  if (sha === undefined) throw new Error('the last plan-applied names no obligations file');
  const bytes = keptInput(run.runDir, sha, OBLIGATIONS_INPUT);
  if (bytes === null) throw new Error(`the kept obligations file ${sha} is missing`);
  return parseObligations(JSON.parse(bytes.toString('utf8')));
}

function obligationsDischarged(run: Run): Verdict {
  const { nowTrue, notYetTrue } = run.report.status;
  const problems = [
    ...nowTrue.filter((o) => o.verdict !== 'held').map((o) => `${o.obligation} ${o.verdict}`),
    ...notYetTrue.map((o) => `${o.obligation} pending (${o.reason})`),
  ];
  // Every non-exempt obligation in force (split parents through their children, as status grades them) is true.
  const live = obligationsInForce(run).obligations.filter((o) => !isExempt(o)).map((o) => o.id as string).sort();
  const shown = nowTrue.map((o) => o.obligation as string).sort();
  if (live.join() !== shown.join()) problems.push(`true: ${shown.join(', ')}; in force, not exempt: ${live.join(', ')}`);
  return verdict(problems, `${nowTrue.map((o) => `${o.obligation} ${o.verdict}`).join(', ')}: every non-exempt obligation in force`);
}

// ---------------------------------------------------------------------------------------------------
// M1/M2 standing criteria over this run

function runEnded(run: Run): Verdict {
  const { endedBy, start, generation, exit } = run.report;
  const pass = endedBy === 'exit' && start.code === 0 && exit !== null && exit.kind === 'complete';
  return { pass, detail: `endedBy=${endedBy} start=${start.code} generation=${generation} reason=${JSON.stringify(exit)}${run.report.devices.failed === null ? '' : ` device failed: ${run.report.devices.failed}`}` };
}

function unitsSettled(run: Run): Verdict {
  const plan = requirePlanInForce(run.runDir, run.view).plan;
  const problems: string[] = [];
  const disposed = new Set(bundleRevisions(run).flatMap((b) => b.changes.flatMap((c) => (c.type === 'unit-cut' ? [c.unit as string] : []))));
  const lines: string[] = [];
  for (const unit of plan.units) {
    const u = run.view.unit(unit.id);
    if (u.status === 'retired') lines.push(`${unit.id} merged`);
    else if ((u.status === 'cut' && disposed.has(unit.id)) || (u.status === 'superseded' && u.supersededBy !== null && run.view.unit(u.supersededBy).status === 'retired')) lines.push(`${unit.id} ${u.status}`);
    else problems.push(`${unit.id}: ${u.status} at ${u.stage}`);
  }
  return verdict(problems, lines.join(', '));
}

function headIsPublication(run: Run): Verdict {
  const integration = revParse(run.repo, `refs/heads/${run.plan.integrationBranch}`);
  const last = publications(run).at(-1);
  if (last === undefined) return { pass: false, detail: 'nothing published' };
  const problems: string[] = [];
  if (integration !== last.new) problems.push(`integration ${integration} is not the last publication's ${last.new}`);
  if (revParse(run.repo, `${integration}^1`) !== last.old) problems.push(`head^1 is not T ${last.old}`);
  if (last.subject === 'unit' && last.unit !== null) {
    const approval = factsOf(run, 'approval').filter((f) => f.unit === last.unit).at(-1);
    if (revParse(run.repo, `${integration}^2`) !== approval?.fingerprint.unitCommit) problems.push(`head^2 is not ${last.unit}'s approved commit`);
    if (treeOf(run, integration) !== treeOf(run, candidateRef(run.arc, last.unit))) problems.push('head tree is not the candidate ref\'s tree');
  } else if (git(run.repo, ['rev-list', '--parents', '-n', '1', integration]).split(' ').length !== 2) {
    problems.push('the docs commit is not a single-parent commit on T');
  }
  return verdict(problems, `integration ${integration} = the ${last.subject} publication ${last.op}`);
}

/**
 * The arc's diff is product inside the scopes in force plus the living docs: every changed path matches the scope of
 * some unit of the plan in force (bundle-admitted units included; its plan scope or its latest spec's scope, so a
 * ruled growth counts) or is a living `.roadmap/` doc, and the close-out put the rendered docs in it.
 */
function diffProductAndDocs(run: Run): Verdict {
  const units = requirePlanInForce(run.runDir, run.view).plan.units;
  const scopes = units.flatMap((u) => {
    const spec = run.view.unit(u.id).spec === null ? null : specOf(run, u.id);
    return [...u.scope, ...(spec?.scope ?? [])].map((pattern) => ({ unit: u.id as string, pattern }));
  });
  const paths = git(run.repo, ['diff', '--name-only', `${MAIN}...${run.plan.integrationBranch}`]).split('\n').filter((p) => p !== '');
  const problems: string[] = [];
  const owned: string[] = [];
  for (const p of paths) {
    if (RENDERED.includes(p) || p.startsWith('.roadmap/contracts/')) continue;
    const by = scopes.find((x) => matchesPattern(repoPath(p), x.pattern));
    if (by === undefined) problems.push(`${p}: no scope in force matches it (units ${units.map((u) => u.id).join(', ')}), and it is no living .roadmap doc`);
    else owned.push(`${p} (${by.unit})`);
  }
  if (!paths.some((p) => RENDERED.includes(p))) {
    const closeOut = factsOf(run, 'docs-published').some((f) => f.source === 'close-out');
    problems.push(`no rendered living doc (${RENDERED.join(', ')}) in the diff: ${closeOut ? 'the close-out publication changed neither' : 'no close-out publication happened'}`);
  }
  return verdict(problems, `${owned.join(', ')}; living docs ${paths.filter((p) => RENDERED.includes(p) || p.startsWith('.roadmap/contracts/')).join(', ')}`);
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

const JUDGMENT_ROLES: ReadonlySet<string> = new Set(['planCheck', 'gate', 'lens', 'checkpoint']);

/** The role of a backend call (a unit's, a job's, or a smoke's), else null. */
function backendRole(i: IntentOf<'proc.spawn'>): string | null {
  const s = i.expect.subject;
  if (s.purpose === 'backend' || s.purpose === 'arc-backend') return s.role;
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
  const roles = new Set<string>();
  for (const i of spawnIntents(run)) {
    const role = backendRole(i);
    if (role === null || !JUDGMENT_ROLES.has(role) || i.expect.subject.purpose === 'smoke') continue;
    roles.add(role);
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
  for (const r of JUDGMENT_ROLES) if (!roles.has(r)) problems.push(`no ${r} call`);
  return verdict(problems, `${seen.size} judgment invocations (${[...roles].sort().join(', ')}), ${seen.size} distinct fresh sessions`);
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
  const arc = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'arc-backend').length;
  if (arc === 0) problems.push('no lens or checkpoint call');
  return verdict(problems, `${backend.size} backend invocations (${arc} lens or checkpoint), one usage fact each`);
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

type Grade = readonly [string, (run: Run) => Verdict];

const COMMON: readonly Grade[] = [
  ['baseline', baseline],
  ['branch', branchMatches],
  ['stale-whole', staleWhole],
  ['bundles-whole', bundlesWhole],
  ['bundle-divergences', bundleDivergences],
  ['divergence-digest-bound', divergenceDigestBound],
  ['convergence-bound', convergenceBound],
  ['drift-audit', driftAudit],
  ['final-audit', finalAudit],
  ['close-out', closeOut],
  ['completion', completion],
  ['lens-coverage', lensCoverage],
  ['snapshot-closure', snapshotClosure],
  ['obligations-discharged', obligationsDischarged],
  ['run-ended', runEnded],
  ['units-settled', unitsSettled],
  ['head-is-publication', headIsPublication],
  ['diff-product-and-docs', diffProductAndDocs],
  ['snapshot-verifies', snapshotVerifies],
  ['judgment-fresh', judgmentFresh],
  ['meter-covers-calls', meterCoversCalls],
  ['no-model-ids', noModelIds],
];

/** Each branch's own criteria, after the common ones. */
const BRANCH_CRITERIA: Readonly<Record<StoryBranch, readonly Grade[]>> = {
  R: [['regression-unselected', regressionUnselected], ['audit-race', auditRace], ['repair-resolved', repairResolved]],
  P: [['prevention', prevention]],
  L: [['latent-repair', latentRepair]],
};

// ---------------------------------------------------------------------------------------------------
// What the run did not exercise

/** The ops of checkpoint `job`'s consumed answer. */
function checkpointOps(run: Run, job: string): readonly unknown[] {
  const call = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'arc-backend' && i.expect.subject.job === job).at(-1);
  const result = call === undefined ? null : resultOf(run, call);
  if (result === null || result.type !== 'backend' || result.outcome.kind !== 'success') return [];
  return ((result.outcome.value as { ops?: unknown[] }).ops) ?? [];
}

function exercised(run: Run): ReadonlySet<Branch> {
  const out = new Set<Branch>();
  const applied = factsOf(run, 'plan-applied');
  for (const [i, f] of applied.entries()) {
    const prev = applied[i - 1];
    if (f.source?.type !== 'command') continue;
    if (prev !== undefined && f.rulingsSha256 !== undefined && f.rulingsSha256 !== prev.rulingsSha256) out.add('rule');
    if (readCommand(run.runDir, f.source.command as CommandId, run.arc).file.body.type === 'reverse') out.add('reverse');
  }
  if (factsOf(run, 'steered').length > 0) out.add('steer');
  if (factsOf(run, 'merged-in').length > 0) out.add('merge-in');
  if (factsOf(run, 'stage-outcome').some((f) => f.stage === 'reproduce')) out.add('reproduction');
  if (run.events.some((e) => e.type === 'intent' && e.kind === 'candidate.merge' && e.expect.batch !== undefined)) out.add('batch repair');
  if (items(run, 'convergence-identity').length > 0) out.add('per-identity bound');
  if (items(run, 'owner-request').length > 0) out.add('owner-request');
  if (factsOf(run, 'admissions-closed').length > 0) out.add('draining');
  const goLanes = new Set(run.obligations.lanes.filter((l) => l.reporter === 'go-test-json').map((l) => l.id as string));
  if (factsOf(run, 'witnessed').some((f) => goLanes.has(f.lane))) out.add('real go');
  for (const d of factsOf(run, 'bundle-decided')) {
    if (d.outcome.kind === 'rejected' && d.outcome.reason === 'invalid' && checkpointOps(run, d.job).length >= 2) out.add('literal partial bundle');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------

export function check(dir: string): CheckResult {
  const l = layout(dir);
  if (!existsSync(l.report)) throw new Error(`${l.report} is missing: run evals/m3/driver.ts first`);
  const report = JSON.parse(readFileSync(l.report, 'utf8')) as Report;
  const plan = parsePlan(JSON.parse(readFileSync(l.plan, 'utf8')));
  if (plan.arc !== l.arc) throw new Error(`${l.plan} names arc ${plan.arc}, but the fixture dir ${dir} is arc ${l.arc}: was it moved after setup?`);
  const arc = arcId(plan.arc);
  const runDir = absPath(l.runDir);
  const { view, events } = readJournal(runDir, arc);
  const obligations = parseObligations(JSON.parse(readFileSync(l.obligations, 'utf8')));
  const run: Run = { repo: absPath(l.repo), input: l.input, runDir, arc, plan, obligations, report, events, view };
  const branch = branchOf(run)?.branch ?? null;
  const criteria = [...COMMON, ...(branch === null ? [] : BRANCH_CRITERIA[branch])].map(([name, grade]): Criterion => {
    try {
      const v = grade(run);
      return { name, pass: v.pass, detail: v.detail };
    } catch (error) {
      return { name, pass: false, detail: `threw: ${(error as Error).message}` };
    }
  });
  const done = exercised(run);
  return { pass: criteria.every((c) => c.pass), branch, criteria, notExercised: BRANCHES.filter((b) => !done.has(b)), cannotShow: CANNOT_SHOW };
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m3/check.ts <dir>');
  const result = check(resolve(dir));
  const list = (xs: readonly string[]): string => (xs.length === 0 ? '(none)' : xs.join(', '));
  process.stdout.write(`${JSON.stringify(result)}\nNOT EXERCISED: ${list(result.notExercised)}\nCANNOT SHOW: ${list(result.cannotShow)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}

/** Every pending command is one of `ids`. */
function pendingAre(run: Run, ids: ReadonlySet<string>): boolean {
  return pendingCommandIds(run.runDir).every((id) => ids.has(id));
}
