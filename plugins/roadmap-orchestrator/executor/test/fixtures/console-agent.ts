// Real journal/launch/owner records; transcript bytes are scripted, no backend CLI is invoked.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arcId, implementerSessionId, invocationDirName, opKey, sha256, specRev, unitId } from '../../src/core/ids.ts';
import { sha256Hex, type JsonValue } from '../../src/core/json.ts';
import type { LaunchFile, ResultFile } from '../../src/core/records.ts';
import { absPath, isoTime } from '../../src/core/values.ts';
import { claimHost, releaseHost } from '../../src/host/lock.ts';
import { publishOwner } from '../../src/host/owner.ts';
import { selfIdentity } from '../../src/host/liveness.ts';
import { openHostDir } from '../../src/host/hostdir.ts';
import { inputPath, keepInput, specShaInForce } from '../../src/input/inforce.ts';
import { pinDispatch } from '../../src/pipeline/dispatch.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { at, record, start } from '../../src/pipeline/stages.ts';
import { runnerFiles } from '../../src/runner/files.ts';
import { launchSha256 } from '../../src/runner/launch.ts';
import { contextFor } from './unit-common.ts';
import { enrichedParityArc } from './status-parity.ts';
export async function consoleAgentFixture(existing?: Awaited<ReturnType<typeof enrichedParityArc>>, seatPrompt?: string) {
  const f = existing ?? await enrichedParityArc(); const r = contextFor(f.d);
  const arc = arcId(f.d.arc); const unit = unitId('u3'); const rev = r.ctx.routing(null).rev;
  pinDispatch(r.ctx, r.unit(unit), { rev: specRev(1), sha256: specShaInForce(r.journal.view, unit)! });
  const parent = start(r.ctx, unit, 'build'); const session = implementerSessionId('00000000-0000-4000-8000-000000000111');
  const prompt = seatPrompt ?? 'Implement the unit contract. Inspect the source, explain your reasoning, and report verification evidence.\n';
  const stdinPath = inputPath(f.runDir, keepInput(f.runDir, Buffer.from(prompt), 'prompt.txt'), 'prompt.txt');
  let launch!: LaunchFile;
  const spawned = r.journal.begin({ kind: 'proc.spawn', key: opKey('console-live-agent'), parent, deadlineAt: null, body: (op, inv) => {
    launch = { v: 2, arc, op, inv, argv: ['claude', '-p', '--output-format', 'stream-json', '--model', 'scripted-history-fixture'], cwd: absPath(f.d.repo), env: {}, stdinPath,
      deadlineAt: isoTime('2099-01-01T00:00:00.000Z'), stallMs: null, graceMs: 1000, containment: 'session', test: null,
      terminal: { type: 'backend', purpose: 'backend', role: 'build', routingRev: rev, schemaPath: absPath(join(f.runDir, 'report.schema.json')), outputPath: absPath(join(invocationDir(f.runDir, inv), 'stdout')), session: { backend: 'claude', mode: 'fresh', id: session } } };
    return { expect: { subject: { purpose: 'backend', role: 'build', tier: 'med', unit, attempt: parent.attempt, routingRev: rev }, launchSha256: launchSha256(launch) }, post: null };
  } });
  const dir = invocationDir(f.runDir, spawned.inv); mkdirSync(dir, { recursive: true });
  const files = runnerFiles(dir, spawned.inv); files.write('launch.json', launch);
  const transcript = join(dir, 'stdout');
  const shape = readFileSync(new URL('./transcripts/claude.jsonl', import.meta.url), 'utf8').trimEnd().split('\n');
  writeFileSync(transcript, shape.slice(0, 6).join('\n') + '\n');
  openHostDir(f.hostDir);
  const owner = selfIdentity();
  const claim = await claimHost(f.hostDir, { runDir: f.runDir, arc, repo: absPath(f.d.repo), supervisor: owner }, async () => ({ kind: 'reconciled' }));
  if (claim.kind !== 'claimed') throw new Error('fixture host already claimed');
  publishOwner(f.hostDir, claim.claim, { pid: owner.pid, start: owner.start });
  let ended = false;
  return { ...f, arc, inv: spawned.inv, routeId: invocationDirName(spawned.inv), transcript, prompt,
    append(text: string) { appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'); },
    finish(report: JsonValue = { summary: 'Verified the change.' }) {
      appendFileSync(transcript, shape[6] + '\n');
      const now = isoTime(new Date().toISOString()); const binding = { v: 2 as const, arc, op: spawned.op, inv: spawned.inv };
      const result: ResultFile = { ...binding, type: 'backend', role: 'build', routingRev: rev, session, outcome: { kind: 'success', value: report }, usage: { kind: 'unavailable', reason: 'absent' }, backendErrors: [] };
      files.write('result.json', result); files.write('exit.json', { ...binding, child: { type: 'exited', code: 0 }, cause: 'exited', endedAt: now, quiescedAt: now, cpu: null });
      r.journal.done(spawned.op, 'proc.spawn', { kind: 'result', pressure: null, resultSha256: sha256(sha256Hex(readFileSync(join(dir, 'result.json')))), summary: { type: 'backend', outcome: 'success' } }, null);
      record(r.ctx, at(parent, 'build'), 'success'); ended = true;
    },
    close() { r.journal.close(); releaseHost(f.hostDir, claim.claim); },
    get ended() { return ended; },
  };
}
