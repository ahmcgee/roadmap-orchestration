// The routing stack (DESIGN-1.0.md §4, Routing profiles), lowest to highest precedence:
//
//   builtin profile  <  .roadmap/config.json routing  <  plan.json routing  <  per-unit route
//
// The per-unit layer (M3: `route`, `steer --class`) is a plan unit's `routing`; a unit resolves through the arc's stack
// with its own layer on top, so each unit has its own routingRev (the arc's when it has no layer). The routing in force
// is resolved from the `routingProvenance` its plan revision recorded (`provenanceStack`, H7), never a live config.
//
// Every layer names a model CLASS per seat, never a model. The built-in seats (profiles.ts) are a full table; each layer
// above them is a partial one, and a seat takes its class from the highest layer that names it. Each class
// then binds to a triple: the profile's class catalogue (classes.ts), unless the repo config rebinds it. The resolved table of
// triples is hashed into the RoutingRev that records carry instead of model ids, so a rebind changes the
// rev exactly as a seat edit does.
//
// Seats: build has `low | med | high`; planCheck and gate also have `escalation`, where route-ups and risk
// triggers go (transitions.ts). A unit's risk is never `escalation`. The arc roles `lens`, `checkpoint` (M3) and
// `packReview` (M4a) have the one seat `arc`. An arc role is in force (checked, smoked and hashed) only where it can run,
// the arc's `ArcScope`: none in a non-holistic arc (G20: it resolves exactly as in M2, so its `routingRev` is the one
// 1.0.0-dev.5 recorded); `lens` and `checkpoint` in a holistic `architecture-doc` arc (so its seats in force are the
// ones 1.0.0-dev.6 hashed); all three in a corpus arc (lead ruling LR-0a-1: the pack review runs only there).
//
// `.roadmap/config.json` (committed, set once per repo):
//
//   { "routing": {
//       "profile": "default" | "claude-only",                      optional; the base profile
//       "seats": { "<planCheck|gate>": { "<low|med|high|escalation>": "<class>" },
//                  "build": { "<low|med|high>": "<class>" } },        optional; any subset of seats
//       "classes": { "<efficient|frontier|summit>":                    optional; rebinds for this repo
//                      { "backend", "model", "effort" } } },
//     "chain": { "k": <positive> } }                                  optional (M4a): unacked chained starts allowed
//
//   `chain.k` (M4a, OR-Q19, K10) is asked once at bootstrap and committed by the owner; the root agent never writes it.
//   Absent: K unset (a chained start is refused `chain-invalid{k-unset}`). Nothing about issues lives here (OR-L6).
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
import { object, positive } from '../core/validate.ts';
import type { PlanM1, PlanTargetKind } from '../input/plan.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { support } from '../prompts/index.ts';
import { CLASS_CATALOGUE, type ClassCatalogue } from './classes.ts';
import { BUILTIN_SEATS } from './profiles.ts';
import {
  type ArcRole, type ClassBindings, type ClassSource, type ClassTable, MODEL_CLASSES, type ModelClass, type ProfileName, type Role,
  type RoutingLayer, type RoutingLayerName, type RoutingProvenance, type RoutingTable, SEAT_REFS, type SeatRef, type SeatTable, type Triple, UNIT_ROLES, atSeat,
  classBindings, profileName, routingLayer, seatTable,
} from './types.ts';

export type RepoConfig = Readonly<{
  routing?: Readonly<{ profile?: ProfileName; seats?: RoutingLayer; classes?: ClassBindings }>;
  chain?: Readonly<{ k: number }>;
}>;

export const repoConfig = object((f): RepoConfig => {
  const chain = f.optional('chain', object((g) => ({ k: g.get('k', positive) })));
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
  return { ...(routing === undefined ? {} : { routing }), ...(chain === undefined ? {} : { chain }) };
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
  /** A holistic arc's scope: which arc roles are in force (`ARC_ROLES_IN_FORCE`); absent outside a holistic arc (`none`). */
  arcScope?: PlanTargetKind;
}>;

/**
 * Where the arc roles can run (G20, LR-0a-1): `none` outside a holistic arc, else the plan's target kind. A holistic
 * `architecture-doc` arc runs the M3 roles; a corpus arc (always holistic) runs every arc role.
 */
export type ArcScope = 'none' | PlanTargetKind;
export const ARC_ROLES_IN_FORCE: { readonly [S in ArcScope]: readonly ArcRole[] } = {
  none: [], 'architecture-doc': ['lens', 'checkpoint'], corpus: ['lens', 'checkpoint', 'packReview'],
};

/** A plan's arc scope: `none` without `holistic`, else its target kind. */
export function arcScopeOf(plan: Pick<PlanM1, 'target' | 'holistic'>): ArcScope {
  return plan.holistic === undefined ? 'none' : plan.target;
}

/** The stack of a repo config and a plan layer, without a unit layer and without the arc seats. */
export function arcStack(profile: ProfileName, config: RepoConfig | null, plan: RoutingLayer | null): RoutingStack {
  return { profile, classes: config?.routing?.classes ?? null, repoConfig: config?.routing?.seats ?? null, plan, unit: null };
}

/** `stack` with the arc seats of `arcScope` in force. */
function scoped(stack: RoutingStack, arcScope: ArcScope): RoutingStack {
  return arcScope === 'none' ? stack : { ...stack, arcScope };
}

/** The arc's stack for a plan: its routing layer, and the arc seats its scope puts in force (G20). */
export function planStack(profile: ProfileName, config: RepoConfig | null, plan: Pick<PlanM1, 'routing' | 'target' | 'holistic'>): RoutingStack {
  return scoped(arcStack(profile, config, plan.routing ?? null), arcScopeOf(plan));
}

/**
 * The stack a plan revision's routing provenance records (H7), for the arc (`unit` null) or for one unit: the arc's
 * stack with that unit's own layer on top (`route`, `steer --class`), when it has one. Every routing in force is
 * resolved from this, so a live repo config is never re-read once a revision recorded what it resolved from; a unit
 * without a layer resolves exactly as the arc, so its routingRev is the arc's.
 */
export function provenanceStack(p: RoutingProvenance, arcScope: ArcScope, unit: UnitId | null): RoutingStack {
  return scoped({
    profile: p.profile, classes: p.repoConfig.classes, repoConfig: p.repoConfig.seats, plan: p.planLayer, unit: unit === null ? null : p.unitLayers[unit] ?? null,
  }, arcScope);
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
  /** The stack's `arcScope`: which arc seats are in force (`seatsInForce`). */
  arcScope: ArcScope;
}>;

const LAYERS = [['unit', 'unit'], ['plan', 'plan'], ['repo-config', 'repoConfig']] as const;

/** Resolves every seat through the stack to a class, and every class to its binding in the class catalogue. */
export function resolveRouting(stack: RoutingStack): ResolvedRouting {
  return resolveRoutingUnder(CLASS_CATALOGUE, stack);
}

/**
 * `resolveRouting` under a given catalogue. Only the dev.6 rev alias (src/core/upgrade.ts `dev6RevAlias`, scaffolding)
 * passes another one; every routing in force binds through `CLASS_CATALOGUE` (OR-L3: no routing generations).
 */
export function resolveRoutingUnder(catalogue: ClassCatalogue, stack: RoutingStack): ResolvedRouting {
  const bound = (c: ModelClass): Triple => stack.classes?.[c] ?? catalogue[stack.profile][c];
  const named = (seat: SeatRef): readonly [ModelClass, RoutingLayerName] => {
    for (const [name, key] of LAYERS) {
      const c = (stack[key]?.[seat.role] as Readonly<Partial<Record<string, ModelClass>>> | undefined)?.[seat.tier];
      if (c !== undefined) return [c, name];
    }
    return [atSeat(BUILTIN_SEATS, seat), 'builtin'];
  };
  const classes = seatTable((s) => named(s)[0]);
  const table = seatTable((s) => bound(atSeat(classes, s)));
  const bindings = Object.fromEntries(MODEL_CLASSES.map((c) => [c, stack.classes?.[c] === undefined ? 'builtin' : 'repo-config'])) as ResolvedRouting['bindings'];
  return { table, classes, sources: seatTable((s) => named(s)[1]), bindings, rev: routingRevOf(table, stack.arcScope ?? 'none'), arcScope: stack.arcScope ?? 'none' };
}

/**
 * First 16 hex of sha256 over the canonical JSON of the resolved table's roles in force: the unit roles and the arc
 * roles of `arcScope`. A non-holistic arc hashes the M2 table (its 1.0.0-dev.5 revs); a holistic `architecture-doc`
 * arc the 1.0.0-dev.6 role set (no `packReview`), so only the class catalogue (OR-L3) moved its revs.
 */
export function routingRevOf(table: RoutingTable, arcScope: ArcScope): RoutingRev {
  const roles: readonly Role[] = [...UNIT_ROLES, ...ARC_ROLES_IN_FORCE[arcScope]];
  return routingRev(sha256Hex(canonicalJson(Object.fromEntries(roles.map((r) => [r, table[r]])))).slice(0, 16));
}

/** The seats in force (G20, LR-0a-1): the unit roles' and the arc roles' of the resolved scope. */
export function seatsInForce(resolved: ResolvedRouting): readonly SeatRef[] {
  const arc: readonly Role[] = ARC_ROLES_IN_FORCE[resolved.arcScope];
  return SEAT_REFS.filter((s) => (UNIT_ROLES as readonly Role[]).includes(s.role) || arc.includes(s.role));
}

/**
 * The startup row for routing: every seat in force (`seatsInForce`: the arc seats of its scope only, G20)
 * whose bound model has no usable prompt. A Codex model at a judgment seat is `codex-judgment`; any other
 * unsupported pair is `no-prompt`. Names the seat, the layer that chose its class and the class, never the model.
 */
export function unsupportedSeats(resolved: ResolvedRouting, unit: UnitId | null): StartupRejection[] {
  const out: StartupRejection[] = [];
  for (const seat of seatsInForce(resolved)) {
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
