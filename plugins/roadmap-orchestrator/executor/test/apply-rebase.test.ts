// Apply rebase (2026-10-16; src/input/rebase.ts, src/commands/apply.ts): an apply puts in force the owner's files merged
// three-way from their base onto the files in force, so an executor act since the base is kept and only a true conflict
// refuses. Over unit-common arcs (real git, the command path, the executor's own `spec.patch` op). Named tests:
// rebase.export-race, rebase.same-spec-other-field, rebase.same-field-conflict, rebase.start-keeps-executor-acts.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type CommandOutcome, applyCommand } from '../src/commands/apply.ts';
import { exportBase, exportInputs } from '../src/commands/inputs.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { arcId, clauseId, invocationIdOf, unitId } from '../src/core/ids.ts';
import type { CommandBody, SpecPatchOp } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { runDir } from '../src/input/cli.ts';
import { inForceFiles, readInputFiles, requirePlanInForce, revisionInForce } from '../src/input/inforce.ts';
import { pinDispatch, runOp } from '../src/pipeline/dispatch.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { gitCommonDir, settlePlan } from '../src/preflight/checks.ts';
import { specPatchOp } from '../src/spec/patch.ts';
import { tmpDir } from './helpers/repo.ts';
import { type ArcDescriptor, type ArcRun, applyBody, commandContextFor, contextFor, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: 60_000 };
type Json = Record<string, unknown>;

const specPath = (d: ArcDescriptor, unit: string): string => join(dirname(d.planPath), `${unit}.json`);
function editSpec(d: ArcDescriptor, unit: string, edit: (spec: Json) => void): void {
  const spec = JSON.parse(readFileSync(specPath(d, unit), 'utf8')) as Json;
  edit(spec);
  writeFileSync(specPath(d, unit), JSON.stringify(spec));
}
const addAcceptance = (s: Json): void => {
  s['acceptance'] = [...(s['acceptance'] as Json[]), { id: 'A2', clause: 'mul(0, 5) is 0', failLoudIfUndelivered: true, state: 'active' }];
  s['rev'] = (s['rev'] as number) + 1;
};

/** Two units, their run dir where `roadmap inputs export` finds it (the repo's), revision 1 recorded by the first context. */
function twoUnitArc(): ArcRun {
  const d = setupArc({ steps: [], units: [{ id: 'u1' }, { id: 'u2' }] });
  const dir = runDir(gitCommonDir(absPath(d.repo)), arcId(d.arc));
  mkdirSync(dir, { recursive: true });
  return contextFor({ ...d, runDir: dir });
}

/** The executor's own spec patch of `unit` at its evidence stage (the implementer's recorded decisions), after its pin. */
async function machinePatch(r: ArcRun, unit: string, ops: readonly SpecPatchOp[]): Promise<void> {
  const u = r.unit(unit);
  const pinned = loadUnitSpec(r.ctx, u);
  assert.equal(pinDispatch(r.ctx, u, { rev: pinned.spec.rev, sha256: pinned.sha256 }).kind, 'pinned');
  const id = unitId(unit);
  const { path, spec, sha256 } = loadUnitSpec(r.ctx, r.unit(unit));
  const attempt = r.journal.view.unit(id).counters.attempts + 1;
  await runOp(r.journal, specPatchOp(r.ctx.runDir), `spec:${unit}`, { type: 'stage', unit: id, stage: 'evidence', attempt }, {
    path, oldSha256: sha256, patch: { expectRev: spec.rev, by: { role: 'executor', inv: invocationIdOf(`${r.d.arc}/9#1`) }, ops },
  });
  r.journal.fact({ kind: 'stage-outcome', unit: id, stage: 'evidence', attempt, outcome: 'captured', class: 'advance', chargeable: false } as Fact);
}
const DECISION: SpecPatchOp = { op: 'add', section: 'decisions', item: { id: clauseId('D1'), text: 'mul is exported from src/mul.js' } };

async function command(r: ArcRun, body: CommandBody): Promise<CommandOutcome> {
  return applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.ctx.plan().arc, body));
}

/** The files in force, as `roadmap inputs export` writes them. */
function inForceNow(r: ArcRun) {
  const inForce = requirePlanInForce(r.ctx.runDir, r.journal.view);
  return inForceFiles(r.ctx.runDir, r.journal.view, inForce, revisionInForce(r.ctx.runDir, inForce), absPath(r.d.planPath), absPath(r.d.repo));
}
const specInForce = (r: ArcRun, unit: string): Json & { rev: number; acceptance: Json[]; decisions: Json[] } =>
  JSON.parse(inForceNow(r).specs.get(unitId(unit))!.bytes!.toString('utf8')) as never;

test('rebase.export-race: the owner exports and edits u2 while the executor patches u1; the apply against the export keeps both', T, async () => {
  const r = twoUnitArc();
  try {
    const out = join(tmpDir('rebase-export'), 'inputs');
    await exportInputs({ repo: absPath(r.d.repo), arc: arcId(r.d.arc), out: absPath(out) });
    // The owner works on the export, synced over their input files.
    for (const f of ['plan.json', 'u1.json', 'u2.json', 'rulings.md']) cpSync(join(out, f), join(dirname(r.d.planPath), f));
    editSpec(r.d, 'u2', addAcceptance);
    // Meanwhile the executor revises u1.
    await machinePatch(r, 'u1', [DECISION]);
    assert.equal(specInForce(r, 'u1').rev, 2);

    const outcome = await command(r, applyBody(r.d, exportBase(absPath(join(out, 'export.json')), 'apply')));
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    const [u1, u2] = [specInForce(r, 'u1'), specInForce(r, 'u2')];
    assert.deepEqual([u1.rev, u1.decisions.map((x) => x['id'])], [2, ['D1']], 'the executor\'s patch of u1 is kept');
    assert.deepEqual([u2.rev, u2.acceptance.map((x) => x['id'])], [2, ['A1', 'A2']], 'the owner\'s edit of u2 is in force');
    assert.equal(JSON.parse(readFileSync(specPath(r.d, 'u1'), 'utf8')).rev, 1, 'the owner\'s u1 file is never written');
  } finally {
    r.journal.close();
  }
});

test('rebase.same-spec-other-field: the owner\'s acceptance edit of a spec the executor patched merges onto the patch at the next rev, from the default base', T, async () => {
  const r = twoUnitArc();
  try {
    await machinePatch(r, 'u1', [DECISION]);
    // The owner's Phase-0 file, never written by the executor: rev 1, a new acceptance clause, rev 2.
    editSpec(r.d, 'u1', addAcceptance);
    const outcome = await command(r, applyBody(r.d));
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    const u = r.journal.view.unit(unitId('u1'));
    assert.equal(u.pendingRevision?.rev, 3, 'the merged spec takes the next rev on top of the executor\'s rev 2');
    const merged = JSON.parse(inForceNow(r).specs.get(unitId('u1'))!.bytes!.toString('utf8')) as Json & { decisions: Json[]; acceptance: Json[] };
    assert.deepEqual([merged.decisions.map((x) => x['id']), merged.acceptance.map((x) => x['id'])], [['D1'], ['A1', 'A2']], 'both changes');
  } finally {
    r.journal.close();
  }
});

test('rebase.same-field-conflict: the owner and the executor changing one JSON path differently refuses the apply, naming the file and the path', T, async () => {
  const r = twoUnitArc();
  try {
    await machinePatch(r, 'u1', [DECISION]);
    editSpec(r.d, 'u1', (s) => {
      s['decisions'] = [{ id: 'D1', text: 'mul lives in src/math.js', state: 'active' }];
      s['rev'] = 2;
    });
    const outcome = await command(r, applyBody(r.d));
    assert.deepEqual(outcome, {
      kind: 'rejected',
      reason: `apply rejected (1 reason): (1) conflict: ${specPath(r.d, 'u1')} at $.decisions[D1].text: you and the arc both changed it since the base`,
    });
    assert.equal(specInForce(r, 'u1').rev, 2, 'nothing applied');
  } finally {
    r.journal.close();
  }
});

test('rebase.start-keeps-executor-acts: a start with the owner\'s unchanged files after an executor patch changes nothing', T, async () => {
  const r = twoUnitArc();
  try {
    await machinePatch(r, 'u1', [DECISION]);
    const revs = r.journal.view.planApplied()?.rev;
    const context = {
      repo: r.ctx.repo, planFile: absPath(r.d.planPath), plan: r.ctx.plan(), specOf: () => null, profile: 'default' as never, arcRoles: 'm4b' as const, runDir: r.ctx.runDir, hostDir: r.ctx.hostDir,
    };
    assert.deepEqual(settlePlan(r.journal, context, readInputFiles(absPath(r.d.planPath), absPath(r.d.repo)), process.env), []);
    assert.equal(r.journal.view.planApplied()?.rev, revs, 'no revision');
    assert.equal(specInForce(r, 'u1').rev, 2, 'the patch stays in force');
  } finally {
    r.journal.close();
  }
});
