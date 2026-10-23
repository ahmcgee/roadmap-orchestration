// dev.17 record types (SCHEMAS.md "dev.17 records"): the spec's design record and revision pins with their read-time
// defaults, the plan-check design decisions' payloads, the findings ledger and approval blobs, the flaky ledger. Readers
// only: behaviour is tested where it is wired.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flakyLedgerEntry } from '../src/core/flaky.ts';
import { obligationId, sha } from '../src/core/ids.ts';
import { UNPINNED } from '../src/core/pins.ts';
import { specKindOf, specM1, specPinOf } from '../src/core/records.ts';
import { approvalBlobs, findingsLedgerEntry } from '../src/core/review.ts';
import { designSize } from '../src/core/design.ts';
import { SchemaError } from '../src/core/validate.ts';
import { repoPath } from '../src/core/values.ts';
import { pocDecision, scaffoldDecision, splitDecision } from '../src/prompts/schemas.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function spec(unit: string, extra: object = {}): Record<string, unknown> {
  return {
    schema: 'roadmap/spec-m1', unit, rev: 1, lanes: [], acceptance: [{ id: 'a1', clause: 'It works.', failLoudIfUndelivered: true, state: 'active' }],
    scope: ['src/**'], resources: [], decisions: [], facts: [], cites: { contracts: ['docs/api.md'], rulings: [] }, obligations: ['I-1'],
    witnesses: [{ id: 'W-1', lane: 'unit', testId: 't1', clause: 'a1', skeleton: 'asserts it works', state: 'active' }],
    ...extra,
  };
}

const DESIGN = {
  kind: 'integration',
  changes: [{ system: 'api', paths: ['src/api/**'], lines: 40 }, { system: null, paths: ['tools/x.ts'], lines: 5 }],
  interfaces: [{ type: 'contract', path: 'docs/api.md', blob: A }],
  failureModes: [
    { id: 'FM-1', mode: 'empty input', proof: { type: 'test', test: { type: 'witness', item: 'W-1' } }, requirements: [{ type: 'requirement', id: 'I-1', rev: 2 }] },
    { id: 'FM-2', mode: 'disk full', proof: { type: 'untested', reason: 'no fault injection here' }, requirements: [] },
  ],
  breaks: { tests: [{ type: 'file', path: 'test/api.test.ts', blob: B }], docs: [] },
  experiments: [{ command: 'npm test', output: 'ok' }],
  verification: { type: 'repeat', rationale: 'timing only', runs: 5 },
};

const refuses = (read: () => unknown, field: RegExp): void =>
  assert.throws(read, (err: unknown) => err instanceof SchemaError && field.test(err.field));

describe('spec design record and pins', () => {
  it('reads a spec with a design record and pins; its kind is the record\'s and its links read their pins', () => {
    const s = specM1(spec('u1', { design: DESIGN, pins: [{ type: 'requirement', id: 'I-1', rev: 2 }, { type: 'contract', path: 'docs/api.md', blob: A }] }), 'spec');
    assert.equal(specKindOf(s), 'integration');
    assert.equal(designSize(s.design!), 45);
    assert.deepEqual(specPinOf(s, { type: 'requirement', id: obligationId('I-1') }), { type: 'requirement', id: 'I-1', rev: 2 });
    assert.deepEqual(specPinOf(s, { type: 'contract', path: repoPath('docs/api.md') }), { type: 'contract', path: 'docs/api.md', blob: A });
  });

  it('a link a present pin list leaves out reads unpinned', () => {
    const s = specM1(spec('u1', { pins: [{ type: 'requirement', id: 'I-1', rev: 2 }] }), 'spec');
    assert.equal(specPinOf(s, { type: 'contract', path: repoPath('docs/api.md') }), UNPINNED);
  });

  it('a dev.16 spec (no design, no pins) reads kind module and every link unpinned', () => {
    const s = specM1(spec('u1'), 'spec');
    assert.equal(specKindOf(s), 'module');
    assert.equal(specPinOf(s, { type: 'requirement', id: obligationId('I-1') }), UNPINNED);
  });

  it('refuses a pin of no link, a duplicate pin, a failure mode citing a witness item the spec lacks, an unknown kind', () => {
    refuses(() => specM1(spec('u1', { pins: [{ type: 'requirement', id: 'I-9', rev: 1 }] }), 'spec'), /^spec\.pins\[0\]$/);
    refuses(() => specM1(spec('u1', { pins: [{ type: 'requirement', id: 'I-1', rev: 1 }, { type: 'requirement', id: 'I-1', rev: 2 }] }), 'spec'), /^spec\.pins/);
    const fm = { ...DESIGN.failureModes[0], proof: { type: 'test', test: { type: 'witness', item: 'W-7' } } };
    refuses(() => specM1(spec('u1', { design: { ...DESIGN, failureModes: [fm] } }), 'spec'), /^spec\.design\.failureModes\[0\]\.proof$/);
    refuses(() => specM1(spec('u1', { design: { ...DESIGN, kind: 'service' } }), 'spec'), /^spec\.design\.kind$/);
    refuses(() => specM1(spec('u1', { design: { ...DESIGN, changes: [] } }), 'spec'), /^spec\.design\.changes$/);
  });
});

describe('plan-check design decisions', () => {
  // dev.17 (design pass): a child is the parent's items it takes and its own design, the spec built by code (src/pipeline/split.ts).
  const child = (unit: string): Record<string, unknown> => ({
    unit, scope: ['src/**'], items: ['a1'], obligations: [],
    design: {
      kind: 'module', changes: [{ system: null, paths: ['src/**'], lines: 10 }], interfaces: [], failureModes: [], breaks: { tests: [], docs: [] }, experiments: [],
      newSystem: null, verification: null,
    },
  });

  it('split: two or more distinct children, edges between distinct children, a skeleton among them', () => {
    const d = splitDecision({ children: [child('u1a'), child('u1b')], edges: [{ from: 'u1a', to: 'u1b' }], skeleton: { unit: 'u1a', lane: 'e2e' } }, 'split');
    assert.equal(d.children.length, 2);
    refuses(() => splitDecision({ children: [child('u1a')], edges: [], skeleton: null }, 'split'), /^split\.children$/);
    refuses(() => splitDecision({ children: [child('u1a'), child('u1a')], edges: [], skeleton: null }, 'split'), /^split\.children/);
    refuses(() => splitDecision({ children: [child('u1a'), child('u1b')], edges: [{ from: 'u1a', to: 'u9' }], skeleton: null }, 'split'), /^split\.edges\[0\]$/);
    refuses(() => splitDecision({ children: [child('u1a'), child('u1b')], edges: [], skeleton: { unit: 'u9', lane: 'e2e' } }, 'split'), /^split\.skeleton\.unit$/);
    refuses(() => splitDecision({ children: [child('u1a'), { ...child('u1b'), items: [] }], edges: [], skeleton: null }, 'split'), /^split\.children\[1\]\.items$/);
  });

  it('scaffold and poc', () => {
    const s = scaffoldDecision({
      newSystem: { name: 'billing', paths: ['src/billing/**'], tests: ['src/billing/**/*.test.ts'] }, entryPoints: ['src/billing/index.ts'], exports: ['charge'],
      loadTest: { lane: 'unit', testId: 'billing loads' }, manifest: [{ path: 'package.json', entry: 'workspaces: src/billing' }],
    }, 'scaffold');
    assert.equal(s.newSystem.name, 'billing');
    const p = pocDecision({ questions: [{ id: 'PQ-1', question: 'Does the API page?', whyItMatters: 'sizes the client' }], brief: 'call it' }, 'poc');
    assert.equal(p.questions[0]!.id, 'PQ-1');
    refuses(() => pocDecision({ questions: [], brief: 'x' }, 'poc'), /^poc\.questions$/);
  });
});

describe('review and flaky ledgers', () => {
  it('reads a findings ledger entry, approval blobs (ascending by path) and a flaky ledger entry', () => {
    assert.equal(findingsLedgerEntry({ id: 'R-1', unit: 'u1', path: 'src/a.ts', anchor: A, outcome: null }, 'e').outcome, null);
    refuses(() => findingsLedgerEntry({ id: 'R-1', unit: 'u1', path: 'src/a.ts', anchor: A, outcome: 'ignored' }, 'e'), /^e\.outcome$/);
    assert.equal(approvalBlobs({ unit: 'u1', specRev: 2, files: [{ path: 'a', blob: A }, { path: 'b', blob: null }] }, 'b').files.length, 2);
    refuses(() => approvalBlobs({ unit: 'u1', specRev: 2, files: [{ path: 'b', blob: A }, { path: 'a', blob: null }] }, 'b'), /^b\.files\[1\]$/);
    const inv = 'arc-1/4#1';
    const e = flakyLedgerEntry({ key: { type: 'test', lane: 'unit', testId: 't1' }, events: [{ tree: sha(A), env: null, failing: ['t1'], red: inv, green: 'arc-1/5#1' }], deflakes: [] }, 'f');
    assert.equal(e.key.type, 'test');
    refuses(() => flakyLedgerEntry({ key: { type: 'lane', lane: 'unit' }, events: [], deflakes: [] }, 'f'), /^f\.events$/);
  });
});
