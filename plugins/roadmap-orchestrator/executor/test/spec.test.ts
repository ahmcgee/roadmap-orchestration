// Spec loading, rendering and patching (src/spec/*), and the spec.patch reconciler (src/recover/spec.ts).
// Integrated tier: real files, and a child process SIGKILLed at the op's crashPoints for the spec.patch
// row of the crash matrix (test/matrix.ts).
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { opKey } from '../src/core/ids.ts';
import { type SpecM1, type SpecPatch, specM1, specPatch } from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import { openJournal } from '../src/core/log.ts';
import { reconcileSpecPatch } from '../src/recover/spec.ts';
import { SpecPatchOpError, SpecPatchStaleError, applySpecPatch, specPatchFileOp } from '../src/spec/patch.ts';
import { renderSpec } from '../src/spec/render.ts';
import { parseRulings } from '../src/spec/rulings.ts';
import { bytesSha256, fileSha256, loadSpec, specBytes, writeSpec } from '../src/spec/spec.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { ARC } from './fixtures/log-records.ts';
import { SPEC_PATCH, crashCells } from './matrix.ts';

const CHILD_TIMEOUT_MS = 20_000;
const SPEC_KEY = opKey('spec:u1');

const FAST_LANE = {
  id: 'unit-tests', argv: ['npm', 'test'], cwd: '.', env: { set: { ZED: '1', ALPHA: 'a b' }, pass: ['PATH', 'HOME'] },
  expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: ['out/b.log', 'out/a.log'], state: 'active',
};
// Every token of this lane is distinctive, so a leak into the implementer's view is detectable.
const ESTATE_LANE = {
  id: 'estateJourney', argv: ['estate-runner', '--estate-flag'], cwd: 'estate-dir', env: { set: { ESTATE_SECRET: 'estate-value' }, pass: ['ESTATE_PASS'] },
  expectedExit: 3, tier: 'estate', resources: ['estate-db'], evidenceGlobs: ['estate-evidence/**'], state: 'active',
};

/** The authored form: a unit spec as Phase 0 writes it, keys in authoring order. */
const RAW_SPEC = {
  schema: 'roadmap/spec-m1',
  unit: 'u1',
  rev: 1,
  lanes: [FAST_LANE, ESTATE_LANE],
  acceptance: [
    { id: 'A1', clause: 'The widget renders.\nIt renders twice.', failLoudIfUndelivered: true, state: 'active' },
    { id: 'A2', clause: 'The widget is blue.', failLoudIfUndelivered: false, state: 'active' },
  ],
  scope: ['src/widget/**', 'docs/widget.md'],
  resources: ['shared-cache', 'estate-db'],
  decisions: [{ id: 'D1', text: 'Use the canvas API.', state: 'active' }],
  facts: [{ id: 'F1', text: 'The canvas is 800 wide.', state: 'active' }],
  cites: { contracts: ['docs/widget.md'], rulings: ['C-2'] },
};
const SPEC: SpecM1 = specM1(RAW_SPEC, 'spec');

const BY = { role: 'planCheck', routingRev: '0123456789abcdef', inv: 'arc-1/5#1' };
const patch = (ops: readonly unknown[], expectRev = 1): SpecPatch => specPatch({ expectRev, by: BY, ops }, 'patch');

/** A redirect exercising every op kind. */
const REDIRECT = patch([
  { op: 'add', section: 'acceptance', item: { id: 'A3', clause: 'The widget is keyboard reachable.', failLoudIfUndelivered: true } },
  { op: 'replace', section: 'acceptance', item: { id: 'A2', clause: 'The widget is green.', failLoudIfUndelivered: false } },
  { op: 'strike', id: 'A1' },
  { op: 'defer', id: 'D1' },
  { op: 'add', section: 'decisions', item: { id: 'D2', text: 'Use SVG instead.' } },
  { op: 'add', section: 'facts', item: { id: 'F2', text: 'SVG is available.' } },
  { op: 'add', section: 'lanes', item: { ...FAST_LANE, id: 'lint', argv: ['npm', 'run', 'lint'], state: undefined } },
].map((op) => JSON.parse(JSON.stringify(op))));

/** Writes the authored spec with arbitrary formatting; returns its path. */
function authored(dir: string, text = JSON.stringify(RAW_SPEC, null, 4)): AbsPath {
  const path = absPath(join(dir, 'spec.json'));
  writeFileSync(path, text);
  return path;
}

const ids = (spec: SpecM1): string[] => [...spec.lanes, ...spec.acceptance, ...spec.decisions, ...spec.facts].map((i) => `${i.id}:${i.state}`);

describe('spec load and write', () => {
  it('spec.load-and-rev', () => {
    const dir = tmpDir('spec');
    const pretty = loadSpec(authored(dir));
    const compact = loadSpec(authored(tmpDir('spec'), JSON.stringify(RAW_SPEC)));
    // Whitespace and key order are not content: both files load to one value with one canonical form.
    assert.deepEqual(pretty, compact);
    assert.equal(pretty.rev, 1);
    assert.ok(specBytes(pretty).equals(specBytes(compact)));
    // A semantic change is a different canonical form (and so a different content hash).
    const changed = specM1({ ...RAW_SPEC, scope: ['src/widget/**'] }, 'spec');
    assert.notEqual(bytesSha256(specBytes(changed)), bytesSha256(specBytes(pretty)));
    // The revision is the file's; a patch moves it by exactly one.
    assert.equal(applySpecPatch(pretty, REDIRECT).rev, 2);
    // writeSpec writes exactly the canonical bytes, and they load back to the same value.
    const out = absPath(join(dir, 'written.json'));
    writeSpec(out, pretty);
    assert.ok(readFileSync(out).equals(specBytes(pretty)));
    assert.equal(fileSha256(out), bytesSha256(specBytes(pretty)));
    assert.deepEqual(loadSpec(out), pretty);
  });

  it('refuses an invalid spec file naming the field', () => {
    const dir = tmpDir('spec');
    // Hard cutover: a spec without cites is refused, never defaulted.
    const { cites: _cites, ...uncited } = RAW_SPEC;
    assert.throws(() => loadSpec(authored(tmpDir('spec'), JSON.stringify(uncited))), (e: unknown) => e instanceof SchemaError && e.field === 'spec.cites');
    assert.throws(() => loadSpec(authored(tmpDir('spec'), JSON.stringify({ ...RAW_SPEC, cites: { contracts: [], rulings: ['C-1', 'C-1'] } }))), SchemaError);
    assert.throws(() => loadSpec(authored(dir, JSON.stringify({ ...RAW_SPEC, acceptance: [] }))), (e: unknown) => e instanceof SchemaError && e.field === 'spec.acceptance');
    assert.throws(() => loadSpec(authored(tmpDir('spec'), '{"schema":')), /not JSON/);
  });
});

describe('spec rendering', () => {
  it('spec.render-deterministic', () => {
    const first = renderSpec(SPEC);
    assert.equal(renderSpec(SPEC), first);
    // Sets render sorted, so a permutation of any of them renders identically.
    const permuted = specM1({
      ...RAW_SPEC,
      scope: [...RAW_SPEC.scope].reverse(),
      resources: [...RAW_SPEC.resources].reverse(),
      lanes: [{ ...FAST_LANE, env: { set: { ALPHA: 'a b', ZED: '1' }, pass: ['HOME', 'PATH'] }, evidenceGlobs: ['out/a.log', 'out/b.log'] }, ESTATE_LANE],
    }, 'spec');
    assert.equal(renderSpec(permuted), first);
    const at = (s: string): number => first.indexOf(s);
    assert.ok(at('`docs/widget.md`') < at('`src/widget/**`'), 'scope sorted');
    assert.ok(at('- `estate-db`') < at('- `shared-cache`'), 'resources sorted');
    assert.ok(at('ALPHA="a b"') < at('ZED="1"') && at('HOME (from the host)') < at('PATH (from the host)'), 'env sorted');
    assert.ok(at('`out/a.log`') < at('`out/b.log`'), 'evidence sorted');
    // Items keep their authored order; every section is present.
    assert.ok(at('`A1`') < at('`A2`'));
    for (const heading of ['# Spec for unit `u1`, rev 1', '## Acceptance', '## Scope', '## Lanes', '## Resources', '## Decisions', '## Facts', '## Cites']) {
      assert.ok(first.includes(heading), heading);
    }
    assert.ok(first.includes('- `A1` [active] (fail loud if undelivered): The widget renders.\n  It renders twice.'), 'multi-line clause indented');
    assert.ok(first.includes('`["npm","test"]`'));
    assert.ok(first.includes('## Cites\n\n- contract `docs/widget.md`\n- ruling C-2'), 'cites: contracts, then rulings');
  });

  it('spec.render-fast-lanes-only', () => {
    const full = renderSpec(SPEC);
    const fast = renderSpec(SPEC, { fastLanesOnly: true });
    const estateTokens = ['estateJourney', 'estate-runner', '--estate-flag', 'estate-dir', 'ESTATE_SECRET', 'estate-value', 'ESTATE_PASS', 'estate-evidence', 'tier estate'];
    for (const token of estateTokens) {
      assert.ok(full.includes(token), `full render shows ${token}`);
      assert.ok(!fast.includes(token), `fast-lanes render leaks ${token}`);
    }
    assert.ok(fast.includes('`unit-tests` [active] tier fast'));
    // A struck estate lane is still an estate lane: omitted too.
    const struck = applySpecPatch(SPEC, patch([{ op: 'strike', id: 'estateJourney' }]));
    assert.ok(!renderSpec(struck, { fastLanesOnly: true }).includes('estateJourney'));
    assert.ok(renderSpec(struck).includes('`estateJourney` [struck] tier estate'));
  });

  it('spec.redirect-renders', () => {
    const text = renderSpec(applySpecPatch(SPEC, REDIRECT));
    assert.ok(text.includes('rev 2'));
    assert.ok(text.includes('- `A3` [active] (fail loud if undelivered): The widget is keyboard reachable.'));
    assert.ok(text.includes('- `A2` [active]: The widget is green.'));
    assert.ok(!text.includes('The widget is blue.'), 'a replaced clause shows only its new text');
    assert.ok(text.includes('- `A1` [struck] (fail loud if undelivered): The widget renders.'), 'struck items stay visible');
    assert.ok(text.includes('- `D1` [deferred]: Use the canvas API.'), 'deferred items stay visible');
    assert.ok(text.includes('- `D2` [active]: Use SVG instead.'));
    assert.ok(text.includes('- `F2` [active]: SVG is available.'));
    assert.ok(text.includes('`lint` [active] tier fast'));
  });
});

describe('spec patch', () => {
  it('spec.patch-stale-refused', async () => {
    assert.throws(() => applySpecPatch(SPEC, patch([{ op: 'strike', id: 'A1' }], 2)),
      (e: unknown) => e instanceof SpecPatchStaleError && e.expectRev === 2 && e.actualRev === 1);
    const patched = applySpecPatch(SPEC, REDIRECT);
    assert.throws(() => applySpecPatch(patched, REDIRECT), SpecPatchStaleError, 'a patch applies to one rev only');
    // The op refuses at prepare, before any intent or write.
    const path = authored(tmpDir('spec'));
    const before = readFileSync(path);
    await assert.rejects(specPatchFileOp.prepare({ path, patch: patch([{ op: 'strike', id: 'A1' }], 2) }), SpecPatchStaleError);
    assert.ok(readFileSync(path).equals(before));
  });

  it('spec.patch-ops', () => {
    const snapshot = JSON.stringify(SPEC);
    const next = applySpecPatch(SPEC, REDIRECT);
    assert.equal(JSON.stringify(SPEC), snapshot, 'applySpecPatch is pure');
    assert.deepEqual(ids(next), [
      'unit-tests:active', 'estateJourney:active', 'lint:active',
      'A1:struck', 'A2:active', 'A3:active',
      'D1:deferred', 'D2:active',
      'F1:active', 'F2:active',
    ]);
    assert.deepEqual(next.acceptance[0], { ...SPEC.acceptance[0], state: 'struck' }, 'strike keeps the item');
    assert.deepEqual(next.decisions[0], { ...SPEC.decisions[0], state: 'deferred' }, 'defer keeps the item');
    assert.equal(next.acceptance[1]!.clause, 'The widget is green.');
    assert.deepEqual(next.scope, SPEC.scope);
    assert.deepEqual(next.resources, SPEC.resources);
    // The result is a valid spec.
    assert.deepEqual(specM1(JSON.parse(specBytes(next).toString('utf8')), 'spec'), next);

    const refused = (spec: SpecM1, ops: readonly unknown[], index: number, reason: string, id: string): void => {
      assert.throws(() => applySpecPatch(spec, patch(ops, spec.rev)),
        (e: unknown) => e instanceof SpecPatchOpError && e.index === index && e.reason === reason && e.id === id, `${reason} ${id}`);
    };
    const note = (id: string) => ({ id, text: 'x' });
    // Ids are never reused: not a live id, not a struck one, not one from another section.
    refused(SPEC, [{ op: 'add', section: 'facts', item: note('F1') }], 0, 'id-reused', 'F1');
    refused(next, [{ op: 'add', section: 'acceptance', item: { id: 'A1', clause: 'again', failLoudIfUndelivered: false } }], 0, 'id-reused', 'A1');
    refused(SPEC, [{ op: 'add', section: 'decisions', item: note('unit-tests') }], 0, 'id-reused', 'unit-tests');
    refused(SPEC, [{ op: 'add', section: 'facts', item: note('F9') }, { op: 'add', section: 'decisions', item: note('F9') }], 1, 'id-reused', 'F9');
    refused(SPEC, [{ op: 'strike', id: 'Z9' }], 0, 'unknown-id', 'Z9');
    refused(SPEC, [{ op: 'defer', id: 'Z9' }], 0, 'unknown-id', 'Z9');
    refused(SPEC, [{ op: 'replace', section: 'facts', item: note('Z9') }], 0, 'unknown-id', 'Z9');
    refused(SPEC, [{ op: 'replace', section: 'facts', item: note('D1') }], 0, 'wrong-section', 'D1');
    refused(next, [{ op: 'replace', section: 'decisions', item: note('D1') }], 0, 'not-active', 'D1');
    refused(next, [{ op: 'defer', id: 'A1' }], 0, 'not-active', 'A1');
    refused(next, [{ op: 'strike', id: 'A1' }], 0, 'already-struck', 'A1');
    // A deferred item can still be struck.
    assert.equal(applySpecPatch(next, patch([{ op: 'strike', id: 'D1' }], 2)).decisions[0]!.state, 'struck');
    // Cites only grow: a cite op adds (sorted, a repeat already there); an empty one is refused; no op removes one.
    const cited = applySpecPatch(SPEC, patch([{ op: 'cite', contracts: ['docs/b.md', 'docs/widget.md'], rulings: ['C-1'] }]));
    assert.deepEqual(cited.cites, { contracts: ['docs/b.md', 'docs/widget.md'], rulings: ['C-1', 'C-2'] });
    assert.deepEqual(specM1(JSON.parse(specBytes(cited).toString('utf8')), 'spec'), cited);
    assert.throws(() => patch([{ op: 'cite', contracts: [], rulings: [] }]), SchemaError);
    assert.throws(() => patch([{ op: 'uncite', contracts: ['docs/widget.md'], rulings: [] }]), SchemaError);
    // Scope and resources are not patchable in M1: the frozen validator refuses them by field.
    for (const section of ['scope', 'resources']) {
      assert.throws(() => patch([{ op: 'add', section, item: { id: 'S1', text: 'x' } }]),
        (e: unknown) => e instanceof SchemaError && e.field === 'patch.ops[0].section', section);
    }
  });
});

describe('spec.patch op and reconciler', () => {
  function childEnv(trigger: string | undefined): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env['ROADMAP_TEST_CRASH'];
    if (trigger !== undefined) env['ROADMAP_TEST_CRASH'] = trigger;
    return env;
  }

  /** A run dir, an authored spec and the redirect patch file for the child. */
  function scenario(): { runDir: string; path: AbsPath; patchFile: string; oldSha: string; newSha: string } {
    const runDir = tmpDir('spec-run');
    const path = authored(tmpDir('spec'));
    const patchFile = join(runDir, 'patch.json');
    writeFileSync(patchFile, JSON.stringify(REDIRECT));
    return { runDir, path, patchFile, oldSha: fileSha256(path), newSha: bytesSha256(specBytes(applySpecPatch(SPEC, REDIRECT))) };
  }

  async function runChild(s: ReturnType<typeof scenario>, trigger: string | undefined): Promise<void> {
    const exit = await runFixture('spec-patch-child.ts', [s.runDir, ARC, s.path, s.patchFile], { env: childEnv(trigger), timeoutMs: CHILD_TIMEOUT_MS });
    if (trigger === undefined) {
      assert.equal(exit.code, 0, exit.stderr);
    } else {
      assert.equal(exit.signal, 'SIGKILL', `child was expected to crash: code ${exit.code}, stderr ${exit.stderr}`);
      assertFired(trigger);
    }
  }

  /** The one open intent a crashed child left, which must be a spec.patch. */
  function openSpecIntent(runDir: string): IntentOf<'spec.patch'> {
    const j = openJournal(absPath(runDir), ARC);
    const open = j.view.openIntents();
    j.close();
    assert.equal(open.length, 1);
    const intent = open[0]!;
    assert.equal(intent.kind, 'spec.patch');
    return intent as IntentOf<'spec.patch'>;
  }

  it('a clean run patches the file to the recorded hash and closes the op', async () => {
    const s = scenario();
    await runChild(s, undefined);
    assert.equal(fileSha256(s.path), s.newSha);
    assert.equal(loadSpec(s.path).rev, 2);
    const j = openJournal(absPath(s.runDir), ARC);
    const derived = j.derived();
    assert.equal(j.view.openIntents().length, 0);
    j.close();
    assert.equal(derived.lastSeq, 2);
  });

  it('prepare records old and new hashes and revs', async () => {
    const s = scenario();
    const body = await specPatchFileOp.prepare({ path: s.path, patch: REDIRECT });
    assert.deepEqual(body, { expect: { path: s.path, oldSha256: s.oldSha, expectRev: 1, patch: REDIRECT }, post: { newSha256: s.newSha, newRev: 2 } });
  });

  describe('spec.patch-crash-cells (matrix: spec.patch)', () => {
    // Per label: the disposition recovery must reach, and the hash the crash leaves on disk.
    const ORACLE: Record<string, { disposition: 'redo' | 'done'; onDisk: 'old' | 'new' }> = {
      'spec.patch.before-write': { disposition: 'redo', onDisk: 'old' },
      'spec.patch.after-write': { disposition: 'done', onDisk: 'new' },
    };
    const cells = crashCells(SPEC_PATCH);
    it('the oracle covers exactly the matrix cells', () => {
      assert.deepEqual(cells.map((c) => c.label).sort(), Object.keys(ORACLE).sort());
    });
    for (const cell of cells) {
      it(`${cell.boundary} ${cell.label} #1`, async () => {
        const s = scenario();
        await runChild(s, writeTrigger(tmpDir('spec-trigger'), { label: cell.label, occurrence: 1 }));
        const expected = ORACLE[cell.label]!;
        const onDisk = fileSha256(s.path);
        assert.equal(onDisk, expected.onDisk === 'old' ? s.oldSha : s.newSha);

        const intent = openSpecIntent(s.runDir);
        const j = openJournal(absPath(s.runDir), ARC);
        const disposition = await reconcileSpecPatch(intent, j.view);
        assert.equal(disposition.kind, expected.disposition, JSON.stringify(disposition));
        if (disposition.kind === 'redo') {
          await specPatchFileOp.act(intent);
          j.done(intent.op, 'spec.patch', await specPatchFileOp.verify(intent), 'redone');
        } else if (disposition.kind === 'done') {
          j.done(intent.op, 'spec.patch', disposition.outcome, 'reconciled');
        }
        assert.equal(j.view.openIntents().length, 0);
        j.close();
        assert.equal(fileSha256(s.path), s.newSha);
        assert.deepEqual(loadSpec(s.path), applySpecPatch(SPEC, REDIRECT));
      });
    }
  });

  it('parks when the file is neither old nor new, or missing', async () => {
    const s = scenario();
    await runChild(s, writeTrigger(tmpDir('spec-trigger'), { label: 'spec.patch.before-write', occurrence: 1 }));
    const intent = openSpecIntent(s.runDir);
    const j = openJournal(absPath(s.runDir), ARC);
    writeFileSync(s.path, JSON.stringify({ ...RAW_SPEC, scope: ['elsewhere/**'] }));
    const changed = await reconcileSpecPatch(intent, j.view);
    assert.equal(changed.kind, 'park');
    rmSync(s.path);
    const missing = await reconcileSpecPatch(intent, j.view);
    assert.equal(missing.kind, 'park');
    j.close();
  });

  it('act refuses a file that no longer hashes to old, and verify one that does not hash to new', async () => {
    const s = scenario();
    const body = await specPatchFileOp.prepare({ path: s.path, patch: REDIRECT });
    const j = openJournal(absPath(s.runDir), ARC);
    const { op } = j.begin({ kind: 'spec.patch', key: SPEC_KEY, parent: { type: 'arc' }, deadlineAt: null, body: () => body });
    const intent = j.view.latestIntent(op) as IntentOf<'spec.patch'>;
    j.close();
    await assert.rejects(specPatchFileOp.verify(intent), /expected/);
    writeFileSync(s.path, JSON.stringify(RAW_SPEC));
    await assert.rejects(specPatchFileOp.act(intent), /expected the old/);
  });
});

describe('rulings ledger', () => {
  const ledger = (lines: readonly string[]) => parseRulings(lines.join('\n'), 'rulings.md');

  it('rulings.lean-and-fold: rule text only; a withdrawn ruling folds to one line naming a ledger ruling', () => {
    assert.deepEqual(ledger(['# Rulings', '', 'C-1 — Helpers live in src/.', 'C-2 — withdrawn by C-3', 'C-3 — Helpers live in lib/.']), [
      { id: 'C-1', status: 'active', text: 'Helpers live in src/.' },
      { id: 'C-2', status: 'withdrawn', by: 'C-3' },
      { id: 'C-3', status: 'active', text: 'Helpers live in lib/.' },
    ]);
    assert.throws(() => ledger(['C-1 — withdrawn by C-9']), SchemaError, 'the withdrawing ruling must be in the ledger');
    assert.throws(() => ledger(['C-1 — One.', 'C-1 — Two.']), SchemaError, 'an id listed twice');
    assert.throws(() => ledger(['C-1: no em dash']), SchemaError);
  });
});
