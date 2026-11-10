import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveConsole } from '../src/console/http.ts';
import { retainedRuns } from '../src/console/runs.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { consoleFixture } from './fixtures/console.ts';

// A repo keeps finished arcs from before the schema cut beside the current one (field: dev.19-era m4/m5 runs).
function withLegacyArc(f: ReturnType<typeof consoleFixture>, id: string, start: object) {
  const dir = join(f.common, 'roadmap-runtime', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'start.json'), JSON.stringify(start));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

test('a pre-cut schema-1 arc is left out of the listing and does not break the current arc', async (t) => {
  const f = consoleFixture();
  withLegacyArc(f, 'm4-conventional-runtime', { v: 1, generation: 1, at: '2099-01-01T00:00:00.000Z' });
  const listed = retainedRuns(f.common, f.hostDir);
  assert.deepEqual(listed.arcs.map((r) => r.arc), [f.arc]);
  assert.equal(listed.selected, f.arc);
  const console = await serveConsole({ ...f, host: '127.0.0.1', port: 0, instance: 'test' });
  t.after(() => console.close());
  const api = `${console.url}/api/${CONSOLE_PROTOCOL}`;
  assert.equal((await fetch(`${api}/arcs/${f.arc}/status`)).status, 200);
  assert.equal((await fetch(`${api}/arcs/${f.arc}/status?summary=1`)).status, 200);
  // Unlisted, like any absent arc: unavailable, so `roadmap status --arc` falls back to its local read.
  const legacy = await fetch(`${api}/arcs/m4-conventional-runtime/status`);
  assert.equal(legacy.status, 503);
  assert.equal(((await legacy.json()) as { error: { code: string } }).error.code, 'unavailable');
});

test('a malformed current-schema start record still fails loudly', () => {
  const f = consoleFixture();
  withLegacyArc(f, 'broken', { v: 2, generation: 1 });
  assert.throws(() => retainedRuns(f.common, f.hostDir));
});
