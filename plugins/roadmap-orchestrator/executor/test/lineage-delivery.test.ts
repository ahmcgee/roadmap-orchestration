// dev.81 (A1): obligations delivered through a re-entry (src/input/lineage.ts `deliverers`/`delivers`), over a real arc
// (real git, real processes, fake backends, fake witness lanes scripted per tree). u2 publishes first; u1 parks at the
// escalation seat and is re-entered as u1-r1, whose spec carries a witness item naming I-1. Then: the apply accepts that
// item (the re-entry delivers I-1 through its lineage), u1-r1's required witnesses carry both obligations' targets, and
// its publication latches I-1 (delivered by u1 alone) and I-2 (co-delivered by u1 and the merged u2), each fact naming
// u1-r1, the publishing unit. Named tests: lineage-delivery.reentry-latches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type Sha, sha, unitId } from '../src/core/ids.ts';
import { isAncestor } from '../src/git/ff.ts';
import { requiredWitnesses } from '../src/holistic/required.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { holisticInForce, loadUnitSpec } from '../src/pipeline/stages.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { editPlan, editSpec } from './fixtures/route-common.ts';
import { addUnit } from './fixtures/sched-m3-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, U1, applyBody, codexStep, commandContextFor, contextFor, gateStep, outcomes } from './fixtures/unit-common.ts';
import { git } from './helpers/repo.ts';
import type { Step } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const R1 = unitId('u1-r1');
const U2 = unitId('u2');

const moduleFiles = (name: string, op: string): Readonly<Record<string, string>> => ({
  [`src/${name}.js`]: `export function ${name}(a, b) {\n  return a ${op} b;\n}\n`,
  [`test/${name}.test.js`]: `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { ${name} } from '../src/${name}.js';\n\ntest('${name}', () => {\n  assert.equal(typeof ${name}(6, 3), 'number');\n});\n`,
});
const keyed = (unit: string, s: Step): Step => ({ ...s, unit });
const build = (unit: string, files: Readonly<Record<string, string>>): Step => keyed(unit, codexStep([{ type: 'commit', message: `build ${unit}`, files }], { argv: ['exec', '-C'] }));
/** Every in-scope path maps to both obligations (each spec declares them). */
const MAPPED = [{ system: 'app', obligations: ['I-1', 'I-2'] }];
const latched = (r: ArcRun): readonly (readonly string[])[] => r.journal.view.holistic().latched.map((l) => [l.obligation, l.unit]);

test('lineage-delivery.reentry-latches: a re-entry delivers what its parent was named for: the apply accepts its witness item, its required witnesses carry the targets, and its publication latches both obligations naming it', T, async () => {
  const { d } = holisticArc({
    steps: [
      // u2 delivers I-2 with u1: merged first, completing nothing. It adds mul, which every unit's spec lane tests.
      keyed('u2', planCheckStep({ decision: 'approve' })), build('u2', { ...moduleFiles('mul', '*'), ...moduleFiles('div', '/') }), keyed('u2', gateStep({ decision: 'approve' })),
      // u1: built, then escalated twice: the park its re-entry fixes.
      keyed('u1', planCheckStep({ decision: 'approve' })), build('u1', moduleFiles('sub', '-')), keyed('u1', gateStep({ decision: 'escalate' })), keyed('u1', gateStep({ decision: 'escalate' })),
      // u1-r1 (its branch starts at u1's): pre-build, a fresh build, the gate.
      keyed('u1-r1', planCheckStep({ decision: 'approve' })), build('u1-r1', moduleFiles('pow', '**')), keyed('u1-r1', gateStep({ decision: 'approve' })),
    ],
    units: [{ id: 'u1', obligations: ['I-1', 'I-2'] }, { id: 'u2', obligations: ['I-1', 'I-2'] }],
    obligations: [{ id: 'I-1', activation: 'future', deliveredBy: ['u1'], testIds: ['t1'] }, { id: 'I-2', activation: 'future', deliveredBy: ['u1', 'u2'], testIds: ['t2'] }],
    mapping: MAPPED, trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
  });
  let r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), admitAll), { kind: 'merged' }, outcomes(d, 'u2').join(' '));
    assert.deepEqual(latched(r), [], 'u2 alone completes nothing');
    const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'escalation', JSON.stringify(parked));
    const at = r.journal.view.unit(U1).decided!;
    raiseNeedsUser(r.journal, r.ctx.runDir, parked.needsUser, { type: 'stage', unit: U1, stage: at.stage, attempt: at.attempt });

    // The re-entry, with a witness item naming I-1 (delivered by u1 as declared): new in the same revision.
    addUnit(d, 'u1-r1');
    editSpec(d, 'u1-r1', (s) => {
      s['witnesses'] = [{ id: 'W-1', lane: 'journey', testId: 't1', clause: 'A1', skeleton: 'mul multiplies', obligation: 'I-1', state: 'active' }];
    });
    editPlan(d, (p) => Object.assign(p.units.find((u) => u['id'] === 'u1-r1')!, { reenters: { unit: 'u1', fixes: `u1/${at.stage}#${at.attempt}` } }));
    const applied = await applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(d)));
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    r.journal.close();
    r = contextFor(d);
    assert.equal(r.journal.view.unit(U1).supersededBy, R1);

    // The comparator itself (`requiredAt` is empty outside a corpus arc), on the tip with the repo's ancestry.
    const tip = sha(git(d.repo, 'rev-parse', 'main'));
    const tree = { sha: tip, isAncestor: (c: Sha) => isAncestor(r.ctx.repo, c, tip) };
    const required = requiredWitnesses(r.journal.view, holisticInForce(r.ctx).obligations!, R1, loadUnitSpec(r.ctx, r.unit('u1-r1')).spec, tree);
    const rows = required.map((w) => `${w.role} ${w.source.id} ${w.testId}`);
    assert.deepEqual(rows, ['target I-1 t1', 'target W-1 t1', 'target I-2 t2'], 'I-1 through the lineage; I-2 with u2 merged into the tip');

    assert.deepEqual(await runUnit(r.ctx, r.unit('u1-r1'), admitAll), { kind: 'merged' }, outcomes(d, 'u1-r1').join(' '));
    assert.deepEqual(latched(r), [['I-1', 'u1-r1'], ['I-2', 'u1-r1']], 'each latch names the publishing re-entry');
    assert.equal(r.journal.view.unit(U2).status, 'retired');
  } finally {
    r.journal.close();
  }
});
