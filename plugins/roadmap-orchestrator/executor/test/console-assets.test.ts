import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { serveConsole } from '../src/console/http.ts';
import { consoleFixture } from './fixtures/console.ts';

test('every vendored byte has a recorded checksum and provenance; React stays out of package dependencies', () => {
  const manifest = readFileSync(new URL('../web/vendor/VENDOR.md', import.meta.url), 'utf8');
  const records = [...manifest.matchAll(/\| `([^`]+)` \| `([0-9a-f]{64})` \|/g)];
  assert.equal(records.length, 12);
  for (const [, name, hash] of records) assert.equal(createHash('sha256').update(readFileSync(new URL(`../web/vendor/${name}`, import.meta.url))).digest('hex'), hash, name);
  assert.match(manifest, /sha512-wS\+h/); assert.match(manifest, /sha512-5m4n/);
  assert.match(manifest, /react \*\*18\.3\.1\*\*, MIT/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies.react, undefined);
});

test('HTML revalidates; explicit content-hashed scripts, CSS and fonts are immutable; undeclared files are absent', async (t) => {
  const server = await serveConsole({ ...consoleFixture(), host: '127.0.0.1', port: 0 }); t.after(() => server.close());
  const page = await fetch(server.url); const html = await page.text();
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(html, /<title>Roadmap<\/title>/);
  const scripts = [...html.matchAll(/<script defer src="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(scripts.length, 4);
  assert.match(scripts[0]!, /react.production.min.js/); assert.match(scripts[1]!, /react-dom.production.min.js/);
  assert.match(scripts[2]!, /bundle.js/); assert.match(scripts[3]!, /app.js/);
  for (const path of [...scripts, ...[...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]!)]) {
    assert.match(path, /^\/assets\/[a-f0-9]{64}\//);
    const response = await fetch(server.url + path);
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /immutable/);
  }
  const root = scripts[0]!.slice(0, scripts[0]!.lastIndexOf('/'));
  const font = await fetch(`${server.url}${root}/fonts/space-grotesk.woff2`);
  assert.equal(font.headers.get('content-type'), 'font/woff2'); assert.equal(font.status, 200);
  for (const path of ['/web/app.js', '/vendor/VENDOR.md', '/.roadmap/config.json', '/src/console/http.ts', '/assets/not-current/app.js']) assert.equal((await fetch(server.url + path)).status, 404);
});
