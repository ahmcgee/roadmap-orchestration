// Free replays of actual paid-run values: schema acceptance must imply parser acceptance, except for a
// specifically recorded repair whose rule appears in the wire schema's description. Never fix up these values.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { schemaViolation } from '../src/backends/adapter.ts';
import { journeyId, milestoneId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { absPath, repoPath } from '../src/core/values.ts';
import type { PlanM1 } from '../src/input/plan.ts';
import { promptFor, support } from '../src/prompts/index.ts';
import { ROLE_SCHEMAS, ROLE_VALIDATORS, experiencePolish, experienceWalk } from '../src/prompts/schemas.ts';
import { MODEL_IDS, ROLES, type Role } from '../src/routing/types.ts';
import { judgeRefusals } from '../src/walk/compare.ts';
import { walkRefusals } from '../src/walk/report.ts';
import { tmpDir } from './helpers/repo.ts';

type Case = { file: string; role: Role; expect: 'accepted' | 'expected-repair' | 'schema-rejected'; schemaError?: string; evidenceFiles?: string[]; check?: 'parser' | 'walkRefusals' | 'judgeRefusals'; error?: string; description?: (string | number)[]; descriptionIncludes?: string };
const root = new URL('./fixtures/real-role-output/', import.meta.url);
const fixtureText = (name: string): string => {
  const bytes = readFileSync(new URL(name, root));
  return (name.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
};
const cases = JSON.parse(readFileSync(new URL('index.json', root), 'utf8')) as Case[];
function at(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((v, key) => (v as Record<string | number, unknown>)[key], value);
}

test('real replay corpus covers every role, contains only sanitized values, and accounts for every fixture', () => {
  assert.equal(cases.length, 94);
  for (const role of ROLES) for (const model of MODEL_IDS) {
    if (support(role, model).type !== 'unsupported') assert.equal(promptFor(role, model).schema, ROLE_SCHEMAS[role], `${role}/${model}: replay the schema actually sent`);
  }
  assert.deepEqual([...new Set(cases.map((c) => c.role))].sort(), Object.keys(ROLE_SCHEMAS).sort());
  assert.deepEqual(cases.map((c) => c.file).sort(), readdirSync(root).filter((f) => (f.endsWith('.json') || f.endsWith('.json.gz')) && f !== 'index.json').sort());
  for (const name of readdirSync(root).filter((f) => f.endsWith('.json') || f.endsWith('.json.gz'))) {
    assert.doesNotMatch(fixtureText(name), /\/(?:tmp|workspaces)\/|claude-(?:opus|sonnet|haiku|fable)|gpt-\d|atlas2-im/i, name);
  }
});

for (const c of cases) test(`real replay ${c.file}: ${c.expect}`, () => {
  const value = JSON.parse(fixtureText(c.file)) as JsonValue;
  const schema = ROLE_SCHEMAS[c.role];
  // Older saved answers can fail current schemas. Record that explicitly rather than silently
  // ignoring them; a future schema change must reclassify the actual replay result.
  const violation = schemaViolation(schema, value);
  if (c.expect === 'schema-rejected') {
    assert.equal(violation, c.schemaError);
    return;
  }
  assert.equal(violation, null);
  if (c.expect === 'accepted') {
    assert.doesNotThrow(() => ROLE_VALIDATORS[c.role](value));
    return;
  }
  assert.ok(c.description && c.descriptionIncludes);
  const description = at(schema, [...c.description, 'description']);
  assert.equal(typeof description, 'string');
  assert.ok((description as string).includes(c.descriptionIncludes));
  if (c.check === 'parser') {
    assert.ok(c.error);
    assert.throws(() => ROLE_VALIDATORS[c.role](value), (e: unknown) => e instanceof Error && e.message.includes(c.error!));
    return;
  }
  // The real walk/compare values pass the role reader. It is the next production reader, which
  // resolves evidence strings as complete filenames, that refuses their path-plus-prose citations.
  assert.doesNotThrow(() => ROLE_VALIDATORS[c.role](value));
  const evidenceDir = absPath(tmpDir('real-replay-evidence'));
  assert.ok(c.evidenceFiles && c.evidenceFiles.length > 0);
  for (const file of c.evidenceFiles) writeFileSync(join(evidenceDir, file), 'Saved capture placeholder.');
  if (c.check === 'judgeRefusals') {
    const out = experiencePolish(value);
    const reasons = judgeRefusals([evidenceDir, evidenceDir], out);
    assert.equal(reasons.length, out.evidence.length);
    assert.ok(reasons.every((r) => r.includes('which is no file in the evidence dir')));
  } else {
    assert.equal(c.check, 'walkRefusals');
    const out = experienceWalk(value);
    const reasons = walkRefusals({
      evidenceDir, systemsMap: null, plan: { units: [] } as unknown as PlanM1,
      vision: { schema: 'roadmap/vision-m3', rev: 1, confirmation: null, clauses: [], questions: [] },
      milestone: {
        id: milestoneId('MS-1'), text: 'Greet', units: [], design: { supplied: true }, references: [repoPath('design')],
        bringUp: { setup: [], serve: [], env: {}, seed: [] }, resources: [],
        journeys: ['J-1', 'J-2'].map((id) => ({ id: journeyId(id), text: 'Use the CLI', via: 'shell', entry: 'node product/cli.js', budget: null })),
      },
    }, out);
    const count = out.journeys.reduce((n, j) => n + j.evidence.length, 0) + out.findings.reduce((n, f) => n + f.evidence.length, 0);
    assert.equal(reasons.length, count);
    assert.ok(reasons.every((r) => r.includes('which is no file in the evidence dir') || r.includes('which is outside the evidence dir')));
  }
});
