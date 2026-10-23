// The built-in seat table (DESIGN-1.0.md §4 Routing profiles): the lowest layer of the stack in layers.ts,
// naming classes, never models. Both profiles share it; a profile differs only in how it binds the classes
// (classes.ts). Every judgment seat binds a class's judgment triple, which is Claude in both profiles (no read-only
// Codex judgment profile exists, R21).
import type { ClassTable, JudgmentSeat, ModelClass } from './types.ts';

/**
 * dev.17 (owner 2026-10-22, the routing research: a strong planner and reviewer over a cheaper executor): plan-check and the
 * gate judge on frontier (Opus 5.5 medium) at every risk tier, and on summit at `escalation` (a route-up or risk trigger).
 * Before dev.17 efficient (Sonnet 5.5) held plan-check and the gate at low and med. The economy class stays, named by no
 * built-in seat, for a retry (BACKLOG "Haiku at the low-risk gate: retry"). Owner ruling (arc-1 feedback items 8, 9):
 * independence is a clean context, not a different model.
 */
const PLAN_CHECK: { readonly [S in JudgmentSeat]: ModelClass } = { low: 'frontier', med: 'frontier', high: 'frontier', escalation: 'summit' };
const GATE: { readonly [S in JudgmentSeat]: ModelClass } = { low: 'frontier', med: 'frontier', high: 'frontier', escalation: 'summit' };

/**
 * dev.17: the efficient class builds at every risk tier (Sonnet 5.5 medium under `claude-only`), and a Claude build consults
 * an Opus advisor at its own decision points (`BUILD_ADVISOR`, classes.ts; backends/argv.ts). The arc roles: the lenses (M3)
 * and the flow role (M4b) on efficient (owner ruling 2026-10-15), the pack review (M4a, OR-Q16) on frontier, the checkpoint
 * (M3) on summit; each is in force only in the arcs its `ArcScope` names (layers.ts: lens and checkpoint in a holistic arc,
 * the pack review in a corpus arc only, LR-0a-1; flow in every arc of the `m4b` role set). dev.13 (R4): the walkthrough and
 * the polish judge on frontier (Opus 5.5 medium), in force only in an arc whose plan has milestones.
 */
export const BUILTIN_SEATS: ClassTable = {
  planCheck: PLAN_CHECK,
  build: { low: 'efficient', med: 'efficient', high: 'efficient' },
  gate: GATE,
  lens: { arc: 'efficient' },
  checkpoint: { arc: 'summit' },
  packReview: { arc: 'frontier' },
  flow: { arc: 'efficient' },
  walkthrough: { arc: 'frontier' },
  polishJudge: { arc: 'frontier' },
  // dev.17 (proportional review): the docs-only verifier on economy (Haiku 5.5 high) at every risk tier: a closed per-hunk
  // classification, and code accepts only when every hunk is clear (src/pipeline/docsonly.ts).
  verifier: { low: 'economy', med: 'economy', high: 'economy' },
};
