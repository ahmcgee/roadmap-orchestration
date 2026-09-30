// The witness protocol (src/holistic/witness.ts, reporters/node-witness.mjs): a real `node --test` run through the
// shipped reporter, hand-written test2json streams (no go toolchain on this host: real `go` is NOT RUN), a real
// shell wrapper appending jsonl lines, and malformed or missing output, which makes every declared test unwitnessed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { envId, invocationId, arcId, opId, sha, sha256 } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { absPath, type AbsPath } from '../src/core/values.ts';
import { verdictOf } from '../src/holistic/observe.ts';
import { type ArcLaneDef, type WitnessTest, laneRevOf, parseObligations, witnessRecord } from '../src/holistic/types.ts';
import {
  NODE_WITNESS_REPORTER, WITNESS_FILE_ENV, WITNESS_RECORD_FILE, collectWitness, envIdOf, hostIdentity, parseGoTestJson, parseWitnessLines,
  witnessEnv, witnessRecordOf, writeWitnessRecord,
} from '../src/holistic/witness.ts';

const root = mkdtempSync(join(tmpdir(), 'witness-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
const dir = (name: string): AbsPath => { const d = join(root, name); mkdirSync(d, { recursive: true }); return absPath(d); };

const INV = invocationId(opId(arcId('arc-1'), 7), 1);
const TREE = sha('a'.repeat(40));
const ENV = envId('fedcba9876543210');

function lane(reporter: ArcLaneDef['reporter'], pass: readonly string[] = []): ArcLaneDef {
  const [l] = parseObligations({
    schema: 'roadmap/obligations-m3', cutLine: 'cut', obligations: [], mapping: { paths: [] },
    lanes: [{ id: 'journey', argv: ['node', '--test'], cwd: '.', env: { set: {}, pass }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], evidenceExcludes: [], reporter }],
  }).lanes;
  return l as ArcLaneDef;
}

const witness = (...testIds: string[]) => ({ lane: lane('node-test').id, testIds });
const t = (testId: string, selected: number, outcome: WitnessTest['outcome']): WitnessTest => ({ testId, selected, outcome });

/** The environment a lane process gets: the host's, minus the outer test runner's own context. */
function laneProcessEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env['NODE_TEST_CONTEXT'];
  return env;
}

describe('witness.node-real: node --test through the shipped reporter', () => {
  it('records every test by its name path, skip and todo as skip, suites not at all, duplicates aggregated', () => {
    const repo = dir('node-real');
    mkdirSync(join(repo, 'nested'));
    writeFileSync(join(repo, 'a.test.mjs'), [
      "import { describe, test } from 'node:test';",
      "describe('ledger', () => {",
      "  test('reconcile month', () => {});",
      "  test('skipped', { skip: 'not yet' }, () => {});",
      "  describe('money', () => { test('half-even', () => {}); });",
      '});',
      "test('parent', async (t) => { await t.test('child', () => {}); });",
      "test('rounds', () => { throw new Error('mis-rounded'); });",
      "test('todo one', { todo: true }, () => { throw new Error('later'); });",
      "test('twice', () => {});",
      '',
    ].join('\n'));
    writeFileSync(join(repo, 'b.test.mjs'), [
      "import { test } from 'node:test';",
      "import { spawnSync } from 'node:child_process';",
      "test('twice', () => {});",
      // A nested `node --test` a test spawns afresh records nothing: the reporter took the variable out of the env.
      "test('spawns a nested run', () => {",
      '  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;',
      "  const r = spawnSync(process.execPath, ['--test', 'nested/inner.mjs'], { env, encoding: 'utf8' });",
      '  if (r.status !== 0) throw new Error(r.stdout + r.stderr);',
      '});',
      '',
    ].join('\n'));
    writeFileSync(join(repo, 'nested', 'inner.mjs'), "import { test } from 'node:test';\ntest('nested only', () => {});\n");
    const file = absPath(join(repo, 'witness.jsonl'));
    const run = spawnSync(process.execPath, ['--test'], { cwd: repo, env: laneProcessEnv(witnessEnv('node-test', file)), encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 1, run.stderr);
    assert.doesNotMatch(run.stdout, /✖ spawns a nested run/, run.stdout);
    assert.match(run.stdout, /✔ reconcile month/, 'the spec reporter keeps the lane stdout readable');
    const tests = collectWitness('node-test', { witnessFile: file, stdoutFile: absPath(join(repo, 'unused')) });
    assert.deepEqual(tests, [
      t('ledger > money > half-even', 1, 'pass'),
      t('ledger > reconcile month', 1, 'pass'),
      t('ledger > skipped', 1, 'skip'),
      t('parent', 1, 'pass'),
      t('parent > child', 1, 'pass'),
      t('rounds', 1, 'fail'),
      t('spawns a nested run', 1, 'pass'),
      t('todo one', 1, 'skip'),
      t('twice', 2, 'pass'),
    ]);
    const record = witnessRecordOf({ lane: lane('node-test'), envId: ENV, treeSha: TREE, inv: INV, purpose: 'witness' }, tests);
    assert.equal(record.laneRev, laneRevOf(lane('node-test')));
    assert.equal(record.runner, 'node-test');
    assert.equal(record.malformed, false);
    assert.equal(verdictOf(record, witness('ledger > reconcile month', 'twice')), 'held');
    assert.equal(verdictOf(record, witness('ledger > reconcile month', 'rounds')), 'not-held');
    assert.equal(verdictOf(record, witness('ledger > reconcile month', 'ledger > skipped')), 'partial');
    assert.equal(verdictOf(record, witness('nested only')), 'unwitnessed');
    assert.equal(verdictOf(record, witness('ledger')), 'unwitnessed', 'a suite is not a test');

    const evidence = dir('node-real-evidence');
    const hash = writeWitnessRecord(evidence, record);
    const bytes = readFileSync(join(evidence, WITNESS_RECORD_FILE), 'utf8');
    assert.equal(hash, sha256(sha256Hex(bytes)));
    assert.deepEqual(witnessRecord(JSON.parse(bytes), 'witness'), record);
    assert.throws(() => writeWitnessRecord(evidence, record), 'witness.json is write-once');
  });

  it('a run whose reporter never loaded leaves no witness file: malformed', () => {
    const repo = dir('node-unloaded');
    writeFileSync(join(repo, 'a.test.mjs'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
    const file = absPath(join(repo, 'witness.jsonl'));
    const run = spawnSync(process.execPath, ['--test'], { cwd: repo, env: laneProcessEnv({ [WITNESS_FILE_ENV]: file }), encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const tests = collectWitness('node-test', { witnessFile: file, stdoutFile: absPath(join(repo, 'unused')) });
    assert.equal(tests, null);
    const record = witnessRecordOf({ lane: lane('node-test'), envId: ENV, treeSha: TREE, inv: INV, purpose: 'witness' }, tests);
    assert.deepEqual([record.malformed, record.records], [true, []]);
    assert.equal(verdictOf(record, witness('ok')), 'unwitnessed');
  });

  it('witnessEnv: the node reporter through NODE_OPTIONS, the file for jsonl, nothing for go', () => {
    const file = absPath('/tmp/w.jsonl');
    assert.deepEqual(witnessEnv('node-test', file), {
      [WITNESS_FILE_ENV]: file,
      NODE_OPTIONS: `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${NODE_WITNESS_REPORTER} --test-reporter-destination=stderr`,
    });
    assert.deepEqual(witnessEnv('jsonl', file), { [WITNESS_FILE_ENV]: file });
    assert.deepEqual(witnessEnv('go-test-json', file), {});
  });

  it('envIdOf binds the host and the passed-through variables, not the unpassed ones', () => {
    const host = hostIdentity();
    const l = lane('node-test', ['TZ']);
    const base = envIdOf(l, host, { TZ: 'UTC', HOME: '/a' });
    assert.equal(envIdOf(l, host, { TZ: 'UTC', HOME: '/b' }), base);
    assert.notEqual(envIdOf(l, host, { TZ: 'Europe/Paris' }), base);
    assert.notEqual(envIdOf(l, host, {}), base);
    assert.notEqual(envIdOf(l, { ...host, node: 'v0.0.0' }, { TZ: 'UTC' }), base);
    assert.notEqual(envIdOf(l, { ...host, arch: 'other' }, { TZ: 'UTC' }), base);
  });
});

describe('witness.go-json: test2json event streams (hand-written; real go NOT RUN)', () => {
  const ev = (o: Record<string, unknown>): string => `${JSON.stringify({ Time: '2026-09-30T12:00:00Z', ...o })}\n`;
  it('pass, fail, skip, subtests, output and package events; a test that never ended fails', () => {
    const stream = [
      ev({ Action: 'start', Package: 'ledger/parse' }),
      ev({ Action: 'run', Package: 'ledger/parse', Test: 'TestParse' }),
      ev({ Action: 'output', Package: 'ledger/parse', Test: 'TestParse', Output: '=== RUN   TestParse\n' }),
      ev({ Action: 'run', Package: 'ledger/parse', Test: 'TestParse/empty' }),
      ev({ Action: 'pass', Package: 'ledger/parse', Test: 'TestParse/empty', Elapsed: 0 }),
      ev({ Action: 'pause', Package: 'ledger/parse', Test: 'TestParse' }),
      ev({ Action: 'cont', Package: 'ledger/parse', Test: 'TestParse' }),
      ev({ Action: 'pass', Package: 'ledger/parse', Test: 'TestParse', Elapsed: 0.01 }),
      ev({ Action: 'run', Package: 'ledger/parse', Test: 'TestRound' }),
      ev({ Action: 'fail', Package: 'ledger/parse', Test: 'TestRound', Elapsed: 0 }),
      ev({ Action: 'run', Package: 'ledger/parse', Test: 'TestLater' }),
      ev({ Action: 'skip', Package: 'ledger/parse', Test: 'TestLater', Elapsed: 0 }),
      ev({ Action: 'output', Package: 'ledger/parse', Output: 'FAIL\n' }),
      ev({ Action: 'fail', Package: 'ledger/parse', Elapsed: 0.02 }),
      ev({ Action: 'build-output', ImportPath: 'ledger/report', Output: '# ledger/report\n' }),
      ev({ Action: 'run', Package: 'ledger/report', Test: 'TestParse' }),
      ev({ Action: 'pass', Package: 'ledger/report', Test: 'TestParse', Elapsed: 0 }),
      ev({ Action: 'run', Package: 'ledger/report', Test: 'TestPanics' }),
      ev({ Action: 'output', Package: 'ledger/report', Test: 'TestPanics', Output: 'panic: boom\n' }),
      ev({ Action: 'fail', Package: 'ledger/report', Elapsed: 0.02 }),
    ].join('');
    const tests = parseGoTestJson(stream);
    assert.deepEqual(tests, [
      t('TestLater', 1, 'skip'),
      t('TestPanics', 1, 'fail'),
      t('TestParse', 2, 'pass'),
      t('TestParse/empty', 1, 'pass'),
      t('TestRound', 1, 'fail'),
    ]);
    const repo = dir('go');
    const stdoutFile = absPath(join(repo, 'stdout'));
    writeFileSync(stdoutFile, stream);
    assert.deepEqual(collectWitness('go-test-json', { witnessFile: absPath(join(repo, 'none')), stdoutFile }), tests);
    const record = witnessRecordOf({ lane: lane('go-test-json'), envId: ENV, treeSha: TREE, inv: INV, purpose: 'witness' }, tests);
    assert.equal(verdictOf(record, witness('TestParse', 'TestParse/empty')), 'held');
    assert.equal(verdictOf(record, witness('TestParse', 'TestPanics')), 'not-held');
    assert.equal(verdictOf(record, witness('TestParse', 'TestLater')), 'partial');
    assert.equal(verdictOf(record, witness('TestLater')), 'unwitnessed');
  });

  it('empty stdout is no records; a non-JSON line, a non-object, an unknown action or a torn last line is malformed', () => {
    assert.deepEqual(parseGoTestJson(''), []);
    const ok = ev({ Action: 'pass', Package: 'p', Test: 'TestA' });
    assert.deepEqual(parseGoTestJson(ok), [t('TestA', 1, 'pass')]);
    for (const bad of [`${ok}PASS\n`, `${ok}[1]\n`, `${ok}null\n`, ev({ Action: 'explode', Package: 'p', Test: 'TestA' }), ev({ Package: 'p', Test: 'TestA' }), ev({ Action: 'pass', Test: 7 }), ev({ Action: 'pass', Test: '' }), ok.slice(0, -1)]) {
      assert.equal(parseGoTestJson(bad), null, bad);
    }
  });
});

describe('witness.jsonl: a shell wrapper appends witness lines', () => {
  it('lines from a real sh wrapper, several per id and an explicit empty selection, aggregate into records', () => {
    const repo = dir('jsonl');
    const wrapper = join(repo, 'wrapper.sh');
    writeFileSync(wrapper, [
      '#!/bin/sh',
      `echo '{"testId":"reconcile month","selected":1,"outcome":"pass"}' >> "$${WITNESS_FILE_ENV}"`,
      `echo '{"testId":"reconcile month","selected":2,"outcome":"pass"}' >> "$${WITNESS_FILE_ENV}"`,
      `echo '{"testId":"half-even","selected":1,"outcome":"pass"}' >> "$${WITNESS_FILE_ENV}"`,
      `echo '{"testId":"half-even","selected":1,"outcome":"skip"}' >> "$${WITNESS_FILE_ENV}"`,
      `echo '{"testId":"unknown commands exit 2","selected":0,"outcome":"zero-selected"}' >> "$${WITNESS_FILE_ENV}"`,
      `echo '{"testId":"rounds","selected":1,"outcome":"fail"}' >> "$${WITNESS_FILE_ENV}"`,
      'exit 1',
      '',
    ].join('\n'));
    const file = absPath(join(repo, 'witness.jsonl'));
    const run = spawnSync('sh', [wrapper], { cwd: repo, env: laneProcessEnv(witnessEnv('jsonl', file)), encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 1, run.stderr);
    const tests = collectWitness('jsonl', { witnessFile: file, stdoutFile: absPath(join(repo, 'unused')) });
    assert.deepEqual(tests, [
      t('half-even', 2, 'skip'),
      t('reconcile month', 3, 'pass'),
      t('rounds', 1, 'fail'),
      t('unknown commands exit 2', 0, 'zero-selected'),
    ]);
    const record = witnessRecordOf({ lane: lane('jsonl'), envId: ENV, treeSha: TREE, inv: INV, purpose: 'witness' }, tests);
    assert.equal(record.runner, 'jsonl');
    assert.equal(verdictOf(record, witness('reconcile month')), 'held');
    assert.equal(verdictOf(record, witness('reconcile month', 'half-even')), 'partial');
    assert.equal(verdictOf(record, witness('reconcile month', 'unknown commands exit 2')), 'partial');
    assert.equal(verdictOf(record, witness('unknown commands exit 2')), 'unwitnessed');
    assert.equal(verdictOf(record, witness('rounds', 'reconcile month')), 'not-held');
  });

  it('an empty witness file is no records, not malformed', () => {
    assert.deepEqual(parseWitnessLines(''), []);
  });
});

describe('witness.malformed: malformed or missing output makes every declared test unwitnessed', () => {
  const good = '{"testId":"a","selected":1,"outcome":"pass"}\n';
  const cases: readonly (readonly [string, string])[] = [
    ['not JSON', `${good}not json\n`],
    ['a torn last line', `${good}{"testId":"b","selected":1,"outc`],
    ['no final newline', good.slice(0, -1)],
    ['an empty line', `${good}\n${good}`],
    ['an unknown outcome', '{"testId":"a","selected":1,"outcome":"flaky"}\n'],
    ['an extra field', '{"testId":"a","selected":1,"outcome":"pass","ms":3}\n'],
    ['a missing field', '{"testId":"a","outcome":"pass"}\n'],
    ['an empty test id', '{"testId":"","selected":1,"outcome":"pass"}\n'],
    ['selected 0 with a pass', '{"testId":"a","selected":0,"outcome":"pass"}\n'],
    ['zero-selected with a selection', '{"testId":"a","selected":1,"outcome":"zero-selected"}\n'],
    ['a negative selection', '{"testId":"a","selected":-1,"outcome":"pass"}\n'],
    ['an array', '[]\n'],
  ];
  for (const [name, content] of cases) {
    it(name, () => {
      assert.equal(parseWitnessLines(content), null);
      const repo = dir(`malformed-${name.replaceAll(' ', '-')}`);
      const file = absPath(join(repo, 'witness.jsonl'));
      writeFileSync(file, content);
      for (const runner of ['node-test', 'jsonl'] as const) {
        const tests = collectWitness(runner, { witnessFile: file, stdoutFile: absPath(join(repo, 'unused')) });
        const record = witnessRecordOf({ lane: lane(runner), envId: ENV, treeSha: TREE, inv: INV, purpose: 'witness' }, tests);
        assert.deepEqual([record.malformed, record.records], [true, []]);
        assert.equal(verdictOf(record, witness('a')), 'unwitnessed');
      }
    });
  }

  it('a missing witness file is malformed for node-test and jsonl', () => {
    const missing = absPath(join(root, 'no-such-file'));
    for (const runner of ['node-test', 'jsonl'] as const) assert.equal(collectWitness(runner, { witnessFile: missing, stdoutFile: missing }), null);
  });

  it('a malformed record with records is refused by the reader', () => {
    const record = witnessRecordOf({ lane: lane('jsonl'), envId: ENV, treeSha: TREE, inv: INV, purpose: 'witness' }, null);
    assert.throws(() => witnessRecord({ ...record, records: [t('a', 1, 'pass')] }, 'witness'));
  });
});
