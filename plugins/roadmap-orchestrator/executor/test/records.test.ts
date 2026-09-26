import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ExitFile, MIN_GRACE_MS, RUNNER_FILE_READERS, type RunnerFileName, approvalFingerprint, classifyCommand, classifyTerminal, commandFile,
  handshakeFile, hostLockClaim, hostOwner, needsUserAck, needsUserRecord, readinessFile, receipt, recoveryLockClaim,
  specM1, specPatch, supervisorState,
} from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';

const UUID = '0190f6c2-8f3a-7d21-9a4e-3b5c6d7e8f90';
const T0 = '2026-09-25T12:00:00.000Z';
const T1 = '2026-09-25T12:00:01.000Z';
const bind = { v: 1, arc: 'arc-1', op: 'arc-1/7', inv: 'arc-1/7#1' };

const RUNNER_SAMPLES: { readonly [N in RunnerFileName]: Record<string, unknown> } = {
  'launch.json': {
    ...bind, argv: ['codex', 'exec', '-'], cwd: '/var/tmp/wt/u1', env: { HOME: '/home/x' }, stdinPath: '/run/inv/7-1/stdin',
    deadlineAt: T1, graceMs: 5000, containment: 'session', test: null,
    terminal: { type: 'backend', purpose: 'backend', role: 'build', routingRev: '0123456789abcdef', schemaPath: '/run/s.json', outputPath: '/run/inv/7-1/last.json', session: { backend: 'codex', mode: 'fresh' } },
  },
  'runner.json': { ...bind, runner: { pid: 100, start: 5555, bootId: UUID }, child: { pid: 101, start: 5556, sid: 101 } },
  'cancel.json': { ...bind, reason: 'pause', at: T0 },
  'exit.json': { ...bind, child: { type: 'exited', code: 0 }, cause: 'exited', endedAt: T0, quiescedAt: T1 },
  'result.json': {
    ...bind, type: 'backend', role: 'gate', routingRev: '0123456789abcdef', session: UUID,
    outcome: { kind: 'success', value: { decision: 'approve' } }, usage: { kind: 'unavailable', reason: 'absent' }, backendErrors: [],
  },
};

function exit(child: ExitFile['child'], cause: ExitFile['cause'] = 'exited'): ExitFile {
  return RUNNER_FILE_READERS['exit.json']({ ...bind, child, cause, endedAt: T0, quiescedAt: T1 }, 'exit.json');
}

function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

describe('records', () => {
  it('launch.json refuses a grace under MIN_GRACE_MS (the backstop at deadline + 2 * grace must not beat exit.json)', () => {
    const read = RUNNER_FILE_READERS['launch.json'];
    assert.equal(MIN_GRACE_MS, 1_000);
    assert.equal(read({ ...RUNNER_SAMPLES['launch.json'], graceMs: MIN_GRACE_MS }, 'launch.json').graceMs, MIN_GRACE_MS);
    for (const graceMs of [MIN_GRACE_MS - 1, 500, 0]) {
      assert.throws(() => read({ ...RUNNER_SAMPLES['launch.json'], graceMs }, 'launch.json'), (e: unknown) => e instanceof SchemaError && e.field === 'launch.json.graceMs');
    }
  });

  describe('classifyTerminal precedence', () => {
    const output = { decision: 'approve' };
    for (const cause of ['deadline', 'cancel', 'recovery-kill'] as const) {
      it(`cause ${cause} → process-fault regardless of schema-valid output`, () => {
        assert.equal(classifyTerminal(exit({ type: 'exited', code: 0 }, cause), output, true).kind, 'process-fault');
        assert.equal(classifyTerminal(exit({ type: 'signalled', signal: 'SIGKILL' }, cause), output, true).kind, 'process-fault');
      });
    }
    it('a signal → process-fault regardless of schema-valid output', () => {
      assert.equal(classifyTerminal(exit({ type: 'signalled', signal: 'SIGSEGV' }), output, true).kind, 'process-fault');
    });
    it('a failed spawn → process-fault', () => {
      assert.equal(classifyTerminal(exit({ type: 'spawn-failed', error: 'EACCES' }), undefined, false).kind, 'process-fault');
    });
    it('non-zero exit with schema-valid output → malformed', () => {
      assert.equal(classifyTerminal(exit({ type: 'exited', code: 1 }), output, true).kind, 'malformed');
    });
    it('non-zero exit without schema-valid output → process-fault', () => {
      assert.equal(classifyTerminal(exit({ type: 'exited', code: 1 }), undefined, false).kind, 'process-fault');
    });
    it('exit 0 without schema-valid output → malformed', () => {
      assert.equal(classifyTerminal(exit({ type: 'exited', code: 0 }), { partial: true }, false).kind, 'malformed');
    });
    it('exit 0 with schema-valid output → success carrying the output', () => {
      assert.deepEqual(classifyTerminal(exit({ type: 'exited', code: 0 }), output, true), { kind: 'success', value: output });
    });
  });

  describe('classifyCommand', () => {
    it('grades by expected exit, and faults on a runner kill or signal', () => {
      assert.deepEqual(classifyCommand(exit({ type: 'exited', code: 0 }), 0), { exitCode: 0, verdict: 'pass' });
      assert.deepEqual(classifyCommand(exit({ type: 'exited', code: 1 }), 0), { exitCode: 1, verdict: 'fail' });
      assert.deepEqual(classifyCommand(exit({ type: 'exited', code: 3 }), 3), { exitCode: 3, verdict: 'pass' });
      assert.deepEqual(classifyCommand(exit({ type: 'exited', code: 0 }, 'deadline'), 0), { exitCode: 0, verdict: 'process-fault' });
      assert.deepEqual(classifyCommand(exit({ type: 'signalled', signal: 'SIGTERM' }), 0), { exitCode: null, verdict: 'process-fault' });
    });
  });

  describe('runner file validators', () => {
    for (const name of Object.keys(RUNNER_SAMPLES) as RunnerFileName[]) {
      const sample = RUNNER_SAMPLES[name];
      it(`${name} accepts the sample`, () => {
        assert.deepEqual(RUNNER_FILE_READERS[name](sample, name), sample);
      });
      for (const field of Object.keys(sample)) {
        it(`${name} rejects a missing ${field}`, () => {
          assert.throws(() => RUNNER_FILE_READERS[name](without(sample, field), name), (err: unknown) =>
            err instanceof SchemaError && err.field === `${name}.${field}`);
        });
      }
      it(`${name} rejects an unknown field`, () => {
        assert.throws(() => RUNNER_FILE_READERS[name]({ ...sample, extra: 1 }, name), /extra: expected no such field/);
      });
      it(`${name} rejects an inv of another op`, () => {
        assert.throws(() => RUNNER_FILE_READERS[name]({ ...sample, inv: 'arc-1/8#1' }, name), /inv: expected an invocation of arc-1\/7/);
      });
    }

    it('launch.json: a model id may appear only inside argv; the terminal names role and routingRev', () => {
      const launch = RUNNER_SAMPLES['launch.json'];
      const terminal = launch['terminal'] as Record<string, unknown>;
      assert.throws(() => RUNNER_FILE_READERS['launch.json']({ ...launch, terminal: { ...terminal, model: 'gpt-5.6-luna' } }, 'launch.json'), /terminal\.model: expected no such field/);
    });
    it('launch.json: a judgment role takes only a fresh Claude judgment session', () => {
      const launch = RUNNER_SAMPLES['launch.json'];
      const terminal = { ...(launch['terminal'] as Record<string, unknown>), role: 'gate' };
      assert.throws(() => RUNNER_FILE_READERS['launch.json']({ ...launch, terminal: { ...terminal, session: { backend: 'claude', mode: 'resume', id: UUID } } }, 'launch.json'), /session\.mode/);
      assert.ok(RUNNER_FILE_READERS['launch.json']({ ...launch, terminal: { ...terminal, session: { backend: 'claude', mode: 'fresh', id: UUID } } }, 'launch.json'));
    });
    it('launch.json: declared env may not set ROADMAP_* (the runner owns them)', () => {
      assert.throws(() => RUNNER_FILE_READERS['launch.json']({ ...RUNNER_SAMPLES['launch.json'], env: { ROADMAP_INV: 'x' } }, 'launch.json'), /env\.ROADMAP_INV/);
    });
    it('exit.json: quiescence cannot precede the child\'s end', () => {
      assert.throws(() => RUNNER_FILE_READERS['exit.json']({ ...RUNNER_SAMPLES['exit.json'], endedAt: T1, quiescedAt: T0 }, 'exit.json'), /quiescedAt/);
    });
    it('result.json: a command result with no exit code must be a process fault', () => {
      const cmd = { ...bind, type: 'command', purpose: 'lane', exitCode: null, expectedExit: 0, verdict: 'fail' };
      assert.throws(() => RUNNER_FILE_READERS['result.json'](cmd, 'result.json'), /verdict/);
      assert.ok(RUNNER_FILE_READERS['result.json']({ ...cmd, verdict: 'process-fault' }, 'result.json'));
    });
  });

  it('approval fingerprint lists are sorted and unique', () => {
    const fp = { unitCommit: 'a'.repeat(40), specRev: 2, contractRevs: [{ path: 'a.md', blob: 'b'.repeat(40) }, { path: 'b.md', blob: 'c'.repeat(40) }], rulingRevs: [{ id: 'C-1', rev: 1 }] };
    assert.deepEqual(approvalFingerprint(fp, 'fp'), fp);
    assert.throws(() => approvalFingerprint({ ...fp, contractRevs: [...fp.contractRevs].reverse() }, 'fp'), /fp\.contractRevs\[1\]/);
  });

  it('spec.json M1 subset parses and rejects duplicate item ids', () => {
    const lane = { id: 'L1', argv: ['npm', 'test'], cwd: '.', env: { set: { CI: '1' }, pass: ['HOME'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: ['coverage/**'], state: 'active' };
    const spec = {
      schema: 'roadmap/spec-m1', unit: 'u1', rev: 1, lanes: [lane],
      acceptance: [{ id: 'A1', clause: 'x works', failLoudIfUndelivered: true, state: 'active' }],
      scope: ['src/**'], resources: [], decisions: [{ id: 'R1', text: 'use y', state: 'active' }], facts: [],
    };
    assert.deepEqual(specM1(spec, 'spec'), spec);
    assert.throws(() => specM1({ ...spec, facts: [{ id: 'A1', text: 'dup', state: 'active' }] }, 'spec'), /spec\.<item ids>/);
    assert.throws(() => specM1({ ...spec, lanes: [{ ...lane, tier: 'slow' }] }, 'spec'), /spec\.lanes\[0\]\.tier/);
  });

  it('SpecPatch reads each op form and refuses an empty patch', () => {
    const patch = {
      expectRev: 1, by: { role: 'planCheck', routingRev: '0123456789abcdef', inv: 'arc-1/7#1' },
      ops: [{ op: 'add', section: 'facts', item: { id: 'F2', text: 't' } }, { op: 'strike', id: 'A1' }],
    };
    assert.deepEqual(specPatch(patch, 'patch'), patch);
    assert.throws(() => specPatch({ ...patch, ops: [] }, 'patch'), /patch\.ops/);
    assert.throws(() => specPatch({ ...patch, ops: [{ op: 'add', section: 'scope', item: {} }] }, 'patch'), /patch\.ops\[0\]\.section/);
  });

  it('host files validate', () => {
    const proc = { pid: 10, start: 20 };
    const nonce = 'e'.repeat(32);
    const claim = { v: 1, nonce, generation: 1, bootId: UUID, supervisor: proc, arc: 'arc-1', runDir: '/r/.git/roadmap-runtime/arc-1', repo: '/r' };
    assert.deepEqual(hostLockClaim(claim, 'host.lock'), claim);
    assert.throws(() => hostLockClaim(without(claim, 'runDir'), 'host.lock'), /host\.lock\.runDir/);
    assert.ok(hostOwner({ v: 1, nonce, generation: 1, executor: null }, 'owner'));
    assert.ok(recoveryLockClaim({ v: 1, nonce, bootId: UUID, holder: proc, at: T0 }, 'rec'));
    assert.ok(handshakeFile({ v: 1, nonce, generation: 2 }, 'hs'));
    assert.ok(readinessFile({ v: 1, generation: 2, state: 'failed', at: T0, reason: 'x' }, 'ready'));
    assert.throws(() => readinessFile({ v: 1, generation: 2, state: 'ready', at: T0, reason: 'x' }, 'ready'), /ready\.reason/);
    assert.ok(supervisorState({ v: 1, generation: 3, crashes: [T0, T1], heartbeatStaleMs: 300_000 }, 'sup'));
    assert.throws(() => supervisorState({ v: 1, generation: 3, crashes: [T1, T0], heartbeatStaleMs: 300_000 }, 'sup'), /sup\.crashes/);
  });

  it('commands, receipts and needs-user validate', () => {
    assert.ok(commandFile({ v: 1, id: 'cmd-0123456789abcdef', arc: 'arc-1', at: T0, body: { type: 'resume', target: { type: 'backend', backend: 'codex' } } }, 'cmd'));
    assert.throws(() => commandFile({ v: 1, id: 'cmd-0123456789abcdef', arc: 'arc-1', at: T0, body: { type: 'rule' } }, 'cmd'), /cmd\.body\.type/);
    assert.ok(receipt({ v: 1, command: 'cmd-0123456789abcdef', state: 'applied', at: T0, op: 'arc-1/9', verified: ['unit u1 parked'] }, 'r'));
    assert.throws(() => receipt({ v: 1, command: 'cmd-0123456789abcdef', state: 'applied', at: T0 }, 'r'), /r\.op/);
    const nu = {
      v: 1, id: 'nu-9', arc: 'arc-1', raisedAt: T0, blocking: true, subject: { type: 'unit', unit: 'u1' }, reason: 'residue',
      summary: 's', recommendation: 'isolate', options: [{ id: 'isolated', label: 'I isolated it' }, { id: 'transferred', label: 'I own it now' }], evidence: [],
    };
    assert.deepEqual(needsUserRecord(nu, 'nu'), nu);
    assert.throws(() => needsUserRecord({ ...nu, reason: 'other' }, 'nu'), /nu\.reason/);
    assert.ok(needsUserAck({ v: 1, id: 'nu-9', command: 'cmd-0123456789abcdef', choice: 'isolated', at: T1 }, 'ack'));
  });
});
