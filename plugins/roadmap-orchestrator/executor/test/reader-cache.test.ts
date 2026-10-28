import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { successorOf } from '../src/chain.ts';
import { LogCorruptError, openJournal } from '../src/core/log.ts';
import type { PlanChange } from '../src/core/events.ts';
import { arcId, planRev, specRev, unitId } from '../src/core/ids.ts';
import { appliedRevisions } from '../src/holistic/coverage.ts';
import { readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { absPath } from '../src/core/values.ts';
import { pinDispatch } from '../src/pipeline/dispatch.ts';
import { repairUnits } from '../src/pipeline/reproduce.ts';
import { fileSha256 } from '../src/spec/spec.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';

const routing = { profile: 'default', config: null, arcRoles: 'm4b' } as const;

test('repair spec cache follows evidence edits and keeps pending revisions out until reopen', () => {
  const d = setupArc({ steps: [] });
  const file = join(d.planPath, '..', 'u1.json');
  const edit = (rev: number, repairs: readonly string[]): void => {
    const spec = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...spec, rev, repairs }));
  };
  edit(1, ['F-1']);
  const r = contextFor(d);
  try {
    const unit = r.unit('u1');
    const id = unitId('u1');
    const read = () => repairUnits(r.ctx).map(({ unit, repairs, progress }) => ({ unit, repairs, progress }));
    assert.equal(appliedRevisions(r.ctx).length, 1);
    assert.deepEqual(read(), [{ unit: id, repairs: ['F-1'], progress: { kind: 'working' } }]);
    const first = loadUnitSpec(r.ctx, unit);
    assert.equal(pinDispatch(r.ctx, unit, { rev: first.spec.rev, sha256: first.sha256 }).kind, 'pinned');
    const apply = (editKind: 'evidence' | 'revision', rev: number, repairs: readonly string[]): void => {
      edit(rev, repairs);
      const files = readInputFiles(absPath(d.planPath), absPath(d.repo));
      const changes: readonly PlanChange[] = [{ type: 'spec', unit: id, edit: editKind, specRev: specRev(rev), specSha256: fileSha256(absPath(file)) }];
      recordPlan(r.journal, r.ctx.runDir, files, changes, routing);
    };
    apply('evidence', 1, ['F-2']);
    assert.deepEqual(read()[0]?.repairs, ['F-2']);
    assert.equal(appliedRevisions(r.ctx).length, 2);
    apply('revision', 2, ['F-3']);
    assert.deepEqual(read()[0]?.repairs, ['F-2'], 'a pending revision does not replace the dispatched spec');
    const pending = r.journal.view.unit(id).pendingRevision!;
    r.journal.fact({ kind: 'reopened', unit: id, command: null, specRev: pending.rev, specSha256: pending.sha256 });
    assert.deepEqual(read()[0]?.repairs, ['F-3']);
    assert.equal(r.journal.view.planApplied()?.rev, planRev(3));
    assert.equal(appliedRevisions(r.ctx).length, 3);
    r.journal.fact({ kind: 'stage-outcome', unit: id, stage: 'gate', attempt: r.journal.view.unit(id).counters.attempts + 1, outcome: 'approve', class: 'advance', chargeable: false });
    assert.deepEqual(read()[0]?.progress, { kind: 'approved' }, 'progress is read fresh even when the spec hash is unchanged');
  } finally {
    r.journal.close();
  }
});

test('successor reads the immutable first chain revision and ignores an arc that has not applied a plan', () => {
  const d = setupArc({ steps: [] });
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8'));
  plan.chain = { previousArc: 'previous', previousHead: plan.baseline };
  writeFileSync(d.planPath, JSON.stringify(plan));
  const runtime = join(d.repo, '.git', 'roadmap-runtime');
  const dir = absPath(join(runtime, d.arc));
  mkdirSync(dir, { recursive: true });
  const r = contextFor({ ...d, runDir: dir });
  try {
    recordPlan(r.journal, dir, readInputFiles(absPath(d.planPath), absPath(d.repo)), [], routing);
    assert.equal(successorOf(absPath(d.repo), arcId('previous')), d.arc);
    assert.equal(successorOf(absPath(d.repo), arcId('unrelated')), null);
    const empty = absPath(join(runtime, 'planned-only'));
    mkdirSync(empty);
    openJournal(empty, arcId('planned-only')).close();
    assert.equal(successorOf(absPath(d.repo), arcId('unrelated')), null);
  } finally { r.journal.close(); }
});


test('successor still refuses corruption in the prefix through the first applied plan', () => {
  const d = setupArc({ steps: [] });
  const dir = absPath(join(d.repo, '.git', 'roadmap-runtime', d.arc));
  mkdirSync(dir, { recursive: true });
  const r = contextFor({ ...d, runDir: dir });
  r.journal.close();
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replace(`"arc":"${d.arc}"`, '"arc":"wrong-arc"'));
  assert.throws(() => successorOf(absPath(d.repo), arcId('previous')), (error: unknown) => error instanceof LogCorruptError && error.offset === 0);
});
