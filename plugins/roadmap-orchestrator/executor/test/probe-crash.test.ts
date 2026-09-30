// Crash tests of a probe job (src/park/probe.ts), driven by probe-child.ts: the probe of a backend target (a
// claude outage park: the backend's smoke), of the host target (a blocked-lane park: the host sample and the
// smoke's shell command), and of a residue no park names (estate#1's failed cleanup: the reclaim order under the
// residue's retry holder, whose teardown spawn reaches the launch labels), crashed at every label of the matrix
// row `probe job`. After each crash, recovery and the next probe leave the park recovered by exactly one passing
// probe fact covering it, nothing open, and a second recovery and probe append nothing. A residue ends with its
// instance free and its residue disposed `cleaned`, with at most one pass: recovery finishes a reclaim order the
// crash cut short (`settleRetry`), and a reclaim that released before the crash leaves nothing to probe.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { probeTargetKey } from '../src/core/events.ts';
import { arcId, poolInstance, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { readResidues, undispositioned } from '../src/host/residues.ts';
import { cleanup, reserve, run as runReservation } from '../src/resources/reserve.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { events } from './fixtures/invoke-specs.ts';
import { ESTATE } from './fixtures/pool-plan.ts';
import { LANES_BLOCKED, type ProbeRun, newProbeRun, openProbeRun, parkBackend, parkUnit, seedArc } from './fixtures/probe-common.ts';
import { PROBE_JOB, crashCells } from './matrix.ts';

const CHILD_TIMEOUT_MS = 60_000;
const T = { timeout: 180_000 };
const U1 = unitId('u1');
const ESTATE1 = poolInstance(ESTATE, 1);
const claudeOk = { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: { ok: true } }] } as const;

type Kind = 'backend' | 'host' | 'residue';
const TARGET = { backend: 'backend:claude', host: 'host', residue: `resource:${ESTATE1}` } as const;

const child = (mode: 'probe' | 'recover', r: ProbeRun, trigger: string | null) =>
  runFixture('probe-child.ts', [mode, JSON.stringify(r)], {
    env: trigger === null ? { ...process.env } : { ...process.env, ROADMAP_TEST_CRASH: trigger },
    timeoutMs: CHILD_TIMEOUT_MS,
  });

async function ok(mode: 'probe' | 'recover', r: ProbeRun): Promise<string> {
  const exit = await child(mode, r, null);
  assert.equal(exit.code, 0, `${mode}: ${exit.stderr}`);
  return exit.stdout.trim();
}

/**
 * A parked arc: claude parked on an outage, or u1 parked on a blocked lane; or a residue no park names, u1's lanes
 * holder having failed estate#1's teardown once. Returns the run and the seq a probe covers (the park's, or the
 * residue's fail seq).
 */
async function prepare(kind: Kind): Promise<Readonly<{ r: ProbeRun; seq: number }>> {
  const r = newProbeRun([claudeOk, claudeOk, claudeOk]);
  const { ctx, journal } = openProbeRun(r);
  seedArc(journal, [U1]);
  let seq: number;
  if (kind === 'residue') {
    writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
    const holder = { type: 'stage', unit: U1, stage: 'lanes', attempt: 1 } as const;
    const got = reserve(ctx, holder, { named: [], pools: [ESTATE], cpu: 0, publication: false }, holder);
    if (got.state !== 'reserved') throw new Error(`estate busy: ${JSON.stringify(got)}`);
    assert.equal((await cleanup(ctx, runReservation(ctx, got, holder), holder)).kind, 'cleanup-failed');
    seq = journal.view.residues()[0]!.failSeq;
  } else {
    seq = kind === 'backend' ? parkBackend(journal, 'claude', 'outage', null) : parkUnit(journal, U1, LANES_BLOCKED, 1, [{ type: 'host' }]);
  }
  journal.close();
  return { r, seq };
}

function assertRecovered(r: ProbeRun, kind: Kind, seq: number): void {
  const { view } = readJournal(absPath(r.runDir), arcId(r.arc));
  if (kind === 'backend') assert.deepEqual(view.backendParks(), []);
  else assert.equal(view.unit(U1).status, 'active');
  const passes = events(r.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'probe' && e.fact.result === 'pass' && probeTargetKey(e.fact.target) === TARGET[kind] ? [e.fact] : []));
  if (kind === 'residue') {
    assert.ok(passes.length <= 1 && passes.every((p) => JSON.stringify(p.covers) === JSON.stringify([seq])), JSON.stringify(passes));
    assert.deepEqual(view.resources().get(ESTATE1)?.status, { state: 'free' });
    assert.deepEqual(view.residues(), []);
    const hostDir = absPath(r.hostDir);
    assert.deepEqual(undispositioned(hostDir), []);
    assert.deepEqual(readResidues(hostDir).flatMap((l) => (l.type === 'disposition' ? [l.disposition] : [])), ['cleaned']);
  } else {
    assert.deepEqual(passes.map((p) => p.covers), [[seq]], 'exactly one pass, covering the park');
  }
  assert.deepEqual(view.openIntents(), []);
}

describe('probe.crash', { concurrency: 8 }, () => {
  const labels = crashCells(PROBE_JOB).map((c) => c.label);

  it('the row crashes the probe job at every boundary it names', () => {
    assert.deepEqual(labels, ['launch.after-launch-json', 'launch.after-spawn', 'probe.before-fact', 'probe.after-fact']);
  });

  for (const kind of ['backend', 'host', 'residue'] as const) {
    it(`${kind}: the uncrashed probe reaches each label once and recovers the park`, T, async () => {
      for (const label of labels) {
        const { r, seq } = await prepare(kind);
        const exit = await child('probe', r, writeTrigger(tmpDir('trigger'), { label, occurrence: 2 }));
        assert.equal(exit.code, 0, `${label}: ${exit.stderr}`);
        assert.equal(exit.stdout.trim(), 'pass');
        assertRecovered(r, kind, seq);
      }
    });

    for (const label of labels) {
      it(`${kind} ${label}: recovery and the next probe recover the park with exactly one pass; again, nothing changes`, T, async () => {
        const { r, seq } = await prepare(kind);
        const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence: 1 });
        const exit = await child('probe', r, trigger);
        assert.equal(exit.signal, 'SIGKILL', `the probe did not crash at ${label}: ${exit.stderr}`);
        assertFired(trigger);
        await ok('recover', r);
        // A durable pass leaves nothing due; so does a residue, whose reclaim order recovery (or the crashed job) finished.
        const finished = label === 'probe.after-fact' || kind === 'residue';
        assert.equal(await ok('probe', r), finished ? '' : 'pass', 'a durable pass leaves nothing due');
        assertRecovered(r, kind, seq);
        const before = events(r.runDir).length;
        await ok('recover', r);
        assert.equal(await ok('probe', r), '');
        assert.equal(events(r.runDir).length, before, 'nothing left to do');
      });
    }
  }
});
