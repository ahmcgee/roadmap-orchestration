// A checkpoint's bundle and its activation (M3 step B6; DESIGN-1.0.md §2.8; plan "Checkpoint and bundles", OR-V, A9,
// A10, A16, A19, H3, H10, H12, H13, H16). The checkpoint writes nothing itself: its output is one decision, and this
// module activates it all or nothing through A2's apply core (`evaluateRevision`, then the commit under the revision
// fence, src/recover/revision.ts `commitRevision`), with proposer `bundle{job, cites, evidence}` and source
// `bundle{job}`. OR-V: the vision is the root; a bundle that weakens or amends (an obligation disposed, split or
// re-anchored; a contract edited; the plan re-cut) applies without asking when every op cites active vision clauses
// and evidence, and records what it departed from as a divergence (src/holistic/divergence.ts) for the owner's review
// after the fact.
//
// The whole activation holds the revision fence, from the staleness check through the commit (A19): no revision lands
// between the check and the commit, and the proposal is built from the revision in force at that moment. In order:
//
//   0. Busy (M4a rev 3, C5, R50): an op that touches a unit with an open stage attempt (`openAttempt`, src/core/state.ts:
//      running or crash-abandoned) → `rejected{busy, units}`; the trigger is due again once each attempt has closed
//      (src/holistic/checkpoint.ts), and it never counts toward `secondInvalid`.
//   1. Staleness (H3). The artifacts the ops touch, compared with the vector the checkpoint captured: the plan's bytes,
//      each patched or re-entered unit's spec rev, the obligations, the ledger, the contracts a landing ruling names;
//      and the vision, always. A finding a disposition names that is no longer active is stale too. Any → `rejected
//      {stale}`, and the trigger is due again (the whole bundle re-evaluated by a fresh checkpoint).
//   2. Validation. Cites: every op's and interpretation's clauses active in the vision in force (H16: a withdrawn clause
//      is never newly cited); the observations and findings it cites were in its inputs. Finding dispositions
//      (`rulingRefusal`). Rulings: each JSON text parsed with `ruledBy: checkpoint{job}` and `consistency` stamped by
//      the executor from the captured inputs (lead ruling: the model echoes no revisions), validated at the tip in
//      order (`validateRuling`; only a valid one is folded into the ledger the next is checked against, so no model
//      output reaches the ledger reader as a repeated id); each lands through exactly one `rule` op. M4a: the corpus
//      amendments and the issue outcomes (src/holistic/{amendments,intake}.ts: active pinned rules only; every captured
//      issue exactly once; an `acted` outcome through ops of this output only). A split child anchored at a rule takes
//      its hash from the pin in force; one anchored at another rule than its parent's whose census state is `out-of-slice`
//      moves that state to `obligation{child}` when the child serves only the owner-selected slice and this bundle's
//      opportunities (C4), else the reason names the rule, its state and the fix. The model's numbered ids are read in
//      numeric form (`C-01` is `C-1`, C3). The proposal: the revision in force plus the ops (`proposalOf`, built before
//      step 1, which reads what it touches; it never throws on model output). M4a rev 3, a corpus arc (OR-A1, LR-h): each
//      `admit` is classified (src/holistic/admits.ts, over `admitWorldOf`); a converted admit is dropped from the
//      proposal (unless another op or an `acted` intake names it: then a reason), an opportunity's clauses join
//      `holistic.advances`, and the proposal is rebuilt from the effective ops. Any reason → `rejected{invalid}`; a
//      trigger's second invalid bundle → `bundle-request`.
//   3. Owner-only (A16, H10). A `request` op, or an op with a nested owner-only effect (a lane whose argv[0] no lane of
//      the plan in force runs, a lane env prerequisite no lane in force passes, a contract op outside the plan's
//      contracts and architecture doc) → one blocking `owner-request`; nothing is applied.
//   4. Draining: an `admit` → `bundle-request` (non-blocking).
//   5. Evidence base (M4a rev 3, C1, R58). Each cited observation on another tree than the head: the head's observation
//      of that lane must exist under the same lane rev and environment, neither record malformed, the cited one non-empty,
//      and every cited test the same outcome on the head with no fewer selected (`evidenceDiffers`); tests the head adds
//      never matter. Else `rejected{evidence}`; its lanes are re-witnessed on the head before the trigger's next capture
//      (src/holistic/checkpoint.ts), so the re-evaluation reads them.
//   6. Convergence (src/holistic/convergence.ts): an open brake, or a second material change of one causal identity
//      (a `convergence-identity` item raised with it) → `bundle-request`. An owner-approved bundle request (`enact`)
//      skips 4 and 6.
//   7. All-or-none `evaluateRevision`. A refusal → `rejected{invalid}` as in 2. Nothing changes → `no-op` (step 8).
//   8. No-op: `bundle-decided{no-op}` (with its conversions when every admit converted and nothing else changes), then
//      the divergences of its interpretations (H12), keyed `(job, index)`.
//   9. Divergences, computed by code from the ops against the revisions in force, plus one per interpretation (H13:
//      each with its preimage and compensation hint).
//  10. The commit: `plan-applied{source: bundle{job, admits, conversions}}` first (a corpus arc's classification persisted
//      atomically with the revision, Q4), then the divergences from the payload. Its docs
//      publication (a ruling's `constraints.md`, contract ops; `invariants.md`) runs inside it; a publication refused at
//      the tip → `rejected{stale}`.
//
// After an applied or no-op decision: its finding dispositions (`ruleFinding`, by `checkpoint{job}`); in a corpus arc the
// debt its deferrals bank, its amendments and issue outcomes, and its conversions (each an amendment `source: admit`, a
// follow-up overrun also a debt item naming its opportunity), read from the decision record, never classified again;
// the convergence bound when due (over the effective ops), the divergence digest when due. Each is idempotent, and
// `settleDecided` rewrites what a crash lost.
import { join } from 'node:path';
import type { Parent } from '../core/events.ts';
import { crashPoint } from '../core/crash.ts';
import type { JournalView } from '../core/interfaces.ts';
import { holdFence } from '../core/fence.ts';
import { canonicalJson } from '../core/json.ts';
import {
  type FindingId, type InvocationId, type JobId, type LaneId, type NeedsUserId, type ObligationId, type PlanRev, type RoutingRev, type RuleId, type RulingId, type Sha,
  type Sha256Hex, type UnitId, type VisionClauseId, parseInvocationId, specRev, canonicalIds, type NumberedId, compareIds,
} from '../core/ids.ts';
import { type LaneDef, type NeedsUserContent, type NeedsUserReason, type SpecM1, specObligations } from '../core/records.ts';
import { type CheckpointState, openAttempt } from '../core/state.ts';
import { bundleClassesOf } from '../core/upgrade.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPath, absPath, branchRef } from '../core/values.ts';
import { git, revParse } from '../git/git.ts';
import {
  type InForce, type InputFile, type InputFiles, type RevisionInForce, type RoutingBase, inForceFiles, keptPayload, ledgerPath, requirePlanInForce, revisionInForce,
  sidecarPath,
} from '../input/inforce.ts';
import { type PlanM1, advancesOf, contractOpDocuments, parsePlan } from '../input/plan.ts';
import { type RevisionContext, evaluateRevision, keepRevision, payloadOf } from '../commands/apply.ts';
import { mayOverlap } from '../input/classify.ts';
import { raiseNeedsUser, readNeedsUser } from '../needsuser.ts';
import { laneEnvId, observations, observedViews } from '../pipeline/lanes.ts';
import { conversionsOf, rulingContextAt } from '../pipeline/publish.ts';
import { type BundleOp, type CheckpointOutput, splitChildAnchor } from '../prompts/schemas.ts';
import { type DocsPublisher, commitRevision } from '../recover/revision.ts';
import { SpecPatchOpError, SpecPatchStaleError, applySpecPatch } from '../spec/patch.ts';
import { ledgerAfter, parseRulings, sidecarsAfter, validateRuling } from '../spec/rulings.ts';
import { SpecFileError, parseSpec, specBytes } from '../spec/spec.ts';
import { mintDebt } from '../debt/mint.ts';
import { baselineDebtAt } from '../phase0/rows.ts';
import {
  type AdmitClassification, type AdmitOp, type AdmitWorld, type AuditRange, type RecordedAdmit, type UnitMerge, admitOpOf, classifyAdmits, conversionReasons, namedUnits, opportunityClauses,
} from './admits.ts';
import { admitSummary, amendmentReasons, appendAmendment, checkpointAmendments, conversionAmendment, divergenceAmendments } from './amendments.ts';
import type { AuditContext } from './audit.ts';
import { type AppliedBundle, brakesOf, raiseBound, secondChanges } from './convergence.ts';
import { publishedHeads } from './coverage.ts';
import { type DivergenceBase, appendDivergences, interpretationDivergences, opDivergences, raiseDigest } from './divergence.ts';
import { isActive, ruleFinding, rulingRefusal } from './findings.ts';
import { intakeReasons, issueReuse, settleIntake } from './intake.ts';
import { type Observation, keyOf, observedVerdict, reuse } from './observe.ts';
import {
  type BundleRejection, type BusyAttempt, type ClassifiedAdmit, type Conversion, type ObligationAnchor, type ObligationDef, type Obligations, type OwnerOnlyClass, type RevisionVector,
  type RulingSidecar, isExempt, laneRevOf, observationKeyText, parseObligations, parseRulingSidecar,
} from './types.ts';
import { citeReasons } from './vision.ts';

/** What a checkpoint needs beyond an audit's context: the revision core's plan file, routing base and docs publisher. */
export type CheckpointContext = AuditContext & Readonly<{ planFile: AbsPath; routingBase: RoutingBase; docs: DocsPublisher }>;

/** A checkpoint's captured inputs, as the fold has them. */
export type Captured = CheckpointState['inputs'];

export type BundleDecision =
  | Readonly<{ kind: 'applied'; planRev: PlanRev }>
  /** `conversions` (M4a rev 3): the admits code converted, when nothing else of the bundle changes the arc; absent: none. */
  | Readonly<{ kind: 'no-op'; conversions?: readonly Conversion[] }>
  /** `units` exactly on a `busy` rejection: the open attempts the bundle touched. */
  | Readonly<{ kind: 'rejected'; reason: BundleRejection; detail: string; units?: readonly BusyAttempt[] }>
  | Readonly<{ kind: 'requested'; needsUser: NeedsUserId; reason: Extract<NeedsUserReason, 'bundle-request' | 'owner-request'> }>;

/** One activation: the deciding job, the inputs the output was decided on, the output, and the call that produced it. */
export type Activation = Readonly<{
  job: JobId;
  /** The inputs the output was built on (an enactment's: the requesting job's). */
  captured: Captured;
  output: CheckpointOutput;
  /** The checkpoint call that produced `output`. */
  inv: InvocationId;
  /** An owner-approved bundle request (A9): draining and the brakes do not apply to it. */
  enact: boolean;
  /** Its trigger was rejected invalid once already: this bundle, if invalid, goes to the owner. */
  secondInvalid: boolean;
  /** Every bundle applied before, in log order (the brakes count them). */
  applied: readonly AppliedBundle[];
}>;

const jobParent = (job: JobId): Parent => ({ type: 'job', job });

// ---------------------------------------------------------------------------------------------------
// Needs-user items of a job

/** The item of `reason` a job raised, or null. */
function raisedItem(ctx: CheckpointContext, job: JobId, reason: NeedsUserReason): NeedsUserId | null {
  const view = ctx.journal.view;
  const key = canonicalJson(jobParent(job));
  return view.opsOf('needsuser.raise').find((i) => canonicalJson(i.parent) === key && view.doneOf(i.op) !== null
    && readNeedsUser(ctx.runDir, i.expect.id)?.reason === reason)?.expect.id ?? null;
}

/** Raises `content` for `job` once (a run again after a crash finds it by parent and reason). */
export function raiseOnce(ctx: CheckpointContext, job: JobId, content: NeedsUserContent): NeedsUserId {
  return raisedItem(ctx, job, content.reason) ?? raiseNeedsUser(ctx.journal, ctx.runDir, content, jobParent(job));
}

const opText = (op: BundleOp): string => {
  const { cites, evidence: _e, ...body } = op;
  return `${canonicalJson(body)} citing ${cites.join(', ')}`;
};

/**
 * Run 10 (E): a request the executor cannot apply (an invalid bundle, a checkpoint failing twice) always offers both
 * answers explicitly; at the close-out an unanswered one is declined (src/holistic/closeout.ts).
 */
export const INVALID_REQUEST_OPTIONS = [
  { id: 'acknowledge', label: 'Handled: any change it needs was made with roadmap apply (or none is needed)' },
  { id: 'decline', label: 'Drop the request' },
] as const;

/**
 * A non-blocking `bundle-request` (A9): `applicable` offers `apply` or `reject`; an invalid one `acknowledge` or `decline`
 * (`INVALID_REQUEST_OPTIONS`).
 */
function bundleRequest(ctx: CheckpointContext, a: Activation, why: string, applicable: boolean): NeedsUserId {
  return raiseOnce(ctx, a.job, {
    blocking: false,
    subject: { type: 'arc' },
    reason: 'bundle-request',
    summary: `Checkpoint ${a.job} proposes a bundle it may not apply by itself: ${why}. Units keep running. Its ops: ${a.output.ops.map(opText).join('; ')}.`,
    recommendation: applicable
      ? 'Choose `apply` to have the executor apply it as proposed (checked again against the arc then: a stale bundle is re-evaluated), or `reject` to drop it.'
      : 'It cannot be applied as proposed. Make the change yourself with `roadmap apply` if it is wanted, then choose `acknowledge`; or choose `decline` to drop it.',
    options: applicable ? [{ id: 'apply', label: 'Apply the bundle as proposed' }, { id: 'reject', label: 'Drop the bundle' }] : INVALID_REQUEST_OPTIONS,
    evidence: [],
  });
}

// ---------------------------------------------------------------------------------------------------
// The revisions now

/** The revision vector at `head` (the plan and specs in force, the inputs' bytes, the contracts' blobs at `head`). */
export function vectorAt(ctx: CheckpointContext, inForce: InForce, revision: RevisionInForce, files: InputFiles, head: ReturnType<typeof revParse>): RevisionVector {
  if (revision.vision === null) throw new Error('a checkpoint outside a holistic revision in force');
  const specs: Record<UnitId, number> = {};
  for (const u of [...inForce.plan.units].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const f = files.specs.get(u.id);
    if (f?.bytes === null || f === undefined) throw new Error(`unit ${u.id} is in force without a spec`);
    specs[u.id] = parseSpec(f.bytes, f.path).rev;
  }
  const blobs = rulingContextAt(readerOf(ctx), head);
  return {
    plan: inForce.rev,
    specs,
    obligationsSha256: revision.manifest.obligations,
    ledgerSha256: revision.ledger.sha256,
    visionSha256: revision.vision.sha256,
    contracts: contractOpDocuments(inForce.plan).flatMap((path) => {
      const blob = blobs.blobAt(path);
      return blob === null ? [] : [{ path, blob }];
    }),
  };
}

const readerOf = (ctx: CheckpointContext) => ({ journal: ctx.journal, runDir: ctx.runDir, planFile: ctx.planFile, repo: ctx.repo });
const revisionContext = (ctx: CheckpointContext): RevisionContext => ({ runDir: ctx.runDir, view: ctx.journal.view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase });
const integrationHead = (ctx: CheckpointContext) => revParse(ctx.repo, branchRef(ctx.plan().integrationBranch));

/** The plan's bytes (sha256) at plan rev `rev`, from its revision's payload. */
function planShaAt(ctx: CheckpointContext, rev: number): string {
  const fact = ctx.journal.view.planApplied();
  if (fact?.rev === rev) return fact.planSha256;
  const r = appliedByRev(ctx, rev);
  return r.manifest.planSha256;
}

function appliedByRev(ctx: CheckpointContext, rev: number) {
  const view = ctx.journal.view;
  for (const commit of view.opsOf('revision.commit')) {
    if (commit.expect.rev !== rev || view.doneOf(commit.op) === null) continue;
    return keptPayload(ctx.runDir, commit.expect.payloadSha256);
  }
  throw new Error(`plan rev ${rev} has no applied revision.commit (a checkpoint captures only a holistic revision)`);
}

// ---------------------------------------------------------------------------------------------------
// The proposal: the revision in force plus the ops

/** What the ops touch: for staleness and the preimages. */
type Touched = { plan: boolean; specs: Set<UnitId>; obligations: boolean; ledger: boolean; contracts: Set<RepoPath> };

/** An op of the output with its index there (a converted admit drops out; the rest keep their index). */
type IndexedOp = Readonly<{ index: number; op: BundleOp }>;
const indexed = (ops: readonly BundleOp[]): readonly IndexedOp[] => ops.map((op, index) => ({ index, op }));

/**
 * What a proposal is built from: the effective ops; the clauses this bundle's opportunities add to `holistic.advances`;
 * and (a corpus arc) the clauses a split child moving a census state may serve (C4), null outside a corpus arc.
 */
type ProposalOpts = Readonly<{ ops: readonly IndexedOp[]; addAdvances: readonly VisionClauseId[]; slice: ReadonlySet<VisionClauseId> | null }>;

type Proposal = Readonly<{
  files: InputFiles;
  /** The obligations with the ops applied (the obligations in force when they do not parse or nothing touched them). */
  obligations: Obligations | null;
  landing: readonly RulingSidecar[];
  touched: Touched;
  /** The lanes the ops bring in (an admitted spec's, a patch's added or replaced lanes). */
  lanes: readonly LaneDef[];
  /** Contract ops of landing rulings on a path outside the plan's contracts and architecture doc (H10). */
  outsidePaths: readonly RepoPath[];
  reasons: readonly string[];
}>;

type RawUnit = Record<string, unknown> & { id: string };
type RawPlan = Record<string, unknown> & { units: RawUnit[]; limits?: Record<string, number> };
type RawObligation = Record<string, unknown> & { id: string; state: unknown; witness: unknown; proofJudgment: unknown };
type RawObligations = Record<string, unknown> & { obligations: RawObligation[] };

const TERMINAL = ['waived', 'deferred', 'retired'] as const;
const isTerminal = (d: string): d is (typeof TERMINAL)[number] => (TERMINAL as readonly string[]).includes(d);
const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const judgedPaths = (s: RulingSidecar): readonly RepoPath[] => [...new Set([...s.contractRefs, ...s.contractOps.map((o) => o.path)])].sort();

/** The routing rev the checkpoint call `inv` ran under (its spawn's subject). */
function callRoutingRev(ctx: CheckpointContext, inv: InvocationId): RoutingRev {
  const intent = ctx.journal.view.latestIntent(parseInvocationId(inv).op);
  if (intent === null || intent.kind !== 'proc.spawn' || intent.expect.subject.purpose !== 'arc-backend') throw new Error(`${inv} is no arc-backend call`);
  return intent.expect.subject.routingRev;
}

/**
 * A model-written numbered id in numeric form (M4a rev 3, C3): `C-01` is `C-1`, as the ids' comparator (9c35bfe) orders
 * them, so a padded id never makes a second ruling of one. Only what the executor reads from the answer is canonicalised;
 * stored records are never rewritten.
 */
export const numericId = <T extends string>(id: T): T => id.replace(/^([A-Z])-0+(?=[0-9])/, '$1-') as T;

/** The output with every model-written ruling id of its ops in numeric form (`rule`, `obligation-dispose`, `reenter.reset`, a patch's `cite.rulings`). */
export function numericRulingIds(output: CheckpointOutput): CheckpointOutput {
  const ops = output.ops.map((op): BundleOp => {
    switch (op.op) {
      case 'rule':
      case 'obligation-dispose':
        return { ...op, ruling: numericId(op.ruling) };
      case 'reenter':
        return op.reset === null ? op : { ...op, reset: numericId(op.reset) };
      case 'patch-spec':
        return { ...op, patch: op.patch.map((x) => (x.op === 'cite' ? { ...x, rulings: x.rulings.map(numericId) } : x)) };
      default:
        return op;
    }
  });
  return { ...output, ops };
}

/**
 * A model-written ruling's ids in numeric form (`id`, `supersedes[].id`, C3) and its id lists (`obligations`, `cites`,
 * `obligationDispositions` by id) put in canonical order before the sidecar reader, which requires it: the model's order
 * never invalidates a ruling. Anything else is the reader's to refuse (a malformed id throws InvalidIdError, a
 * SchemaError: the ruling's reason).
 */
function answerIdOrder(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  if (typeof out['id'] === 'string') out['id'] = numericId(out['id']);
  const sup = out['supersedes'];
  if (Array.isArray(sup)) out['supersedes'] = sup.map((x) => (typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string' ? { ...x, id: numericId((x as { id: string }).id) } : x));
  for (const key of ['obligations', 'cites'] as const) {
    const v = out[key];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[key] = [...(v as NumberedId[])].sort(compareIds);
  }
  const d = out['obligationDispositions'];
  if (Array.isArray(d) && d.every((x) => typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string')) {
    out['obligationDispositions'] = [...(d as { id: NumberedId }[])].sort((x, y) => compareIds(x.id, y.id));
  }
  return out;
}

/**
 * The rulings of the output, each parsed with what the executor stamps (lead ruling): `ruledBy: checkpoint{job}` and a
 * `consistency` judged by the checkpoint at the captured head and revisions (the model echoes none).
 */
function stampedRulings(ctx: CheckpointContext, a: Activation, reasons: string[]): readonly RulingSidecar[] {
  const at = rulingContextAt(readerOf(ctx), a.captured.headSha);
  const routingRev = callRoutingRev(ctx, a.inv);
  const ledgerSha256 = a.captured.vector.ledgerSha256;
  if (ledgerSha256 === null) throw new Error(`${a.job}: a holistic revision keeps its ledger, but the capture names none`);
  return a.output.rulings.flatMap((text, i) => {
    try {
      const raw = answerIdOrder(JSON.parse(text) as Record<string, unknown>);
      const draft = parseRulingSidecar({
        ...raw, ruledBy: { type: 'checkpoint', job: a.job },
        consistency: {
          verdict: 'consistent',
          // M4a rev 3 (C2): the pin the checkpoint read, so a corpus arc's ruling is consistent with the corpus in force.
          judgedRevs: {
            head: a.captured.headSha, ledgerSha256, obligationsSha256: a.captured.vector.obligationsSha256, visionSha256: a.captured.visionSha256, contracts: [],
            ...(a.captured.corpusSha256 === undefined ? {} : { corpusSha256: a.captured.corpusSha256 }),
          },
          by: { type: 'judgment', role: 'checkpoint', routingRev },
        },
      });
      const contracts = judgedPaths(draft).flatMap((path) => {
        const blob = at.blobAt(path);
        return blob === null ? [] : [{ path, blob }];
      });
      return [{ ...draft, consistency: { ...draft.consistency, judgedRevs: { ...draft.consistency.judgedRevs, contracts } } }];
    } catch (error) {
      if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
      reasons.push(`ruling ${i + 1} is not a ruling sidecar: ${error.message}`);
      return [];
    }
  });
}

/**
 * A split child as the obligations file holds it, anchored at its doc ref or at its rule with the hash `anchor` resolved
 * in the pin in force; its proof is the checkpoint's own judgment of the witness it names.
 */
function childOf(parent: ObligationDef, op: Extract<BundleOp, { op: 'obligation-split' }>, c: Extract<BundleOp, { op: 'obligation-split' }>['children'][number], laneRev: string, anchor: ObligationAnchor): Record<string, unknown> {
  const serves = canonicalIds([...parent.serves, ...op.cites]);
  return {
    id: c.id, rev: 1, statement: c.statement, ...anchor, serves, witness: c.witness,
    proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev, witness: c.witness },
    deliveredBy: c.deliveredBy, activation: c.activation, parent: parent.id, contracts: parent.contracts, state: { type: 'active' },
  };
}

/** `declared` ∪ every non-exempt obligation a mapping pattern that may overlap `scope` names (prefix-conservative), ascending. */
function mappedObligations(obligations: Obligations, scope: readonly string[], declared: readonly ObligationId[]): readonly ObligationId[] {
  const live = new Set(obligations.obligations.filter((o) => !isExempt(o)).map((o) => o.id));
  const mapped = obligations.mapping.paths.filter((m) => scope.some((p) => mayOverlap(p, m.pattern))).flatMap((m) => m.obligations).filter((id) => live.has(id));
  return canonicalIds([...declared, ...mapped]);
}

/** The revision in force with every op of `opts` applied, or the reasons it cannot be built; nothing is written. */
function proposalOf(ctx: CheckpointContext, a: Activation, inForce: InForce, revision: RevisionInForce, current: InputFiles, opts: ProposalOpts): Proposal {
  const reasons: string[] = [];
  const touched: Touched = { plan: false, specs: new Set(), obligations: false, ledger: false, contracts: new Set() };
  const lanes: LaneDef[] = [];
  /** The units whose spec this bundle writes (admit, patch-spec, reenter): their `obligations` are code's to complete. */
  const authored = new Set<UnitId>();
  const plan = JSON.parse(current.planBytes.toString('utf8')) as RawPlan;
  const specs = new Map<UnitId, InputFile>(current.specs);
  const obligationsRaw = current.obligations?.bytes == null ? null : JSON.parse(current.obligations.bytes.toString('utf8')) as RawObligations;
  const obligationsNow = revision.obligations?.value ?? null;
  const pinRules = new Map<string, Sha256Hex>((revision.corpus?.pin.value.rules ?? []).map((r) => [r.id, r.textSha256]));
  const pinned = (id: RuleId): Sha256Hex | null => pinRules.get(id) ?? null;
  const unit = (id: string): RawUnit | undefined => plan.units.find((u) => u.id === id);
  const specOf = (id: UnitId): SpecM1 | null => {
    const f = specs.get(id);
    return f?.bytes == null ? null : parseSpec(f.bytes, f.path);
  };
  const specPath = (id: UnitId): AbsPath => absPath(join(ctx.planFile, '..', `${id}.json`));

  const landing = stampedRulings(ctx, a, reasons);
  const byId = new Map(landing.map((s) => [s.id as string, s]));
  const ruled = new Set(opts.ops.flatMap(({ op }) => (op.op === 'rule' ? [op.ruling as string] : [])));
  for (const s of landing) if (!ruled.has(s.id)) reasons.push(`ruling ${s.id} lands through no \`rule\` op`);
  const documents = new Set<RepoPath>(contractOpDocuments(inForce.plan));
  const outsidePaths = [...new Set(landing.flatMap((s) => s.contractOps.map((o) => o.path).filter((p) => !documents.has(p))))].sort();

  let ledgerText = revision.ledger.bytes.toString('utf8');
  let sidecars = [...revision.sidecars.values()].map((s) => s.sidecar);
  const dispose = (id: ObligationId, disposition: string, ruling: RulingId): void => {
    if (!isTerminal(disposition)) return;
    const o = obligationsRaw?.obligations.find((x) => x.id === id);
    if (o === undefined) {
      reasons.push(`${ruling} dispositions ${id}, which the obligations in force do not hold`);
      return;
    }
    o.state = { type: disposition, ruling };
    touched.obligations = true;
  };

  opts.ops.forEach(({ op, index: i }) => {
    const at = `op ${i + 1} (${op.op})`;
    switch (op.op) {
      case 'admit': {
        if (unit(op.unit.id) !== undefined) {
          reasons.push(`${at}: unit ${op.unit.id} is already planned`);
          return;
        }
        let spec: SpecM1;
        try {
          spec = parseSpec(Buffer.from(op.spec, 'utf8'), specPath(op.unit.id));
        } catch (error) {
          if (!(error instanceof SpecFileError || error instanceof SchemaError)) throw error;
          reasons.push(`${at}: its spec is not a unit spec: ${error.message}`);
          return;
        }
        if (spec.unit !== op.unit.id || spec.rev !== 1) reasons.push(`${at}: its spec names unit ${spec.unit} rev ${spec.rev}, not ${op.unit.id} rev 1`);
        plan.units.push({ id: op.unit.id, spec: `${op.unit.id}.json`, risk: op.unit.risk, scope: op.unit.scope, resources: [], after: op.unit.after, origin: op.unit.origin });
        specs.set(op.unit.id, { path: specPath(op.unit.id), bytes: specBytes(spec) });
        authored.add(op.unit.id);
        lanes.push(...spec.lanes);
        touched.plan = true;
        return;
      }
      case 'patch-spec': {
        const spec = unit(op.unit) === undefined ? null : specOf(op.unit);
        if (spec === null) {
          reasons.push(`${at}: unit ${op.unit} is not planned`);
          return;
        }
        try {
          specs.set(op.unit, { path: specs.get(op.unit)!.path, bytes: specBytes(applySpecPatch(spec, { expectRev: spec.rev, by: { role: 'executor', inv: a.inv }, ops: op.patch })) });
        } catch (error) {
          if (!(error instanceof SpecPatchOpError || error instanceof SpecPatchStaleError)) throw error;
          reasons.push(`${at}: ${error.message}`);
          return;
        }
        for (const p of op.patch) if ((p.op === 'add' || p.op === 'replace') && p.section === 'lanes') lanes.push(p.item as LaneDef);
        touched.specs.add(op.unit);
        authored.add(op.unit);
        return;
      }
      case 'reenter': {
        const old = unit(op.reenters);
        const spec = old === undefined ? null : specOf(op.reenters);
        if (old === undefined || spec === null) {
          reasons.push(`${at}: unit ${op.reenters} is not planned`);
          return;
        }
        if (unit(op.unit) !== undefined) {
          reasons.push(`${at}: unit ${op.unit} is already planned`);
          return;
        }
        const { cut: _cut, reenters: _r, ...rest } = old;
        plan.units.push({
          ...rest, id: op.unit, spec: `${op.unit}.json`, contingent: [],
          reenters: { unit: op.reenters, ...(op.enterAt === null ? {} : { enterAt: op.enterAt }), ...(op.reset === null ? {} : { reset: { ruling: op.reset } }) },
        });
        specs.set(op.unit, { path: specPath(op.unit), bytes: specBytes({ ...spec, unit: op.unit, rev: specRev(1) }) });
        authored.add(op.unit);
        touched.plan = true;
        touched.specs.add(op.reenters);
        return;
      }
      case 'cut': {
        const u = unit(op.unit);
        if (u === undefined) {
          reasons.push(`${at}: unit ${op.unit} is not planned`);
          return;
        }
        u['cut'] = { reason: op.reason };
        touched.plan = true;
        return;
      }
      case 'route': {
        const u = unit(op.unit);
        if (u === undefined) {
          reasons.push(`${at}: unit ${op.unit} is not planned`);
          return;
        }
        const routing = { ...(u['routing'] as Record<string, Record<string, string>> | undefined) };
        for (const s of op.seats) routing[s.role] = { ...routing[s.role], [s.tier]: s.class };
        u['routing'] = routing;
        touched.plan = true;
        return;
      }
      case 'limits': {
        if (op.unit !== null && unit(op.unit) === undefined) {
          reasons.push(`${at}: unit ${op.unit} is not planned`);
          return;
        }
        if (op.unit !== null && op.limits.some((l) => l.field === 'convergenceK')) reasons.push(`${at}: convergenceK is arc-wide (unit null)`);
        const target = op.unit === null ? plan : unit(op.unit)!;
        const limits = { ...(target['limits'] as Record<string, number> | undefined) };
        for (const l of op.limits) limits[l.field] = l.value;
        target['limits'] = limits;
        touched.plan = true;
        return;
      }
      case 'obligation-split': {
        const parent = obligationsNow?.obligations.find((o) => o.id === op.obligation);
        const raw = obligationsRaw?.obligations.find((o) => o.id === op.obligation);
        if (parent === undefined || raw === undefined || obligationsRaw === null || obligationsNow === null) {
          reasons.push(`${at}: obligation ${op.obligation} is not in force`);
          return;
        }
        if (parent.state.type !== 'active') {
          reasons.push(`${at}: ${op.obligation} is ${parent.state.type}, not active`);
          return;
        }
        const children = op.children.flatMap((c) => {
          const lane = obligationsNow.lanes.find((l) => l.id === c.witness.lane);
          if (lane === undefined) {
            reasons.push(`${at}: child ${c.id}'s witness lane ${c.witness.lane} is not an arc lane`);
            return [];
          }
          const anchor = splitChildAnchor(c, pinned);
          if (anchor === null) {
            reasons.push(`${at}: child ${c.id} is anchored at ${c.rule}, which is no active rule of the pin in force`);
            return [];
          }
          const census = censusMove(obligationsRaw, parent, op, c, opts.slice);
          if (census !== null) {
            reasons.push(`${at}: ${census}`);
            return [];
          }
          return [childOf(parent, op, c, laneRevOf(lane), anchor)];
        });
        raw.state = { type: 'split', children: canonicalIds(op.children.map((c) => c.id)) };
        raw.witness = null;
        raw.proofJudgment = null;
        obligationsRaw.obligations.push(...(children as RawObligation[]));
        touched.obligations = true;
        return;
      }
      case 'obligation-dispose': {
        const s = byId.get(op.ruling) ?? revision.sidecars.get(op.ruling)?.sidecar;
        if (s === undefined || s.status !== 'active') {
          reasons.push(`${at}: ruling ${op.ruling} is neither in the bundle nor active in force`);
          return;
        }
        if (!s.obligationDispositions.some((d) => d.id === op.obligation && d.disposition === op.disposition)) {
          reasons.push(`${at}: ${op.ruling} does not disposition ${op.obligation} ${op.disposition}`);
          return;
        }
        dispose(op.obligation, op.disposition, op.ruling);
        return;
      }
      case 'rule': {
        const s = byId.get(op.ruling);
        if (s === undefined) {
          reasons.push(`${at}: ruling ${op.ruling} is not among the bundle's rulings`);
          return;
        }
        ledgerText = ledgerAfter(ledgerText, s);
        sidecars = [...sidecarsAfter(sidecars, s)];
        for (const d of s.obligationDispositions) dispose(d.id, d.disposition, s.id);
        touched.ledger = true;
        for (const p of judgedPaths(s)) touched.contracts.add(p);
        return;
      }
      case 'invalidate-approval':
        reasons.push(`${at}: no record voids a gate approval in 1.0.0-dev.6; re-enter ${op.unit} (\`reenter\`) or patch its spec before its gate instead`);
        return;
      case 'request':
        return;
    }
  });
  if (opts.addAdvances.length > 0) {
    const holistic = plan['holistic'] as { advances: VisionClauseId[] } | undefined;
    if (holistic === undefined) throw new Error(`${a.job}: an opportunity in an arc whose plan is not holistic`);
    holistic.advances = canonicalIds([...holistic.advances, ...opts.addAdvances]);
    touched.plan = true;
  }

  // The rulings, each at the tip with the earlier valid ones landed (their contract ops outside the documents are H10's).
  // An invalid ruling is never folded in: its reasons reject the bundle, and the ledger the next one is checked against
  // stays one the reader parses (paid M4a run 1: a proposed C-2 the ledger already held, folded, repeated the id and
  // crashed the executor).
  const tip = rulingContextAt(readerOf(ctx), integrationHead(ctx));
  let ledger = revision.ledger.bytes.toString('utf8');
  for (const s of landing) {
    const inside = { ...s, contractOps: s.contractOps.filter((o) => documents.has(o.path)) };
    const why = validateRuling(inside, { ...tip, ledger: parseRulings(ledger, 'the rulings ledger') });
    reasons.push(...why);
    if (why.length === 0) ledger = ledgerAfter(ledger, s);
  }

  let parsed: PlanM1 | null = null;
  const planBytes = touched.plan ? jsonBytes(plan) : current.planBytes;
  try {
    parsed = parsePlan(JSON.parse(planBytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    reasons.push(`the plan with the ops applied does not parse: ${error.message}`);
  }
  let obligations: InputFile | null = current.obligations;
  let obligationsAfter = obligationsNow;
  if (touched.obligations && current.obligations !== null && obligationsRaw !== null) {
    const bytes = jsonBytes(obligationsRaw);
    try {
      obligationsAfter = parseObligations(JSON.parse(bytes.toString('utf8')));
      obligations = { path: current.obligations.path, bytes };
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      reasons.push(`the obligations with the ops applied do not parse: ${error.message}`);
    }
  }
  if (parsed === null || reasons.length > 0) return { files: current, obligations: obligationsNow, landing, touched, lanes, outsidePaths, reasons };

  // Lead ruling (paid M3 run 5): a spec the bundle authors declares every obligation the impact mapping selects for its
  // scope, filled in by code (declared ∪ mapping-selected, non-exempt); the model never reproduces the mapping. The
  // classifier's refusal of narrower declarations stays for the architect's specs (DESIGN §2.3).
  if (obligationsAfter !== null) {
    for (const id of [...authored].sort()) {
      const u = parsed.units.find((x) => x.id === id);
      const f = specs.get(id);
      if (u === undefined || f?.bytes == null) continue;
      const spec = parseSpec(f.bytes, f.path);
      const widened = mappedObligations(obligationsAfter, [...u.scope, ...spec.scope], specObligations(spec));
      if (widened.length > 0 && canonicalJson(widened) !== canonicalJson(specObligations(spec))) specs.set(id, { path: f.path, bytes: specBytes({ ...spec, obligations: widened }) });
    }
  }

  const ledgerFile = ledgerPath(ctx.planFile, parsed);
  const sidecarFiles = new Map(sidecars.map((s) => {
    const kept = revision.sidecars.get(s.id);
    const bytes = kept !== undefined && kept.sidecar.status === s.status ? kept.bytes : jsonBytes(s);
    return [s.id, { path: sidecarPath(ledgerFile, s.id), bytes }] as const;
  }));
  const files: InputFiles = {
    ...current,
    plan: parsed,
    planBytes,
    specs: new Map(parsed.units.map((u) => [u.id, specs.get(u.id) ?? { path: specPath(u.id), bytes: null }] as const)),
    ledger: touched.ledger ? { path: current.ledger.path, bytes: Buffer.from(ledgerText, 'utf8') } : current.ledger,
    sidecars: touched.ledger ? sidecarFiles : current.sidecars,
    obligations,
  };
  return { files, obligations: obligationsAfter, landing, touched, lanes, outsidePaths, reasons };
}

/**
 * A split child anchored at another rule than its parent's (M4a rev 3, C4), in a corpus arc: when that rule's census
 * state is `out-of-slice` and the child serves only `slice` (the owner-selected slice and this bundle's opportunity
 * clauses), the census entry moves to `obligation{child}` in `raw` and this returns null; any other state, or a child
 * serving more, is the returned reason. Null too outside a corpus arc (`slice` null) and for a child on its parent's rule.
 */
function censusMove(
  raw: RawObligations | null, parent: ObligationDef, op: Extract<BundleOp, { op: 'obligation-split' }>, c: Extract<BundleOp, { op: 'obligation-split' }>['children'][number],
  slice: ReadonlySet<VisionClauseId> | null,
): string | null {
  if (slice === null || c.rule === null || raw === null) return null;
  const parentRule = parent.rule?.id ?? null;
  if (c.rule === parentRule) return null;
  const census = raw['census'] as { rule: string; state: { type: string; id?: string } }[] | undefined;
  if (census === undefined) throw new Error(`a corpus arc's obligations hold no census (split of ${parent.id})`);
  const entry = census.find((e) => e.rule === c.rule);
  const fix = `anchor the child at its parent's rule ${parentRule ?? '(none)'}, or admit it as an opportunity`;
  if (entry === undefined) return `child ${c.id} is anchored at ${c.rule}, which the census does not name: ${fix}`;
  const state = entry.state.type === 'obligation' ? `obligation{${entry.state.id}}` : entry.state.type;
  if (entry.state.type !== 'out-of-slice') return `child ${c.id} is anchored at ${c.rule}, whose census state is ${state}: ${fix}`;
  const serves = canonicalIds([...parent.serves, ...op.cites]);
  const outside = serves.filter((v) => !slice.has(v));
  if (outside.length > 0) return `child ${c.id} is anchored at ${c.rule}, whose census state is out-of-slice, and it serves ${outside.join(', ')}, outside the slice: ${fix}`;
  entry.state = { type: 'obligation', id: c.id };
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The checks

/** Why the bundle is stale against the captured vector (H3: the vision always), or empty. */
function staleness(ctx: CheckpointContext, a: Activation, p: Proposal, now: RevisionVector, inForce: InForce): readonly string[] {
  const was = a.captured.vector;
  const out: string[] = [];
  if (was.visionSha256 !== now.visionSha256) out.push('the vision changed since the checkpoint read it');
  if (p.touched.plan && planShaAt(ctx, was.plan) !== inForce.manifest.planSha256) out.push(`the plan changed since plan rev ${was.plan}`);
  for (const u of [...p.touched.specs].sort()) {
    if (was.specs[u] !== now.specs[u]) out.push(`the spec of ${u} moved from rev ${was.specs[u] ?? 'none'} to ${now.specs[u] ?? 'none'}`);
  }
  if (p.touched.obligations && was.obligationsSha256 !== now.obligationsSha256) out.push('the obligations changed since the checkpoint read them');
  if (p.touched.ledger && was.ledgerSha256 !== now.ledgerSha256) out.push('the rulings ledger changed since the checkpoint read it');
  if (p.touched.contracts.size > 0) {
    const then = rulingContextAt(readerOf(ctx), a.captured.headSha);
    const tip = rulingContextAt(readerOf(ctx), integrationHead(ctx));
    for (const path of [...p.touched.contracts].sort()) if (then.blobAt(path) !== tip.blobAt(path)) out.push(`contract ${path} changed since the checkpoint read it`);
  }
  const fold = ctx.journal.view.holistic();
  for (const d of a.output.findingDispositions) {
    const f = fold.findings.find((x) => x.id === d.finding);
    if (f !== undefined && a.captured.findings.includes(d.finding) && !isActive(f)) out.push(`finding ${d.finding} is ${f.state} since the checkpoint read it`);
  }
  return out;
}

/** Why the output's cites and finding dispositions are invalid, or empty (H16: active clauses only). */
function citeAndDispositionReasons(ctx: CheckpointContext, a: Activation, revision: RevisionInForce): readonly string[] {
  const vision = revision.vision?.value ?? null;
  const out: string[] = [];
  a.output.ops.forEach((op, i) => out.push(...citeReasons(vision, op.cites, `op ${i + 1} (${op.op})`)));
  a.output.interpretations.forEach((x, i) => out.push(...citeReasons(vision, x.clauses, `interpretation ${i + 1}`)));
  out.push(...citeReasons(vision, a.output.cites.vision, 'the decision'));
  const shown = new Set(a.captured.observations.map(observationKeyText));
  for (const k of a.output.cites.observations) if (!shown.has(observationKeyText(k))) out.push(`the decision cites observation ${observationKeyText(k)}, which it was not given`);
  for (const f of a.output.cites.findings) if (!a.captured.findings.includes(f)) out.push(`the decision cites finding ${f}, which it was not given`);
  const fold = ctx.journal.view.holistic();
  const seen = new Set<string>();
  for (const d of a.output.findingDispositions) {
    if (seen.has(d.finding)) out.push(`finding ${d.finding} is disposed twice`);
    seen.add(d.finding);
    const f = fold.findings.find((x) => x.id === d.finding);
    if (f === undefined || !a.captured.findings.includes(d.finding)) {
      out.push(`finding ${d.finding} was not among the checkpoint's findings`);
      continue;
    }
    if (!isActive(f)) continue;
    const refusal = rulingRefusal(f, d.disposition, { type: 'checkpoint', job: a.job });
    if (refusal !== null) out.push(refusal);
  }
  return out;
}

/** A16, H10: the owner-only requests of the bundle, explicit and nested. */
function ownerOnly(ctx: CheckpointContext, a: Activation, p: Proposal, inForce: InForce, current: InputFiles, revision: RevisionInForce): readonly Readonly<{ class: OwnerOnlyClass; summary: string }>[] {
  const out: { class: OwnerOnlyClass; summary: string }[] = [];
  for (const op of a.output.ops) if (op.op === 'request') out.push({ class: op.class, summary: op.summary });
  const inForceLanes: readonly LaneDef[] = [
    ...inForce.plan.suite.lanes,
    ...[...current.specs.values()].flatMap((f) => (f.bytes === null ? [] : parseSpec(f.bytes, f.path).lanes)),
    ...(revision.obligations?.value.lanes ?? []),
  ];
  const programs = new Set(inForceLanes.map((l) => l.argv[0]));
  const passed = new Set(inForceLanes.flatMap((l) => l.env.pass));
  for (const l of p.lanes) {
    if (!programs.has(l.argv[0])) out.push({ class: 'lane-program', summary: `lane ${l.id} runs ${JSON.stringify(l.argv[0])}, which no lane of the plan in force runs` });
    for (const name of l.env.pass.filter((n) => !passed.has(n))) out.push({ class: 'env-prerequisite', summary: `lane ${l.id} passes ${name}, which no lane of the plan in force needs` });
  }
  for (const path of p.outsidePaths) out.push({ class: 'contract-path', summary: `a contract op edits ${path}, outside the plan's contracts and architecture doc` });
  return out;
}

/**
 * Why a cited observation does not hold as evidence on the head (M4a rev 3, C1, R58), or null when it does: the head's
 * observation of the lane ran under the same lane rev and environment, neither record is malformed, the cited one records
 * a test, and every cited test has the same outcome on the head with at least as many selected. Tests the head adds, and
 * another tree or invocation with equal results, never matter.
 */
export function evidenceDiffers(cited: Observation, head: Observation): string | null {
  if (cited.key.laneRev !== head.key.laneRev || cited.key.envId !== head.key.envId) {
    return `ran under lane rev ${cited.key.laneRev} in env ${cited.key.envId}, the head's under ${head.key.laneRev} in ${head.key.envId}`;
  }
  if (cited.record.malformed) return 'is malformed';
  if (head.record.malformed) return 'is malformed on the head';
  if (cited.record.records.length === 0) return 'records no test';
  const onHead = new Map(head.record.records.map((r) => [r.testId, r]));
  for (const r of cited.record.records) {
    const h = onHead.get(r.testId);
    if (h === undefined) return `test ${JSON.stringify(r.testId)} is not in the head's record`;
    if (h.outcome !== r.outcome) return `test ${JSON.stringify(r.testId)} was ${r.outcome}, is ${h.outcome} on the head`;
    if (h.selected < r.selected) return `test ${JSON.stringify(r.testId)} selected ${r.selected}, ${h.selected} on the head`;
  }
  return null;
}

/** Step 5: the cited observations that do not hold on the head (`evidenceDiffers`), or are missing there, and their lanes. */
function evidenceBase(ctx: CheckpointContext, a: Activation, revision: RevisionInForce): Readonly<{ reasons: readonly string[]; lanes: readonly LaneId[] }> {
  const head = integrationHead(ctx);
  const tree = revParse(ctx.repo, `${head}^{tree}`);
  const store = observations(ctx);
  const reasons: string[] = [];
  const lanes = new Set<LaneId>();
  for (const k of a.output.cites.observations) {
    if (k.treeSha === tree) continue;
    const lane = revision.obligations?.value.lanes.find((l) => l.id === k.lane);
    if (lane === undefined) {
      reasons.push(`the cited observation ${observationKeyText(k)} names lane ${k.lane}, no arc lane in force`);
      continue;
    }
    const cited = reuse(store, k);
    const now = reuse(store, keyOf(tree, lane, laneEnvId(ctx, lane)));
    const why = now === null ? `has none on the head ${head}` : cited === null ? 'is not in the observation store' : evidenceDiffers(cited, now);
    if (why === null) continue;
    reasons.push(`the cited observation of lane ${k.lane} ${now === null ? why : `differs on the head ${head}: ${why}`}`);
    lanes.add(k.lane);
  }
  return { reasons, lanes: [...lanes].sort() };
}

// ---------------------------------------------------------------------------------------------------
// Busy (C5) and admit classes (B)

/** Step 0 (C5, R50): the open stage attempts of the planned units the ops change, ascending by unit. */
function busyAttempts(ctx: CheckpointContext, ops: readonly IndexedOp[]): readonly BusyAttempt[] {
  const view = ctx.journal.view;
  const planned = new Set(view.plannedUnits());
  const touched = new Set(ops.flatMap(({ op }) => (op.op === 'admit' || op.op === 'obligation-split' ? [] : namedUnits(op))));
  return [...touched].filter((u) => planned.has(u)).sort().flatMap((unit) => {
    const open = openAttempt(view, unit);
    return open === null ? [] : [{ unit, stage: open.stage, attempt: open.attempt }];
  });
}

/** The arc's classified admits so far (the done bundle revisions' sources), in log order; unclassified bundles count none. */
export function recordedAdmits(view: JournalView): readonly RecordedAdmit[] {
  return view.opsOf('revision.commit').flatMap((commit) => {
    const source = commit.expect.source;
    if (source.type !== 'bundle' || view.doneOf(commit.op) === null) return [];
    const classes = bundleClassesOf(source);
    return classes === 'unclassified' ? [] : classes.admits.map((x) => ({ job: source.job, ...x }));
  });
}

/** S = `holistic.advances` minus every recorded opportunity's clauses (R44). */
function ownerSlice(plan: PlanM1, recorded: readonly RecordedAdmit[]): ReadonlySet<VisionClauseId> {
  const opportunity = new Set(recorded.flatMap((x) => (x.class.type === 'opportunity' ? x.class.clauses : [])));
  return new Set(advancesOf(plan).filter((c) => !opportunity.has(c)));
}

/**
 * The integration history attribution reads (R46): each published head's position (the base 0, each published head the
 * next; `tip` is the base while nothing is published), each unit ff's first-parent paths, and each completed audit's
 * covered ranges by position. Classification and the drift indicator (status, brief) read the same.
 */
export function integrationHistory(view: JournalView, repo: AbsPath, tip: Sha): Readonly<{
  positions: ReadonlyMap<Sha, number>; merges: readonly UnitMerge[]; audits: ReadonlyMap<JobId, readonly AuditRange[]>;
}> {
  const heads = publishedHeads(view);
  const positions = new Map<Sha, number>();
  positions.set(heads.length > 0 ? heads[0]!.old : tip, 0);
  heads.forEach((h, i) => {
    if (!positions.has(h.head)) positions.set(h.head, i + 1);
  });
  const positionOf = (sha: Sha, what: string): number => {
    const p = positions.get(sha);
    if (p === undefined) throw new Error(`${what} names ${sha}, no head of the integration history`);
    return p;
  };
  const ffs = new Map(view.opsOf('integration.ff').map((i) => [i.op, i]));
  const merges = heads.flatMap((h, i): UnitMerge[] => {
    const parent = ffs.get(h.op)?.parent;
    if (h.subject !== 'unit' || parent?.type !== 'stage') return [];
    const paths = git(repo, ['diff', '--name-only', '--no-renames', h.old, h.head]).split('\n').filter((x) => x !== '');
    return [{ unit: parent.unit, position: i + 1, paths }];
  });
  const audits = new Map(view.holistic().audits.flatMap((x) => (x.ended === null ? [] : [[x.started.job, x.ended.covered.map((r): AuditRange => ({
    lens: r.lens, from: positionOf(r.from, `${x.started.job}'s ${r.lens} range`), to: positionOf(r.to, `${x.started.job}'s ${r.lens} range`),
  }))] as const])));
  return { positions, merges, audits };
}

/**
 * What classification reads (src/holistic/admits.ts), from the log, the revision in force, the obligations after the ops
 * and git: the integration history's positions (the base 0, each published head the next), each unit ff's first-parent
 * paths, each completed audit's covered ranges, the obligations' verdicts on the head and at every published head.
 */
export function admitWorldOf(
  ctx: CheckpointContext, a: Activation, revision: RevisionInForce, inForce: InForce, obligations: Obligations | null, recorded: readonly RecordedAdmit[],
): AdmitWorld {
  const view = ctx.journal.view;
  if (revision.vision === null) throw new Error(`${a.job}: admit classes outside a holistic revision`);
  const { positions, merges, audits } = integrationHistory(view, ctx.repo, integrationHead(ctx));
  const fold = view.holistic();
  const captured = new Set<FindingId>(a.captured.findings);
  const findings = new Map(fold.findings.map((f) => [f.id, {
    id: f.id, active: isActive(f), captured: captured.has(f.id), visionClauses: f.visionClauses, obligation: f.obligation, lens: f.lens, source: f.source,
    paths: f.evidence.map((e) => e.path),
  }] as const));
  const defs = obligations?.obligations ?? [];
  const head = integrationHead(ctx);
  const views = new Map(observedViews(ctx, obligations, defs, head).map((v) => [v.obligation.id, v]));
  const store = observations(ctx);
  const lanes = new Map((obligations?.lanes ?? []).map((l) => [l.id, l]));
  const trees = [...positions].map(([sha, position]) => ({ position, tree: revParse(ctx.repo, `${sha}^{tree}`) }));
  const world = new Map(defs.map((o) => {
    const v = views.get(o.id)!;
    const held = v.observation?.verdict === 'held';
    const holding = o.activation === 'must-hold' ? held : !(v.latched && !held);
    const lane = o.witness === null ? undefined : lanes.get(o.witness.lane);
    const history = lane === undefined || o.witness === null ? [] : trees.flatMap(({ position, tree }) => {
      const verdict = observedVerdict(store, keyOf(tree, lane, laneEnvId(ctx, lane)), o.witness!);
      return verdict === 'held' || verdict === 'not-held' ? [{ position, held: verdict === 'held' }] : [];
    });
    return [o.id, { def: o, holding, history }] as const;
  }));
  return {
    world: revision.vision.value.clauses.filter((c) => c.kind === 'world' && c.state === 'active').map((c) => c.id),
    advances: advancesOf(inForce.plan),
    recorded,
    rootOf: (u) => view.unit(u).lineage?.root ?? u,
    obligations: world,
    // The census in force (before this bundle's ops): a split child at an out-of-slice rule targets that rule.
    census: new Map((revision.obligations?.value.census ?? []).map((e) => [e.rule, e.state.type])),
    findings,
    audits,
    merges,
  };
}

/** The admit ops of `ops` for classification (the specs parsed when the proposal was built; `obligations` in force). */
function admitOps(ctx: CheckpointContext, ops: readonly IndexedOp[], obligations: Obligations | null): readonly AdmitOp[] {
  return ops.flatMap(({ op, index }) => (op.op === 'admit'
    ? [admitOpOf(index, op, parseSpec(Buffer.from(op.spec, 'utf8'), absPath(join(ctx.planFile, '..', `${op.unit.id}.json`))), obligations)]
    : []));
}

// ---------------------------------------------------------------------------------------------------
// The activation

/** The proposer of a bundle's revision: its split ops' cites and evidence back a split that drops text (H14); its admits' classes (OR-A1). */
function proposerOf(a: Activation, ops: readonly IndexedOp[], admits: readonly ClassifiedAdmit[]) {
  const splits = ops.map((x) => x.op).filter((op) => op.op === 'obligation-split');
  const from = splits.length > 0 ? splits : ops.map((x) => x.op);
  return {
    type: 'bundle' as const, job: a.job, cites: canonicalIds(from.flatMap((op) => op.cites)),
    evidence: [...new Set(from.flatMap((op) => op.evidence))],
    admits,
  };
}

/**
 * Activates one checkpoint decision (see the header) and records it: `plan-applied{source: bundle{job}}`, or
 * `bundle-decided`. Holds the revision fence throughout.
 */
export async function activate(ctx: CheckpointContext, a: Activation): Promise<BundleDecision> {
  const hold = await holdFence(ctx.journal);
  let decision: BundleDecision;
  try {
    decision = await decide(ctx, { ...a, output: numericRulingIds(a.output) });
  } finally {
    hold.release();
  }
  if (decision.kind === 'applied' || decision.kind === 'no-op') settleDecided(ctx, a.job, a.output, a.captured, a.applied);
  return decision;
}

function decided(ctx: CheckpointContext, job: JobId, decision: Exclude<BundleDecision, { kind: 'applied' }>): BundleDecision {
  const outcome = decision.kind === 'requested' ? { kind: 'requested' as const, needsUser: decision.needsUser } : decision;
  ctx.journal.fact({ kind: 'bundle-decided', job, outcome });
  return decision;
}

const NO_PROPOSAL = (current: InputFiles, obligations: Obligations | null): Proposal => ({
  files: current, obligations, landing: [], touched: { plan: false, specs: new Set<UnitId>(), obligations: false, ledger: false, contracts: new Set<RepoPath>() },
  lanes: [], outsidePaths: [], reasons: [],
});

async function decide(ctx: CheckpointContext, a: Activation): Promise<BundleDecision> {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce);
  const current = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile, ctx.repo);
  const now = vectorAt(ctx, inForce, revision, current, integrationHead(ctx));
  const all = indexed(a.output.ops);
  // M4a rev 3 (LR-h): admit classes, census moves and opportunities exist in a corpus arc only.
  const corpus = revision.corpus !== null && a.output.decision === 'bundle';
  const recorded = corpus ? recordedAdmits(ctx.journal.view) : [];
  const slice = corpus ? ownerSlice(inForce.plan, recorded) : null;
  // Before classification a split child may serve any clause an admit of this bundle cites (a would-be opportunity); the
  // rebuild below checks it against the bundle's actual opportunities.
  const firstSlice = slice === null ? null : new Set([...slice, ...all.flatMap(({ op }) => (op.op === 'admit' ? op.cites : []))]);
  let p = a.output.decision === 'no-op' ? NO_PROPOSAL(current, revision.obligations?.value ?? null) : proposalOf(ctx, a, inForce, revision, current, { ops: all, addAdvances: [], slice: firstSlice });

  // 0. Busy (C5): an op touching a unit with an open stage attempt waits for its boundary.
  const busy = busyAttempts(ctx, all);
  if (busy.length > 0) {
    const detail = `the bundle changes ${busy.map((b) => `${b.unit}, which is in ${b.stage} attempt ${b.attempt}`).join('; ')}; it is decided again at the stage boundary`;
    return decided(ctx, a.job, { kind: 'rejected', reason: 'busy', detail, units: busy });
  }

  // 1. Staleness (H3: the vision always).
  const stale = staleness(ctx, a, p, now, inForce);
  if (stale.length > 0) return decided(ctx, a.job, { kind: 'rejected', reason: 'stale', detail: stale.join('; ') });

  // 2. Validation (H16), and the proposal's own reasons; then (a corpus arc) the admit classes (OR-A1).
  const invalid = (reasons: readonly string[]): BundleDecision => (a.secondInvalid
    ? decided(ctx, a.job, { kind: 'requested', needsUser: bundleRequest(ctx, a, `it is invalid a second time (${reasons.join('; ')})`, false), reason: 'bundle-request' })
    : decided(ctx, a.job, { kind: 'rejected', reason: 'invalid', detail: reasons.join('; ') }));
  const pin = revision.corpus?.pin.value ?? null;
  const reasons = [
    ...citeAndDispositionReasons(ctx, a, revision), ...amendmentReasons(pin, a.output), ...intakeReasons(ctx.runDir, a.captured, pin, a.output, issueReuse(view, ctx.runDir, a.captured)), ...p.reasons,
  ];
  if (reasons.length > 0) return invalid(reasons);
  let classes: AdmitClassification | null = null;
  let ops = all;
  if (corpus) {
    const admits = admitOps(ctx, all, revision.obligations?.value ?? null);
    classes = admits.length === 0 ? { classes: [], conversions: [], reasons: [] } : classifyAdmits(admitWorldOf(ctx, a, revision, inForce, p.obligations, recorded), admits);
    const why = [...classes.reasons, ...conversionReasons(a.output, classes.conversions)];
    if (why.length > 0) return invalid(why);
    const dropped = new Set(classes.conversions.map((c) => c.index));
    ops = all.filter((x) => !dropped.has(x.index));
    const added = opportunityClauses(classes.classes);
    if (dropped.size > 0 || added.length > 0 || ops.some(({ op }) => op.op === 'obligation-split')) {
      p = proposalOf(ctx, a, inForce, revision, current, { ops, addAdvances: added, slice: new Set([...slice!, ...added]) });
      if (p.reasons.length > 0) return invalid(p.reasons);
    }
  }
  const conversions = classes?.conversions ?? [];
  const noOp = (): BundleDecision => {
    const d = decided(ctx, a.job, conversions.length === 0 ? { kind: 'no-op' } : { kind: 'no-op', conversions });
    crashPoint('bundle.after-decided');
    return d;
  };

  // 3. Owner-only (A16, H10): nothing applied.
  const requests = ownerOnly(ctx, a, p, inForce, current, revision);
  if (requests.length > 0) {
    const needsUser = raiseOnce(ctx, a.job, {
      blocking: true,
      subject: { type: 'arc' },
      reason: 'owner-request',
      summary: `Checkpoint ${a.job} asks for acts only the owner may take: ${requests.map((r) => `[${r.class}] ${r.summary}`).join('; ')}. Nothing of its bundle was applied.`,
      recommendation: 'Decide each request: take the act yourself (for a plan change, `roadmap apply`) or leave it. Acknowledge this item when done; the next checkpoint reads the arc as it then is.',
      options: [],
      evidence: [],
    });
    return decided(ctx, a.job, { kind: 'requested', needsUser, reason: 'owner-request' });
  }

  // 4. Draining: an admit goes to the owner.
  if (!a.enact && view.holistic().draining !== null && ops.some(({ op }) => op.op === 'admit')) {
    return decided(ctx, a.job, { kind: 'requested', needsUser: bundleRequest(ctx, a, 'the arc is draining (admissions closed) and the bundle admits a unit', true), reason: 'bundle-request' });
  }

  // 5. The evidence base.
  const evidence = evidenceBase(ctx, a, revision);
  if (evidence.reasons.length > 0) return decided(ctx, a.job, { kind: 'rejected', reason: 'evidence', detail: evidence.reasons.join('; ') });

  // 6. Convergence (A9, OR-Q2/3), over the effective ops.
  if (!a.enact && a.output.decision === 'bundle') {
    const rootOf = (u: UnitId): UnitId => view.unit(u).lineage?.root ?? u;
    const known = new Set<string>([...view.holistic().findings.map((f) => f.id as string), ...(revision.obligations?.value.obligations.map((o) => o.id as string) ?? [])]);
    const brakes = brakesOf(view, ctx.runDir, inForce.plan, a.applied, known, rootOf);
    if (brakes.open.length > 0) {
      return decided(ctx, a.job, { kind: 'requested', needsUser: bundleRequest(ctx, a, `a convergence brake is open (${brakes.open.join(', ')})`, true), reason: 'bundle-request' });
    }
    const second = secondChanges(brakes, ops.map((x) => x.op), known, rootOf);
    if (second.length > 0) {
      raiseOnce(ctx, a.job, {
        blocking: false,
        subject: { type: 'arc' },
        reason: 'convergence-identity',
        summary: `Checkpoint ${a.job} would change ${second.join(', ')} a second time (causal identity: finding or obligation @ lineage root). Units keep running; the checkpoint's bundles wait for the owner as bundle requests until this item is acknowledged.`,
        recommendation: 'Review the earlier change and this one (`roadmap status`); decide the bundle request, then acknowledge this item.',
        options: [],
        evidence: [],
      });
      return decided(ctx, a.job, { kind: 'requested', needsUser: bundleRequest(ctx, a, `it changes ${second.join(', ')} a second time`, true), reason: 'bundle-request' });
    }
  }

  // 7–8. All or none; no effective change is a no-op.
  const evaluated = a.output.decision === 'no-op' ? null : evaluateRevision(revisionContext(ctx), p.files, proposerOf(a, ops, classes?.classes ?? []));
  if (evaluated?.kind === 'rejected') return invalid(evaluated.reasons);
  if (evaluated === null || evaluated.kind === 'unchanged') return noOp();

  // 9. Divergences (H13), computed by code.
  const base: DivergenceBase = {
    job: a.job, planRev: inForce.rev, specRevs: now.specs, obligationsSha256: now.obligationsSha256,
    obligationRevs: new Map((revision.obligations?.value.obligations ?? []).map((o) => [o.id as string, o.rev])),
    ledgerSha256: now.ledgerSha256, blobAt: rulingContextAt(readerOf(ctx), a.captured.headSha).blobAt,
  };
  const draft = {
    ...evaluated.draft,
    divergences: [...evaluated.draft.divergences, ...opDivergences(base, ops.map((x) => x.op), p.landing), ...interpretationDivergences(a.job, a.captured.vector, a.output)],
  };

  // 10. The commit: plan-applied (a corpus arc's classes and conversions in its source, Q4), then the divergences from the payload.
  keepRevision(ctx.runDir, { ...evaluated, draft });
  const source = classes === null ? { type: 'bundle' as const, job: a.job } : { type: 'bundle' as const, job: a.job, admits: classes.classes, conversions };
  const committed = await commitRevision({ journal: ctx.journal, runDir: ctx.runDir, docs: ctx.docs }, payloadOf(draft, source), jobParent(a.job));
  if (committed.kind === 'refused') return decided(ctx, a.job, { kind: 'rejected', reason: 'stale', detail: `its docs publication was refused at the tip: ${committed.reason}` });
  crashPoint('bundle.after-applied');
  return { kind: 'applied', planRev: committed.fact.rev };
}

/** The output's ops minus the admits `job`'s decision record converts (Q4): what was applied, as the brakes count it. */
export function effectiveOps(view: Parameters<typeof conversionsOf>[0], job: JobId, output: CheckpointOutput): readonly BundleOp[] {
  const dropped = new Set(conversionsOf(view, job).map((c) => c.index));
  return output.ops.filter((_, i) => !dropped.has(i));
}

/**
 * What follows an applied or no-op decision, each only where missing (a crash may cut it short): a no-op's
 * interpretation divergences (H12), the finding dispositions still applicable, then (M4a, a corpus arc) the debt the
 * deferrals bank, the amendments (the output's own, keyed by `captured.job`, the checkpoint whose output it is), the
 * issue outcomes (src/holistic/intake.ts), one amendment per `target-departed` or `interpretation` divergence of
 * `job` (src/holistic/amendments.ts), and (M4a rev 3, R35) each conversion its decision record holds: an amendment
 * `source: admit{job, index, reason}`, and for a follow-up overrun a debt item naming the opportunity (never classified
 * again: the record is read); the convergence bound when due, the digest when due.
 */
export function settleDecided(ctx: CheckpointContext, job: JobId, output: CheckpointOutput, captured: Captured, applied: readonly AppliedBundle[]): void {
  const view = ctx.journal.view;
  const c = view.holistic().checkpoints.find((x) => x.inputs.job === job);
  if (c?.decided === null || c === undefined) throw new Error(`${job} is not decided`);
  if (c.decided.kind === 'no-op') appendDivergences(ctx.journal, interpretationDivergences(job, captured.vector, output));
  for (const d of output.findingDispositions) {
    const f = ctx.journal.view.holistic().findings.find((x) => x.id === d.finding);
    if (f === undefined || !isActive(f)) continue;
    ruleFinding(ctx.journal, d.finding, d.disposition, { type: 'checkpoint', job });
  }
  if (ctx.plan().target === 'corpus') {
    bankDeferred(ctx, job, output);
    for (const draft of checkpointAmendments(captured.job, output)) appendAmendment(ctx.journal, draft);
    settleIntake(ctx.journal, captured.job, output, issueReuse(ctx.journal.view, ctx.runDir, captured));
    for (const draft of divergenceAmendments(ctx.journal.view, job)) appendAmendment(ctx.journal, draft);
    settleConversions(ctx, job, output);
  }
  const plan = requirePlanInForce(ctx.runDir, ctx.journal.view).plan;
  const rootOf = (u: UnitId): UnitId => ctx.journal.view.unit(u).lineage?.root ?? u;
  const all = c.decided.kind === 'applied' && !applied.some((x) => x.job === job) ? [...applied, ...appliedNow(ctx, job, output)] : applied;
  raiseBound(ctx, brakesOf(ctx.journal.view, ctx.runDir, plan, all, new Set(), rootOf), all);
  raiseDigest(ctx);
}

/** Each conversion of `job`'s decision record (Q4): its amendment, then (a follow-up overrun) its debt item; idempotent by source. */
function settleConversions(ctx: CheckpointContext, job: JobId, output: CheckpointOutput): void {
  const conversions = conversionsOf(ctx.journal.view, job);
  if (conversions.length === 0) return;
  const baseline = baselineDebtAt(ctx.repo, ctx.plan().baseline);
  for (const c of conversions) {
    const op = output.ops[c.index];
    if (op === undefined) throw new Error(`${job}'s decision record converts op ${c.index + 1}, which its output does not have`);
    appendAmendment(ctx.journal, conversionAmendment(job, c, op));
    crashPoint('bundle.after-conversion-amendment');
    if (c.reason !== 'follow-up-overrun' || op.op !== 'admit') continue;
    const fact = mintDebt(baseline, ctx.journal.view.holistic().debt, {
      type: 'opportunity-overrun', opportunity: c.opportunity!, job, index: c.index, unit: c.unit,
      what: `Opportunity ${c.opportunity} needed a second follow-up repair, which code converted: ${admitSummary(op)}`,
    });
    if (fact !== null) {
      ctx.journal.fact(fact);
      crashPoint('bundle.after-overrun-debt');
    }
  }
}

/**
 * R7: each finding the output deferred that `job` ruled deferred, a P2 or P3 with no obligation, banked as
 * `finding-deferred` debt (`mintDebt`: once per finding, deduped by key against the baseline ledger and the arc's banked
 * items), under the unit that owned it (null: none). A deferred finding with an obligation is never debt (correctness
 * never banks): it stays a finding.
 */
function bankDeferred(ctx: CheckpointContext, job: JobId, output: CheckpointOutput): void {
  const fold = ctx.journal.view.holistic();
  const deferred = output.findingDispositions.flatMap((d) => {
    const f = fold.findings.find((x) => x.id === d.finding);
    const by = f?.last?.state === 'ruled' ? f.last : null;
    const mine = d.disposition === 'deferred' && by?.disposition === 'deferred' && by.by.type === 'checkpoint' && by.by.job === job;
    return f !== undefined && mine && f.obligation === null && f.severity !== 'P1' ? [f] : [];
  });
  if (deferred.length === 0) return;
  const baseline = baselineDebtAt(ctx.repo, ctx.plan().baseline);
  for (const f of deferred) {
    const fact = mintDebt(baseline, ctx.journal.view.holistic().debt, {
      type: 'finding-deferred', finding: f.id, severity: f.severity, obligation: f.obligation, unit: f.owner, what: f.claim,
    });
    if (fact !== null) ctx.journal.fact(fact);
  }
}

/** The bundle `job` just applied, as an applied bundle (its revision.commit's seq, its effective ops). */
function appliedNow(ctx: CheckpointContext, job: JobId, output: CheckpointOutput): readonly AppliedBundle[] {
  const commit = [...ctx.journal.view.opsOf('revision.commit')].reverse().find((i) => i.expect.source.type === 'bundle' && i.expect.source.job === job);
  if (commit === undefined) throw new Error(`${job} applied with no revision.commit`);
  return [{ job, seq: Number(commit.op.slice(commit.op.lastIndexOf('/') + 1)), ops: effectiveOps(ctx.journal.view, job, output) }];
}
