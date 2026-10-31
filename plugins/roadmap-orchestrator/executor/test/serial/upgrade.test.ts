import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChecks, gitCommonDir } from '../../src/preflight/checks.ts';
import { runDir } from '../../src/input/cli.ts';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { setupArc } from '../fixtures/unit-common.ts';
// PREVIOUS_RELEASE is re-pointed to the first post-break release once one exists.
const PREVIOUS_RELEASE = '1.0.0-dev.32';
test('upgrade.previous-schema: startup refuses schema 1 loudly before claiming or recovering', async () => {
  const d = setupArc({steps: []});
  const dir = runDir(gitCommonDir(absPath(d.repo)), arcId(d.arc));
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'start.json'), JSON.stringify({v: 1, release: PREVIOUS_RELEASE}));
  let claimed = false;
  const result = await runChecks({repo: absPath(d.repo), planFile: absPath(d.planPath), profile: 'default', hostDir: absPath(d.hostDir), env: process.env, respawn: null,
    claim: async () => {claimed = true; throw new Error('must refuse before claim');}});
  assert.equal(result.kind, 'refused');
  if (result.kind !== 'refused') throw new Error('schema 1 was adopted');
  assert.equal(claimed, false);
  assert.equal(result.rejections[0]?.kind, 'schema-version');
  assert.match(JSON.stringify(result.rejections), /schema 1.*requires schema 2.*original executor/);
});
