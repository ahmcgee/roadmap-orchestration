import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateScaleArc, ownScaleArc, padScaleJournal } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { consoleGet } from '../helpers/console-http.ts';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { arcId, commandId, sha256, unitId } from '../../src/core/ids.ts';
import { sha256Hex } from '../../src/core/json.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import type { ShellView } from '../../src/console/view-protocol.ts';

// The field arc (dev.60): while units build, an arc rewrites its schedule several times a second, moves branch refs and appends
// journal events, so its records change during every check. A check that any record change discarded never published: from a
// fresh start the console served nothing (browser views stayed "preparing", the event stream failed), and every check folded
// the whole journal again because no observation was ever kept.
test('a busy arc whose records change during every check converges: the event stream and browser views follow it from a fresh start', {timeout: 240_000}, async t => {
  const dir = tmpDir('console-busy'), m = await generateScaleArc(dir, {units: 40, days: 2, seed: 'busy-week'});
  padScaleJournal(m, 60_000);
  const release = await ownScaleArc(m); t.after(release);
  // The arc is busy before the console starts.
  const journal = openJournal(absPath(m.runDir), arcId(m.arc)); t.after(() => journal.close());
  const sched = join(m.runDir, 'sched.json'), schedule = JSON.parse(readFileSync(sched, 'utf8')) as {queue: {queuedAt: number}[]};
  const git = (...args: string[]) => execFileSync('git', ['-C', m.repo, ...args], {encoding: 'utf8'}).trim();
  const heads = [git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD~1')];
  let appended = 0, written = 0, moves = 0;
  const timers = [
    setInterval(() => {
      for (let k = 0; k < 1 + appended % 3; k++) written = journal.fact({kind: 'noted', unit: unitId(`u${1 + appended % 40}`),
        command: commandId(`cmd-${String(900_000 + ++appended).padStart(16, '0')}`), brief: sha256(sha256Hex(`busy ${appended}`))});
    }, 250),
    setInterval(() => {
      writeFileSync(`${sched}.tmp`, JSON.stringify({...schedule, queue: schedule.queue.map((q, i) => i === 0 ? {...q, queuedAt: q.queuedAt + ++moves} : q)}));
      renameSync(`${sched}.tmp`, sched);
    }, 150),
    setInterval(() => git('update-ref', 'refs/heads/busy', heads[moves % 2]!), 700),
  ];
  t.after(() => timers.forEach(clearInterval));
  await new Promise(resolve => setTimeout(resolve, 1_000));

  const server = await serveConsole({repo: absPath(m.repo), common: gitCommonDir(absPath(m.repo)), hostDir: absPath(m.hostDir), host: '127.0.0.1', port: 0});
  t.after(() => server.close());
  const base = `${server.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}`;
  // The event stream opens and publishes revisions while the arc stays busy.
  const stream = new AbortController(); t.after(() => stream.abort());
  const events = await fetch(`${base}/events`, {signal: stream.signal});
  if (events.status !== 200) assert.fail(`event stream: ${events.status} ${await events.text()}`);
  const revisions: number[] = [];
  void (async () => {
    const reader = events.body!.getReader(); let text = '';
    try {
      for (;;) {
        const {value, done} = await reader.read(); if (done) return; text += new TextDecoder().decode(value);
        for (let end = text.indexOf('\n\n'); end >= 0; end = text.indexOf('\n\n')) {
          const frame = text.slice(0, end); text = text.slice(end + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (/^event: revision$/m.test(frame) && data) revisions.push((JSON.parse(data.slice(6)) as {highWater: number}).highWater);
        }
      }
    } catch (error) { if (!stream.signal.aborted) throw error; }
  })();
  const views: number[] = [];
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    const r = await consoleGet(`${base}/shell`), body = await r.json() as {highWater: number; data: ShellView; error?: {message: string}};
    assert.equal(r.status, 200, `browser shell: ${body.error?.message}`);
    assert.equal(body.data.lifecycle.state, 'running');
    views.push(body.highWater);
    // A strict read is either current or says it raced the writer; it is never served stale.
    const s = await fetch(`${base}/status`), status = await s.json() as {highWater: number; error?: {code: string}};
    if (s.status === 200) assert.ok(status.highWater >= body.highWater, `strict ${status.highWater} behind browser ${body.highWater}`);
    else assert.equal(status.error?.code, 'unavailable');
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  assert.ok(moves > 50 && appended > 40, `schedule rewrites ${moves}, appends ${appended}`);
  assert.ok(new Set(views).size > 5, `browser highWaters ${[...new Set(views)].join(',')}`);
  assert.ok(new Set(revisions).size > 5, `published revisions ${[...new Set(revisions)].join(',')}`);
  // Published checks keep up: the last one is within a few seconds of the journal.
  assert.ok(written - Math.max(...revisions) < 40, `last published ${Math.max(...revisions)} of ${written}`);
});
