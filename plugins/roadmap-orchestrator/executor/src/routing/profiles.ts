// The built-in seat table (DESIGN-1.0.md §4 Routing profiles): the lowest layer of the stack in layers.ts,
// naming classes, never models. Both profiles share it; a profile differs only in how it binds the classes
// (classes.ts). Every judgment seat binds a class's judgment triple, which is Claude in both profiles (no read-only
// Codex judgment profile exists, R21).
import type { ClassTable, JudgmentSeat, ModelClass } from './types.ts';

/**
 * Efficient plan-checks and gates low risk and frontier med and high (owner ruling 2026-10-15: plan-check's med seat
 * too); an escalation (route-up or risk trigger) goes to summit. Owner ruling (arc-1 feedback items 8, 9): independence
 * is a clean context, not a different model, so the stronger classes are spent where the risk is and where a judgment
 * escalates.
 */
const PLAN_CHECK: { readonly [S in JudgmentSeat]: ModelClass } = { low: 'efficient', med: 'efficient', high: 'frontier', escalation: 'summit' };
const GATE: { readonly [S in JudgmentSeat]: ModelClass } = { low: 'efficient', med: 'frontier', high: 'frontier', escalation: 'summit' };

/**
 * The efficient class builds low/med, frontier builds high. The arc roles: the lenses (M3) and the flow role (M4b) on
 * efficient (owner ruling 2026-10-15), the pack review (M4a, OR-Q16) on frontier, the checkpoint (M3) on summit; each is
 * in force only in the arcs its `ArcScope` names (layers.ts: lens and checkpoint in a holistic arc, the pack review in a
 * corpus arc only, LR-0a-1; flow in every arc of the `m4b` role set).
 */
export const BUILTIN_SEATS: ClassTable = {
  planCheck: PLAN_CHECK,
  build: { low: 'efficient', med: 'efficient', high: 'frontier' },
  gate: GATE,
  lens: { arc: 'efficient' },
  checkpoint: { arc: 'summit' },
  packReview: { arc: 'frontier' },
  flow: { arc: 'efficient' },
};
