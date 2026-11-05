// Reconcilers for open `worktree.create` and `worktree.remove` intents (plan "Recovery").
//
// create: the full postcondition → done. A partial state that is provably this intent's own (the branch,
// if any, still at the recorded start or not yet created; nothing at the path but what `git worktree add`
// itself makes; no other open intent on the path) is cleared with `worktree remove --force` + prune and
// redone. Anything else (a branch that moved, foreign content, a checkout that is dirty beyond files a
// cut-short checkout never wrote) → park, preserving it for the user.
//
// remove: requires the complete evidence manifest the intent names (re-hashed, and matching the done
// snapshot's recorded hash) or parks; no dir → reconcile stale registration, done; a registered entry → redo;
// unregistered leftovers of the journal's own checkout with its evidence → redo; unknown content → park.
// Branches are never deleted by either.
//
// Uses src/git/worktree.ts's pure helpers and git.ts plumbing only; src/recover/ops.ts assembles the op.
import { existsSync, lstatSync, readdirSync, rmdirSync } from 'node:fs';
import type { IntentOf, IntentRecord } from '../core/events.ts';
import { type UnitId, parseOpId } from '../core/ids.ts';
import type { Disposition, JournalView, Reconciler } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { NeedsUserContent } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { readCapturedEvidence } from '../git/evidence.ts';
import { refTarget, statusPorcelainV2Z, worktreeList, worktreePrune, worktreeRemove } from '../git/git.ts';
import { inspectResetTarget, inspectWorktree, standing, worktreeGone } from '../git/worktree.ts';

type Outcome<K extends 'worktree.create' | 'worktree.remove'> = Promise<Extract<Disposition<K>, { kind: 'done' | 'redo' | 'park' }>>;

/** The worktree path an open intent acts in, for the kinds that act in one. */
function worktreeOf(intent: IntentRecord): AbsPath | null {
  switch (intent.kind) {
    case 'worktree.create':
    case 'worktree.remove':
      return intent.expect.path;
    case 'salvage.commit':
    case 'mergein.prepare':
    case 'candidate.merge':
      return intent.expect.worktree;
    default:
      return null;
  }
}

export function reconcileWorktreeCreate(repo: AbsPath): Reconciler<'worktree.create'> {
  return async function reconcile(intent: IntentOf<'worktree.create'>, view: JournalView): Outcome<'worktree.create'> {
    const { path, checkout } = intent.expect;
    const inspection = inspectWorktree(repo, intent.expect);
    if (inspection.kind === 'ready') return { kind: 'done', outcome: { kind: 'created', head: inspection.head } };

    const park = (why: string) => ({ kind: 'park' as const, detail: `worktree.create ${path}: ${inspection.problem}; ${why}` });
    if (intent.expect.reset && existsSync(path)) {
      if (view.openIntents().some((i) => i.op !== intent.op && worktreeOf(i) === path)) return park('a later open intent acts in this path');
      const target = inspectResetTarget(repo, path);
      return target.kind === 'ready' ? { kind: 'redo' } : park(target.problem);
    }
    if (checkout.type === 'branch') {
      const at = refTarget(repo, checkout.branch);
      const ours = at === checkout.at || (at === null && checkout.createBranch);
      if (!ours) return park(`branch ${checkout.branch} is at ${at ?? 'nothing'}, recorded start ${checkout.at}`);
    }
    if (view.openIntents().some((i) => i.op !== intent.op && worktreeOf(i) === path)) {
      return park('a later open intent acts in this path');
    }
    const entry = worktreeList(repo).find((e) => e.path === path);
    const present = existsSync(path);
    if (entry === undefined && present && readdirSync(path).length > 0) return park('content at the path that git does not list as a worktree');
    if (entry !== undefined) {
      const expectedBranch = checkout.type === 'branch' ? checkout.branch : null;
      if (entry.head !== null && entry.head !== checkout.at) return park(`listed worktree HEAD ${entry.head}`);
      if (entry.branch !== null && entry.branch !== expectedBranch) return park(`listed worktree on ${entry.branch}`);
      if (present) {
        // A checkout cut short leaves tracked files unwritten (worktree-side deletions) and nothing else.
        const foreign = statusPorcelainV2Z(path, false).filter((s) => !(s.type === 'changed' && s.x === '.' && s.y === 'D'));
        if (foreign.length > 0) return park(`the listed worktree holds changes (${foreign.map((s) => s.path).join(', ')})`);
      }
      worktreeRemove(repo, path);
    }
    worktreePrune(repo);
    if (existsSync(path)) rmdirSync(path);
    return { kind: 'redo' };
  };
}

export function reconcileWorktreeRemove(repo: AbsPath): Reconciler<'worktree.remove'> {
  return async function reconcile(intent: IntentOf<'worktree.remove'>, view: JournalView): Outcome<'worktree.remove'> {
    const { path, evidence } = intent.expect;
    const park = (why: string) => ({ kind: 'park' as const, detail: `worktree.remove ${path}: ${why}` });
    const captured = readCapturedEvidence(view, evidence);
    if (typeof captured === 'string') return park(`requires a complete evidence manifest: ${captured}`);

    if (!existsSync(path)) {
      // A hand removal may leave git's stale registration; settle that metadata here too.
      if (worktreeList(repo).some((e) => e.path === path)) worktreeRemove(repo, path);
      if (worktreeGone(repo, path)) return { kind: 'done', outcome: { kind: 'removed' } };
    }
    if (worktreeList(repo).some((e) => e.path === path)) return { kind: 'redo' };
    // Git may unregister a worktree even when permission-denied files prevented its directory's removal.
    // Redo only our recorded checkout's leftovers, backed by evidence from this checkout or its stage; unknown paths still park.
    const created = view.opsOf('worktree.create').filter((i) => i.expect.path === path).at(-1);
    const snapshot = view.latestIntent(evidence);
    if (created !== undefined && standing(view, created) && parseOpId(created.op).seq < parseOpId(intent.op).seq
      && snapshot.kind === 'evidence.snapshot' && (snapshot.expect.source === path || canonicalJson(snapshot.parent) === canonicalJson(created.parent))
      && lstatSync(path).isDirectory() && !existsSync(`${path}/.git`)
      && !view.openIntents().some((i) => i.op !== intent.op && worktreeOf(i) === path)) return { kind: 'redo' };
    return park('content at the path that git does not list as a worktree');
  };
}

/** Permission repair concerns one unit; resume reconciles its open checkout intents in-process. */
export function checkoutResidueNeedsUser(unit: UnitId, path: AbsPath, detail: string): NeedsUserContent {
  return {
    blocking: true, subject: { type: 'unit', unit }, reason: 'residue',
    summary: `Unit ${unit} parked on checkout residue at ${path}. ${detail}`,
    recommendation: `Restore ownership and write/search permission, for example sudo chown -R $(id -u):$(id -g) '${path.replaceAll("'", "'\\''")}', or remove the path after reviewing its captured evidence. Then \`roadmap resume ${unit}\` reconciles the open checkout operation and retries the stage without an executor restart.`,
    options: [], evidence: [],
  };
}
