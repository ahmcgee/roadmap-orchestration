// Crash tests of a probe job (src/park/probe.ts), driven by probe-child.ts: the probe of a backend target (a
// claude outage park: the backend's smoke) and of the host target (a blocked-lane park: the host sample and
// the smoke's shell command), crashed at every label of the matrix row `probe job`. After each crash, recovery
// and the next probe leave the park recovered by exactly one passing probe fact covering it, nothing open,
// and a second recovery and probe append nothing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { probeTargetKey } from '../src/core/events.ts';
import { arcId, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { events } from './fixtures/invoke-specs.ts';
import { LANES_BLOCKED, type ProbeRun, newProbeRun, openProbeRun, parkBackend, parkUnit, seedArc } from './fixtures/probe-common.ts';
import { PROBE_JOB, crashCells } from './matrix.ts';

const CHILD_TIMEOUT_MS = 60_000;
const T = { timeout: 180_000 };
const U1 = unitId('u1');
const claudeOk = { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: { ok: true } }] } as const;

type Kind = 'backend' | 'host';
const TARGET = { backend: 'backend:claude', host: 'host' } as const;

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

/** A parked arc: claude parked on an outage, or u1 parked on a blocked lane; returns the run and the park's seq. */
function prepare(kind: Kind): Readonly<{ r: ProbeRun; seq: number }> {
  const r = newProbeRun([claudeOk, claudeOk, claudeOk]);
  const { journal } = openProbeRun(r);
  seedArc(journal, [U1]);
  const seq = kind === 'backend' ? parkBackend(journal, 'claude', 'outage', null) : parkUnit(journal, U1, LANES_BLOCKED, 1, [{ type: 'host' }]);
  journal.close();
  return { r, seq };
}

function assertRecovered(r: ProbeRun, kind: Kind, seq: number): void {
  const { view } = readJournal(absPath(r.runDir), arcId(r.arc));
  if (kind === 'backend') assert.deepEqual(view.backendParks(), []);
  else assert.equal(view.unit(U1).status, 'active');
  const passes = events(r.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'probe' && e.fact.result === 'pass' && probeTargetKey(e.fact.target) === TARGET[kind] ? [e.fact] : []));
  assert.deepEqual(passes.map((p) => p.covers), [[seq]], 'exactly one pass, covering the park');
  assert.deepEqual(view.openIntents(), []);
}

describe('probe.crash', { concurrency: 8 }, () => {
  const labels = crashCells(PROBE_JOB).map((c) => c.label);

  it('the row crashes the probe job at every boundary it names', () => {
    assert.deepEqual(labels, ['launch.after-launch-json', 'launch.after-spawn', 'probe.before-fact', 'probe.after-fact']);
  });

  for (const kind of ['backend', 'host'] as const) {
    it(`${kind}: the uncrashed probe reaches each label once and recovers the park`, T, async () => {
      for (const label of labels) {
        const { r, seq } = prepare(kind);
        const exit = await child('probe', r, writeTrigger(tmpDir('trigger'), { label, occurrence: 2 }));
        assert.equal(exit.code, 0, `${label}: ${exit.stderr}`);
        assert.equal(exit.stdout.trim(), 'pass');
        assertRecovered(r, kind, seq);
      }
    });

    for (const label of labels) {
      it(`${kind} ${label}: recovery and the next probe recover the park with exactly one pass; again, nothing changes`, T, async () => {
        const { r, seq } = prepare(kind);
        const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence: 1 });
        const exit = await child('probe', r, trigger);
        assert.equal(exit.signal, 'SIGKILL', `the probe did not crash at ${label}: ${exit.stderr}`);
        assertFired(trigger);
        await ok('recover', r);
        assert.equal(await ok('probe', r), label === 'probe.after-fact' ? '' : 'pass', 'a durable pass leaves nothing due');
        assertRecovered(r, kind, seq);
        const before = events(r.runDir).length;
        await ok('recover', r);
        assert.equal(await ok('probe', r), '');
        assert.equal(events(r.runDir).length, before, 'nothing left to do');
      });
    }
  }
});
