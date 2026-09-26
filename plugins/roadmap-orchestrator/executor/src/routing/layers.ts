// The routing stack (DESIGN-1.0.md §4, Routing profiles), lowest to highest precedence:
//
//   builtin profile  <  .roadmap/config.json routing  <  plan.json routing  <  per-unit route
//
// Every layer names a model CLASS per seat, never a model. The profile is a full table; each layer above it
// is a partial one, and a seat takes its class from the highest layer that names it. Each class then binds
// to a triple: the class catalogue (classes.ts), unless the repo config rebinds it. The resolved table of
// triples is hashed into the RoutingRev that records carry instead of model ids, so a rebind changes the
// rev exactly as a seat edit does.
//
// Seats: build has `low | med | high`; planCheck and gate also have `escalation`, where route-ups and risk
// triggers go (transitions.ts). A unit's risk is never `escalation`.
//
// `.roadmap/config.json` (committed, set once per repo):
//
//   { "routing": {
//       "profile": "default" | "claude-only",                      optional; the base profile
//       "seats": { "<planCheck|gate>": { "<low|med|high|escalation>": "<class>" },
//                  "build": { "<low|med|high>": "<class>" } },        optional; any subset of seats
//       "classes": { "<efficient|frontier|summit>":                    optional; rebinds for this repo
//                      { "backend", "model", "effort" } } } }
//
//   Classes: `efficient | frontier | summit`. A seat value that is a triple is refused: triples are bound
//   only under `classes`, which is repo-level (a plan cannot rebind a class). A binding's effort is one its
//   model lists in models.ts: a Claude model low | medium | high | xhigh | max, a Codex model low | medium | high. Unknown
//   keys are refused. `{"routing": {"profile": "claude-only"}}` is the one config line that selects the
//   Claude-only profile. The profile is chosen by an explicit `start --profile`, else this file's
//   `profile`, else `default`.
import type { UnitId } from '../core/ids.ts';
import { type RoutingRev, routingRev } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { type Read, SchemaError, object } from '../core/validate.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { support } from '../prompts/index.ts';
import { CLASS_CATALOGUE } from './classes.ts';
import { effortSupported, modelInfo } from './models.ts';
import { PROFILE_TABLES } from './profiles.ts';
import {
  type ClassBindings, type ClassSource, type ClassTable, MODEL_CLASSES, type ModelClass, type ProfileName, type Role,
  type RoutingLayer, type RoutingLayerName, type RoutingTable, SEAT_REFS, type SeatRef, type SeatTable, type Triple, atSeat,
  profileName, routingLayer, seatTable, triple,
} from './types.ts';

/** A class rebind: a triple whose effort the model catalogue lists for its model. */
const binding: Read<Triple> = (value, path) => {
  const t = triple(value, path);
  if (!effortSupported(t)) throw new SchemaError(`${path}.effort`, `one of ${modelInfo(t.model).efforts.join(' | ')}`, t.effort);
  return t;
};

const classBindings: Read<ClassBindings> = object((f) => {
  const out: Partial<Record<ModelClass, Triple>> = {};
  for (const c of MODEL_CLASSES) {
    const t = f.optional(c, binding);
    if (t !== undefined) out[c] = t;
  }
  return out;
});

export type RepoConfig = Readonly<{ routing?: Readonly<{ profile?: ProfileName; seats?: RoutingLayer; classes?: ClassBindings }> }>;

export const repoConfig = object((f): RepoConfig => {
  const routing = f.optional('routing', object((g) => {
    const out: { profile?: ProfileName; seats?: RoutingLayer; classes?: ClassBindings } = {};
    const profile = g.optional('profile', profileName);
    const seats = g.optional('seats', routingLayer);
    const classes = g.optional('classes', classBindings);
    if (profile !== undefined) out.profile = profile;
    if (seats !== undefined) out.seats = seats;
    if (classes !== undefined) out.classes = classes;
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
  /** The repo config's class rebinds; null when it has none. */
  classes: ClassBindings | null;
  repoConfig: RoutingLayer | null;
  plan: RoutingLayer | null;
  unit: RoutingLayer | null;
}>;

/** The stack of a repo config and a plan layer (no per-unit layers in M1). */
export function arcStack(profile: ProfileName, config: RepoConfig | null, plan: RoutingLayer | null): RoutingStack {
  return { profile, classes: config?.routing?.classes ?? null, repoConfig: config?.routing?.seats ?? null, plan, unit: null };
}

export type SeatSources = SeatTable<RoutingLayerName>;
export type ResolvedRouting = Readonly<{
  /** The triple at every seat: what dispatch uses and `rev` hashes. */
  table: RoutingTable;
  /** The class at every seat, and the layer that named it. */
  classes: ClassTable;
  sources: SeatSources;
  /** Where each class's binding came from. */
  bindings: { readonly [C in ModelClass]: ClassSource };
  rev: RoutingRev;
}>;

const LAYERS = [['unit', 'unit'], ['plan', 'plan'], ['repo-config', 'repoConfig']] as const;

/** Resolves every seat through the stack to a class, and every class to its binding. */
export function resolveRouting(stack: RoutingStack): ResolvedRouting {
  const bound = (c: ModelClass): Triple => stack.classes?.[c] ?? CLASS_CATALOGUE[c];
  const named = (seat: SeatRef): readonly [ModelClass, RoutingLayerName] => {
    for (const [name, key] of LAYERS) {
      const c = (stack[key]?.[seat.role] as Readonly<Partial<Record<string, ModelClass>>> | undefined)?.[seat.tier];
      if (c !== undefined) return [c, name];
    }
    return [atSeat(PROFILE_TABLES[stack.profile], seat), 'builtin'];
  };
  const classes = seatTable((s) => named(s)[0]);
  const table = seatTable((s) => bound(atSeat(classes, s)));
  const bindings = Object.fromEntries(MODEL_CLASSES.map((c) => [c, stack.classes?.[c] === undefined ? 'builtin' : 'repo-config'])) as ResolvedRouting['bindings'];
  return { table, classes, sources: seatTable((s) => named(s)[1]), bindings, rev: routingRevOf(table) };
}

/** First 16 hex of sha256 over the canonical JSON of the resolved table. */
export function routingRevOf(table: RoutingTable): RoutingRev {
  return routingRev(sha256Hex(canonicalJson(table)).slice(0, 16));
}

/**
 * The startup row for routing: every seat whose bound model has no usable prompt. A Codex model at a
 * judgment seat is `codex-judgment`; any other unsupported pair is `no-prompt`. Names the seat, the layer
 * that chose its class and the class, never the model.
 */
export function unsupportedSeats(resolved: ResolvedRouting, unit: UnitId | null): StartupRejection[] {
  const out: StartupRejection[] = [];
  for (const seat of SEAT_REFS) {
    const t = atSeat(resolved.table, seat);
    if (supported(seat.role, t.model)) continue;
    const why = seat.role !== 'build' && t.backend === 'codex' ? 'codex-judgment' : 'no-prompt';
    out.push({ kind: 'unsupported-routing', ...seat, layer: atSeat(resolved.sources, seat), class: atSeat(resolved.classes, seat), unit, why });
  }
  return out;
}

function supported(role: Role, model: Triple['model']): boolean {
  const s = support(role, model);
  return s.type === 'prompt' || (s.type === 'inherits' && supported(role, s.from));
}
