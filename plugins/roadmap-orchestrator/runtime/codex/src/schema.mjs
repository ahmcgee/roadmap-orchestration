import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false })

const nullable = (schema) => {
  const out = { ...schema }
  if (Array.isArray(out.type)) out.type = [...new Set([...out.type, 'null'])]
  else if (out.type) out.type = [out.type, 'null']
  else out.anyOf = [...(out.anyOf ?? [{ ...schema }]), { type: 'null' }]
  if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null]
  return out
}

export function toStrictOutputSchema(schema, optional = false) {
  let out = { ...schema }
  if (schema.properties) {
    const originallyRequired = new Set(schema.required ?? [])
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) =>
      [key, toStrictOutputSchema(value, !originallyRequired.has(key))]))
    out.required = Object.keys(schema.properties)
    out.additionalProperties = false
  }
  if (schema.items) out.items = toStrictOutputSchema(schema.items)
  if (schema.anyOf) out.anyOf = schema.anyOf.map((part) => toStrictOutputSchema(part))
  if (schema.oneOf) out.oneOf = schema.oneOf.map((part) => toStrictOutputSchema(part))
  if (optional) out = nullable(out)
  return out
}

function stripOptionalNulls(value, schema) {
  if (Array.isArray(value)) return value.map((item) => stripOptionalNulls(item, schema.items ?? {}))
  if (!value || typeof value !== 'object' || !schema.properties) return value
  const required = new Set(schema.required ?? [])
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (child === null && !required.has(key)) continue
    out[key] = stripOptionalNulls(child, schema.properties[key] ?? {})
  }
  return out
}

export function parseStructuredOutput(text, schema) {
  let parsed
  try { parsed = JSON.parse(text) }
  catch (error) { throw new Error(`StructuredOutput: invalid JSON: ${error.message}`) }
  parsed = stripOptionalNulls(parsed, schema)
  const validate = ajv.compile(schema)
  if (!validate(parsed))
    throw new Error(`StructuredOutput: schema validation failed: ${ajv.errorsText(validate.errors, { separator: '; ' })}`)
  return parsed
}
