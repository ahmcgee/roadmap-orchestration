// dev.13 (SCHEMAS.md "dev.13"): the `milestones` edit class of the classifier (src/input/classify.ts `milestoneRows`) and
// the Phase-0 rows it shares with start and `phase0 check` (src/phase0/rows.ts): `milestones-need-holistic`, the
// advisory `milestone-unit-before-design` and row 11's `milestone-references-oversize` (2026-10-21); and the vision's
// `experience` clause, which the vision skill compiles from its `## Experience standards` section. A corpus arc over
// unit-common's repo for the classifier; the rows over a scratch repo, which row 11 reads the references in.
// Named tests: classify.milestones-* (classify.milestones-rewalk: the walk abandonment brake's reset; classify.milestones-rewalk-bring-up-failed: a failed bring-up's round walked again), phase0.milestones-*,
// vision.experience-clause.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { jobId, milestoneId, sha, unitId } from '../src/core/ids.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath } from '../src/core/values.ts';
import { openFinding } from '../src/holistic/findings.ts';
import { parseVision } from '../src/holistic/types.ts';
import { type Classified, type Proposer, changesScope, classify } from '../src/input/classify.ts';
import { readInputFiles, recordPlan, requirePlanInForce, revisionInForce } from '../src/input/inforce.ts';
import { milestonesOf, parsePlan } from '../src/input/plan.ts';
import { openBlocking, raiseNeedsUser, supersededItems } from '../src/needsuser.ts';
import { milestoneProgress, walkItemsDue } from '../src/walk/milestones.ts';
import { bringUpDraft } from '../src/walk/report.ts';
import { FROM_REF, MILESTONE_REFERENCES_BUDGET, phase0Rows } from '../src/phase0/rows.ts';
import { pinDispatch } from '../src/pipeline/dispatch.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { setupCorpusArc } from './fixtures/corpus-unit.ts';
import { commitAll, makeRepo, tmpDir, writeFiles } from './helpers/repo.ts';
import { type ArcDescriptor, type ArcRun, contextFor, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: 60_000 };
type Json = Record<string, unknown>;
const BASE = { profile: 'default', config: null, arcRoles: 'm4b' } as const;
const SHA = sha('a'.repeat(40));

const MILESTONE = {
  id: 'MS-1', text: 'A developer calls mul from a fresh script.', units: ['u2'], design: { unit: 'u1' }, references: ['design/sdk'],
  bringUp: { setup: [], serve: [], env: {}, seed: [] },
  journeys: [{ id: 'J-1', text: 'I import mul and multiply two numbers.', via: 'shell', entry: 'node', budget: null }],
  resources: [],
};
const TWO = [{ id: 'u1' }, { id: 'u2', after: ['u1'] }] as const;

const editPlan = (d: ArcDescriptor, edit: (p: Json) => void): void => {
  const p = JSON.parse(readFileSync(d.planPath, 'utf8')) as Json;
  edit(p);
  writeFileSync(d.planPath, JSON.stringify(p));
};
const withMilestones = (...ms: Json[]) => (d: ArcDescriptor): void => editPlan(d, (p) => void (p['milestones'] = ms));
const units = (p: Json): Json[] => p['units'] as Json[];

function classifyNow(r: ArcRun, proposer: Proposer = { type: 'apply' }): Classified {
  const { runDir } = r.ctx;
  const inForce = requirePlanInForce(runDir, r.journal.view);
  return classify({
    runDir, view: r.journal.view, inForce, revision: revisionInForce(runDir, inForce), next: readInputFiles(absPath(r.d.planPath), absPath(r.d.repo)), residues: [],
    routing: BASE, proposer,
  });
}
function accepted(v: Classified): Extract<Classified, { kind: 'accepted' }> {
  if (v.kind !== 'accepted') return assert.fail(`expected an accepted change, got ${JSON.stringify(v)}`);
  return v;
}
function reasons(v: Classified): readonly string[] {
  if (v.kind !== 'rejected') return assert.fail(`expected a rejection, got ${JSON.stringify(v)}`);
  return v.reasons;
}
/** Classifies the files and puts them in force, as an accepted apply does. */
function accept(r: ArcRun): void {
  recordPlan(r.journal, r.ctx.runDir, readInputFiles(absPath(r.d.planPath), absPath(r.d.repo)), accepted(classifyNow(r)).changes, BASE);
}
/** `unit` merged: its dispatch pinned and its snapshot published. */
function merge(r: ArcRun, unit: string): void {
  const u = r.unit(unit);
  const { spec, sha256 } = loadUnitSpec(r.ctx, u);
  assert.equal(pinDispatch(r.ctx, u, { rev: spec.rev, sha256 }).kind, 'pinned');
  r.journal.fact({ kind: 'stage-outcome', unit: unitId(unit), stage: 'snapshot', attempt: 1, outcome: 'published', class: 'retire', chargeable: false } as Fact);
}
const walkStarted = (r: ArcRun): void => void r.journal.fact({ kind: 'walk-started', job: jobId('walk', 1), milestone: milestoneId('MS-1'), round: 1, sha: SHA, ports: {} });
const walkEnded = (r: ArcRun): void => void r.journal.fact({ kind: 'walk-ended', job: jobId('walk', 1), outcome: 'reported', findings: [], proposals: [], dropped: [] });

/** A corpus arc over u1 and u2 (u2 after u1) in force; `body` runs on it and the journal closes after. */
async function onCorpusArc(body: (r: ArcRun) => void): Promise<void> {
  const arc = await setupCorpusArc([], { units: TWO });
  const r = contextFor(arc.d);
  try {
    body(r);
  } finally {
    r.journal.close();
  }
}

describe('classify.milestones: the milestones edit class', () => {
  test('classify.milestones-edit: an apply adding milestones is `milestones`, scope none; the walk seats come into force', T, () => onCorpusArc((r) => {
    const cur = r.ctx.plan();
    withMilestones(MILESTONE)(r.d);
    const v = accepted(classifyNow(r));
    assert.deepEqual(v.changes, [{ type: 'milestones' }]);
    assert.deepEqual(changesScope(v.changes, cur, readInputFiles(absPath(r.d.planPath), absPath(r.d.repo)).plan), { type: 'none' });
    assert.deepEqual(v.routings.map((x) => x.milestones), [true], 'the routing with the walk seats in force, for the routing check and the smoke');
  }));

  test('classify.milestones-apply-only: no other proposer changes the milestones', T, () => onCorpusArc((r) => {
    withMilestones(MILESTONE)(r.d);
    assert.deepEqual(reasons(classifyNow(r, { type: 'start' })), ['the milestones change only through an architect `apply`, not a start']);
  }));

  test('classify.milestones-reachable: a milestone added over merged units only is refused', T, () => onCorpusArc((r) => {
    merge(r, 'u2');
    withMilestones(MILESTONE)(r.d);
    assert.deepEqual(reasons(classifyNow(r)), ['milestone MS-1: every unit it lists has merged, so no publication would reach it; list a unit still to merge']);
  }));

  test('classify.milestones-cut-unit: cutting a unit a milestone lists is refused unless the same apply drops it', T, () => onCorpusArc((r) => {
    withMilestones({ ...MILESTONE, design: { supplied: true }, units: ['u1', 'u2'] })(r.d);
    accept(r);
    editPlan(r.d, (p) => void (units(p).find((u) => u['id'] === 'u2')!['cut'] = { reason: 'out of scope' }));
    assert.deepEqual(reasons(classifyNow(r)), ['milestone MS-1 lists u2, cut: a cut unit never merges, so the milestone would never be reached; drop it from the milestone\'s units in the same apply']);
    withMilestones({ ...MILESTONE, design: { supplied: true }, units: ['u1'] })(r.d);
    assert.deepEqual(accepted(classifyNow(r)).changes, [{ type: 'unit-cut', unit: 'u2' }, { type: 'milestones' }]);
  }));

  test('classify.milestones-walked: a milestone being walked is fixed; once walked it stays, with its units and design, and its journeys may change', T, () => onCorpusArc((r) => {
    withMilestones(MILESTONE)(r.d);
    accept(r);
    walkStarted(r);
    const retold = { ...MILESTONE, journeys: [{ ...MILESTONE.journeys[0], text: 'I import mul and multiply 2 by 3.' }] };
    withMilestones(retold)(r.d);
    assert.deepEqual(reasons(classifyNow(r)), ['milestone MS-1 is being walked (walk-1); edit it once the walk ends']);
    editPlan(r.d, (p) => void delete p['milestones']);
    assert.deepEqual(reasons(classifyNow(r)), ['milestone MS-1 has been walked (walk-1); it cannot be removed']);

    walkEnded(r);
    withMilestones({ ...MILESTONE, design: { supplied: true } })(r.d);
    assert.deepEqual(reasons(classifyNow(r)), ['milestone MS-1 has been walked (walk-1): its units and design are fixed; plan another milestone for more']);
    withMilestones(retold)(r.d);
    assert.deepEqual(accepted(classifyNow(r)).changes, [{ type: 'milestones', rewalk: ['MS-1'] }], 'a walked milestone\'s journeys edited: its brake resets');
  }));

  test('classify.milestones-rewalk: an apply editing a walked milestone\'s bring-up resets its walk abandonment brake: the round is due afresh with a fresh attempt count, its escalation superseded', T, () => onCorpusArc((r) => {
    withMilestones(MILESTONE)(r.d);
    accept(r);
    merge(r, 'u2');
    const plan = () => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
    const progress = () => milestoneProgress(r.journal.view, plan(), milestonesOf(plan())[0]!, []);
    const abandon = (n: number): void => {
      r.journal.fact({ kind: 'walk-started', job: jobId('walk', n), milestone: milestoneId('MS-1'), round: 1, sha: SHA, ports: {} });
      r.journal.fact({ kind: 'walk-ended', job: jobId('walk', n), outcome: 'abandoned', findings: [], proposals: [], dropped: [] });
    };
    abandon(1);
    abandon(2);
    assert.equal(progress().kind, 'abandoned');
    const [item] = walkItemsDue(r.journal.view, plan(), [], new Date());
    assert.equal(item!.job, 'walk-2');
    const id = raiseNeedsUser(r.journal, r.ctx.runDir, item!.content, { type: 'job', job: item!.job });
    assert.deepEqual(openBlocking(r.journal.view), [id]);

    withMilestones({ ...MILESTONE, bringUp: { ...MILESTONE.bringUp, setup: [['node', '-e', '0']] } })(r.d);
    assert.deepEqual(accepted(classifyNow(r)).changes, [{ type: 'milestones', rewalk: ['MS-1'] }]);
    accept(r);
    assert.deepEqual(progress(), { kind: 'walk-due', round: 1 });
    assert.deepEqual([...supersededItems(r.journal.view)], [id]);
    assert.deepEqual(openBlocking(r.journal.view), [], 'the escalation clears');
    assert.deepEqual(walkItemsDue(r.journal.view, plan(), [], new Date()), []);
    abandon(3);
    assert.deepEqual(progress(), { kind: 'walk-due', round: 1 }, 'one failed walk since the edit: one retry left');
    abandon(4);
    const again = progress();
    assert.ok(again.kind === 'abandoned' && again.last.job === 'walk-4', JSON.stringify(again));
    assert.deepEqual(walkItemsDue(r.journal.view, plan(), [], new Date()).map((i) => i.job), ['walk-4'], 'the brake binds again, with its own escalation');
  }));

  test('classify.milestones-rewalk-bring-up-failed: an apply editing a milestone\'s bring-up after its walk failed bring-up makes that round\'s walk due again, its escalation superseded', T, () => onCorpusArc((r) => {
    withMilestones(MILESTONE)(r.d);
    accept(r);
    merge(r, 'u2');
    const plan = () => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
    const progress = () => milestoneProgress(r.journal.view, plan(), milestonesOf(plan())[0]!, []);
    const failBringUp = (n: number): void => {
      const job = jobId('walk', n);
      r.journal.fact({ kind: 'walk-started', job, milestone: milestoneId('MS-1'), round: 1, sha: SHA, ports: {} });
      const o = openFinding(r.journal, bringUpDraft(job, milestonesOf(plan())[0]!, 'setup[0]', 'exit 1', []));
      r.journal.fact({ kind: 'walk-ended', job, outcome: 'bring-up-failed', findings: [o.kind === 'suppressed' ? o.by : o.id], proposals: [], dropped: [] });
    };
    const later = new Date(Date.now() + 7 * 3_600_000);
    failBringUp(1);
    assert.equal(progress().kind, 'round-open', 'no unit can repair it: the round holds');
    const [item] = walkItemsDue(r.journal.view, plan(), [], later);
    assert.equal(item!.job, 'walk-1');
    const id = raiseNeedsUser(r.journal, r.ctx.runDir, item!.content, { type: 'job', job: item!.job });

    withMilestones({ ...MILESTONE, bringUp: { ...MILESTONE.bringUp, setup: [['node', '-e', '0']] } })(r.d);
    assert.deepEqual(accepted(classifyNow(r)).changes, [{ type: 'milestones', rewalk: ['MS-1'] }]);
    accept(r);
    assert.deepEqual(progress(), { kind: 'walk-due', round: 1 });
    assert.deepEqual([...supersededItems(r.journal.view)], [id]);
    assert.deepEqual(openBlocking(r.journal.view), [], 'the escalation clears');
    failBringUp(2);
    assert.equal(progress().kind, 'round-open', 'a failure after the edit is a round again');
  }));

  test('classify.milestones-need-holistic: milestones on an arc without the holistic layer are refused before routing resolves', T, () => {
    const d = setupArc({ steps: [], units: TWO });
    const r = contextFor(d);
    try {
      withMilestones(MILESTONE)(d);
      assert.deepEqual(reasons(classifyNow(r)), ['{"kind":"milestones-need-holistic"}']);
    } finally {
      r.journal.close();
    }
  });
});

describe('phase0.milestones: the shared rows', () => {
  const unit = (id: string, after: string[] = [], extra: Json = {}) => ({ id, spec: `${id}.json`, risk: 'med', scope: [`src/${id}/**`], resources: [], after, ...extra });
  const PLAN = {
    schema: 'roadmap/plan-m1', arc: 'arc-1', integrationBranch: 'main', baseline: SHA, worktreeRoot: '/var/tmp/wt', contracts: [], rulings: 'rulings.md',
    architectureDoc: 'docs/arch.md', direction: 'd', suite: { lanes: [] }, resources: [],
    units: [unit('d1'), unit('u1', ['d1']), unit('u2', ['u1']), unit('u3'), unit('u4', [], { cut: { reason: 'later' } })],
    holistic: { vision: 'vision.json', advances: ['V-1'] },
  };
  // The repo row 11 reads the milestones' references in (at `main`, the integration tip).
  const rowsOf = (plan: Json, repo = makeRepo(tmpDir('phase0-milestones'), { files: { 'README.md': 'r\n' } })) => phase0Rows({
    repo: absPath(repo), plan: parsePlan(plan), config: null, where: 'plan.json', pin: null, guide: null, phase0: null,
    obligations: null, vision: null, specs: new Map(), ledger: [], settled: new Set(),
  }, FROM_REF);
  const milestone = { ...MILESTONE, design: { unit: 'd1' }, units: ['u1', 'u2', 'u3', 'u4'] };

  test('phase0.milestones-unit-before-design: each live milestone unit not after its design unit, transitively, is advised; a supplied design is not', () => {
    const out = rowsOf({ ...PLAN, milestones: [milestone] });
    assert.deepEqual(out.rows, []);
    assert.deepEqual(out.advisories, [{ kind: 'milestone-unit-before-design', milestone: 'MS-1', unit: 'u3', design: 'd1' }]);
    assert.deepEqual(rowsOf({ ...PLAN, milestones: [{ ...milestone, design: { supplied: true } }] }).advisories, []);
  });

  // 2026-10-21 (field, dev.15): `references: ["apps/web/src/design"]` inlined a 1.5 MB compiled bundle and 330 KB of comps
  // into a 3.3 MB build prompt, parked context-exceeded at its paid call.
  test('phase0.milestones-references-oversize: a milestone whose references hold more text than the budget is a plan defect naming its largest files; binaries do not count', () => {
    const big = (n: number): string => 'x'.repeat(n);
    const repo = makeRepo(tmpDir('phase0-references'), { files: {
      'design/sdk/DESIGN.md': '# Design\n', 'design/sdk/logo.png': `\0${big(MILESTONE_REFERENCES_BUDGET)}`, 'design/sdk/comps.html': big(330_000),
    } });
    assert.deepEqual(rowsOf({ ...PLAN, milestones: [milestone] }, repo).rows, [], 'within the budget: a binary file is listed, never inlined');
    writeFiles(repo, { 'design/sdk/bundle.js': big(MILESTONE_REFERENCES_BUDGET) });
    commitAll(repo, 'a compiled bundle under the reference dir');
    const bytes = MILESTONE_REFERENCES_BUDGET + 330_000 + '# Design\n'.length;
    assert.deepEqual(rowsOf({ ...PLAN, milestones: [milestone] }, repo).rows, [{ kind: 'plan-defect', defects: [{
      type: 'milestone-references-oversize', milestone: 'MS-1', bytes, budget: MILESTONE_REFERENCES_BUDGET,
      largest: [{ path: 'design/sdk/bundle.js', bytes: MILESTONE_REFERENCES_BUDGET }, { path: 'design/sdk/comps.html', bytes: 330_000 }, { path: 'design/sdk/DESIGN.md', bytes: 9 }],
    }] }]);
  });

  test('phase0.milestones-need-holistic: milestones without `holistic` are a row; none without milestones', () => {
    const { holistic: _h, ...bare } = PLAN;
    assert.deepEqual(rowsOf({ ...bare, milestones: [milestone] }).rows, [{ kind: 'milestones-need-holistic' }]);
    assert.deepEqual(rowsOf(bare).rows, []);
  });
});

describe('vision: the experience kind', () => {
  test('vision.experience-clause: an experience standard reads unranked, as its section compiles it; a ranked one is refused', () => {
    const vision = (clause: Json): Json => ({
      schema: 'roadmap/vision-m3', rev: 1, confirmation: null, questions: [],
      clauses: [
        { id: 'V-1', kind: 'world', text: 'w', rank: null, state: 'active' },
        { id: 'V-2', kind: 'experience', text: 'An error always names what to do next.', rank: null, state: 'active', ...clause },
      ],
    });
    assert.equal(parseVision(vision({})).clauses[1]?.kind, 'experience');
    assert.throws(() => parseVision(vision({ rank: 1 })), SchemaError);
  });
});
