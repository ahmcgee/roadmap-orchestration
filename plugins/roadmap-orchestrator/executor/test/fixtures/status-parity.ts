// Portable projection fixtures. Normalization changes only fixture identities and timing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordAnswer } from '../../src/answers.ts';
import { submitCommand, writeReceipt } from '../../src/commands/queue.ts';
import { arcId, commandId, debtId, envId, invocationId, jobId, laneId, opKey, phaseQuestionId, sha, sha256, specRev, unitId } from '../../src/core/ids.ts';
import { absPath, isoTimeOf } from '../../src/core/values.ts';
import { SCHEMA_VERSION } from '../../src/core/version.ts';
import { debtKey } from '../../src/debt/ledger.ts';
import { inputShaOf } from '../../src/git/reusekey.ts';
import { snapshotRequestOf, witnessDir } from '../../src/git/snapshot.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { witnessRecordOf, writeWitnessRecord } from '../../src/holistic/witness.ts';
import { specShaInForce } from '../../src/input/inforce.ts';
import { systemsMapInForce } from '../../src/input/systems.ts';
import { raiseNeedsUser } from '../../src/needsuser.ts';
import { pinDispatch, verificationWorktree } from '../../src/pipeline/dispatch.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { specSeriesRoot } from '../../src/pipeline/lanes.ts';
import { at, executorIdentity, record, start } from '../../src/pipeline/stages.ts';
import { snapshotPublishOp } from '../../src/recover/ops.ts';
import { runnerFiles } from '../../src/runner/files.ts';
import { commitAll, git, writeFiles } from '../helpers/repo.ts';
import { setupCorpusArc } from './corpus-unit.ts';
import { runOp } from './git-common.ts';
import { contextFor } from './unit-common.ts';
import { milestoneJson, PRODUCT, walkArc } from './walk-common.ts';

export function parityArc() {
  const d = walkArc({ steps: [] });
  const raw = JSON.parse(readFileSync(d.planPath, 'utf8'));
  writeFileSync(d.planPath, JSON.stringify({ ...raw, expectations: { arcUsd: 10, perMilestoneUsd: 3 } }));
  const r = contextFor(d);
  raiseNeedsUser(r.journal, r.ctx.runDir, { reason: 'revision-notice', blocking: false, subject: { type: 'arc' }, summary: 'Review the plan', recommendation: 'Inspect', options: [], evidence: [] }, { type: 'arc' });
  const at = isoTimeOf(new Date('2026-01-01T00:00:00.000Z'));
  for (let i = 1; i <= 12; i++) writeReceipt(r.ctx.runDir, { v: SCHEMA_VERSION, command: commandId(`cmd-${i.toString(16).padStart(16, '0')}`), state: 'rejected', at, reason: `Rejected ${i}` });
  submitCommand(r.ctx.runDir, arcId(d.arc), { type: 'pause', target: { type: 'all' } });
  r.journal.close();
  return { d, runDir: r.ctx.runDir, hostDir: r.ctx.hostDir };
}

export function portableStatus(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v: unknown) => {
    if (typeof v === 'string' && /^t-[0-9a-f]{12}$/.test(v)) return '<arc>';
    if (key === 'foldMs' || key === 'bytes') return 0;
    if (typeof v !== 'string') return v;
    if (v.startsWith('/')) return '<path>';
    return v.replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{40}\b/g, '<sha>')
      .replace(/cmd-[0-9a-f]{16}/g, '<command>');
  }));
}

// A second fixture keeps the original golden intact and adds execution and cross-arc history.
export async function enrichedParityArc() {
  const a = await setupCorpusArc([], {
    units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }, { id: 'u3' }],
    phase0: { questions: [{ id: 'P-1', rank: 1, text: 'Keep the contract?', files: ['0010_Rules.md'], bears: ['V-1'], assumption: 'Yes', state: { type: 'open' } }] },
  });
  const repo = absPath(a.d.repo);
  const raw = JSON.parse(readFileSync(join(a.planDir, 'obligations.json'), 'utf8'));
  raw.lanes.push({ ...raw.lanes[0], id: 'external', witnessClass: 'external' });
  raw.obligations.push({ ...raw.obligations[0], id: 'I-2', rule: { id: a.pin.rules[1]!.id, textSha256: a.pin.rules[1]!.textSha256 }, statement: a.pin.rules[1]!.text,
    witness: { ...raw.obligations[0].witness, lane: 'external' } });
  raw.census[1].state = { type: 'obligation', id: 'I-2' };
  writeFileSync(join(a.planDir, 'obligations.json'), JSON.stringify(raw));
  const plan = JSON.parse(readFileSync(a.d.planPath, 'utf8'));
  writeFiles(repo, PRODUCT);
  commitAll(repo, 'the parity product');
  plan.suite.lanes[0].id = 'mul';
  plan.milestones = [milestoneJson()];
  plan.expectations = { arcUsd: 10, perMilestoneUsd: 3 };

  // Publish an actual earlier arc's revision and journal through the real snapshot operation.
  const earlier = arcId('earlier');
  const earlierPath = join(a.planDir, 'earlier.json');
  writeFileSync(earlierPath, JSON.stringify({ ...plan, arc: earlier }));
  const priorDir = join(repo, '.git', 'roadmap-runtime', earlier); mkdirSync(priorDir, { recursive: true });
  const prior = contextFor({ ...a.d, arc: earlier, planPath: earlierPath, runDir: priorDir });
  try {
    await runOp(prior.journal, snapshotPublishOp(repo), 'parity-snapshot', snapshotRequestOf({
      view: prior.journal.view, runDir: prior.ctx.runDir, identity: executorIdentity(), message: 'earlier parity arc\n',
    }));
  } finally { prior.journal.close(); }
  const head = sha(git(repo, 'rev-parse', 'main'));
  writeFileSync(a.d.planPath, JSON.stringify({ ...plan, chain: { previousArc: earlier, previousHead: head } }));
  const d = { ...a.d, runDir: join(repo, '.git', 'roadmap-runtime', a.d.arc) };
  mkdirSync(d.runDir, { recursive: true });
  const r = contextFor(d), j = r.journal;
  const h = sha256('c'.repeat(64));
  const atTime = isoTimeOf(new Date('2026-01-01T00:00:00.000Z'));
  try {
    const tree = sha(git(repo, 'rev-parse', `${head}^{tree}`));
    const lanes = parseObligations(raw).lanes;
    const lane = lanes[0]!, external = lanes[1]!;
    const parent = { type: 'job', job: jobId('baseline', 1) } as const;
    const { op } = j.begin({ kind: 'proc.spawn', key: opKey('parity-witness'), parent, deadlineAt: null,
      body: () => ({ expect: { subject: { purpose: 'journey', lane: lane.id, laneRev: laneRevOf(lane), at: head, owner: parent }, launchSha256: h }, post: null }) });
    const inv = invocationId(op, 1);
    const entry = { lane: lane.id, laneRev: laneRevOf(lane), envId: envId('fedcba9876543210'), treeSha: tree, inv, purpose: 'witness', for: parent } as const;
    const dir = witnessDir(r.ctx.runDir, entry); mkdirSync(dir, { recursive: true });
    const recordsSha256 = writeWitnessRecord(dir, witnessRecordOf({ lane: lane, envId: entry.envId, treeSha: tree, inv, purpose: 'witness' }, [{ testId: 't1', selected: 1, outcome: 'pass' }]));
    j.fact({ kind: 'witnessed', ...entry, recordsSha256, inputSha: inputShaOf(repo, tree, lane, systemsMapInForce(j.view.planApplied())) });
    j.done(op, 'proc.spawn', { kind: 'result', pressure: null, resultSha256: h, summary: { type: 'command', verdict: 'pass' } }, null);
    j.fact({ kind: 'external-witness', command: commandId('cmd-0000000000000001'), obligation: raw.obligations[1].id, obligationRev: 1,
      laneRev: laneRevOf(external), inputSha: inputShaOf(repo, tree, external, systemsMapInForce(j.view.planApplied())), head, result: 'fail', evidence: 'https://ci.example.invalid/parity', evidenceSha256: null });

    for (const unit of r.ctx.plan().units.slice(0, 2)) {
      pinDispatch(r.ctx, unit, { rev: specRev(1), sha256: specShaInForce(j.view, unit.id)! });
      const parent = start(r.ctx, unit.id, 'lanes');
      const { op: checkout } = j.begin({ kind: 'worktree.create', key: opKey(`parity-checkout:${unit.id}`), parent, deadlineAt: null,
        body: () => ({ expect: { path: verificationWorktree(r.ctx.plan().worktreeRoot, arcId(d.arc), unit.id), checkout: { type: 'detached', at: head } }, post: null }) });
      j.done(checkout, 'worktree.create', { kind: 'created', head }, null);
      const { op } = j.begin({ kind: 'proc.spawn', key: opKey(`parity-lane:${unit.id}`), parent, deadlineAt: null,
        body: () => ({ expect: { subject: { purpose: 'lane', unit: unit.id, lane: laneId('mul'), set: 'spec', at: head }, launchSha256: h }, post: null }) });
      const inv = invocationId(op, 1);
      mkdirSync(invocationDir(r.ctx.runDir, inv), { recursive: true });
      runnerFiles(invocationDir(r.ctx.runDir, inv), inv).write('exit.json', { v: SCHEMA_VERSION, arc: arcId(d.arc), op, inv,
        child: { type: 'exited', code: 0 }, cause: 'exited', endedAt: atTime, quiescedAt: atTime, cpu: { wallMs: 120, runMs: 80, waitMs: 10 } });
      j.done(op, 'proc.spawn', { kind: 'result', pressure: null, resultSha256: h, summary: { type: 'command', verdict: 'pass' } }, null);
      const dir = join(specSeriesRoot(r.ctx.runDir, parent), 'mul'); mkdirSync(dir, { recursive: true });
      const sample = { load1: 1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 900_000 };
      writeFileSync(join(dir, 'host.json'), JSON.stringify({ start: sample, end: sample }));
      const { op: evidence } = j.begin({ kind: 'evidence.snapshot', key: opKey(`parity-evidence:${unit.id}`), parent, deadlineAt: null,
        body: () => ({ expect: { source: invocationDir(r.ctx.runDir, inv), globs: [], dest: absPath(join(dir, 'output')) }, post: { manifest: absPath(join(dir, 'output', 'manifest.json')) } }) });
      j.done(evidence, 'evidence.snapshot', { kind: 'captured', manifestSha256: h, files: 0 }, null);
      j.fact({ kind: 'lane-reused', parent, lane: laneId('mul'), set: 'suite', at: head, from: { parent, inv, at: head } });
      record(r.ctx, at(parent, 'lanes'), 'green');
    }
    const what = 'Tidy the parity helpers.';
    j.fact({ kind: 'debt-banked', id: debtId('B-1'), bankReason: 'gate-note', what, key: debtKey({ unit: unitId('u1'), bankReason: 'gate-note', what }),
      source: { type: 'gate', unit: unitId('u1'), attempt: 1, index: 0 } });
    raiseNeedsUser(j, r.ctx.runDir, { reason: 'revision-notice', blocking: false, subject: { type: 'arc' }, summary: 'Review the plan', recommendation: 'Inspect', options: [], evidence: [] }, { type: 'arc' });
    for (let i = 1; i <= 12; i++) writeReceipt(r.ctx.runDir, { v: SCHEMA_VERSION, command: commandId(`cmd-${i.toString(16).padStart(16, '0')}`), state: 'rejected', at: atTime, reason: `Rejected ${i}` });
    submitCommand(r.ctx.runDir, arcId(d.arc), { type: 'pause', target: { type: 'all' } });
    writeFiles(repo, { 'src/history.js': 'export const moved = true;\n' });
    commitAll(repo, 'move beyond both observations');
  } finally { j.close(); }
  const answer = recordAnswer(repo, phaseQuestionId('P-1'), 'Yes', arcId(d.arc));
  if (answer.kind !== 'recorded') throw new Error(`parity answer: ${JSON.stringify(answer)}`);
  return { d, runDir: r.ctx.runDir, hostDir: r.ctx.hostDir };
}

/** As in the original capture, normalize only generated identities and nondeterministic timing. */
export function portableEnrichedStatus(value: unknown): unknown {
  return JSON.parse(JSON.stringify(portableStatus(value), (key, v: unknown) => {
    if (key === 'p50Ms' || key === 'maxMs') return 0;
    return typeof v === 'string' ? v.replace(/t-[0-9a-f]{12}/g, '<arc>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>') : v;
  }));
}
