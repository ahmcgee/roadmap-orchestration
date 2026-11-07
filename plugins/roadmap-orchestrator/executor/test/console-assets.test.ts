import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { serveConsole } from '../src/console/http.ts';
import { consoleFixture } from './fixtures/console.ts';

test('prebuilt assets have complete package provenance and no runtime package dependencies', () => {
  const files = JSON.parse(readFileSync(new URL('../web/manifest.json', import.meta.url), 'utf8')) as string[];
  assert.deepEqual(files, [...files].sort());
  assert.equal(files.length, new Set(files).size);
  for (const name of files) { assert.doesNotMatch(name, /vendor|atlas|\.\./i); assert.ok(readFileSync(new URL(`../web/${name}`, import.meta.url)).length); }
  const notices = readFileSync(new URL('../web/THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  for (const name of ['react', 'react-dom', 'radix-ui', 'cmdk', 'cytoscape', '@dagrejs/dagre', 'lucide-react', 'class-variance-authority', 'clsx', 'tailwind-merge', '@fontsource/barlow', '@fontsource/barlow-semi-condensed', '@fontsource/jetbrains-mono', 'tailwindcss', 'tw-animate-css']) {
    assert.ok(notices.includes(`${name} ${pkg.devDependencies[name]}`), name);
  }
  assert.match(notices, /Permission is hereby granted/); assert.match(notices, /SIL OPEN FONT LICENSE/);
  assert.doesNotMatch(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), /AtlasDesignSystem|window\.React/);
});

test('HTML revalidates; explicit content-hashed scripts, CSS and fonts are immutable; undeclared files are absent', async (t) => {
  const server = await serveConsole({ ...consoleFixture(), host: '127.0.0.1', port: 0 }); t.after(() => server.close());
  const page = await fetch(server.url); const html = await page.text();
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(html, /<title>Roadmap<\/title>/);
  const scripts = [...html.matchAll(/<script defer src="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, /app.js/);
  for (const path of [...scripts, ...[...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]!)]) {
    assert.match(path, /^\/assets\/[a-f0-9]{64}\//);
    const response = await fetch(server.url + path);
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /immutable/);
  }
  const root = scripts[0]!.slice(0, scripts[0]!.lastIndexOf('/'));
  const font = await fetch(`${server.url}${root}/fonts/barlow-latin-400-normal.woff2`);
  assert.equal(font.headers.get('content-type'), 'font/woff2'); assert.equal(font.status, 200);
  for (const path of ['/web/app.js', '/vendor/VENDOR.md', '/.roadmap/config.json', '/src/console/http.ts', '/assets/not-current/app.js']) assert.equal((await fetch(server.url + path)).status, 404);
});
