import type { RiskTier } from './types.ts';
import { boundAt } from './classes.ts';
import { type ResolvedRouting, routingRevOf } from './layers.ts';

/** A Claude fallback is a routing revision, so historical role usage resolves to the seat actually used. */
export function claudeBuilderRouting(routing: ResolvedRouting, tiers: readonly RiskTier[] = ['low', 'med', 'high']): ResolvedRouting {
  const build = {...routing.table.build};
  let changed = false;
  for (const risk of tiers) {
    if (build[risk].backend !== 'codex') continue;
    build[risk] = boundAt('claude-only', risk === 'high' ? 'frontier' : 'efficient', 'build');
    changed = true;
  }
  if (!changed) return routing;
  const table = {...routing.table, build};
  return {...routing, table, rev: routingRevOf(table, routing.arcScope, routing.arcRoles, routing.milestones), earlierBuiltinRevs: []};
}
