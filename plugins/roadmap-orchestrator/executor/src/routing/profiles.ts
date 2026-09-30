// The built-in seat table (DESIGN-1.0.md §4 Routing profiles): the lowest layer of the stack in layers.ts,
// naming classes, never models. Both profiles share it; a profile differs only in how it binds the classes
// (classes.ts). Judgment resolves to Claude in both, because every Codex judgment triple is unsupported
// until a read-only Codex judgment profile exists (R21).
import type { ClassTable, JudgmentSeat, ModelClass } from './types.ts';

/**
 * Frontier plan-checks and gates at every risk; an escalation (route-up or risk trigger) goes to summit.
 * Owner ruling (arc-1 feedback items 8, 9): independence is a clean context, not a different model, so
 * every tier judges on the frontier class and the stronger class is spent only where a judgment escalates.
 */
const JUDGMENT: { readonly [S in JudgmentSeat]: ModelClass } = { low: 'frontier', med: 'frontier', high: 'frontier', escalation: 'summit' };

/**
 * The efficient class builds low/med, frontier builds high. The arc roles (M3): the lenses on frontier (Opus),
 * the checkpoint on summit (Fable); they are in force only while the arc is holistic (layers.ts).
 */
export const BUILTIN_SEATS: ClassTable = {
  planCheck: JUDGMENT,
  build: { low: 'efficient', med: 'efficient', high: 'frontier' },
  gate: JUDGMENT,
  lens: { arc: 'frontier' },
  checkpoint: { arc: 'summit' },
};
