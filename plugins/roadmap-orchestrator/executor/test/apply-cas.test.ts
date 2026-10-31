// CAS cutover (2026-10-16; src/input/rebase.ts, src/commands/apply.ts): an apply puts in force the owner's files merged
// three-way from their base onto the files in force, so an executor act since the base is kept and only a true conflict
// refuses. Over unit-common arcs (real git, the command path, the executor's own `spec.patch` op). Named tests:
// rebase.export-race, rebase.same-spec-other-field, rebase.same-field-conflict, rebase.start-keeps-executor-acts.
import assert from 'node:assert/strict';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { test } from 'node:test';
import { type CommandOutcome,applyCommand } from '../src/commands/apply.ts';
import { exportInputs } from '../src/commands/inputs.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { arcId,clauseId,invocationIdOf,unitId } from '../src/core/ids.ts';
import type { CommandBody,SpecPatchOp } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { runDir } from '../src/input/cli.ts';
import { inForceFiles,requirePlanInForce,revisionInForce } from '../src/input/inforce.ts';
import { pinDispatch,runOp } from '../src/pipeline/dispatch.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { gitCommonDir } from '../src/preflight/checks.ts';
import { specPatchOp } from '../src/spec/patch.ts';
import { type ArcDescriptor,type ArcRun,applyBody,commandContextFor,contextFor,setupArc } from './fixtures/unit-common.ts';
import { tmpDir } from './helpers/repo.ts';

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

test('CAS: untouched files take in-force bytes; edited specs auto bump without a manual rev', T, async () => {
  const r = twoUnitArc();
  try {
    const exported = await exportInputs({repo: absPath(r.d.repo), arc: arcId(r.d.arc), out: absPath(join(tmpDir('cas'), 'out'))});
    await machinePatch(r, 'u1', [DECISION]);
    editSpec(r.d, 'u2', (s) => { s['acceptance'] = [...s['acceptance'] as Json[], {id: 'A2', clause: 'zero works', failLoudIfUndelivered: true, state: 'active'}]; });
    const out = await command(r, {...applyBody(r.d, exported.base), rev: exported.planRev});
    assert.equal(out.kind, 'applied', JSON.stringify(out));
    assert.equal(specInForce(r, 'u1').rev, 2);
    assert.equal(specInForce(r, 'u1').decisions.length, 1);
    assert.equal(specInForce(r, 'u2').rev, 2);
    assert.equal(specInForce(r, 'u2').acceptance.length, 2);
  } finally {r.journal.close();}
});
test('CAS: all stale edited files are refused together, including disjoint edits within a file', T, async () => {
  const r = twoUnitArc();
  try {
    const exported = await exportInputs({repo: absPath(r.d.repo), arc: arcId(r.d.arc), out: absPath(join(tmpDir('cas-stale'), 'out'))});
    await machinePatch(r, 'u1', [DECISION]);
    await machinePatch(r, 'u2', [DECISION]);
    editSpec(r.d, 'u1', addAcceptance); editSpec(r.d, 'u2', addAcceptance);
    const out = await command(r, {...applyBody(r.d, exported.base), rev: exported.planRev});
    assert.equal(out.kind, 'rejected');
    if (out.kind !== 'rejected') throw new Error('stale edit applied');
    assert.match(out.reason, /u1.json/); assert.match(out.reason, /u2.json/);
    assert.equal(r.journal.view.planApplied()?.rev, 1);
  } finally {r.journal.close();}
});
