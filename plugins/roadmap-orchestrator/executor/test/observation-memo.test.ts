import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { arcId, invocationDirName, invocationIdOf } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { RECORD_BYTES, RecordMemo, immutableGit } from '../src/observation/memo.ts';
import { Observer } from '../src/observation/observer.ts';
import { enrichedParityArc } from './fixtures/status-parity.ts';

const SHA = 'a'.repeat(40);

test('only commands naming full object ids are memoized; a ref argument never is', () => {
  assert.equal(immutableGit(['diff-tree', '-r', '-z', '--no-renames', '--name-only', SHA, 'b'.repeat(40)], undefined), true);
  assert.equal(immutableGit(['ls-tree', '-r', '-z', '--full-tree', SHA], undefined), true);
  assert.equal(immutableGit(['rev-parse', '--verify', '--end-of-options', `${SHA}^{tree}`], undefined), true);
  assert.equal(immutableGit(['cat-file', 'blob', `${SHA}:.roadmap/debt.md`], undefined), true);
  assert.equal(immutableGit(['cat-file', '--batch'], `${SHA}\n${'b'.repeat(40)}\n`), true);
  assert.equal(immutableGit(['log', '--first-parent', '--format=%T', SHA], undefined), true);
  for (const [args, input] of [
    [['rev-parse', '--verify', '--end-of-options', 'refs/heads/main']], [['rev-parse', 'main']], [['rev-parse', 'HEAD']],
    [['rev-parse', '--verify', '-q', '--end-of-options', 'refs/roadmap/arc']], [['rev-parse', '--path-format=absolute', '--git-common-dir']],
    [['log', '--all', '--format=%T', SHA]], [['log', '--format=%d', SHA]], [['log', '--decorate', SHA]], [['merge-base', '--fork-point', SHA, SHA]],
    [['diff-tree', '-r', SHA, 'main']], [['cat-file', 'blob', `main:.roadmap/debt.md`]], [['cat-file', '--batch'], `${SHA}\nmain\n`],
    [['cat-file', '--batch'], ''], [['for-each-ref', SHA]], [['show', SHA]], [['rev-parse', SHA.slice(0, 12)]],
  ] as [string[], string?][]) assert.equal(immutableGit(args, input), false, args.join(' '));
});

test('captures of an unchanged arc after the first spawn git only for ref lookups; from the third on they read no write-once record; a rewritten one is read again after invalidate', async (t) => {
  const f = await enrichedParityArc();
  const shims = mkdtempSync(join(tmpdir(), 'roadmap-memo-git-'));
  t.after(() => rmSync(shims, { recursive: true, force: true }));
  const log = join(shims, 'spawns.log');
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  writeFileSync(join(shims, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`); chmodSync(join(shims, 'git'), 0o755);
  const path = process.env['PATH'];
  process.env['PATH'] = `${shims}:${path}`;
  t.after(() => { process.env['PATH'] = path; });
  const spawns = (): string[] => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

  const o = new Observer(), run = { runDir: absPath(f.runDir), arc: arcId(f.d.arc), at: '' };
  const capture = () => { const r = o.capture({ locator: { type: 'host' }, pinned: run, hostDir: absPath(f.hostDir), token: 0 }); assert.equal(r.error, null); return r.display!; };
  const first = capture(), cold = o.lastWork;
  assert.ok(cold.recordReads > 0 && cold.gitSpawns > 0, 'the first capture reads the records and asks git');
  // A record is kept from its second read on (one read once, a settled row's launch record, is not held for nothing).
  capture();
  const before = spawns().length;
  const second = capture(), warm = o.lastWork;
  assert.deepEqual(second.invocations.map((i) => ({ ...i, quietMs: null })), first.invocations.map((i) => ({ ...i, quietMs: null })));
  assert.equal(warm.recordReads, 0, 'no write-once record is read a third time');
  assert.ok(warm.recordHits > 0 && warm.gitHits > 0);
  const again = spawns().slice(before);
  assert.equal(again.length, warm.gitSpawns);
  assert.ok(again.length < cold.gitSpawns);
  for (const line of again) assert.ok(/ (refs\/\S+|HEAD\S*|--git-common-dir)( |$)/.test(line), `only ref lookups: ${line}`);

  // An ended invocation's exit.json rewritten: the memo keeps answering it until the record is invalidated, then reads it again.
  const inv = readdirSync(join(f.runDir, 'inv')).find((name) => existsSync(join(f.runDir, 'inv', name, 'exit.json')))!;
  const exitPath = join(f.runDir, 'inv', inv, 'exit.json');
  const record = JSON.parse(readFileSync(exitPath, 'utf8'));
  writeFileSync(exitPath, JSON.stringify({ ...record, cpu: { ...record.cpu, wallMs: 4321 } }));
  const id = (row: { body: string }) => JSON.parse(row.body).exit?.cpu?.wallMs;
  const row = (d: typeof first) => d.invocations.find((i) => invocationDirName(invocationIdOf(i.id)) === inv)!;
  assert.notEqual(id(row(capture())), 4321, 'the remembered record stands until it is invalidated');
  assert.equal(o.lastWork.recordReads, 0);
  o.invalidate([exitPath]);
  assert.equal(id(row(capture())), 4321);
  assert.ok(o.lastWork.recordReads >= 1);
  assert.ok(o.changes().rows.some((r) => id(r) === 4321), 'the row read again is a change');
});

test('two readers of one record keep their own forms of it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-memo-forms-')), path = join(dir, 'witness.json');
  try {
    writeFileSync(path, '{"a":1}');
    const memo = new RecordMemo();
    for (let n = 0; n < 3; n++) {
      assert.equal(memo.record('text', path, () => readFileSync(path, 'utf8')), '{"a":1}');
      assert.deepEqual(memo.record('parsed', path, () => JSON.parse(readFileSync(path, 'utf8'))), { a: 1 });
    }
    memo.forget([path]);
    writeFileSync(path, '{"a":2}');
    assert.equal(memo.record('text', path, () => readFileSync(path, 'utf8')), '{"a":2}');
    assert.deepEqual(memo.record('parsed', path, () => JSON.parse(readFileSync(path, 'utf8'))), { a: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('records are bounded by weighed bytes, least recently used first; an evicted record keeps its stamp and is read again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-memo-bound-'));
  try {
    const memo = new RecordMemo(), size = RECORD_BYTES / 10, text = 'x'.repeat(size);
    const paths = Array.from({ length: 12 }, (_, i) => join(dir, `r${i}.json`));
    for (const path of paths) writeFileSync(path, '{}');
    let reads = 0;
    const read = (path: string) => memo.record('text', path, () => { reads++; return text; });
    // Two reads each keep a record: ten fit, then the least recently used go.
    for (const path of paths.slice(0, 10)) { read(path); read(path); }
    assert.equal(memo.sizes().records, 10);
    read(paths[0]!); // a hit: r0 is now the most recently used
    for (const path of paths.slice(10)) { read(path); read(path); }
    const sizes = memo.sizes();
    assert.ok(sizes.recordBytes <= RECORD_BYTES, `${sizes.recordBytes}`);
    assert.equal(sizes.records, 10); assert.equal(sizes.recordEvictions, 2);
    assert.equal(sizes.stamps, 12, 'an evicted record is still stamped for the sweep');
    reads = 0;
    read(paths[0]!); assert.equal(reads, 0, 'the refreshed record was kept');
    read(paths[1]!); assert.equal(reads, 1, 'the least recently used was dropped and is read again');
    // A parsed form weighs its file's size, from the stamp.
    const parsed = join(dir, 'parsed.json'), fresh = new RecordMemo();
    writeFileSync(parsed, JSON.stringify({ pad: 'y'.repeat(1000) }));
    for (let n = 0; n < 2; n++) fresh.record('parsed', parsed, () => JSON.parse(readFileSync(parsed, 'utf8')));
    assert.equal(fresh.sizes().recordBytes, readFileSync(parsed).length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a record heavier than an eighth of the bound is read every time, never kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-memo-heavy-')), path = join(dir, 'witness.json');
  try {
    writeFileSync(path, '{}');
    const memo = new RecordMemo(), heavy = 'x'.repeat(RECORD_BYTES / 8 + 1);
    let reads = 0;
    for (let n = 0; n < 3; n++) memo.record('text', path, () => { reads++; return heavy; });
    assert.equal(reads, 3);
    assert.deepEqual({ records: memo.sizes().records, recordBytes: memo.sizes().recordBytes, stamps: memo.sizes().stamps }, { records: 0, recordBytes: 0, stamps: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settle drops the parsed values not asked for since the previous settle', () => {
  const memo = new RecordMemo();
  let parses = 0;
  const parse = (key: string) => memo.parsed(key, () => { parses++; return { key }; });
  parse('a'); parse('b');
  memo.settle();
  assert.equal(memo.sizes().parsed, 2, 'both were asked for since the memo was made');
  parse('a');
  memo.settle();
  assert.equal(memo.sizes().parsed, 1);
  parses = 0;
  parse('a'); assert.equal(parses, 0, 'a value still asked for stands');
  parse('b'); assert.equal(parses, 1, 'a value let go is parsed again');
});
