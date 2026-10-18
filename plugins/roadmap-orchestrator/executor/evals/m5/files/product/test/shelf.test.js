import assert from 'node:assert/strict';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/server.js';

let server;
let base;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swapshelf-'));
  const dataPath = join(dir, 'shelf.json');
  await copyFile(new URL('../data/shelf.json', import.meta.url), dataPath);
  server = createApp({ dataPath });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('the shelf page lists every book with its author', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /The Left Hand of Darkness/);
  assert.match(html, /by Robin Wall Kimmerer/);
  assert.match(html, /<link rel="stylesheet" href="\/style.css">/);
});

test('a reserved book says so, without the name', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Like new · on the shelf since 5 October · reserved/);
  assert.doesNotMatch(html, /Priya/);
});

test('the stylesheet is served and an unknown path is a 404 page', async () => {
  const css = await fetch(`${base}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const missing = await fetch(`${base}/nowhere`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Back to the shelf/);
});
