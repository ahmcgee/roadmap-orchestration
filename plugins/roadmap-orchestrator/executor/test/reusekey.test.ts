// The lane input memo (src/git/reusekey.ts, dev.74): a lane's input hash on a tree is remembered under the systems map's
// content, not the map object a `plan-applied` fact carries, so an apply that leaves the map as it was keeps every hash and
// lists no tree again. Every content difference is another scope; the map scopes kept are the two most recently used. Listing
// spawns are counted through a git shim on PATH; a tree of more entries than the kept listings hold evicts every other listing,
// so a memo miss shows as a listing spawn.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Sha, type SystemName, sha } from '../src/core/ids.ts';
import { absPath, repoPattern } from '../src/core/values.ts';
import { LISTING_ENTRIES, inputKnown, inputShaOf } from '../src/git/reusekey.ts';
import { type SystemsMap, systemsMap } from '../src/input/systems.ts';
import { git, makeRepo, tmpDir } from './helpers/repo.ts';

const MAP_JSON = {
  systems: {
    core: { paths: ['src/core/**'] },
    api: { paths: ['src/api/**', 'test/api/**'], dependsOn: ['core'] },
    web: { paths: ['src/web/**'] },
  },
  shared: [{ paths: ['package-lock.json'], dependents: ['api'] }],
  docs: ['docs/**'],
};
const read = (json: unknown): SystemsMap => systemsMap(json, 'systemsMap');
const api = { systems: ['api' as SystemName] };

test('lane inputs are remembered by the map\'s content: equal content shares them, any difference does not, two map scopes are kept', (t) => {
  const repo = absPath(makeRepo(tmpDir('reusekey-content'), { files: {
    'src/core/a.js': 'a', 'src/api/b.js': 'b', 'src/api/c.ts': 'c', 'test/api/b.test.js': 't', 'src/web/w.js': 'w',
    'docs/guide.md': 'g', 'package-lock.json': '{}', 'tools/unmapped.sh': 'u',
  } }));
  const tree = sha(git(repo, 'rev-parse', 'HEAD^{tree}'));
  // A tree of more entries than the kept listings hold: listing it evicts every other tree's listing.
  const blob = git(repo, 'hash-object', '-w', '--stdin').trim();
  const big = sha(execFileSync('git', ['-C', repo, 'mktree'], { input: Array.from({ length: LISTING_ENTRIES + 1 }, (_, i) => `100644 blob ${blob}\tf${i}\n`).join(''), maxBuffer: 64 * 1024 * 1024 }).toString().trim());
  // Each time under a pattern not asked before, so its own input is not remembered and the tree is listed.
  let evictions = 0;
  const evict = () => inputShaOf(repo, big, { inputs: [repoPattern(`f${++evictions}`)] }, null);

  const shims = mkdtempSync(join(tmpdir(), 'roadmap-reusekey-git-'));
  t.after(() => rmSync(shims, { recursive: true, force: true }));
  const log = join(shims, 'spawns.log');
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  writeFileSync(join(shims, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`); chmodSync(join(shims, 'git'), 0o755);
  const path = process.env['PATH'];
  process.env['PATH'] = `${shims}:${path}`;
  t.after(() => { process.env['PATH'] = path; });
  const listingsOf = (tr: Sha): number => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.includes(' ls-tree ') && l.endsWith(tr)).length : 0;
  // `inputShaOf` under `map` after every listing was evicted: its hash, and whether it listed the tree.
  const askCold = (map: SystemsMap, lane: typeof api = api): { sha: Sha; listed: number } => {
    evict();
    const before = listingsOf(tree);
    return { sha: inputShaOf(repo, tree, lane, map), listed: listingsOf(tree) - before };
  };

  const a = read(structuredClone(MAP_JSON));
  const first = askCold(a);
  assert.equal(first.listed, 1, 'the first ask lists the tree');

  // Equal content, another object (a later apply's fact): the same entry, no listing.
  const same = read(structuredClone(MAP_JSON));
  assert.notEqual(same, a);
  assert.equal(inputKnown(tree, api, same), true, 'a map of equal content knows the input');
  assert.deepEqual(askCold(same), { sha: first.sha, listed: 0 });
  // Object key order carries nothing (every lookup is by name, every class a set): the same content.
  const { core, api: apiDef, web } = MAP_JSON.systems;
  const reordered = read({ docs: MAP_JSON.docs, shared: MAP_JSON.shared, systems: { web, api: apiDef, core } });
  assert.deepEqual(askCold(reordered), { sha: first.sha, listed: 0 });

  // Any content difference is another scope: the tree is listed again and the hash computed for that content.
  const variants: [string, unknown, 'differs' | 'equal'][] = [
    ['a system added that claims a path the lane read as unmapped', { ...MAP_JSON, systems: { ...MAP_JSON.systems, tools: { paths: ['tools/**'] } } }, 'differs'],
    ['a glob changed', { ...MAP_JSON, systems: { ...MAP_JSON.systems, web: { paths: ['src/web/**', 'tools/**'] } } }, 'differs'],
    ['a dependency removed', { ...MAP_JSON, systems: { ...MAP_JSON.systems, api: { paths: apiDef.paths } } }, 'differs'],
    ['a shared area\'s dependents changed', { ...MAP_JSON, shared: [{ paths: ['package-lock.json'], dependents: ['web'] }] }, 'differs'],
    // A path no system claims is every lane's input: narrowing a glob leaves it in, under another scope.
    ['a glob narrowed', { ...MAP_JSON, systems: { ...MAP_JSON.systems, api: { ...apiDef, paths: ['src/api/*.js', 'test/api/**'] } } }, 'equal'],
    // Array order never changes a class, but the key is never less discriminating than the content's canonical form.
    ['a glob list reordered', { ...MAP_JSON, systems: { ...MAP_JSON.systems, api: { ...apiDef, paths: ['test/api/**', 'src/api/**'] } } }, 'equal'],
    ['a docs glob added outside the lane', { ...MAP_JSON, docs: ['docs/**', 'notes/**'] }, 'equal'],
  ];
  for (const [what, json, outcome] of variants) {
    const map = read(json);
    assert.equal(inputKnown(tree, api, map), false, `${what}: not known under the earlier content`);
    const got = askCold(map);
    assert.equal(got.listed, 1, `${what}: the tree is listed again`);
    if (outcome === 'differs') assert.notEqual(got.sha, first.sha, `${what}: the input changed`);
    else assert.equal(got.sha, first.sha, `${what}: the same input, computed again`);
  }

  // Another lane definition under the same content is its own entry.
  const withCore = { systems: ['api' as SystemName, 'core' as SystemName] };
  assert.equal(inputKnown(tree, withCore, a), false);
  assert.equal(askCold(a, withCore).listed, 1);

  // Bounded: the two most recently used map scopes are kept; a third content evicts the least recent.
  const b = read({ ...MAP_JSON, docs: ['docs/**', 'b/**'] }), c = read({ ...MAP_JSON, docs: ['docs/**', 'c/**'] });
  askCold(a); askCold(b);
  assert.equal(inputKnown(tree, api, a), true); assert.equal(inputKnown(tree, api, b), true);
  askCold(c);
  assert.equal(inputKnown(tree, api, a), false, 'the least recently used scope is evicted');
  assert.equal(inputKnown(tree, api, b), true); assert.equal(inputKnown(tree, api, c), true);
  assert.deepEqual(askCold(a), { sha: first.sha, listed: 1 }, 'an evicted content is computed again, to the same hash');
  // Explicit patterns are one scope whatever the map, never evicted by map scopes.
  const explicit = { inputs: [repoPattern('src/api/**')] };
  inputShaOf(repo, tree, explicit, a);
  for (const m of [b, c, a, b]) askCold(m);
  assert.equal(inputKnown(tree, explicit, null), true);
  assert.equal(inputKnown(tree, explicit, c), true);
});
