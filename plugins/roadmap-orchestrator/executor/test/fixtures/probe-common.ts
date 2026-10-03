// Shared by the park and prober tests and probe-child.ts: a run over the pool plan (pool-plan.ts: named
// resources, an estate pool) with fake backends behind PATH shims, a prober context over it (claude-only
// routing, an injected host sample), a recovery context, and builders for the facts that park units.
import { join } from 'node:path';
import type { Fact, ProbeTarget, StageOutcomeFact } from '../../src/core/events.ts';
import { appliedFields } from './log-records.ts';
import { type InvocationId, type UnitId, planRev, routingRev, seatRev, sha256, specRev } from '../../src/core/ids.ts';
import type { Journal } from '../../src/core/interfaces.ts';
import type { OpenJournal } from '../../src/core/log.ts';
import { absPath, isoTimeOf, repoPattern } from '../../src/core/values.ts';
import type { HostSample } from '../../src/host/sample.ts';
import { type ProberContext, createProber } from '../../src/park/probe.ts';
import { backendEnv } from '../../src/preflight/smoke.ts';
import type { RecoveryContext } from '../../src/recover/recover.ts';
import { DOCS_NOT_YET } from '../../src/recover/revision.ts';
import { resolveRouting } from '../../src/routing/layers.ts';
import type { Backend } from '../../src/routing/types.ts';
import { tmpDir } from '../helpers/repo.ts';
import { type Step, writeScenario } from '../helpers/scenario.ts';
import { newRun, openPoolRun } from './pool-plan.ts';
import type { ResRun } from './res-plan.ts';
import { serialRuntime } from './stage-common.ts';

/** Everything a child needs to rebuild the same prober context, as plain JSON. */
export type ProbeRun = ResRun & Readonly<{ binDir: string; planDir: string }>;

export function newProbeRun(steps: readonly Step[]): ProbeRun {
  const s = writeScenario(tmpDir('probe-scenario'), steps);
  return { ...newRun(), binDir: s.binDir, planDir: tmpDir('probe-plan') };
}

export const CLEAR: HostSample = { load1: 0.5, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 800_000 };
export const BUSY: HostSample = { load1: 32, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 800_000 };

export type OpenedProbe = Readonly<{ ctx: ProberContext; recovery: RecoveryContext; journal: OpenJournal; host: { sample: HostSample } }>;

export function openProbeRun(r: ProbeRun): OpenedProbe {
  const { ctx: resources, journal } = openPoolRun(r);
  const resolved = resolveRouting({ profile: 'claude-only', classes: null, repoConfig: null, plan: null, unit: null });
  const hostEnv = { ...process.env, PATH: `${r.binDir}:${process.env['PATH'] ?? ''}` };
  const host = { sample: CLEAR };
  const planDir = absPath(r.planDir);
  const ctx: ProberContext = {
    ...resources, routing: () => resolved, hostEnv, planDir, profile: 'claude-only', sample: () => host.sample, ...serialRuntime(resources),
  };
  const recovery: RecoveryContext = {
    stage: ctx,
    commands: {
      ...resources, hostEnv: backendEnv(hostEnv), laneEnv: hostEnv, routing: () => ({ profile: 'claude-only', resolved }),
      routingBase: { profile: 'claude-only', config: null }, docs: DOCS_NOT_YET, planFile: absPath(join(r.planDir, 'plan.json')), planDir,
      probes: { prober: createProber(ctx), signal: new AbortController().signal },
    },
  };
  return { ctx, recovery, journal, host };
}

// ---------------------------------------------------------------------------------------------------
// Facts

const H = sha256('d'.repeat(64));

/** Revision 1 of a DAG arc naming `units`, then a dispatch of each: what parks need to exist. */
export function seedArc(journal: Journal, units: readonly UnitId[]): void {
  journal.fact({
    kind: 'plan-applied', rev: planRev(1), command: null, planSha256: H, specs: Object.fromEntries(units.map((u) => [u, H])), changes: [], ...appliedFields(1, null),
  } as Fact);
  for (const unit of units) {
    journal.fact({
      kind: 'dispatch',
      record: {
        unit, specRev: specRev(1), specSha256: H, scope: [repoPattern('src/**')], riskFloor: 'med', routingRev: routingRev('0123456789abcdef'),
        implementerSeatRev: seatRev('fedcba9876543210'), at: isoTimeOf(new Date()), transientRules: 'm3',
      },
    });
  }
}

type ParkedAt = Readonly<{ stage: StageOutcomeFact['stage']; outcome: string }>;
export const LANES_BLOCKED: ParkedAt = { stage: 'lanes', outcome: 'blocked' };
export const SALVAGE_COMMIT_FAILED: ParkedAt = { stage: 'salvage', outcome: 'commit-failed' };
export const PLAN_CHECK_FAULT: ParkedAt = { stage: 'plan-check', outcome: 'process-fault' };
export const BUILD_CLEANUP_FAILED: ParkedAt = { stage: 'build', outcome: 'cleanup-failed' };

/** A retryable park of `unit` at `at`, attempt `attempt`, on `targets`; returns its seq (the park's). */
export function parkUnit(journal: Journal, unit: UnitId, at: ParkedAt, attempt: number, targets: readonly ProbeTarget[]): number {
  return journal.fact({
    kind: 'stage-outcome', unit, stage: at.stage, attempt, outcome: at.outcome, class: 'park', chargeable: false, park: { class: 'retryable', targets },
  } as StageOutcomeFact);
}

/** A backend park; `inv` null exactly for an outage. Returns its seq (the park's epoch). */
export function parkBackend(journal: Journal, backend: Backend, cls: 'usage-limit' | 'capacity' | 'outage', inv: InvocationId | null): number {
  return journal.fact({ kind: 'backend-park', backend, class: cls, inv });
}
