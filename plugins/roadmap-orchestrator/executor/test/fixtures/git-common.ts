// Shared by the git op tests and their crash child (git-child.ts): a stand-in for the pipeline's
// "prepare → intent → act → verify → done" sequence and for the recovery engine's per-op step
// (reconcile → done | redo → act → verify → done | park). The real engine is step 14b; this is the
// minimum that lets each op's crash cells be driven end to end against a real journal.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntentOf, OpKind, OpOutcome, RecoveredBy } from '../../src/core/events.ts';
import { type ArcId, arcId, opKey } from '../../src/core/ids.ts';
import type { Disposition, IntentBody, Journal, JournalView, Reconciler } from '../../src/core/interfaces.ts';
import { type OpenJournal, openJournal } from '../../src/core/log.ts';
import type { Identity } from '../../src/git/git.ts';
import type { SalvageRules } from '../../src/git/salvage.ts';
import { type AbsPath, type RepoPattern, absPath, gitDate, repoPattern } from '../../src/core/values.ts';
import { assertFired, writeTrigger } from '../helpers/crash.ts';
import { runFixture } from '../helpers/proc.ts';
import { git, makeRepo, tmpDir } from '../helpers/repo.ts';

export const ARC: ArcId = arcId('arc-git');

/** Fixed identity and dates: what the pipeline records in the intent, so salvage SHAs are reproducible. */
export const IDENTITY: Identity = {
  author: { name: 'Roadmap Executor', email: 'executor@roadmap.invalid', date: gitDate('1767225600 +0000') },
  committer: { name: 'Roadmap Executor', email: 'executor@roadmap.invalid', date: gitDate('1767225660 +0000') },
};

export function rules(runDir: string, scope: readonly string[] = ['src'], excluded: readonly string[] = ['src/evidence']): SalvageRules {
  return {
    scope: scope.map((s): RepoPattern => repoPattern(s)),
    excluded: excluded.map((s): RepoPattern => repoPattern(s)),
    rejectedRoot: absPath(join(runDir, 'rejected')),
  };
}

export const openArc = (runDir: string): OpenJournal => openJournal(absPath(runDir), ARC);

/** The shape every op here shares (`GitOp` for git kinds, `EvidenceSnapshotOp` for the snapshot). */
export type OpLike<K extends OpKind, R> = Readonly<{
  kind: K;
  prepare(request: R): Promise<IntentBody<K>>;
  act(intent: IntentOf<K>): Promise<void>;
  verify(intent: IntentOf<K>): Promise<OpOutcome[K]>;
  reconcile: Reconciler<K>;
}>;

function latest<K extends OpKind>(view: JournalView, op: IntentOf<K>['op'], kind: K): IntentOf<K> {
  const intent = view.latestIntent(op);
  assert.equal(intent.kind, kind);
  return intent as IntentOf<K>;
}

/** prepare → durable intent → act → verify → done. Returns the intent. */
export async function runOp<K extends OpKind, R>(journal: Journal, op: OpLike<K, R>, key: string, request: R): Promise<IntentOf<K>> {
  const body = await op.prepare(request);
  const { op: id } = journal.begin({ kind: op.kind, key: opKey(key), parent: { type: 'arc' }, deadlineAt: null, body: () => body });
  const intent = latest(journal.view, id, op.kind);
  await op.act(intent);
  journal.done(id, op.kind, await op.verify(intent), null);
  return intent;
}

export type Recovery =
  | Readonly<{ kind: 'closed'; recoveredBy: Exclude<RecoveredBy, null>; intent: IntentOf<OpKind> }>
  | Readonly<{ kind: 'parked'; detail: string; intent: IntentOf<OpKind> }>;

/** Recovers the one open intent of `op.kind`, as the recovery engine will. */
export async function recoverOp<K extends OpKind, R>(journal: Journal, op: OpLike<K, R>): Promise<Recovery> {
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
    default:
      throw new Error(`unexpected disposition ${d.kind} for ${op.kind}`);
  }
}

/** The product repo every git test starts from; clones of it share commit ids. */
export function baseRepo(dir: string): AbsPath {
  makeRepo(dir, {
    files: {
      '.gitignore': '*.log\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'docs/readme.md': '# readme\n',
    },
    commits: [{ message: 'second', files: { 'src/c.ts': 'export const c = 3;\n' } }],
  });
  return absPath(dir);
}

/** A clone of `base` (same commit ids) with a local identity for the tests' own plain-git commits. */
export function cloneRepo(base: string, dir: string): AbsPath {
  git(base, 'clone', '--quiet', base, dir);
  git(dir, 'config', 'user.name', 'Roadmap Test');
  git(dir, 'config', 'user.email', 'roadmap-test@example.invalid');
  return absPath(dir);
}

const CHILD_TIMEOUT_MS = 30_000;

/**
 * Runs git-child.ts on `scenario` with a crash trigger at (label, occurrence). Returns whether it fired:
 * fired → the child died by SIGKILL and the trigger is consumed; not fired → the child finished cleanly.
 */
export async function crashChild(scenario: Readonly<Record<string, unknown>>, label: string, occurrence: number): Promise<boolean> {
  const dir = tmpDir('git-crash');
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const trigger = writeTrigger(dir, { label, occurrence });
  const exit = await runFixture('git-child.ts', [scenarioPath], {
    env: { PATH: process.env['PATH'], ROADMAP_TEST_CRASH: trigger },
    timeoutMs: CHILD_TIMEOUT_MS,
  });
  if (exit.signal === 'SIGKILL') {
    assertFired(trigger);
    return true;
  }
  assert.equal(exit.code, 0, `git-child exited ${exit.code} ${exit.signal}: ${exit.stderr}`);
  assert.equal(existsSync(trigger), true, 'an unfired trigger stays armed');
  return false;
}
