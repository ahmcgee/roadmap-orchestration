// Schema 2 is a hard cutover. Previous run directories must finish on their original executor.
export const SCHEMA_VERSION = 2;
export type SchemaVersion = typeof SCHEMA_VERSION;
