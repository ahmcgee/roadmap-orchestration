// dev.13 (plan §4a; SCHEMAS.md "dev.13" "The demo"): promotion on settle (src/demo/promote.ts) and the supervisor's keeper
// (src/demo/keeper.ts), integrated: a corpus arc over unit-common's repo with milestones, walk facts written as agent C's walk
// job writes them, and a tiny real product (a node http server with a setup and a seed step) brought up from real git
// checkouts on real ports. Every process a test starts is stopped by the test (`stopDemo`).
// Named tests: demo.promote-swap, demo.failed-keeps-old, demo.hold-release, demo.down-up, demo.restart-restores,
// demo.blocked-never-promotes, demo.unsettled-round, demo.final-tip, demo.keeper-outlives, demo.crash-promoted, demo.reserved-name,
// demo.cli.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, test } from 'node:test';
import { arcId, commandId, jobId, journeyId, milestoneId, serveName, sha, unitId } from '../src/core/ids.ts';
import { SchemaError } from '../src/core/validate.ts';
import { arcsWithRefs } from '../src/chain.ts';
import { parsePlan } from '../src/input/plan.ts';
import { absPath, repoPattern } from '../src/core/values.ts';
import { stopSession } from '../src/walk/bringup.ts';
import { reconcileOnce, startDemoKeeper } from '../src/demo/keeper.ts';
import { actOnDemo, demoFacts, demoStatus, demoTicker, demoView, promoteFinal } from '../src/demo/promote.ts';
import { repairUnits } from '../src/pipeline/reproduce.ts';
import { DEMO_REF, type DemoRecord, readDemoRecord, readDesired } from '../src/demo/records.ts';
import { refTarget } from '../src/git/git.ts';
import { openFinding } from '../src/holistic/findings.ts';
import { CliError, parseCommand } from '../src/input/cli.ts';
import { setupCorpusArc } from './fixtures/corpus-unit.ts';
import { type ArcRun, contextFor } from './fixtures/unit-common.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { commitAll, tmpDir, writeFiles } from './helpers/repo.ts';

const T = { timeout: 180_000 };
type Json = Record<string, unknown>;

const SERVER = [
  "import { createServer } from 'node:http';",
  "import { existsSync, readFileSync } from 'node:fs';",
  "const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim() : 'none');",
  "createServer((req, res) => res.end(`${read('version.txt')}|${read('built.txt')}|${read('seeded.txt')}`)).listen(Number(process.env.PORT), '127.0.0.1');",
].join('\n');
const BROKEN = "console.error('this version cannot start'); process.exit(3);\n";

const BRING_UP = {
  setup: [['node', '-e', "require('fs').writeFileSync('built.txt', 'built')"]],
  serve: [{ name: 'web', argv: ['node', 'demo/serve.mjs'], ready: { http: 'http://127.0.0.1:{port:web}/' } }],
  env: { PORT: '{port:web}' },
  seed: [['node', '-e', "require('fs').writeFileSync('seeded.txt', 'seeded on ' + process.env.PORT)"]],
};
const CLI_BRING_UP = { setup: [['node', '-e', "require('fs').mkdirSync('bin', { recursive: true }); require('fs').writeFileSync('bin/tool', 'built')"]], serve: [], env: {}, seed: [] };

const milestone = (n: number, unit: string, bringUp: Json = BRING_UP): Json => ({
  id: `MS-${n}`, text: `Milestone ${n}: someone opens the page.`, units: [unit], design: { supplied: true }, references: ['design/web'], bringUp,
  journeys: [{ id: `J-${n}`, text: 'I open the page.', via: 'shell', entry: bringUp === BRING_UP ? 'http://127.0.0.1:{port:web}/' : 'bin/tool', budget: null }], resources: [],
});

/** Every demo record a test touched, so `stopDemo` can stop what is still running. */
const hosts: string[] = [];

async function stopDemo(record: DemoRecord | null): Promise<void> {
  for (const p of [...(record?.serving?.processes ?? []), ...(record?.trial?.processes ?? [])]) await stopSession(p.sid);
}

after(async () => {
  for (const h of hosts) await stopDemo(readDemoRecord(absPath(h)));
});

/** A corpus arc with three units and `milestones` in its first plan, and the product committed at version `v1`. */
async function demoArc(milestones: readonly Json[] = [milestone(1, 'u1'), milestone(2, 'u2'), milestone(3, 'u3')]): Promise<ArcRun> {
  const arc = await setupCorpusArc([], { units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] });
  const p = JSON.parse(readFileSync(arc.d.planPath, 'utf8')) as Json;
  p['milestones'] = milestones;
  writeFileSync(arc.d.planPath, JSON.stringify(p));
  const r = contextFor(arc.d);
  hosts.push(r.ctx.hostDir);
  return r;
}

/** Commits the product at `version` (with `server` as its serve.mjs); returns the commit. */
function release(r: ArcRun, version: string, server = SERVER): ReturnType<typeof sha> {
  writeFiles(r.d.repo, { 'demo/serve.mjs': server, 'version.txt': `${version}\n` });
  return sha(commitAll(r.d.repo, `product ${version}`));
}

const nextWalk = (r: ArcRun): number => r.journal.view.walkFacts().filter((x) => x.fact.kind === 'walk-started').length + 1;

/** A walk of `ms` on `at`, ended clean, and the node passed: as agent C's job records a clean round. */
function settle(r: ArcRun, ms: string, at: ReturnType<typeof sha>, extra: Readonly<{ proposals?: number }> = {}): void {
  const job = jobId('walk', nextWalk(r));
  r.journal.fact({ kind: 'walk-started', job, milestone: milestoneId(ms), round: 1, sha: at, ports: {} });
  const proposals = [];
  for (let i = 0; i < (extra.proposals ?? 0); i++) {
    const id = r.journal.view.nextPolishId();
    r.journal.fact({
      kind: 'polish-proposed', id, job, milestone: milestoneId(ms), journey: journeyId(`J-${ms.slice(3)}`), evidence: ['shot.png'], text: 'tighten the header',
      unit: { id: unitId(`polish-${id.toLowerCase()}`), scope: [repoPattern('design/web/**')], spec: '{}' },
    });
    proposals.push(id);
  }
  r.journal.fact({ kind: 'walk-ended', job, outcome: 'reported', findings: [], proposals, dropped: [] });
  r.journal.fact({ kind: 'milestone-passed', milestone: milestoneId(ms), job });
}

const tick = (r: ArcRun): void => demoTicker(r.ctx).tick();
const reader = (r: ArcRun) => ({ view: r.journal.view, plan: r.ctx.plan(), repairs: repairUnits(r.ctx) });
const reconcile = (r: ArcRun): Promise<DemoRecord> => reconcileOnce(r.ctx.hostDir, r.ctx.runDir);

async function get(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) });
  return res.text();
}
const refused = async (port: number): Promise<boolean> => {
  try {
    await get(port);
    return false;
  } catch {
    return true;
  }
};
const webPort = (rec: DemoRecord): number => rec.ports[serveName('web')] as number;

describe('demo: promotion and the keeper', () => {
  test('demo.promote-swap: a settled milestone promotes; the next is brought up beside it and swapped onto the same port, reseeded', T, async () => {
    const r = await demoArc();
    try {
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1);
      tick(r);
      assert.deepEqual(demoFacts(r.journal.view).promotions.map((p) => [p.milestone, p.sha]), [['MS-1', v1]]);
      assert.equal(refTarget(r.ctx.repo, DEMO_REF), v1, 'the ref follows the promotion');
      assert.equal(readDesired(r.ctx.runDir)?.target?.sha, v1);
      tick(r);
      assert.equal(demoFacts(r.journal.view).promotions.length, 1, 'promoted once');

      const first = await reconcile(r);
      const port = webPort(first);
      assert.equal(first.serving?.sha, v1);
      assert.equal(await get(port), `v1|built|seeded on ${port}`, 'seeded in the trial, then reseeded on the stable port');
      assert.equal(readlinkSync(join(r.ctx.plan().worktreeRoot, 'demo', 'current')), first.serving?.slot);

      const v2 = release(r, 'v2');
      settle(r, 'MS-2', v2);
      tick(r);
      const view = demoView(reader(r));
      assert.deepEqual(view?.since.milestones, ['MS-2'], 'what changed since the promotion before');
      const second = await reconcile(r);
      assert.equal(second.serving?.sha, v2);
      assert.equal(webPort(second), port, 'the stable port is kept');
      assert.notEqual(second.serving?.slot, first.serving?.slot, 'brought up in the spare slot');
      assert.equal(await get(port), `v2|built|seeded on ${port}`, 'the new version, reseeded');
      assert.ok(first.serving?.processes.every((p) => !existsSync(`/proc/${p.pid}`) || readFileSync(`/proc/${p.pid}/stat`, 'utf8').split(' ')[2] === 'Z'), 'the old version is stopped');
      const s = demoStatus(reader(r), r.ctx.hostDir);
      assert.deepEqual([s?.milestone, s?.sha, s?.serving, s?.where], ['MS-2', v2, v2, { type: 'url', url: `http://127.0.0.1:${port}/`, ports: { web: port } }]);
      await stopDemo(second);
    } finally {
      r.journal.close();
    }
  });

  test('demo.failed-keeps-old: a version that does not come up leaves the old one serving, and opens a walkthrough P1 on its milestone', T, async () => {
    const r = await demoArc();
    try {
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1);
      tick(r);
      const first = await reconcile(r);
      const port = webPort(first);
      const v2 = release(r, 'v2', BROKEN);
      settle(r, 'MS-2', v2);
      tick(r);
      const after = await reconcile(r);
      assert.equal(after.serving?.sha, v1, 'the old version keeps serving');
      assert.match(await get(port), /^v1\|/);
      assert.deepEqual(after.failures.map((f) => [f.milestone, f.sha]), [['MS-2', v2]]);
      const log = after.failures[0]!.log;
      assert.match(readFileSync(log, 'utf8'), /# failed: serve\.web: it ended before it was ready/);

      tick(r);
      const failed = r.journal.view.walkFacts().filter((x) => x.fact.kind === 'demo-failed').map((x) => x.fact);
      assert.deepEqual(failed, [{ kind: 'demo-failed', milestone: 'MS-2', sha: v2, log }]);
      const p1 = r.journal.view.holistic().findings.filter((f) => f.source.type === 'demo');
      assert.deepEqual(p1.map((f) => [f.lens, f.severity, f.milestone, f.source, f.evidence]), [['walkthrough', 'P1', 'MS-2', { type: 'demo', sha: v2 }, [{ path: log, blob: null }]]]);
      tick(r);
      assert.equal(r.journal.view.walkFacts().filter((x) => x.fact.kind === 'demo-failed').length, 1, 'journaled once');

      const again = await reconcile(r);
      assert.equal(again.failures.length, 1, 'not retried on the same act and boot');
      const s = demoStatus(reader(r), r.ctx.hostDir);
      assert.deepEqual([s?.sha, s?.serving, s?.failed], [v2, v1, { sha: v2, log }]);
      await stopDemo(again);
    } finally {
      r.journal.close();
    }
  });

  test('demo.hold-release: hold freezes promotion; release promotes the latest settled milestone at once', T, async () => {
    const r = await demoArc();
    try {
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1);
      tick(r);
      assert.equal(actOnDemo(r.ctx, commandId('cmd-000000000001aaaa'), 'hold').kind, 'applied');
      assert.deepEqual(actOnDemo(r.ctx, commandId('cmd-000000000002aaaa'), 'hold'), { kind: 'rejected', reason: 'demo hold: promotion is already held (by cmd-000000000001aaaa)' });
      const v2 = release(r, 'v2');
      settle(r, 'MS-2', v2);
      tick(r);
      assert.deepEqual(demoFacts(r.journal.view).promotions.map((p) => p.milestone), ['MS-1'], 'held: nothing promoted');
      assert.equal(readDesired(r.ctx.runDir)?.target?.sha, v1);
      const released = actOnDemo(r.ctx, commandId('cmd-000000000003aaaa'), 'release');
      assert.deepEqual(released, { kind: 'applied', verified: ['demo promotion released', `promoted MS-2 at ${v2}`] });
      assert.equal(refTarget(r.ctx.repo, DEMO_REF), v2);
      assert.equal(readDesired(r.ctx.runDir)?.target?.sha, v2);
      assert.deepEqual(actOnDemo(r.ctx, commandId('cmd-000000000004aaaa'), 'release'), { kind: 'rejected', reason: 'demo release: promotion is not held' });
      assert.equal(actOnDemo(r.ctx, commandId('cmd-000000000003aaaa'), 'release').kind, 'applied', 'a re-run of an applied act finds its own fact');
    } finally {
      r.journal.close();
    }
  });

  test('demo.down-up: down stops the instance and keeps its checkout; up restarts it on the same port', T, async () => {
    const r = await demoArc();
    try {
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1);
      tick(r);
      const up = await reconcile(r);
      const port = webPort(up);
      assert.equal(actOnDemo(r.ctx, commandId('cmd-000000000001bbbb'), 'down').kind, 'applied');
      assert.equal(actOnDemo(r.ctx, commandId('cmd-000000000002bbbb'), 'down').kind, 'rejected');
      const down = await reconcile(r);
      assert.deepEqual([down.serving?.state, down.serving?.processes], ['down', []]);
      assert.ok(await refused(port), 'nothing listens');
      assert.ok(existsSync(down.serving!.slot), 'the checkout is kept');
      assert.equal(actOnDemo(r.ctx, commandId('cmd-000000000003bbbb'), 'up').kind, 'applied');
      const again = await reconcile(r);
      assert.equal(again.serving?.state, 'up');
      assert.match(await get(port), /^v1\|built\|seeded on/, 'restored from its checkout: its seeded data kept');
      await stopDemo(again);
    } finally {
      r.journal.close();
    }
  });

  test('demo.restart-restores: a demo whose processes are gone is restored on its port; one whose checkout is gone is brought up afresh', T, async () => {
    const r = await demoArc();
    try {
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1);
      tick(r);
      const first = await reconcile(r);
      const port = webPort(first);
      await stopDemo(first);
      assert.ok(await refused(port));
      const restored = await reconcile(r);
      assert.equal(restored.serving?.slot, first.serving?.slot);
      assert.match(await get(port), /^v1\|/);

      await stopDemo(restored);
      rmSync(restored.serving!.slot, { recursive: true, force: true });
      const fresh = await reconcile(r);
      assert.equal(fresh.serving?.sha, v1);
      assert.match(await get(port), /^v1\|built\|seeded/);
      await stopDemo(fresh);
    } finally {
      r.journal.close();
    }
  });

  test('demo.blocked-never-promotes: a milestone with an active walkthrough P1 does not promote; the demo stays at the last good one', T, async () => {
    const r = await demoArc();
    try {
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1);
      tick(r);
      const v2 = release(r, 'v2');
      settle(r, 'MS-2', v2);
      openFinding(r.journal, {
        lens: 'walkthrough', severity: 'P1', obligation: null, visionClauses: [], milestone: milestoneId('MS-2'), claim: 'the page is blank', cause: 'blank page',
        evidence: [], mutant: null, source: { type: 'job', job: jobId('walk', 2) }, gateHadPassed: false,
      });
      tick(r);
      assert.deepEqual(demoFacts(r.journal.view).promotions.map((p) => p.sha), [v1]);
      assert.equal(promoteFinal(r.ctx, v2), null, 'nor does the completion over an open walkthrough P1');
    } finally {
      r.journal.close();
    }
  });

  test('demo.unsettled-round: a walk whose applied polish is not yet in the plan has not closed its rounds', T, async () => {
    const r = await demoArc();
    try {
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1, { proposals: 1 });
      tick(r);
      assert.deepEqual(demoFacts(r.journal.view).promotions, [], 'its polish unit is still to be admitted');
    } finally {
      r.journal.close();
    }
  });

  test('demo.final-tip: the completion promotes the final tip under the last settled milestone', T, async () => {
    const r = await demoArc();
    try {
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1);
      tick(r);
      const tip = release(r, 'v-final');
      const p = promoteFinal(r.ctx, tip);
      assert.deepEqual([p?.milestone, p?.sha], ['MS-1', tip]);
      assert.equal(refTarget(r.ctx.repo, DEMO_REF), tip);
      assert.equal(promoteFinal(r.ctx, tip), null, 'once');
      tick(r);
      assert.equal(demoFacts(r.journal.view).promotions.length, 2, 'a settled milestone older than the tip does not promote back');
    } finally {
      r.journal.close();
    }
  });

  test('demo.keeper-outlives: the supervisor\'s keeper brings a promotion up, and a non-server product is its checkout with setup run', T, async () => {
    const r = await demoArc([milestone(1, 'u1', CLI_BRING_UP)]);
    try {
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1);
      tick(r);
      const keeper = startDemoKeeper(r.ctx.hostDir, r.ctx.runDir);
      const deadline = Date.now() + 60_000;
      while (readDemoRecord(r.ctx.hostDir)?.serving?.sha !== v1 && Date.now() < deadline) await sleep(100);
      await keeper.finish(false);
      const rec = readDemoRecord(r.ctx.hostDir);
      assert.equal(rec?.serving?.sha, v1);
      const s = demoStatus(reader(r), r.ctx.hostDir);
      const bin = join(r.ctx.plan().worktreeRoot, 'demo', 'current', 'bin');
      assert.deepEqual([s?.where, s?.serving], [{ type: 'path', path: bin }, v1]);
      assert.equal(readFileSync(join(bin, 'tool'), 'utf8'), 'built');
    } finally {
      r.journal.close();
    }
  });

  test('demo.crash-promoted: a crash after the promotion fact and before the ref is mended by the next start\'s first tick', T, async () => {
    const r = await demoArc();
    const v1 = release(r, 'v1');
    settle(r, 'MS-1', v1);
    r.journal.close();
    const trigger = writeTrigger(tmpDir('demo-crash'), { label: 'demo-promoted', occurrence: 1 });
    const exit = await runFixture('demo-child.ts', [JSON.stringify(r.d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 60_000 });
    assert.equal(exit.signal, 'SIGKILL', exit.stderr);
    assertFired(trigger);
    const again = contextFor(r.d);
    try {
      assert.deepEqual(demoFacts(again.journal.view).promotions.map((p) => p.sha), [v1]);
      assert.equal(refTarget(again.ctx.repo, DEMO_REF), null, 'the crash left the ref behind');
      tick(again);
      assert.equal(refTarget(again.ctx.repo, DEMO_REF), v1);
      assert.equal(demoFacts(again.journal.view).promotions.length, 1, 'no second promotion');
    } finally {
      again.journal.close();
    }
  });
});

describe('demo: the reserved name', () => {
  test('demo.reserved-name: no arc is named demo, and the demo\'s ref is no arc\'s snapshot ref', T, async () => {
    const r = await demoArc();
    try {
      const plan = JSON.parse(readFileSync(r.d.planPath, 'utf8')) as Json;
      assert.throws(() => parsePlan({ ...plan, arc: 'demo' }), (e: unknown) => e instanceof SchemaError && e.message.includes('reserved'));
      const v1 = release(r, 'v1');
      settle(r, 'MS-1', v1);
      tick(r);
      assert.equal(refTarget(r.ctx.repo, DEMO_REF), v1);
      assert.ok(!arcsWithRefs(r.ctx.repo).includes(arcId('demo')), 'the chain does not read refs/roadmap/demo as an arc');
    } finally {
      r.journal.close();
    }
  });
});

describe('demo: the owner\'s acts on the command line', () => {
  test('demo.cli: `roadmap demo <act>` parses each act and refuses any other', () => {
    for (const act of ['up', 'down', 'hold', 'release'] as const) assert.deepEqual(parseCommand(['demo', act]), { command: 'demo', act, run: { type: 'host' } });
    assert.throws(() => parseCommand(['demo', 'restart']), CliError);
    assert.throws(() => parseCommand(['demo']), CliError);
  });
});
