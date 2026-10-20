// The built-in seat table (DESIGN-1.0.md §4 Routing profiles): the lowest layer of the stack in layers.ts,
// naming classes, never models. Both profiles share it; a profile differs only in how it binds the classes
// (classes.ts). Every judgment seat binds a class's judgment triple, which is Claude in both profiles (no read-only
// Codex judgment profile exists, R21).
import type { ClassTable, JudgmentSeat, ModelClass } from './types.ts';

/**
 * Efficient plan-checks low and med risk, frontier high (owner ruling 2026-10-15). The gate's risk ladder (owner direction
 * 2026-10-17, 1.0.0-dev.12): efficient (Sonnet 5.5) gates low and med, frontier (Opus 5.5) high. gate.low was economy
 * (Haiku 5.5) until the paid gate role eval (2026-10-17) failed it on clean-cell false alarms (4/12 at high, all one
 * mistake: a spec-vs-ruling tension blocked on instead of listed in premises) and it reverted; the economy class stays,
 * named by no built-in seat, for a retry (BACKLOG "Haiku at the low-risk gate: retry"). An escalation (route-up or risk trigger) goes to
 * summit. Owner ruling (arc-1 feedback items 8, 9): independence is a clean context, not a different model, so the
 * stronger classes are spent where the risk is and where a judgment escalates.
 */
const PLAN_CHECK: { readonly [S in JudgmentSeat]: ModelClass } = { low: 'efficient', med: 'efficient', high: 'frontier', escalation: 'summit' };
const GATE: { readonly [S in JudgmentSeat]: ModelClass } = { low: 'efficient', med: 'efficient', high: 'frontier', escalation: 'summit' };

/**
 * The efficient class builds low/med, frontier builds high. The arc roles: the lenses (M3) and the flow role (M4b) on
 * efficient (owner ruling 2026-10-15), the pack review (M4a, OR-Q16) on frontier, the checkpoint (M3) on summit; each is
 * in force only in the arcs its `ArcScope` names (layers.ts: lens and checkpoint in a holistic arc, the pack review in a
 * corpus arc only, LR-0a-1; flow in every arc of the `m4b` role set). dev.13 (R4): the walkthrough and the polish judge on
 * frontier (Opus 5.5 medium), in force only in an arc whose plan has milestones.
 */
export const BUILTIN_SEATS: ClassTable = {
  planCheck: PLAN_CHECK,
  build: { low: 'efficient', med: 'efficient', high: 'frontier' },
  gate: GATE,
  lens: { arc: 'efficient' },
  checkpoint: { arc: 'summit' },
  packReview: { arc: 'frontier' },
  flow: { arc: 'efficient' },
  walkthrough: { arc: 'frontier' },
  polishJudge: { arc: 'frontier' },
};
