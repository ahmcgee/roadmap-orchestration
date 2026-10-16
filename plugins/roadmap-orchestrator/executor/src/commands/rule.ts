// `roadmap rule <record.json>` (M3 step A4; DESIGN-1.0.md §2.3, §2.9; plan "Commands"; A3, G21): the architect's one
// way to land a ruling with no dependent edit, since the ledger is executor-owned after `start`. Mutation, no scope (it
// drains no unit: its docs publication preempts a unit candidate that holds the slot before green, A7). The effect, each
// step only where missing (a run again after a crash finds what is done):
//
//   1. The record: it still hashes to what the CLI recorded, and parses as a ruling sidecar (`roadmap/ruling-m3`;
//      src/input/classify.ts `readRulingRecord`). Its id is a C-n, or `C-?`: then it takes the ledger in force's next
//      C-n (`numberRulings`, 2026-10-16), and the receipt names the id.
//   2. Validation (A1 `validateRuling`) at the integration tip, against the revisions in force: its identity (the
//      ledger's next C-n), supersession, docRefs, contract ops (the plan's contracts and architecture doc only),
//      obligations, cites (active vision clauses only: a withdrawn cite is refused, H16), and its `consistency`, which
//      must be fresh (G21): judged against the ledger, obligations and vision in force and the contracts' blobs at the
//      head (the judged head itself is provenance only, src/spec/rulings.ts). Every reason is listed. `rulingReasons` is
//      the one validation: `apply --ruling` (M4a rev 3, I2) validates its records with it, each against the ledger after
//      the ones before it and the units of the revision being built.
//   3. The proposal (the apply core, G1), landed by the one ruling path (src/input/classify.ts `withRulings`, which
//      `apply --ruling` shares): the revision in force with the ledger after it (`ledgerAfter`: its line
//      appended, fully superseded rulings folded), its sidecars after it (`sidecarsAfter`) and its obligation
//      dispositions applied (`obligationsAfter`: a `waived`, `deferred` or `retired` obligation takes that state
//      naming the ruling; `amended` changes no state, it is what lets a later `apply` amend the obligation while the
//      ruling is in force), proposer `rule`, committed through the fence (`commitUnderFence`). Its docs publication
//      (src/pipeline/publish.ts) renders `.roadmap/constraints.md` (and `.roadmap/invariants.md` when an obligation's
//      state changed) and applies its contract ops at the tip, validating the ruling again there under the slot, runs
//      its lanes, and publishes; then `plan-applied` (source the command) is the postcondition.
//
// Nothing is written into the owner's files (2026-10-16): the ledger, sidecars and obligations in force are the run dir's,
// and `roadmap inputs export` writes them; an apply of files without the ruling rebases onto it (src/input/rebase.ts).
import type { CommandId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { CommandBody } from '../core/records.ts';
import { canonicalJson } from '../core/json.ts';
import { type AbsPath, branchRef } from '../core/values.ts';
import { refTarget } from '../git/git.ts';
import { type RulingRecord, numberRulings, readRulingRecord, withRulings } from '../input/classify.ts';
import { type InputFiles, inForceFiles, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { rulingContextAt } from '../pipeline/publish.ts';
import { ledgerAfter, parseRulings, validateRuling } from '../spec/rulings.ts';
import { type CommandContext, type Effect, commitUnderFence, evaluateRevision, parentOf, rejectedText } from './apply.ts';

type RuleBody = Extract<CommandBody, { type: 'rule' }>;

/** What validating a ruling reads: the log and run dir, the repo (its integration tip), the plan file. */
type RulingReader = Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; planFile: AbsPath; repo: AbsPath }>;

/**
 * Why `records` may not land, in order, on the revision `base` builds (A1 `validateRuling`, at the integration tip): each
 * against the ledger after the records before it, the obligations, vision and corpus in force, and the units of `base`'s
 * plan (a ruling may apply to a unit the same `apply --ruling` adds). Every reason; empty when they may. The one
 * validation of `rule` and `apply --ruling` (M4a rev 3, I2).
 */
export function rulingReasons(ctx: RulingReader, base: InputFiles, records: readonly RulingRecord[]): readonly string[] {
  if (records.length === 0) return [];
  const revision = revisionInForce(ctx.runDir, requirePlanInForce(ctx.runDir, ctx.journal.view));
  const plan = requirePlanInForce(ctx.runDir, ctx.journal.view).plan;
  const tip = refTarget(ctx.repo, branchRef(plan.integrationBranch));
  if (tip === null) throw new Error(`integration ${plan.integrationBranch} does not exist`);
  const context = { ...rulingContextAt(ctx, tip), units: base.plan.units.map((u) => u.id) };
  const reasons: string[] = [];
  let ledger = revision.ledger.bytes.toString('utf8');
  for (const r of records) {
    reasons.push(...validateRuling(r.sidecar, { ...context, ledger: parseRulings(ledger, 'the rulings ledger') }));
    ledger = ledgerAfter(ledger, r.sidecar);
  }
  return reasons;
}

export async function rule(ctx: CommandContext, id: CommandId, body: RuleBody): Promise<Effect> {
  const view = ctx.journal.view;
  // Run again after a crash past the fact: it is the postcondition.
  const done = view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: [`plan rev ${done.rev} in force: the ruling of ${body.path} landed`] };

  const draft = readRulingRecord(body);
  if (typeof draft === 'string') return { kind: 'rejected', reason: draft };

  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce);
  const current = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile, ctx.repo);
  // A `C-?` record takes the ledger's next C-n now.
  const [record] = numberRulings([draft], current.ledger.bytes) as [RulingRecord];
  const sidecar = record.sidecar;
  const reasons = rulingReasons(ctx, current, [record]);
  if (reasons.length > 0) return { kind: 'rejected', reason: rejectedText(reasons, 'rule') };
  const proposal = withRulings(current, [record]);

  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv };
  const evaluated = evaluateRevision(rctx, proposal, { type: 'rule' });
  if (evaluated.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(evaluated.reasons, 'rule') };
  if (evaluated.kind === 'unchanged') throw new Error(`rule ${sidecar.id}: a new ruling left the rulings in force unchanged`);
  const committed = await commitUnderFence(ctx, evaluated, { type: 'rule' }, { type: 'command', command: id }, parentOf(id));
  if (committed.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(committed.reasons, 'rule') };
  return {
    kind: 'applied',
    verified: [
      ...(draft.id === null ? [`ruling ${body.path} numbered ${sidecar.id}`] : []),
      `plan rev ${committed.fact.rev} in force: ${sidecar.id} landed${committed.fact.publication === undefined ? '' : ` (published by ${committed.fact.publication.pub} at ${committed.fact.publication.head})`}`,
      ...committed.fact.changes.map((c) => canonicalJson(c)),
    ],
  };
}
