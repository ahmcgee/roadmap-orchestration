// Real Git and authoritative records, built outside the cost measurement. No executor/backend processes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordAnswer } from '../../src/answers.ts';
import { writeReceipt } from '../../src/commands/queue.ts';
import { type Event, prevHash, serializeEvent } from '../../src/core/events.ts';
import { arcId, commandId, envId, invocationId, jobId, laneId, opKey, sha, sha256, unitId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { absPath, isoTime } from '../../src/core/values.ts';
import { inputShaOf } from '../../src/git/reusekey.ts';
import { systemsMapInForce } from '../../src/input/systems.ts';
import { witnessDir } from '../../src/git/snapshot.ts';
import { type ArcLaneDef, laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { witnessRecordOf, writeWitnessRecord } from '../../src/holistic/witness.ts';
import { pinDispatch, verificationWorktree } from '../../src/pipeline/dispatch.ts';
import { specSeriesRoot } from '../../src/pipeline/lanes.ts';
import { at, record, start } from '../../src/pipeline/stages.ts';
import { specShaInForce } from '../../src/input/inforce.ts';
import { corpusHolisticArc } from './corpus-holistic.ts';
import { contextFor } from './unit-common.ts';
import { git, writeFiles, commitAll } from '../helpers/repo.ts';

const H = sha256('c'.repeat(64));
const AT = isoTime('2026-01-01T00:00:00.000Z');

export async function statusCostArc(lines: number, units: number, trees: number) {
  const a = await corpusHolisticArc([], { units: Array.from({ length: units }, (_, i) => ({ id: `u${i + 1}` })),
    phase0: { questions: [{ id: 'P-1', rank: 1, text: 'Keep the contract?', files: ['0010_Rules.md'], bears: ['V-1'], assumption: 'Yes', state: { type: 'open' } }] } });
  const file = join(a.planDir, 'obligations.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.lanes.push({ ...raw.lanes[0], id: 'external', witnessClass: 'external' });
  raw.obligations.push({ ...raw.obligations[0], id: 'I-2', rule: { id: a.pin.rules[1]!.id, textSha256: a.pin.rules[1]!.textSha256 }, statement: a.pin.rules[1]!.text, witness: { ...raw.obligations[0].witness, lane: 'external' } });
  raw.census[1].state = { type: 'obligation', id: 'I-2' };
  writeFileSync(file, JSON.stringify(raw));
  const plan = JSON.parse(readFileSync(a.d.planPath, 'utf8'));
  plan.suite.lanes[0].id = 'mul';
  writeFileSync(a.d.planPath, JSON.stringify(plan));
  const d = { ...a.d, runDir: join(a.d.repo, '.git', 'roadmap-runtime', a.d.arc) };
  mkdirSync(d.runDir, { recursive: true });
  const r = contextFor(d), j = r.journal;
  const repo = absPath(a.d.repo);
  const head = sha(git(repo, 'rev-parse', 'main'));
  const tree = sha(git(repo, 'rev-parse', `${head}^{tree}`));
  const lane = parseObligations(raw).lanes[0]!;
  const witness = (lane: ArcLaneDef) => {
    const parent = { type: 'job', job: jobId('baseline', 1) } as const;
    const { op } = j.begin({ kind: 'proc.spawn', key: opKey('cost-witness'), parent, deadlineAt: null,
      body: () => ({ expect: { subject: { purpose: 'journey', lane: lane.id, laneRev: laneRevOf(lane), at: head, owner: parent }, launchSha256: H }, post: null }) });
    const inv = invocationId(op, 1);
    const entry = { lane: lane.id, laneRev: laneRevOf(lane), envId: envId('fedcba9876543210'), treeSha: tree, inv, purpose: 'witness', for: parent } as const;
    const dir = witnessDir(r.ctx.runDir, entry); mkdirSync(dir, { recursive: true });
    const recordsSha256 = writeWitnessRecord(dir, witnessRecordOf({ lane, envId: entry.envId, treeSha: tree, inv, purpose: 'witness' }, [{ testId: 't1', selected: 1, outcome: 'pass' }]));
    j.fact({ kind: 'witnessed', ...entry, recordsSha256, inputSha: inputShaOf(repo, tree, lane, systemsMapInForce(j.view.planApplied())) });
    j.done(op, 'proc.spawn', { kind: 'result', pressure: null, resultSha256: H, summary: { type: 'command', verdict: 'pass' } }, null);
  };
  witness(lane);
  const external = parseObligations(raw).lanes[1]!;
  j.fact({ kind: 'external-witness', command: commandId('cmd-0000000000000001'), obligation: raw.obligations[1].id,
    obligationRev: 1, laneRev: laneRevOf(external), inputSha: inputShaOf(repo, tree, external, systemsMapInForce(j.view.planApplied())), head, result: 'fail', evidence: 'https://ci.example.invalid', evidenceSha256: null });
  // Certify every unit, including a reuse of the counted run; detached checkout avoids mutable branch lookup.
  for (const unit of r.ctx.plan().units) {
    pinDispatch(r.ctx, unit, { rev: 1 as never, sha256: specShaInForce(j.view, unit.id)! });
    const parent = start(r.ctx, unit.id, 'lanes');
    const { op: create } = j.begin({ kind: 'worktree.create', key: opKey(`cost-checkout:${unit.id}`), parent, deadlineAt: null,
      body: () => ({ expect: { path: verificationWorktree(r.ctx.plan().worktreeRoot, arcId(a.d.arc), unit.id), checkout: { type: 'detached', at: head } }, post: null }) });
    j.done(create, 'worktree.create', { kind: 'created', head }, null);
    const { op } = j.begin({ kind: 'proc.spawn', key: opKey(`cost-lane:${unit.id}`), parent, deadlineAt: null,
      body: () => ({ expect: { subject: { purpose: 'lane', unit: unit.id, lane: laneId('mul'), set: 'spec', at: head }, launchSha256: H }, post: null }) });
    j.done(op, 'proc.spawn', { kind: 'result', pressure: null, resultSha256: H, summary: { type: 'command', verdict: 'pass' } }, null);
    const root = specSeriesRoot(r.ctx.runDir, parent), dir = join(root, 'mul'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'host.json'), '{}');
    const source = absPath(join(r.ctx.runDir, 'inv', `${op.split('/').at(-1)}-1`));
    const { op: evidence } = j.begin({ kind: 'evidence.snapshot', key: opKey(`cost-evidence:${unit.id}`), parent, deadlineAt: null,
      body: () => ({ expect: { source, globs: [], dest: absPath(join(dir, 'output')) }, post: { manifest: absPath(join(dir, 'output', 'manifest.json')) } }) });
    j.done(evidence, 'evidence.snapshot', { kind: 'captured', manifestSha256: H, files: 0 }, null);
    j.fact({ kind: 'lane-reused', parent, lane: laneId('mul'), set: 'suite', at: head, from: { parent, inv: invocationId(op, 1), at: head } });
    record(r.ctx, at(parent, 'lanes'), 'green');
  }
  for (let i = 0; i < trees; i++) { writeFiles(repo, { 'src/history.js': `export const n = ${i};\n` }); commitAll(repo, `history ${i}`); }
  for (let i = 1; i <= 12; i++) writeReceipt(r.ctx.runDir, { v: 2 as never, command: commandId(`cmd-${i.toString(16).padStart(16, '0')}`), state: 'rejected', at: AT, reason: `receipt ${i}` });
  j.close();
  const answer = recordAnswer(repo, 'P-1' as never, 'Yes', arcId(a.d.arc));
  if (answer.kind !== 'recorded') throw new Error(`cost fixture answer: ${JSON.stringify(answer)}`);
  const path = join(r.ctx.runDir, 'events.jsonl');
  const initial = readJournal(r.ctx.runDir, arcId(a.d.arc));
  const bytes = readFileSync(path); const chunks: Buffer[] = [bytes];
  let hash = prevHash(bytes.subarray(bytes.lastIndexOf(10, bytes.length - 2) + 1));
  for (let seq = initial.events.length + 1; seq <= lines; seq++) {
    const e: Event = { v: 2 as never, arc: arcId(a.d.arc), at: AT, seq, prev: hash, type: 'fact', fact: { kind: 'containment-mode', mode: 'session' } };
    const line = Buffer.from(serializeEvent(e)); chunks.push(line); hash = prevHash(line);
  }
  writeFileSync(path, Buffer.concat(chunks));
  return { runDir: r.ctx.runDir, hostDir: r.ctx.hostDir, arc: arcId(a.d.arc), forgePath: a.forge.path, units, lines };
}
