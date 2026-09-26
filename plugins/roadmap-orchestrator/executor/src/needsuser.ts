// Needs-user items (plan "Commands, needs-user", R10): the executor's durable questions to the architect.
//
// Raising one is the `needsuser.raise` op. The record's bytes are decided inside the intent body (the id is
// `nu-<seq>` of the op, so the content depends on it) and staged durably under `needs-user/.staged/` before
// the intent line is appended; the act renames the staged file to `needs-user/<id>.json`. So the intent never
// names content that exists nowhere: recovery finds the final file (its hash must match: done) or the staged
// one (redo the rename). The final file is write-once; an acknowledgement is a separate `<id>.ack.json`
// written by the `ack` command (commands/apply.ts).
//
// The fold records each raise with its `blocking` flag and each acknowledgement, so `openBlocking` (the
// terminal predicate's input) is a pure function of the log.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crashPoint } from './core/crash.ts';
import type { IntentOf, Parent } from './core/events.ts';
import { durableMkdir, durableRename, durableWrite, readJson } from './core/fsx.ts';
import { type NeedsUserId, type Sha256Hex, needsUserIdForOp, opKey, sha256 } from './core/ids.ts';
import type { Journal, JournalView, Reconciler } from './core/interfaces.ts';
import { canonicalJson, sha256Hex } from './core/json.ts';
import { type NeedsUserAck, type NeedsUserRecord, needsUserAck, needsUserRecord, type NeedsUserContent } from './core/records.ts';
import { type AbsPath, absPath, isoTimeOf } from './core/values.ts';
import { SCHEMA_VERSION } from './core/version.ts';

export const NEEDS_USER_DIR = 'needs-user';
const STAGED_DIR = '.staged';

export const needsUserPath = (runDir: AbsPath, id: NeedsUserId): AbsPath => absPath(join(runDir, NEEDS_USER_DIR, `${id}.json`));
export const needsUserAckPath = (runDir: AbsPath, id: NeedsUserId): AbsPath => absPath(join(runDir, NEEDS_USER_DIR, `${id}.ack.json`));
const stagedPath = (runDir: AbsPath, id: NeedsUserId): AbsPath => absPath(join(runDir, NEEDS_USER_DIR, STAGED_DIR, `${id}.json`));

/** The exact bytes of a needs-user file: canonical JSON, as every executor-written record. */
export const needsUserBytes = (record: NeedsUserRecord): string => canonicalJson(record);

const fileSha = (path: AbsPath): Sha256Hex => sha256(sha256Hex(readFileSync(path)));

/**
 * Raises one needs-user item; returns once `needs-user/<id>.json` is durable and the op is done. `parent` is
 * what the item answers for: the stage attempt whose outcome parked or stopped the unit, the op a recovery
 * parked, or the arc. The executor reads it back to raise each such item once (`raisedFor`).
 */
export function raiseNeedsUser(journal: Journal, runDir: AbsPath, content: NeedsUserContent, parent: Parent): NeedsUserId {
  durableMkdir(join(runDir, NEEDS_USER_DIR, STAGED_DIR));
  let id: NeedsUserId | null = null;
  const { op } = journal.begin({
    kind: 'needsuser.raise',
    key: opKey('needs-user'),
    parent,
    deadlineAt: null,
    body: (op) => {
      id = needsUserIdForOp(op);
      const record: NeedsUserRecord = { v: SCHEMA_VERSION, id, arc: journal.view.arc, raisedAt: isoTimeOf(new Date()), ...content };
      const bytes = needsUserBytes(needsUserRecord(JSON.parse(needsUserBytes(record)), 'needs-user'));
      // Staged before the intent is appended, so the intent's hash always names bytes that exist. A body
      // whose intent never became durable leaves a staged `nu-<seq>` that the next intent (same seq)
      // replaces; the final file is the write-once one.
      durableWrite(stagedPath(runDir, id), bytes);
      return { expect: { id, path: needsUserPath(runDir, id), blocking: content.blocking }, post: { sha256: sha256(sha256Hex(bytes)) } };
    },
  });
  if (id === null) throw new Error(`journal.begin opened ${op} without asking for the needs-user body`);
  const intent = journal.view.latestIntent(op) as IntentOf<'needsuser.raise'>;
  publishNeedsUser(runDir, intent);
  journal.done(op, 'needsuser.raise', { kind: 'raised' }, null);
  return id;
}

/** The act (also the reconciler's redo): the staged file becomes the write-once final file. */
export function publishNeedsUser(runDir: AbsPath, intent: IntentOf<'needsuser.raise'>): void {
  const { id, path } = intent.expect;
  const staged = stagedPath(runDir, id);
  if (existsSync(path)) throw new Error(`needs-user ${path} already exists; it is write-once`);
  if (fileSha(staged) !== intent.post.sha256) throw new Error(`staged needs-user ${staged} does not hash to the intent's ${intent.post.sha256}`);
  crashPoint('needsuser.raise.before-publish');
  durableRename(staged, path);
  crashPoint('needsuser.raise.after-publish');
}

/**
 * Recovery of an open raise: the final file hashing to the recorded content is done; absent, the staged
 * file is published (redo: `publishNeedsUser`). Any other state is not ours to repair and throws.
 */
export function needsUserReconciler(runDir: AbsPath): Reconciler<'needsuser.raise'> {
  return async (intent) => {
    const { path, id } = intent.expect;
    if (existsSync(path)) {
      const actual = fileSha(path);
      if (actual !== intent.post.sha256) throw new Error(`needs-user ${path} hashes to ${actual}, not the raised ${intent.post.sha256}`);
      return { kind: 'done', outcome: { kind: 'raised' } };
    }
    if (!existsSync(stagedPath(runDir, id))) throw new Error(`needs-user ${id}: neither ${path} nor its staged file exists after a durable intent`);
    return { kind: 'redo' };
  };
}

/** The needs-user a done raise parented by `parent` recorded, or null when none was raised for it. */
export function raisedFor(view: JournalView, parent: Parent): NeedsUserId | null {
  const key = canonicalJson(parent);
  const raise = view.opsOf('needsuser.raise').find((i) => canonicalJson(i.parent) === key && view.doneOf(i.op) !== null);
  return raise === undefined ? null : raise.expect.id;
}

/** Raised, blocking and not acknowledged: what keeps a parked unit's arc from being terminal-complete. */
export function openBlocking(view: JournalView): readonly NeedsUserId[] {
  return view.needsUser().filter((n) => n.blocking && n.ack === null).map((n) => n.id);
}

/** A needs-user record from its file, or null when absent. Invalid content throws. */
export function readNeedsUser(runDir: AbsPath, id: NeedsUserId): NeedsUserRecord | null {
  const path = needsUserPath(runDir, id);
  return existsSync(path) ? needsUserRecord(readJson(path), `${NEEDS_USER_DIR}/${id}.json`) : null;
}

export function readNeedsUserAck(runDir: AbsPath, id: NeedsUserId): NeedsUserAck | null {
  const path = needsUserAckPath(runDir, id);
  return existsSync(path) ? needsUserAck(readJson(path), `${NEEDS_USER_DIR}/${id}.ack.json`) : null;
}
