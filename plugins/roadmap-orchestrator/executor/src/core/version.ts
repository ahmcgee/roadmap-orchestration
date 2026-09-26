// The one schema version. Every executor-written file and log line carries `v: SCHEMA_VERSION`. Record
// changes are additive with read-time defaults, so an update adopts the previous release's arcs; the version
// is bumped (here and in SCHEMAS.md together) only for a change that cannot be defaulted, and then readers
// accept both versions (SCHEMAS.md "Record evolution"). Input files authored by Phase 0 (`plan.json`,
// `spec.json`) carry a `schema` string instead, because their shape is chosen by the input contract.
export const SCHEMA_VERSION = 1;
export type SchemaVersion = typeof SCHEMA_VERSION;
