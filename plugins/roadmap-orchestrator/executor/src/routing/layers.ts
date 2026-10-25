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
// then binds to a triple: the profile's class catalogue (classes.ts), which binds a class's build seats and its judgment
// seats separately, unless the repo config rebinds it, which binds the class at every seat that names it (so a class
// rebound to Codex at a judgment seat is refused `codex-judgment`). The resolved table of triples is hashed into the
// RoutingRev that records carry instead of model ids, so a rebind changes the rev exactly as a seat edit does. Status
// aliases historical builtin seat and summit-effort hashes to today's bindings, without changing current routing.
//
// Seats: build has `low | med | high`; planCheck and gate also have `escalation`, where route-ups and risk
// triggers go (transitions.ts). A unit's risk is never `escalation`. The arc roles `lens`, `checkpoint` (M3),
// `packReview` (M4a) and `flow` (M4b) have the one seat `arc`. An arc role is in force (checked, smoked and hashed) only
// where it can run, the arc's `ArcScope` and arc-role set: `lens` and `checkpoint` in a holistic arc, `packReview` in a
// corpus arc only (lead ruling LR-0a-1), `flow` in every arc of the `m4b` role set, which 1.0.0-dev.8 records on every
// revision of an arc it started (`RoutingProvenance.arcRoles`). An arc 1.0.0-dev.7 started records none and keeps the
// dev.7 role set (no `flow`), so its routing revs are the ones dev.7 hashed (scaffolding: `arcRolesInForce`). So the flow
// seat is checked on a non-holistic arc too: an unsupported binding of its class refuses any start (DESIGN §10 M4b).
// dev.17: the `dev17` role set is `m4b` plus the unit role `scaffold` (`unitRolesInForce`), written on every revision of an arc
// dev.17 started; an adopted earlier arc keeps `m4b`, so its revs hash no scaffold seat.
// dev.13: the walk roles `walkthrough` and `polishJudge` are in force exactly while the plan revision has milestones
// (`RoutingStack.milestones`, `hasMilestones`), which only a holistic arc may have; an arc without milestones hashes,
// checks and smokes neither, so its routing revs are unchanged.
//
// `.roadmap/config.json` (committed, set once per repo):
//
//   { "routing": {
//       "profile": "default" | "claude-only",                      optional; the base profile
//       "seats": { "<planCheck|gate>": { "<low|med|high|escalation>": "<class>" },
//                  "build": { "<low|med|high>": "<build class>" } },  optional; any subset of seats
//       "classes": { "<efficient|frontier|summit|economy>":            optional; rebinds for this repo
//                      { "backend", "model", "effort" } } },
//     "chain": { "k": <positive> },                                  optional (M4a): unacked chained starts allowed
//     "flow": { "givens": [{ "lever": "<lever class>", "note" }] },   optional (M4b): repo givens, owner-committed
//     "walkthrough": { "mcp": { "<server>": {                        optional (dev.13): the walk sessions' MCP servers
//         "command", "args"?: [...], "env"?: { ... } } } },
//     "systemsMap": { "systems", "shared"?, "contracts"?, "docs"? } } optional (dev.17): src/input/systems.ts
//
//   `chain.k` (M4a, OR-Q19, K10) is asked once at bootstrap and committed by the owner; the root agent never writes it.
//   Absent: K unset (a chained start is refused `chain-invalid{k-unset}`).
//   `flow.givens` (M4b): what cannot be tuned in this repo, each a closed lever class (src/flow/types.ts `FLOW_LEVERS`)
//   and a note; code drops a flow proposal using a given's lever. The owner commits them; host givens live in the git
//   common dir (src/flow/givens.ts).
//   `walkthrough.mcp` (dev.13, D1): the MCP servers a walk session (and a build in a milestone with a `browser` journey)
//   gets, passed as `--mcp-config` with `--strict-mcp-config`, so it gets exactly these. `{evidence}` and `{viewport}` in
//   `args` and `env` values are substituted by code (`WALK_SUBSTITUTIONS`). Absent: no browser drive, so a `browser`
//   journey is refused at bootstrap (Phase-0 row `walk-tools-missing`).
//
//   Classes: `efficient | frontier | summit | economy`; economy is judgment-only, so a build seat naming it is refused,
//   in every layer. A seat value that is a triple is refused: triples are bound
//   only under `classes`, which is repo-level (a plan cannot rebind a class). A rebind is one triple for the class at
//   build and judgment seats alike; a Codex one refuses any judgment seat in force that names the class. A binding's effort is one its
//   model lists in models.ts: a Claude model low | medium | high | xhigh | max, a Codex model low | medium | high. Unknown
//   keys are refused. `{"routing": {"profile": "claude-only"}}` is the one config line that selects the
//   Claude-only profile. The profile is chosen by an explicit `start --profile`, else this file's
//   `profile`, else `default`.
import type { UnitId } from '../core/ids.ts';
import { type RoutingRev, routingRev } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { Fields, type Read, SchemaError, arrayOf, object, positive, str, stringMap } from '../core/validate.ts';
import { type RepoGiven, repoGiven } from '../flow/types.ts';
import { type SystemsMap, systemsMap } from '../input/systems.ts';
import { EARLIER_BUILTIN_SEATS, PRE_DEV17_BUILTIN_SEATS, dev7ArcRolesDefault, summitXhighTriple } from '../core/upgrade.ts';
import { type PlanM1, type PlanTargetKind, hasMilestones } from '../input/plan.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { support } from '../prompts/index.ts';
import { CLASS_CATALOGUE, boundAt } from './classes.ts';
import { BUILTIN_SEATS } from './profiles.ts';
import {
  type ArcRole, type ArcRoleSet, WALK_ROLES, type ClassBindings, type ClassSource, type ClassTable, MODEL_CLASSES, type ModelClass, type ProfileName, type Role,
  type RoutingLayer, type RoutingLayerName, type RoutingProvenance, type RoutingTable, SEAT_REFS, type SeatRef, type SeatTable, type Triple, UNIT_ROLES, type UnitRole, DEV17_ROLES, DEV17_UNIT_ROLES, atSeat,
  classBindings, profileName, routingLayer, seatTable,
} from './types.ts';

/**
 * One MCP server a walk session gets (dev.13, `walkthrough.mcp.<name>`): the stdio command Claude Code spawns, with
 * `{evidence}` and `{viewport}` in `args` and `env` values substituted by code. `args` absent: none; `env` absent: none.
 */
export type WalkMcpServer = Readonly<{ command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>;
/**
 * The placeholders code substitutes in a walk MCP server's `args` and `env` values: `{evidence}` the session's evidence dir
 * (absolute), `{viewport}` `WALK_VIEWPORT`. Nothing else is substituted.
 */
export const WALK_SUBSTITUTIONS = ['{evidence}', '{viewport}'] as const;
/** The pinned viewport a walk opens at (`WxH`, Playwright MCP's `--viewport-size` form); a narrow pass resizes in session. */
export const WALK_VIEWPORT = '1280x800';
/** An MCP server name: what Claude Code prefixes its tools with (`mcp__<name>__<tool>`). */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type RepoConfig = Readonly<{
  routing?: Readonly<{ profile?: ProfileName; seats?: RoutingLayer; classes?: ClassBindings }>;
  chain?: Readonly<{ k: number }>;
  flow?: Readonly<{ givens: readonly RepoGiven[] }>;
  /** dev.13: the walk sessions' MCP servers, by name (non-empty); absent: no browser drive. */
  walkthrough?: Readonly<{ mcp: Readonly<Record<string, WalkMcpServer>> }>;
  /** dev.17: the repo's systems map (src/input/systems.ts); absent: none (every lane selected everywhere, the whole tree its input). */
  systemsMap?: SystemsMap;
}>;

const walkMcpServer = object((f): WalkMcpServer => ({
  command: f.get('command', str),
  args: f.optional('args', arrayOf(str)) ?? [],
  env: f.optional('env', stringMap) ?? {},
}));

const walkMcp: Read<Readonly<Record<string, WalkMcpServer>>> = (value, path) => {
  const f = new Fields(value, path);
  const names = Object.keys(value as object);
  if (names.length === 0) throw new SchemaError(path, 'at least one MCP server', value);
  const out: Record<string, WalkMcpServer> = {};
  for (const name of names) {
    if (!MCP_SERVER_NAME.test(name)) throw new SchemaError(`${path}.${name}`, 'an MCP server name: letters, digits, _ and -, 1-64 chars', name);
    out[name] = f.get(name, walkMcpServer);
  }
  f.end();
  return out;
};

export const repoConfig = object((f): RepoConfig => {
  const chain = f.optional('chain', object((g) => ({ k: g.get('k', positive) })));
  const flow = f.optional('flow', object((g) => ({ givens: g.get('givens', arrayOf(repoGiven)) })));
  const walkthrough = f.optional('walkthrough', object((g) => ({ mcp: g.get('mcp', walkMcp) })));
  const systems = f.optional('systemsMap', systemsMap);
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
  return {
    ...(routing === undefined ? {} : { routing }), ...(chain === undefined ? {} : { chain }), ...(flow === undefined ? {} : { flow }),
    ...(walkthrough === undefined ? {} : { walkthrough }), ...(systems === undefined ? {} : { systemsMap: systems }),
  };
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
  /** The arc's role set (M4b): `m4b` puts `flow` in force; absent: the dev.7 role set (an adopted dev.7 arc, or a bare stack). */
  arcRoles?: ArcRoleSet;
  /** dev.13: the plan revision has milestones, so the walk roles are in force; absent: none (every arc before dev.13). */
  milestones?: true;
}>;

/**
 * Where the arc roles can run (G20, LR-0a-1): `none` outside a holistic arc, else the plan's target kind. A holistic
 * `architecture-doc` arc runs the M3 roles; a corpus arc (always holistic) runs every arc role; `flow` (M4b) runs in every
 * arc of the `m4b` role set (`arcRolesInForce`).
 */
export type ArcScope = 'none' | PlanTargetKind;
export const ARC_ROLES_IN_FORCE: { readonly [S in ArcScope]: readonly ArcRole[] } = {
  none: ['flow'], 'architecture-doc': ['lens', 'checkpoint', 'flow'], corpus: ['lens', 'checkpoint', 'packReview', 'flow'],
};

/**
 * The arc roles in force for a scope, role set and milestones: `ARC_ROLES_IN_FORCE`, without `flow` when the arc records no
 * role set (TEMPORARY SCAFFOLDING, SCHEMAS.md "M4b": the 1.0.0-dev.7 role set of an adopted dev.7 arc; delete with its
 * absence handling once no dev.7 arc is in flight), and (dev.13) the walk roles exactly when the plan has milestones. A
 * plan with milestones is holistic (Phase-0 `milestones-need-holistic`), so `none` never takes them.
 */
export function arcRolesInForce(arcScope: ArcScope, arcRoles: ArcRoleSet | null, milestones: boolean): readonly ArcRole[] {
  const roles = ARC_ROLES_IN_FORCE[arcScope];
  const scoped = arcRoles !== null ? roles : roles.filter((r) => r !== 'flow');
  if (milestones && arcScope === 'none') throw new Error('the walk roles in force outside a holistic arc (milestones need the holistic layer)');
  return milestones ? [...scoped, ...WALK_ROLES] : scoped;
}

/**
 * The unit roles in force (dev.17): the M1 unit roles, and the dev.17 unit roles (`scaffold`) in an arc of the `dev17` role
 * set only, so an adopted arc of an earlier release hashes and runs exactly the roles it did.
 */
export function unitRolesInForce(arcRoles: ArcRoleSet | null): readonly UnitRole[] {
  return arcRoles === 'dev17' ? [...UNIT_ROLES, ...DEV17_UNIT_ROLES] : UNIT_ROLES;
}

/** A plan's arc scope: `none` without `holistic`, else its target kind. */
export function arcScopeOf(plan: Pick<PlanM1, 'target' | 'holistic'>): ArcScope {
  return plan.holistic === undefined ? 'none' : plan.target;
}

/** The stack of a repo config and a plan layer, without a unit layer and without the arc seats (no scope, no role set). */
export function arcStack(profile: ProfileName, config: RepoConfig | null, plan: RoutingLayer | null): RoutingStack {
  return { profile, classes: config?.routing?.classes ?? null, repoConfig: config?.routing?.seats ?? null, plan, unit: null };
}

/** `stack` with the arc seats of `arcScope`, `arcRoles` and (dev.13) the plan's milestones in force. */
function scoped(stack: RoutingStack, arcScope: ArcScope, arcRoles: ArcRoleSet | null, milestones: boolean): RoutingStack {
  return { ...stack, ...(arcScope === 'none' ? {} : { arcScope }), ...(arcRoles === null ? {} : { arcRoles }), ...(milestones ? { milestones: true } : {}) };
}

/**
 * The arc's stack for a plan: its routing layer, and the arc seats its scope, the arc's role set and (dev.13) its
 * milestones put in force (G20).
 */
export function planStack(
  profile: ProfileName, config: RepoConfig | null, plan: Pick<PlanM1, 'routing' | 'target' | 'holistic' | 'milestones'>, arcRoles: ArcRoleSet | null,
): RoutingStack {
  return scoped(arcStack(profile, config, plan.routing ?? null), arcScopeOf(plan), arcRoles, hasMilestones(plan));
}

/**
 * The stack a plan revision's routing provenance records (H7), for the arc (`unit` null) or for one unit: the arc's
 * stack with that unit's own layer on top (`route`, `steer --class`), when it has one. Every routing in force is
 * resolved from this, so a live repo config is never re-read once a revision recorded what it resolved from; a unit
 * without a layer resolves exactly as the arc, so its routingRev is the arc's. `milestones` (dev.13): the revision's plan
 * has milestones (`hasMilestones`), which puts the walk roles in force.
 */
export function provenanceStack(p: RoutingProvenance, arcScope: ArcScope, unit: UnitId | null, milestones: boolean): RoutingStack {
  return scoped({
    profile: p.profile, classes: p.repoConfig.classes, repoConfig: p.repoConfig.seats, plan: p.planLayer, unit: unit === null ? null : p.unitLayers[unit] ?? null,
  }, arcScope, p.arcRoles ?? dev7ArcRolesDefault(), milestones);
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
  /** The stack's `arcScope`, role set and milestones: which arc seats are in force (`seatsInForce`). */
  arcScope: ArcScope;
  arcRoles: ArcRoleSet | null;
  milestones: boolean;
  /**
   * TEMPORARY SCAFFOLDING (BACKLOG "Scaffolding to delete"): the revs this same stack hashed under each earlier adopted
   * release's built-in seats and xhigh summit effort (`EARLIER_BUILTIN_SEATS`, `summitXhighTriple` in core/upgrade.ts),
   * which status aliases a recorded rev through.
   * Empty under any table but HEAD's.
   */
  earlierBuiltinRevs: readonly RoutingRev[];
  /**
   * TEMPORARY SCAFFOLDING: the one of `earlierBuiltinRevs` under `PRE_DEV17_BUILTIN_SEATS`, the only earlier table whose
   * build seats differ from HEAD's (dev.16 built high on frontier). A unit pinned under it is a dev.16 arc's, so dispatch
   * keeps its started implementer's seat (`repin`). Only this table: an owner edit of HEAD's seats can hash to an older
   * table's rev (HEAD with build.high on frontier is dev.9's table where no arc role is in force), never to this one
   * unless it restores dev.16's seats exactly. Null under any table but HEAD's.
   */
  preDev17Rev: RoutingRev | null;
}>;

const LAYERS = [['unit', 'unit'], ['plan', 'plan'], ['repo-config', 'repoConfig']] as const;

/**
 * Resolves every seat through the stack to a class, and every class to its binding in the class catalogue (OR-L3: no
 * routing generations, so every revision binds through `CLASS_CATALOGUE` and the built-in seats): a repo rebind at
 * every seat naming the class, else the catalogue's build triple at a build seat and its judgment triple at any other.
 */
export function resolveRouting(stack: RoutingStack): ResolvedRouting {
  const current = resolveRoutingUnder(BUILTIN_SEATS, stack);
  const earlier = EARLIER_BUILTIN_SEATS.map((seats) => resolveRoutingUnder(seats, stack));
  const xhigh = [current, ...earlier].map((r, i) => {
    const table = seatTable((s) => {
      const triple = atSeat(r.table, s);
      return atSeat(r.classes, s) === 'summit' && r.bindings.summit === 'builtin' ? summitXhighTriple(triple) : triple;
    });
    return routingRevOf(table, r.arcScope, r.arcRoles, r.milestones, i === 0);
  });
  return {
    ...current, earlierBuiltinRevs: [...new Set([...earlier.map((r) => r.rev), ...xhigh])].filter((rev) => rev !== current.rev),
    preDev17Rev: resolveRoutingUnder(PRE_DEV17_BUILTIN_SEATS, stack).rev,
  };
}

/**
 * `resolveRouting` with `builtin` as the lowest layer. Only `status` passes another table: the built-in seats an
 * earlier release hashed, to alias its recorded revs (`EARLIER_BUILTIN_SEATS`, src/core/upgrade.ts; scaffolding).
 */
export function resolveRoutingUnder(builtin: ClassTable, stack: RoutingStack): ResolvedRouting {
  const bound = (c: ModelClass, seat: SeatRef): Triple => stack.classes?.[c] ?? boundAt(stack.profile, c, seat.role);
  const named = (seat: SeatRef): readonly [ModelClass, RoutingLayerName] => {
    for (const [name, key] of LAYERS) {
      const c = (stack[key]?.[seat.role] as Readonly<Partial<Record<string, ModelClass>>> | undefined)?.[seat.tier];
      if (c !== undefined) return [c, name];
    }
    return [atSeat(builtin, seat), 'builtin'];
  };
  // Every layer and the built-in table name a build class at a build seat (`ClassOf`), so the merged table does too.
  const classes = seatTable((s) => named(s)[0]) as ClassTable;
  const table = seatTable((s) => bound(atSeat(classes, s), s));
  const bindings = Object.fromEntries(MODEL_CLASSES.map((c) => [c, stack.classes?.[c] === undefined ? 'builtin' : 'repo-config'])) as ResolvedRouting['bindings'];
  const arcScope = stack.arcScope ?? 'none';
  const arcRoles = stack.arcRoles ?? null;
  const milestones = stack.milestones === true;
  return {
    table, classes, sources: seatTable((s) => named(s)[1]), bindings, rev: routingRevOf(table, arcScope, arcRoles, milestones, builtin === BUILTIN_SEATS), arcScope, arcRoles, milestones,
    earlierBuiltinRevs: [], preDev17Rev: null,
  };
}

/**
 * First 16 hex of sha256 over the canonical JSON of the resolved table's roles in force: the unit roles and the arc
 * roles of `arcScope` and `arcRoles` (`arcRolesInForce`). Without a role set (an adopted 1.0.0-dev.7 arc) a
 * non-holistic arc hashes the M2 table and a holistic `architecture-doc` arc the 1.0.0-dev.6 role set (no
 * `packReview`), so dev.7's revs are unchanged; an `m4b` arc's revs include `flow`, and (dev.13) only a plan with
 * milestones hashes the walk roles, so an arc without them keeps its revs. `head` false (an earlier release's built-in seats,
 * which only `status` resolves under to alias recorded revs): without the roles that release never had (`DEV17_ROLES`).
 */
export function routingRevOf(table: RoutingTable, arcScope: ArcScope, arcRoles: ArcRoleSet | null, milestones: boolean, head = true): RoutingRev {
  const inForce = unitRolesInForce(arcRoles);
  const unitRoles: readonly Role[] = head ? inForce : inForce.filter((r) => !(DEV17_ROLES as readonly Role[]).includes(r));
  const roles: readonly Role[] = [...unitRoles, ...arcRolesInForce(arcScope, arcRoles, milestones)];
  return routingRev(sha256Hex(canonicalJson(Object.fromEntries(roles.map((r) => [r, table[r]])))).slice(0, 16));
}

/** The seats in force (G20, LR-0a-1): the unit roles' of the role set (`unitRolesInForce`) and the arc roles' of the resolved scope and role set. */
export function seatsInForce(resolved: ResolvedRouting): readonly SeatRef[] {
  const roles: readonly Role[] = [...unitRolesInForce(resolved.arcRoles), ...arcRolesInForce(resolved.arcScope, resolved.arcRoles, resolved.milestones)];
  return SEAT_REFS.filter((s) => roles.includes(s.role));
}

/**
 * The startup row for routing: every seat in force (`seatsInForce`: the arc seats of its scope only, G20)
 * whose bound model has no usable prompt. A Codex model at a judgment seat (only a repo's Codex rebind of a class a
 * judgment seat names puts one there) is `codex-judgment`; any other unsupported pair is `no-prompt`. Names the seat, the layer that chose its class and the class, never the model.
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
