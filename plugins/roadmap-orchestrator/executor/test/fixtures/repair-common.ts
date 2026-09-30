// Shared by the repair and vacuity tests (test/repair.test.ts) and their crash child (repair-child.ts): holistic arcs
// whose findings open, through the findings store, before revision 1 (a repair unit's spec must name a finding the arc
// holds), and the tree ids a mutant's lane will run on (a patch applied to a commit plus files, through a private index),
// so a test scripts the witness lanes' outcomes on them before anything runs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arcId, laneId, obligationId } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { type FindingDraft, keepMutantPatch, openFinding } from '../../src/holistic/findings.ts';
import { git } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import { type HolisticArc, holisticArc } from './brake-common.ts';
import { planCheckStep } from './stage-common.ts';
import { type ArcDescriptor, codexStep, gateStep } from './unit-common.ts';

/** Opens `drafts` in order (F-1, F-2, …) on the laid-out arc, before revision 1. */
export const openBefore = (...drafts: readonly FindingDraft[]) => (d: ArcDescriptor): void => {
  const journal = openJournal(absPath(d.runDir), arcId(d.arc));
  try {
    for (const draft of drafts) {
      const r = openFinding(journal, draft);
      if (r.kind !== 'opened') throw new Error(`the fixture's finding did not open: ${JSON.stringify(r)}`);
    }
  } finally {
    journal.close();
  }
};

/** The mutant: `add` subtracts. It applies to the fixture repo's `src/add.js`. */
export const MUTANT_PATCH = [
  'diff --git a/src/add.js b/src/add.js',
  '--- a/src/add.js',
  '+++ b/src/add.js',
  '@@ -1,3 +1,3 @@',
  ' export function add(a, b) {',
  '-  return a + b;',
  '+  return a - b;',
  ' }',
  '',
].join('\n');
/** A patch whose context `src/add.js` does not have. */
export const STALE_PATCH = MUTANT_PATCH.replace('-  return a + b;', '-  return a * b;');

/** A vacuity finding over I-1 whose mutant runs on the `journey` lane. */
export const vacuityDraft = (runDir: string, patch: string = MUTANT_PATCH): FindingDraft => ({
  lens: 'vacuity', severity: 'P2', obligation: obligationId('I-1'), visionClauses: [], claim: 'I-1\'s witness passes when add subtracts', cause: 'add is never checked',
  evidence: [], mutant: { patchSha256: keepMutantPatch(absPath(runDir), patch), lane: laneId('journey') }, source: { type: 'job', job: 'audit-1' as never }, gateHadPassed: true,
});

/** A witness P1 over `obligation`, as code opens it on an audit snapshot. */
export const witnessDraft = (obligation: string): FindingDraft => ({
  lens: 'witness', severity: 'P1', obligation: obligationId(obligation), visionClauses: [], claim: `${obligation} is not held on the audited head`,
  cause: 'must-hold obligation not held on an audit snapshot', evidence: [], mutant: null, source: { type: 'job', job: 'audit-1' as never }, gateHadPassed: true,
});

/** The strengthened test a vacuity repair's build commits (and its spec lane runs). */
export const STRICT_TEST = {
  'test/strict.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/add.js';\n\ntest('add adds', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
} as const;
export const STRICT_LANE = { id: 'strict', argv: ['node', '--test', 'test/strict.test.js'] } as const;

/** A build committing `files`. */
export const buildOf = (files: Readonly<Record<string, string>>, message = 'strengthen the witness'): Step =>
  codexStep([{ type: 'commit', message, files }], { argv: ['exec', '-C'] });

export const MAPPED = [{ pattern: 'src/**', obligations: ['I-1'] }, { pattern: 'test/**', obligations: ['I-1'] }, { pattern: 'contracts/**', obligations: ['I-1'] }];

/**
 * A holistic arc whose only unit, `v1`, is a vacuity repair of F-1 (origin repair, declaring I-1): plan-check, a build
 * committing the strict test, gate, then `more` steps. Every tree's witness passes t1 unless a test scripts it.
 */
export function vacuityArc(opts: Readonly<{ patch?: string; more?: readonly Step[] }> = {}): HolisticArc {
  return holisticArc({
    steps: [planCheckStep({ decision: 'approve' }), buildOf(STRICT_TEST), gateStep({ decision: 'approve' }), ...(opts.more ?? [])],
    units: [{ id: 'v1', origin: 'repair', repairs: ['F-1'], obligations: ['I-1'], lanes: [STRICT_LANE] }],
    obligations: [{ id: 'I-1', testIds: ['t1'] }],
    mapping: MAPPED,
    trees: { '*': { outcomes: { t1: 'pass' } } },
    beforeStart: (d) => openBefore(vacuityDraft(d.runDir, opts.patch))(d),
  });
}

/** The tree of `base` (a commit) with `files` written and `patch` applied (when given): what a mutant lane runs on. */
export function treeWith(repo: string, base: string, files: Readonly<Record<string, string>>, patch: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-tree-with-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    const run = (args: readonly string[], input?: string): string => {
      const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, ...(input === undefined ? {} : { input }) });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    run(['read-tree', `${base}^{tree}`]);
    for (const [path, text] of Object.entries(files)) run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], text)},${path}`]);
    if (patch !== null) {
      writeFileSync(join(dir, 'm.patch'), patch);
      run(['apply', '--cached', join(dir, 'm.patch')]);
    }
    return run(['write-tree']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The integration tip. */
export const tipOf = (d: ArcDescriptor): string => git(d.repo, 'rev-parse', 'main');
