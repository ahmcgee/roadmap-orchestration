// dev.13 unit tests (plan §7 "Unit tests"): the milestone node over DAG shapes (src/walk/node.ts), the rounds brake and
// the milestone states (src/walk/milestones.ts), a walk report's validation and minting (src/walk/report.ts), the port
// placeholder (src/walk/bringup.ts) and the MCP config's substitutions (src/walk/walk.ts). Pure: plans and views are
// built in place (only the fields each function reads).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { WalkFact } from '../src/core/events.ts';
import type { FindingId, JobId, MilestoneId, UnitId } from '../src/core/ids.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import type { FindingState } from '../src/core/state.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import type { RepairUnit } from '../src/holistic/findings.ts';
import type { Vision } from '../src/holistic/types.ts';
import type { Milestone, PlanM1, PlanUnit } from '../src/input/plan.ts';
import { validateWalkthroughOutput } from '../src/prompts/schemas.ts';
import { substitutePorts } from '../src/walk/bringup.ts';
import { milestoneProgress, milestoneState, walkItemsDue, walksPending } from '../src/walk/milestones.ts';
import { milestoneEdges, milestoneWaits } from '../src/walk/node.ts';
import { coversReference, evidencePath, walkDraft, walkRefusals } from '../src/walk/report.ts';
import { walkSessionMcp } from '../src/walk/walk.ts';
import { polishDue } from '../src/walk/polish.ts';
import { COMPARE_ATTEMPTS, failedCompares, touchesReference } from '../src/walk/compare.ts';
import { admitter } from '../src/schedule/ready.ts';
import { canonicalJson } from '../src/core/json.ts';
import { tmpDir } from './helpers/repo.ts';
import { J1_EVIDENCE, walkAnswer } from './fixtures/walk-common.ts';

type U = Readonly<{ id: string; after?: readonly string[]; origin?: string; reenters?: string; polish?: Readonly<{ milestone: string; proposal: string }> }>;

const MILESTONE = (id: string, units: readonly string[], extra: Partial<Milestone> = {}): Milestone => ({
  id: id as MilestoneId, text: `${id} text`, units: units as UnitId[], design: { supplied: true }, references: ['design' as never],
  bringUp: { setup: [], serve: [], env: {}, seed: [] },
  journeys: [{ id: 'J-1' as never, text: 'j1', via: 'shell', entry: 'cli', budget: null }, { id: 'J-2' as never, text: 'j2', via: 'shell', entry: 'cli', budget: null }],
  resources: [], ...extra,
});

/** The fields of a plan the walk code reads: units (after, origin, re-entry, polish), milestones, limits. */
function planOf(units: readonly U[], milestones: readonly Milestone[], walkRounds?: number): PlanM1 {
  return {
    units: units.map((u) => ({
      id: u.id, after: u.after ?? [], ...(u.origin === undefined ? {} : { origin: u.origin }), ...(u.reenters === undefined ? {} : { reenters: { unit: u.reenters } }),
      ...(u.polish === undefined ? {} : { polish: u.polish }),
    })),
    milestones,
    ...(walkRounds === undefined ? {} : { limits: { walkRounds } }),
  } as unknown as PlanM1;
}

type WalkFactSpec = WalkFact;
const VISION_IN_FORCE = 'v'.repeat(64);
/** A view over walk facts, unit statuses, findings and decided checkpoints (seq order as given). */
function viewOf(o: Readonly<{
  walks?: readonly WalkFactSpec[]; status?: Readonly<Record<string, string>>; superseded?: Readonly<Record<string, string>>; findings?: readonly Partial<FindingState>[];
  /** Decided checkpoints: their capture's seq, the findings it captured, and its vision (absent: the vision in force). */
  checkpoints?: readonly Readonly<{ seq: number; findings: readonly string[]; vision?: string }>[];
  /** Per milestone, the seq of the latest apply that edited its bring-up or journeys (`rewalkSeq`; absent: 0). */
  rewalks?: Readonly<Record<string, number>>;
}>): JournalView {
  const walkFacts = (o.walks ?? []).map((fact, i) => ({ seq: 10 * (i + 1), at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), fact }));
  return {
    walkFacts: () => walkFacts,
    unit: (id: string) => ({ status: o.status?.[id] ?? 'active', supersededBy: o.superseded?.[id] ?? null }),
    holistic: () => ({
      findings: (o.findings ?? []).map((f) => ({ lens: 'walkthrough', severity: 'P1', state: 'open', ...f })),
      checkpoints: (o.checkpoints ?? []).map((c) => ({ inputs: { seq: c.seq, findings: c.findings, visionSha256: c.vision ?? VISION_IN_FORCE }, decided: { kind: 'no-op' } })),
    }),
    planApplied: () => ({ visionSha256: VISION_IN_FORCE }),
    rewalkSeq: (m: string) => o.rewalks?.[m] ?? 0,
  } as unknown as JournalView;
}

const W = (n: number): JobId => `walk-${n}` as JobId;
const started = (n: number, round: number, milestone = 'MS-1'): WalkFact => ({ kind: 'walk-started', job: W(n), milestone: milestone as MilestoneId, round, sha: 'a'.repeat(40) as never, ports: {} });
const ended = (n: number, outcome: 'reported' | 'bring-up-failed' | 'abandoned', findings: readonly string[] = [], proposals: readonly string[] = [], dropped: readonly string[] = []): WalkFact => ({
  kind: 'walk-ended', job: W(n), outcome, findings: findings as FindingId[], proposals: proposals as never[], dropped: dropped as never[],
});
const passed = (n: number): WalkFact => ({ kind: 'milestone-passed', milestone: 'MS-1' as MilestoneId, job: W(n) });
const repairing = (unit: string, finding: string): RepairUnit => ({ unit: unit as UnitId, repairs: [finding as FindingId], progress: { kind: 'working' } });

describe('the milestone node (src/walk/node.ts)', () => {
  const edges = (plan: PlanM1) => Object.fromEntries([...milestoneEdges(plan)].map(([u, ms]) => [u, ms]));

  test('node.chain-and-through: a direct descendant and one through a non-milestone unit wait; the milestone\'s own units and an unrelated unit do not', () => {
    const plan = planOf([{ id: 'a' }, { id: 'b', after: ['a'] }, { id: 'c', after: ['b'] }, { id: 'd', after: ['c'] }, { id: 'z' }], [MILESTONE('MS-1', ['a', 'b'])]);
    assert.deepEqual(edges(plan), { c: ['MS-1'], d: ['MS-1'] });
  });

  test('node.diamond: both arms and the join wait on the one node above them', () => {
    const plan = planOf([{ id: 'top' }, { id: 'l', after: ['top'] }, { id: 'r', after: ['top'] }, { id: 'join', after: ['l', 'r'] }], [MILESTONE('MS-1', ['top'])]);
    assert.deepEqual(edges(plan), { l: ['MS-1'], r: ['MS-1'], join: ['MS-1'] });
  });

  test('node.two-milestones: a unit below two milestones waits on both, in plan order; a unit inside one waits on the other above it', () => {
    const plan = planOf([{ id: 'a' }, { id: 'b', after: ['a'] }, { id: 'c', after: ['b'] }], [MILESTONE('MS-1', ['a']), MILESTONE('MS-2', ['b'])]);
    assert.deepEqual(edges(plan), { b: ['MS-1'], c: ['MS-1', 'MS-2'] });
  });

  test('node.lineage: a re-entry of a milestone unit is one of its units; a re-entry of a gated unit is gated; an edge on a superseded unit stands for its lineage', () => {
    const plan = planOf(
      [{ id: 'a' }, { id: 'a2', reenters: 'a', origin: 'checkpoint' }, { id: 'b', after: ['a'] }, { id: 'b2', reenters: 'b', origin: 'checkpoint' }, { id: 'c', after: ['a2'] }],
      [MILESTONE('MS-1', ['a'])],
    );
    assert.deepEqual(edges(plan), { b: ['MS-1'], b2: ['MS-1'], c: ['MS-1'] });
  });

  test('node.exempt: repair, checkpoint-admitted and polish units below a milestone never wait on its node', () => {
    const plan = planOf([
      { id: 'a' }, { id: 'fix', after: ['a'], origin: 'repair' }, { id: 'ck', after: ['a'], origin: 'checkpoint' },
      { id: 'pol', after: ['a'], origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-1' } }, { id: 'planned', after: ['fix'] },
    ], [MILESTONE('MS-1', ['a'])]);
    assert.deepEqual(edges(plan), { planned: ['MS-1'] });
  });

  test('node.passes: the waits drop once milestone-passed is in the log; a plan without milestones has no edges', () => {
    const plan = planOf([{ id: 'a' }, { id: 'b', after: ['a'] }], [MILESTONE('MS-1', ['a'])]);
    assert.deepEqual([...milestoneWaits(viewOf({}), plan)], [['b', ['MS-1']]]);
    assert.deepEqual([...milestoneWaits(viewOf({ walks: [started(1, 1), ended(1, 'reported'), passed(1)] }), plan)], []);
    assert.deepEqual([...milestoneEdges(planOf([{ id: 'a' }, { id: 'b', after: ['a'] }], []))], []);
  });
});

describe('the rounds brake (src/walk/milestones.ts)', () => {
  const m = MILESTONE('MS-1', ['a']);
  const plan = (units: readonly U[] = [{ id: 'a' }], rounds?: number) => planOf(units, [m], rounds);
  const progress = (p: PlanM1, v: JournalView, repairs: readonly RepairUnit[] = []) => milestoneProgress(v, p, m, repairs);

  test('brake.reach: building until every unit merged (by lineage head), then round 1 is due; a running walk is walking', () => {
    assert.equal(progress(plan(), viewOf({})).kind, 'building');
    assert.deepEqual(progress(plan(), viewOf({ status: { a: 'retired' } })), { kind: 'walk-due', round: 1 });
    assert.equal(progress(plan(), viewOf({ status: { a: 'superseded', a2: 'active' }, superseded: { a: 'a2' } })).kind, 'building');
    assert.deepEqual(progress(plan(), viewOf({ status: { a: 'superseded', a2: 'retired' }, superseded: { a: 'a2' } })), { kind: 'walk-due', round: 1 });
    assert.equal(progress(plan(), viewOf({ status: { a: 'retired' }, walks: [started(1, 1)] })).kind, 'walking');
  });

  test('brake.abandoned: an abandoned walk is no round: the same round is due again', () => {
    assert.deepEqual(progress(plan(), viewOf({ status: { a: 'retired' }, walks: [started(1, 1), ended(1, 'abandoned')] })), { kind: 'walk-due', round: 1 });
  });

  test('brake.clean: a round with no findings and no proposals settles at once', () => {
    const p = progress(plan(), viewOf({ status: { a: 'retired' }, walks: [started(1, 1), ended(1, 'reported'), passed(1)] }));
    assert.equal(p.kind, 'settled');
  });

  test('brake.checkpoint-pending: an open finding of the round waits for a checkpoint that weighed it (captured it, decided, under the vision in force); one that admits nothing settles it', () => {
    const walks = [started(1, 1), ended(1, 'reported', ['F-1'])];
    const findings = [{ id: 'F-1' as FindingId, milestone: 'MS-1' as MilestoneId }];
    const open = progress(plan(), viewOf({ status: { a: 'retired' }, walks, findings }));
    assert.ok(open.kind === 'round-open' && open.round.pending === 'checkpoint', JSON.stringify(open));
    assert.equal(progress(plan(), viewOf({ status: { a: 'retired' }, walks, findings, checkpoints: [{ seq: 5, findings: [] }] })).kind, 'round-open', 'a checkpoint before the walk opened F-1 weighed nothing of it');
    assert.equal(progress(plan(), viewOf({ status: { a: 'retired' }, walks, findings, checkpoints: [{ seq: 25, findings: ['F-1'], vision: 'w'.repeat(64) }] })).kind, 'round-open', 'one under another vision weighed it under that one only');
    assert.equal(progress(plan(), viewOf({ status: { a: 'retired' }, walks, findings, checkpoints: [{ seq: 25, findings: ['F-1'] }] })).kind, 'settled');
  });

  test('brake.landed: the next round once every admitted unit is merged or cut and one landed; none landed settles', () => {
    const walks = [started(1, 1), ended(1, 'reported', ['F-1'])];
    const findings = [{ id: 'F-1' as FindingId, milestone: 'MS-1' as MilestoneId, state: 'owned' as const }];
    const units = [{ id: 'a' }, { id: 'r1', origin: 'repair' }, { id: 'r2', origin: 'repair' }];
    const repairs = [repairing('r1', 'F-1'), repairing('r2', 'F-1')];
    const inFlight = progress(plan(units), viewOf({ status: { a: 'retired', r1: 'retired' }, walks, findings }), repairs);
    assert.ok(inFlight.kind === 'round-open' && inFlight.round.pending === null && inFlight.round.inFlight.join() === 'r2', JSON.stringify(inFlight));
    assert.deepEqual(progress(plan(units), viewOf({ status: { a: 'retired', r1: 'retired', r2: 'cut' }, walks, findings }), repairs), { kind: 'walk-due', round: 2 });
    assert.equal(progress(plan(units), viewOf({ status: { a: 'retired', r1: 'cut', r2: 'cut' }, walks, findings }), repairs).kind, 'settled', 'no landing: settle');
  });

  test('brake.polish: applied proposals wait for their units (agent D\'s revision), then count as admitted; the bound stops the rounds', () => {
    const walks = [started(1, 1), ended(1, 'reported', [], ['X-1'])];
    const pending = progress(plan(), viewOf({ status: { a: 'retired' }, walks }));
    assert.ok(pending.kind === 'round-open' && pending.round.pending === 'polish', JSON.stringify(pending));
    const units = [{ id: 'a' }, { id: 'p1', origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-1' } }];
    assert.deepEqual(progress(plan(units), viewOf({ status: { a: 'retired', p1: 'retired' }, walks })), { kind: 'walk-due', round: 2 });
    // Round 2 of 2: its proposals are all dropped (walk-ended.dropped), nothing waits, and the bound settles the milestone.
    const last = [...walks, started(2, 2), ended(2, 'reported', [], ['X-2'], ['X-2'])];
    assert.equal(progress(plan(units, 2), viewOf({ status: { a: 'retired', p1: 'retired' }, walks: last })).kind, 'settled');
    // At the bound with units landed: settled all the same.
    assert.equal(progress(plan(units, 1), viewOf({ status: { a: 'retired', p1: 'retired' }, walks })).kind, 'settled');
  });

  test('brake.states: building, walking, blocked, passed, polishing, settled', () => {
    const st = (v: JournalView, p: PlanM1 = plan()) => milestoneState(v, m.id, milestoneProgress(v, p, m, []));
    assert.equal(st(viewOf({})), 'building');
    assert.equal(st(viewOf({ status: { a: 'retired' } })), 'walking');
    assert.equal(st(viewOf({ status: { a: 'retired' }, walks: [started(1, 1), ended(1, 'reported', ['F-1'])], findings: [{ id: 'F-1' as FindingId, milestone: 'MS-1' as MilestoneId }] })), 'blocked');
    const units = [{ id: 'a' }, { id: 'p1', origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-1' } }];
    const polished = [started(1, 1), ended(1, 'reported', [], ['X-1']), passed(1)];
    assert.equal(st(viewOf({ status: { a: 'retired' }, walks: polished }), plan(units)), 'polishing');
    assert.equal(st(viewOf({ status: { a: 'retired', p1: 'retired' }, walks: polished }), plan(units)), 'passed');
    assert.equal(st(viewOf({ status: { a: 'retired' }, walks: [started(1, 1), ended(1, 'reported'), passed(1)] })), 'settled');
    assert.equal(st(viewOf({ status: { a: 'retired' }, walks: [started(1, 1), ended(1, 'bring-up-failed', ['F-1'])], findings: [{ id: 'F-1' as FindingId, milestone: 'MS-1' as MilestoneId }], checkpoints: [{ seq: 30, findings: ['F-1'] }] })), 'blocked', 'settled unpassed');
  });

  test('brake.escalation: an unowned walk P1 past 6 h, and a milestone settled unpassed, each raise one finding-p1-escalated per walk job', () => {
    const findings = [{ id: 'F-1' as FindingId, milestone: 'MS-1' as MilestoneId }];
    const v = viewOf({ status: { a: 'retired' }, walks: [started(1, 1), ended(1, 'reported', ['F-1'])], findings });
    const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h, 1));
    assert.deepEqual(walkItemsDue(v, plan(), [], at(5)), [], 'before 6 h, and the round still waits for its checkpoint');
    const due = walkItemsDue(v, plan(), [], at(7));
    assert.deepEqual(due.map((i) => [i.job, i.content.reason, i.content.blocking]), [['walk-1', 'finding-p1-escalated', true]]);
    assert.match(due[0]!.content.summary, /F-1/);
    const owned = viewOf({ status: { a: 'retired', r1: 'active' }, walks: [started(1, 1), ended(1, 'reported', ['F-1'])], findings: [{ ...findings[0], state: 'owned' }] });
    assert.deepEqual(walkItemsDue(owned, plan([{ id: 'a' }, { id: 'r1', origin: 'repair' }]), [repairing('r1', 'F-1')], at(7)), [], 'an owned P1 whose repair is in flight is not escalated');
    const settled = viewOf({ status: { a: 'retired' }, walks: [started(1, 1), ended(1, 'reported', ['F-1'])], findings: [{ ...findings[0], state: 'ruled' }], checkpoints: [{ seq: 30, findings: ['F-1'] }] });
    const items = walkItemsDue(settled, plan(), [], at(1));
    assert.deepEqual(items.map((i) => i.job), ['walk-1']);
    assert.match(items[0]!.content.summary, /never passed/);
  });
});

describe('a walk report held to its inputs (src/walk/report.ts)', () => {
  const VISION = {
    clauses: [{ id: 'V-1', kind: 'world', state: 'active' }, { id: 'V-2', kind: 'experience', state: 'withdrawn' }, { id: 'V-3', kind: 'experience', state: 'active' }, { id: 'V-4', kind: 'non-negotiable', state: 'active' }],
  } as unknown as Vision;
  const dir = (): AbsPath => {
    const d = absPath(tmpDir('walk-evidence'));
    mkdirSync(join(d, 'J-1'), { recursive: true });
    writeFileSync(join(d, 'J-1', 'shot.png'), 'png');
    writeFileSync(join(d, J1_EVIDENCE), '200 hello');
    return d;
  };
  const m = MILESTONE('MS-1', ['a'], { references: ['design' as never, 'docs/api' as never] });
  const check = (evidenceDir: AbsPath) => ({ milestone: m, plan: planOf([{ id: 'a' }], [m]), vision: VISION, evidenceDir });
  const answer = (spec: Parameters<typeof walkAnswer>[0]) => validateWalkthroughOutput(walkAnswer(spec));

  test('report.valid: every journey reported, evidence inside the dir (relative or absolute), a design or contract path inside a reference, a floor a non-negotiable clause or a file', () => {
    const d = dir();
    const out = answer({
      journeys: [{ journey: 'J-1', outcome: 'completed', evidence: ['J-1/shot.png'] }, { journey: 'J-2', outcome: 'completed', evidence: [join(d, 'J-1', 'shot.png')] }],
      findings: [
        { class: 'deviates', journey: 'J-1', claim: 'off-token colour', cause: 'card: off-token colour', against: { type: 'design', path: 'design/tokens.css', anchor: '--accent' }, evidence: ['J-1/shot.png'] },
        { class: 'breaks', journey: 'J-2', claim: 'errors exit 0', cause: 'import: errors exit 0', against: { type: 'contract', path: 'docs/api/cli.md', anchor: 'Exit codes', dependents: 'scripts' }, evidence: ['J-1/shot.png'] },
        { class: 'breaks', journey: 'J-2', claim: 'key ignored', cause: 'config: unknown key ignored', against: { type: 'floor', text: 'nothing ignored silently', source: 'V-4' }, evidence: ['J-1/shot.png'] },
        { class: 'breaks', journey: 'J-1', claim: 'low contrast', cause: 'lead: low contrast', against: { type: 'floor', text: '4.5:1', source: 'design/DESIGN.md' }, evidence: ['J-1/shot.png'] },
      ],
    });
    assert.deepEqual(walkRefusals(check(d), out), []);
  });

  test('report.refusals: a journey unreported or unknown, evidence missing or outside, a design or contract path outside the references, a withdrawn or unknown clause, a floor on a clause not non-negotiable', () => {
    const d = dir();
    const out = answer({
      journeys: [{ journey: 'J-1', outcome: 'completed', evidence: ['J-1/missing.png'] }, { journey: 'J-9', outcome: 'completed', evidence: ['../outside.txt'] }],
      findings: [
        { class: 'deviates', journey: 'J-1', claim: 'c1', cause: 'x', against: { type: 'design', path: 'src/app.css', anchor: 'a' }, evidence: ['J-1/shot.png'] },
        { class: 'deviates', journey: 'J-1', claim: 'c2', cause: 'y', against: { type: 'vision', clause: 'V-2' }, evidence: ['J-1/shot.png'] },
        { class: 'breaks', journey: 'J-1', claim: 'c3', cause: 'z', against: { type: 'floor', text: 'contrast', source: 'V-7' }, evidence: ['J-1/shot.png'] },
        { class: 'breaks', journey: 'J-1', claim: 'c4', cause: 'w', against: { type: 'contract', path: 'src/cli.ts', anchor: 'exit', dependents: 'scripts' }, evidence: ['J-1/shot.png'] },
        { class: 'breaks', journey: 'J-1', claim: 'c5', cause: 'v', against: { type: 'floor', text: 'every error says how to fix it', source: 'V-3' }, evidence: ['J-1/shot.png'] },
      ],
    });
    const reasons = walkRefusals(check(d), out);
    assert.equal(reasons.length, 9, reasons.join('\n'));
    assert.ok(reasons.some((r) => /c4.*src\/cli\.ts, which is inside none of MS-1's references/.test(r)));
    assert.ok(reasons.some((r) => /c5.*V-3 as a floor, but its kind is experience/.test(r)));
    assert.ok(reasons.some((r) => /J-2 of MS-1 is not reported/.test(r)));
    assert.ok(reasons.some((r) => /J-9 is no journey of MS-1/.test(r)));
    assert.ok(reasons.some((r) => /missing\.png, which is no file/.test(r)));
    assert.ok(reasons.some((r) => /outside\.txt, which is outside the evidence dir/.test(r)));
    assert.ok(reasons.some((r) => /src\/app\.css, which is inside none of MS-1's references/.test(r)));
    assert.ok(reasons.some((r) => /V-2, which is withdrawn/.test(r)));
    assert.ok(reasons.some((r) => /V-7, which the vision in force does not have/.test(r)));
  });

  test('report.polish-refusals: a scope covering no reference, an id the plan holds, a spec for another unit', () => {
    const d = dir();
    const spec = (unit: string) => ({
      schema: 'roadmap/spec-m1', unit, rev: 1, lanes: [{ id: 'l', argv: ['true'], cwd: '.', env: { set: [], pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], evidenceExcludes: [], state: 'active' }],
      acceptance: [{ id: 'A1', clause: 'c', failLoudIfUndelivered: true, state: 'active' }], scope: ['design/**'], resources: [], decisions: [], facts: [],
      cites: { contracts: [], rulings: [] }, obligations: [], repairs: [],
    });
    const out = answer({
      polish: [
        { journey: 'J-1', text: 'p1', unit: { id: 'x-ok', scope: ['design/tokens.css'], spec: spec('x-ok') } },
        { journey: 'J-1', text: 'p2', unit: { id: 'x-src', scope: ['src/**'], spec: spec('x-src') } },
        { journey: 'J-1', text: 'p3', unit: { id: 'a', scope: ['design/**'], spec: spec('a') } },
        { journey: 'J-1', text: 'p4', unit: { id: 'x-other', scope: ['docs/**'], spec: spec('x-ok') } },
      ],
    });
    const reasons = walkRefusals(check(d), out).filter((r) => r.startsWith('polish'));
    assert.equal(reasons.length, 3, reasons.join('\n'));
    assert.match(reasons[0]!, /x-src.*covers none of MS-1's references/);
    assert.match(reasons[1]!, /a is already a unit of the plan/);
    assert.match(reasons[2]!, /its spec is unit x-ok rev 1/);
  });

  test('report.covers-and-paths: scope coverage and evidence paths', () => {
    const refs = ['design', 'docs/api'] as never[];
    assert.equal(coversReference(refs, ['design/**' as never]), true);
    assert.equal(coversReference(refs, ['docs/**' as never]), true, 'a pattern above a reference holds it');
    assert.equal(coversReference(refs, ['docs/api/errors.md' as never]), true, 'a file inside a reference');
    assert.equal(coversReference(refs, ['designer/**' as never, 'docs/apis/**' as never]), false);
    const d = absPath('/run/evidence/jobs/walk-1');
    assert.equal(evidencePath(d, 'J-1/a.png'), '/run/evidence/jobs/walk-1/J-1/a.png');
    assert.equal(evidencePath(d, '/run/evidence/jobs/walk-1/x'), '/run/evidence/jobs/walk-1/x');
    assert.equal(evidencePath(d, '../walk-2/x'), null);
    assert.equal(evidencePath(d, '/etc/passwd'), null);
  });

  test('mint.class-to-severity: breaks is a P1, deviates a P2, the milestone named, no obligation, a vision clause kept', () => {
    const d = dir();
    const x = { repo: absPath(tmpDir('walk-repo')), job: W(1), sha: 'a'.repeat(40) as never, milestone: m, evidenceDir: d };
    const out = answer({
      findings: [
        { class: 'breaks', journey: 'J-1', claim: 'dead end', cause: 'submit: 404', against: { type: 'journey' }, evidence: ['J-1/shot.png'] },
        { class: 'deviates', journey: 'J-2', claim: 'vague error', cause: 'form: vague error', against: { type: 'vision', clause: 'V-1' }, evidence: ['J-1/shot.png'] },
      ],
    });
    const [p1, p2] = out.findings.map((f) => walkDraft(x, f));
    assert.deepEqual([p1!.lens, p1!.severity, p1!.milestone, p1!.obligation, p1!.visionClauses, p1!.cause], ['walkthrough', 'P1', 'MS-1', null, [], 'submit: 404']);
    assert.deepEqual([p2!.severity, p2!.visionClauses], ['P2', ['V-1']]);
    assert.deepEqual(p1!.evidence, [{ path: join(d, 'J-1', 'shot.png'), blob: null }]);
    assert.match(p1!.claim, /^J-1: dead end/);
  });
});

describe('placeholders', () => {
  test('bringup.ports: {port:<name>} is substituted; a name without a port is a bug', () => {
    assert.equal(substitutePorts('http://127.0.0.1:{port:web}/x?api={port:api}', { web: 4100, api: 4200 } as never), 'http://127.0.0.1:4100/x?api=4200');
    assert.throws(() => substitutePorts('{port:db}', { web: 1 } as never), /\{port:db\} names no allocated port/);
  });

  test('walk.mcp-config: the servers with {evidence} and {viewport} substituted in args and env, none for a shell-only milestone', () => {
    const servers = { pw: { command: 'playwright-mcp', args: ['--output-dir', '{evidence}', '--viewport-size', '{viewport}'], env: { OUT: '{evidence}/x' } } };
    const browser = MILESTONE('MS-1', ['a'], { journeys: [{ id: 'J-1' as never, text: 'j', via: 'browser', entry: '/', budget: null }] });
    const ev = absPath('/run/evidence/jobs/walk-1');
    assert.deepEqual(JSON.parse(walkSessionMcp(servers, browser, ev)!), {
      mcpServers: { pw: { type: 'stdio', command: 'playwright-mcp', args: ['--output-dir', ev, '--viewport-size', '1280x800'], env: { OUT: `${ev}/x` } } },
    });
    assert.equal(walkSessionMcp(servers, MILESTONE('MS-1', ['a']), ev), null);
    assert.throws(() => walkSessionMcp(undefined, browser, ev), /walk-tools-missing/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Agent D: the polish revision's due set, the brake with refused proposals, the compare's code drop and admission

describe('polish and compare (src/walk/polish.ts, src/walk/compare.ts)', () => {
  const m = MILESTONE('MS-1', ['a'], { references: ['design' as never, 'docs/api' as never] });
  const plan = (units: readonly U[] = [{ id: 'a' }], rounds?: number) => planOf(units, [m], rounds);
  const proposed = (n: number, job: number, unit: string): WalkFact => ({
    kind: 'polish-proposed', id: `X-${n}` as never, job: W(job), milestone: 'MS-1' as MilestoneId, journey: 'J-1' as never, evidence: ['/e/shot.png'], text: `tweak ${n}`,
    unit: { id: unit as UnitId, scope: ['design/**' as never], spec: '{}' },
  });
  const refused = (n: number): WalkFact => ({ kind: 'polish-refused', proposal: `X-${n}` as never, reasons: ['its scope covers none of the references'] });

  test('brake.polish-refused: a refused proposal is settled; the round waits only for the rest, and settles when every one was refused', () => {
    const walks = [started(1, 1), proposed(1, 1, 'p1'), proposed(2, 1, 'p2'), ended(1, 'reported', [], ['X-1', 'X-2'])];
    const waiting = milestoneProgress(viewOf({ status: { a: 'retired' }, walks: [...walks, refused(1)] }), plan(), m, []);
    assert.ok(waiting.kind === 'round-open' && waiting.round.pending === 'polish', 'X-2 is neither refused nor carried yet');
    const units = [{ id: 'a' }, { id: 'p2', origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-2' } }];
    const inFlight = milestoneProgress(viewOf({ status: { a: 'retired' }, walks: [...walks, refused(1)] }), plan(units), m, []);
    assert.ok(inFlight.kind === 'round-open' && inFlight.round.pending === null && inFlight.round.inFlight.join() === 'p2', JSON.stringify(inFlight));
    assert.deepEqual(milestoneProgress(viewOf({ status: { a: 'retired', p2: 'retired' }, walks: [...walks, refused(1)] }), plan(units), m, []), { kind: 'walk-due', round: 2 });
    assert.equal(milestoneProgress(viewOf({ status: { a: 'retired' }, walks: [...walks, refused(1), refused(2)] }), plan(), m, []).kind, 'settled', 'all refused: nothing admitted, nothing landed');
  });

  test('polish.due: the first reported walk with an applied proposal neither carried nor refused; dropped proposals never', () => {
    const walks = [started(1, 1), proposed(1, 1, 'p1'), proposed(2, 1, 'p2'), ended(1, 'reported', [], ['X-1', 'X-2'])];
    const due = polishDue(viewOf({ walks }), plan());
    assert.deepEqual([due?.walk.job, due?.proposals.map((p) => p.id)], ['walk-1', ['X-1', 'X-2']]);
    const carried = plan([{ id: 'a' }, { id: 'p1', origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-1' } }]);
    assert.deepEqual(polishDue(viewOf({ walks: [...walks, refused(2)] }), carried), null, 'X-1 carried, X-2 refused');
    const last = [started(1, 1), proposed(1, 1, 'p1'), ended(1, 'reported', [], ['X-1'], ['X-1'])];
    assert.equal(polishDue(viewOf({ walks: last }), plan()), null, 'the last round\'s proposals are dropped, never applied');
  });

  test('compare.reference-untouched: a diff touches a reference only at or under one of its dirs', () => {
    assert.equal(touchesReference(m, ['src/app.ts', 'design.md', 'designs/x.css']), false);
    assert.equal(touchesReference(m, ['src/app.ts', 'design/tokens.css']), true);
    assert.equal(touchesReference(m, ['docs/api']), true);
    assert.equal(touchesReference(m, []), false);
  });

  test('compare.admission: a polish unit\'s candidate waits until its tweak is kept, for ever after a drop; other units and stages never', () => {
    const tweak = (decision: 'keep' | 'drop'): WalkFact => ({ kind: 'tweak-judged', unit: 'p1' as UnitId, decision, reason: 'judged' });
    const p1 = { id: 'p1', origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-1' } } as unknown as PlanUnit;
    const a = { id: 'a' } as unknown as PlanUnit;
    const admit = admitter(() => ({}) as never, () => ({ reproduces: false, repairs: new Set(), links: () => ({ requirements: new Set(), contracts: new Set(), breaks: [] }) }));
    const at = (v: JournalView, unit: PlanUnit, stage: 'candidate' | 'lanes') => {
      const view = {
        ...v, control: () => ({ pausedAll: false, pausedUnits: [] }), runOnly: () => null, backendParks: () => [],
        unit: () => ({ approval: null, pressureHold: null, decided: null }),
      } as unknown as JournalView;
      const out = admit({ view, plan: plan(), unit, stage, blocking: [], drains: [], tripped: [], pressure: { ticks: [], nowMs: 0 } });
      return out.kind === 'admit' ? 'admit' : out.constraints.map((c) => canonicalJson(c));
    };
    assert.deepEqual(at(viewOf({}), p1, 'candidate'), ['{"decision":null,"type":"compare"}']);
    assert.deepEqual(at(viewOf({ walks: [tweak('drop')] }), p1, 'candidate'), ['{"decision":"drop","type":"compare"}']);
    assert.equal(at(viewOf({ walks: [tweak('keep')] }), p1, 'candidate'), 'admit');
    assert.equal(at(viewOf({}), p1, 'lanes'), 'admit');
    assert.equal(at(viewOf({}), a, 'candidate'), 'admit');
  });
});

describe('the abandonment brakes (lead ruling 2026-10-18)', () => {
  const m = MILESTONE('MS-1', ['a']);
  const plan = (units: readonly U[] = [{ id: 'a' }]) => planOf(units, [m]);
  const interrupted = (n: number): WalkFact => ({ ...(ended(n, 'abandoned') as Extract<WalkFact, { kind: 'walk-ended' }>), interrupted: true });

  test('brake.walk-abandoned: a round gets one retry; a second failed walk ends it abandoned (not settled, no walk due), an interrupted walk is no try', () => {
    const p = (walks: readonly WalkFact[], units?: readonly U[]) => milestoneProgress(viewOf({ status: { a: 'retired', r1: 'retired' }, walks, findings: [{ id: 'F-1' as FindingId, milestone: 'MS-1' as MilestoneId, state: 'owned' }] }), plan(units), m, [repairing('r1', 'F-1')]);
    assert.deepEqual(p([started(1, 1), ended(1, 'abandoned')]), { kind: 'walk-due', round: 1 }, 'one retry');
    assert.deepEqual(p([started(1, 1), interrupted(1), started(2, 1), interrupted(2), started(3, 1), ended(3, 'abandoned')]), { kind: 'walk-due', round: 1 }, 'interrupted walks are no tries');
    const twice = p([started(1, 1), ended(1, 'abandoned'), started(2, 1), ended(2, 'abandoned')]);
    assert.ok(twice.kind === 'abandoned' && twice.round === 1 && twice.last.job === 'walk-2', JSON.stringify(twice));
    // A later round counts only its own walks: round 1 reported, its repair landed, round 2 abandoned twice.
    const units = [{ id: 'a' }, { id: 'r1', origin: 'repair' }];
    const later = [started(1, 1), ended(1, 'reported', ['F-1']), started(2, 2), ended(2, 'abandoned'), started(3, 2), ended(3, 'abandoned')];
    const r2 = p(later, units);
    assert.ok(r2.kind === 'abandoned' && r2.round === 2 && r2.last.job === 'walk-3', JSON.stringify(r2));
    assert.deepEqual(p(later.slice(0, 4), units), { kind: 'walk-due', round: 2 });
  });

  test('brake.walk-abandoned-escalation: an abandoned round raises one finding-p1-escalated, blocking while the node is unpassed; the state is blocked or settled; nothing is pending', () => {
    const walks = [started(1, 1), ended(1, 'abandoned'), started(2, 1), ended(2, 'abandoned')];
    const v = viewOf({ status: { a: 'retired' }, walks });
    const items = walkItemsDue(v, plan(), [], new Date(Date.UTC(2026, 9, 1, 0, 5)));
    assert.deepEqual(items.map((i) => [i.job, i.content.reason, i.content.blocking]), [['walk-2', 'finding-p1-escalated', true]]);
    assert.match(items[0]!.content.summary, /round 1 walk failed 2 times.*never passed/);
    assert.equal(milestoneState(v, m.id, milestoneProgress(v, plan(), m, [])), 'blocked');
    assert.equal(walksPending(v, plan(), []), false, 'no walk due: the arc is not held open by it');
    const after1 = viewOf({ status: { a: 'retired', p1: 'retired' }, walks: [started(1, 1), ended(1, 'reported', [], ['X-1']), passed(1), started(2, 2), ended(2, 'abandoned'), started(3, 2), ended(3, 'abandoned')] });
    const units = [{ id: 'a' }, { id: 'p1', origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-1' } }];
    const after = walkItemsDue(after1, planOf(units, [m]), [], new Date());
    assert.deepEqual(after.map((i) => [i.job, i.content.blocking]), [['walk-3', false]], 'passed: told, not blocked');
    assert.equal(milestoneState(after1, m.id, milestoneProgress(after1, planOf(units, [m]), m, [])), 'settled');
  });

  test('brake.walk-rewalk: an apply editing the milestone\'s bring-up or journeys after its abandoned walks is a fresh start: the round is due, its tries counted after the edit, no escalation', () => {
    const twice = [started(1, 1), ended(1, 'abandoned'), started(2, 1), ended(2, 'abandoned')]; // seqs 10..40
    const p = (walks: readonly WalkFact[], rewalk: number) => milestoneProgress(viewOf({ status: { a: 'retired' }, walks, rewalks: { 'MS-1': rewalk } }), plan(), m, []);
    assert.deepEqual(p(twice, 45), { kind: 'walk-due', round: 1 }, 'reset after both tries');
    assert.deepEqual(p(twice, 25), { kind: 'walk-due', round: 1 }, 'reset between them: one try counted');
    assert.equal(p(twice, 5).kind, 'abandoned', 'an edit before the tries resets nothing');
    const thrice = [...twice, started(3, 1), ended(3, 'abandoned')]; // walk-3 at 50, 60
    assert.deepEqual(p(thrice, 45), { kind: 'walk-due', round: 1 }, 'one try since the edit: one retry left');
    const four = [...thrice, started(4, 1), ended(4, 'abandoned')];
    const again = p(four, 45);
    assert.ok(again.kind === 'abandoned' && again.last.job === 'walk-4', JSON.stringify(again));
    assert.deepEqual(walkItemsDue(viewOf({ status: { a: 'retired' }, walks: twice, rewalks: { 'MS-1': 45 } }), plan(), [], new Date()), [], 'the escalation is no longer due');
    // A later round's brake resets the same way.
    const units = [{ id: 'a' }, { id: 'r1', origin: 'repair' }];
    const later = [started(1, 1), ended(1, 'reported', ['F-1']), started(2, 2), ended(2, 'abandoned'), started(3, 2), ended(3, 'abandoned')]; // ..60
    const v = (rewalk: number) => viewOf({ status: { a: 'retired', r1: 'retired' }, walks: later, findings: [{ id: 'F-1' as FindingId, milestone: 'MS-1' as MilestoneId, state: 'owned' }], rewalks: { 'MS-1': rewalk } });
    assert.equal(milestoneProgress(v(0), plan(units), m, [repairing('r1', 'F-1')]).kind, 'abandoned');
    assert.deepEqual(milestoneProgress(v(65), plan(units), m, [repairing('r1', 'F-1')]), { kind: 'walk-due', round: 2 });
  });

  test('brake.compare-abandoned: failed compares of a unit are counted, an interrupted one is not', () => {
    const cs = (n: number, unit: string): WalkFact => ({ kind: 'compare-started', job: `compare-${n}` as JobId, unit: unit as UnitId, before: 'a'.repeat(40) as never, after: 'b'.repeat(40) as never, ports: { before: {}, after: {} } });
    const ca = (n: number, interrupted = false): WalkFact => ({ kind: 'compare-abandoned', job: `compare-${n}` as JobId, detail: 'x', ...(interrupted ? { interrupted: true as const } : {}) });
    const v = viewOf({ walks: [cs(1, 'p1'), ca(1, true), cs(2, 'p1'), ca(2), cs(3, 'p2'), ca(3)] });
    assert.equal(failedCompares(v, 'p1' as UnitId), 1);
    assert.equal(failedCompares(v, 'p2' as UnitId), 1);
    assert.equal(COMPARE_ATTEMPTS, 2);
  });
});
