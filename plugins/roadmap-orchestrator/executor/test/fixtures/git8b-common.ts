// Shared by the step-8b git op tests (merge-in, candidate, ff, snapshot) and their crash child
// (git8b-child.ts): deterministic commits built by plumbing (the same SHA in every clone), the product
// repo layout the scenarios start from, a recovery step that also applies abort and recovery-required
// dispositions, and the crash runner for the 8b child.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntentOf, OpKind, RecoveredBy } from '../../src/core/events.ts';
import { type OpId, type Sha, type UnitId, sha, unitId } from '../../src/core/ids.ts';
import type { Disposition, Journal } from '../../src/core/interfaces.ts';
import type { ApprovalFingerprint } from '../../src/core/records.ts';
import { type AbsPath, type RefName, absPath, refName, repoPattern } from '../../src/core/values.ts';
import { type CandidateRequest, candidateRef } from '../../src/git/candidate.ts';
import { commitTree, git as gitRaw, readTree, writeTreeFromIndex } from '../../src/git/git.ts';
import { specRev } from '../../src/core/ids.ts';
import { assertFired, writeTrigger } from '../helpers/crash.ts';
import { runFixture } from '../helpers/proc.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import { ARC, IDENTITY, type OpLike, baseRepo, cloneRepo } from './git-common.ts';

export const UNIT: UnitId = unitId('unit-a');
export const INTEGRATION: RefName = refName('refs/heads/main');
export const UNIT_BRANCH: RefName = refName('refs/heads/unit-a');
export const CANDIDATE_REF: RefName = candidateRef(ARC, UNIT);

/**
 * A commit on `parent` with `files` changed (`null` deletes), made by plumbing with the fixed IDENTITY,
 * so the same inputs give the same SHA in every clone of the base repo.
 */
export function commitOn(repo: AbsPath, parent: Sha, files: Readonly<Record<string, string | null>>, message: string): Sha {
  const tmp = mkdtempSync(join(tmpdir(), 'roadmap-commit-on-'));
  try {
    const indexFile = absPath(join(tmp, 'index'));
    readTree(repo, parent, indexFile);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        gitRaw(repo, ['update-index', '--force-remove', '--', path], { indexFile });
        continue;
      }
      const blob = gitRaw(repo, ['hash-object', '-w', '--stdin'], { input: content }).trim();
      gitRaw(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { indexFile });
    }
    const tree = writeTreeFromIndex(repo, indexFile);
    return commitTree(repo, { tree, parents: [parent], author: IDENTITY.author, committer: IDENTITY.committer, message, gpgsign: false });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const revOf = (repo: string, rev: string): Sha => sha(git(repo, 'rev-parse', '--verify', rev));

/**
 * The scenario repo: a clone of the shared base with
 * - M0 = the base's main;
 * - U = unit-a: M0 + src/a.ts changed (the approved unit commit);
 * - T = main: M0 + docs/readme.md changed (`clean`), or M0 + src/a.ts changed otherwise (`conflict`).
 */
export type Scene = Readonly<{ root: string; repo: AbsPath; runDir: AbsPath; m0: Sha; unit: Sha; tip: Sha }>;

export function scene(base: string, kind: 'clean' | 'conflict'): Scene {
  const root = tmpDir('git8b');
  const repo = cloneRepo(base, join(root, 'repo'));
  const m0 = revOf(repo, 'main');
  const unit = commitOn(repo, m0, { 'src/a.ts': 'export const a = 100;\n' }, 'unit-a: change a\n');
  const tip = kind === 'clean'
    ? commitOn(repo, m0, { 'docs/readme.md': '# readme, integrated\n' }, 'main: docs\n')
    : commitOn(repo, m0, { 'src/a.ts': 'export const a = -1;\n' }, 'main: conflicting a\n');
  git(repo, 'update-ref', UNIT_BRANCH, unit);
  git(repo, 'update-ref', INTEGRATION, tip);
  const runDir = absPath(join(root, 'run'));
  mkdirSync(runDir);
  return { root, repo, runDir, m0, unit, tip };
}

export const sharedBase = (): string => baseRepo(join(tmpDir('git8b-base'), 'base'));

export function candidateRequest(worktree: AbsPath, unitCommit: Sha): CandidateRequest {
  return {
    arc: ARC,
    unit: UNIT,
    integration: INTEGRATION,
    unitCommit,
    worktree,
    rules: { evidenceGlobs: [repoPattern('out/lanes')], scope: [repoPattern('**')] },
    identity: IDENTITY,
    message: `roadmap: candidate ${UNIT}\n`,
  };
}

export const MERGEIN_MESSAGE = 'unit-a: merge integration\n';

export const fingerprintFor = (unitCommit: Sha): ApprovalFingerprint => ({ unitCommit, specRev: specRev(1), contractRevs: [], rulingRevs: [] });

export type Recovery8b =
  | Readonly<{ kind: 'closed'; recoveredBy: Exclude<RecoveredBy, null>; intent: IntentOf<OpKind> }>
  | Readonly<{ kind: 'parked'; detail: string; intent: IntentOf<OpKind> }>
  | Readonly<{ kind: 'aborted'; detail: string; intent: IntentOf<OpKind> }>
  /** Left open: the recovery engine (14b) closes it and raises the needs-user. */
  | Readonly<{ kind: 'recovery-required'; detail: string; intent: IntentOf<OpKind> }>;

/** Recovers the one open intent of `op.kind`, applying each disposition as the recovery engine will. */
export async function recover8b<K extends OpKind, R>(journal: Journal, op: OpLike<K, R>): Promise<Recovery8b> {
  const open = journal.view.openIntents().filter((i) => i.kind === op.kind);
  assert.equal(open.length, 1, `exactly one open ${op.kind} intent`);
  const intent = open[0] as IntentOf<K>;
  const d: Disposition<K> = await op.reconcile(intent, journal.view);
  switch (d.kind) {
    case 'done':
      journal.done(intent.op, op.kind, d.outcome, 'reconciled');
      return { kind: 'closed', recoveredBy: 'reconciled', intent };
    case 'redo':
      await op.act(intent);
      journal.done(intent.op, op.kind, await op.verify(intent), 'redone');
      return { kind: 'closed', recoveredBy: 'redone', intent };
    case 'park':
      return { kind: 'parked', detail: d.detail, intent };
    case 'abort':
      journal.abort(intent.op, 'recovery', d.detail);
      return { kind: 'aborted', detail: d.detail, intent };
    case 'recovery-required':
      return { kind: 'recovery-required', detail: d.detail, intent };
    default:
      throw new Error(`unexpected disposition ${d.kind} for ${op.kind}`);
  }
}

export type Scenario8b =
  | Readonly<{ op: 'mergein'; runDir: string; repo: string; worktree: string }>
  | Readonly<{ op: 'candidate'; runDir: string; repo: string; unitCommit: string; worktree: string }>
  | Readonly<{ op: 'ff'; runDir: string; repo: string; candidate: OpId }>
  | Readonly<{ op: 'snapshot'; runDir: string; repo: string; spec: string }>;

const CHILD_TIMEOUT_MS = 30_000;

/**
 * Runs git8b-child.ts on `scenario` with a crash trigger at (label, occurrence). Returns whether it fired:
 * fired → the child died by SIGKILL and the trigger is consumed; not fired → the child finished cleanly.
 */
export async function crashChild8b(scenario: Scenario8b, label: string, occurrence: number): Promise<boolean> {
  const dir = tmpDir('git8b-crash');
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const trigger = writeTrigger(dir, { label, occurrence });
  const exit = await runFixture('git8b-child.ts', [scenarioPath], {
    env: { PATH: process.env['PATH'], ROADMAP_TEST_CRASH: trigger },
    timeoutMs: CHILD_TIMEOUT_MS,
  });
  if (exit.signal === 'SIGKILL') {
    assertFired(trigger);
    return true;
  }
  assert.equal(exit.code, 0, `git8b-child exited ${exit.code} ${exit.signal}: ${exit.stderr}`);
  assert.equal(existsSync(trigger), true, 'an unfired trigger stays armed');
  return false;
}
