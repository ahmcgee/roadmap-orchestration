// M4b step A2: givens (plan "Givens"). The host file under the git common dir (write-once entries, enforced while the
// fingerprint matches, else stale) and the repo's committed `flow.givens`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { declareHostGiven, givensInForce, givensPath, readHostGivens, repoGivensOf } from '../src/flow/givens.ts';
import { absPath, isoTime } from '../src/core/values.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { tmpDir } from './helpers/repo.ts';

const HERE = { platform: 'linux', arch: 'x64', cpus: 8, memGiB: 16 };
const REBUILT = { ...HERE, cpus: 4 };
const T1 = isoTime('2026-10-08T12:00:00.000Z');
const T2 = isoTime('2026-10-08T13:00:00.000Z');
const common = () => absPath(tmpDir('flow-givens'));

describe('host givens', () => {
  it('the file lives at <common>/roadmap/givens.json; absent reads as none', () => {
    const dir = common();
    assert.equal(givensPath(dir), join(dir, 'roadmap', 'givens.json'));
    assert.deepEqual(readHostGivens(dir), { schema: 'roadmap/flow-givens-m4b', givens: [] });
  });

  it('declarations append G-1, G-2 and keep earlier entries; an equal one returns the existing entry', () => {
    const dir = common();
    const g1 = declareHostGiven(dir, 'concurrency', 'the codespace has 8 cores', HERE, T1);
    const bytes = readFileSync(givensPath(dir), 'utf8');
    assert.deepEqual(declareHostGiven(dir, 'concurrency', 'the codespace has 8 cores', HERE, T2), g1, 'idempotent, its first `at` kept');
    assert.equal(readFileSync(givensPath(dir), 'utf8'), bytes, 'nothing rewritten');
    const g2 = declareHostGiven(dir, 'concurrency', 'the codespace has 8 cores', REBUILT, T2);
    assert.equal(g2.id, 'G-2', 'another fingerprint is another given');
    assert.deepEqual(readHostGivens(dir).givens, [g1, g2]);
    assert.equal(g1.id, 'G-1');
  });

  it('a host given is enforced while its fingerprint matches the host, else stale; repo givens follow, always enforced', () => {
    const dir = common();
    declareHostGiven(dir, 'concurrency', 'n', HERE, T1);
    const repo = repoGivensOf(parseRepoConfig({ flow: { givens: [{ lever: 'suite-lane', note: 'CI owns the suite argv' }] } }));
    assert.deepEqual(givensInForce(readHostGivens(dir), repo, HERE), [
      { scope: 'host', id: 'G-1', lever: 'concurrency', note: 'n', state: 'enforced' },
      { scope: 'repo', lever: 'suite-lane', note: 'CI owns the suite argv' },
    ]);
    assert.deepEqual(givensInForce(readHostGivens(dir), [], REBUILT).map((g) => (g.scope === 'host' ? g.state : null)), ['stale'], 'stale by fingerprint');
  });

  it('repo givens: none without a config or a flow block', () => {
    assert.deepEqual(repoGivensOf(null), []);
    assert.deepEqual(repoGivensOf(parseRepoConfig({ chain: { k: 3 } })), []);
  });
});
