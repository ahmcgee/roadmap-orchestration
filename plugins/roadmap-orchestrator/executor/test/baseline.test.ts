// M3 step B2: the baseline witness job (src/pipeline/baseline.ts, A6) and journey-series lane reuse (src/pipeline/lanes.ts),
// over real arcs (real git, real processes, fake witness lanes scripted per tree). Named tests: baseline.held,
// baseline.must-hold-not-held, baseline.future-vacuous, baseline.resume, baseline.not-holistic, lanes.reuse.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { jobId, sha } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { holisticInForce } from '../src/pipeline/stages.ts';
import { type BaselineContext, baselineDue, runBaseline } from '../src/pipeline/baseline.ts';
import { jobEvidenceRoot } from '../src/git/snapshot.ts';
import { arcJourneyLane, runJourneySeries } from '../src/pipeline/lanes.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type HolisticOptions, holisticArc } from './fixtures/brake-common.ts';
import { publishArc, wire } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun, contextFor } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
type Json = Record<string, unknown>;

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const spawnsOf = (r: ArcRun, lane: string): number => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey' && i.expect.subject.lane === lane).length;

function arc(opts: Omit<HolisticOptions, 'steps' | 'mapping'>): Readonly<{ r: ArcRun; ctx: BaselineContext }> {
  const { d } = holisticArc({ steps: [], mapping: [], ...opts });
  const r = contextFor(d);
  const w = wire(r);
  return { r, ctx: { ...r.ctx, acquireFirst: w.arbiter.acquireFirst } };
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

  test('baseline.must-hold-not-held: a must-hold obligation not held on the tip raises a blocking obligation-baseline, once', T, async () => {
    const { r, ctx } = arc({ obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'] }], trees: { '*': { outcomes: { t1: 'fail', t2: 'pass' } } } });
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

  test('baseline.not-holistic: a dev.5-style arc (no vision) owes no baseline and spends nothing', T, () => {
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
