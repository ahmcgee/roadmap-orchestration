import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openJournal } from '../src/core/log.ts';
import { invocationDirName, opKey, sha256 } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { serveConsole } from '../src/console/http.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { consoleFixture } from './fixtures/console.ts';

test('recorded result verdicts validate identity and hash; valid-schema tampering is corruption and pruning is explicit', async (t) => {
  const f = consoleFixture(); const j = openJournal(f.runDir, f.arc);
  const spawn = j.begin({ kind: 'proc.spawn', key: opKey('console-result'), parent: { type: 'arc' }, deadlineAt: null,
    body: () => ({ expect: { subject: { purpose: 'smoke', check: 'command', target: { type: 'command' } }, launchSha256: sha256('1'.repeat(64)) }, post: null }) });
  const dir = invocationDir(f.runDir, spawn.inv); mkdirSync(dir, { recursive: true });
  runnerFiles(dir, spawn.inv).write('result.json', { v: 2, arc: f.arc, op: spawn.op, inv: spawn.inv, type: 'command', purpose: 'smoke', expectedExit: 0, exitCode: 0, verdict: 'pass' });
  const path = join(dir, 'result.json'), original = readFileSync(path);
  j.done(spawn.op, 'proc.spawn', { kind: 'result', resultSha256: sha256(sha256Hex(original)), summary: { type: 'command', verdict: 'pass' }, pressure: null }, null); j.close();
  const s = await serveConsole({ ...f, host: '127.0.0.1', port: 0 }); t.after(() => s.close());
  const api = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
  const response = await fetch(`${api}/invocations/${invocationDirName(spawn.inv)}/result`); assert.equal(response.status, 200);
  const body = await response.json() as { data: { record: { verdict: string }; lines: string[] } };
  assert.equal(body.data.record.verdict, 'pass'); assert.ok(body.data.lines.some((l) => l.includes('pass')));
  writeFileSync(path, JSON.stringify({ ...JSON.parse(original.toString()), verdict: 'fail', exitCode: 1 }));
  // The console's integrity sweep finds the tampered bytes within its detection bound (a step or two on this fixture) and
  // forces a fresh capture, which fails; browser reads then answer the corruption. A read's 202 poll carries its answer.
  const deadline = Date.now() + 10_000;
  let corrupt: Response;
  for (;;) {
    corrupt = await fetch(`${api}/shell`);
    while (corrupt.status === 202) corrupt = await fetch(`${api}/shell?pending=${(await corrupt.json() as { pending: string }).pending}`);
    if (corrupt.status !== 200 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(corrupt.status, 500); assert.match(await corrupt.text(), /resultSha256/);
  writeFileSync(path, original); rmSync(path);
  const pruned = await fetch(`${api}/invocations/${invocationDirName(spawn.inv)}/result`); assert.equal(pruned.status, 404);
  assert.match(await pruned.text(), /absent|pruned/);
});
