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
//      appended, fully superseded rulings folded), its sidecars after it (`sidecarsAfter`) and its obligation
//      dispositions applied (`obligationsAfter`: a `waived`, `deferred` or `retired` obligation takes that state
//      naming the ruling; `amended` changes no state, it is what lets a later `apply` amend the obligation while the
//      ruling is in force), proposer `rule`, committed through the fence (`commitUnderFence`). Its docs publication
//      (src/pipeline/publish.ts) renders `.roadmap/constraints.md` (and `.roadmap/invariants.md` when an obligation's
//      state changed) and applies its contract ops at the tip, validating the ruling again there under the slot, runs
//      its lanes, and publishes; then `plan-applied` (source the command) is the postcondition.
//   4. Write-back (A3): the live ledger, each sidecar file and the obligations file take the revision's bytes only
//      while they still hold the previous revision's (a file the architect changed since is left alone, and the
//      receipt says so), as `spec.patch` writes back a spec. A run again after a crash past the fact finishes it from
//      the log: the previous revision's payload names what the files held; a previous 1.0.0-dev.5 revision has none,
//      so the live ledger's hash is kept before the commit (`legacyPreimagePath`) for that compare.
//
// Until the command's op is done, a manual start leaves the files for the next start (src/preflight/checks.ts
// `settlePlan`): they may not hold the revision yet, and recovery re-runs this command, which writes it back.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicJson, durableMkdir, durableWrite } from '../core/fsx.ts';
import { type CommandId, type ObligationId, type RulingId, type Sha256Hex, sha256 } from '../core/ids.ts';
import type { CommandBody, RevisionManifest } from '../core/records.ts';
import { readJournal } from '../core/log.ts';
import { canonicalJson } from '../core/json.ts';
import { SchemaError, object } from '../core/validate.ts';
import { type AbsPath, absPath, branchRef } from '../core/values.ts';
import { refTarget } from '../git/git.ts';
import { type RulingSidecar, parseRulingSidecar } from '../holistic/types.ts';
import {
  type InputFile, type InputFiles, OBLIGATIONS_INPUT, RULING_INPUT, RULINGS_INPUT, inForceFiles, keptInput, keptPayload, ledgerPath, requirePlanInForce, revisionInForce,
  sidecarPath,
} from '../input/inforce.ts';
import { rulingContextAt } from '../pipeline/publish.ts';
import { bytesSha256, fileSha256 } from '../spec/spec.ts';
import { ledgerAfter, sidecarsAfter, validateRuling } from '../spec/rulings.ts';
import { type CommandContext, type Effect, commitUnderFence, evaluateRevision, parentOf, rejectedText } from './apply.ts';
import { COMMANDS_DIR } from './queue.ts';

type RuleBody = Extract<CommandBody, { type: 'rule' }>;

/** What a rule writes back: the ledger's, each sidecar's and the obligations file's bytes, by sha256. */
type WrittenBack = Readonly<{ ledgerSha256: Sha256Hex; sidecars: Readonly<Record<string, Sha256Hex>>; obligations: Sha256Hex | null }>;

const writtenBackOf = (m: RevisionManifest): WrittenBack => ({ ledgerSha256: m.rulings.ledgerSha256, sidecars: m.rulings.sidecars, obligations: m.obligations });

/** A superseded sidecar's bytes: its record with `status: superseded`, as JSON. */
const sidecarBytes = (s: RulingSidecar): Buffer => Buffer.from(`${JSON.stringify(s, null, 2)}\n`, 'utf8');

/** The dispositions that are an obligation state (`amended` is none: it authorizes an amendment, §2.8). */
const TERMINAL = ['waived', 'deferred', 'retired'] as const;
type Terminal = (typeof TERMINAL)[number];
const isTerminal = (d: string): d is Terminal => (TERMINAL as readonly string[]).includes(d);

/**
 * The obligations file with `sidecar`'s terminal dispositions applied: each such obligation's `state` becomes
 * `{type: <disposition>, ruling}`. The file's JSON is edited in place (every other field as the file in force has it).
 * The classifier then checks the change like any other (a split parent is never disposed, H14).
 */
function obligationsAfter(current: InputFile | null, sidecar: RulingSidecar): InputFile | null {
  const terminal = sidecar.obligationDispositions.filter((d) => isTerminal(d.disposition));
  if (terminal.length === 0) return current;
  if (current === null || current.bytes === null) throw new Error(`${sidecar.id} dispositions ${terminal.map((d) => d.id).join(', ')}, but no obligations are in force (validation names only obligations in force)`);
  const raw = JSON.parse(current.bytes.toString('utf8')) as { obligations: { id: ObligationId; state: unknown }[] };
  for (const d of terminal) {
    const o = raw.obligations.find((x) => x.id === d.id);
    if (o === undefined) throw new Error(`${sidecar.id} dispositions ${d.id}, which the obligations in force do not hold (validation names only obligations in force)`);
    o.state = { type: d.disposition, ruling: sidecar.id };
  }
  return { path: current.path, bytes: Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8') };
}

export async function rule(ctx: CommandContext, id: CommandId, body: RuleBody): Promise<Effect> {
  const view = ctx.journal.view;
  // Run again after a crash past the fact: it is the postcondition; the write-back is finished from the log.
  const done = view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: [`plan rev ${done.rev} in force: the ruling of ${body.path} landed`, ...writeBackAfter(ctx, id, done.rev)] };

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
  const before = writtenBackOf(revision.manifest);
  const ledger = Buffer.from(ledgerAfter(revision.ledger.bytes.toString('utf8'), sidecar), 'utf8');
  const sidecars = new Map(sidecarsAfter([...revision.sidecars.values()].map((s) => s.sidecar), sidecar).map((s) => {
    const kept = revision.sidecars.get(s.id);
    const b = s.id === sidecar.id ? bytes : kept !== undefined && kept.sidecar.status === s.status ? kept.bytes : sidecarBytes(s);
    return [s.id, { path: sidecarPath(current.ledger.path, s.id), bytes: b }] as const;
  }));
  const proposal: InputFiles = { ...current, ledger: { path: current.ledger.path, bytes: ledger }, sidecars, obligations: obligationsAfter(current.obligations, sidecar) };

  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase };
  const evaluated = evaluateRevision(rctx, proposal, { type: 'rule' });
  if (evaluated.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(evaluated.reasons, 'rule') };
  if (evaluated.kind === 'unchanged') throw new Error(`rule ${sidecar.id}: a new ruling left the rulings in force unchanged`);
  if (inForce.fact.payloadSha256 === undefined) keepLegacyPreimage(ctx.runDir, id, before);
  const committed = await commitUnderFence(ctx, evaluated, { type: 'rule' }, { type: 'command', command: id }, parentOf(id));
  if (committed.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(committed.reasons, 'rule') };
  const after = writtenBackOf(keptPayload(ctx.runDir, committed.fact.payloadSha256!).manifest);
  return {
    kind: 'applied',
    verified: [
      `plan rev ${committed.fact.rev} in force: ${sidecar.id} landed${committed.fact.publication === undefined ? '' : ` (published by ${committed.fact.publication.pub} at ${committed.fact.publication.head})`}`,
      ...committed.fact.changes.map((c) => canonicalJson(c)),
      ...writeBack(ctx, before, after),
    ],
  };
}

// TEMPORARY SCAFFOLDING (SCHEMAS.md "Record evolution"): a rule whose previous revision a 1.0.0-dev.5 executor
// recorded (no payload) keeps the live ledger's hash it evaluated against before it commits, so a run again after a
// crash past the fact compares the live files with it. That revision has no sidecars or obligations in force. Delete
// once no arc started on 1.0.0-dev.5 is in flight.

/** `<runDir>/commands/rule-preimages/<command>.json`: `{ledgerSha256}`. */
const legacyPreimagePath = (runDir: AbsPath, id: CommandId): AbsPath => absPath(join(runDir, COMMANDS_DIR, 'rule-preimages', `${id}.json`));

function keepLegacyPreimage(runDir: AbsPath, id: CommandId, before: WrittenBack): void {
  if (Object.keys(before.sidecars).length > 0 || before.obligations !== null) throw new Error(`a 1.0.0-dev.5 revision in force has sidecars or obligations: ${canonicalJson(before)}`);
  const path = legacyPreimagePath(runDir, id);
  mkdirSync(dirname(path), { recursive: true });
  atomicJson(path, { ledgerSha256: before.ledgerSha256 });
}

function legacyPreimage(runDir: AbsPath, id: CommandId): WrittenBack {
  const path = legacyPreimagePath(runDir, id);
  if (!existsSync(path)) throw new Error(`rule ${id} committed on a 1.0.0-dev.5 revision without keeping the ledger it replaced (${path})`);
  const read = object((f) => ({ ledgerSha256: f.get('ledgerSha256', (v, p) => sha256(v, p)) }))(JSON.parse(readFileSync(path, 'utf8')), path);
  return { ledgerSha256: read.ledgerSha256, sidecars: {}, obligations: null };
}

/** The write-back of the revision `rev` command `id` committed, found from the log (a run again after a crash). */
function writeBackAfter(ctx: CommandContext, id: CommandId, rev: number): readonly string[] {
  const facts = readJournal(ctx.runDir, ctx.journal.view.arc).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [e.fact] : []));
  const mine = facts.find((f) => f.rev === rev);
  const prev = facts.find((f) => f.rev === rev - 1);
  if (mine?.payloadSha256 === undefined) throw new Error(`plan rev ${rev} of a rule has no payload`);
  if (prev === undefined) throw new Error(`plan rev ${rev} of a rule has no revision before it in the log`);
  const before = prev.payloadSha256 === undefined ? legacyPreimage(ctx.runDir, id) : writtenBackOf(keptPayload(ctx.runDir, prev.payloadSha256).manifest);
  return writeBack(ctx, before, writtenBackOf(keptPayload(ctx.runDir, mine.payloadSha256).manifest));
}

/**
 * The live ledger, sidecar and obligations files take the revision's bytes where they still hold the previous
 * revision's (or, for a sidecar new in it, where none exists yet); a file the architect changed since is left alone
 * and reported.
 */
function writeBack(ctx: CommandContext, before: WrittenBack, after: WrittenBack): readonly string[] {
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
  for (const id of Object.keys(after.sidecars).sort() as RulingId[]) {
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
