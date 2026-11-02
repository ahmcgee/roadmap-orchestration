import assert from 'node:assert/strict';
import { matchesGlob } from 'node:path';
import { describe, it } from 'node:test';
import { matchesPattern, repoPath, repoPattern } from '../src/core/values.ts';

// The literal-prefix shortcut in matchesPattern must agree with the plain definition on every pair: an exact path, a
// directory prefix, the glob, or the glob as a directory.
const plain = (path: string, pattern: string): boolean => {
  const p = pattern.replace(/\/+$/, '');
  return path === p || path.startsWith(`${p}/`) || matchesGlob(path, p) || matchesGlob(path, `${p}/**`);
};

const PATTERNS = ['a', 'a/', 'a/b', 'a//b', 'a//b/*', '**', '**/c.ts', 'a/**', 'a/**/c.ts', '*.ts', 'a/*.ts', 'a/b*', 'a/b?/c',
  'a/[bc]/c.ts', 'a/{b,x}/c.ts', '{a,x}/b', 'a/!(b)/c.ts', '!(a)/**', 'a/+(b)/c.ts', 'a/@(b|x)/c.ts', 'a\\*b', 'a/b/c.ts/',
  'a/.h/*', '.h', '*', 'a/*/c.ts', 'ab*', 'a*/b'];
const PATHS = ['a', 'a/b', 'a/b/c.ts', 'a/x/c.ts', 'a/bc/c.ts', 'a/b.ts', 'ab', 'abc/b', 'x/b', 'a/.h/z', '.h', '.h/a', 'c.ts',
  'a*b', 'a/b/c.ts/d'];

describe('values.matchesPattern', () => {
  it('agrees with exact, prefix and matchesGlob matching on globs, extglobs, braces, escapes and doubled slashes', () => {
    for (const pattern of PATTERNS) for (const path of PATHS) {
      assert.equal(matchesPattern(repoPath(path), repoPattern(pattern)), plain(path, pattern), `${path} ~ ${pattern}`);
    }
  });
});
