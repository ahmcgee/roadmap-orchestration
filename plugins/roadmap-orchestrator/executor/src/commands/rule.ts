// `roadmap rule <record.json>` (M3 step A4; DESIGN-1.0.md §2.3, §2.9; plan "Commands"; A3, G21): the architect's one
// way to land a ruling, since the ledger is executor-owned after `start`. Mutation, no scope (it drains no unit: its
// docs publication preempts a unit candidate that holds the slot before green, A7). The effect, each step only where
// missing (a run again after a crash finds what is done):
//
//   1. The record: it still hashes to what the CLI recorded, and parses as a ruling sidecar (`roadmap/ruling-m3`;
//      src/input/classify.ts `readRulingRecord`).
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
//   4. Write-back (A3; `writeBack`, which `apply --ruling` shares): the live ledger, each sidecar file and the obligations file take the revision's bytes only
//      while they still hold the previous revision's (a file the architect changed since is left alone, and the
//      receipt says so), as `spec.patch` writes back a spec. A run again after a crash past the fact finishes it from
//      the log: the previous revision's payload names what the files held.
//
// Until the command's op is done, a manual start leaves the files for the next start (src/preflight/checks.ts
// `settlePlan`): they may not hold the revision yet, and recovery re-runs this command, which writes it back.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import { type CommandId, type RulingId, type Sha256Hex, compareIds } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { CommandBody, RevisionManifest } from '../core/records.ts';
import { readJournal } from '../core/log.ts';
import { canonicalJson } from '../core/json.ts';
import { type AbsPath, absPath, branchRef } from '../core/values.ts';
import { refTarget } from '../git/git.ts';
import { type RulingRecord, readRulingRecord, withRulings } from '../input/classify.ts';
import {
  type InputFiles, OBLIGATIONS_INPUT, RULING_INPUT, RULINGS_INPUT, inForceFiles, keptInput, keptPayload, ledgerPath, requirePlanInForce, revisionInForce,
  sidecarPath,
} from '../input/inforce.ts';
import { rulingContextAt } from '../pipeline/publish.ts';
import { fileSha256 } from '../spec/spec.ts';
import { ledgerAfter, parseRulings, validateRuling } from '../spec/rulings.ts';
import { type CommandContext, type Effect, commitUnderFence, evaluateRevision, parentOf, rejectedText } from './apply.ts';

type RuleBody = Extract<CommandBody, { type: 'rule' }>;

/** What a rule writes back: the ledger's, each sidecar's and the obligations file's bytes, by sha256. */
export type WrittenBack = Readonly<{ ledgerSha256: Sha256Hex; sidecars: Readonly<Record<string, Sha256Hex>>; obligations: Sha256Hex | null }>;

export const writtenBackOf = (m: RevisionManifest): WrittenBack => ({ ledgerSha256: m.rulings.ledgerSha256, sidecars: m.rulings.sidecars, obligations: m.obligations });

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
  // Run again after a crash past the fact: it is the postcondition; the write-back is finished from the log.
  const done = view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: [`plan rev ${done.rev} in force: the ruling of ${body.path} landed`, ...writeBackAfter(ctx, done.rev)] };

  const record = readRulingRecord(body);
  if (typeof record === 'string') return { kind: 'rejected', reason: record };
  const sidecar = record.sidecar;

  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce);
  const current = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile, ctx.repo);
  const reasons = rulingReasons(ctx, current, [record]);
  if (reasons.length > 0) return { kind: 'rejected', reason: rejectedText(reasons, 'rule') };
  const before = writtenBackOf(revision.manifest);
  const proposal = withRulings(current, [record]);

  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase };
  const evaluated = evaluateRevision(rctx, proposal, { type: 'rule' });
  if (evaluated.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(evaluated.reasons, 'rule') };
  if (evaluated.kind === 'unchanged') throw new Error(`rule ${sidecar.id}: a new ruling left the rulings in force unchanged`);
  const committed = await commitUnderFence(ctx, evaluated, { type: 'rule' }, { type: 'command', command: id }, parentOf(id));
  if (committed.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(committed.reasons, 'rule') };
  const after = writtenBackOf(keptPayload(ctx.runDir, committed.fact.payloadSha256).manifest);
  return {
    kind: 'applied',
    verified: [
      `plan rev ${committed.fact.rev} in force: ${sidecar.id} landed${committed.fact.publication === undefined ? '' : ` (published by ${committed.fact.publication.pub} at ${committed.fact.publication.head})`}`,
      ...committed.fact.changes.map((c) => canonicalJson(c)),
      ...writeBack(ctx, before, after),
    ],
  };
}

/**
 * The write-back of the revision `rev` a command committed, found from the log (a run again after a crash): against
 * `before` (an `apply --ruling`'s manifest: what it read), else the revision before it.
 */
export function writeBackAfter(ctx: CommandContext, rev: number, before: WrittenBack | null = null): readonly string[] {
  const facts = readJournal(ctx.runDir, ctx.journal.view.arc).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [e.fact] : []));
  const mine = facts.find((f) => f.rev === rev);
  const prev = facts.find((f) => f.rev === rev - 1);
  if (mine === undefined) throw new Error(`plan rev ${rev} of a rule is not in the log`);
  if (prev === undefined) throw new Error(`plan rev ${rev} of a rule has no revision before it in the log`);
  const from = before ?? writtenBackOf(keptPayload(ctx.runDir, prev.payloadSha256).manifest);
  return writeBack(ctx, from, writtenBackOf(keptPayload(ctx.runDir, mine.payloadSha256).manifest));
}

/**
 * The live ledger, sidecar and obligations files take the revision's bytes where they still hold the previous
 * revision's (or, for a sidecar new in it, where none exists yet); a file the architect changed since is left alone
 * and reported.
 */
export function writeBack(ctx: CommandContext, before: WrittenBack, after: WrittenBack): readonly string[] {
  const plan = ctx.plan();
  const ledger = ledgerPath(ctx.planFile, plan);
  const out: string[] = [];
  const one = (path: AbsPath, was: Sha256Hex | null | undefined, now: Sha256Hex, ext: string): void => {
    const live = existsSync(path) ? fileSha256(path) : undefined;
    if (live === now) return;
    if (live !== (was ?? undefined)) {
      out.push(`${path} was changed since the previous revision: left alone (it does not hold the ruling's revision)`);
      return;
    }
    const bytes = keptInput(ctx.runDir, now, ext);
    if (bytes === null) throw new Error(`the rule's revision names ${ext} ${now}, which is not kept`);
    durableMkdir(dirname(path));
    durableWrite(path, bytes);
    out.push(`${path} written back`);
  };
  one(ledger, before.ledgerSha256, after.ledgerSha256, RULINGS_INPUT);
  for (const id of (Object.keys(after.sidecars) as RulingId[]).sort(compareIds)) {
    const now = after.sidecars[id]!;
    if (before.sidecars[id] === now) continue;
    one(sidecarPath(ledger, id), before.sidecars[id], now, RULING_INPUT);
  }
  if (after.obligations !== null && after.obligations !== before.obligations) {
    const file = plan.holistic?.obligations;
    if (file === undefined) throw new Error(`the rule's revision names obligations ${after.obligations}, but the plan names no obligations file`);
    one(absPath(join(dirname(ctx.planFile), file)), before.obligations, after.obligations, OBLIGATIONS_INPUT);
  }
  return out;
}
