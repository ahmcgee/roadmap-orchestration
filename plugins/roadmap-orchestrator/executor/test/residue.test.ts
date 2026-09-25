// Integrated tests of the host residue index (src/host/residues.ts) and the failed-cleanup ordering
// (src/recover/residue.ts): real files, the real journal, child processes killed at the residue
// crashPoints (the `resource.transition fail + residue` row of the crash matrix).
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseChainLine, parseEventLine } from '../src/core/events.ts';
import { atomicJson } from '../src/core/fsx.ts';
import { arcId, commandId, invocationId, needsUserId, opId, sha256 } from '../src/core/ids.ts';
import { LogCorruptError, openJournal } from '../src/core/log.ts';
import { type NeedsUserAck, residueRecord } from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { type AbsPath, absPath, isoTimeOf } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { type StartupContext, exitCodeFor } from '../src/preflight/startup.ts';
import { RESIDUES, hostPath, openHostDir } from '../src/host/hostdir.ts';
import {
  readResidues, recordDisposition, recordResidue, residueFragmentName, undispositioned, undispositionedResidueCheck,
} from '../src/host/residues.ts';
import { appendFailedCleanupResidues } from '../src/recover/residue.ts';
import { ARC, FAILED, RECIPES, failIntent, keyOf, residueEntry } from './fixtures/host-records.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { RESIDUE_ORDERING, crashCells } from './matrix.ts';

const CHILD_TIMEOUT_MS = 20_000;
const [DB, QUEUE] = FAILED as [typeof FAILED[0], typeof FAILED[0]];

function hostDir(): AbsPath {
  return openHostDir(absPath(join(tmpDir('residue-host'), 'roadmap')));
}

const indexBytes = (dir: AbsPath): Buffer => readFileSync(hostPath(dir, RESIDUES));
const cleaned = (resource: typeof DB) => ({ type: 'disposition', key: keyOf(resource), disposition: 'cleaned', by: { arc: ARC, inv: invocationId(opId(ARC, 120), 1) } }) as const;

/** The startup row reads only the host dir; the rest of the context is irrelevant to it. */
const contextFor = (dir: AbsPath): StartupContext => ({ hostDir: dir }) as unknown as StartupContext;

describe('residue.blocks-start', () => {
  it('an undisposed residue refuses start (exit 78) until it is cleaned, isolated or transferred', async () => {
    const dir = hostDir();
    assert.deepEqual(await undispositionedResidueCheck.check(contextFor(dir)), [], 'no index is no residue');
    recordResidue(dir, residueEntry(DB));
    recordResidue(dir, residueEntry(QUEUE));
    const rejections = await undispositionedResidueCheck.check(contextFor(dir));
    assert.deepEqual(rejections, [{ kind: 'undispositioned-residue', residues: [keyOf(DB), keyOf(QUEUE)] }]);
    assert.equal(exitCodeFor(rejections[0]!), 78);
    recordDisposition(dir, cleaned(DB));
    assert.deepEqual(undispositioned(dir), [keyOf(QUEUE)]);
    recordDisposition(dir, { type: 'disposition', key: keyOf(QUEUE), disposition: 'isolated', by: { arc: ARC, needsUser: needsUserId('nu-44') } });
    assert.deepEqual(await undispositionedResidueCheck.check(contextFor(dir)), []);
  });

  it('a residue of another arc blocks this arc too: the index is host-wide', async () => {
    const dir = hostDir();
    recordResidue(dir, residueEntry(DB, arcId('arc-old')));
    assert.deepEqual(undispositioned(dir), [keyOf(DB, arcId('arc-old'))]);
  });
});

describe('residue.ack-frees-nothing', () => {
  it('acknowledging the residue needs-user leaves the residue undisposed; ack is not a disposition', () => {
    const dir = hostDir();
    recordResidue(dir, residueEntry(DB));
    const runDir = tmpDir('residue-run');
    const ack: NeedsUserAck = { v: SCHEMA_VERSION, id: needsUserId('nu-44'), command: commandId('cmd-00000000000000aa'), choice: null, at: isoTimeOf(new Date()) };
    atomicJson(join(runDir, 'nu-44.ack.json'), ack);
    assert.deepEqual(undispositioned(dir), [keyOf(DB)]);
    assert.throws(
      () => residueRecord({ type: 'disposition', key: keyOf(DB), disposition: 'ack', by: { arc: ARC, needsUser: 'nu-44' } }, 'residue'),
      SchemaError,
    );
  });
});

describe('residue.per-resource', () => {
  it('a two-resource cleanup with two failures yields two residues, one per resource, and nothing released', async () => {
    const dir = hostDir();
    const runDir = tmpDir('residue-run');
    const exit = await runFixture('host-residue.ts', ['fail', runDir, dir], { env: { PATH: process.env['PATH'] }, timeoutMs: CHILD_TIMEOUT_MS });
    assert.equal(exit.code, 0, exit.stderr);
    assert.deepEqual(undispositioned(dir), [keyOf(DB), keyOf(QUEUE)]);
    assert.deepEqual(readResidues(dir).map((l) => l.type === 'residue' ? { key: l.key, teardown: l.teardown, label: l.label } : null), [
      { key: keyOf(DB), ...RECIPES.get(DB)! },
      { key: keyOf(QUEUE), ...RECIPES.get(QUEUE)! },
    ]);
    assertJournal(runDir, null);
  });

  it('a residue is appended once per key; the same record again is a no-op, a different one throws', () => {
    const dir = hostDir();
    assert.equal(recordResidue(dir, residueEntry(DB)), 'appended');
    assert.equal(recordResidue(dir, residueEntry(DB)), 'present');
    assert.throws(() => recordResidue(dir, { ...residueEntry(DB), label: 'another' }), /already recorded differently/);
    assert.equal(readResidues(dir).length, 1);
  });

  it('a disposition needs a residue and is recorded at most once', () => {
    const dir = hostDir();
    assert.throws(() => recordDisposition(dir, cleaned(DB)), /has no residue/);
    recordResidue(dir, residueEntry(DB));
    assert.equal(recordDisposition(dir, cleaned(DB)), 'appended');
    assert.equal(recordDisposition(dir, cleaned(DB)), 'present');
    assert.throws(
      () => recordDisposition(dir, { type: 'disposition', key: keyOf(DB), disposition: 'transferred', by: { arc: ARC, needsUser: needsUserId('nu-9') } }),
      /already disposed of differently/,
    );
  });

  it('only a fail transition held by a stage records residues, and every failed resource needs a recipe', () => {
    const dir = hostDir();
    const j = openJournal(absPath(tmpDir('residue-run')), ARC);
    const { op } = j.begin(failIntent());
    const intent = j.view.latestIntent(op);
    assert.ok(intent.kind === 'resource.transition');
    assert.throws(() => appendFailedCleanupResidues(dir, intent, new Map([[DB, RECIPES.get(DB)!]])), /no teardown recipe for failed resource queue/);
    const sweep = { ...intent, expect: { ...intent.expect, holder: { type: 'sweep', command: commandId('cmd-00000000000000bb') } } } as const;
    assert.throws(() => appendFailedCleanupResidues(dir, sweep, RECIPES), /held by a sweep/);
    const release = { ...intent, expect: { ...intent.expect, edge: { type: 'release' } } } as const;
    assert.throws(() => appendFailedCleanupResidues(dir, release, RECIPES), /a release transition records no residue/);
    j.close();
  });
});

describe('residue.chain-and-tail', () => {
  it('lines are canonical and chained like the event log', () => {
    const dir = hostDir();
    recordResidue(dir, residueEntry(DB));
    recordDisposition(dir, cleaned(DB));
    const lines = indexBytes(dir).toString('utf8').split('\n');
    assert.equal(lines.pop(), '');
    const parsed = lines.map((l) => parseChainLine(l, residueRecord, 'residue'));
    assert.deepEqual(parsed.map((l) => l.seq), [1, 2]);
    assert.equal(parsed[0]!.prev, null);
    assert.ok(parsed[1]!.prev !== null);
  });

  for (const [what, tail] of [['a torn last line', '{"at":"2026'], ['a zero-filled tail', '\0'.repeat(37)]] as const) {
    it(`${what} is saved to a fragment and truncated; the next append chains to the valid prefix`, () => {
      const dir = hostDir();
      recordResidue(dir, residueEntry(DB));
      const valid = indexBytes(dir);
      appendFileSync(hostPath(dir, RESIDUES), tail);
      assert.equal(readResidues(dir).length, 1);
      assert.ok(indexBytes(dir).equals(valid), 'truncated to the valid prefix');
      const fragments = readdirSync(dir).filter((n) => n.startsWith('residues.torn.'));
      assert.equal(fragments.length, 1);
      assert.match(fragments[0]!, new RegExp(`^residues\\.torn\\.${valid.length}\\.[0-9a-f]{8}$`));
      assert.equal(readFileSync(join(dir, fragments[0]!), 'utf8'), tail);
      recordResidue(dir, residueEntry(QUEUE));
      assert.deepEqual(readResidues(dir).map((l) => l.seq), [1, 2]);
      assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('residues.torn.')), fragments, 'a clean index discards nothing');
    });
  }

  it('an invalid complete line or a broken chain refuses with LogCorruptError at its offset', () => {
    for (const corrupt of ['garbage', 'chain'] as const) {
      const dir = hostDir();
      recordResidue(dir, residueEntry(DB));
      recordResidue(dir, residueEntry(QUEUE));
      const bytes = indexBytes(dir);
      const second = bytes.indexOf(0x0a) + 1;
      const lines = bytes.toString('utf8').split('\n');
      if (corrupt === 'garbage') lines[1] = '{"not":"a residue line"}';
      else lines[1] = lines[1]!.replace(/"prev":"[0-9a-f]{64}"/, `"prev":"${'0'.repeat(64)}"`);
      writeFileSync(hostPath(dir, RESIDUES), lines.join('\n'));
      assert.throws(() => undispositioned(dir), (err: unknown) => {
        assert.ok(err instanceof LogCorruptError, String(err));
        assert.equal(err.offset, second);
        return true;
      }, corrupt);
    }
  });

  it('the fragment name is content-addressed', () => {
    assert.equal(residueFragmentName(12, sha256('0123456789abcdef'.repeat(4))), 'residues.torn.12.01234567');
  });
});

/** The fail transition's journal: one intent, closed by one done with `recoveredBy`; no release intent. */
function assertJournal(runDir: string, recoveredBy: 'reconciled' | null): void {
  const j = openJournal(absPath(runDir), ARC);
  assert.deepEqual(j.view.openIntents(), []);
  j.close();
  const text = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
  const events = text.split('\n').filter((l) => l !== '').map(parseEventLine);
  const intents = events.filter((e) => e.type === 'intent');
  assert.equal(intents.length, 1, `exactly the fail intent: ${text}`);
  const intent = intents[0]!;
  assert.ok(intent.kind === 'resource.transition' && intent.expect.edge.type === 'fail', 'never released');
  const dones = events.filter((e) => e.type === 'done');
  assert.equal(dones.length, 1);
  assert.equal(dones[0]!.recoveredBy, recoveredBy);
}

describe('crash matrix: resource.transition fail + residue', () => {
  // Occurrences each label produces in the two-resource scenario; the next one is shown never to fire.
  const OCCURRENCES: Readonly<Record<string, number>> = { 'residue.before-host-append': 2, 'residue.after-host-append': 1 };

  for (const cell of crashCells(RESIDUE_ORDERING)) {
    const count = OCCURRENCES[cell.label];
    assert.ok(count !== undefined, `occurrence count for ${cell.label}`);
    for (let occurrence = 1; occurrence <= count; occurrence++) {
      it(`${cell.boundary} ${cell.label} #${occurrence}: ${cell.recovery}`, async () => {
        const dir = hostDir();
        const runDir = tmpDir('residue-run');
        const trigger = writeTrigger(tmpDir('trigger'), { label: cell.label, occurrence });
        const env = { PATH: process.env['PATH'], ROADMAP_TEST_CRASH: trigger };
        const crashed = await runFixture('host-residue.ts', ['fail', runDir, dir], { env, timeoutMs: CHILD_TIMEOUT_MS });
        assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
        assertFired(trigger);
        const durable = cell.label === 'residue.after-host-append' ? 2 : occurrence - 1;
        assert.equal(existsSync(hostPath(dir, RESIDUES)) ? readResidues(dir).length : 0, durable, 'residues durable before the crash');

        const recovered = await runFixture('host-residue.ts', ['recover', runDir, dir], { env, timeoutMs: CHILD_TIMEOUT_MS });
        assert.equal(recovered.code, 0, recovered.stderr);
        assert.deepEqual(undispositioned(dir), [keyOf(DB), keyOf(QUEUE)], 'each residue exactly once');
        assert.equal(readResidues(dir).length, 2);
        assertJournal(runDir, 'reconciled');
      });
    }
    it(`${cell.label} fires no more than ${count} times in the scenario`, async () => {
      const dir = hostDir();
      const runDir = tmpDir('residue-run');
      const trigger = writeTrigger(tmpDir('trigger'), { label: cell.label, occurrence: count + 1 });
      const exit = await runFixture('host-residue.ts', ['fail', runDir, dir], { env: { PATH: process.env['PATH'], ROADMAP_TEST_CRASH: trigger }, timeoutMs: CHILD_TIMEOUT_MS });
      assert.equal(exit.code, 0, exit.stderr);
      assert.equal(existsSync(trigger), true, 'still armed');
      assertJournal(runDir, null);
    });
  }
});
