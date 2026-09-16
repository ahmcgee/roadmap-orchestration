// Zero-token pin on the two Phase-0 CODEX ROLES the root runs by hand — the plan-pack review and
// the contract-vs-code cross-check — which ship as templates (a strict-mode output schema and a
// brief each) rather than as prompts composed in a script, because Phase 0 runs in the root
// session, before any workflow exists.
//
// Three properties, each one an arc-observed death class when it slips:
//   1. STRICT MODE. `codex exec --output-schema` is OpenAI strict mode (evals/README.md P1): every
//      property must be required at every level and additionalProperties must be false, or the
//      turn 400s with invalid_json_schema and the role dies with no report.
//   2. CAPS ARE CONTRACTS. Every maxLength/maxItems the schema carries must be stated in the brief,
//      by field name, with its bound (RATIONALE §9 — a cap the model is never told is a trap).
//   3. PLACEHOLDERS. The briefs are filled by the root with `sed`; every `{{NAME}}` a brief uses
//      must be one SKILL.md documents, and no other token of that shape may appear.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { capsOf, statesBudgetFor } from './hygiene-lib.mjs'

const T = (f) => fileURLToPath(new URL(`../../templates/${f}`, import.meta.url))
const ROLES = [
  { name: 'plan-pack review', schema: 'phase0-review.schema.json', brief: 'phase0-review-brief.md' },
  { name: 'contract-vs-code cross-check', schema: 'phase0-contract-check.schema.json', brief: 'phase0-contract-check-brief.md' },
]
const PLACEHOLDERS = ['REPO', 'ROADMAP']
const SKILL = readFileSync(fileURLToPath(new URL('../../SKILL.md', import.meta.url)), 'utf8')

// Walk a JSON schema and assert strict-mode legality at every object level.
function assertStrict(node, path) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false, `${path}: additionalProperties must be false`)
    const keys = Object.keys(node.properties ?? {})
    assert.deepEqual([...(node.required ?? [])].sort(), [...keys].sort(),
      `${path}: strict mode requires EVERY property to be listed in required`)
    for (const k of keys) assertStrict(node.properties[k], `${path}.${k}`)
  }
  if (node.type === 'array') assertStrict(node.items, `${path}[]`)
}

for (const role of ROLES) {
  const schema = JSON.parse(readFileSync(T(role.schema), 'utf8'))
  const brief = readFileSync(T(role.brief), 'utf8')

  test(`${role.name}: the output schema is OpenAI strict-mode legal at every level`, () => {
    assertStrict(schema, role.schema)
    assert.ok(schema.$comment?.includes('strict mode'), 'the schema says why it is shaped this way')
  })

  test(`${role.name}: every cap in the schema is stated in the brief, by field name and bound`, () => {
    const caps = capsOf(schema)
    assert.ok(caps.length > 0, 'the schema carries caps (this test would otherwise be vacuous)')
    // An array of capped strings is named by the array (`questions`), not by the `[]` the lib records.
    const nameOf = (c) => c.path.split('.').filter((p) => p !== '[]').pop()
    const missing = caps.filter((c) => !statesBudgetFor(brief, nameOf(c))).map((c) => `${c.path} (${c.max})`)
    assert.deepEqual(missing, [], `${role.brief} drives a capped field without stating its budget`)
    // Item counts too: a per-item cap on an unbounded array bounds nothing, and a bounded one the
    // model is not told about is overrun on the first thorough report.
    for (const [k, v] of Object.entries(schema.properties)) {
      if (v.type !== 'array' || v.maxItems == null) continue
      assert.match(brief, new RegExp(`\`${k}\`[\\s\\S]{0,900}?At most ${v.maxItems}`),
        `${role.brief} must tell the model \`${k}\` holds at most ${v.maxItems} entries`)
    }
  })

  test(`${role.name}: the brief carries the strict-mode closing rule and the read-only bar`, () => {
    assert.match(brief, /ONLY a JSON object matching the output schema/, 'the final message is the report and nothing else')
    assert.match(brief, /Emit every\s+field, even when empty/, 'strict mode: optional-by-meaning fields are still emitted')
    assert.match(brief, /no field the\s+schema does not define/, 'and no undeclared keys')
    assert.match(brief, /Read-only\. Write no code, create no files, make no commit/, 'the role changes nothing')
    assert.match(brief, /adjudicated by (that|the) architect|Judge what the contracts SAY/, 'and decides nothing — Claude decides')
  })

  test(`${role.name}: every placeholder the brief uses is documented in SKILL.md, and no stray one exists`, () => {
    const used = [...new Set([...brief.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))]
    assert.deepEqual(used.filter((p) => !PLACEHOLDERS.includes(p)), [], 'unknown placeholder in the brief')
    for (const p of used)
      assert.ok(SKILL.includes(`{{${p}}}`), `SKILL.md never tells the root how to fill {{${p}}}`)
  })
}

test('SKILL.md names both templates by file, so the root runs the shipped brief and schema rather than improvising one', () => {
  for (const role of ROLES) {
    assert.ok(SKILL.includes(`templates/${role.schema}`), `SKILL.md does not name ${role.schema}`)
    assert.ok(SKILL.includes(`templates/${role.brief}`), `SKILL.md does not name ${role.brief}`)
  }
})

test('SKILL.md names the reviewer model explicitly — astra, never "the strongest model available"', () => {
  assert.ok(SKILL.includes('-m gpt-6-astra'), 'the invocation pins gpt-6-astra')
  assert.ok(SKILL.includes('codexReviewModel'), 'and names the knob that overrides it')
  assert.doesNotMatch(SKILL, /<review model>/, 'no placeholder the root would fill with the build model')
  assert.match(SKILL, /never a silent downgrade/, 'a fallback to the build model is a journaled user decision')
})

test('the contract cross-check `surfaces` list is a completeness list: uncapped in count, capped per entry', () => {
  const schema = JSON.parse(readFileSync(T('phase0-contract-check.schema.json'), 'utf8'))
  assert.equal(schema.properties.surfaces.maxItems, undefined, 'a sampled surface list hides exactly the divergence it exists to find')
  assert.deepEqual(schema.properties.surfaces.items.properties.verdict.enum, ['matches', 'differs', 'absent'])
})
