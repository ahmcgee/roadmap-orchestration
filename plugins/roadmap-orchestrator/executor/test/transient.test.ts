// The transient check, the diff base and the prefix-collision guard (src/git/transient.ts), through
// planCandidate on real git: the plan's merge.transient-refusal and merge.prefix-collision, M3's H15 rules
// (transient.dev5-rules-kept, pinned-scope enforcement) and the G17 docs check.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { repoPath, repoPattern } from '../src/core/values.ts';
import { planCandidate } from '../src/git/candidate.ts';
import { type TransientRules, diffBase, docsTransientViolations, transientViolations, unitDiffPaths } from '../src/git/transient.ts';
import { absPath } from '../src/core/values.ts';
import { type Scene, candidateRequest, commitOn, scene, sharedBase } from './fixtures/git8b-common.ts';
import { git } from './helpers/repo.ts';

let base: string;
before(() => {
  base = sharedBase();
});

const worktree = (s: Scene) => absPath(join(s.root, 'candidate'));

describe('transient check', () => {
  it('merge.transient-refusal: .roadmap/state.json and evidence paths refuse the candidate; .roadmap/contracts/x.md passes', () => {
    const s = scene(base, 'clean');
    const refused = [
      ['.roadmap/state.json', 'roadmap-dir'],
      ['evidence/lane-1/stdout.txt', 'evidence'],
      ['out/lanes/unit.txt', 'evidence'],
    ] as const;
    for (const [path, rule] of refused) {
      const unit = commitOn(s.repo, s.m0, { 'src/d.ts': 'export const d = 4;\n', [path]: 'transient\n' }, `unit touching ${path}\n`);
      const decision = planCandidate(s.repo, candidateRequest(worktree(s), unit));
      assert.equal(decision.kind, 'transient-violation', path);
      if (decision.kind !== 'transient-violation') continue;
      assert.deepEqual(decision.violations, [{ path, rule }]);
      assert.equal(git(s.repo, 'for-each-ref', 'refs/roadmap-run'), '', 'no candidate ref written');
    }
    const ok = commitOn(s.repo, s.m0, { '.roadmap/contracts/x.md': '# contract\n', 'src/d.ts': 'export const d = 4;\n' }, 'unit with a contract\n');
    assert.equal(planCandidate(s.repo, candidateRequest(worktree(s), ok)).kind, 'merge');
  });

  it('refuses every transient rule and passes product and allowlisted paths', () => {
    const rules: TransientRules = { kind: 'dev5', evidenceGlobs: [repoPattern('out/lanes'), repoPattern('**/*.lane.log')] };
    const paths = [
      '.roadmap/config.json', '.roadmap/constraints.md', '.roadmap/contracts/api/v1.md', '.roadmap/debt.md', '.roadmap/invariants.md',
      '.roadmap/notes.md', '.roadmap/runtime/x', '.roadmap-runtime/arc/events.jsonl', 'a/__preview/x.png', 'a/__codex/log',
      'evidence/x', 'inv/12-1/result.json', 'inv/12-1/stdout', 'lib/roadmap-runtime/y', 'out/lanes/a/b', 'src/events.jsonl',
      'src/events.torn.0.abcd1234', 'src/evidence/fine.ts', 'src/result.json', 'src/x.lane.log', 'src/y.ts',
    ].map((p) => repoPath(p));
    assert.deepEqual(transientViolations(rules, paths), [
      { path: '.roadmap-runtime/arc/events.jsonl', rule: 'run-state' },
      { path: '.roadmap/notes.md', rule: 'roadmap-dir' },
      { path: '.roadmap/runtime/x', rule: 'roadmap-dir' },
      { path: 'a/__codex/log', rule: 'run-state' },
      { path: 'a/__preview/x.png', rule: 'run-state' },
      { path: 'evidence/x', rule: 'evidence' },
      { path: 'inv/12-1/result.json', rule: 'executor-file' },
      { path: 'inv/12-1/stdout', rule: 'executor-file' },
      { path: 'lib/roadmap-runtime/y', rule: 'run-state' },
      { path: 'out/lanes/a/b', rule: 'evidence' },
      { path: 'src/events.jsonl', rule: 'executor-file' },
      { path: 'src/events.torn.0.abcd1234', rule: 'executor-file' },
      { path: 'src/x.lane.log', rule: 'evidence' },
    ]);
  });

  it('transient.dev5-rules-kept: a dev.5 dispatch carries an allowlisted .roadmap/ entry and out-of-scope paths; an m3 one is refused both', () => {
    const s = scene(base, 'clean');
    const unit = commitOn(s.repo, s.m0, { '.roadmap/constraints.md': '# constraints\n', 'lib/other.ts': 'export const o = 1;\n', 'src/d.ts': 'export const d = 4;\n' }, 'unit beyond its scope\n');
    const dev5 = candidateRequest(worktree(s), unit);
    assert.equal(dev5.rules.kind, 'dev5');
    assert.equal(planCandidate(s.repo, dev5).kind, 'merge');
    const m3: TransientRules = { kind: 'm3', evidenceGlobs: dev5.rules.evidenceGlobs, scope: [repoPattern('src')] };
    const decision = planCandidate(s.repo, { ...dev5, rules: m3 });
    assert.equal(decision.kind, 'transient-violation');
    if (decision.kind !== 'transient-violation') return;
    assert.deepEqual(decision.violations, [
      { path: '.roadmap/constraints.md', rule: 'roadmap-dir' },
      { path: 'lib/other.ts', rule: 'out-of-scope' },
    ]);
    assert.equal(git(s.repo, 'for-each-ref', 'refs/roadmap-run'), '', 'no candidate ref written');
  });

  it('m3 rules: the pinned scope passes, a path outside it and every .roadmap/ path are refused', () => {
    const s = scene(base, 'clean');
    const rules: TransientRules = { kind: 'm3', evidenceGlobs: [repoPattern('out/lanes')], scope: [repoPattern('src'), repoPattern('docs/**/*.md')] };
    const inScope = commitOn(s.repo, s.m0, { 'src/d.ts': 'export const d = 4;\n', 'docs/guide/x.md': '# x\n' }, 'unit in scope\n');
    assert.equal(planCandidate(s.repo, { ...candidateRequest(worktree(s), inScope), rules }).kind, 'merge');

    const paths = [
      '.roadmap/config.json', '.roadmap/contracts/api/v1.md', '.roadmap/notes.md', 'docs/guide/x.md', 'docs/guide/x.txt',
      'lib/y.ts', 'src/evidence/fine.ts', 'src/y.ts', 'srcx/z.ts',
    ].map((p) => repoPath(p));
    assert.deepEqual(transientViolations(rules, paths), [
      { path: '.roadmap/config.json', rule: 'roadmap-dir' },
      { path: '.roadmap/contracts/api/v1.md', rule: 'roadmap-dir' },
      { path: '.roadmap/notes.md', rule: 'roadmap-dir' },
      { path: 'docs/guide/x.txt', rule: 'out-of-scope' },
      { path: 'lib/y.ts', rule: 'out-of-scope' },
      { path: 'srcx/z.ts', rule: 'out-of-scope' },
    ]);
    // The rules the scope never reached still hold inside it.
    assert.deepEqual(transientViolations(rules, [repoPath('src/inv/3-1/stdout'), repoPath('src/__preview/a.png')]), [
      { path: 'src/__preview/a.png', rule: 'run-state' },
      { path: 'src/inv/3-1/stdout', rule: 'executor-file' },
    ]);

    const outside = commitOn(s.repo, s.m0, { 'src/d.ts': 'export const d = 4;\n', 'lib/y.ts': 'export const y = 1;\n', '.roadmap/contracts/x.md': '# c\n' }, 'unit outside scope\n');
    const decision = planCandidate(s.repo, { ...candidateRequest(worktree(s), outside), rules });
    assert.equal(decision.kind, 'transient-violation');
    if (decision.kind !== 'transient-violation') return;
    assert.deepEqual(decision.violations, [
      { path: '.roadmap/contracts/x.md', rule: 'roadmap-dir' },
      { path: 'lib/y.ts', rule: 'out-of-scope' },
    ]);
  });

  it('the docs check: a docs diff is confined to its rendered .roadmap/ files and contract ops\' paths', () => {
    const allowed = ['.roadmap/constraints.md', '.roadmap/debt.md', '.roadmap/contracts/api.md'].map((p) => repoPath(p));
    assert.deepEqual(docsTransientViolations([repoPath('.roadmap/debt.md'), repoPath('.roadmap/contracts/api.md')], allowed), []);
    assert.deepEqual(docsTransientViolations(['src/a.ts', '.roadmap/debt.md', '.roadmap/contracts/other.md', '.roadmap/invariants.md'].map((p) => repoPath(p)), allowed), [
      { path: '.roadmap/contracts/other.md', rule: 'not-docs' },
      { path: '.roadmap/invariants.md', rule: 'not-docs' },
      { path: 'src/a.ts', rule: 'not-docs' },
    ]);
  });

  it('the diff base is merge-base(T, branch): the unit diff excludes what T changed', () => {
    const s = scene(base, 'clean');
    assert.equal(diffBase(s.repo, s.tip, s.unit), s.m0);
    assert.deepEqual(unitDiffPaths(s.repo, s.tip, s.unit), ['src/a.ts']);
  });
});

describe('prefix-collision guard', () => {
  it('merge.prefix-collision: case-fold-equal and directory-prefix paths refuse the candidate; a collision present at T is grandfathered', () => {
    const s = scene(base, 'clean');
    const cases = [
      [{ 'SRC/A.ts': 'x\n' }, { path: 'SRC/A.ts', existing: 'src/a.ts', kind: 'case-fold-equal' }],
      [{ Src: 'a file where a directory is\n' }, { path: 'Src', existing: 'src/a.ts', kind: 'directory-prefix' }],
      [{ 'docs/README.md/x.md': 'under a file\n' }, { path: 'docs/README.md/x.md', existing: 'docs/readme.md', kind: 'directory-prefix' }],
    ] as const;
    for (const [files, collision] of cases) {
      const unit = commitOn(s.repo, s.m0, files, 'unit adding a colliding path\n');
      const decision = planCandidate(s.repo, candidateRequest(worktree(s), unit));
      assert.equal(decision.kind, 'prefix-collision', collision.path);
      if (decision.kind !== 'prefix-collision') continue;
      assert.deepEqual(decision.collisions, [collision]);
    }

    // T already holds a case-fold collision; a unit that adds an unrelated path and edits one of the pair passes.
    const tip = commitOn(s.repo, s.tip, { 'docs/README.md': '# upper\n' }, 'main: a grandfathered collision\n');
    git(s.repo, 'update-ref', 'refs/heads/main', tip);
    const unit = commitOn(s.repo, tip, { 'src/new.ts': 'export const n = 1;\n', 'docs/README.md': '# upper, edited\n' }, 'unit beside a grandfathered collision\n');
    assert.equal(planCandidate(s.repo, candidateRequest(worktree(s), unit)).kind, 'merge');

    // A case-only rename (the old spelling deleted) collides with nothing.
    const rename = commitOn(s.repo, tip, { 'src/c.ts': null, 'src/C.ts': 'export const c = 3;\n' }, 'unit renaming by case\n');
    assert.equal(planCandidate(s.repo, candidateRequest(worktree(s), rename)).kind, 'merge');
  });
});
