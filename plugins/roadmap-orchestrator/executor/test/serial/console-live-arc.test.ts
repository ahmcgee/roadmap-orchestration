import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateScaleArc, ownScaleArc, padScaleJournal } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { consoleGet } from '../helpers/console-http.ts';
import { readGhCalls, STORE_FILE } from '../fakes/gh-store.ts';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { arcId, commandId, sha256, unitId } from '../../src/core/ids.ts';
import { sha256Hex } from '../../src/core/json.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import type { ShellView } from '../../src/console/view-protocol.ts';

// The field arc (dev.59): a long journal, a forge a network round trip away, and an executor appending a few events a second.
// Each check re-read the forge and deep-copied and re-hashed the whole journal, so it took longer than the gap between appends;
// a journal append during a check counted as a race, so every check was discarded. Nothing was published (the header kept
// its last state), strict reads failed at two seconds and browser reads at thirty, and the console log said nothing.
test('a live-appending long arc: checks keep up, strict and browser reads are current within budget, the forge is not re-read per append', {timeout: 240_000}, async t => {
  const dir = tmpDir('console-live'), m = await generateScaleArc(dir, {units: 40, days: 2, seed: 'live-week'});
  padScaleJournal(m, 60_000);
  // The fixture's fake forge, as slow as a real GitHub round trip.
  const bin = join(dir, 'slow-gh'); mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nsleep 0.6\nexec ${join(dir, 'forge', 'bin', 'gh')} "$@"\n`, {mode: 0o755});
  const path = process.env['PATH']; process.env['PATH'] = `${bin}:${path}`;
  t.after(() => { process.env['PATH'] = path; });
  const release = await ownScaleArc(m); t.after(release);
  const server = await serveConsole({repo: absPath(m.repo), common: gitCommonDir(absPath(m.repo)), hostDir: absPath(m.hostDir), host: '127.0.0.1', port: 0});
  t.after(() => server.close());
  const base = `${server.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}`;
  const strict = async () => {
    const started = Date.now(), r = await fetch(`${base}/status`), body = await r.json() as {highWater: number; error?: {message: string}};
    assert.equal(r.status, 200, `strict status: ${body.error?.message}`);
    return {highWater: body.highWater, ms: Date.now() - started};
  };
  const shell = async () => {
    const r = await consoleGet(`${base}/shell`), body = await r.json() as {highWater: number; data: ShellView; error?: {message: string}};
    assert.equal(r.status, 200, `browser shell: ${body.error?.message}`);
    return body;
  };
  const cold = await strict(); assert.ok(cold.highWater > 60_000);
  const forgeCalls = () => readGhCalls(join(dir, 'forge', STORE_FILE)).length;
  const coldCalls = forgeCalls(); assert.ok(coldCalls > 0, 'the first check reads the forge');

  const journal = openJournal(absPath(m.runDir), arcId(m.arc)); t.after(() => journal.close());
  let appended = 0, written = cold.highWater;
  const append = () => {
    for (let k = 0; k < 1 + appended % 3; k++) written = journal.fact({kind: 'noted', unit: unitId(`u${1 + appended % 40}`),
      command: commandId(`cmd-${String(900_000 + ++appended).padStart(16, '0')}`), brief: sha256(sha256Hex(`live ${appended}`))});
  };
  const appender = setInterval(append, 250);
  const until = Date.now() + 12_000, seen: number[] = [];
  try {
    while (Date.now() < until) {
      const s = await strict();
      assert.ok(s.ms < 2_000, `strict status took ${s.ms}ms`);
      const view = await shell();
      assert.equal(view.data.lifecycle.state, 'running', 'the header shows the running arc');
      seen.push(s.highWater, view.highWater);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally { clearInterval(appender); }
  assert.ok(appended > 60, `appended ${appended}`);
  // Checks were published while the arc appended: reads followed the journal, not the cold capture.
  assert.ok(new Set(seen).size > 5, `observed highWaters ${[...new Set(seen)].join(',')}`);
  assert.equal(forgeCalls(), coldCalls, 'no check re-read the forge for an append');
  const settled = Date.now() + 5_000;
  for (;;) {
    const [s, view] = [await strict(), await shell()];
    if (s.highWater === written && view.highWater === written) break;
    assert.ok(Date.now() < settled, `caught up to ${s.highWater}/${view.highWater} of ${written}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
});
