// M4a rev 3 step N2 (B "Checkpoint admits", OR-A1, LR-k, R44–R48): the admit classifier (src/holistic/admits.ts) over
// hand-built worlds, pure. Named tests: admits.table-row-1..9, admits.table-total, admits.ref-holds-invalid,
// admits.ref-exempt-invalid, admits.ref-resolved-invalid, admits.impact-mapped-not-touched,
// admits.exempt-delivered-not-touched, admits.mixed-finding-keeps-out-of-slice, admits.attr-audit-lens-range,
// admits.attr-witness-union-range, admits.attr-plan-check-ambiguous, admits.attr-issue-ambiguous,
// admits.attr-absolute-paths-ignored, admits.attr-obligation-held-window, admits.attr-shared-file-ambiguous,
// admits.opportunity-clause-without-lineage-spends, admits.follow-up-overrun-converts-with-debt,
// admits.conversion-referenced-is-invalid, admits.dishonest-citation-invalid. The run-9 replay is test/admits-run9.test.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FindingId, JobId, ObligationId, UnitId, VisionClauseId } from '../src/core/ids.ts';
import type { RepairRef } from '../src/core/records.ts';
import { mintDebt } from '../src/debt/mint.ts';
import { DEBT_SCHEMA } from '../src/debt/types.ts';
import {
  type AdmitFinding, type AdmitObligation, type AdmitOp, type AdmitWorld, type AuditRange, type RecordedAdmit, type UnitMerge, classifyAdmits, conversionReasons,
  findingAttribution, obligationAttribution, opportunityClauses,
} from '../src/holistic/admits.ts';
import type { AdmitClass, ObligationDef } from '../src/holistic/types.ts';
import { validateCheckpointOutput } from '../src/prompts/schemas.ts';
import { checkpointAnswer, intakeOutcome } from './helpers/holistic.ts';

const v = (...n: number[]) => n.map((x) => `V-${x}` as VisionClauseId);
const u = (s: string) => s as UnitId;
const job = (s: string) => s as JobId;

function obligation(id: string, serves: readonly VisionClauseId[], over: Partial<{ deliveredBy: readonly string[]; activation: 'must-hold' | 'future'; state: ObligationDef['state'] }> = {}): ObligationDef {
  return {
    id: id as ObligationId, rev: 1, statement: id, serves, witness: { lane: 'journey', testIds: [`t-${id}`] } as unknown as ObligationDef['witness'], proofJudgment: null,
    deliveredBy: (over.deliveredBy ?? []) as UnitId[], activation: over.activation ?? 'must-hold', contracts: [], state: over.state ?? { type: 'active' },
    rule: { id: 'T-1', textSha256: '0'.repeat(64) },
  } as unknown as ObligationDef;
}
const ob = (def: ObligationDef, holding = false, history: AdmitObligation['history'] = []): AdmitObligation => ({ def, holding, history });

function finding(id: string, clauses: readonly VisionClauseId[], over: Partial<AdmitFinding> = {}): AdmitFinding {
  return {
    id: id as FindingId, active: true, captured: true, visionClauses: clauses, obligation: null, lens: 'vision', source: { type: 'job', job: job('audit-1') }, paths: ['src/a.js'], ...over,
  };
}

/** World W = {V-1, V-3, V-4} (V-2 a purpose), slice advances {V-1, V-2}. */
function world(over: Partial<AdmitWorld> & { obligationList?: readonly AdmitObligation[]; findingList?: readonly AdmitFinding[] } = {}): AdmitWorld {
  const { obligationList = [], findingList = [], ...rest } = over;
  return {
    world: v(1, 3, 4), advances: v(1, 2), recorded: [], rootOf: (x) => x,
    obligations: new Map(obligationList.map((o) => [o.def.id, o])), findings: new Map(findingList.map((f) => [f.id, f])),
    audits: new Map([[job('audit-1'), [{ lens: 'vision', from: 0, to: 2 }, { lens: 'drift', from: 1, to: 2 }] as AuditRange[]]]),
    merges: [], ...rest,
  };
}
const admit = (unit: string, cites: readonly VisionClauseId[], repairs: readonly string[] = [], index = 0): AdmitOp => ({ index, unit: u(unit), cites, repairs: repairs as RepairRef[] });
const opp = (unit: string, clauses: readonly VisionClauseId[], id = 'O-1'): RecordedAdmit => ({ job: job('ckpt-1'), index: 0, unit: u(unit), class: { type: 'opportunity', id, clauses } as AdmitClass });
const followUp = (unit: string, refs: readonly string[], o = 'O-1'): RecordedAdmit => ({ job: job('ckpt-2'), index: 0, unit: u(unit), class: { type: 'repair', refs, followUp: o } as AdmitClass });
const merge = (unit: string, position: number, paths: readonly string[] = ['src/a.js']): UnitMerge => ({ unit: u(unit), position, paths });

/** The one outcome of a single-op classification: its class, its conversion, or its reasons. */
function one(w: AdmitWorld, op: AdmitOp) {
  const out = classifyAdmits(w, [op]);
  const n = out.classes.length + out.conversions.length + (out.reasons.length > 0 ? 1 : 0);
  assert.equal(n, 1, `exactly one outcome: ${JSON.stringify(out)}`);
  return out;
}

/** The opportunity O-1 (unit `opp`, clause V-3) merged at position 1 touching src/a.js, and a finding F-1 over V-3 in its range. */
const lineageWorld = (extra: readonly RecordedAdmit[] = []) => world({
  recorded: [opp('opp', v(3)), ...extra], merges: [merge('opp', 1)], findingList: [finding('F-1', v(3))],
});

describe('admit classes: the decision table (R45)', () => {
  test('admits.table-row-1: an invalid repair ref is a reason, never a class', () => {
    const out = one(world({ findingList: [finding('F-1', v(1), { active: false })] }), admit('fix', v(1), ['F-1']));
    assert.match(out.reasons[0]!, /^op 1 \(admit fix\): repair-ref-resolved: F-1/);
  });

  test('admits.table-row-2: a repair attributed wholly to opportunity O-1, out ⊆ OC(O-1), no follow-up yet → O-1 follow-up', () => {
    assert.deepEqual(one(lineageWorld(), admit('fix', v(3), ['F-1'])).classes, [{ index: 0, unit: 'fix', class: { type: 'repair', refs: ['F-1'], followUp: 'O-1' } }]);
  });

  test('admits.table-row-3: the same with O-1 already followed up → converted follow-up-overrun naming O-1 (LR-k)', () => {
    assert.deepEqual(one(lineageWorld([followUp('fix1', ['F-9'])]), admit('fix2', v(3), ['F-1'])).conversions, [{ index: 0, unit: 'fix2', reason: 'follow-up-overrun', opportunity: 'O-1' }]);
  });

  test('admits.table-row-4: a repair touching only the slice, no lineage → repair{followUp: null}', () => {
    const w = world({ findingList: [finding('F-1', v(1))] });
    assert.deepEqual(one(w, admit('fix', v(1), ['F-1'])).classes[0]!.class, { type: 'repair', refs: ['F-1'], followUp: null });
  });

  test('admits.table-row-5 / admits.dishonest-citation-invalid: a repair touching V-3 outside the slice without citing it is invalid', () => {
    const out = one(world({ findingList: [finding('F-1', v(1, 3))] }), admit('fix', v(1), ['F-1']));
    assert.equal(out.reasons.length, 1);
    assert.match(out.reasons[0]!, /dishonest-citation: V-3/);
  });

  test('admits.table-row-6: honest work outside the slice with the budget left → opportunity O-1, its clauses joining advances', () => {
    const out = one(world(), admit('more', v(1, 3)));
    assert.deepEqual(out.classes[0]!.class, { type: 'opportunity', id: 'O-1', clauses: ['V-3'] });
    assert.deepEqual(opportunityClauses(out.classes), ['V-3']);
  });

  test('admits.table-row-7: the same with the budget spent → converted over-budget', () => {
    assert.deepEqual(one(world({ recorded: [opp('opp', v(3))] }), admit('more', v(4))).conversions, [{ index: 0, unit: 'more', reason: 'over-budget', opportunity: null }]);
  });

  test('admits.table-row-8: no repairs, in-slice clauses only → oversight', () => {
    assert.deepEqual(one(world(), admit('gap', v(1, 2))).classes[0]!.class, { type: 'oversight', clauses: ['V-1'] });
  });

  test('admits.table-row-9: no repairs and no world clause touched → converted unrelated', () => {
    assert.deepEqual(one(world(), admit('aside', v(2))).conversions, [{ index: 0, unit: 'aside', reason: 'unrelated', opportunity: null }]);
  });

  test('admits.table-total: every generated combination of refs, attribution, out-of-slice touch, follow-ups and budget lands on exactly one row', () => {
    let n = 0;
    for (const ref of ['none', 'valid-in', 'valid-out', 'invalid'] as const) {
      for (const cites of [v(1), v(3), v(1, 3), v(2), []] as const) {
        for (const lineage of [false, true]) {
          for (const followed of [false, true]) {
            for (const spent of [false, true]) {
              const recorded = [...(spent || lineage ? [opp('opp', v(3))] : []), ...(followed ? [followUp('fix1', ['F-8'])] : [])];
              const f = ref === 'valid-in' ? finding('F-1', v(1)) : ref === 'valid-out' ? finding('F-1', v(3)) : finding('F-1', v(1), { active: ref !== 'invalid' });
              const w = world({ recorded, findingList: [f], merges: lineage ? [merge('opp', 1)] : [merge('other', 1)] });
              one(w, admit('x', cites, ref === 'none' ? [] : ['F-1']));
              n += 1;
            }
          }
        }
      }
    }
    assert.equal(n, 160);
  });

  test('admits.opportunity-clause-without-lineage-spends: work on O-1\'s clause V-3 without its lineage spends budget (over-budget), never a free follow-up', () => {
    assert.equal(one(world({ recorded: [opp('opp', v(3))] }), admit('more', v(3))).conversions[0]!.reason, 'over-budget');
  });

  test('budgets count earlier ops of the same bundle: a second opportunity in one bundle converts over-budget', () => {
    const out = classifyAdmits(world(), [admit('a', v(3), [], 0), admit('b', v(4), [], 1)]);
    assert.deepEqual(out.classes.map((c) => c.class.type), ['opportunity']);
    assert.deepEqual(out.conversions.map((c) => [c.unit, c.reason]), [['b', 'over-budget']]);
  });
});

describe('admit classes: repair refs and touched clauses (R45, R47)', () => {
  test('admits.ref-holds-invalid: repairing an obligation that holds on the head is invalid', () => {
    const out = one(world({ obligationList: [ob(obligation('I-1', v(1)), true)] }), admit('fix', v(1), ['I-1']));
    assert.match(out.reasons[0]!, /repair-ref-holds: I-1/);
  });

  test('admits.ref-exempt-invalid: repairing a deferred obligation is invalid', () => {
    const out = one(world({ obligationList: [ob(obligation('I-1', v(1), { state: { type: 'deferred', ruling: 'C-1' } as ObligationDef['state'] }))] }), admit('fix', v(1), ['I-1']));
    assert.match(out.reasons[0]!, /repair-ref-exempt: I-1 is deferred/);
  });

  test('admits.ref-resolved-invalid: repairing a finding the checkpoint was not given is invalid; an unheld obligation is a valid ref', () => {
    assert.match(one(world({ findingList: [finding('F-1', v(1), { captured: false })] }), admit('fix', v(1), ['F-1'])).reasons[0]!, /repair-ref-resolved: F-1/);
    assert.deepEqual(one(world({ obligationList: [ob(obligation('I-1', v(1)))] }), admit('fix', v(1), ['I-1'])).classes[0]!.class, { type: 'repair', refs: ['I-1'], followUp: null });
  });

  test('admits.impact-mapped-not-touched: an obligation the admit only may affect (not delivered by it) adds no clause', () => {
    const w = world({ obligationList: [ob(obligation('I-2', v(3), { deliveredBy: ['other'], activation: 'future' }), true)] });
    assert.deepEqual(one(w, admit('gap', v(1))).classes[0]!.class, { type: 'oversight', clauses: ['V-1'] });
  });

  test('a delivered obligation counts: delivering I-2 (serving V-3) touches V-3', () => {
    const w = world({ obligationList: [ob(obligation('I-2', v(3), { deliveredBy: ['gap'], activation: 'future' }), true)] });
    assert.match(one(w, admit('gap', v(1))).reasons[0]!, /dishonest-citation: V-3/);
  });

  test('admits.exempt-delivered-not-touched: a waived obligation the admit delivers adds no clause', () => {
    const w = world({ obligationList: [ob(obligation('I-2', v(3), { deliveredBy: ['gap'], activation: 'future', state: { type: 'waived', ruling: 'C-1' } as ObligationDef['state'] }), true)] });
    assert.deepEqual(one(w, admit('gap', v(1))).classes[0]!.class, { type: 'oversight', clauses: ['V-1'] });
  });

  test('admits.mixed-finding-keeps-out-of-slice: a finding over [V-1, V-3] keeps V-3 (Q1): cited, it is an opportunity', () => {
    const w = world({ findingList: [finding('F-1', v(1, 3))] });
    assert.deepEqual(one(w, admit('fix', v(1, 3), ['F-1'])).classes[0]!.class, { type: 'opportunity', id: 'O-1', clauses: ['V-3'] });
  });

  test('a repaired finding\'s obligation serves count: F-1 over V-1 on I-3 (serving V-4) touches V-4', () => {
    const w = world({ findingList: [finding('F-1', v(1), { obligation: 'I-3' as ObligationId })], obligationList: [ob(obligation('I-3', v(4)), true)] });
    assert.match(one(w, admit('fix', v(1), ['F-1'])).reasons[0]!, /dishonest-citation: V-4/);
  });
});

describe('admit classes: attribution (R46)', () => {
  const merges = [merge('a', 1, ['src/a.js']), merge('b', 2, ['src/a.js', 'src/b.js'])];

  test('admits.attr-audit-lens-range: an audit lens finding names the units merged in that lens\'s range touching its paths', () => {
    const w = world({ merges });
    assert.deepEqual(findingAttribution(w, finding('F-1', v(1), { lens: 'drift' })), ['b'], 'drift covered (1, 2]');
    assert.deepEqual(findingAttribution(w, finding('F-1', v(1), { lens: 'vision' })), ['a', 'b'], 'vision covered (0, 2]');
    assert.deepEqual(findingAttribution(w, finding('F-1', v(1), { lens: 'vision', paths: ['src/b.js'] })), ['b'], 'paths filter');
  });

  test('admits.attr-witness-union-range: a witness finding reads the union of its audit\'s ranges', () => {
    const w = world({ merges, audits: new Map([[job('audit-1'), [{ lens: 'drift', from: 0, to: 1 }, { lens: 'vision', from: 1, to: 2 }] as AuditRange[]]]) });
    assert.deepEqual(findingAttribution(w, finding('F-1', v(1), { lens: 'witness' })), ['a', 'b']);
  });

  test('admits.attr-plan-check-ambiguous: a plan-check finding is unattributable, so its repair never follows up an opportunity', () => {
    const f = finding('F-1', v(3), { lens: 'plan-check', source: { type: 'stage', unit: u('opp'), stage: 'plan-check', attempt: 1 } });
    const w = world({ recorded: [opp('opp', v(3))], merges: [merge('opp', 1)], findingList: [f] });
    assert.deepEqual(findingAttribution(w, f), []);
    assert.equal(one(w, admit('fix', v(3), ['F-1'])).conversions[0]!.reason, 'over-budget', 'ambiguity spends budget');
  });

  test('admits.attr-issue-ambiguous: an issue finding is unattributable', () => {
    assert.deepEqual(findingAttribution(world({ merges }), finding('F-1', v(1), { lens: 'issue', source: { type: 'job', job: job('ckpt-3') } })), []);
  });

  test('admits.attr-absolute-paths-ignored: absolute (evidence-dir) paths name no unit', () => {
    const w = world({ merges });
    assert.deepEqual(findingAttribution(w, finding('F-1', v(1), { paths: ['/var/tmp/run/corpus/src/a.js'] })), []);
    assert.deepEqual(findingAttribution(w, finding('F-1', v(1), { paths: ['/var/tmp/run/corpus/x.md', 'src/b.js'] })), ['b']);
  });

  test('admits.attr-obligation-held-window: an obligation names the units after its last held head up to its first not-held one', () => {
    const w = world({ merges: [merge('a', 1), merge('b', 2), merge('c', 3)] });
    const history = [{ position: 0, held: true }, { position: 1, held: true }, { position: 2, held: false }, { position: 3, held: false }];
    assert.deepEqual(obligationAttribution(w, ob(obligation('I-1', v(1)), false, history)), ['b']);
    assert.deepEqual(obligationAttribution(w, ob(obligation('I-1', v(1)), false, [{ position: 2, held: false }])), [], 'never observed held');
  });

  test('admits.attr-shared-file-ambiguous: a path two lineages touched is a partial overlap: no follow-up', () => {
    const w = world({ recorded: [opp('opp', v(3))], merges: [merge('opp', 1), merge('other', 2)], findingList: [finding('F-1', v(3))] });
    assert.deepEqual(findingAttribution(w, finding('F-1', v(3))), ['opp', 'other']);
    assert.equal(one(w, admit('fix', v(3), ['F-1'])).conversions[0]!.reason, 'over-budget');
  });

  test('re-entries share their lineage: a fix of O-1\'s re-entered unit is O-1\'s follow-up', () => {
    const w = world({ recorded: [opp('opp', v(3))], merges: [merge('opp-2', 1)], findingList: [finding('F-1', v(3))], rootOf: (x) => (x === 'opp-2' ? u('opp') : x) });
    assert.deepEqual(one(w, admit('fix', v(3), ['F-1'])).classes[0]!.class, { type: 'repair', refs: ['F-1'], followUp: 'O-1' });
  });
});

describe('admit classes: conversions (R35, LR-k)', () => {
  test('admits.follow-up-overrun-converts-with-debt: the overrun converts and banks one debt item naming O-1, idempotent by source', () => {
    const out = one(lineageWorld([followUp('fix1', ['F-9'])]), admit('fix2', v(3), ['F-1'], 2));
    const c = out.conversions[0]!;
    assert.deepEqual(c, { index: 2, unit: 'fix2', reason: 'follow-up-overrun', opportunity: 'O-1' });
    const baseline = { schema: DEBT_SCHEMA, items: [] } as const;
    const fact = mintDebt(baseline, [], { type: 'opportunity-overrun', opportunity: c.opportunity!, job: job('ckpt-3'), index: c.index, unit: c.unit, what: 'O-1 needed another repair' });
    assert.ok(fact !== null);
    assert.deepEqual([fact.bankReason, fact.source, fact.opportunity], ['opportunity-overrun', { type: 'admit', job: 'ckpt-3', index: 2 }, 'O-1']);
    assert.equal(mintDebt(baseline, [fact], { type: 'opportunity-overrun', opportunity: c.opportunity!, job: job('ckpt-3'), index: 2, unit: c.unit, what: 'again' }), null);
  });

  test('admits.conversion-referenced-is-invalid: another op or an acted intake naming a converted admit makes the bundle invalid', () => {
    const spec = JSON.stringify({ unit: 'aside' });
    const output = validateCheckpointOutput(checkpointAnswer({
      decision: 'bundle',
      ops: [
        { op: 'admit', unit: { id: 'aside', risk: 'low', scope: ['src/**'], after: [], origin: 'checkpoint' }, spec, cites: ['V-2'], evidence: ['e'] },
        { op: 'admit', unit: { id: 'next', risk: 'low', scope: ['src/**'], after: ['aside'], origin: 'checkpoint' }, spec, cites: ['V-1'], evidence: ['e'] },
        { op: 'limits', unit: 'aside', limits: [{ field: 'chargeable', value: 2 }], cites: ['V-1'], evidence: ['e'] },
      ],
      issueIntake: [{ issue: 'issue-1', outcome: intakeOutcome.actedOps([0]) }],
    }));
    const reasons = conversionReasons(output, [{ index: 0, unit: u('aside'), reason: 'unrelated', opportunity: null }]);
    assert.equal(reasons.length, 3, JSON.stringify(reasons));
    assert.match(reasons[0]!, /^op 2 \(admit\) names aside/);
    assert.match(reasons[1]!, /^op 3 \(limits\) names aside/);
    assert.match(reasons[2]!, /^issueIntake acts on issue-1 through op 1/);
    assert.deepEqual(conversionReasons(output, []), []);
  });
});
