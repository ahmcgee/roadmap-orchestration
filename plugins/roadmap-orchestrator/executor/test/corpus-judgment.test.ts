// M4a step C2: a corpus arc's judgments, approvals and debt, through the unit driver with fake backends (real processes,
// real git; test/fixtures/corpus-unit.ts). Named tests: judgment.corpus-materialised-readonly, gate.no-vision-doc,
// gate.debt-banked, publish.debt-render, gate.fingerprint-corpus; and the DEBT_BANK crash row (test/matrix.ts).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, describe, it, test } from 'node:test';
import { corpusPin } from '../src/commands/corpus.ts';
import type { Fact } from '../src/core/events.ts';
import { arcId, sha, unitId } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { registryOf } from '../src/corpus/registry.ts';
import { type CorpusPin, parseCorpusPin } from '../src/corpus/types.ts';
import { debtKey } from '../src/debt/ledger.ts';
import { DEBT_SCHEMA, type DebtLedger } from '../src/debt/types.ts';
import { DEBT_DOC, parseDebtBlock, renderDebt } from '../src/docs/debt.ts';
import { INVARIANTS_DOC, parseRulesRegistryBlock } from '../src/docs/invariants.ts';
import { snapshotRef, verifySnapshot } from '../src/git/snapshot.ts';
import { keepCorpusFiles, readInputFiles, recordPlan } from '../src/input/inforce.ts';
import type { StageContext } from '../src/pipeline/dispatch.ts';
import { arcDebtLedger, closeOutFiles, debtFile, publishCloseOut } from '../src/pipeline/publish.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { APPLY, phase0InputOf, phase0Rows } from '../src/phase0/rows.ts';
import { createArbiter } from '../src/schedule/arbiter.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { PIN_FILE } from './helpers/corpusarc.ts';
import { runFixture } from './helpers/proc.ts';
import { commitAll, git, tmpDir } from './helpers/repo.ts';
import { type CallRecord, readCalls } from './helpers/scenario.ts';
import { type CorpusUnitArc, VISION_PATH, setupCorpusArc } from './fixtures/corpus-unit.ts';
import { BASE, followContext, stepTo, unitOf } from './fixtures/route-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, contextFor, gateStep, isGateCall, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';
import { DEBT_BANK, crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const U1 = unitId('u1');

const note = (text: string) => ({ severity: 'note', path: null, text, contractRef: null });
const NOTE = 'Rename mul to multiply once the API settles.';
/** The approving gate's findings (an approve carries no blocking one): a note (banked), a blank note (nothing), the note again up to whitespace (deduped by key). */
const FINDINGS = [note(NOTE), note('   '), note(`  Rename  mul to multiply\nonce the API settles.`)];

/** The ledger the baseline publishes: B-1 open, kept by this arc's Phase 0. */
const BASELINE_DEBT: DebtLedger = {
  schema: DEBT_SCHEMA,
  items: [{
    id: 'B-1' as never, originArc: arcId('arc-0'), bankReason: 'gate-note', what: 'Split the berth module.', unit: null,
    key: debtKey({ unit: null, bankReason: 'gate-note', what: 'Split the berth module.' }), history: [], state: 'open',
  }],
};

const addDirs = (c: CallRecord): readonly string[] => c.argv.flatMap((a, i) => (a === '--add-dir' ? [c.argv[i + 1]!] : []));
/** Every file under `dir`, as paths relative to it. */
const filesUnder = (dir: string): readonly string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
const facts = (r: ArcRun, kind: Fact['kind']): readonly Fact[] =>
  readJournal(absPath(r.d.runDir), arcId(r.d.arc)).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [e.fact] : []));
const reader = (r: ArcRun) => ({ journal: r.journal, runDir: r.ctx.runDir, planFile: absPath(r.d.planPath), repo: r.ctx.repo });
const viewDir = (a: CorpusUnitArc, pinSha: string, view: 'full' | 'without-vision'): string =>
  join(a.d.runDir, 'corpus', `${pinSha.slice(0, 8)}${view === 'full' ? '' : '.no-vision'}`);

/** The arc with a published debt ledger at its baseline and B-1 kept, its gate approving with `FINDINGS`. */
function debtArc(extraGates: number = 0): Promise<CorpusUnitArc> {
  const gates = Array.from({ length: 1 + extraGates }, () => gateStep({ decision: 'approve', findings: FINDINGS }));
  return setupCorpusArc([planCheckStep({ decision: 'approve' }), mulBuild(), ...gates], {
    baseline: { [DEBT_DOC]: renderDebt(BASELINE_DEBT) },
    phase0: { debt: [{ id: 'B-1', disposition: { type: 'keep', reason: 'not this arc' } }] },
  });
}

/** The ledger the arc renders once its gate banked the note (B-2, after the baseline's B-1). */
function expectedLedger(r: ArcRun): DebtLedger {
  return {
    schema: DEBT_SCHEMA,
    items: [
      { ...BASELINE_DEBT.items[0]!, history: [{ arc: arcId(r.d.arc), disposition: { type: 'keep', reason: 'not this arc' } }] },
      { id: 'B-2' as never, originArc: arcId(r.d.arc), bankReason: 'gate-note', what: NOTE, unit: U1, key: debtKey({ unit: U1, bankReason: 'gate-note', what: NOTE }), history: [], state: 'open' },
    ],
  };
}

describe('a corpus arc\'s unit through its gate', T, () => {
  let a: CorpusUnitArc;
  let r: ArcRun;
  before(async () => {
    a = await debtArc();
    r = contextFor(a.d);
    await stepTo(followContext(r), 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(a.d).at(-1), 'gate:approve');
  }, T);
  after(() => r.journal.close());

  it('judgment.corpus-materialised-readonly: plan-check reads the rules index and the pin materialised read-only from kept bytes, the vision doc included', () => {
    const [check] = readCalls(a.d.scenarioPath);
    assert.ok(check !== undefined && check.as === 'claude' && !isGateCall(check));
    const dir = viewDir(a, a.pinSha256, 'full');
    assert.ok(addDirs(check).includes(dir), `plan-check may read ${dir}: ${check.argv.join(' ')}`);
    assert.deepEqual(filesUnder(dir), a.pin.files.map((f) => f.path).sort(), 'every pinned file, the vision doc among them');
    for (const f of a.pin.files) {
      const path = join(dir, f.path);
      assert.equal(statSync(path).mode & 0o777, 0o444, `${f.path} is read-only`);
      assert.equal(sha256Hex(readFileSync(path)), f.sha256, `${f.path} holds its pinned bytes`);
    }
    assert.throws(() => writeFileSync(join(dir, a.pin.files[0]!.path), 'edited'), /EACCES/);
    for (const rule of a.pin.rules) assert.ok(check.stdin.includes(rule.text), `the rules index carries ${rule.id}`);
    assert.ok(check.stdin.includes(`${dir}/${a.pin.vision.path}`), 'plan-check is told where the vision doc is');
  });

  it('gate.no-vision-doc: the gate reads the rules index and a view of the pin without the vision doc', () => {
    const [g] = readCalls(a.d.scenarioPath).filter(isGateCall);
    assert.ok(g !== undefined);
    const dir = viewDir(a, a.pinSha256, 'without-vision');
    assert.ok(addDirs(g).includes(dir), `the gate may read ${dir}`);
    assert.ok(!addDirs(g).includes(viewDir(a, a.pinSha256, 'full')), 'never the full view');
    assert.deepEqual(filesUnder(dir), a.pin.files.filter((f) => f.path !== a.pin.vision.path).map((f) => f.path).sort());
    for (const rule of a.pin.rules) assert.ok(g.stdin.includes(rule.text), `the rules index carries ${rule.id}`);
    const vision = readFileSync(join(a.d.repo, VISION_PATH), 'utf8').split('\n').find((l) => l.startsWith('A calm'))!;
    for (const text of [vision, a.pin.vision.path, 'Every vessel finds a berth.']) assert.ok(!g.stdin.includes(text), `the gate prompt carries "${text}"`);
  });

  it('gate.fingerprint-corpus: the approval binds the whole pin in force and no architecture doc', () => {
    const fp = r.journal.view.unit(U1).approval?.fingerprint;
    assert.ok(fp !== undefined);
    assert.equal(fp.corpus, a.pinSha256);
    assert.deepEqual(fp.contractRevs.map((c) => c.path), ['contracts/api.md'], 'the cited contract only: a corpus arc has no target document');
  });

  it('gate.debt-banked: the approving answer\'s note is banked once after the approval, continuing the baseline\'s ids; a blank note never, a repeat deduped', () => {
    const attempt = r.journal.view.unit(U1).approval!.attempt;
    const debt = r.journal.view.holistic().debt;
    assert.deepEqual(debt.map(({ seq: _seq, ...d }) => d), [{
      kind: 'debt-banked', id: 'B-2', bankReason: 'gate-note', what: NOTE, key: debtKey({ unit: U1, bankReason: 'gate-note', what: NOTE }),
      source: { type: 'gate', unit: U1, attempt, index: 0 },
    }]);
    const log = readJournal(absPath(a.d.runDir), arcId(a.d.arc)).events;
    const seqOf = (kind: string): number => log.find((e) => e.type === 'fact' && e.fact.kind === kind)!.seq;
    assert.ok(seqOf('approval') < seqOf('debt-banked'), 'banked after the approval');
  });

  it('publish.debt-render: the close-out renders debt.md from the baseline ledger, the Phase-0 dispositions and the banked items, and invariants.md with the pin\'s registry', () => {
    const expected = expectedLedger(r);
    assert.deepEqual(arcDebtLedger(reader(r)), expected);
    const head = sha(git(a.d.repo, 'rev-parse', 'main'));
    const files = new Map(closeOutFiles(reader(r), head).map((f) => [f.path as string, f.bytes.toString('utf8')]));
    assert.equal(files.get(DEBT_DOC), renderDebt(expected));
    assert.deepEqual(parseDebtBlock(files.get(DEBT_DOC)!), expected, 'the block round-trips');
    assert.deepEqual(parseRulesRegistryBlock(files.get(INVARIANTS_DOC)!), registryOf(a.pin));
    // A commit already holding the rendering needs none (a docs publication carries it only where it differs).
    git(a.d.repo, 'checkout', '--quiet', '-b', 'debt-rendered');
    writeFileSync(join(a.d.repo, DEBT_DOC), renderDebt(expected));
    const rendered = sha(commitAll(a.d.repo, 'debt rendered'));
    git(a.d.repo, 'checkout', '--quiet', 'main');
    assert.equal(debtFile(reader(r), rendered), null);
    assert.equal(debtFile(reader(r), head)?.path, DEBT_DOC);
  });
});

/** Re-pins the arc at a commit off `main` that rewords T-2 (same id, R5) and puts the new pin in force as the next revision. */
async function repin(a: CorpusUnitArc, r: ArcRun): Promise<CorpusPin> {
  git(a.d.repo, 'checkout', '--quiet', '-b', 'corpus-edit');
  const file = join(a.d.repo, 'docs/corpus/0020_Berths.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('A booking names one berth and one tide window.', 'A booking names exactly one berth and one tide window.'));
  const commit = commitAll(a.d.repo, 'reword T-2');
  git(a.d.repo, 'checkout', '--quiet', 'main');
  const out = await corpusPin({ repo: absPath(a.d.repo), commit: sha(commit), baseline: sha(a.baseline), out: absPath(join(a.planDir, PIN_FILE)) });
  assert.equal(out.kind, 'pinned', JSON.stringify(out));
  const files = readInputFiles(absPath(a.d.planPath), absPath(a.d.repo));
  const rows = phase0Rows(phase0InputOf(files, null), APPLY);
  assert.deepEqual(rows.rows, []);
  keepCorpusFiles(r.ctx.runDir, rows.opened!.files);
  recordPlan(r.journal, r.ctx.runDir, files, [], BASE);
  return parseCorpusPin(JSON.parse(readFileSync(join(a.planDir, PIN_FILE), 'utf8')));
}

test('gate.fingerprint-corpus: a re-pin invalidates the approval at ff and the re-gate binds the new pin; the close-out publishes debt.md and the registry; the ref carries both pins\' files', T, async () => {
  const a = await debtArc(1);
  const r = contextFor(a.d);
  try {
    const ctx: StageContext = followContext(r);
    await stepTo(ctx, 'u1', (f) => f.stage === 'gate');
    const next = await repin(a, r);
    const nextSha = sha256Hex(readFileSync(join(a.planDir, PIN_FILE)));
    assert.notEqual(nextSha, a.pinSha256);
    assert.deepEqual(await runUnit(ctx, unitOf(ctx, 'u1'), admitAll), { kind: 'merged' });
    assert.ok(outcomes(a.d).includes('ff:fingerprint-invalid'), outcomes(a.d).join(' '));
    const approvals = facts(r, 'approval').map((f) => (f.kind === 'approval' ? f.fingerprint.corpus : null));
    assert.deepEqual(approvals, [a.pinSha256, nextSha], 'the re-gate binds the pin then in force');
    const gates = readCalls(a.d.scenarioPath).filter(isGateCall);
    assert.equal(gates.length, 2);
    assert.ok(addDirs(gates[1]!).includes(viewDir(a, nextSha, 'without-vision')), 'the re-gate reads the new pin');
    // Each approval banked under its own source, the re-gate's note deduped by key: one item.
    assert.deepEqual(r.journal.view.holistic().debt.map((d) => d.id), ['B-2']);

    const closed = await publishCloseOut({ ...ctx, planFile: absPath(a.d.planPath), arbiter: createArbiter(ctx) });
    assert.equal(closed.kind, 'published', JSON.stringify(closed));
    const show = (path: string): string => git(a.d.repo, 'show', `main:${path}`);
    assert.deepEqual(parseDebtBlock(show(DEBT_DOC)), arcDebtLedger(reader(r)));
    assert.deepEqual(parseRulesRegistryBlock(show(INVARIANTS_DOC)), registryOf(next));

    const at = sha(git(a.d.repo, 'rev-parse', snapshotRef(arcId(a.d.arc))));
    const check = verifySnapshot(absPath(a.d.repo), at);
    assert.equal(check.kind, 'verified', check.kind === 'mismatch' ? check.detail : '');
    if (check.kind !== 'verified') return;
    const listed = new Set(check.manifest.files.map((f) => f.path as string));
    for (const f of [...a.pin.files, ...next.files]) assert.ok(listed.has(`inputs/${f.sha256}.corpus-file`), `${f.path} (${f.sha256}) is carried`);
  } finally {
    r.journal.close();
  }
});

test('gate.debt-banked: outside a corpus arc a gate note banks nothing', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve', findings: FINDINGS })] });
  const r = contextFor(d);
  try {
    await stepTo(followContext(r), 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    assert.deepEqual(r.journal.view.holistic().debt, []);
    assert.equal(r.journal.view.unit(U1).approval?.fingerprint.corpus, undefined, 'no corpus outside a corpus arc');
    assert.equal(arcDebtLedger(reader(r)), null);
  } finally {
    r.journal.close();
  }
});

describe(`matrix row ${DEBT_BANK}`, () => {
  for (const cell of crashCells(DEBT_BANK)) {
    it(`${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async () => {
      const a = await debtArc();
      const trigger = writeTrigger(tmpDir('debt-crash'), { label: cell.label, occurrence: 1 });
      const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
      const first = await runFixture('corpus-gate-child.ts', [JSON.stringify(a.d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
      assert.equal(first.signal, 'SIGKILL', first.stderr);
      assertFired(trigger);
      const log = (): Readonly<{ approvals: readonly number[]; debt: readonly Fact[]; gates: number }> => {
        const events = readJournal(absPath(a.d.runDir), arcId(a.d.arc)).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
        return {
          approvals: events.flatMap((f) => (f.kind === 'approval' ? [f.attempt] : [])), debt: events.filter((f) => f.kind === 'debt-banked'),
          gates: events.filter((f) => f.kind === 'stage-outcome' && f.stage === 'gate').length,
        };
      };
      const killed = log();
      assert.deepEqual({ approvals: killed.approvals.length, debt: killed.debt.length, gates: killed.gates }, { approvals: 1, debt: 0, gates: 0 }, 'killed between the approval and the banking');

      const second = await runFixture('corpus-gate-child.ts', [JSON.stringify(a.d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
      assert.equal(second.code, 0, second.stderr);
      const now = log();
      assert.deepEqual(now.approvals, killed.approvals, 'the approval is kept, not recorded twice');
      assert.equal(now.gates, 1);
      assert.deepEqual(now.debt.map((f) => (f.kind === 'debt-banked' ? [f.id, f.source] : null)), [['B-2', { type: 'gate', unit: 'u1', attempt: killed.approvals[0], index: 0 }]]);
      assert.equal(readCalls(a.d.scenarioPath).filter(isGateCall).length, 1, 'the recorded gate call is consumed, never asked again');
    });
  }
});

