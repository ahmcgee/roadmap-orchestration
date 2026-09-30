// `roadmap rule <record.json>` (M3 step A4; DESIGN-1.0.md §2.3, §2.9; plan "Commands"; A3, G21): the architect's one
// way to land a ruling, since the ledger is executor-owned after `start`. Mutation, no scope (it drains no unit: its
// docs publication preempts a unit candidate that holds the slot before green, A7). The effect, each step only where
// missing (a run again after a crash finds what is done):
//
//   1. The record: it still hashes to what the CLI recorded, and parses as a ruling sidecar (`roadmap/ruling-m3`).
//   2. Validation (A1 `validateRuling`) at the integration tip, against the revisions in force: its identity (the
//      ledger's next C-n), supersession, docRefs, contract ops (the plan's contracts and architecture doc only),
//      obligations, cites (active vision clauses only: a withdrawn cite is refused, H16), and its `consistency`, which
//      must be fresh (G21): judged at exactly the head, ledger, obligations and vision in force and the contracts'
//      blobs. Every reason is listed.
//   3. The proposal (the apply core, G1): the revision in force with the ledger after it (`ledgerAfter`: its line
//      appended, fully superseded rulings folded) and its sidecars after it (`sidecarsAfter`), proposer `rule`,
//      committed through the fence (`commitUnderFence`). Its docs publication (src/pipeline/publish.ts) renders
//      `.roadmap/constraints.md` and applies its contract ops at the tip, validating the ruling again there under the
//      slot, runs its lanes, and publishes; then `plan-applied` (source the command) is the postcondition.
//   4. Write-back (A3): the live ledger and each sidecar file take the revision's bytes only while they still hold the
//      previous revision's (a file the architect changed since is left alone, and the receipt says so), as
//      `spec.patch` writes back a spec.
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import type { CommandId, RulingId, Sha256Hex } from '../core/ids.ts';
import type { CommandBody } from '../core/records.ts';
import { readJournal } from '../core/log.ts';
import { canonicalJson } from '../core/json.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, branchRef } from '../core/values.ts';
import { refTarget } from '../git/git.ts';
import { type RulingSidecar, parseRulingSidecar } from '../holistic/types.ts';
import {
  type InputFiles, RULING_INPUT, RULINGS_INPUT, inForceFiles, keptInput, keptPayload, ledgerPath, requirePlanInForce, revisionInForce, sidecarPath,
} from '../input/inforce.ts';
import { rulingContextAt } from '../pipeline/publish.ts';
import { bytesSha256, fileSha256 } from '../spec/spec.ts';
import { ledgerAfter, sidecarsAfter, validateRuling } from '../spec/rulings.ts';
import { type CommandContext, type Effect, commitUnderFence, evaluateRevision, parentOf, rejectedText } from './apply.ts';

type RuleBody = Extract<CommandBody, { type: 'rule' }>;

/** The rulings part of a revision: the ledger's bytes and each sidecar's, by sha256. */
type Rulings = Readonly<{ ledgerSha256: Sha256Hex; sidecars: Readonly<Record<string, Sha256Hex>> }>;

/** A superseded sidecar's bytes: its record with `status: superseded`, as JSON. */
const sidecarBytes = (s: RulingSidecar): Buffer => Buffer.from(`${JSON.stringify(s, null, 2)}\n`, 'utf8');

export async function rule(ctx: CommandContext, id: CommandId, body: RuleBody): Promise<Effect> {
  const view = ctx.journal.view;
  // Run again after a crash past the fact: it is the postcondition; the write-back is finished from the log.
  const done = view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: [`plan rev ${done.rev} in force: the ruling of ${body.path} landed`, ...writeBackAfter(ctx, done.rev)] };

  if (!existsSync(body.path)) return { kind: 'rejected', reason: `the ruling record ${body.path} does not exist` };
  const bytes = readFileSync(body.path);
  if (bytesSha256(bytes) !== body.sha256) return { kind: 'rejected', reason: `the ruling record ${body.path} changed since the command hashed it` };
  let sidecar: RulingSidecar;
  try {
    sidecar = parseRulingSidecar(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
    return { kind: 'rejected', reason: `the ruling record ${body.path} is not a ruling sidecar: ${error.message}` };
  }

  const tip = refTarget(ctx.repo, branchRef(ctx.plan().integrationBranch));
  if (tip === null) throw new Error(`integration ${ctx.plan().integrationBranch} does not exist`);
  const reasons = validateRuling(sidecar, rulingContextAt(ctx, tip));
  if (reasons.length > 0) return { kind: 'rejected', reason: rejectedText(reasons, 'rule') };

  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce, ctx.planFile);
  const current = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile);
  const before: Rulings = revision.manifest.rulings;
  const ledger = Buffer.from(ledgerAfter(revision.ledger.bytes.toString('utf8'), sidecar), 'utf8');
  const sidecars = new Map(sidecarsAfter([...revision.sidecars.values()].map((s) => s.sidecar), sidecar).map((s) => {
    const kept = revision.sidecars.get(s.id);
    const b = s.id === sidecar.id ? bytes : kept !== undefined && kept.sidecar.status === s.status ? kept.bytes : sidecarBytes(s);
    return [s.id, { path: sidecarPath(current.ledger.path, s.id), bytes: b }] as const;
  }));
  const proposal: InputFiles = { ...current, ledger: { path: current.ledger.path, bytes: ledger }, sidecars };

  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase };
  const evaluated = evaluateRevision(rctx, proposal, { type: 'rule' });
  if (evaluated.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(evaluated.reasons, 'rule') };
  if (evaluated.kind === 'unchanged') throw new Error(`rule ${sidecar.id}: a new ruling left the rulings in force unchanged`);
  const committed = await commitUnderFence(ctx, evaluated, { type: 'rule' }, { type: 'command', command: id }, parentOf(id));
  if (committed.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(committed.reasons, 'rule') };
  const after = keptPayload(ctx.runDir, committed.fact.payloadSha256!).manifest.rulings;
  return {
    kind: 'applied',
    verified: [
      `plan rev ${committed.fact.rev} in force: ${sidecar.id} landed${committed.fact.publication === undefined ? '' : ` (published by ${committed.fact.publication.pub} at ${committed.fact.publication.head})`}`,
      ...committed.fact.changes.map((c) => canonicalJson(c)),
      ...writeBack(ctx, before, after),
    ],
  };
}

/** The write-back of the revision `rev` this command committed, found from the log (a run again after a crash). */
function writeBackAfter(ctx: CommandContext, rev: number): readonly string[] {
  const facts = readJournal(ctx.runDir, ctx.journal.view.arc).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [e.fact] : []));
  const mine = facts.find((f) => f.rev === rev);
  const prev = facts.find((f) => f.rev === rev - 1);
  if (mine?.payloadSha256 === undefined) throw new Error(`plan rev ${rev} of a rule has no payload`);
  if (prev?.payloadSha256 === undefined) return ['the rulings in force before it were a 1.0.0-dev.5 revision\'s live ledger: nothing is written back'];
  return writeBack(ctx, keptPayload(ctx.runDir, prev.payloadSha256).manifest.rulings, keptPayload(ctx.runDir, mine.payloadSha256).manifest.rulings);
}

/**
 * The live ledger and sidecar files take the revision's bytes where they still hold the previous revision's (or, for
 * a sidecar new in it, where none exists yet); a file the architect changed since is left alone and reported.
 */
function writeBack(ctx: CommandContext, before: Rulings, after: Rulings): readonly string[] {
  const ledger = ledgerPath(ctx.planFile, ctx.plan());
  const out: string[] = [];
  const one = (path: AbsPath, was: Sha256Hex | undefined, now: Sha256Hex, ext: string): void => {
    const live = existsSync(path) ? fileSha256(path) : undefined;
    if (live === now) return;
    if (live !== was) {
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
  for (const id of Object.keys(after.sidecars).sort() as RulingId[]) {
    const now = after.sidecars[id]!;
    if (before.sidecars[id] === now) continue;
    one(sidecarPath(ledger, id), before.sidecars[id], now, RULING_INPUT);
  }
  return out;
}
