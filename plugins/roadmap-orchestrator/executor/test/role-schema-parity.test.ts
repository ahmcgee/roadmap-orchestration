// Exercise all parser branches, not just yesterday's paid outputs. A parser-only local constraint
// fails this sweep unless it has a narrowly identified, described cross-field rule below.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemaViolation } from '../src/backends/adapter.ts';
import type { JsonValue } from '../src/core/json.ts';
import { visionClauseId } from '../src/core/ids.ts';
import { repoPath, repoPattern } from '../src/core/values.ts';
import { SchemaError } from '../src/core/validate.ts';
import { ROLE_SCHEMAS, ROLE_VALIDATORS } from '../src/prompts/schemas.ts';
import type { Role } from '../src/routing/types.ts';

type Path = (string | number)[];
const premise = [{ claim: 'Read it', evidence: [{ path: 'src/a.ts', line: 1 }] }];
const spec = {
  schema: 'roadmap/spec-m1', unit: 'tweak', rev: 1, intent: 'Improve', nonGoals: ['No redesign'],
  lanes: [{ id: 'test', state: 'active', argv: ['node', ''], cwd: '.', env: { set: [{ name: 'MODE', value: '' }], pass: ['CI'] }, expectedExit: 0, cadence: 'build', resources: ['db'], evidenceGlobs: ['out/**'], evidenceExcludes: ['out/tmp/**'] }],
  acceptance: [{ id: 'A1', state: 'active', clause: 'Works', failLoudIfUndelivered: true }],
  decisions: [{ id: 'D1', state: 'active', text: 'Do it' }], facts: [{ id: 'F1', state: 'active', text: 'Known' }],
  resources: ['db'], cites: { contracts: ['docs/api.md'], rulings: ['C-1'] }, obligations: ['I-1'], repairs: ['F-1', 'I-2'],
};
const finding = {
  severity: 'note', evidence: ['src/a.ts:1'], path: 'src/a.ts', text: 'Problem', contractRef: 'C-1', experiments: [],
  debt: { drag: 'Future work' }, defect: 'incorrect-behaviour', reraises: 'R-1', hunk: { path: 'src/a.ts', line: 1 },
};
const gate = {
  standing: [{ id: 'pre-1', disposition: 'addressed', evidence: [''] }], decision: 'revise', ordering: null,
  findings: [finding], directives: ['Fix'], reasons: ['Why'], premises: premise,
  clusters: [{ id: 'one', paths: ['src/**'], review: 'close' }], rulings: [{ finding: 'R-1', ruling: 'upheld', reason: 'Still broken' }],
};
const walk = {
  final: true, journeys: [{ journey: 'J-1', outcome: 'blocked', evidence: ['capture.txt'], note: 'Blocked' }],
  findings: [{ class: 'breaks', journey: 'J-1', evidence: ['capture.txt'], claim: 'Fails', cause: 'Missing', against: { type: 'journey' }, paths: ['src/a.ts'] }],
  polish: [{ journey: 'J-1', evidence: ['capture.txt'], text: 'Improve', unit: { id: 'tweak', systems: ['app'], spec } }],
  premises: premise, reasons: [],
};
const audit = {
  findings: [{ severity: 'P1', obligation: 'I-1', visionClauses: ['V-1'], claim: 'Fails', cause: 'Missing', evidence: [{ path: 'src/a.ts', line: 1 }], mutant: { lane: 'test', edits: [{ path: 'src/a.ts', old: 'old', new: '' }] } }],
  reasons: ['Why'], premises: premise,
  requests: [{ op: 'request', summary: '', evidence: [''], dismisses: 'F-1', counterEvidence: 'It changed' }],
};
const pack = {
  findings: [{ severity: 'blocking', target: { type: 'unit', id: 'u1' }, claim: 'Fails', evidence: [{ path: 'src/a.ts', line: 1 }] }],
  dispositions: [{ job: 'review-1', index: 0, disposition: 'resolved' }], reasons: ['Why'], premises: premise,
};
const examples: [Role, JsonValue][] = [
  ['build', { final: true, summary: 'Built', blockers: ['Help'], experiments: [{ name: 'check', argv: [''], exit: 0 }], grounding: { specWrong: '', touches: [''] }, tooBig: { estimate: '', suggestedChildren: [''] }, notes: ['Done'] }],
  ['verifier', gate], ['verifier', { ...gate, findings: [{ ...finding, experiments: [{ command: 'node check', output: 'ok' }] }] }],
  ['verifier', { ...gate, decision: 'escalate', directives: [], ordering: { blockers: ['u2'] } }],
  ['verifier', { ...gate, decision: 'approve', directives: [], findings: [] }],
  ['campaignAudit', audit], ['campaignAudit', { ...audit, requests: [{ op: 'request', summary: '', evidence: [''], dismisses: null, counterEvidence: null }] }],
  ['experienceVerdict', { final: true, mode: 'walkthrough', verdict: walk }],
  ['experienceVerdict', { final: true, mode: 'polish', verdict: { final: true, decision: 'keep', evidence: ['capture.txt'], reasons: ['Improved'], premises: premise } }],
];
for (const target of [{ type: 'unit', id: 'u1' }, { type: 'obligation', id: 'I-1' }, { type: 'census', rule: 'T-1' }, { type: 'rule', id: 'T-1' }, { type: 'plan' }]) {
  examples.push(['packReview', { ...pack, findings: [{ ...pack.findings[0]!, target }] }]);
}
for (const against of [{ type: 'contract', path: 'docs/api.md', anchor: 'API', dependents: 'Clients' }, { type: 'floor', text: 'Safe', source: 'V-1' }, { type: 'floor', text: 'Safe', source: 'design/floor.md' }]) {
  examples.push(['experienceVerdict', { final: true, mode: 'walkthrough', verdict: { ...walk, findings: [{ ...walk.findings[0]!, against }] } }]);
}
for (const against of [{ type: 'design', path: 'design/README.md', anchor: 'Form' }, { type: 'vision', clause: 'V-1' }]) {
  examples.push(['experienceVerdict', { final: true, mode: 'walkthrough', verdict: { ...walk, journeys: [{ ...walk.journeys[0]!, outcome: 'completed' }], findings: [{ ...walk.findings[0]!, class: 'deviates', against }] } }]);
}

function replace(value: JsonValue, path: Path, next: JsonValue | undefined): JsonValue {
  if (path.length === 0) return next!;
  const clone = structuredClone(value);
  let parent = clone as Record<string | number, JsonValue>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, JsonValue>;
  const last = path.at(-1)!;
  if (next === undefined) delete parent[last];
  else parent[last] = next;
  return clone;
}
function* mutations(value: JsonValue, path: Path = []): Generator<[Path, JsonValue | undefined]> {
  yield [path, null];
  yield [path, false];
  if (typeof value === 'string') {
    for (const candidate of ['', ' ', '../x', '/outside', 'a/../b', 'a/./b', 'a//b', 'a\u0000b', 'J-0', 'V-0', 'V-1234567890123456', 'R-1234567890123456', 'V-01', 'X'.repeat(65)]) yield [path, candidate];
  } else if (typeof value === 'number') {
    for (const candidate of [-1, 0, 1, 255, 256, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) yield [path, candidate];
  } else if (Array.isArray(value)) {
    yield [path, []];
    yield [path, [...value, ...value]];
    for (let i = 0; i < value.length; i++) yield* mutations(value[i]!, [...path, i]);
  } else if (value !== null && typeof value === 'object') {
    yield [path, { ...value, unexpected: true }];
    for (const [key, child] of Object.entries(value)) {
      yield [[...path, key], undefined];
      yield* mutations(child, [...path, key]);
    }
  }
}

// Each exception matches a specific parser error and points at the property description that states
// that same rule. Unsupported numeric bounds qualify only with their exact documented range;
// supported type/pattern/length failures never qualify for an exception.
const describedRules: [RegExp, string, RegExp][] = [
  [/\.final: expected true/, 'final', /final-report parser rejects false/],
  [/gate\.directives: expected (?:an empty array|a non-empty array)/, 'directives', /Must be empty for approve or escalate/],
  [/gate\.ordering: expected null outside/, 'ordering', /Non-null only with decision escalate/],
  [/gate\.findings\[\d+\]\.severity: expected no blocking finding/, 'severity', /approve decision forbids blocking/],
  [/gate\.findings\[\d+\]\.evidence: expected an experiment or path:line/, 'evidence', /at least one experiment or an evidence entry containing path:line/],
  [/\.journeys\[\d+\]\.outcome: expected a blocked journey/, 'outcome', /blocked journey requires at least one breaks/],
  [/\.(?:findings|polish)\[\d+\]\.journey: expected a journey this report reports/, 'journey', /Must be a journey reported in journeys/],
  [/\.env\.pass: expected names not also in set/, 'pass', /must not also appear in env.set/],
  [/\.spec\.lanes\[\d+\]\.argv\[0\]: expected a non-empty string/, 'argv', /argv\[0\] must be a non-empty/],
  [/\.verdict: expected an object/, 'verdict', /Must match mode/],
  [/\.line: expected an integer in/, 'line', /A safe integer in \[1, 9007199254740991\]/],
  [/\.rev: expected SpecRev/, 'rev', /A safe integer in \[1, 9007199254740991\]/],
  [/\.index: expected an integer in/, 'index', /A safe integer in \[0, 9007199254740991\]/],
  [/gate\.clusters\[\d+\]: expected a unique id/, 'clusters', /unique IDs/],
  [/gate\.rulings\[\d+\]: expected a unique id/, 'rulings', /unique finding IDs/],
  [/gate\.ordering\.blockers\[\d+\]: expected a unique id/, 'blockers', /unique/],
  [/\.visionClauses\[\d+\]: expected a unique id/, 'visionClauses', /unique/],
  [/\.paths\[\d+\]: expected a unique id/, 'paths', /unique/],
  [/\.systems\[\d+\]: expected a unique id/, 'systems', /unique/],
  [/\.journeys\[\d+\]: expected a unique id/, 'journeys', /exactly once/],
  [/\.polish\[\d+\]: expected a unique id/, 'polish', /different new unit/],
  [/\.spec\.<item ids>\[\d+\]: expected a unique id/, 'lanes', /unique across lanes/],
  ...['resources', 'contracts', 'rulings', 'obligations', 'repairs', 'set', 'pass'].map((property): [RegExp, string, RegExp] => [new RegExp(`\\.${property}\\[\\d+\\]: expected a unique id`), property, /unique/]),
];
function descriptions(schema: JsonValue, property: string): string[] {
  if (schema === null || typeof schema !== 'object') return [];
  if (Array.isArray(schema)) return schema.flatMap((s) => descriptions(s, property));
  const record = schema as Record<string, JsonValue>;
  const props = record['properties'] as Record<string, JsonValue> | undefined;
  const p = props?.[property];
  const found = p !== undefined && p !== null && !Array.isArray(p) && typeof p === 'object' && typeof (p as Record<string, JsonValue>)['description'] === 'string' ? [(p as Record<string, string>)['description']!] : [];
  if (property === '' && typeof record['description'] === 'string') found.push(record['description']);
  return [...found, ...Object.values(schema).flatMap((s) => descriptions(s, property))];
}

for (const [i, [role, example]] of examples.entries()) test(`schema/parser parity ${role} branch ${i + 1}`, () => {
  const schema = ROLE_SCHEMAS[role];
  assert.equal(schemaViolation(schema, example), null, 'baseline schema');
  assert.doesNotThrow(() => ROLE_VALIDATORS[role](example), 'baseline parser');
  let checked = 0;
  for (const [path, next] of mutations(example)) {
    const changed = replace(example, path, next);
    try { ROLE_VALIDATORS[role](changed); }
    catch (error) {
      assert.ok(error instanceof SchemaError);
      if (schemaViolation(schema, changed) === null) {
        const rule = describedRules.find(([pattern]) => pattern.test(error.message));
        assert.ok(rule, `schema accepted an undocumented parser rejection after ${path.join('.')}=${JSON.stringify(next)}: ${error.message}`);
        const annotations = descriptions(schema, rule[1]);
        assert.ok(annotations.some((description) => rule[2].test(description)), `rule missing from ${rule[1]} description: ${error.message}`);
        const bounds = /expected an integer in (\[[^\]]+\])/.exec(error.message)?.[1];
        if (bounds !== undefined) assert.ok(annotations.some((description) => description.includes(bounds)), `stale bounds description: ${error.message}`);
      }
    }
    checked++;
  }
  assert.ok(checked > 100);
});

// Keep this distinct from the local adapter's larger vocabulary. Adding an unsupported keyword to a
// sent role schema must fail for free, before it can fail in a paid call.
test('all sent role schemas stay in the Claude API subset with plain object roots', () => {
  const allowed = new Set(['type', 'enum', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'pattern', 'minItems', 'description']);
  function check(schema: JsonValue): void {
    assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema));
    const node = schema as Record<string, JsonValue>;
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), `unsupported schema keyword: ${key}`);
    if (node['minItems'] !== undefined) assert.ok(node['minItems'] === 0 || node['minItems'] === 1);
    if (typeof node['pattern'] === 'string') assert.doesNotMatch(node['pattern'], /\(\?[=!<]|\\[1-9bB]/, 'no lookaround, backreferences or word boundaries');
    if (node['properties'] !== undefined) {
      assert.equal(node['type'], 'object');
      assert.equal(node['additionalProperties'], false);
      const properties = node['properties'] as Record<string, JsonValue>;
      assert.deepEqual(node['required'], Object.keys(properties));
      Object.values(properties).forEach(check);
    }
    if (node['items'] !== undefined) check(node['items']);
    if (node['anyOf'] !== undefined) (node['anyOf'] as JsonValue[]).forEach(check);
  }
  for (const schema of Object.values(ROLE_SCHEMAS)) {
    const root = schema as Record<string, JsonValue>;
    assert.equal(root['type'], 'object');
    assert.equal(root['anyOf'], undefined);
    check(schema);
  }
});


test('wire path patterns agree with repository-path, glob and floor-source readers', () => {
  const at = (schema: JsonValue, ...path: (string | number)[]): JsonValue => path.reduce<JsonValue>((node, key) => (node as Record<string | number, JsonValue>)[key]!, schema);
  const finding = at(ROLE_SCHEMAS.experienceVerdict, 'properties', 'verdict', 'anyOf', 0, 'properties', 'findings', 'items', 'anyOf', 0);
  const cases: [JsonValue, (value: string) => unknown][] = [
    [at(finding, 'properties', 'paths', 'items'), repoPath],
    [at(ROLE_SCHEMAS.verifier, 'properties', 'clusters', 'anyOf', 0, 'items', 'properties', 'paths', 'items'), repoPattern],
    [at(finding, 'properties', 'against', 'anyOf', 2, 'properties', 'source'), (value) => /^V-[0-9]+$/.test(value) ? visionClauseId(value) : repoPath(value)],
  ];
  const edit = at(ROLE_SCHEMAS.campaignAudit, 'properties', 'findings', 'items', 'properties', 'mutant', 'anyOf', 0, 'properties', 'edits', 'items');
  for (const path of ['src/a.ts', '/checkout/src/a.ts']) assert.equal(schemaViolation(edit, {path, old: 'old', new: ''}), null);
  for (const value of [{path: '', old: 'old', new: ''}, {path: '../a.ts', old: 'old', new: ''}, {path: 'src/a.ts', old: '', new: ''}]) assert.notEqual(schemaViolation(edit, value), null);
  assert.match(JSON.stringify(at(edit, 'properties', 'path')), /inside the audited checkout/);
  assert.match(JSON.stringify(at(edit, 'properties', 'old')), /occur exactly once/);
  assert.match(JSON.stringify(at(edit, 'properties', 'new')), /Must differ from old/);
  const strings = ['', '.', '..', 'a/../b', 'a/./b', 'a//b', 'a/', 'V-0', 'V-01', 'V-1234567890123456', 'V-0\n', 'V-0\r', 'V-0\u2028', 'V-0\u2029', 'V-0\nmore'];
  let level = [''];
  for (let n = 1; n <= 4; n++) {
    level = level.flatMap((prefix) => ['a', 'V', '-', '0', '1', '.', '/', '\0'].map((letter) => prefix + letter));
    strings.push(...level);
  }
  for (const [schema, reader] of cases) for (const value of strings) {
    let accepts = true;
    try { reader(value); } catch { accepts = false; }
    assert.equal(schemaViolation(schema, value) === null, accepts, `wire/reader disagreement for ${JSON.stringify(value)}`);
  }
});
