// `roadmap scope accept|reject <unit> --reason <text>` (scope growth, 2026-10-15; SCHEMAS.md "Scope growth"): the root
// agent's decision on the scope growth a unit's plan-check proposed and code verified, which holds the unit at plan-check
// (`scope-growth`, src/pipeline/stages.ts `verifiedGrowth`). A `scope-decide` command, mutation, scope {u}. Refused unless
// the unit is held by that hold. The effect, each step only where missing (a run again after a crash finds what is done):
//
//   accept  1. The ruled growth, the one canonical path a dispatched unit's scope grows by (src/input/classify.ts "scope
//              growth"), built here instead of by hand: a new ruling (the ledger's next C-n, an architect `decision`
//              applying to the unit, whose statement names exactly the added patterns in backticks; its doc ref quotes a
//              line of the first file the growth takes in, a line naming what the spec `removes` when one does; its
//              consistency fresh at the integration tip), the unit's plan scope widened by the patterns, and its spec in
//              force at rev + 1 with the patterns in its scope and the ruling in its cites. Validated as `rule` validates a
//              ruling (`rulingReasons`), evaluated by the apply core with the Phase-0 rows (as an `apply --ruling`), then
//              committed through the fence: `plan-applied` (source the command). The spec revision is pending; the unit
//              re-opens on it when the hold is released, and its plan-check's dispatch check re-pins the wider scope.
//           2. Write-back: the ledger, sidecars and obligations as `rule` writes them back, the plan as `steer --class`
//              writes it back, and the unit's live spec file when it still holds the spec the growth was built on (a file
//              the architect changed since is left alone; the receipt says so).
//   both    3. The hold's needs-user acknowledged by this command.
//           4. `scope-decided{unit, attempt, command, decision, reason}`, the postcondition: the fold releases the hold and
//              keeps the decision with its proposals. Accepted: the unit re-opens at plan-check on the grown spec. Rejected:
//              the plan-check runs again on the same spec, told what was rejected; a proposal of a rejected pattern no
//              longer holds it, so it decides within the scope (approve, redirect, or infeasible: an escalation).
// A rejection of the revision (the classifier's or the Phase-0 rows' reasons) rejects the command, listing every reason;
// the unit stays held, and the root agent rejects instead or lands its own `apply --ruling`.
import { existsSync, readFileSync } from 'node:fs';
import { canonicalJson } from '../core/json.ts';
import type { ScopeGrowthProposal } from '../core/events.ts';
import { type CommandId, type RulingId, type UnitId, specRev } from '../core/ids.ts';
import { type CommandBody, type SpecM1, specRemoves } from '../core/records.ts';
import type { PlanAppliedFact } from '../core/events.ts';
import { type RepoPath, type RepoPattern, branchRef, matchesPattern, repoPath } from '../core/values.ts';
import { git, refTarget } from '../git/git.ts';
import { type RulingSidecar, RULING_SCHEMA, parseRulingSidecar } from '../holistic/types.ts';
import { type RulingRecord, withRulings } from '../input/classify.ts';
import {
  type InputFiles, PLAN_INPUT, SPEC_INPUT, inForceFiles, keptInput, keptPayload, ledgerPath, requirePlanInForce, revisionInForce, sidecarPath, specFilePath,
} from '../input/inforce.ts';
import { parsePlan } from '../input/plan.ts';
import { raisedFor } from '../needsuser.ts';
import { APPLY, phase0InputOf, phase0Rows } from '../phase0/rows.ts';
import { rulingContextAt } from '../pipeline/publish.ts';
import { quotedTextReason } from '../docs/contracts.ts';
import { durableWrite } from '../core/fsx.ts';
import { SpecFileError, bytesSha256, fileSha256, parseSpec, specBytes } from '../spec/spec.ts';
import { SchemaError } from '../core/validate.ts';
import { consistencyRevs, nextRulingId, parseRulings } from '../spec/rulings.ts';
import { type CommandContext, type Effect, acknowledge, commitUnderFence, evaluateRevision, parentOf, rejectedText } from './apply.ts';
import { rulingReasons, writeBackAfter } from './rule.ts';
import { writeBack as writeBackPlan } from './steer.ts';

type ScopeBody = Extract<CommandBody, { type: 'scope-decide' }>;

const DECIDED = { accept: 'accepted', reject: 'rejected' } as const;

export async function decideScope(ctx: CommandContext, id: CommandId, body: ScopeBody): Promise<Effect> {
  const what = `scope ${body.decision} ${body.unit}`;
  if (!ctx.plan().units.some((u) => u.id === body.unit)) return { kind: 'rejected', reason: `${what}: unknown unit ${body.unit}` };
  const u = ctx.journal.view.unit(body.unit);
  // Run again after a crash past the fact: it is the postcondition (an accept's write-back is finished from the log).
  const decided = u.scopeDecisions.find((d) => d.command === id);
  if (decided !== undefined) {
    const landed = ctx.journal.view.planAppliedBy(id);
    return { kind: 'applied', verified: [...(landed === null ? [] : writeBacks(ctx, landed, body.unit)), decidedText(body.unit, decided.attempt, decided.decision)] };
  }
  const held = u.interrupted;
  if (u.status !== 'held' || held === null || held.stage !== 'plan-check' || held.outcome !== 'scope-growth' || held.detail?.kind !== 'scope-growth') {
    return { kind: 'rejected', reason: `${what}: the unit is ${u.status}${held === null ? '' : ` (held at ${held.stage}#${held.attempt} ${held.outcome})`}, not held for a scope-growth proposal of its plan-check` };
  }
  const verified: string[] = [];
  if (body.decision === 'accept') {
    const landed = await landGrowth(ctx, id, body.unit, held.attempt, held.detail.proposals, body.reason);
    if (landed.kind === 'rejected') return landed;
    verified.push(...landed.verified);
  }
  const item = raisedFor(ctx.journal.view, { type: 'stage', unit: body.unit, stage: 'plan-check', attempt: held.attempt });
  if (item !== null && ctx.journal.view.ackOf(item) === null) verified.push(...acknowledge(ctx, id, item, null));
  ctx.journal.fact({ kind: 'scope-decided', unit: body.unit, attempt: held.attempt, command: id, decision: DECIDED[body.decision], reason: body.reason });
  verified.push(decidedText(body.unit, held.attempt, DECIDED[body.decision]));
  return { kind: 'applied', verified };
}

const decidedText = (unit: UnitId, attempt: number, decision: 'accepted' | 'rejected'): string => decision === 'accepted'
  ? `unit ${unit}: the scope growth of plan-check#${attempt} accepted; the unit re-opens at plan-check on its grown spec`
  : `unit ${unit}: the scope growth of plan-check#${attempt} rejected; the plan-check runs again within the scope`;

/** One line of ledger text: no newline, no backtick (the statement's backticks name exactly the added patterns). */
const plain = (text: string): string => text.replace(/`/g, '\'').replace(/\s+/g, ' ').trim();

/** `spec` grown by `added` (those its scope lacks), citing `ruling`, at rev + 1. */
export function grownSpec(spec: SpecM1, added: readonly RepoPattern[], ruling: RulingId): SpecM1 {
  return {
    ...spec, rev: specRev(spec.rev + 1), scope: [...spec.scope, ...added.filter((p) => !spec.scope.includes(p))],
    cites: { ...spec.cites, rulings: spec.cites.rulings.includes(ruling) ? spec.cites.rulings : [...spec.cites.rulings, ruling] },
  };
}

/**
 * The doc ref of a growth ruling: a line of the first file at the tip the added patterns take in, preferring one that names
 * something the spec removes (why the file needs the unit), quoted as its own anchor; null when no file has a quotable line.
 */
function growthDocRef(
  docAt: (path: RepoPath) => string | null, files: readonly RepoPath[], added: readonly RepoPattern[], removes: readonly string[],
): RulingSidecar['docRefs'][number] | null {
  for (const path of files.filter((f) => added.some((p) => matchesPattern(f, p)))) {
    const text = docAt(path);
    if (text === null) continue;
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    const ordered = [...lines.filter((l) => removes.some((r) => l.includes(r))), ...lines];
    const quote = ordered.find((l) => quotedTextReason(text, l, l) === null);
    if (quote !== undefined) return { path, anchor: quote, quotedText: quote, relation: 'consistent' };
  }
  return null;
}

/** The accepted growth as one ruled revision (steps 1-2), or why it may not land. */
async function landGrowth(
  ctx: CommandContext, id: CommandId, unit: UnitId, attempt: number, proposals: readonly ScopeGrowthProposal[], reason: string,
): Promise<Effect> {
  const view = ctx.journal.view;
  const done = view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: [`plan rev ${done.rev} in force: the scope growth of ${unit} landed`, ...writeBacks(ctx, done, unit)] };
  const u = view.unit(unit);
  if (u.pendingRevision !== null) {
    return { kind: 'rejected', reason: `scope accept ${unit}: its spec revision ${u.pendingRevision.rev} is pending (applied, not yet re-opened on); reject this growth, or withdraw that revision first` };
  }
  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce);
  const current = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile, ctx.repo);
  const planUnit = inForce.plan.units.find((p) => p.id === unit);
  const specFile = current.specs.get(unit);
  if (planUnit === undefined || specFile === undefined || specFile.bytes === null) throw new Error(`scope accept ${unit}: a held unit the plan in force does not hold with its spec`);
  const added = [...new Set(proposals.flatMap((p) => p.patterns))].filter((p) => !planUnit.scope.includes(p)).sort();
  if (added.length === 0) return { kind: 'applied', verified: [`unit ${unit}'s plan scope holds every proposed pattern already: nothing to land`] };

  const tip = refTarget(ctx.repo, branchRef(inForce.plan.integrationBranch));
  if (tip === null) throw new Error(`integration ${inForce.plan.integrationBranch} does not exist`);
  const rctx = { ...rulingContextAt(ctx, tip), units: inForce.plan.units.map((p) => p.id) };
  const spec = parseSpec(specFile.bytes, specFile.path);
  const files = git(ctx.repo, ['ls-tree', '-r', '-z', '--name-only', tip]).split('\0').filter((f) => f !== '').map((f) => repoPath(f));
  const docRef = growthDocRef(rctx.docAt, files, added, specRemoves(spec));
  if (docRef === null) return { kind: 'rejected', reason: `scope accept ${unit}: no file at the integration tip ${tip} the growth takes in has a line its ruling could quote` };
  const ruling = nextRulingId(parseRulings(revision.ledger.bytes.toString('utf8'), 'the rulings ledger in force'));
  const why = proposals.map((p) => plain(p.reason)).join('; ');
  const draft: RulingSidecar = {
    schema: RULING_SCHEMA, id: ruling,
    statement: `Unit ${unit}'s scope grows by ${added.map((p) => `\`${p}\``).join(', ')}: proposed by its plan-check (${why}), accepted by the root agent (${plain(reason)}).`,
    kind: 'decision', ruledBy: { type: 'architect' }, trigger: `roadmap scope accept ${unit} (${id}) on plan-check#${attempt}`, supersedes: [], condition: null,
    docRefs: [docRef], contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: [], evidence: [],
    appliesTo: { type: 'units', units: [unit] }, lifetime: 'arc', status: 'active',
    consistency: { verdict: 'consistent', judgedRevs: { ...rctx.inForce, contracts: [] }, by: { type: 'architect' } },
  };
  const revs = consistencyRevs(draft, rctx);
  if ('reasons' in revs) throw new Error(`scope accept ${unit}: a growth ruling names no contract, yet ${revs.reasons.join('; ')}`);
  const bytes = Buffer.from(`${JSON.stringify({ ...draft, consistency: { ...draft.consistency, judgedRevs: revs.revs } }, null, 2)}\n`, 'utf8');
  const record: RulingRecord = { path: sidecarPath(ledgerPath(ctx.planFile, inForce.plan), ruling), bytes, sidecar: parseRulingSidecar(JSON.parse(bytes.toString('utf8'))) };

  // The plan's own JSON with the unit's scope widened, so every other byte stays as written; the spec at rev + 1.
  const raw = JSON.parse(current.planBytes.toString('utf8')) as { units: { id: string; scope: string[] }[] };
  const entry = raw.units.find((x) => x.id === unit);
  if (entry === undefined) throw new Error(`scope accept ${unit}: not in the plan in force`);
  entry.scope = [...entry.scope, ...added];
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const base: InputFiles = {
    ...current, plan: parsePlan(JSON.parse(planBytes.toString('utf8'))), planBytes,
    specs: new Map([...current.specs, [unit, { path: specFile.path, bytes: specBytes(grownSpec(spec, added, ruling)) }]]),
  };
  const invalid = rulingReasons(ctx, base, [record]);
  if (invalid.length > 0) return { kind: 'rejected', reason: rejectedText(invalid) };
  const proposal = withRulings(base, [record]);
  const proposer = { type: 'apply', rulings: [ruling] } as const;
  const rctx2 = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv };
  const evaluated = evaluateRevision(rctx2, proposal, proposer);
  if (evaluated.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(evaluated.reasons) };
  if (evaluated.kind === 'unchanged') throw new Error(`scope accept ${unit}: a new ruling and a wider scope left the plan in force unchanged`);
  // The Phase-0 rows an apply runs (a corpus arc's corpus overlap among them).
  const rows = phase0Rows(phase0InputOf(proposal, ctx.routingBase.config), APPLY).rows;
  if (rows.length > 0) return { kind: 'rejected', reason: rejectedText(rows.map((r) => canonicalJson(r))) };
  const committed = await commitUnderFence(ctx, evaluated, proposer, { type: 'command', command: id }, parentOf(id));
  if (committed.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(committed.reasons) };
  return {
    kind: 'applied',
    verified: [
      `plan rev ${committed.fact.rev} in force: unit ${unit}'s scope grows by ${added.join(', ')}, ruled by ${ruling}`,
      ...committed.fact.changes.map((c) => canonicalJson(c)), ...writeBacks(ctx, committed.fact, unit),
    ],
  };
}

/**
 * Step 2 (also a run again after a crash): the ledger, sidecars and obligations (`rule`'s write-back), the plan (`steer`'s),
 * and the unit's live spec file when it holds the spec the revision grew (its bytes, or the same spec as written), never a
 * file the architect changed since.
 */
function writeBacks(ctx: CommandContext, fact: PlanAppliedFact, unit: UnitId): readonly string[] {
  const out = [...writeBackAfter(ctx, fact.rev), writeBackPlan(ctx, fact)];
  const planUnit = parsePlan(JSON.parse(keptOf(ctx, fact.planSha256, PLAN_INPUT).toString('utf8'))).units.find((p) => p.id === unit);
  if (planUnit === undefined) throw new Error(`plan rev ${fact.rev} does not hold ${unit}`);
  const sha = keptPayload(ctx.runDir, fact.payloadSha256).manifest.specs[unit];
  if (sha === undefined) throw new Error(`plan rev ${fact.rev} names no spec of ${unit}`);
  const bytes = keptOf(ctx, sha, SPEC_INPUT);
  const grown = parseSpec(bytes, specFilePath(ctx.planFile, planUnit));
  const file = specFilePath(ctx.planFile, planUnit);
  if (existsSync(file) && fileSha256(file) === bytesSha256(bytes)) return [...out, `spec file ${file} holds rev ${grown.rev}`];
  const ruling = grown.cites.rulings.at(-1);
  if (ruling === undefined) throw new Error(`the grown spec of ${unit} cites no ruling`);
  const live = existsSync(file) ? liveSpec(file) : null;
  const before = live === null ? null : specBytes(grownSpec(live, grown.scope.filter((p) => !live.scope.includes(p)) as RepoPattern[], ruling));
  if (live === null || live.rev + 1 !== grown.rev || before === null || !before.equals(bytes)) {
    return [...out, `spec file ${file} left alone: it changed since the spec the growth was built on, so it does not hold rev ${grown.rev}'s scope, and an apply of it as it is drops that`];
  }
  durableWrite(file, bytes);
  return [...out, `spec file ${file} written back: it holds rev ${grown.rev}`];
}

/** The live spec file, or null while it does not load (the architect's edit in progress): it is then left alone. */
function liveSpec(file: ReturnType<typeof specFilePath>): SpecM1 | null {
  try {
    return parseSpec(readFileSync(file), file);
  } catch (error) {
    if (error instanceof SchemaError || error instanceof SpecFileError) return null;
    throw error;
  }
}

function keptOf(ctx: CommandContext, sha: Parameters<typeof keptInput>[1], ext: string): Buffer {
  const bytes = keptInput(ctx.runDir, sha, ext);
  if (bytes === null) throw new Error(`the revision names ${ext} ${sha}, which is not kept`);
  return bytes;
}
