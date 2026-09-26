// The two built-in routing profiles (DESIGN-1.0.md §4 Routing profiles). Each is a full ClassTable: the
// lowest layer of the stack in layers.ts, naming classes, never models (classes.ts binds them). Judgment
// resolves to Claude in both profiles, because every Codex judgment triple is unsupported until a read-only
// Codex judgment profile exists (R21).
import type { ClassTable, JudgmentSeat, ModelClass, ProfileName } from './types.ts';

/**
 * Frontier plan-checks and gates at every risk; an escalation (route-up or risk trigger) goes to summit.
 * Owner ruling (arc-1 feedback items 8, 9): independence is a clean context, not a different model, so
 * every tier judges on the frontier class and the stronger class is spent only where a judgment escalates.
 */
const JUDGMENT: { readonly [S in JudgmentSeat]: ModelClass } = { low: 'frontier', med: 'frontier', high: 'frontier', escalation: 'summit' };

export const PROFILE_TABLES: { readonly [P in ProfileName]: ClassTable } = {
  // The efficient class builds low/med, frontier builds high.
  default: {
    planCheck: JUDGMENT,
    build: { low: 'efficient', med: 'efficient', high: 'frontier' },
    gate: JUDGMENT,
  },
  // No Codex dependency (with the built-in bindings): frontier builds every tier; judgment as in `default`.
  'claude-only': {
    planCheck: JUDGMENT,
    build: { low: 'frontier', med: 'frontier', high: 'frontier' },
    gate: JUDGMENT,
  },
};
