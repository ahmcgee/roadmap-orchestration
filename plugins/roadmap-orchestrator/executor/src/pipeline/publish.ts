// The docs publication (M3 step A4; DESIGN-1.0.md §2.9, §9; plan "Commands", Docs publication; A7, A17, G12): a
// revision's rendered `.roadmap/` documents and its contract ops, published through the integration slot like a unit,
// so the tested head is the published head. It runs inside its revision's commit (src/recover/revision.ts
// `commitRevision`, under the revision fence), reached through `DocsPublisher`:
//
//   slot       `integration-slot` under `docs{pub}` (pub = the next `docs-<n>`), taken first of every waiter
//              (`acquireFirst`, src/schedule/arbiter.ts). A unit candidate holding it before green is preempted
//              (src/pipeline/integrate.ts `preemptCandidate`: `preempted`, uncharged); a green one's ff → snapshot
//              chain completes first.
//   files      each rendered document (kept bytes) and each document the revision's new rulings' contract ops edit
//              at the tip T, those rulings validated again at T (`validateRuling`, G21: their consistency is fresh).
//   docs.commit on `refs/roadmap-run/<arc>/docs/<pub>`, parents [T] (src/git/docs.ts).
//   transient  the commit's diff holds only those files (`docsTransientViolations`).
//   lanes      in a detached checkout of the commit, under `job{pub}` (`runJourneySeries`, lanes.ts): the plan's suite, then the arc
//              lanes witnessing the selected obligations (below), each witness run a `witnessed{for: job{pub}}` fact.
//   verdict    green only with every suite lane passing and no selected obligation's effect `red` (the table,
//              src/holistic/table.ts): a must-hold obligation the revision adds must hold on the docs candidate (G12).
//   ff         `integration.ff{subject: docs{pub}}`, T → the commit: the exact expected update.
//   then       the revision's activation (`plan-applied`, by `commitRevision`), then `settle` (`finishDocs`): a docs-only
//              publication's `docs-covered{pub, T → D}` (A17), the snapshot, the slot released.
// A refusal before the ff releases the slot and aborts the revision (nothing is in force); the command reports why.
//
// Selection (G12; SCHEMAS "Choices made in M3 A4"): the rendered `.roadmap/` files are not changed paths: the executor
// renders them from in-force records, and as unmapped paths they would select every must-hold obligation. A docs
// candidate selects the obligations its contract ops' paths touch (contracts, docRefs, witness files, mapping; an
// unmapped contract path selects every must-hold, as for a unit), plus the obligations the revision adds, splits or
// re-witnesses, with the split closure. Witnesses are read against the revision's own obligations.
//
// Crash safety: recovery finds the publication a revision carried as the docs ff begun after its `revision.commit`
// (src/recover/revision.ts `docsStateOf`). The slot left held is the docs holder's (src/recover/resource.ts):
// published → `finishDocs` (what is missing of docs-covered, snapshot, release); not published → `abandonDocs` (its
// checkout removed, the slot released), and the source re-evaluates.
//
// The lanes run as a journey series under `job{pub}` (src/pipeline/lanes.ts `runJourneySeries`: reserved first of every
// unit, the red-lane protocol, evidence per execution, a witness record per arc lane run).
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, Parent, PlanChange, RevisionPayload } from '../core/events.ts';
import { type JobId, type ObligationId, type OpId, type Sha, type Sha256Hex, INTEGRATION_SLOT } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { type AbsPath, type RepoPath, absPath, branchRef } from '../core/values.ts';
import { applyContractOps } from '../docs/contracts.ts';
import { type DocsFile, changedPaths, docsWorktreeRequest, planDocs } from '../git/docs.ts';
import { capturedEvidence } from '../git/evidence.ts';
import { planDocsFf } from '../git/ff.ts';
import { gitRun, refTarget } from '../git/git.ts';
import { snapshotRequestOf } from '../git/snapshot.ts';
import { docsTransientViolations } from '../git/transient.ts';
import { selectObligations } from '../holistic/impact.ts';
import { verdictOf } from '../holistic/observe.ts';
import { brakesOn, obligationEffects } from '../holistic/table.ts';
import { type ArcLaneDef, type Obligations, type RulingSidecar, isExempt, parseObligations, parseRulingSidecar } from '../holistic/types.ts';
import {
  OBLIGATIONS_INPUT, RENDER_INPUT, RULING_INPUT, keptInput, keptPayload, requirePlanInForce, revisionInForce,
} from '../input/inforce.ts';
import type { PlanM1 } from '../input/plan.ts';
import {
  type DocsHolder, type Reservation, type ResourceContext, cleanup, entryOf, finishCleanup, heldReservation, holderUnits, resourceTable, run,
} from '../resources/reserve.ts';
import { type DocsOutcome, type DocsPublisher } from '../recover/revision.ts';
import { docsCommitOp, evidenceSnapshotOp, integrationFfOp, snapshotPublishOp, worktreeRemoveOp } from '../recover/ops.ts';
import { spawnReconciler } from '../recover/spawn.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import type { ResourceRequest } from '../schedule/types.ts';
import { type RulingContext, ledgerAfter, parseRulings, validateRuling } from '../spec/rulings.ts';
import { preemptCandidate } from './integrate.ts';
import { type JourneySeries, arcJourneyLane, jobEvidenceRoot, runJourneySeries, suiteJourneyLane } from './lanes.ts';
import { runOp, runPrepared } from './dispatch.ts';
import { executorIdentity } from './stages.ts';

/** What a docs publication needs: the reservation cycle's context, the lanes' environment, the plan file, the arbiter. */
export type DocsContext = ResourceContext & Readonly<{
  /** The executor's own environment: lanes take their declared `pass` names from it. */
  hostEnv: Readonly<Record<string, string | undefined>>;
  /** The plan file: the inputs in force of a dev.5 revision resolve beside it. */
  planFile: AbsPath;
  arbiter: Readonly<{ acquireFirst: AcquireFirst; wake: () => void }>;
}>;

/** A docs publication's slot: `integration-slot` alone, as a unit publication's. */
const SLOT: ResourceRequest = { named: [], pools: [], cpu: 0, publication: true };
/** How often a waiting docs publication re-evaluates the arbiter, so it asks a preemption again (outside the scheduler's ticks). */
const WAKE_MS = 200;
/** A job's waits are never cancelled: a docs publication runs to its end once its revision committed to it. */
const NEVER = new AbortController().signal;

export const docsWorktree = (plan: PlanM1, pub: JobId): AbsPath => absPath(join(plan.worktreeRoot, plan.arc, `${pub}.checkout`));

/** The executor's docs publisher: `DocsPublisher` over `ctx` (src/recover/revision.ts). */
export function docsPublisher(ctx: DocsContext): DocsPublisher {
  return (payload) => publishDocs(ctx, payload);
}

// ---------------------------------------------------------------------------------------------------
// The slot

/**
 * Preempts the slot's holder when it is a unit candidate that has not recorded its outcome (A7). A publication past
 * green (its ff and snapshot chain) is waited for.
 */
function preemptBeforeGreen(ctx: DocsContext): void {
  const { status, pending } = entryOf(resourceTable(ctx.journal.view), INTEGRATION_SLOT);
  if (pending !== null || status.state === 'free' || status.holder.type !== 'publication') return;
  const { unit, attempt } = status.holder;
  const d = ctx.journal.view.unit(unit).decided;
  // Its candidate attempt recorded (green: the chain runs; anything else: the slot is being released), or it is past
  // green (ff published, or its snapshot): the docs publication waits for the release.
  const recorded = d !== null && ((d.stage === 'candidate' && d.attempt === attempt) || (d.stage === 'ff' && d.outcome === 'published') || d.stage === 'snapshot');
  if (!recorded) preemptCandidate(ctx.journal, unit);
}

async function takeSlot(ctx: DocsContext, holder: DocsHolder): Promise<Reservation<'running', DocsHolder>> {
  const timer = setInterval(() => ctx.arbiter.wake(), WAKE_MS);
  try {
    const grant = await ctx.arbiter.acquireFirst(SLOT, holder, NEVER, () => preemptBeforeGreen(ctx));
    if (grant.kind !== 'granted') throw new Error(`${holder.pub}: its slot wait was cancelled, and nothing cancels it`);
  } finally {
    clearInterval(timer);
  }
  return run(ctx, heldReservation(ctx, holder, 'reserved'), { type: 'job', job: holder.pub });
}

/** The slot released (it has no teardown, so its cleanup cannot fail), from whatever state the docs holder left it in. */
async function releaseSlot(ctx: ResourceContext, pub: JobId): Promise<void> {
  const holder: DocsHolder = { type: 'docs', pub };
  const parent: Parent = { type: 'job', job: pub };
  const { status, pending } = entryOf(resourceTable(ctx.journal.view), INTEGRATION_SLOT);
  if (pending !== null) throw new Error(`${pub}: ${pending.op} is open on ${INTEGRATION_SLOT}`);
  if (status.state === 'free' || status.holder.type !== 'docs' || status.holder.pub !== pub) return;
  const cleaned = status.state === 'cleaning'
    ? await finishCleanup(ctx, { state: 'cleaning', holder, resources: [INTEGRATION_SLOT], recipes: new Map() }, parent)
    : await cleanup(ctx, heldReservation(ctx, holder, status.state === 'reserved' ? 'reserved' : 'running'), parent);
  if (cleaned.kind !== 'released') throw new Error(`the integration slot of ${pub} was not released: ${cleaned.kind}`);
}

// ---------------------------------------------------------------------------------------------------
// The files

/** A path's text at `commit`, or null when absent. */
function textAt(repo: AbsPath, commit: Sha, path: RepoPath): string | null {
  const r = gitRun(repo, ['cat-file', 'blob', `${commit}:${path}`], { okCodes: [0, 128] });
  return r.code === 0 ? r.stdout : null;
}

/** A path's blob at `commit`, or null when absent. */
function blobAt(repo: AbsPath, commit: Sha, path: RepoPath): Sha | null {
  const r = gitRun(repo, ['rev-parse', '--verify', '-q', `${commit}:${path}`], { okCodes: [0, 1, 128] });
  return r.code === 0 ? (r.stdout.trim() as Sha) : null;
}

type Reader = Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; planFile: AbsPath; repo: AbsPath }>;

/**
 * What `validateRuling` reads (A1) at the integration tip `tip`: the ledger, obligations and vision in force, the
 * tip's documents and blobs, the plan's contracts and architecture doc, its units. The `rule` command validates a
 * sidecar against it, and a docs publication again under the slot.
 */
export function rulingContextAt(ctx: Reader, tip: Sha): RulingContext {
  const inForce = requirePlanInForce(ctx.runDir, ctx.journal.view);
  const revision = revisionInForce(ctx.runDir, inForce, ctx.planFile);
  return {
    ledger: parseRulings(revision.ledger.bytes.toString('utf8'), 'the rulings ledger in force'),
    inForce: { head: tip, ledgerSha256: revision.ledger.sha256, obligationsSha256: revision.obligations?.sha256 ?? null, visionSha256: revision.vision?.sha256 ?? null },
    docAt: (path) => textAt(ctx.repo, tip, path),
    blobAt: (path) => blobAt(ctx.repo, tip, path),
    documents: [...new Set([...inForce.plan.contracts, inForce.plan.architectureDoc])].sort(),
    obligations: revision.obligations?.value ?? null,
    vision: revision.vision?.value ?? null,
    units: inForce.plan.units.map((u) => u.id),
  };
}

const keptOr = (runDir: AbsPath, sha: Sha256Hex, ext: string): Buffer => {
  const bytes = keptInput(runDir, sha, ext);
  if (bytes === null) throw new Error(`the revision payload names ${ext} ${sha}, which is not kept`);
  return bytes;
};

/** The sidecars the payload lands: in its manifest and not in the revision in force (A2: the new ones), ascending by id. */
function landedSidecars(ctx: Reader, payload: RevisionPayload): readonly RulingSidecar[] {
  const inForce = revisionInForce(ctx.runDir, requirePlanInForce(ctx.runDir, ctx.journal.view), ctx.planFile).manifest.rulings.sidecars;
  return Object.entries(payload.manifest.rulings.sidecars)
    .filter(([id]) => !Object.hasOwn(inForce, id))
    .sort(([a], [b]) => Number(a.slice(2)) - Number(b.slice(2)))
    .map(([, sha]) => parseRulingSidecar(JSON.parse(keptOr(ctx.runDir, sha, RULING_INPUT).toString('utf8'))));
}

type Files = Readonly<{ kind: 'files'; files: readonly DocsFile[]; contractPaths: readonly RepoPath[] }> | Readonly<{ kind: 'refused'; reasons: readonly string[] }>;

/**
 * The docs commit's files at `tip`: every rendered document (its kept bytes), then every document the new rulings'
 * contract ops edit, each ruling validated again at `tip` first (its identity against the ledger with the earlier
 * ones landed; its consistency against the revisions in force).
 */
function docsFiles(ctx: Reader, payload: RevisionPayload, tip: Sha): Files {
  const publication = payload.publication;
  if (publication === null) throw new Error(`revision ${payload.rev} has no docs publication`);
  const renders: DocsFile[] = publication.renders.map((r) => ({ path: r.path, bytes: keptOr(ctx.runDir, r.sha256, RENDER_INPUT) }));
  const landed = landedSidecars(ctx, payload);
  const ops = landed.flatMap((s) => s.contractOps);
  if (canonicalJson(ops) !== canonicalJson(publication.contractOps)) {
    throw new Error(`revision ${payload.rev}: its publication's contract ops are not its new rulings' (${canonicalJson(publication.contractOps)} vs ${canonicalJson(ops)})`);
  }
  const base = rulingContextAt(ctx, tip);
  const reasons: string[] = [];
  let ledgerText = revisionInForce(ctx.runDir, requirePlanInForce(ctx.runDir, ctx.journal.view), ctx.planFile).ledger.bytes.toString('utf8');
  const edited = new Map<RepoPath, string>();
  const docAt = (path: RepoPath): string | null => edited.get(path) ?? base.docAt(path);
  for (const s of landed) {
    reasons.push(...validateRuling(s, { ...base, ledger: parseRulings(ledgerText, 'the rulings ledger') }));
    ledgerText = ledgerAfter(ledgerText, s);
    const applied = applyContractOps(s.contractOps, s.id, docAt);
    if ('reasons' in applied) reasons.push(...applied.reasons.map((r) => `${s.id} ${r}`));
    else for (const e of applied.edits) edited.set(e.path, e.text);
  }
  if (reasons.length > 0) return { kind: 'refused', reasons };
  const contractPaths = [...edited.keys()].sort();
  return { kind: 'files', files: [...renders, ...contractPaths.map((path) => ({ path, bytes: Buffer.from(edited.get(path)!, 'utf8') }))], contractPaths };
}

// ---------------------------------------------------------------------------------------------------
// Selection and witnesses (G12)

/** The revision's own obligations (the docs candidate publishes them), or null outside a holistic arc with some. */
function revisionObligations(runDir: AbsPath, payload: RevisionPayload): Obligations | null {
  const sha = payload.manifest.obligations;
  return sha === null ? null : parseObligations(JSON.parse(keptOr(runDir, sha, OBLIGATIONS_INPUT).toString('utf8')));
}

/** The obligations a revision adds, splits or re-witnesses (G12). */
export const revisedObligations = (changes: readonly PlanChange[]): readonly ObligationId[] =>
  changes.flatMap((c) => (c.type === 'obligation' && (c.edit === 'added' || c.edit === 'split' || c.edit === 'witness') ? [c.id] : []));

/** The docs candidate's selection: its contract ops' paths (never the rendered `.roadmap/` files) and the revised obligations. */
export function docsSelection(obligations: Obligations, contractPaths: readonly RepoPath[], changes: readonly PlanChange[]): readonly ObligationId[] {
  return selectObligations({ obligations, units: [], closure: [], changedPaths: contractPaths, revised: revisedObligations(changes) });
}

/** The arc lanes that witness the selected, non-exempt obligations, in the file's lane order. */
function witnessLanes(obligations: Obligations, selected: ReadonlySet<ObligationId>): readonly ArcLaneDef[] {
  const needed = new Set(obligations.obligations.flatMap((o) => (selected.has(o.id) && !isExempt(o) && o.witness !== null ? [o.witness.lane] : [])));
  return obligations.lanes.filter((l) => needed.has(l.id));
}

// ---------------------------------------------------------------------------------------------------
// The publication

const refused = (reason: string): DocsOutcome => ({ kind: 'refused', reason });

/** A docs `ff` publishes no unit: its reconciler never asks for a unit's re-check. */
const noUnit = (): never => {
  throw new Error('a docs ff has no unit to re-check');
};

/** One docs publication of `payload`, inside its open commit (the caller holds the revision fence). */
async function publishDocs(ctx: DocsContext, payload: RevisionPayload): Promise<DocsOutcome> {
  const publication = payload.publication;
  if (publication === null) throw new Error(`revision ${payload.rev} has no docs publication`);
  const pub = ctx.journal.view.nextJobId('docs');
  const parent: Parent = { type: 'job', job: pub };
  await takeSlot(ctx, { type: 'docs', pub });
  const refuse = async (reason: string): Promise<DocsOutcome> => {
    await releaseSlot(ctx, pub);
    return refused(`docs publication ${pub}: ${reason}`);
  };

  const plan = ctx.plan();
  const integration = branchRef(plan.integrationBranch);
  const tip = refTarget(ctx.repo, integration);
  if (tip === null) throw new Error(`integration ${integration} does not exist`);
  const files = docsFiles(ctx, payload, tip);
  if (files.kind === 'refused') return refuse(`its rulings do not land at ${tip}: ${files.reasons.join('; ')}`);

  const commit = await runOp(ctx.journal, docsCommitOp(ctx.repo), `docs:${pub}`, parent, planDocs(ctx.repo, {
    arc: plan.arc, pub, tip, files: files.files, worktree: docsWorktree(plan, pub), identity: executorIdentity(),
    message: `roadmap ${plan.arc}: docs publication ${pub} (plan rev ${payload.rev})\n`,
  }));
  const next = commit.post.new;
  const violations = docsTransientViolations(changedPaths(ctx.repo, tip, next), files.files.map((f) => f.path));
  if (violations.length > 0) return refuse(`its commit touches paths it does not publish: ${violations.map((v) => `${v.path} (${v.rule})`).join(', ')}`);

  const obligations = revisionObligations(ctx.runDir, payload);
  const selected = new Set(obligations === null ? [] : docsSelection(obligations, files.contractPaths, payload.changes));
  const lanes = [...plan.suite.lanes.map(suiteJourneyLane), ...(obligations === null ? [] : witnessLanes(obligations, selected).map(arcJourneyLane))];
  const series = await runJourneySeries(
    ctx, { type: 'job', job: pub, acquireFirst: ctx.arbiter.acquireFirst }, lanes, docsWorktreeRequest(commit), jobEvidenceRoot(ctx.runDir, pub),
    { reuse: true, stop: (r) => r.record === null && r.verdict !== 'pass' },
  );
  crashPoint('docs.after-lanes');
  const why = verdictReason(series, obligations, selected);
  if (why !== null) return refuse(why);

  const decision = planDocsFf(ctx.repo, integration, commit);
  if (decision.kind !== 'ff') {
    if (decision.kind === 'foreign-mover') return refuse(`${decision.ref} is at ${decision.observed ?? 'nothing'}, expected ${decision.expected}: an executor-owned ref was moved by another`);
    return refuse(`integration advanced to ${decision.tip} while the docs publication held the slot`);
  }
  const ff = await runPrepared(ctx.journal, integrationFfOp(ctx.repo, noUnit), `integration:${plan.arc}`, parent, decision.body);
  const ffDone = ctx.journal.view.doneOf(ff.op);
  if (ffDone === null || ffDone.kind !== 'integration.ff') throw new Error(`integration.ff ${ff.op} has no done record`);
  if (ffDone.outcome.kind !== 'published') return refuse(`its ff ended ${ffDone.outcome.kind}`);
  return { kind: 'published', publication: { pub, head: next }, settle: () => finishDocs(ctx, pub) };
}

/**
 * Why the docs candidate is not green, or null: a series that ended without every verdict, a suite lane that did not
 * pass, or a selected obligation whose effect is `red` on the candidate's witness records (G12).
 */
function verdictReason(series: JourneySeries, obligations: Obligations | null, selected: ReadonlySet<ObligationId>): string | null {
  switch (series.end.kind) {
    case 'ran':
      break;
    case 'blocked':
      return `lane ${series.end.lane} gave no verdict: ${series.end.detail}`;
    case 'occupied':
      return `a lane's resources were occupied: ${series.end.needsUser.summary}`;
    case 'cleanup-failed':
      return `a lane's resources could not be cleaned (${series.end.failed.join(', ')}): job-owned residues, probed and reclaimed`;
    case 'interrupted':
      throw new Error(`a docs publication's lanes are never interrupted (${series.end.reason})`);
  }
  const red = series.runs.find((r) => r.record === null && r.verdict !== 'pass');
  if (red !== undefined) return `suite lane ${red.lane} is ${red.verdict} on the docs candidate (evidence ${red.dir})`;
  if (obligations === null || selected.size === 0) return null;
  const records = new Map(series.runs.flatMap((r) => (r.record === null ? [] : [[r.lane, r.record] as const])));
  const effects = obligationEffects({
    obligations: obligations.obligations, selected, latched: new Set(), completing: new Set(),
    verdict: (_o, witness) => {
      const record = records.get(witness.lane);
      return record === undefined ? null : verdictOf(record, witness);
    },
  });
  if (!brakesOn(effects, selected)) return null;
  const reds = [...selected].filter((id) => effects.get(id) === 'red').sort();
  return `obligations ${reds.join(', ')} do not hold on the docs candidate`;
}

// ---------------------------------------------------------------------------------------------------
// After the activation, and recovery

/** The docs `ff` of `pub`, if one was begun. */
const docsFfOf = (view: JournalView, pub: JobId): IntentOf<'integration.ff'> | undefined =>
  view.opsOf('integration.ff').find((i) => i.expect.subject?.type === 'docs' && i.expect.subject.pub === pub);

/** The revision the publication `pub` carried: the latest `revision.commit` begun before its docs `ff`. */
function payloadOfPub(view: JournalView, runDir: AbsPath, ff: IntentOf<'integration.ff'>): RevisionPayload {
  const seq = (op: OpId): number => Number(op.slice(op.lastIndexOf('/') + 1));
  const commit = view.opsOf('revision.commit').filter((i) => seq(i.op) < seq(ff.op)).at(-1);
  if (commit === undefined) throw new Error(`docs ff ${ff.op} follows no revision.commit`);
  return keptPayload(runDir, commit.expect.payloadSha256);
}

/**
 * After a published docs publication's activation, each step only where missing (recovery calls it again): a
 * docs-only publication's `docs-covered{pub, T → D}` (A17: no contract op, so its diff is confined to the rendered
 * `.roadmap/` files), the snapshot of the run's records (the `plan-applied` included), then the slot released.
 */
export async function finishDocs(ctx: ResourceContext, pub: JobId): Promise<void> {
  const view = ctx.journal.view;
  const ff = docsFfOf(view, pub);
  const done = ff === undefined ? null : view.doneOf(ff.op);
  if (ff === undefined || done === null || done.kind !== 'integration.ff' || done.outcome.kind !== 'published') throw new Error(`docs publication ${pub} did not publish`);
  const payload = payloadOfPub(view, ctx.runDir, ff);
  if (payload.publication?.contractOps.length === 0 && !view.holistic().docsCovered.some((d) => d.pub === pub)) {
    ctx.journal.fact({ kind: 'docs-covered', pub, from: ff.expect.old, to: ff.expect.new });
  }
  const parent: Parent = { type: 'job', job: pub };
  const snapped = view.opsOf('snapshot.publish').some((i) => canonicalJson(i.parent) === canonicalJson(parent) && view.doneOf(i.op) !== null);
  if (!snapped) {
    await runOp(ctx.journal, snapshotPublishOp(ctx.repo), `snapshot:${ctx.plan().arc}`, parent, snapshotRequestOf({
      view: ctx.journal.view, runDir: ctx.runDir, identity: executorIdentity(), message: `roadmap ${ctx.plan().arc}: snapshot after docs publication ${pub}\n`,
    }));
  }
  crashPoint('docs.after-snapshot');
  await releaseSlot(ctx, pub);
}

/**
 * A docs publication a crash cut short before its `ff` published: its lanes' invocations settled, its checkout
 * removed (citing its last evidence snapshot, or one made of what the checkout holds), and the slot released. Its
 * revision was aborted, so its source re-evaluates.
 */
export async function abandonDocs(ctx: ResourceContext, pub: JobId): Promise<void> {
  const parent: Parent = { type: 'job', job: pub };
  const same = (p: Parent): boolean => canonicalJson(p) === canonicalJson(parent);
  const spawn = spawnReconciler(ctx);
  for (const intent of ctx.journal.view.openIntents()) if (intent.kind === 'proc.spawn' && same(intent.parent)) await spawn(intent, ctx.journal.view);
  const view = ctx.journal.view;
  const removed = new Set(view.opsOf('worktree.remove').filter((i) => view.doneOf(i.op) !== null).map((i) => i.expect.path));
  const created = view.opsOf('worktree.create').filter((i) => same(i.parent) && view.doneOf(i.op) !== null && !removed.has(i.expect.path));
  for (const c of created) {
    let evidence = view.opsOf('evidence.snapshot').filter((i) => same(i.parent) && view.doneOf(i.op) !== null).at(-1)?.op;
    if (evidence === undefined) {
      evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${pub}`, parent, {
        source: c.expect.path, globs: [], dest: absPath(join(jobEvidenceRoot(ctx.runDir, pub), '_leftover')),
      })).op;
    }
    await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${pub}`, parent, { path: c.expect.path, evidence: capturedEvidence(ctx.journal.view, evidence) });
  }
  if (holderUnits(ctx.journal.view, { type: 'docs', pub }).length > 0) await releaseSlot(ctx, pub);
}

/** Recovery of a docs holder found holding the slot (src/recover/resource.ts): finish a published one, abandon the rest. */
export async function recoverDocs(ctx: ResourceContext, pub: JobId): Promise<void> {
  const view = ctx.journal.view;
  const ff = docsFfOf(view, pub);
  const done = ff === undefined ? null : view.doneOf(ff.op);
  if (done !== null && done.kind === 'integration.ff' && done.outcome.kind === 'published') return finishDocs(ctx, pub);
  return abandonDocs(ctx, pub);
}
