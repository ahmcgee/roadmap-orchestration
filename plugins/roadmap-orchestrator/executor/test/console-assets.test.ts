import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  for (const name of ['react', 'react-dom', 'radix-ui', 'cmdk', 'cytoscape', 'lucide-react', 'class-variance-authority', 'clsx', 'tailwind-merge', 'tailwindcss', 'tw-animate-css']) {
    assert.ok(notices.includes(`${name} ${pkg.devDependencies[name]}`), name);
  }
  // The fonts are vendored from the foundry release, not an npm package: their notice names the release.
  assert.ok(notices.includes('Mona Sans 2.0.27\nLicence: OFL-1.1\n\nCopyright 2022 The Mona Sans Project Authors'), 'Mona Sans notice');
  assert.match(notices, /Permission is hereby granted/); assert.match(notices, /SIL OPEN FONT LICENSE/);
  // Audit code we own and emitted selectors; vendor implementation bytes are out of scope.
  const forbidden=/atlas|AtlasGlyph|AutonomousOrbit|Starfield|TransitMoment/i;
  function audit(dir:URL){for(const entry of readdirSync(dir,{withFileTypes:true})){assert.doesNotMatch(entry.name,forbidden);const path=new URL(entry.name+(entry.isDirectory()?'/':''),dir);if(entry.isDirectory())audit(path);else assert.doesNotMatch(readFileSync(path,'utf8'),forbidden,String(path));}}
  audit(new URL('../web-src/',import.meta.url));
  const css=readFileSync(new URL('../web/app.css',import.meta.url),'utf8');
  for(const selector of css.matchAll(/[^{}]+(?=\{)/g))assert.doesNotMatch(selector[0],forbidden,'generated CSS selector');
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
  const font = await fetch(`${server.url}${root}/fonts/mona-sans-vf-opsz-wght.woff2`);
  assert.equal(font.headers.get('content-type'), 'font/woff2'); assert.equal(font.status, 200);
  for (const path of ['/web/app.js', '/vendor/VENDOR.md', '/.roadmap/config.json', '/src/console/http.ts', '/assets/not-current/app.js']) assert.equal((await fetch(server.url + path)).status, 404);
});

test('the console ships exactly the vendored Mona Sans files, unchanged, and loads no font or stylesheet from the network', () => {
  // The hashes are the release's (web-src/fonts/README.md): a changed or extra font file is a deliberate, recorded change.
  const expected: Record<string, string> = {
    'mona-sans-italic-400.woff2': '19f03aa1b1d75f6d6b33b878f8c3e17c85e6d4e0463284e8f37f51fda19f4dfa',
    'mona-sans-mono-vf-wght.woff2': '034552e40f30aab5d5b4ede4d4f29fd38c3b93d923fcec90775fd488276122ef',
    'mona-sans-semicondensed-500.woff2': '8620ee38a0eb14b4a1a8daed760b5d804699a30dc8f61f4f002064b0dd09d876',
    'mona-sans-semicondensed-600.woff2': 'da5a83bdb9740b2c305860c90074a202a70632213d438627715fb2847239a835',
    'mona-sans-vf-opsz-wght.woff2': '62e40f6e14e5bbb97132b4513a4d97319ab6aaa46996cf46c7a9f357edadb662',
  };
  const files = JSON.parse(readFileSync(new URL('../web/manifest.json', import.meta.url), 'utf8')) as string[];
  assert.deepEqual(files.filter((f) => f.startsWith('fonts/')), Object.keys(expected).map((name) => `fonts/${name}`));
  for (const [name, sha] of Object.entries(expected)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../web/fonts/${name}`, import.meta.url))).digest('hex'), sha, name);
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../web-src/fonts/${name}`, import.meta.url))).digest('hex'), sha, `web-src ${name}`);
  }
  const css = readFileSync(new URL('../web/app.css', import.meta.url), 'utf8'), html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]!).filter((u) => !u.startsWith('data:'));
  assert.deepEqual([...new Set(urls.filter((u) => u.includes('fonts/')))].sort(), Object.keys(expected).map((name) => `./fonts/${name}`));
  for (const url of urls) assert.match(url, /^\.\/fonts\/[a-z0-9-]+\.woff2$/, `stylesheet reference ${url}`);
  assert.doesNotMatch(css, /@import\s/, 'no stylesheet imports survive the build');
  assert.doesNotMatch(css + html, /fonts\.googleapis|fonts\.gstatic|fontsource|Barlow|JetBrains/);
  const families = new Set([...css.matchAll(/@font-face\{[^}]*font-family:\s*['"]?([^;'"]+)/g)].map((m) => m[1]));
  assert.deepEqual([...families].sort(), ['Mona Sans', 'Mona Sans Mono', 'Mona Sans SemiCondensed']);
});
