// The routing stack (DESIGN-1.0.md §4, Routing profiles), lowest to highest precedence:
//
//   builtin profile  <  .roadmap/config.json routing  <  plan.json routing  <  per-unit route
//
// Each layer above the profile is a partial table; a seat takes its triple from the highest layer that
// names it. The resolved table is hashed into the RoutingRev that records carry instead of model ids.
//
// `.roadmap/config.json` (committed, set once per repo):
//
//   { "routing": {
//       "profile": "default" | "claude-only",                      optional; the base profile
//       "seats": { "<planCheck|build|gate>": {                      optional; any subset of seats
//                    "<low|med|high>": { "backend", "model", "effort" } } } } }
//
//   A Claude triple's effort is "default"; a Codex triple's effort is one its model lists in
//   models.ts (low | medium | high). Unknown keys are refused. `{"routing": {"profile": "claude-only"}}`
//   is the one config line that selects the Claude-only profile. The profile is chosen by an explicit
//   `start --profile`, else this file's `profile`, else `default`.
import type { UnitId } from '../core/ids.ts';
import { type RoutingRev, routingRev } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { SchemaError, object } from '../core/validate.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { support } from '../prompts/index.ts';
import { effortSupported, modelInfo } from './models.ts';
import { PROFILE_TABLES } from './profiles.ts';
import {
  RISK_TIERS, ROLES, type ProfileName, type RiskTier, type Role, type RoutingLayer, type RoutingLayerName, type RoutingTable,
  type Triple, profileName, routingLayer,
} from './types.ts';

export type RepoConfig = Readonly<{ routing?: Readonly<{ profile?: ProfileName; seats?: RoutingLayer }> }>;

export const repoConfig = object((f): RepoConfig => {
  const routing = f.optional('routing', object((g) => {
    const out: { profile?: ProfileName; seats?: RoutingLayer } = {};
    const profile = g.optional('profile', profileName);
    const seats = g.optional('seats', routingLayer);
    if (profile !== undefined) out.profile = profile;
    if (seats !== undefined) out.seats = seats;
    return out;
  }));
  return routing === undefined ? {} : { routing };
});

/** Reads `.roadmap/config.json`'s parsed JSON. */
export function parseRepoConfig(value: unknown): RepoConfig {
  return repoConfig(value, 'config');
}

/** An explicit `--profile` wins, then the repo config's `profile`, then `default`. */
export function selectProfile(cli: ProfileName | null, config: RepoConfig | null): ProfileName {
  return cli ?? config?.routing?.profile ?? 'default';
}

export type RoutingStack = Readonly<{
  profile: ProfileName;
  repoConfig: RoutingLayer | null;
  plan: RoutingLayer | null;
  unit: RoutingLayer | null;
}>;

export type SeatSources = { readonly [R in Role]: { readonly [T in RiskTier]: RoutingLayerName } };
export type ResolvedRouting = Readonly<{ table: RoutingTable; sources: SeatSources; rev: RoutingRev }>;

const LAYERS = [['unit', 'unit'], ['plan', 'plan'], ['repo-config', 'repoConfig']] as const;

/** Resolves every seat through the stack. An effort its model does not list is a SchemaError naming the layer. */
export function resolveRouting(stack: RoutingStack): ResolvedRouting {
  const table = {} as { [R in Role]: { [T in RiskTier]: Triple } };
  const sources = {} as { [R in Role]: { [T in RiskTier]: RoutingLayerName } };
  for (const r of ROLES) {
    table[r] = {} as { [T in RiskTier]: Triple };
    sources[r] = {} as { [T in RiskTier]: RoutingLayerName };
    for (const t of RISK_TIERS) {
      let triple: Triple = PROFILE_TABLES[stack.profile][r][t];
      let source: RoutingLayerName = 'builtin';
      for (const [name, key] of LAYERS) {
        const named = stack[key]?.[r]?.[t];
        if (named !== undefined) {
          if (!effortSupported(named)) {
            throw new SchemaError(`${name}.${r}.${t}.effort`, `one of ${modelInfo(named.model).efforts.join(' | ')}`, named.effort);
          }
          triple = named;
          source = name;
          break;
        }
      }
      table[r][t] = triple;
      sources[r][t] = source;
    }
  }
  return { table, sources, rev: routingRevOf(table) };
}

/** First 16 hex of sha256 over the canonical JSON of the resolved table. */
export function routingRevOf(table: RoutingTable): RoutingRev {
  return routingRev(sha256Hex(canonicalJson(table)).slice(0, 16));
}

/**
 * The startup row for routing: every seat whose model has no usable prompt. A Codex model at a judgment
 * seat is `codex-judgment`; any other unsupported pair is `no-prompt`. Names the seat and the layer,
 * never the model.
 */
export function unsupportedSeats(resolved: ResolvedRouting, unit: UnitId | null): StartupRejection[] {
  const out: StartupRejection[] = [];
  for (const role of ROLES) {
    for (const tier of RISK_TIERS) {
      const triple = resolved.table[role][tier];
      if (supported(role, triple.model)) continue;
      const why = role !== 'build' && triple.backend === 'codex' ? 'codex-judgment' : 'no-prompt';
      out.push({ kind: 'unsupported-routing', role, tier, layer: resolved.sources[role][tier], unit, why });
    }
  }
  return out;
}

function supported(role: Role, model: Triple['model']): boolean {
  const s = support(role, model);
  return s.type === 'prompt' || (s.type === 'inherits' && supported(role, s.from));
}
