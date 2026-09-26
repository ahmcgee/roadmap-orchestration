// Needs-user items (src/needsuser.ts): the write-once raise through the journal, its reconciler, the fold's
// open/acknowledged view, and durability across a killed executor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, test } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { type ArcId, arcId, commandId, needsUserId, sha256 } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { openJournal } from '../src/core/log.ts';
import { needsUserRecord } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import {
  needsUserPath, needsUserReconciler, openBlocking, publishNeedsUser, raiseNeedsUser, readNeedsUser,
} from '../src/needsuser.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { fixture, runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { NEEDSUSER_RAISE, crashCells } from './matrix.ts';

const T = { timeout: 30_000 };
const newArc = (): ArcId => arcId(`n-${randomBytes(6).toString('hex')}`);

const CONTENT = {
  blocking: true, subject: { type: 'arc' }, reason: 'usage-limit', summary: 'claude is parked', recommendation: 'resume --backend claude', options: [], evidence: [],
} as const;

function raiseIntent(runDir: string, arc: ArcId): IntentOf<'needsuser.raise'> {
  const j = openJournal(absPath(runDir), arc);
  const open = j.view.openIntents();
  j.close();
  assert.equal(open.length, 1);
  assert.equal(open[0]?.kind, 'needsuser.raise');
  return open[0] as IntentOf<'needsuser.raise'>;
}

describe('needs-user', () => {
  it('raises a write-once file whose hash the op records; the fold knows it open and blocking', T, () => {
    const runDir = absPath(tmpDir('nu'));
    const arc = newArc();
    const journal = openJournal(runDir, arc);
    const id = raiseNeedsUser(journal, runDir, CONTENT, { type: 'arc' });
    const other = raiseNeedsUser(journal, runDir, { ...CONTENT, blocking: false }, { type: 'arc' });
    assert.match(id, /^nu-[0-9]+$/);
    const intent = journal.view.opsOf('needsuser.raise')[0];
    assert.ok(intent !== undefined);
    const bytes = readFileSync(needsUserPath(runDir, id));
    assert.equal(sha256(sha256Hex(bytes)), intent.post.sha256);
    assert.deepEqual(intent.expect, { id, path: needsUserPath(runDir, id), blocking: true });
    const record = needsUserRecord(JSON.parse(bytes.toString('utf8')), 'nu');
    assert.deepEqual({ ...record, raisedAt: null }, { v: 2, id, arc, raisedAt: null, ...CONTENT });
    assert.deepEqual(journal.view.needsUser().map((n) => [n.id, n.blocking, n.ack]), [[id, true, null], [other, false, null]]);
    assert.deepEqual(openBlocking(journal.view), [id]);
    // Acknowledged (by the ack command's fact), it no longer blocks; a second acknowledgement is illegal.
    journal.fact({ kind: 'needs-user-acked', id, command: commandId('cmd-0000000000000001'), choice: null });
    assert.deepEqual(openBlocking(journal.view), []);
    assert.throws(() => journal.fact({ kind: 'needs-user-acked', id, command: commandId('cmd-0000000000000002'), choice: null }), /second acknowledgement/);
    assert.deepEqual(readdirSync(join(runDir, 'needs-user', '.staged')), [], 'nothing staged is left behind');
    journal.close();
  });

  it('needsuser.durable-restart: raise, kill the executor, restart: the id is still open and the file matches', T, async () => {
    const runDir = tmpDir('nu-restart');
    const arc = newArc();
    const child = spawn(process.execPath, [fixture('needsuser-child.ts'), runDir, arc], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    const id = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        out += chunk;
        if (out.includes('\n')) resolve(out.trim());
      });
      child.once('exit', (code) => reject(new Error(`the child exited ${code} before raising`)));
    });
    child.kill('SIGKILL');
    assert.equal(await exited, 'SIGKILL');

    const journal = openJournal(absPath(runDir), arc);
    const nu = needsUserId(id);
    assert.deepEqual(openBlocking(journal.view), [nu]);
    const intent = journal.view.opsOf('needsuser.raise')[0];
    assert.ok(intent !== undefined && journal.view.doneOf(intent.op) !== null);
    assert.equal(sha256(sha256Hex(readFileSync(needsUserPath(absPath(runDir), nu)))), intent.post.sha256);
    assert.equal(readNeedsUser(absPath(runDir), nu)?.reason, 'base-red');
    journal.close();
  });
});

describe(`matrix row ${NEEDSUSER_RAISE}`, () => {
  const cells = crashCells(NEEDSUSER_RAISE);
  it('lists the op\'s crash points', () => {
    assert.deepEqual(cells.map((c) => `${c.boundary} ${c.label}`), ['B2 needsuser.raise.before-publish', 'B4 needsuser.raise.after-publish']);
  });

  for (const cell of cells) {
    test(`needsuser crash ${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async () => {
      const runDir = absPath(tmpDir('nu-crash'));
      const arc = newArc();
      const trigger = writeTrigger(tmpDir('nu-trigger'), { label: cell.label, occurrence: 1 });
      const exit = await runFixture('needsuser-child.ts', [runDir, arc], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 20_000 });
      assert.equal(exit.signal, 'SIGKILL', exit.stderr);
      assertFired(trigger);

      const intent = raiseIntent(runDir, arc);
      const published = cell.boundary === 'B4';
      assert.equal(existsSync(intent.expect.path), published);
      const journal = openJournal(runDir, arc);
      const disposition = await needsUserReconciler(runDir)(intent, journal.view);
      if (published) {
        assert.deepEqual(disposition, { kind: 'done', outcome: { kind: 'raised' } });
        journal.done(intent.op, 'needsuser.raise', { kind: 'raised' }, 'reconciled');
      } else {
        assert.deepEqual(disposition, { kind: 'redo' });
        publishNeedsUser(runDir, intent);
        journal.done(intent.op, 'needsuser.raise', { kind: 'raised' }, 'redone');
      }
      assert.equal(sha256(sha256Hex(readFileSync(intent.expect.path))), intent.post.sha256);
      assert.deepEqual(openBlocking(journal.view), [intent.expect.id]);
      // A done raise's file is write-once: publishing again refuses.
      assert.throws(() => publishNeedsUser(runDir, intent), /write-once/);
      journal.close();
    });
  }
});
