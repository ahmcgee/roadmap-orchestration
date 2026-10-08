import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { adapt, schemaViolation, writeResult } from '../src/backends/adapter.ts';
import { ResultConflictError, UnsupportedSchemaError } from '../src/backends/errors.ts';
import type { BackendOutcomeKind, ExitFile, ResultFile } from '../src/core/records.ts';
import { tmpDir } from './helpers/repo.ts';
import { CAPACITY_TEXT, editClaudeResult, fixtureInvocation, writeExit, writeLaunch } from './helpers/scenario.ts';

const BIND = { v: 1, arc: 'arc-1', op: 'arc-1/7', inv: 'arc-1/7#1' } as const;
const EXIT0: ExitFile['child'] = { type: 'exited', code: 0 };
const EXIT1: ExitFile['child'] = { type: 'exited', code: 1 };

function outcome(r: ResultFile): BackendOutcomeKind {
  assert.equal(r.type, 'backend');
  return r.type === 'backend' ? r.outcome.kind : 'process-fault';
}

/** A capture whose stdout is edited: Claude's structured output replaced, or Codex's -o file rewritten. */
function edited(name: string, child: ExitFile['child'], edit: (invDir: string) => void): string {
  const invDir = fixtureInvocation(name, child);
  edit(invDir);
  return invDir;
}

const schemaInvalidClaude = (invDir: string): void => {
  editClaudeResult(invDir, (r) => ({ ...r, structured_output: { ok: 'yes' } }));
};

describe('adapter', () => {
  describe('adapter.precedence (over captured real CLI output)', () => {
    // Each backend: a capture with schema-valid output, and one without.
    const backends = [
      { name: 'codex', valid: 'codex-fresh', failed: 'codex-turn-failed' },
      { name: 'claude', valid: 'claude-judgment', failed: 'claude-api-error' },
    ] as const;
    for (const b of backends) {
      for (const cause of ['deadline', 'recovery-kill'] as const) {
        it(`${b.name}: cause ${cause} with schema-valid output → process-fault`, () => {
          assert.equal(outcome(adapt(fixtureInvocation(b.valid, EXIT0, cause))), 'process-fault');
        });
      }
      it(`${b.name}: cause cancel (a pause) with schema-valid output → cancelled{pause}, not a fault`, () => {
        const r = adapt(fixtureInvocation(b.valid, EXIT0, 'cancel'));
        assert.deepEqual(r.type === 'backend' ? r.outcome : null, { kind: 'cancelled', reason: 'pause' });
      });
      it(`${b.name}: a signal with schema-valid output → process-fault`, () => {
        assert.equal(outcome(adapt(fixtureInvocation(b.valid, { type: 'signalled', signal: 'SIGSEGV' }))), 'process-fault');
      });
      it(`${b.name}: a failed spawn → process-fault`, () => {
        assert.equal(outcome(adapt(fixtureInvocation(b.failed, { type: 'spawn-failed', error: 'ENOENT' }))), 'process-fault');
      });
      it(`${b.name}: non-zero exit with schema-valid output → malformed`, () => {
        assert.equal(outcome(adapt(fixtureInvocation(b.valid, EXIT1))), 'malformed');
      });
      it(`${b.name}: non-zero exit without schema-valid output → process-fault`, () => {
        assert.equal(outcome(adapt(fixtureInvocation(b.failed, EXIT1))), 'process-fault');
      });
      it(`${b.name}: exit 0 with schema-valid output → success`, () => {
        const r = adapt(fixtureInvocation(b.valid, EXIT0));
        assert.equal(r.type === 'backend' && r.outcome.kind === 'success' ? JSON.stringify(r.outcome.value) : null, '{"ok":true}');
      });
    }
    it('codex: exit 0 without schema-valid output (-o violates the schema) → malformed', () => {
      const r = adapt(edited('codex-fresh', EXIT0, (d) => writeFileSync(join(d, 'last.json'), '{"ok":"yes"}')));
      assert.equal(outcome(r), 'malformed');
      assert.match(r.type === 'backend' && r.outcome.kind === 'malformed' ? r.outcome.detail : '', /schema violation at \$\.ok/);
    });
    it('claude: exit 0 without schema-valid output (structured_output violates the schema) → malformed', () => {
      assert.equal(outcome(adapt(edited('claude-judgment', EXIT0, schemaInvalidClaude))), 'malformed');
    });
    it('claude: stop_reason refusal without schema-valid output → refusal', () => {
      const r = adapt(edited('claude-judgment', EXIT0, (d) => editClaudeResult(d, (o) => {
        delete o['structured_output'];
        return { ...o, stop_reason: 'refusal', result: "I can't help with that." };
      })));
      assert.deepEqual(r.type === 'backend' ? r.outcome : null, { kind: 'refusal', stopReason: 'refusal' });
    });
    it('claude: a reported session id other than the launched one turns success into malformed', () => {
      const r = adapt(edited('claude-judgment', EXIT0, (d) => editClaudeResult(d, (o) => ({ ...o, session_id: '11111111-1111-4111-8111-111111111111' }))));
      assert.equal(outcome(r), 'malformed');
    });
    it('a malformed complete stdout line is malformed output, with usage malformed', () => {
      const r = adapt(edited('codex-fresh', EXIT0, (d) => writeFileSync(join(d, 'stdout'), '{"type":"thread.started","thr\n')));
      assert.equal(outcome(r), 'malformed');
      assert.deepEqual(r.type === 'backend' ? r.usage : null, { kind: 'unavailable', reason: 'malformed' });
    });
    it('a torn final line (killed mid-write) is dropped: the complete events before it are still read', () => {
      const cut = (d: string): void => {
        const text = readFileSync(join(d, 'stdout'), 'utf8');
        const lines = text.split('\n').filter((l) => l !== '');
        // Every line but the last, then half of the last without its newline.
        writeFileSync(join(d, 'stdout'), `${lines.slice(0, -1).map((l) => `${l}\n`).join('')}${lines.at(-1)!.slice(0, 20)}`);
      };
      const codex = adapt(fixtureInvocation('codex-fresh', { type: 'signalled', signal: 'SIGKILL' }, 'deadline'));
      const codexCut = adapt(edited('codex-fresh', { type: 'signalled', signal: 'SIGKILL' }, cut));
      assert.equal(outcome(codexCut), 'process-fault');
      // The thread id of the first line survives: a continue can still resume it.
      assert.equal(codexCut.type === 'backend' && codexCut.role === 'build' ? codexCut.session : null, codex.type === 'backend' && codex.role === 'build' ? codex.session : 'x');
      const claude = adapt(edited('claude-judgment', EXIT0, cut));
      assert.equal(outcome(claude), 'malformed', 'no result event: the result line was the torn one');
      assert.deepEqual(claude.type === 'backend' ? claude.usage : null, { kind: 'unavailable', reason: 'no-result' });
    });
  });

  describe('backend.capacity-text', () => {
    it('codex: capacity and usage-limit text inside command output and the answer is not a backend error', () => {
      const r = adapt(edited('codex-fresh', EXIT0, (d) => {
        const lines = readFileSync(join(d, 'stdout'), 'utf8').trimEnd().split('\n');
        const noise = [
          { type: 'item.completed', item: { id: 'item_9', type: 'command_execution', command: 'npm test', aggregated_output: CAPACITY_TEXT, exit_code: 1, status: 'completed' } },
          { type: 'item.completed', item: { id: 'item_10', type: 'agent_message', text: CAPACITY_TEXT } },
        ].map((e) => JSON.stringify(e));
        writeFileSync(join(d, 'stdout'), `${[...lines.slice(0, 2), ...noise, ...lines.slice(2)].join('\n')}\n`);
      }));
      assert.equal(outcome(r), 'success');
      assert.deepEqual(r.type === 'backend' ? r.backendErrors : null, []);
    });
    it('claude: capacity text in a normal result is not a backend error', () => {
      const r = adapt(edited('claude-judgment', EXIT0, (d) => editClaudeResult(d, (o) => ({ ...o, result: CAPACITY_TEXT }))));
      assert.equal(outcome(r), 'success');
      assert.deepEqual(r.type === 'backend' ? r.backendErrors : null, []);
    });
  });

  describe('adapter.rerun-idempotent', () => {
    it('writes result.json once; a re-run over the same files is a byte-identical no-op', () => {
      const invDir = fixtureInvocation('codex-fresh', EXIT0);
      const first = writeResult(invDir);
      const bytes = readFileSync(join(invDir, 'result.json'), 'utf8');
      const second = writeResult(invDir);
      assert.deepEqual(second, first);
      assert.equal(readFileSync(join(invDir, 'result.json'), 'utf8'), bytes);
      assert.equal(bytes.endsWith('\n'), true);
    });
    it('a re-run that would write a different result is a loud error, and leaves the first result', () => {
      const invDir = fixtureInvocation('claude-judgment', EXIT0);
      writeResult(invDir);
      const bytes = readFileSync(join(invDir, 'result.json'), 'utf8');
      schemaInvalidClaude(invDir);
      assert.throws(() => writeResult(invDir), ResultConflictError);
      assert.equal(readFileSync(join(invDir, 'result.json'), 'utf8'), bytes);
    });
  });

  describe('adapter.command-verdict', () => {
    function command(child: ExitFile['child'], cause: ExitFile['cause'] = 'exited', expectedExit = 0): ResultFile {
      const invDir = tmpDir('inv');
      writeLaunch(invDir, { argv: ['npm', 'test'], cwd: invDir, terminal: { type: 'command', purpose: 'lane', expectedExit }, stdinPath: null });
      writeExit(invDir, child, cause);
      return writeResult(invDir);
    }
    const verdict = (r: ResultFile): [number | null, string] => (r.type === 'command' ? [r.exitCode, r.verdict] : [null, 'not a command']);
    it('exit code equal to expectedExit → pass', () => assert.deepEqual(verdict(command(EXIT0)), [0, 'pass']));
    it('a non-zero expectedExit is honoured', () => assert.deepEqual(verdict(command({ type: 'exited', code: 3 }, 'exited', 3)), [3, 'pass']));
    it('another exit code → fail', () => assert.deepEqual(verdict(command(EXIT1)), [1, 'fail']));
    it('a signal → process-fault with exitCode null', () => {
      assert.deepEqual(verdict(command({ type: 'signalled', signal: 'SIGKILL' })), [null, 'process-fault']);
    });
    it('a deadline kill → process-fault even when the child exited 0', () => {
      assert.deepEqual(verdict(command(EXIT0, 'deadline')), [0, 'process-fault']);
    });
    it('a failed spawn → process-fault', () => {
      assert.deepEqual(verdict(command({ type: 'spawn-failed', error: 'ENOENT' })), [null, 'process-fault']);
    });

    /** A lane the executor cancelled for a stop: launch.json, cancel.json, exit.json with cause cancel. */
    function cancelledLane(): string {
      const invDir = tmpDir('inv');
      writeLaunch(invDir, { argv: ['npm', 'test'], cwd: invDir, terminal: { type: 'command', purpose: 'lane', expectedExit: 0 }, stdinPath: null });
      writeFileSync(join(invDir, 'cancel.json'), JSON.stringify({ ...BIND, reason: 'stop', at: '2026-09-25T11:59:59.000Z' }));
      writeExit(invDir, { type: 'signalled', signal: 'SIGTERM' }, 'cancel');
      return invDir;
    }

    it('adapter.lane-cancelled: a cancel → cancelled{cancel.json\'s reason}, the shape a backend call records', () => {
      const r = writeResult(cancelledLane());
      assert.deepEqual(r.type === 'command' ? [r.exitCode, r.verdict, r.verdict === 'cancelled' ? r.reason : null] : r, [null, 'cancelled', 'stop']);
    });

  });

  describe('schemaViolation', () => {
    const schema = {
      type: 'object', additionalProperties: false, required: ['verdict', 'notes', 'n'],
      properties: {
        verdict: { type: 'string', enum: ['approve', 'reject'] },
        notes: { type: 'array', items: { type: 'string', maxLength: 5 }, maxItems: 2 },
        n: { type: ['integer', 'null'], minimum: 0 },
      },
    };
    it('accepts a conforming value', () => assert.equal(schemaViolation(schema, { verdict: 'approve', notes: ['a'], n: null }), null));
    it('names the path of the first violation', () => {
      assert.match(schemaViolation(schema, { verdict: 'maybe', notes: [], n: 1 }) ?? '', /^\$\.verdict: not in enum/);
      assert.match(schemaViolation(schema, { verdict: 'approve', notes: ['toolong'], n: 1 }) ?? '', /^\$\.notes\[0\]: longer than 5/);
      assert.match(schemaViolation(schema, { verdict: 'approve', notes: [], n: 1.5 }) ?? '', /^\$\.n: expected type integer\|null/);
      assert.match(schemaViolation(schema, { verdict: 'approve', notes: [] }) ?? '', /^\$\.n: required/);
      assert.match(schemaViolation(schema, { verdict: 'approve', notes: [], n: 0, extra: 1 }) ?? '', /^\$\.extra: not allowed/);
    });
    it('refuses a keyword it does not implement instead of skipping it', () => {
      assert.throws(() => schemaViolation({ type: 'object', $ref: '#/x' }, {}), UnsupportedSchemaError);
      assert.throws(() => schemaViolation({ type: 'object', additionalProperties: { type: 'string' } }, {}), UnsupportedSchemaError);
    });
  });
});
