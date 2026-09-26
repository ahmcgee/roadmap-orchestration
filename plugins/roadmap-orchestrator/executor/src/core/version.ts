// The one schema version. Every executor-written file and log line carries `v: SCHEMA_VERSION`; a schema
// change bumps it here and in SCHEMAS.md together. Input files authored by Phase 0 (`plan.json`,
// `spec.json`) carry a `schema` string instead, because their shape is chosen by the input contract.
export const SCHEMA_VERSION = 1;
export type SchemaVersion = typeof SCHEMA_VERSION;
