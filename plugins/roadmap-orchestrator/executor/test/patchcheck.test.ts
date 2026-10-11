// A mutant patch's syntax (M4a rev 3, H6, F14): `checkPatch` parses with `git apply --numstat`, never applies, and keeps
// git's stderr as the reason a patch is corrupt. A patch that parses but no longer applies is not corrupt here. M4b:
// `editsPatch` (src/git/mutant.ts), a vacuity mutant's exact edits made a patch by git (mutant.edits-*).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sha } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { editsPatch, patchedTree } from '../src/git/mutant.ts';
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

// The function paid M4b run 3's vacuity lens mutated: the hand-written diff it wrote claimed 7 old lines in a 6-line hunk.
const LEDGER = `import { locked, load, save } from './store.js';

export function book({ vessel, berth, date, window }) {
  return locked(() => {
    const ledger = load();
    const held = ledger.bookings.find((b) => b.berth === berth && b.date === date && b.window === window);
    if (held !== undefined) throw new Error(\`\${berth} is taken\`);
    const booking = { id: \`bk-\${ledger.next}\`, vessel, berth, date, window };
    ledger.next += 1;
    save(ledger);
    return booking;
  });
}
`;

describe('mutant edits (M4b)', () => {
  const repo = absPath(makeRepo(tmpDir('mutant-edits'), { files: { 'src/ledger.js': LEDGER, 'src/b.js': 'export const b = 1;\nexport const c = 1;\n' } }));
  const at = sha(git(repo, 'rev-parse', 'HEAD'));
  const blobOf = (tree: string, path: string): string => git(repo, 'cat-file', 'blob', `${tree}:${path}`);
  const apply = (patch: string) => {
    const file = join(tmpDir('mutant-edits-patch'), 'm.patch');
    writeFileSync(file, patch);
    return patchedTree(repo, at, absPath(file));
  };

  it('mutant.edits-patch: edits across files, in order within one, become a patch git wrote, which parses and applies to the audited tree', () => {
    const made = editsPatch(repo, at, [
      { path: 'src/ledger.js', old: ' && b.date === date', new: '' },
      { path: 'src/b.js', old: 'b = 1', new: 'b = 2' },
      { path: 'src/b.js', old: 'b = 2;\nexport const c = 1', new: 'b = 3;\nexport const c = 1' },
    ]);
    assert.ok(made.kind === 'patch', JSON.stringify(made));
    assert.deepEqual(checkPatch(repo, made.patch), { kind: 'ok' });
    const tree = apply(made.patch);
    assert.ok(tree.kind === 'applied', JSON.stringify(tree));
    assert.equal(blobOf(tree.tree, 'src/ledger.js'), LEDGER.replace(' && b.date === date', '').trim());
    assert.equal(blobOf(tree.tree, 'src/b.js'), 'export const b = 3;\nexport const c = 1;');
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the checkout is untouched');
  });

  it('mutant.edits-refused: an edit is refused, with why, when its old text is absent, repeated or empty, it changes nothing, or its path names no regular file in the repo', () => {
    const refused = (path: string, old: string, n = 'x'): string => {
      const made = editsPatch(repo, at, [{ path, old, new: n }]);
      assert.equal(made.kind, 'refused', JSON.stringify(made));
      return made.kind === 'refused' ? made.reason : '';
    };
    assert.match(refused('src/ledger.js', 'b.date !== date'), /occurs 0 times/);
    assert.match(refused('src/b.js', 'export const'), /occurs 2 times/);
    assert.match(refused('src/b.js', ''), /old is empty/);
    assert.match(refused('src/b.js', 'b = 1', 'b = 1'), /changes nothing/);
    assert.match(refused('src/none.js', 'b'), /no regular file/);
    assert.match(refused('src', 'b'), /no regular file/);
    assert.match(refused('../src/b.js', 'b = 1'), /not relative/);
    assert.match(refused('/src/b.js', 'b = 1'), /not relative/);
    const second = editsPatch(repo, at, [{ path: 'src/b.js', old: 'b = 1', new: 'b = 2' }, { path: 'src/b.js', old: 'b = 1', new: 'b = 3' }]);
    assert.ok(second.kind === 'refused' && /^edit 2 \(src\/b\.js\): old occurs 0 times/.test(second.reason), 'a later edit reads the file as the earlier ones left it');
  });
});
