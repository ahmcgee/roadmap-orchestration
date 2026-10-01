// The M3 paid fixture, step 3: `node evals/m3/check.ts <dir>` grades a finished run (setup → driver) from the log,
// the repo, the run dir and report.json. Agent-facing output: one JSON line `{pass, criteria[{name, pass, detail}],
// notExercised[], cannotShow[]}`, then the two lists as lines. Exits 1 when any criterion fails.
//
// M3 criteria (plan "Fixture evals/m3/", the story's steps in brackets):
//   baseline                the baseline job witnessed every arc lane on the baseline before any unit was dispatched,
//                           and raised no `obligation-baseline`: I-2 and I-3 held, I-1 not
//   regression-unselected   [2] tidy's approval selected I-3 and not I-2; I-2 not held on the tree tidy published (S)
//   audit-race              [3] the first audit ran L on S; report published inside it (S′) and latched I-1; the audit's
//                           code opened a P1 over I-2, and re-witnessed I-2 on S′ (not held)
//   stale-whole             [4] the first checkpoint was rejected stale whole: the driver's apply committed between its
//                           capture and its decision, and nothing of its bundle applied
//   bundles-whole           every bundle decided rejected or requested applied nothing; exactly one bundle revision,
//                           adding one unit of origin `repair` whose spec repairs I-2's P1
//   repair-divergence       [5] the bundle revision recorded a `plan-departed` divergence citing V-2
//   divergence-digest-bound [5] each digest binds exactly the divergences recorded before it that no earlier digest
//                           bound; the driver acknowledged the story's digest; none is left uncovered
//   convergence-bound       [6] K = 1: `convergence-bound` was raised once the bundle applied, and acknowledged
//   repair-resolved         [7] the repair merged, the P1 over I-2 was resolved, and I-2 holds on the head
//   drift-audit             [8] an audit triggered by the bundle revision's drift ran the vision lens alone; its
//                           checkpoint no-oped
//   final-audit             [9] the last audit was `final`, ran every lens of L on the last unit publication's head;
//                           its checkpoint no-oped
//   close-out               [10] the close-out publication is docs-only (the rendered `.roadmap/` files) and records
//                           `docs-covered` for its own edge
//   completion              [11] `arc-completed` names the plan in force, the head and every unit; then the terminal
//                           snapshot (its high-water past the completion); status shows the completion active
//   lens-coverage           every lens of L has a contiguous watermark at the final head (status.audit), the docs edge
//                           applied only from the final audit's SHA, nothing outstanding
//   snapshot-closure        the terminal ref verifies as a closure (every file named by a record), and carries each
//                           witness record and each kept revision payload the log names
//   obligations-discharged  status: every obligation holds on the head, none pending
// M1/M2 standing criteria, over this run:
//   run-ended (complete), units-settled, head-is-publication (the head is the last publication's commit: a unit's
//   tested candidate or the docs commit), diff-product-and-docs (units' scopes plus the living `.roadmap/` docs,
//   constraints.md and invariants.md included), snapshot-verifies, judgment-fresh (plan-check, gate, lens and
//   checkpoint calls), meter-covers-calls (unit and arc calls), no-model-ids
//
// The non-exercised list names what this run's journal shows no trace of, from: rule, reverse, steer, merge-in,
// reproduction, batch repair, per-identity bound, owner-request, draining, real go, literal partial bundle. The paid
// run takes none of them (the fake story takes the literal partial bundle); each has a fake integrated test.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Event, Fact, IntentOf } from '../../src/core/events.ts';
import { type ArcId, type CommandId, type NeedsUserId, type OpId, type UnitId, arcId, invocationDirName, invocationId } from '../../src/core/ids.ts';
import type { JournalView } from '../../src/core/interfaces.ts';
import { readJournal } from '../../src/core/log.ts';
import { RUNNER_FILE_READERS, type ResultFile } from '../../src/core/records.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import { candidateRef } from '../../src/git/candidate.ts';
import { git, refTarget, revParse } from '../../src/git/git.ts';
import { snapshotRef, verifySnapshot, witnessDir } from '../../src/git/snapshot.ts';
import { verdictOf } from '../../src/holistic/observe.ts';
import { type Obligations, type ObservationVerdict, parseObligations, witnessRecord } from '../../src/holistic/types.ts';
import { WITNESS_RECORD_FILE } from '../../src/holistic/witness.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import { type PlanM1, parsePlan } from '../../src/input/plan.ts';
import { readNeedsUser } from '../../src/needsuser.ts';
import { readCommand } from '../../src/commands/queue.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { MODEL_IDS } from '../../src/routing/types.ts';
import { parseSpec } from '../../src/spec/spec.ts';
import type { Report } from './driver.ts';
import { LENSES, MAIN, MONEY_LANE, layout } from './layout.ts';

type Verdict = Readonly<{ pass: boolean; detail: string }>;
export type Criterion = Readonly<{ name: string }> & Verdict;
export type CheckResult = Readonly<{ pass: boolean; criteria: readonly Criterion[]; notExercised: readonly Branch[]; cannotShow: readonly string[] }>;

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

/** The one bundle revision, or why there is not exactly one. */
function bundleRevision(run: Run) {
  const revs = factsOf(run, 'plan-applied').filter((f) => f.source?.type === 'bundle');
  return revs.length === 1 ? revs[0]! : null;
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
  const applied = factsOf(run, 'plan-applied').filter((f) => f.source?.type === 'bundle');
  for (const d of factsOf(run, 'bundle-decided')) {
    if (applied.some((f) => f.source?.type === 'bundle' && f.source.job === d.job)) problems.push(`${d.job} decided ${d.outcome.kind} and applied`);
  }
  const rev = bundleRevision(run);
  if (rev === null) return verdict([...problems, `${applied.length} bundle revisions, not one`], '');
  const added = rev.changes.flatMap((c) => (c.type === 'unit-added' ? [c.unit] : []));
  const plan = requirePlanInForce(run.runDir, run.view).plan;
  const unit = plan.units.find((u) => u.id === added[0]);
  if (added.length !== 1 || unit === undefined) return verdict([...problems, `the bundle revision adds ${JSON.stringify(added)}`], '');
  if (unit.origin !== 'repair') problems.push(`${unit.id} has origin ${unit.origin}`);
  const spec = run.view.unit(unit.id).spec;
  const specText = spec === null ? null : readFileSync(join(run.runDir, 'inputs', `${spec.sha256}.spec.json`), 'utf8');
  const repairs = specText === null ? [] : (parseSpec(Buffer.from(specText), `${unit.id}.json` as never).repairs ?? []);
  const p1 = moneyP1(run);
  if (!repairs.some((x) => x === p1?.id || x === 'I-2')) problems.push(`${unit.id}'s spec repairs ${JSON.stringify(repairs)}, not ${p1?.id} or I-2`);
  const requests = run.report.devices.acks.filter((a) => a.reason === 'bundle-request');
  const answered = requests.map((a) => `${a.needsUser}:${a.choice ?? 'ack'}`).join(', ');
  return verdict(problems, `one bundle revision ${rev.rev} (${rev.source?.type === 'bundle' ? rev.source.job : ''}) admits ${unit.id} (repair of ${JSON.stringify(repairs)}); ${factsOf(run, 'bundle-decided').length} decided bundles applied nothing; ${requests.length} bundle requests answered by the driver${requests.length === 0 ? '' : ` (${answered})`} (informational)`);
}

function repairDivergence(run: Run): Verdict {
  const rev = bundleRevision(run);
  if (rev === null || rev.source?.type !== 'bundle') return { pass: false, detail: 'no single bundle revision' };
  const job = rev.source.job;
  const ds = factsOf(run, 'divergence').filter((d) => d.job === job);
  const hit = ds.find((d) => d.type === 'plan-departed' && d.cites.includes('V-2' as never));
  return { pass: hit !== undefined, detail: hit !== undefined ? `${hit.id} plan-departed citing ${hit.cites.join(', ')} (${hit.what})` : `${job}'s divergences: ${JSON.stringify(ds.map((d) => [d.id, d.type, d.cites]))}` };
}

function divergenceDigestBound(run: Run): Verdict {
  const problems: string[] = [];
  const bound = new Set<string>();
  const digests = factsOf(run, 'divergence-digest');
  for (const g of digests) {
    const expected = factsOf(run, 'divergence').filter((d) => d.seq < g.seq && !bound.has(d.id)).map((d) => d.id as string);
    if (JSON.stringify(g.ids) !== JSON.stringify(expected)) problems.push(`digest ${g.needsUser} binds ${JSON.stringify(g.ids)}, not ${JSON.stringify(expected)}`);
    for (const id of g.ids) bound.add(id);
  }
  const acks = run.report.devices.acks;
  if (digests.length === 0) problems.push('no digest was raised');
  for (const g of digests) {
    if (!acks.some((a) => a.needsUser === g.needsUser && a.reason === 'divergence-digest')) problems.push(`the driver did not acknowledge the digest ${g.needsUser}`);
    else if (run.view.needsUser().find((n) => n.id === g.needsUser)?.ack == null) problems.push(`${g.needsUser} is not acknowledged`);
  }
  const uncovered = run.report.status.divergences.map((d) => d.id);
  if (uncovered.length > 0) problems.push(`uncovered divergences ${JSON.stringify(uncovered)}`);
  if (factsOf(run, 'divergence').length === 0) problems.push('no divergence recorded');
  return verdict(problems, `${digests.length} digests: ${digests.map((x) => `${x.needsUser} [${x.ids.join(', ')}]`).join('; ')}; each acknowledged by the driver`);
}

function convergenceBound(run: Run): Verdict {
  const rev = bundleRevision(run);
  const raised = items(run, 'convergence-bound');
  const acks = run.report.devices.acks;
  const problems: string[] = [];
  if (raised.length !== 1) problems.push(`${raised.length} convergence-bound items`);
  for (const item of raised) {
    if (!acks.some((a) => a.needsUser === item.id && a.reason === 'convergence-bound') || item.ack === null) problems.push(`${item.id} is not acknowledged by the driver`);
  }
  if (rev === null) problems.push('no bundle revision');
  return verdict(problems, `${raised.map((n) => n.id).join(', ')} raised after the bundle revision ${rev?.rev}, acknowledged`);
}

function repairResolved(run: Run): Verdict {
  const problems: string[] = [];
  const repair = run.report.devices.repair?.unit ?? null;
  if (repair === null) return { pass: false, detail: 'the driver found no repair unit' };
  const pub = unitPublication(run, repair);
  if (pub === undefined) problems.push(`${repair} never published`);
  const p1 = moneyP1(run);
  const resolved = factsOf(run, 'finding-transition').find((t) => t.id === p1?.id && t.to.state === 'resolved');
  if (p1 === undefined || resolved === undefined) problems.push(`the P1 over I-2 (${p1?.id}) was not resolved`);
  const i2 = run.report.status.nowTrue.find((o) => o.obligation === 'I-2');
  if (i2?.verdict !== 'held') problems.push(`I-2 is ${i2?.verdict ?? 'absent'} on the head`);
  return verdict(problems, `${repair} published ${pub?.new}; ${p1?.id} resolved at seq ${resolved?.seq}; I-2 held`);
}

function driftAudit(run: Run): Verdict {
  const rev = bundleRevision(run);
  if (rev === null) return { pass: false, detail: 'no bundle revision' };
  const audit = factsOf(run, 'audit-started').find((a) => a.triggers.some((t) => t.type === 'drift' && t.planRev === rev.rev));
  if (audit === undefined) return { pass: false, detail: `no audit triggered by the drift of revision ${rev.rev}` };
  const problems: string[] = [];
  if (JSON.stringify(audit.lenses) !== JSON.stringify(['vision'])) problems.push(`${audit.job} ran ${JSON.stringify(audit.lenses)}, not the vision lens alone`);
  if (factsOf(run, 'audit-ended').find((e) => e.job === audit.job)?.outcome !== 'completed') problems.push(`${audit.job} did not complete`);
  const ck = checkpointOf(run, audit.job);
  if (ck?.decision !== 'no-op') problems.push(`its checkpoint ${ck?.job} decided ${ck?.decision}`);
  return verdict(problems, `${audit.job} (drift of rev ${rev.rev}) ran vision; ${ck?.job} no-op`);
}

function finalAudit(run: Run): Verdict {
  const last = factsOf(run, 'audit-started').at(-1);
  if (last === undefined) return { pass: false, detail: 'no audit' };
  const problems: string[] = [];
  if (!last.triggers.some((t) => t.type === 'final')) problems.push(`the last audit ${last.job} was triggered by ${JSON.stringify(last.triggers)}, not final`);
  if (JSON.stringify(last.lenses) !== JSON.stringify(LENSES)) problems.push(`${last.job} ran ${JSON.stringify(last.lenses)}, not L`);
  const lastUnit = publications(run).filter((p) => p.subject !== 'docs').at(-1);
  if (lastUnit === undefined || last.integrationSha !== lastUnit.new) problems.push(`${last.job} audited ${last.integrationSha}, not the last unit publication ${lastUnit?.new}`);
  if (factsOf(run, 'audit-ended').find((e) => e.job === last.job)?.outcome !== 'completed') problems.push(`${last.job} did not complete`);
  const ck = checkpointOf(run, last.job);
  if (ck?.decision !== 'no-op') problems.push(`its checkpoint ${ck?.job} decided ${ck?.decision}`);
  return verdict(problems, `${last.job} final on ${last.integrationSha}, ran ${last.lenses.join(', ')}; ${ck?.job} no-op`);
}

/** The executor-rendered `.roadmap/` files a docs-only publication may carry. */
const RENDERED = ['.roadmap/constraints.md', '.roadmap/invariants.md'];

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
  const units = requirePlanInForce(run.runDir, run.view).plan.units.map((u) => u.id as string).sort();
  if (JSON.stringify([...c.units].sort()) !== JSON.stringify(units)) problems.push(`arc-completed units ${JSON.stringify(c.units)}, not ${JSON.stringify(units)}`);
  const at = refTarget(run.repo, snapshotRef(run.arc));
  const v = at === null ? null : verifySnapshot(run.repo, at);
  if (v === null || v.kind !== 'verified' || v.manifest.highWater < c.seq) problems.push(`the terminal snapshot does not follow arc-completed (seq ${c.seq}): ${v === null ? 'no ref' : v.kind === 'verified' ? `high-water ${v.manifest.highWater}` : v.detail}`);
  if (!run.report.status.completion.active) problems.push(`status completion not active: ${JSON.stringify(run.report.status.completion)}`);
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
  const last = factsOf(run, 'audit-started').at(-1);
  for (const d of factsOf(run, 'docs-covered')) if (last === undefined || d.from !== last.integrationSha) problems.push(`the docs edge ${d.from}→${d.to} does not start at the final audit's SHA ${last?.integrationSha}`);
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

function obligationsDischarged(run: Run): Verdict {
  const { nowTrue, notYetTrue } = run.report.status;
  const problems = [
    ...nowTrue.filter((o) => o.verdict !== 'held').map((o) => `${o.obligation} ${o.verdict}`),
    ...notYetTrue.map((o) => `${o.obligation} pending (${o.reason})`),
  ];
  if (nowTrue.length !== run.obligations.obligations.length) problems.push(`${nowTrue.length} obligations true, of ${run.obligations.obligations.length}`);
  return verdict(problems, nowTrue.map((o) => `${o.obligation} ${o.verdict}`).join(', '));
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
  for (const unit of plan.units) {
    const u = run.view.unit(unit.id);
    if (u.status !== 'retired') problems.push(`${unit.id}: ${u.status} at ${u.stage}`);
  }
  return verdict(problems, `${plan.units.map((u) => u.id).join(', ')} merged`);
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

function diffProductAndDocs(run: Run): Verdict {
  const scopes = requirePlanInForce(run.runDir, run.view).plan.units.flatMap((u) => u.scope as readonly string[]);
  const paths = git(run.repo, ['diff', '--name-only', `${MAIN}...${run.plan.integrationBranch}`]).split('\n').filter((p) => p !== '');
  const outside = paths.filter((p) => !scopes.includes(p) && !RENDERED.includes(p) && !p.startsWith('.roadmap/contracts/'));
  return { pass: outside.length === 0 && paths.some((p) => RENDERED.includes(p)), detail: outside.length > 0 ? `outside the units' scopes and the living docs: ${outside.join(', ')}` : paths.join(', ') };
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

const CRITERIA: readonly (readonly [string, (run: Run) => Verdict])[] = [
  ['baseline', baseline],
  ['regression-unselected', regressionUnselected],
  ['audit-race', auditRace],
  ['stale-whole', staleWhole],
  ['bundles-whole', bundlesWhole],
  ['repair-divergence', repairDivergence],
  ['divergence-digest-bound', divergenceDigestBound],
  ['convergence-bound', convergenceBound],
  ['repair-resolved', repairResolved],
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
  const criteria = CRITERIA.map(([name, grade]): Criterion => {
    try {
      const v = grade(run);
      return { name, pass: v.pass, detail: v.detail };
    } catch (error) {
      return { name, pass: false, detail: `threw: ${(error as Error).message}` };
    }
  });
  const done = exercised(run);
  return { pass: criteria.every((c) => c.pass), criteria, notExercised: BRANCHES.filter((b) => !done.has(b)), cannotShow: CANNOT_SHOW };
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m3/check.ts <dir>');
  const result = check(resolve(dir));
  const list = (xs: readonly string[]): string => (xs.length === 0 ? '(none)' : xs.join(', '));
  process.stdout.write(`${JSON.stringify(result)}\nNOT EXERCISED: ${list(result.notExercised)}\nCANNOT SHOW: ${list(result.cannotShow)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}
