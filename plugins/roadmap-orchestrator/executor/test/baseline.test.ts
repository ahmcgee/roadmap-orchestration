// M3 step B2: the baseline witness job (src/pipeline/baseline.ts, A6) and journey-series lane reuse (src/pipeline/lanes.ts),
// over real arcs (real git, real processes, fake witness lanes scripted per tree). Named tests: baseline.held,
// baseline.must-hold-not-held, baseline.future-vacuous, baseline.resume, baseline.rerun-after-revision,
// baseline.docs-only-apply, baseline.docs-paths, baseline.source-change, baseline.lane-revision, baseline.regrade,
// baseline.expected-red-{future,must-hold,mixed}, baseline.external-lane, baseline.not-holistic, lanes.reuse.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { jobId, sha } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { holisticInForce } from '../src/pipeline/stages.ts';
import { type BaselineContext, baselineDue, runBaseline } from '../src/pipeline/baseline.ts';
import { jobEvidenceRoot } from '../src/git/snapshot.ts';
import { arcJourneyLane, runJourneySeries, witnessRecordPath } from '../src/pipeline/lanes.ts';
import { baselineOwed } from '../src/schedule/scheduler.ts';
import { commitAll, git, tmpDir, writeFiles } from './helpers/repo.ts';
import { scriptTree } from './helpers/witness.ts';
import { type HolisticOptions, holisticArc, obligationsJson } from './fixtures/brake-common.ts';
import { type Wired, publishArc, wire } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun, applyBody, contextFor } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
type Json = Record<string, unknown>;

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const spawnsOf = (r: ArcRun, lane: string): number => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey' && i.expect.subject.lane === lane).length;
type ObligationsJson = Json & { lanes: Json[]; obligations: Json[] };
const readObligations = (r: ArcRun): ObligationsJson => JSON.parse(readFileSync(join(r.d.planPath, '..', 'obligations.json'), 'utf8')) as ObligationsJson;
async function applyObligations(r: ArcRun, w: Wired, input: ObligationsJson): Promise<void> {
  writeFileSync(join(r.d.planPath, '..', 'obligations.json'), JSON.stringify(input));
  const applied = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(r.d)));
  assert.equal(applied.kind, 'applied', JSON.stringify(applied));
}

function arc(opts: Omit<HolisticOptions, 'steps' | 'mapping'>): Readonly<{ r: ArcRun; ctx: BaselineContext; w: Wired; control: string }> {
  const { d, control } = holisticArc({ steps: [], mapping: [], ...opts });
  const r = contextFor(d);
  const w = wire(r);
  return { r, ctx: { ...r.ctx, acquireFirst: w.arbiter.acquireFirst }, w, control };
}

describe('the baseline witness (A6)', () => {
  test('baseline.held: every arc lane runs on the tip under job{baseline-1}; must-hold held and future not yet held: nothing raised, and no baseline is due after', T, async () => {
    const { r, ctx } = arc({
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', activation: 'future', deliveredBy: ['u1'], testIds: ['t2'] }],
      trees: { '*': { outcomes: { t1: 'pass', t2: 'fail' } } },
    });
    try {
      assert.equal(baselineDue(ctx), 'baseline-1');
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      assert.equal(baselineDue(ctx), null);
      const tree = git(r.d.repo, 'rev-parse', 'main^{tree}');
      assert.deepEqual(facts(r).flatMap((f) => (f.kind === 'witnessed' ? [[f.lane, f.for, f.treeSha]] : [])), [['journey', { type: 'job', job: 'baseline-1' }, tree]]);
      const spawn = r.journal.view.opsOf('proc.spawn').find((i) => i.expect.subject.purpose === 'journey')!;
      assert.deepEqual(spawn.parent, { type: 'job', job: 'baseline-1' });
      assert.deepEqual(r.journal.view.needsUser(), []);
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      r.journal.close();
    }
  });

  test('baseline.must-hold-not-held: a must-hold obligation not held on the tip raises a blocking obligation-baseline, once; its optionless ack closes it', T, async () => {
    const { r, ctx, w } = arc({ obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'] }], trees: { '*': { outcomes: { t1: 'fail', t2: 'pass' } } } });
    try {
      const out = await runBaseline(ctx);
      assert.deepEqual(out, { kind: 'raised', problems: [{ obligation: 'I-1', kind: 'not-held', verdict: 'not-held' }] });
      const [item] = r.journal.view.needsUser();
      assert.ok(item !== undefined && item.blocking);
      const record = JSON.parse(readFileSync(join(r.ctx.runDir, 'needs-user', `${item.id}.json`), 'utf8')) as Json;
      assert.equal(record['reason'], 'obligation-baseline');
      assert.match(String(record['summary']), /must-hold but not held: I-1 \(not-held\)/);
      assert.deepEqual(record['evidence'], [jobEvidenceRoot(r.ctx.runDir, jobId('baseline', 1))]);
      assert.equal(baselineDue(ctx), null, 'raised once: the baseline is done');
      await assert.rejects(runBaseline(ctx), /no baseline is due/);
      // Its recommendation ends 'then acknowledge this item': the optionless ack is accepted and closes it (field arc m6, nu-5373).
      assert.deepEqual(record['options'], []);
      const ack = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'ack', needsUser: item.id, choice: null }));
      assert.equal(ack.kind, 'applied', JSON.stringify(ack));
      assert.notEqual(r.journal.view.ackOf(item.id), null);
    } finally {
      r.journal.close();
    }
  });

  test('baseline.future-vacuous: a future obligation already held is refused as a vacuous witness', T, async () => {
    const { r, ctx } = arc({ obligations: [{ id: 'I-1', activation: 'future', deliveredBy: ['u1'], testIds: ['t1'] }], trees: { '*': { outcomes: { t1: 'pass' } } } });
    try {
      assert.deepEqual(await runBaseline(ctx), { kind: 'raised', problems: [{ obligation: 'I-1', kind: 'vacuous', verdict: 'held' }] });
      const [item] = r.journal.view.needsUser();
      const record = JSON.parse(readFileSync(join(r.ctx.runDir, 'needs-user', `${item!.id}.json`), 'utf8')) as Json;
      assert.match(String(record['summary']), /future but already held \(a vacuous witness\): I-1/);
    } finally {
      r.journal.close();
    }
  });

  test('baseline.resume: a job that witnessed some lanes before it was cut short resumes as the same job and runs only the lanes it has not witnessed', T, async () => {
    const { r, ctx } = arc({
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'], lane: 'other' }], lanes: ['journey', 'other'],
      trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
    });
    try {
      // The first lane of baseline-1 ran, as a job cut short after it would have left it.
      const lane = holisticInForce(r.ctx).obligations!.lanes.find((l) => l.id === 'journey')!;
      const job = jobId('baseline', 1);
      const tip = sha(git(r.d.repo, 'rev-parse', 'main'));
      const series = await runJourneySeries(ctx, { type: 'job', job, acquireFirst: ctx.acquireFirst }, [arcJourneyLane(lane)], {
        path: absPath(join(tmpDir('baseline-partial'), 'checkout')), checkout: { type: 'detached', at: tip },
      }, { reuse: false, stop: () => false });
      assert.equal(series.end.kind, 'ran');
      assert.equal(baselineDue(ctx), 'baseline-1', 'the same job is still due');
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      assert.deepEqual([spawnsOf(r, 'journey'), spawnsOf(r, 'other')], [1, 1], 'only the missing lane ran again');
      assert.equal(baselineDue(ctx), null);
    } finally {
      r.journal.close();
    }
  });

  test('baseline.docs-only-apply: repeated docs publications move the tip without owing a baseline or spawning lanes again', T, async () => {
    const { r, ctx, w } = arc({ obligations: [{ id: 'I-1', testIds: ['t1'] }], trees: { '*': { outcomes: { t1: 'pass' } } } });
    try {
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      for (const cutLine of ['revised pack', 'revised pack again']) {
        const before = git(r.d.repo, 'rev-parse', 'main');
        await applyObligations(r, w, { ...readObligations(r), cutLine });
        const after = git(r.d.repo, 'rev-parse', 'main');
        assert.notEqual(after, before, 'the docs publication moved the tip');
        assert.equal(git(r.d.repo, 'diff', '--name-only', before, after), '.roadmap/invariants.md');
        assert.equal(baselineDue(ctx), null);
        assert.equal(baselineOwed(w.stage), null);
        await assert.rejects(runBaseline(ctx), /no baseline is due/);
        assert.equal(spawnsOf(r, 'journey'), 1, 'neither publication nor baseline reran the lane');
      }
    } finally {
      r.journal.close();
    }
  });

  test('baseline.docs-paths: executor-rendered docs preserve evidence; any other path (a roadmap input, a contract document) reruns every lane', T, async () => {
    const { r, ctx } = arc({
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'], lane: 'other' }], lanes: ['journey', 'other'],
      trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
    });
    try {
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      for (const path of ['.roadmap/constraints.md', '.roadmap/invariants.md', '.roadmap/debt.md']) {
        writeFiles(r.d.repo, { [path]: 'published docs\n' });
        commitAll(r.d.repo, `publish ${path}`);
        assert.equal(baselineDue(ctx), null, path);
        assert.deepEqual([spawnsOf(r, 'journey'), spawnsOf(r, 'other')], [1, 1]);
      }
      writeFiles(r.d.repo, { '.roadmap/vision.json': '{}\n' });
      commitAll(r.d.repo, 'change vision outside rendered docs');
      assert.equal(baselineDue(ctx), 'baseline-1');
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      assert.deepEqual([spawnsOf(r, 'journey'), spawnsOf(r, 'other')], [2, 2]);
      writeFiles(r.d.repo, { 'contracts/nested/new.md': 'a contract a ruling edited\n' });
      commitAll(r.d.repo, 'edit a contract document');
      assert.equal(baselineDue(ctx), 'baseline-1', 'a contract document may be a lane input');
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      assert.deepEqual([spawnsOf(r, 'journey'), spawnsOf(r, 'other')], [3, 3]);
    } finally {
      r.journal.close();
    }
  });

  test('baseline.rerun-after-revision: a docs revision adding a lane runs only that lane as the same job on its own checkout; each series certified once (paid M4b run 3)', T, async () => {
    const { r, ctx, w, control } = arc({ obligations: [{ id: 'I-1', testIds: ['t1'] }], trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } } });
    try {
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      assert.equal(baselineDue(ctx), null);
      // Rev 2 adds lane `other` (I-2); its docs publication (docs-1) moves the tip.
      const before = git(r.d.repo, 'rev-parse', 'main');
      const obligations = [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'], lane: 'other' }];
      const input = obligationsJson({ obligations, mapping: [], lanes: ['journey', 'other'] }, control) as ObligationsJson;
      input.lanes[0] = readObligations(r).lanes[0]!; // Preserve journey's argv/rev; the fixture otherwise makes a new wrapper.
      await applyObligations(r, w, input);
      assert.notEqual(git(r.d.repo, 'rev-parse', 'main'), before, 'the docs publication moved the tip');
      assert.equal(baselineOwed(w.stage), 'baseline-1', 'not done elsewhere: the tree it left lacks lane other');
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      assert.equal(baselineDue(ctx), null);
      const ran = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey' && i.parent.type === 'job' && i.parent.job === 'baseline-1');
      assert.deepEqual(ran.map((i) => i.expect.subject.purpose === 'journey' && i.expect.subject.lane), ['journey', 'other'], 'only the added lane ran on the new tip');
      const root = join(r.ctx.plan().worktreeRoot, r.ctx.plan().arc);
      assert.deepEqual(facts(r).flatMap((f) => (f.kind === 'series-certified' && f.parent.type === 'job' && f.parent.job === 'baseline-1' ? [[f.parent, f.checkout]] : [])), [
        [{ type: 'job', job: 'baseline-1' }, join(root, 'baseline-1.checkout-1')],
        [{ type: 'job', job: 'baseline-1' }, join(root, 'baseline-1.checkout-2')],
      ], 'one certificate per series, each on its own checkout');
      await applyObligations(r, w, { ...readObligations(r), cutLine: 'another pack revision' });
      assert.equal(baselineDue(ctx), null, 'records on both earlier equivalent trees still count');
      assert.deepEqual([spawnsOf(r, 'journey'), spawnsOf(r, 'other')], [1, 2], 'only docs publication witnessed the newly added must-hold lane');
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      r.journal.close();
    }
  });

  test('baseline.source-change: a source change and docs revision make every lane run again', T, async () => {
    const { r, ctx, w } = arc({
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'], lane: 'other' }], lanes: ['journey', 'other'],
      trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
    });
    try {
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      writeFiles(r.d.repo, { 'src/add.js': 'export const add = (a, b) => a + b;\n' });
      commitAll(r.d.repo, 'change source on integration tip');
      await applyObligations(r, w, { ...readObligations(r), cutLine: 'source and pack revision' });
      assert.equal(baselineDue(ctx), 'baseline-1');
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      assert.equal(baselineDue(ctx), null);
      assert.deepEqual([spawnsOf(r, 'journey'), spawnsOf(r, 'other')], [2, 2]);
    } finally {
      r.journal.close();
    }
  });

  test('baseline.lane-revision: changing one lane definition reruns only that lane', T, async () => {
    const { r, ctx, w } = arc({
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'], lane: 'other' }], lanes: ['journey', 'other'],
      trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
    });
    try {
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      const input = readObligations(r);
      input.lanes[0]!['env'] = { set: { PACK_REV: '2' }, pass: ['PATH'] };
      await applyObligations(r, w, input);
      const before = [spawnsOf(r, 'journey'), spawnsOf(r, 'other')];
      assert.equal(baselineDue(ctx), 'baseline-1');
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      assert.equal(baselineDue(ctx), null);
      assert.deepEqual([spawnsOf(r, 'journey'), spawnsOf(r, 'other')], [before[0]! + 1, before[1]]);
    } finally {
      r.journal.close();
    }
  });

  test('baseline.regrade: a new future witness test id is graded against the job record without rerunning the lane', T, async () => {
    const { r, ctx, w, control } = arc({
      obligations: [{ id: 'I-1', activation: 'future', deliveredBy: ['u1'], testIds: ['missing'] }],
      trees: { '*': { outcomes: { t1: 'pass' } } },
    });
    try {
      assert.deepEqual(await runBaseline(ctx), { kind: 'held' });
      const input = readObligations(r);
      input.obligations[0]!['witness'] = { lane: 'journey', testIds: ['t1'] };
      input.obligations[0]!['proofJudgment'] = { verdict: 'proves', obligationRev: 1, witness: { testIds: ['t1'] } };
      scriptTree(control, '*', { outcomes: { t1: 'fail' } });
      await applyObligations(r, w, input);
      assert.equal(spawnsOf(r, 'journey'), 3, 'docs publication keeps the diagnostic rerun even for an all-future lane');
      assert.equal(baselineDue(ctx), 'baseline-1', 'the retained record now reveals a vacuous witness');
      assert.deepEqual(await runBaseline(ctx), { kind: 'raised', problems: [{ obligation: 'I-1', kind: 'vacuous', verdict: 'held' }] });
      assert.equal(baselineDue(ctx), null);
      assert.equal(spawnsOf(r, 'journey'), 3, 'baseline regrades its own older record, without spawning again');
    } finally {
      r.journal.close();
    }
  });

  for (const kind of ['future', 'must-hold', 'mixed'] as const) {
    test(`baseline.expected-red-${kind}: only an all-future lane skips the diagnostic rerun`, T, async () => {
      const { r, ctx } = arc({
        obligations: [
          { id: 'I-1', activation: kind === 'must-hold' ? 'must-hold' : 'future', deliveredBy: ['u1'], testIds: ['t1'] },
          ...(kind === 'mixed' ? [{ id: 'I-2', testIds: ['t1'] }] : []),
        ],
        trees: { '*': { outcomes: { t1: 'fail' } } },
      });
      try {
        const out = await runBaseline(ctx);
        assert.equal(out.kind, kind === 'future' ? 'held' : 'raised');
        const count = kind === 'future' ? 1 : 2;
        assert.equal(spawnsOf(r, 'journey'), count);
        const witnessed = r.journal.view.holistic().witnessed;
        assert.equal(witnessed.length, 1, 'only the counted red run is witnessed');
        const record = JSON.parse(readFileSync(witnessRecordPath(r.ctx.runDir, witnessed[0]!), 'utf8')) as { records: { outcome: string }[] };
        assert.deepEqual(record.records.map((t) => t.outcome), ['fail']);
        const dirs = readdirSync(jobEvidenceRoot(r.ctx.runDir, jobId('baseline', 1)));
        assert.equal(dirs.filter((d) => d.startsWith('arc-journey-')).length, count, 'one immutable evidence dir per execution');
        assert.ok(!dirs.some((d) => d.includes('.rerun')), 'no legacy rerun directory');
        assert.equal(baselineDue(ctx), null);
      } finally {
        r.journal.close();
      }
    });
  }

  test('baseline.external-lane: an obligation an external-class lane witnesses is neither run nor graded at baseline, so no baseline is owed for it', T, async () => {
    const { r, ctx } = arc({
      obligations: [{ id: 'I-1', testIds: ['ci'] }],
      trees: {},
      laneExtra: { journey: { witnessClass: 'external', inputs: ['src/**'] } },
    });
    try {
      assert.equal(baselineDue(ctx), null);
      assert.equal(spawnsOf(r, 'journey'), 0);
      assert.deepEqual(r.journal.view.needsUser(), []);
    } finally {
      r.journal.close();
    }
  });

  test('baseline.not-holistic: an arc without the holistic layer (no vision) owes no baseline and spends nothing', T, () => {
    const d = publishArc({ steps: [] });
    const r = contextFor(d);
    try {
      assert.equal(baselineDue(r.ctx), null);
    } finally {
      r.journal.close();
    }
  });
});

describe('lane reuse (§9)', () => {
  test('lanes.reuse: a witness lane whose observation on the tree exists (all four keys, its record hash) is not run again; without reuse it runs', T, async () => {
    const { r, ctx } = arc({ obligations: [{ id: 'I-1', testIds: ['t1'] }], trees: { '*': { outcomes: { t1: 'pass' } } } });
    try {
      const lane = arcJourneyLane(holisticInForce(r.ctx).obligations!.lanes[0]!);
      const tip = sha(git(r.d.repo, 'rev-parse', 'main'));
      const run = (n: number, reuse: boolean) => runJourneySeries(ctx, { type: 'job', job: jobId('audit', 1), acquireFirst: ctx.acquireFirst }, [lane], {
        path: absPath(join(tmpDir('reuse'), `checkout-${n}`)), checkout: { type: 'detached', at: tip },
      }, { reuse, stop: () => false });
      const first = await run(1, true);
      assert.equal(first.runs[0]!.inv !== null, true);
      const second = await run(2, true);
      assert.deepEqual([second.runs[0]!.inv, second.runs[0]!.record?.inv], [null, first.runs[0]!.inv], 'reused: the kept record, nothing ran');
      assert.equal(spawnsOf(r, 'journey'), 1);
      assert.equal(r.journal.view.opsOf('worktree.create').length, 1, 'a series that runs no lane makes no checkout');
      const third = await run(3, false);
      assert.notEqual(third.runs[0]!.inv, null);
      assert.equal(spawnsOf(r, 'journey'), 2);
      assert.equal(facts(r).filter((f) => f.kind === 'witnessed').length, 2, 'one witnessed fact per run, none for a reuse');
    } finally {
      r.journal.close();
    }
  });
});
