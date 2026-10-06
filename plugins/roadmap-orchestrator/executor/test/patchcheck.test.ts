// A mutant patch's syntax (M4a rev 3, H6, F14): `checkPatch` parses with `git apply --numstat`, never applies, and keeps
// git's stderr as the reason a patch is corrupt. A patch that parses but no longer applies is not corrupt here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { absPath } from '../src/core/values.ts';
import { checkPatch } from '../src/git/patchcheck.ts';
import { git, makeRepo, tmpDir } from './helpers/repo.ts';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 0000000..1111111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
`;

describe('patchcheck', () => {
  const repo = absPath(makeRepo(tmpDir('patchcheck'), { files: { 'src/a.ts': 'export const a = 1;\n' } }));

  it('patchcheck.well-formed-ok: a well-formed patch is ok, and nothing is applied', () => {
    assert.deepEqual(checkPatch(repo, PATCH), { kind: 'ok' });
    assert.equal(readFileSync(join(repo, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(git(repo, 'status', '--porcelain'), '');
  });

  it('patchcheck.inapplicable-not-corrupt: a patch that parses but does not apply is not corrupt', () => {
    assert.deepEqual(checkPatch(repo, PATCH.replace('-export const a = 1;', '-export const a = 9;')), { kind: 'ok' });
  });

  it('patchcheck.corrupt-keeps-stderr: a patch git cannot parse is corrupt, with git\'s reason', () => {
    const truncated = checkPatch(repo, PATCH.replace('@@ -1 +1 @@', '@@ -1,4 +1,4 @@'));
    assert.equal(truncated.kind, 'corrupt');
    assert.match(truncated.kind === 'corrupt' ? truncated.stderr : '', /corrupt patch|patch fragment without header|error/);
    const empty = checkPatch(repo, '');
    assert.ok(empty.kind === 'corrupt' && empty.stderr.length > 0, JSON.stringify(empty));
    const garbage = checkPatch(repo, 'diff --git a/x b/x\n@@ nonsense\n');
    assert.equal(garbage.kind, 'corrupt');
  });
});
