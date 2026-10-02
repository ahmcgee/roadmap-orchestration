import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clauseId, divergenceId, envId, findingId, jobId, laneId, laneRev, obligationId, questionId, rulingId, sha, specRev, unitId, visionClauseId } from '../src/core/ids.ts';
import { DOC_RELATIONS, LENS_KINDS, OBLIGATION_DISPOSITIONS, type ObligationDef, RULING_KINDS, RULING_LIFETIMES, RULING_SCHEMA } from '../src/holistic/types.ts';
import type { JsonValue } from '../src/core/json.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath, repoPath, repoPattern } from '../src/core/values.ts';
import { PROMPTS, UnsupportedPromptError, promptFor, support } from '../src/prompts/index.ts';
import { type RoleInputs, ROLE_INPUTS, UNIT_POLICY, laneCommand, obligationsText, pasted } from '../src/prompts/inputs.ts';
import {
  PLAN_CHECK_SCHEMA, ROLE_SCHEMAS, ROLE_VALIDATORS, type RoleOutputs, validateBuildOutput, validateDecisionsFile, validateGateOutput,
  validatePlanCheckOutput,
} from '../src/prompts/schemas.ts';
import { arcStack, resolveRouting, seatsInForce } from '../src/routing/layers.ts';
import { MODEL_IDS, PROFILES, ROLES, type Role, atSeat } from '../src/routing/types.ts';

// Two complete input sets per role that differ in every field, so swapping one field shows whether a
// module's rendering depends on it.
const spec = (rev: number, text: string) => ({ unit: unitId('u-one'), rev: specRev(rev), markdown: text });
const doc = (path: string, text: string) => ({ path: repoPath(path), text });
const ruling = (id: string, text: string) => ({ id: rulingId(id), text });
const lane = (id: string, argv: string[]) => ({
  id: laneId(id), argv, cwd: repoPath('.'), env: { set: { CI: '1' }, pass: [] }, expectedExit: 0, tier: 'fast' as const,
  resources: [], evidenceGlobs: [], evidenceExcludes: [],
});
const SHA_A = sha('a'.repeat(40));
const SHA_B = sha('b'.repeat(40));

const index = (c: string, r: string, ledger: string) => ({
  contracts: [{ path: repoPath(c), heading: `${c} heading` }], rulings: [{ id: rulingId(r), line: `${r} first sentence.` }], ledger: absPath(ledger),
});
const premise = (claim: string, path: string) => ({ claim, evidence: [{ path, line: 3 }] });

// M3: the vision, obligations and findings the arc roles (and plan-check and the gate) read.
const vision = (rev: number, text: string) => ({
  rev, clauses: [{ id: visionClauseId('V-1'), kind: 'world' as const, text, rank: null, state: 'active' as const }], questions: [], advances: [visionClauseId('V-1')],
});
const obligation = (id: string, statement: string): ObligationDef => ({
  id: obligationId(id), rev: 1, statement, docRef: { path: repoPath('docs/target.md'), anchor: '#a', quotedText: statement }, serves: [visionClauseId('V-1')],
  witness: { lane: laneId('journey'), testIds: ['t1'] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: laneRev('0123456789abcdef'), witness: { lane: laneId('journey'), testIds: ['t1'] } },
  deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' },
});
const observed = (id: string, statement: string, tree: typeof SHA_A) => ({
  obligation: obligation(id, statement), exempt: false, latched: false,
  observation: { key: { treeSha: tree, lane: laneId('journey'), laneRev: laneRev('0123456789abcdef'), envId: envId('fedcba9876543210') }, verdict: 'held' as const },
});
const findingView = (id: string, claim: string) => ({
  id: findingId(id), lens: 'invariants' as const, severity: 'P1' as const, state: 'open' as const, obligation: obligationId('I-1'), claim, owner: null,
});

const SAMPLES: { readonly [R in Role]: readonly [RoleInputs[R], RoleInputs[R]] } = {
  planCheck: [
    {
      spec: spec(1, 'SPEC-A'), contracts: [doc('docs/api.md', 'CONTRACT-A')], rulings: [ruling('C-1', 'RULE-A')], index: index('docs/x.md', 'C-7', '/plan/a/rulings.md'),
      architecture: { kind: 'full', doc: doc('docs/arch.md', 'ARCH-A') }, direction: 'DIR-A', scope: [repoPattern('src/a/**')], risk: 'low',
      checkouts: { tip: { path: absPath('/wt/u.plan-check-1'), at: SHA_A }, branch: null },
      lanePrograms: [{ lane: laneId('unit'), argv0: 'npm', resolved: { kind: 'program', realpath: absPath('/usr/lib/node/npm') } }],
      priorRound: null, vision: null,
    },
    {
      spec: spec(2, 'SPEC-B'), contracts: [doc('docs/b.md', 'CONTRACT-B')], rulings: [ruling('C-2', 'RULE-B')], index: index('docs/y.md', 'C-8', '/plan/b/rulings.md'),
      architecture: { kind: 'digest', digest: doc('docs/digest.md', 'DIGEST-B'), doc: repoPath('docs/arch2.md') }, direction: 'DIR-B',
      scope: [repoPattern('src/b/**')], risk: 'high',
      checkouts: { tip: { path: absPath('/wt/u.plan-check-2'), at: SHA_B }, branch: { path: absPath('/wt/u.plan-check-2-branch'), at: SHA_A } },
      lanePrograms: [{ lane: laneId('lint'), argv0: 'rg', resolved: { kind: 'not-found' } }],
      priorRound: {
        patch: [{ op: 'strike', id: clauseId('A3') }], reasons: ['A3 contradicts C-2'], premises: [premise('PREMISE-B', 'src/b/x.ts')],
        patchedRev: specRev(2), changedPremiseFiles: ['src/b/x.ts'],
      },
      vision: vision(2, 'VISION-B'),
    },
  ],
  build: [
    {
      spec: spec(1, 'SPEC-A'), contracts: [doc('docs/api.md', 'CONTRACT-A')], rulings: [ruling('C-1', 'RULE-A')], index: index('docs/x.md', 'C-7', '/plan/a/rulings.md'),
      planCheckNotes: '', fastLanes: [lane('unit', ['npm', 'test'])], evidenceDir: absPath('/run/ev/a'), worktree: absPath('/wt/a'),
      scope: [repoPattern('src/a/**')], fixRound: null,
    },
    {
      spec: spec(2, 'SPEC-B'), contracts: [doc('docs/b.md', 'CONTRACT-B')], rulings: [ruling('C-2', 'RULE-B')], index: index('docs/y.md', 'C-8', '/plan/b/rulings.md'),
      planCheckNotes: 'NOTES-B', fastLanes: [lane('lint', ['npx', 'tsc', '--noEmit'])], evidenceDir: absPath('/run/ev/b'), worktree: absPath('/wt/b'),
      scope: [repoPattern('src/b/**')], fixRound: { failingEvidenceDirs: [absPath('/run/inv/9-1')], directives: ['DIRECTIVE-B'] },
    },
  ],
  gate: [
    {
      spec: spec(1, 'SPEC-A'), contracts: [doc('docs/api.md', 'CONTRACT-A')], rulings: [ruling('C-1', 'RULE-A')], index: index('docs/x.md', 'C-7', '/plan/a/rulings.md'),
      architecture: { kind: 'full', doc: doc('docs/arch.md', 'ARCH-A') }, direction: 'DIR-A', planCheckNotes: '', obligations: [],
      diff: { base: SHA_A, head: SHA_B, text: 'DIFF-A' },
      laneLedger: [{ lane: laneId('unit'), argv: ['npm', 'test'], expectedExit: 0, exitCode: 0, verdict: 'pass', evidenceDir: absPath('/run/inv/3-1'), ignored: null }],
      evidence: [absPath('/run/ev/a')], scope: { patterns: [repoPattern('src/a/**')], growth: [] }, priorRound: null,
    },
    {
      spec: spec(2, 'SPEC-B'), contracts: [doc('docs/b.md', 'CONTRACT-B')], rulings: [ruling('C-2', 'RULE-B')], index: index('docs/y.md', 'C-8', '/plan/b/rulings.md'),
      architecture: { kind: 'digest', digest: doc('docs/digest.md', 'DIGEST-B'), doc: repoPath('docs/arch2.md') }, direction: 'DIR-B', planCheckNotes: 'NOTES-B',
      obligations: [observed('I-2', 'OBLIGATION-B', SHA_B)],
      diff: { base: SHA_B, head: SHA_A, text: 'DIFF-B' },
      laneLedger: [{ lane: laneId('lint'), argv: ['npx', 'tsc'], expectedExit: 0, exitCode: 0, verdict: 'pass', evidenceDir: absPath('/run/inv/4-1'),
        ignored: { v: 1, written: { files: 42, bytes: 3_250_000 }, captured: { files: 0, bytes: 0 }, uncaptured: [{ dir: '.local/demo/', files: 42, bytes: 3_250_000, reason: 'not-declared' }] } }],
      evidence: [absPath('/run/ev/b')], scope: { patterns: [repoPattern('src/b/**')], growth: [repoPath('README.md')] },
      priorRound: {
        directives: ['DIRECTIVE-B'], findings: [{ severity: 'blocking', path: 'src/b/x.ts', text: 'FINDING-B', contractRef: null }],
        premises: [premise('PREMISE-B', 'src/b/x.ts')], fixPaths: [repoPath('src/b/x.ts')], changedPremiseFiles: ['src/b/x.ts'],
      },
    },
  ],
  lens: [
    {
      vision: vision(1, 'VISION-A'), lens: 'invariants', obligations: [observed('I-1', 'OBLIGATION-A', SHA_A)], range: { from: SHA_A, to: SHA_B, diff: 'RANGE-A' },
      owners: [], priorFindings: [], contracts: [doc('docs/api.md', 'CONTRACT-A')], rulings: [ruling('C-1', 'RULE-A')], index: index('docs/x.md', 'C-7', '/plan/a/rulings.md'),
      architecture: { kind: 'full', doc: doc('docs/arch.md', 'ARCH-A') }, checkout: absPath('/wt/audit-1'),
    },
    {
      vision: vision(2, 'VISION-B'), lens: 'vision', obligations: [observed('I-2', 'OBLIGATION-B', SHA_B)], range: { from: SHA_B, to: SHA_A, diff: 'RANGE-B' },
      owners: [{ unit: unitId('u-two'), head: SHA_B, diff: 'OWNER-B' }], priorFindings: [findingView('F-1', 'FINDING-B')], contracts: [doc('docs/b.md', 'CONTRACT-B')],
      rulings: [ruling('C-2', 'RULE-B')], index: index('docs/y.md', 'C-8', '/plan/b/rulings.md'),
      architecture: { kind: 'digest', digest: doc('docs/digest.md', 'DIGEST-B'), doc: repoPath('docs/arch2.md') }, checkout: absPath('/wt/audit-2'),
    },
  ],
  checkpoint: [
    {
      vision: vision(1, 'VISION-A'), trigger: { type: 'audit', job: jobId('audit', 1) }, priorInvalid: null, head: SHA_A, plan: 'PLAN-A', findings: [],
      obligations: [observed('I-1', 'OBLIGATION-A', SHA_A)], coverage: { unservedAdvanced: [], horizon: [], obligationsServingNone: [], withdrawnCited: [] }, divergences: [],
      contracts: [doc('docs/api.md', 'CONTRACT-A')], rulings: [ruling('C-1', 'RULE-A')], index: index('docs/x.md', 'C-7', '/plan/a/rulings.md'),
      architecture: { kind: 'full', doc: doc('docs/arch.md', 'ARCH-A') }, direction: 'DIR-A',
    },
    {
      vision: vision(2, 'VISION-B'), trigger: { type: 'park', unit: unitId('u-two'), seq: 40, cause: { stage: 'candidate', attempt: 9, outcome: 'red', reason: 'candidate-red', design: false, detail: ['TRIGGER-B'] } },
      priorInvalid: { job: jobId('ckpt', 2), reasons: 'PRIOR-B' }, head: SHA_B, plan: 'PLAN-B', findings: [findingView('F-2', 'FINDING-B')],
      obligations: [observed('I-2', 'OBLIGATION-B', SHA_B)], coverage: { unservedAdvanced: [visionClauseId('V-1')], horizon: [], obligationsServingNone: [], withdrawnCited: [] },
      divergences: [{ id: divergenceId('D-1'), type: 'plan-departed', what: 'DIVERGENCE-B' }], contracts: [doc('docs/b.md', 'CONTRACT-B')], rulings: [ruling('C-2', 'RULE-B')],
      index: index('docs/y.md', 'C-8', '/plan/b/rulings.md'), architecture: { kind: 'digest', digest: doc('docs/digest.md', 'DIGEST-B'), doc: repoPath('docs/arch2.md') },
      direction: 'DIR-B',
    },
  ],
};

const OUTPUTS: { readonly [R in Role]: unknown } = {
  planCheck: {
    decision: 'redirect', reasons: ['A1 contradicts C-1'], risk: 'med', notes: '', premises: [{ claim: 'parse.ts exists', evidence: [{ path: 'src/a/parse.ts', line: 1 }] }],
    visionConflict: [{ clauses: ['V-1'], note: 'A2 makes rounding permissive, against V-1.' }],
    patch: [
      { op: 'replace', section: 'lanes', item: { id: 'unit', argv: ['npm', 'test'], cwd: '.', env: { set: [{ name: 'CI', value: '1' }], pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], evidenceExcludes: [] } },
      { op: 'add', section: 'decisions', item: { id: 'R2', text: 'Use the existing parser.' } },
      { op: 'strike', id: 'A3' },
      { op: 'cite', contracts: ['docs/api.md'], rulings: ['C-4'] },
    ],
  },
  build: {
    summary: 'Added the parser.', changedPaths: ['src/a/parse.ts'], lanesRun: [{ lane: 'unit', exit: 0 }], blockers: [],
  },
  gate: {
    decision: 'revise', reasons: ['A2 untested'], directives: ['Add a test for A2.'],
    findings: [{ severity: 'blocking', path: 'src/a/parse.ts', text: 'A2 has no test.', contractRef: null }], premises: [],
  },
  lens: {
    findings: [{ severity: 'P1', obligation: 'I-1', visionClauses: ['V-1'], claim: 'I-1 is not held.', cause: 'rounding', evidence: [{ path: 'src/a.ts', line: 3 }], mutant: null }],
    reasons: ['I-1 fails on the audited tree'], premises: [],
  },
  checkpoint: {
    decision: 'bundle', reasons: ['F-1 needs a repair'],
    ops: [{ op: 'cut', unit: 'u-one', reason: 'superseded by the repair', cites: ['V-1'], evidence: ['F-1'] }],
    rulings: [], findingDispositions: [], interpretations: [], cites: { vision: ['V-1'], observations: [], findings: ['F-1'] }, premises: [],
  },
};

/** Every (role, model) either built-in profile can resolve, the arc seats of a holistic arc included. */
function builtinSeats(): readonly (readonly [Role, (typeof MODEL_IDS)[number]])[] {
  const seen = new Map<string, readonly [Role, (typeof MODEL_IDS)[number]]>();
  for (const p of PROFILES) {
    const resolved = resolveRouting({ ...arcStack(p, null, null), holistic: true });
    for (const s of seatsInForce(resolved)) {
      const m = atSeat(resolved.table, s).model;
      seen.set(`${s.role}/${m}`, [s.role, m]);
    }
  }
  return [...seen.values()];
}

// A checker for the strict JSON Schema subset schemas.ts emits; enough to show a sample output
// conforms to the schema a backend is handed.
function conforms(schema: JsonValue, value: unknown): boolean {
  const s = schema as { readonly [k: string]: JsonValue };
  if (s['anyOf'] !== undefined) return (s['anyOf'] as JsonValue[]).some((b) => conforms(b, value));
  if (s['enum'] !== undefined && !(s['enum'] as JsonValue[]).includes(value as JsonValue)) return false;
  switch (s['type']) {
    case 'null': return value === null;
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value) && value.every((v) => conforms(s['items'] as JsonValue, v));
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const props = s['properties'] as { readonly [k: string]: JsonValue };
      const keys = Object.keys(value);
      return keys.length === Object.keys(props).length &&
        keys.every((k) => props[k] !== undefined && conforms(props[k], (value as Record<string, unknown>)[k]));
    }
    default: throw new Error(`unexpected schema node ${JSON.stringify(schema)}`);
  }
}

/** Codex strict mode: every object lists every property as required and forbids additional ones. */
function assertStrict(schema: JsonValue, path: string): void {
  if (Array.isArray(schema)) return schema.forEach((s, i) => assertStrict(s, `${path}[${i}]`));
  if (typeof schema !== 'object' || schema === null) return;
  const s = schema as { readonly [k: string]: JsonValue };
  if (s['type'] === 'object') {
    assert.equal(s['additionalProperties'], false, `${path}: additionalProperties`);
    assert.deepEqual(s['required'], Object.keys(s['properties'] as object), `${path}: required`);
  }
  for (const [k, v] of Object.entries(s)) assertStrict(v, `${path}.${k}`);
}

describe('prompts', () => {
  it('prompts.fields==required: every module lists and interpolates exactly its role inputs', () => {
    for (const role of ROLES) {
      const [a, b] = SAMPLES[role];
      assert.deepEqual(Object.keys(a).sort(), [...ROLE_INPUTS[role]].sort(), `${role}: sample keys`);
      for (const model of MODEL_IDS) {
        const s = support(role, model);
        if (s.type !== 'prompt') continue;
        const mod = s.prompt as { fields: readonly string[]; render: (i: unknown) => string };
        assert.deepEqual([...mod.fields].sort(), [...ROLE_INPUTS[role]].sort(), `${role}/${model}: fields`);
        const base = mod.render(a);
        for (const field of mod.fields) {
          const swapped = { ...a, [field]: (b as Record<string, unknown>)[field] };
          assert.notEqual(mod.render(swapped), base, `${role}/${model} does not interpolate ${field}`);
        }
      }
    }
  });

  it('prompts.every-supported-seat-renders: deterministic, and the schema accepts a sample output', () => {
    const seats = builtinSeats();
    assert.ok(seats.length >= 7);
    for (const role of ROLES) assert.ok(seats.some(([r]) => r === role), `${role}: seated by a built-in profile`);
    for (const [role, model] of seats) {
      const mod = promptFor(role, model) as { system: string; schema: JsonValue; render: (i: unknown) => string };
      for (const input of SAMPLES[role]) {
        const text = mod.render(input);
        assert.equal(mod.render(input), text, `${role}/${model}: deterministic`);
        assert.ok(text.length > 0 && mod.system.length > 0);
        assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, `${role}/${model}: no timestamps`);
      }
      assert.equal(mod.schema, ROLE_SCHEMAS[role]);
      assertStrict(mod.schema, `${role}/${model}`);
      assert.ok(conforms(mod.schema, OUTPUTS[role]), `${role}/${model}: sample conforms to schema`);
      ROLE_VALIDATORS[role](OUTPUTS[role]);
    }
  });

  it('inherits resolves to the named module; unsupported throws', () => {
    assert.equal(promptFor('build', 'gpt-5.6-sol'), promptFor('build', 'gpt-5.6-luna'));
    assert.throws(() => promptFor('gate', 'gpt-5.6-luna'), UnsupportedPromptError);
    assert.throws(() => promptFor('build', 'claude-fable-5-1'), UnsupportedPromptError);
    for (const role of ROLES) for (const model of MODEL_IDS) {
      const s = PROMPTS[role][model];
      if (s.type === 'inherits') assert.equal(PROMPTS[role][s.from].type, 'prompt', `${role}/${model}: inherits a real module`);
    }
  });

  it('judgment prompts say fresh session, cite C-nn, and grade the contract text itself', () => {
    for (const role of ['planCheck', 'gate'] as const) for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
      const sys = promptFor(role, model).system;
      assert.match(sys, /fresh session/, `${role}/${model}`);
      assert.match(sys, /C-nn/, `${role}/${model}`);
      assert.match(sys, /paraphrase/, `${role}/${model}`);
    }
  });

  it('build prompts cover fast lanes, decisions.json, .roadmap/, estate lanes and stopping', () => {
    for (const model of ['claude-opus-5-5', 'gpt-5.6-luna'] as const) {
      const mod = promptFor('build', model);
      const sys = mod.system;
      for (const needle of [/fast lane/, /decisions\.json/, /\.roadmap\//, /[Ee]state lanes/, /Committing is optional/, /[Ss]top/]) {
        assert.match(sys, needle, `build/${model}: ${needle}`);
      }
      assert.doesNotMatch(sys, /decisionsRecorded/, `build/${model}: decisions go only to decisions.json`);
      const text = mod.render(SAMPLES.build[1]);
      assert.match(text, /\/run\/inv\/9-1/, 'fix round names the failing evidence dir');
      assert.match(text, /cd \/wt\/b && env CI=1 npx tsc --noEmit/, 'lane rendered as its exact command');
    }
  });

  it('build prompts carry the unit policy, which overrides the repository\'s instruction files', () => {
    for (const needle of [/AGENTS\.md/, /CLAUDE\.md/, /overrides/, /[Nn]o cloud/, /[Nn]o sudo/, /package installs/, /kill a process/, /[Nn]o network/]) assert.match(UNIT_POLICY, needle);
    for (const model of ['claude-opus-5-5', 'gpt-5.6-luna'] as const) assert.ok(promptFor('build', model).system.includes(UNIT_POLICY), `build/${model}`);
  });

  it('judgment prompts: cited documents in full, the rest indexed; host facts only from lane programs; correctness or acceptance only', () => {
    for (const role of ['planCheck', 'gate'] as const) for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
      const mod = promptFor(role, model) as { system: string; render: (i: unknown) => string };
      assert.match(mod.system, /reference index|<reference_index>/, `${role}/${model}`);
      assert.match(mod.system, /correctness or the spec's stated acceptance/, `${role}/${model}`);
      assert.match(mod.system, /one Grep over many paths/, `${role}/${model}`);
      assert.match(mod.system, /premises/, `${role}/${model}`);
      const text = mod.render(SAMPLES[role][1]);
      assert.match(text, /docs\/y\.md: docs\/y\.md heading/, 'an uncited contract is one index line');
      assert.match(text, /C-8: C-8 first sentence\./, 'a ruling not cited is one index line');
      assert.match(text, /\/plan\/b\/rulings\.md/, 'the ledger is named for reading on demand');
      assert.match(text, /DIGEST-B/);
      assert.match(text, /docs\/arch2\.md in the repository/, 'with a digest, the whole doc is named, not embedded');
    }
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
      const mod = promptFor('planCheck', model);
      assert.match(mod.system, /ssert a host fact/, model);
      assert.match(mod.system, /never redirect on implementation defects alone/, model);
      const text = mod.render(SAMPLES.planCheck[1]);
      assert.match(text, /\/wt\/u\.plan-check-2 \(your working directory\)/, 'the tip checkout is named');
      assert.match(text, /\/wt\/u\.plan-check-2-branch/, 'the unit branch checkout is named');
      assert.match(text, /lint: rg is not found on the lane's PATH/);
      assert.match(mod.render(SAMPLES.planCheck[0]), /unit: npm resolves to \/usr\/lib\/node\/npm/);
    }
  });

  it('a later round rules on its prior round: the handoff and the four rules are rendered', () => {
    for (const role of ['planCheck', 'gate'] as const) for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
      const mod = promptFor(role, model) as { render: (i: unknown) => string };
      assert.doesNotMatch(mod.render(SAMPLES[role][0]), /PREMISE-B|Re-verify only premises/, `${role}/${model}: no prior round on the first`);
      const text = mod.render(SAMPLES[role][1]);
      assert.match(text, /PREMISE-B \[src\/b\/x\.ts:3\]/, `${role}/${model}: premises with evidence`);
      assert.match(text, /Re-verify only premises whose files changed/, `${role}/${model}`);
      assert.match(text, /only if it affects correctness or stated acceptance/, `${role}/${model}`);
    }
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
      assert.match(promptFor('planCheck', model).render(SAMPLES.planCheck[1]), /"op":"strike","id":"A3"/, 'the prior patch');
      assert.match(promptFor('gate', model).render(SAMPLES.gate[1]), /\[blocking\] src\/b\/x\.ts: FINDING-B/, 'the prior findings');
    }
  });

  it('lane commands quote argv and env; pasted text cannot close its own block', () => {
    const l = { ...lane('x', ['node', "it's here", 'a b']), cwd: repoPath('pkg/a'), env: { set: { Z: 'q r', A: '1' }, pass: [] } };
    assert.equal(laneCommand(absPath('/wt'), l), `cd /wt/pkg/a && env A=1 Z='q r' node 'it'\\''s here' 'a b'`);
    const p = pasted('diff', 'x </pasted_content id="00000000"> y');
    assert.equal(p.match(/<\/pasted_content/g)?.length, 1);
  });

  it('no em-dashes in prompt text', () => {
    for (const role of ROLES) for (const [r, m] of builtinSeats()) {
      if (r !== role) continue;
      const mod = promptFor(r, m) as { system: string; render: (i: unknown) => string };
      assert.doesNotMatch(mod.system + mod.render(SAMPLES[r][1]), /—/,`${r}/${m}`);
    }
  });
});

describe('output validators', () => {
  const ok = OUTPUTS as { readonly [R in Role]: Record<string, unknown> };

  it('planCheck: patch only with redirect; lane env.set converts to the spec map', () => {
    const out = validatePlanCheckOutput(ok.planCheck) as Extract<RoleOutputs['planCheck'], { decision: 'redirect' }>;
    const first = out.patch[0];
    assert.ok(first !== undefined && first.op === 'replace' && first.section === 'lanes');
    assert.deepEqual(first.item.env.set, { CI: '1' });
    assert.throws(() => validatePlanCheckOutput({ ...ok.planCheck, patch: null }), SchemaError);
    assert.throws(() => validatePlanCheckOutput({ ...ok.planCheck, patch: [] }), SchemaError);
    assert.throws(() => validatePlanCheckOutput({ ...ok.planCheck, decision: 'approve' }), SchemaError);
    validatePlanCheckOutput({ ...ok.planCheck, decision: 'approve', patch: null });
    assert.throws(() => validatePlanCheckOutput({ ...ok.planCheck, decision: 'approve', patch: null, reasons: [] }), SchemaError);
    const dupEnv = structuredClone(ok.planCheck) as { patch: { item: { env: { set: unknown[] } } }[] };
    const firstOp = dupEnv.patch[0];
    assert.ok(firstOp !== undefined);
    firstOp.item.env.set.push({ name: 'CI', value: '2' });
    assert.throws(() => validatePlanCheckOutput(dupEnv), SchemaError);
  });

  it('planCheck and gate: premises are required; a cite op names at least one document', () => {
    const { premises: _p, ...noPremises } = ok.planCheck;
    assert.throws(() => validatePlanCheckOutput(noPremises), SchemaError);
    const { premises: _g, ...gateNoPremises } = ok.gate;
    assert.throws(() => validateGateOutput(gateNoPremises), SchemaError);
    assert.throws(() => validatePlanCheckOutput({ ...ok.planCheck, patch: [{ op: 'cite', contracts: [], rulings: [] }] }), SchemaError);
    assert.throws(() => validatePlanCheckOutput({ ...ok.planCheck, premises: [{ claim: 'x', evidence: [{ path: 'a', line: 0 }] }] }), SchemaError);
  });

  it('gate: directives only with revise; approve carries no blocking finding', () => {
    validateGateOutput(ok.gate);
    assert.throws(() => validateGateOutput({ ...ok.gate, directives: [] }), SchemaError);
    assert.throws(() => validateGateOutput({ ...ok.gate, decision: 'approve' }), SchemaError);
    const note = [{ severity: 'note', path: null, text: 'fine', contractRef: 'C-1' }];
    assert.throws(() => validateGateOutput({ ...ok.gate, decision: 'approve', directives: [], findings: ok.gate['findings'] }), SchemaError);
    validateGateOutput({ ...ok.gate, decision: 'approve', directives: [], findings: note });
    validateGateOutput({ ...ok.gate, decision: 'escalate', directives: [], findings: ok.gate['findings'] });
  });

  it('build and decisions.json: ids checked, unknown keys refused', () => {
    validateBuildOutput(ok.build);
    assert.throws(() => validateBuildOutput({ ...ok.build, extra: 1 }), SchemaError);
    assert.throws(() => validateBuildOutput({ ...ok.build, lanesRun: [{ lane: '1bad', exit: 0 }] }), SchemaError);
    // decisions.json is the one channel: the report may not carry an echo of it.
    assert.throws(() => validateBuildOutput({ ...ok.build, decisionsRecorded: [{ id: 'impl-1', text: 'a' }] }), SchemaError);
    validateDecisionsFile({ decisions: [{ id: 'impl-1', text: 'a' }] });
    assert.throws(() => validateDecisionsFile({ decisions: [{ id: 'impl-1', text: 'a' }, { id: 'impl-1', text: 'b' }] }), SchemaError);
  });
});

describe('M3 prompts: the vision and the arc roles', () => {
  const ARC_MODELS = ['claude-opus-5-5', 'claude-fable-5-1'] as const;

  it('the arc roles are supported on Opus and Fable: lens/Opus and checkpoint/Fable written, the other inherits; Sonnet and Codex unsupported', () => {
    assert.equal(PROMPTS.lens['claude-opus-5-5'].type, 'prompt');
    assert.equal(PROMPTS.checkpoint['claude-fable-5-1'].type, 'prompt');
    assert.equal(promptFor('lens', 'claude-fable-5-1'), promptFor('lens', 'claude-opus-5-5'));
    assert.equal(promptFor('checkpoint', 'claude-opus-5-5'), promptFor('checkpoint', 'claude-fable-5-1'));
    for (const role of ['lens', 'checkpoint'] as const) {
      for (const model of ['claude-sonnet-5-5', 'gpt-5.6-luna', 'gpt-5.6-sol'] as const) assert.throws(() => promptFor(role, model), UnsupportedPromptError);
      for (const model of ARC_MODELS) {
        const s = PROMPTS[role][model];
        if (s.type === 'inherits') assert.match(s.reviewed, /^\d{4}-\d{2}-\d{2}: /, `${role}/${model}: a dated review`);
      }
    }
  });

  it('the vision goes first and in full into every lens and checkpoint prompt, before obligations and plan, and wins a conflict', () => {
    for (const role of ['lens', 'checkpoint'] as const) for (const model of ARC_MODELS) {
      const mod = promptFor(role, model) as { system: string; render: (i: unknown) => string };
      assert.match(mod.system, /the vision wins/, `${role}/${model}`);
      assert.match(mod.system, /forecloses? a horizon clause/, `${role}/${model}: the horizon is never foreclosed`);
      assert.match(mod.system, /Never (resolve|answer) an open question yourself/, `${role}/${model}`);
      if (role === 'checkpoint') assert.match(mod.system, /costly to undo if the assumption proves false is a request/, model);
      for (const input of SAMPLES[role]) {
        const text = mod.render(input);
        const v = input.vision;
        assert.ok(text.startsWith(`<vision>\nVision revision ${v.rev}\n`), `${role}/${model}: the message opens with the vision`);
        for (const c of v.clauses) assert.ok(text.includes(`${c.id} (${c.kind}): ${c.text}`), `${role}/${model}: clause ${c.id} in full`);
        const at = text.indexOf(v.clauses[0]!.text);
        assert.ok(at < text.indexOf(input.obligations[0]!.obligation.statement), `${role}/${model}: vision before obligations`);
        if (role === 'checkpoint') assert.ok(at < text.indexOf((input as RoleInputs['checkpoint']).plan), `${role}/${model}: vision before the plan`);
      }
    }
  });

  it('the vision: world clauses first, withdrawn clauses marked, tradeoffs ranked; the slice, the horizon and the open questions', () => {
    const q = { id: questionId('Q-1'), text: 'Q', bears: [visionClauseId('V-1'), visionClauseId('V-4')], assumption: 'A', state: 'open' as const };
    const v = {
      rev: 3, clauses: [
        { id: visionClauseId('V-1'), kind: 'purpose' as const, text: 'P', rank: null, state: 'active' as const },
        { id: visionClauseId('V-2'), kind: 'tradeoff' as const, text: 'T', rank: 1, state: 'active' as const },
        { id: visionClauseId('V-3'), kind: 'good' as const, text: 'G', rank: null, state: 'withdrawn' as const },
        { id: visionClauseId('V-4'), kind: 'world' as const, text: 'W', rank: null, state: 'active' as const },
      ],
      questions: [q, { ...q, id: questionId('Q-2'), text: 'CLOSED', state: 'closed' as const }],
      advances: [visionClauseId('V-1'), visionClauseId('V-4')],
    };
    const text = promptFor('checkpoint', 'claude-fable-5-1').render({ ...SAMPLES.checkpoint[0], vision: v });
    assert.match(text, /<vision>\nVision revision 3\nV-4 \(world\): W\nV-1 \(purpose\): P\n/);
    assert.match(text, /V-2 \(tradeoff, rank 1\): T/);
    assert.match(text, /V-3 \(good, WITHDRAWN: never cite it\): G/);
    assert.match(text, /\nThis arc advances: V-1, V-4\nHorizon \(active, beyond this arc\): V-2\nOpen questions:\n- Q-1 \(bears on V-1, V-4\): Q\n {2}Working assumption: A\n<\/vision>/);
    assert.doesNotMatch(text, /CLOSED/, 'a closed question is omitted');
  });

  it('the checkpoint conveys OR-V: steer to the vision, cite V-n plus evidence per op, optimistic interpretations, owner-only acts only as requests', () => {
    const sys = promptFor('checkpoint', 'claude-fable-5-1').system;
    for (const needle of [
      /not toward the original plan/, /most optimistic reading/, /interpretations/, /cites the active V-n clauses that demand it/, /evidence/,
      /amend its statement or anchor, re-anchor it, split it and drop part of its text, retire, waive or defer it/, /amend the implementation contracts/,
      /irreversible or destructive/, /more than \$10/, /legal ramifications/, /may only request it/, /lane program the plan in force does not already run/,
      /new environment prerequisite/, /outside the plan's contracts and architecture docs/, /never cited/, /no-op is legitimate/,
      /[Nn]obody can answer a question/, /not a transcript of your reasoning/,
      /Splitting a must-hold obligation \(a latched one included\) keeps every child that restates it must-hold/,
    ]) assert.match(sys, needle);
  });

  it('the checkpoint lists the ruling sidecar\'s required schema value and every closed enum from the reader\'s constants (paid m3 run 7: invalid rulings twice)', () => {
    const sys = promptFor('checkpoint', 'claude-fable-5-1').system;
    assert.ok(sys.includes(`- schema: "${RULING_SCHEMA}".`), 'the schema value');
    for (const [field, values] of [['kind', RULING_KINDS], ['relation', DOC_RELATIONS], ['disposition', OBLIGATION_DISPOSITIONS], ['lifetime', RULING_LIFETIMES]] as const) {
      assert.ok([`${field}: one of`, `${field} one of`].some((f) => sys.includes(`${f} ${values.map((v) => `"${v}"`).join(', ')}`)), field);
    }
    assert.match(sys, /appliesTo: \{"type": "arc"\} or \{"type": "units", "units": \[unit ids, ascending\]\}/);
  });

  it('a latched future obligation renders as must-hold (latched), so a split can keep its restating child must-hold', () => {
    const view = { ...observed('I-1', 'A month reconciles.', SHA_A), obligation: { ...obligation('I-1', 'A month reconciles.'), activation: 'future' as const, deliveredBy: [unitId('report')] } };
    assert.match(obligationsText([{ ...view, latched: true }], { serves: true }), /^- I-1 \(rev 1; must-hold \(latched\); /);
    assert.match(obligationsText([view], { serves: true }), /^- I-1 \(rev 1; future; /);
  });

  it('the lens prompt carries exactly one `lens: <kind>` marker, and each kind its own brief', () => {
    const mod = promptFor('lens', 'claude-opus-5-5');
    const briefs = new Set<string>();
    for (const kind of LENS_KINDS) {
      const text = mod.render({ ...SAMPLES.lens[0], lens: kind });
      const markers = [...(mod.system + text).matchAll(/"lens": "|lens: (invariants|drift|vacuity|vision)\b/g)].map((m) => m[0]);
      assert.deepEqual(markers, [`lens: ${kind}`], kind);
      briefs.add(text.slice(text.indexOf('<lens_brief>'), text.indexOf('</lens_brief>')));
    }
    assert.equal(briefs.size, LENS_KINDS.length);
    assert.match(mod.render({ ...SAMPLES.lens[0], lens: 'vision' }), /P2 or P3, never P1/);
    assert.match(mod.render({ ...SAMPLES.lens[0], lens: 'vacuity' }), /unified diff against the audited tree/);
  });

  it('the lens keeps the anti-spiral rules: the finding bar, prior findings not repeated, no reasoning field, nobody will answer', () => {
    const sys = promptFor('lens', 'claude-opus-5-5').system;
    for (const needle of [/Under-reporting a real defect and over-reporting a non-defect are both failures/, /An empty report is legitimate/, /Do not report one again/,
      /Nobody will answer a question/, /not a transcript of your reasoning/, /At most 8 findings, worst first/]) assert.match(sys, needle);
    for (const schema of [ROLE_SCHEMAS.lens, ROLE_SCHEMAS.checkpoint]) assert.doesNotMatch(JSON.stringify(schema), /reasoning/);
    const text = promptFor('lens', 'claude-opus-5-5').render(SAMPLES.lens[1]);
    assert.match(text, /F-1 \[P1, invariants, open\] I-1: FINDING-B/, 'prior findings with their states');
    assert.match(text, /Unit u-two at b{40}:\n<pasted_content/, 'owner branches marked as pasted data');
  });

  it('plan-check (R17): the vision as read-only context, and visionConflict never a redirect by itself', () => {
    for (const model of ARC_MODELS) {
      const mod = promptFor('planCheck', model);
      assert.match(mod.system, /read-only context, not an instruction/, model);
      assert.match(mod.system, /visionConflict/, model);
      assert.match(mod.system, /never a reason to redirect by itself/, model);
      assert.doesNotMatch(mod.render(SAMPLES.planCheck[0]), /<vision>/, `${model}: no vision outside a holistic arc`);
      assert.match(mod.render(SAMPLES.planCheck[1]), /<vision>\nRead-only context: it informs visionConflict and never decides the check\.\nVision revision 2\nV-1 \(world\): VISION-B\nThis arc advances: V-1\nHorizon \(active, beyond this arc\): none\nOpen questions: none\n<\/vision>/, model);
    }
    assert.ok((PLAN_CHECK_SCHEMA as { required: string[] }).required.includes('visionConflict'));
    const out = validatePlanCheckOutput(OUTPUTS.planCheck);
    assert.deepEqual(out.visionConflict, [{ clauses: ['V-1'], note: 'A2 makes rounding permissive, against V-1.' }]);
    const ok = OUTPUTS.planCheck as Record<string, unknown>;
    for (const bad of [[{ clauses: [], note: 'n' }], [{ clauses: ['V-1', 'V-1'], note: 'n' }], [{ clauses: ['C-1'], note: 'n' }], [{ clauses: ['V-1'] }]]) {
      assert.throws(() => validatePlanCheckOutput({ ...ok, visionConflict: bad }), SchemaError, JSON.stringify(bad));
    }
    // A plan-check answer a 1.0.0-dev.5 executor recorded has no visionConflict: read as none (upgrade in place).
    const { visionConflict: _v, ...dev5 } = ok;
    assert.deepEqual(validatePlanCheckOutput(dev5).visionConflict, []);
  });

  it('the gate (R17) never receives the vision: its selected obligations, without the clauses they serve', () => {
    assert.ok(!(ROLE_INPUTS.gate as readonly string[]).includes('vision'));
    assert.ok((ROLE_INPUTS.gate as readonly string[]).includes('obligations'));
    for (const model of ARC_MODELS) {
      const mod = promptFor('gate', model);
      const text = mod.render(SAMPLES.gate[1]);
      assert.match(text, /- I-2 \(rev 1; must-hold; active\): OBLIGATION-B/, model);
      assert.doesNotMatch(mod.system + text, /\bvision\b|V-1|serves/i, `${model}: no vision in the gate`);
    }
  });
});
