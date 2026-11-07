import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRITERIA } from '../evals/m4a/check.ts';
import { absPath } from '../src/core/values.ts';
import { makeRepo, tmpDir, commitAll, writeFiles } from './helpers/repo.ts';

const grade = CRITERIA.find(([name]) => name === 'config')![1];
const required = { chain: { k: 1 }, systemsMap: { systems: { app: { paths: ['**'] } } } };
const webConsole = { host: '127.0.0.1', port: 49123 };
async function check(config: unknown, systems = ['app']) {
  const repo = makeRepo(tmpDir('console-m4a-config'), { files: { 'seed.txt': 'seed' } });
  writeFiles(repo, { '.roadmap/config.json': JSON.stringify(config) });
  const head = commitAll(repo, 'fixture config');
  // Minimal completed references: the oracle reads config at the recorded head, not the working tree.
  const ref = {
    arc: 'fixture', plan: { units: [{ id: 'u1', systems }] },
    events: [{ type: 'fact', seq: 1, fact: { kind: 'plan-applied' } }, { type: 'fact', seq: 2, fact: { kind: 'arc-completed', head } }],
    view: { holistic: () => ({ completion: { seq: 2, active: true } }) },
  };
  return grade({ product: absPath(repo), one: ref, two: ref } as unknown as Parameters<typeof grade>[0]);
}
test('M4a config accepts only the observation exception, preserving K and system coverage', async () => {
  assert.equal((await check(required)).pass, true);
  assert.equal((await check({ ...required, webConsole })).pass, true);
  assert.equal((await check({ ...required, webConsole, routing: {} })).pass, false);
  assert.equal((await check({ ...required, webConsole, chain: { k: 2 } })).pass, false);
  assert.equal((await check({ chain: { k: 1 }, webConsole })).pass, false);
  assert.equal((await check({ ...required, webConsole }, ['undeclared'])).pass, false);
  await assert.rejects(check({ ...required, webConsole, surprise: true }));
  await assert.rejects(check({ ...required, webConsole: { host: '127.0.0.1', port: 'wrong' } }));
});
