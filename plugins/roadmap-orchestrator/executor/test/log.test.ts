// Integrated tests of the journal (src/core/log.ts): real files, real fsync, real child processes killed
// at crashPoints. The plan's named log.* tests, the tail rule including zero-filled tails, and the
// journal rows of the crash matrix (test/matrix.ts).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { type Event, type LogRecord, parseEventLine } from '../src/core/events.ts';
import { commandId, opKey, sha256 } from '../src/core/ids.ts';
import type { IntentBody } from '../src/core/interfaces.ts';
import { EVENTS_FILE, LogCorruptError, type OpenJournal, STATE_FILE, fragmentName, openJournal, readJournal } from '../src/core/log.ts';
import { FoldInvariantError } from '../src/core/state.ts';
import { sha256Hex } from '../src/core/json.ts';
import { absPath } from '../src/core/values.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import {
  ARC, DEADLINE, H, REV, U1, chain, commandIntent, inv1, logBytes, meter, spawnIntent, spawnResult, stageParent,
} from './fixtures/log-records.ts';
import { JOURNAL_APPEND, JOURNAL_TAIL, crashCells } from './matrix.ts';

const CHILD_TIMEOUT_MS = 20_000;

const open = (dir: string): OpenJournal => openJournal(absPath(dir), ARC);
const eventsPath = (dir: string): string => join(dir, EVENTS_FILE);
const readLog = (dir: string): Buffer => readFileSync(eventsPath(dir));
const bytesLength = (dir: string): number => readLog(dir).length;
const fragments = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith('events.torn.')).sort();

/** Parsed events of a log file that must be entirely complete lines. */
function events(dir: string): Event[] {
  const text = readLog(dir).toString('utf8');
  assert.ok(text === '' || text.endsWith('\n'), 'log ends with a newline');
  return text.split('\n').slice(0, -1).map(parseEventLine);
}

/** Byte offset of the start of every line. */
function lineStarts(bytes: Buffer): number[] {
  const out: number[] = [];
  for (let start = 0; start < bytes.length; start = bytes.indexOf(0x0a, start) + 1) out.push(start);
  return out;
}

function commandBody(): IntentBody<'command.apply'> {
  return { expect: { command: commandId('cmd-0123456789abcdef'), commandSha256: H }, post: null };
}

/** Writes `pairs` command intents with their done through the journal: 2 × pairs lines. */
function populate(dir: string, pairs: number): Buffer {
  const j = open(dir);
  for (let i = 0; i < pairs; i++) {
    const { op } = j.begin({ kind: 'command.apply', key: opKey(`command:${i}`), parent: { type: 'arc' }, deadlineAt: null, body: commandBody });
    j.done(op, 'command.apply', { kind: 'rejected', reason: `reason ${'x'.repeat(i * 7)}` }, null);
  }
  j.close();
  return readLog(dir);
}

function assertCorrupt(dir: string, offset: number | readonly number[], detail?: RegExp): LogCorruptError {
  let caught: LogCorruptError | undefined;
  assert.throws(() => open(dir), (err: unknown) => {
    assert.ok(err instanceof LogCorruptError, `expected LogCorruptError, got ${String(err)}`);
    caught = err;
    return true;
  });
  const e = caught!;
  assert.equal(e.file, eventsPath(dir));
  if (typeof offset === 'number') assert.equal(e.offset, offset, e.message);
  else assert.ok(offset.includes(e.offset), `offset ${e.offset} not in ${offset.join(', ')}: ${e.message}`);
  if (detail !== undefined) assert.match(e.detail, detail);
  return e;
}

/** A torn-tail open: prefix kept, fragment saved, one fact appended; a second open changes nothing. */
function assertTailRepaired(dir: string, original: Buffer, validEnd: number, fragment: Buffer): void {
  const after = readLog(dir);
  assert.ok(after.subarray(0, validEnd).equals(original.subarray(0, validEnd)), 'the valid prefix is untouched');
  const all = events(dir);
  const last = all[all.length - 1]!;
  assert.equal(all.length, lineStarts(original.subarray(0, validEnd)).length + 1, 'exactly one line was added');
  const digest = sha256(sha256Hex(fragment));
  assert.deepEqual(last.type === 'fact' ? last.fact : null, { kind: 'tail-discarded', offset: validEnd, length: fragment.length, sha256: digest });
  assert.deepEqual(fragments(dir), [fragmentName(validEnd, digest)]);
  assert.ok(readFileSync(join(dir, fragmentName(validEnd, digest))).equals(fragment), 'the fragment holds the discarded bytes');
  open(dir).close();
  assert.ok(readLog(dir).equals(after), 'a second open is idempotent');
  assert.deepEqual(fragments(dir), [fragmentName(validEnd, digest)]);
}

function childEnv(trigger: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['ROADMAP_TEST_CRASH'];
  if (trigger !== undefined) env['ROADMAP_TEST_CRASH'] = trigger;
  return env;
}

async function runChild(args: readonly string[], trigger: string | undefined): Promise<void> {
  const exit = await runFixture('log-child.ts', args, { env: childEnv(trigger), timeoutMs: CHILD_TIMEOUT_MS });
  if (trigger === undefined) {
    assert.equal(exit.code, 0, exit.stderr);
  } else {
    assert.equal(exit.signal, 'SIGKILL', `child was expected to crash: code ${exit.code}, stderr ${exit.stderr}`);
    assertFired(trigger);
  }
}

describe('journal append', () => {
  it('allocates ops from seq, chains lines, and caches state.json', () => {
    const dir = tmpDir('log');
    const j = open(dir);
    const a = j.begin({ kind: 'proc.spawn', key: opKey('spawn:a'), parent: stageParent('build', 1), deadlineAt: DEADLINE, body: (op, inv) => {
      assert.equal(inv, `${op}#1`);
      return { expect: spawnIntent(1).expect as IntentBody<'proc.spawn'>['expect'], post: null };
    } });
    assert.deepEqual(a, { op: 'arc-1/1', inv: 'arc-1/1#1', seq: 1 });
    assert.equal(j.fact({ kind: 'meter', inv: a.inv, role: 'build', tier: 'med', routingRev: REV, unit: { unit: U1, attempt: 1 }, usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: null, cacheWriteTokens: null } }), 2);
    assert.equal(j.done(a.op, 'proc.spawn', { kind: 'lost', treeEffects: false }, 'reconciled'), 3);
    assert.equal(j.view.highWater(), 3);
    assert.deepEqual(j.view.openIntents(), []);
    j.close();

    const logged = events(dir);
    assert.deepEqual(logged.map((e) => e.seq), [1, 2, 3]);
    // Folding the file from scratch gives what the live journal held, and state.json caches exactly that.
    const reopened = open(dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')), JSON.parse(JSON.stringify(reopened.derived())));
    assert.equal(reopened.derived().meter[0]?.inputTokens, 3);
    reopened.close();
  });

  it('refuses a re-entrant append from an intent body, writing nothing', () => {
    const dir = tmpDir('log');
    const j = open(dir);
    assert.throws(() => j.begin({ kind: 'command.apply', key: opKey('c'), parent: { type: 'arc' }, deadlineAt: null, body: () => {
      j.fact({ kind: 'containment-mode', mode: 'session' });
      return commandBody();
    } }), /re-entrant append/);
    j.close();
    assert.equal(readLog(dir).length, 0);
  });

  it('log.one-open-intent-per-key', () => {
    const dir = tmpDir('log');
    const j = open(dir);
    const intent = { kind: 'command.apply', key: opKey('command:k'), parent: { type: 'arc' }, deadlineAt: null, body: commandBody } as const;
    const first = j.begin(intent);
    const before = readLog(dir);
    assert.throws(() => j.begin(intent), (err: unknown) => err instanceof FoldInvariantError && /key command:k already has open intent arc-1\/1/.test(err.detail));
    assert.ok(readLog(dir).equals(before), 'the refused intent was never written');
    j.done(first.op, 'command.apply', { kind: 'rejected', reason: 'r' }, null);
    assert.equal(j.begin(intent).seq, 3, 'the key is free once the first intent is closed');
    j.close();
    open(dir).close();

    // A log that already holds two open intents on one key is refused at the second.
    const raw = tmpDir('log');
    const bytes = logBytes(chain([commandIntent(1, 'k'), commandIntent(2, 'k')]));
    writeFileSync(eventsPath(raw), bytes);
    assertCorrupt(raw, lineStarts(bytes)[1]!, /key k already has open intent/);
  });

  it('log.deadline-inherits', () => {
    const dir = tmpDir('log');
    const j = open(dir);
    const parent = stageParent('build', 2);
    const expect = spawnIntent(1).expect as IntentBody<'proc.spawn'>['expect'];
    const first = j.begin({ kind: 'proc.spawn', key: opKey('spawn:u1'), parent, deadlineAt: DEADLINE, body: () => ({ expect, post: null }) });
    assert.throws(() => j.retry(first.op, 'proc.spawn', () => ({ expect, post: null })), /while ordinal 1 is open/);
    j.done(first.op, 'proc.spawn', { kind: 'lost', treeEffects: true }, 'reconciled');
    const second = j.retry(first.op, 'proc.spawn', (inv) => {
      assert.equal(inv, `${first.op}#2`);
      return { expect, post: null };
    });
    assert.deepEqual(second, { op: first.op, inv: `${first.op}#2`, seq: 3 });
    const retried = j.view.latestIntent(first.op);
    assert.equal(retried.ordinal, 2);
    assert.equal(retried.deadlineAt, DEADLINE);
    assert.equal(retried.key, 'spawn:u1');
    assert.deepEqual(retried.parent, parent);
    j.close();
    const logged = events(dir)[2]!;
    assert.ok(logged.type === 'intent' && logged.deadlineAt === DEADLINE, 'the deadline is in the log, not only in memory');

    // A retry line carrying another deadline is refused at open.
    const raw = tmpDir('log');
    const bytes = logBytes(chain([spawnIntent(1), { type: 'done', op: first.op, kind: 'proc.spawn', outcome: { kind: 'lost', treeEffects: false }, recoveredBy: 'reconciled' }, spawnIntent(1, { ordinal: 2, deadlineAt: null })]));
    writeFileSync(eventsPath(raw), bytes);
    assertCorrupt(raw, lineStarts(bytes)[2]!, /changes deadlineAt/);
  });
});

describe('journal open', () => {
  it('log.seq-gap', () => {
    const records: LogRecord[] = [commandIntent(1, 'a'), commandIntent(2, 'b'), commandIntent(3, 'c')];
    const good = chain(records);
    // Re-chain after the gap so the only fault is the seq.
    const gapped: Event[] = [good[0]!, { ...good[1]!, seq: 3 }];
    const bytes = logBytes([...gapped]);
    const dir = tmpDir('log');
    writeFileSync(eventsPath(dir), bytes);
    const e = assertCorrupt(dir, lineStarts(bytes)[1]!, /seq not contiguous: expected 2/);
    assert.match(e.message, /is corrupt at byte \d+/);

    // A broken chain is refused the same way.
    const broken = logBytes([good[0]!, { ...good[1]!, prev: H }, good[2]!]);
    const dir2 = tmpDir('log');
    writeFileSync(eventsPath(dir2), broken);
    assertCorrupt(dir2, lineStarts(broken)[1]!, /chain broken/);
  });

  it('log.mid-corruption-refuses', () => {
    const dir = tmpDir('log');
    const original = populate(dir, 3);
    const starts = lineStarts(original);
    const mid = 2;
    const from = starts[mid]!;
    const to = starts[mid + 1]! - 1; // the middle line's bytes, excluding its \n
    // Any single changed byte in a middle line is refused, never discarded: at that line, or (when the
    // change still parses, e.g. inside a hash) at the next line, whose chain no longer matches.
    for (let at = from; at < to; at++) {
      const bad = Buffer.from(original);
      bad[at] = bad[at] === 0x78 ? 0x79 : 0x78;
      writeFileSync(eventsPath(dir), bad);
      assertCorrupt(dir, [from, starts[mid + 1]!]);
      assert.ok(readLog(dir).equals(bad), 'a refused log is left exactly as found');
      assert.deepEqual(fragments(dir), [], 'nothing was discarded');
    }
    const bad = Buffer.from(original);
    bad[from] = 0x78;
    writeFileSync(eventsPath(dir), bad);
    assertCorrupt(dir, from, /JSON/);
  });

  it('log.torn-every-offset', () => {
    const source = tmpDir('log');
    const original = populate(source, 3);
    const lastStart = lineStarts(original).at(-1)!;
    for (let cut = lastStart; cut < original.length; cut++) {
      const dir = tmpDir('log');
      writeFileSync(eventsPath(dir), original.subarray(0, cut));
      open(dir).close();
      if (cut === lastStart) {
        assert.ok(readLog(dir).equals(original.subarray(0, lastStart)), 'a log ending in \\n is untouched');
        assert.deepEqual(fragments(dir), []);
        continue;
      }
      assertTailRepaired(dir, original, lastStart, original.subarray(lastStart, cut));
    }
  });

  it('discards an all-NUL tail, after a complete line or after a torn one', () => {
    const source = tmpDir('log');
    const original = populate(source, 2);
    const lastStart = lineStarts(original).at(-1)!;
    const zeros = Buffer.alloc(4096);

    const afterComplete = tmpDir('log');
    writeFileSync(eventsPath(afterComplete), Buffer.concat([original, zeros]));
    open(afterComplete).close();
    assertTailRepaired(afterComplete, Buffer.concat([original, zeros]), original.length, zeros);

    const afterTorn = tmpDir('log');
    const torn = Buffer.concat([original.subarray(0, lastStart + 20), zeros]);
    writeFileSync(eventsPath(afterTorn), torn);
    open(afterTorn).close();
    assertTailRepaired(afterTorn, torn, lastStart, torn.subarray(lastStart));

    // A complete line of NULs is not a tail: it is corruption.
    const nulLine = tmpDir('log');
    writeFileSync(eventsPath(nulLine), Buffer.concat([original, zeros, Buffer.from('\n')]));
    assertCorrupt(nulLine, original.length);
  });

  it('refuses a fragment whose content does not match its name', () => {
    const dir = tmpDir('log');
    populate(dir, 1);
    writeFileSync(join(dir, 'events.torn.12.0000abcd'), 'not these bytes');
    assert.throws(() => open(dir), (err: unknown) => err instanceof LogCorruptError && err.file === join(dir, 'events.torn.12.0000abcd') && err.offset === 12);
  });

  it('opens a log in time linear in its length: 10x the lines costs under 15x the CPU', (t) => {
    const records: LogRecord[] = [];
    for (let seq = 1; records.length < 100_000; seq += 3) {
      records.push(spawnIntent(seq), meter(inv1(seq), 'build', seq, 1, null), spawnResult(spawnIntent(seq).op));
    }
    const small = tmpDir('log');
    const large = tmpDir('log');
    writeFileSync(eventsPath(small), logBytes(chain(records.slice(0, 10_000))));
    writeFileSync(eventsPath(large), logBytes(chain(records.slice(0, 100_000))));
    // The main thread's CPU time (user + system) of the synchronous open, not wall time: the full suite
    // runs test files concurrently, and wall time would measure the host's load. Absolute CPU time stretches
    // too (the 100k-line open: about 1.6 s idle, 10 to 11.5 s seen under the full suite on a loaded host),
    // so no absolute bound is both tight and stable. Instead the test compares two sizes opened in the same
    // process under the same load: a linear open costs about 10x for 10x the lines, a quadratic one tends
    // to 100x. Measured ratios: 9.7 to 10.2 idle, 9.6 to 9.7 under the full suite's load; a simulated
    // quadratic term (a linear scan of the offsets seen so far, per line) measured 23.7. The bound of 15
    // leaves half again the worst linear ratio seen and fails that small quadratic term. Each size is opened
    // twice, alternating, and the cheaper open counts, which damps a GC pause or a descheduling landing in
    // one measurement. The 30 s ceiling on the large open is a backstop for a catastrophic regression that
    // the ratio alone would miss (both sizes equally slow per line).
    const openCpuMs = (dir: string, lines: number): { cpuMs: number; wallMs: number } => {
      const started = process.threadCpuUsage();
      const wallStarted = performance.now();
      const j = open(dir);
      const { user, system } = process.threadCpuUsage(started);
      const wallMs = performance.now() - wallStarted;
      assert.equal(j.view.highWater(), lines);
      j.close();
      return { cpuMs: (user + system) / 1000, wallMs };
    };
    const smallRuns: { cpuMs: number; wallMs: number }[] = [];
    const largeRuns: { cpuMs: number; wallMs: number }[] = [];
    for (let i = 0; i < 2; i++) {
      smallRuns.push(openCpuMs(small, 10_000));
      largeRuns.push(openCpuMs(large, 100_000));
    }
    const smallMs = Math.min(...smallRuns.map((r) => r.cpuMs));
    const largeMs = Math.min(...largeRuns.map((r) => r.cpuMs));
    const ratio = largeMs / smallMs;
    const fmt = (runs: { cpuMs: number; wallMs: number }[]): string => runs.map((r) => `${Math.round(r.cpuMs)} ms CPU (${Math.round(r.wallMs)} ms wall)`).join(', ');
    t.diagnostic(`open of ${bytesLength(small)} bytes: ${fmt(smallRuns)}; open of ${bytesLength(large)} bytes: ${fmt(largeRuns)}; ratio ${ratio.toFixed(1)}`);
    assert.ok(ratio < 15, `opening 10x the lines cost ${ratio.toFixed(1)}x the CPU (${Math.round(largeMs)} ms vs ${Math.round(smallMs)} ms; linear is about 10x, the bound 15x): the open no longer scales linearly`);
    assert.ok(largeMs < 30_000, `the 100k-line open used ${Math.round(largeMs)} ms of CPU time (backstop 30000 ms; about 1600 ms idle)`);
  });
});

describe('journal read-only', () => {
  it('log.readonly-tolerates-inflight-append', async (t) => {
    const dir = tmpDir('log');
    open(dir).close();
    const appendMs = 4_000;
    const readMs = 3_000;
    const child = runFixture('log-child.ts', ['append-for', dir, ARC, String(appendMs)], { env: childEnv(undefined), timeoutMs: CHILD_TIMEOUT_MS });
    // What each read returned: its high-water mark and its last event, checked against the final log below.
    const seen: { highWater: number; last: Event | undefined }[] = [];
    let inFlight = 0;
    const until = Date.now() + readMs;
    while (Date.now() < until) {
      const { view, events: got } = readJournal(absPath(dir), ARC);
      got.forEach((e, i) => assert.equal(e.seq, i + 1, 'a snapshot is contiguous from seq 1'));
      assert.equal(view.highWater(), got.length);
      assert.ok(view.highWater() >= (seen.at(-1)?.highWater ?? 0), 'the folded seq never decreases');
      seen.push({ highWater: view.highWater(), last: got.at(-1) });
      if (!readLog(dir).toString('latin1').endsWith('\n')) inFlight++;
      await yieldToLoop();
    }
    const exit = await child;
    assert.equal(exit.code, 0, exit.stderr);
    assert.deepEqual(fragments(dir), [], 'a read-only reader saves no fragment');
    const final = events(dir);
    for (const { highWater, last } of seen) assert.deepEqual(last, final[highWater - 1], `the snapshot at seq ${highWater} is a prefix of the final log`);
    t.diagnostic(`${seen.length} reads, up to seq ${seen.at(-1)?.highWater}; ${inFlight} separate raw reads found an append in flight; final seq ${final.length}`);
    assert.ok(seen.at(-1)!.highWater > 0, 'the reads saw the child append');
    assert.ok(inFlight > 0, 'the reads overlapped appends in flight, so the race was exercised');
  });

  it('log.readonly-refuses-corrupt-complete-line', () => {
    const dir = tmpDir('log');
    const original = populate(dir, 2);
    const starts = lineStarts(original);
    const bad = Buffer.from(original);
    bad[starts[1]!] = 0x78;
    const torn = Buffer.from('{"arc":"arc-1","at":"2026');
    writeFileSync(eventsPath(dir), Buffer.concat([bad, torn]));
    const before = readLog(dir);
    assert.throws(() => readJournal(absPath(dir), ARC), (err: unknown) => {
      assert.ok(err instanceof LogCorruptError, `expected LogCorruptError, got ${String(err)}`);
      assert.equal(err.file, eventsPath(dir));
      assert.equal(err.offset, starts[1]);
      return true;
    });
    assert.ok(readLog(dir).equals(before), 'a refused read leaves the log exactly as found');
    assert.deepEqual(fragments(dir), []);

    // The same log without the bad line: the unterminated suffix is left out and left in place.
    writeFileSync(eventsPath(dir), Buffer.concat([original, torn]));
    const { view, events: got } = readJournal(absPath(dir), ARC);
    assert.equal(view.highWater(), starts.length);
    assert.equal(got.length, starts.length);
    assert.ok(readLog(dir).equals(Buffer.concat([original, torn])), 'not truncated');
    assert.deepEqual(fragments(dir), [], 'no fragment saved');
  });
});

describe('journal crashes', () => {
  it('log.short-write-no-act', async () => {
    const dir = tmpDir('log');
    const acts = join(dir, 'acts');
    const trigger = writeTrigger(tmpDir('log-trigger'), { label: 'log.append.after-partial-write', occurrence: 1 });
    await runChild(['append3', dir, ARC, acts], trigger);
    assert.equal(existsSync(acts), false, 'the caller never acted on the torn intent');
    const torn = readLog(dir);
    assert.ok(torn.length > 0 && !torn.includes(0x0a), 'the log holds a torn first line');

    const j = open(dir);
    assert.deepEqual(j.view.openIntents(), [], 'the torn intent never began');
    j.close();
    assertTailRepaired(dir, torn, 0, torn);
  });

  it('log.fragment-without-fact', async () => {
    const dir = tmpDir('log');
    const original = populate(dir, 2);
    const cut = original.length - 10;
    writeFileSync(eventsPath(dir), original.subarray(0, cut));
    const lastStart = lineStarts(original).at(-1)!;
    const trigger = writeTrigger(tmpDir('log-trigger'), { label: 'log.open.after-truncate', occurrence: 1 });
    await runChild(['open', dir, ARC], trigger);
    // Truncated and saved, but the crash came before the fact.
    assert.ok(readLog(dir).equals(original.subarray(0, lastStart)));
    assert.equal(fragments(dir).length, 1);
    assert.equal(events(dir).some((e) => e.type === 'fact'), false);

    open(dir).close();
    assertTailRepaired(dir, original.subarray(0, cut), lastStart, original.subarray(lastStart, cut));
  });

  describe('matrix: journal.append', () => {
    const OCCURRENCES = [1, 2, 3];
    // Allowed recovery per label, crashing on the n-th append: how many records survive, whether a tail
    // was discarded, and how many acts the caller made (always n - 1: never an act for the n-th append).
    const ORACLE: Record<string, (n: number) => { records: number; discarded: boolean }> = {
      'log.append.before-write': (n) => ({ records: n - 1, discarded: false }),
      'log.append.after-partial-write': (n) => ({ records: n - 1, discarded: true }),
      'log.append.after-fsync': (n) => ({ records: n, discarded: false }),
    };
    const cells = crashCells(JOURNAL_APPEND);
    it('the oracle covers exactly the matrix cells', () => {
      assert.deepEqual(cells.map((c) => c.label).sort(), Object.keys(ORACLE).sort());
    });
    for (const cell of cells) {
      for (const n of OCCURRENCES) {
        it(`${cell.boundary} ${cell.label} #${n}`, async () => {
          const dir = tmpDir('log');
          const acts = join(dir, 'acts');
          await runChild(['append3', dir, ARC, acts], writeTrigger(tmpDir('log-trigger'), { label: cell.label, occurrence: n }));
          const actLines = existsSync(acts) ? readFileSync(acts, 'utf8').split('\n').filter((l) => l !== '') : [];
          assert.deepEqual(actLines, Array.from({ length: n - 1 }, (_, i) => `act ${i + 1}`));

          const expected = ORACLE[cell.label]!(n);
          const j = open(dir);
          const derived = j.derived();
          j.close();
          assert.equal(derived.lastSeq, expected.records + (expected.discarded ? 1 : 0));
          assert.equal(derived.tailDiscarded.length, expected.discarded ? 1 : 0);
          assert.equal(fragments(dir).length, expected.discarded ? 1 : 0);
          const types = events(dir).slice(0, expected.records).map((e) => e.type);
          assert.deepEqual(types, ['intent', 'done', 'fact'].slice(0, expected.records));
          // The recovered log is stable.
          const settled = readLog(dir);
          open(dir).close();
          assert.ok(readLog(dir).equals(settled));
        });
      }
    }
  });

  describe('matrix: journal.tail-repair', () => {
    const cells = crashCells(JOURNAL_TAIL);
    it('covers both repair steps', () => {
      assert.deepEqual(cells.map((c) => c.label).sort(), ['log.open.after-fragment-save', 'log.open.after-truncate']);
    });
    for (const cell of cells) {
      it(`${cell.boundary} ${cell.label} #1`, async () => {
        const dir = tmpDir('log');
        const original = populate(dir, 2);
        const lastStart = lineStarts(original).at(-1)!;
        const torn = original.subarray(0, lastStart + 15);
        writeFileSync(eventsPath(dir), torn);
        await runChild(['open', dir, ARC], writeTrigger(tmpDir('log-trigger'), { label: cell.label, occurrence: 1 }));
        assert.equal(fragments(dir).length, 1, 'the fragment was saved before the crash');
        open(dir).close();
        assertTailRepaired(dir, torn, lastStart, torn.subarray(lastStart));
      });
    }
  });

  it('a clean child run leaves every act and record', async () => {
    const dir = tmpDir('log');
    const acts = join(dir, 'acts');
    await runChild(['append3', dir, ARC, acts], undefined);
    assert.equal(readFileSync(acts, 'utf8'), 'act 1\nact 2\nact 3\n');
    assert.deepEqual(events(dir).map((e) => e.type), ['intent', 'done', 'fact']);
  });
});
