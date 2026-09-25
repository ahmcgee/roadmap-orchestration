import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arcId, invocationIdOf, laneId, resourceName, sha, unitId } from '../src/core/ids.ts';
import { absPath, planPath } from '../src/core/values.ts';
import { EXIT_HOST_BUSY, EXIT_REFUSED, type StartupRejection, type StartupRejectionKind, exitCodeFor } from '../src/preflight/startup.ts';

const arc = arcId('arc-1');
const unit = unitId('u1');

// One sample per member; the mapped type makes a new member fail compilation until it has a sample here.
const SAMPLES: { readonly [K in StartupRejectionKind]: Extract<StartupRejection, { kind: K }> } = {
  'legacy-roadmap-dir': { kind: 'legacy-roadmap-dir', path: absPath('/r/.roadmap'), unexpected: ['state.json'] },
  'worktree-root-unusable': { kind: 'worktree-root-unusable', path: absPath('/tmp/wt'), problem: 'tmpfs', detail: 'tmpfs' },
  'spec-lane-unrunnable': { kind: 'spec-lane-unrunnable', unit, lane: laneId('L1'), problem: { type: 'env-missing', name: 'KUBECONFIG' } },
  'unsupported-routing': { kind: 'unsupported-routing', role: 'gate', tier: 'high', layer: 'plan', unit: null, why: 'codex-judgment' },
  'undispositioned-residue': { kind: 'undispositioned-residue', residues: [{ arc, unit, inv: invocationIdOf('arc-1/4#1'), resource: resourceName('db') }] },
  'host-busy': { kind: 'host-busy', holder: 'owner', arc, generation: 3, pid: 1234 },
  'previous-arc-unreconciled': { kind: 'previous-arc-unreconciled', arc: arcId('arc-0'), invocations: [invocationIdOf('arc-0/9#1')] },
  'backend-smoke': { kind: 'backend-smoke', profile: 'default', backend: 'codex', problem: 'failed', detail: 'auth' },
  'plan-invalid': { kind: 'plan-invalid', problem: { type: 'unknown-spec-path', unit, path: planPath('specs/u1.json') } },
  'recovery-holder-dead': { kind: 'recovery-holder-dead', pid: 99 },
  'owner-mismatch': { kind: 'owner-mismatch', detail: 'nonce differs' },
  'log-corrupt': { kind: 'log-corrupt', file: absPath('/r/.git/roadmap-runtime/arc-1/events.jsonl'), offset: 4096, detail: 'bad line' },
  'containment-mode-changed': { kind: 'containment-mode-changed', recorded: 'session', detected: 'cgroup' },
};

describe('startup rejection table', () => {
  for (const [kind, rejection] of Object.entries(SAMPLES) as [StartupRejectionKind, StartupRejection][]) {
    it(`${kind} has an exit code`, () => {
      assert.equal(exitCodeFor(rejection), kind === 'host-busy' ? EXIT_HOST_BUSY : EXIT_REFUSED);
    });
  }

  it('refusals exit 78 and a live holder exits 75', () => {
    assert.equal(EXIT_REFUSED, 78);
    assert.equal(EXIT_HOST_BUSY, 75);
    assert.equal(exitCodeFor({ kind: 'host-busy', holder: 'recovery', arc, generation: 1, pid: 1 }), 75);
    assert.equal(exitCodeFor({ kind: 'plan-invalid', problem: { type: 'baseline-not-ancestor', baseline: sha('a'.repeat(40)), tip: sha('b'.repeat(40)) } }), 78);
  });
});
