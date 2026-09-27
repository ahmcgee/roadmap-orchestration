import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clauseId, laneId, rulingId, sha, specRev, unitId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath, repoPath, repoPattern } from '../src/core/values.ts';
import { PROMPTS, UnsupportedPromptError, promptFor, support } from '../src/prompts/index.ts';
import { type RoleInputs, ROLE_INPUTS, UNIT_POLICY, laneCommand, pasted } from '../src/prompts/inputs.ts';
import {
  ROLE_SCHEMAS, ROLE_VALIDATORS, type RoleOutputs, validateBuildOutput, validateDecisionsFile, validateGateOutput,
  validatePlanCheckOutput,
} from '../src/prompts/schemas.ts';
import { arcStack, resolveRouting } from '../src/routing/layers.ts';
import { MODEL_IDS, PROFILES, ROLES, type Role, SEAT_REFS, atSeat } from '../src/routing/types.ts';

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

const SAMPLES: { readonly [R in Role]: readonly [RoleInputs[R], RoleInputs[R]] } = {
  planCheck: [
    {
      spec: spec(1, 'SPEC-A'), contracts: [doc('docs/api.md', 'CONTRACT-A')], rulings: [ruling('C-1', 'RULE-A')], index: index('docs/x.md', 'C-7', '/plan/a/rulings.md'),
      architecture: { kind: 'full', doc: doc('docs/arch.md', 'ARCH-A') }, direction: 'DIR-A', scope: [repoPattern('src/a/**')], risk: 'low',
      checkouts: { tip: { path: absPath('/wt/u.plan-check-1'), at: SHA_A }, branch: null },
      lanePrograms: [{ lane: laneId('unit'), argv0: 'npm', resolved: { kind: 'program', realpath: absPath('/usr/lib/node/npm') } }],
      priorRound: null,
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
      architecture: { kind: 'full', doc: doc('docs/arch.md', 'ARCH-A') }, direction: 'DIR-A', planCheckNotes: '',
      diff: { base: SHA_A, head: SHA_B, text: 'DIFF-A' },
      laneLedger: [{ lane: laneId('unit'), argv: ['npm', 'test'], expectedExit: 0, exitCode: 0, verdict: 'pass', evidenceDir: absPath('/run/inv/3-1'), ignored: null }],
      evidence: [absPath('/run/ev/a')], scope: { patterns: [repoPattern('src/a/**')], growth: [] }, priorRound: null,
    },
    {
      spec: spec(2, 'SPEC-B'), contracts: [doc('docs/b.md', 'CONTRACT-B')], rulings: [ruling('C-2', 'RULE-B')], index: index('docs/y.md', 'C-8', '/plan/b/rulings.md'),
      architecture: { kind: 'digest', digest: doc('docs/digest.md', 'DIGEST-B'), doc: repoPath('docs/arch2.md') }, direction: 'DIR-B', planCheckNotes: 'NOTES-B',
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
};

const OUTPUTS: { readonly [R in Role]: unknown } = {
  planCheck: {
    decision: 'redirect', reasons: ['A1 contradicts C-1'], risk: 'med', notes: '', premises: [{ claim: 'parse.ts exists', evidence: [{ path: 'src/a/parse.ts', line: 1 }] }],
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
};

/** Every (role, model) either built-in profile can resolve. */
function builtinSeats(): readonly (readonly [Role, (typeof MODEL_IDS)[number]])[] {
  const seen = new Map<string, readonly [Role, (typeof MODEL_IDS)[number]]>();
  for (const p of PROFILES) {
    const { table } = resolveRouting(arcStack(p, null, null));
    for (const s of SEAT_REFS) {
      const m = atSeat(table, s).model;
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
    assert.ok(seats.length >= 5);
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

  it('no Sonnet anywhere in src, and no em-dashes in prompt text', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(new URL('../src', import.meta.url).pathname);
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /sonnet/i, f);
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
