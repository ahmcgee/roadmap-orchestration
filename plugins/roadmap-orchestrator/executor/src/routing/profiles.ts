// The two built-in routing profiles (DESIGN-1.0.md §4 Routing profiles, D2). Each is a full RoutingTable:
// the lowest layer of the stack in layers.ts. Judgment roles resolve to Claude in both profiles, because
// every Codex judgment triple is unsupported until a read-only Codex judgment profile exists (R21).
import type { ProfileName, RiskTier, Role, RoutingTable, Triple } from './types.ts';

const OPUS: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'default' };
const FABLE: Triple = { backend: 'claude', model: 'claude-fable-5-1', effort: 'default' };
// D2 names the seat (Luna builds low/med) but no effort; `medium` is Luna's own default.
const LUNA_BUILD: Triple = { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' };

/** Opus judges low and med; Fable judges high. Shared by both profiles. */
const JUDGMENT = { low: OPUS, med: OPUS, high: FABLE } as const;

export const PROFILE_TABLES: { readonly [P in ProfileName]: RoutingTable } = {
  // D2: Luna builds low/med, Opus 5.5 builds high, Opus plan-checks and gates low/med, Fable high.
  default: {
    planCheck: JUDGMENT,
    build: { low: LUNA_BUILD, med: LUNA_BUILD, high: OPUS },
    gate: JUDGMENT,
  },
  // No Codex dependency: Opus builds every tier; judgment seats as in `default`.
  'claude-only': {
    planCheck: JUDGMENT,
    build: { low: OPUS, med: OPUS, high: OPUS },
    gate: JUDGMENT,
  },
};

export function resolve(table: RoutingTable, role: Role, tier: RiskTier): Triple {
  return table[role][tier];
}
