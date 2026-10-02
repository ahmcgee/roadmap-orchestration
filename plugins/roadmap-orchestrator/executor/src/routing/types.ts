// Routing vocabulary. Every routing layer names a model CLASS per seat; a class binds a full triple in one
// place, the class catalogue (classes.ts), which `.roadmap/config.json` may rebind per repo. Model ids live
// only in the model and class catalogues, a repo's class rebinds and launch argv; executor-written records
// name a role, a seat and a RoutingRev instead.
import { type UnitId, unitId } from '../core/ids.ts';
import { Fields, type Read, SchemaError, literal, nullable, object, oneOf } from '../core/validate.ts';
import { effortSupported, modelInfo } from './models.ts';

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'] as const;
export const CODEX_MODELS = ['gpt-5.6-luna', 'gpt-5.6-sol'] as const;
export const MODEL_IDS = [...CLAUDE_MODELS, ...CODEX_MODELS] as const;

export type ClaudeModelId = (typeof CLAUDE_MODELS)[number];
export type CodexModelId = (typeof CODEX_MODELS)[number];
/** Closed: adding a model fails compilation until every role's PROMPTS row names it. */
export type ModelId = ClaudeModelId | CodexModelId;

export const BACKENDS = ['claude', 'codex'] as const;
export type Backend = (typeof BACKENDS)[number];

export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];
/** `claude --effort <level>` (Claude Code 2.1.283); models.ts lists which a model takes. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export type Effort = CodexEffort | ClaudeEffort;

/** A Claude triple with a Codex effort, or a model on the other backend, is unrepresentable. */
export type Triple =
  | { readonly backend: 'claude'; readonly model: ClaudeModelId; readonly effort: ClaudeEffort }
  | { readonly backend: 'codex'; readonly model: CodexModelId; readonly effort: CodexEffort };

/**
 * `lens` and `checkpoint` (M3) are the arc roles: judgment roles that run for the arc, not for a unit, on the one
 * seat `arc`. They come last, so every earlier role keeps its place in seat order.
 */
export const ROLES = ['planCheck', 'build', 'gate', 'lens', 'checkpoint'] as const;
export type Role = (typeof ROLES)[number];
/** The unit pipeline's roles (M1). */
export const UNIT_ROLES = ['planCheck', 'build', 'gate'] as const satisfies readonly Role[];
export type UnitRole = (typeof UNIT_ROLES)[number];
export const ARC_ROLES = ['lens', 'checkpoint'] as const satisfies readonly Role[];
export type ArcRole = (typeof ARC_ROLES)[number];
/** The judgment roles of a unit's pipeline. The arc roles judge too (a fresh read-only session): `SessionRole`. */
export type JudgmentRole = 'planCheck' | 'gate';
export type ImplementerRole = 'build';
/** Every role that runs a fresh read-only session on the judgment profile: the unit judgments and the arc roles. */
export type FreshRole = JudgmentRole | ArcRole;

/** A unit's risk. Never `escalation`: that seat is a judgment role's route-up target, not a risk. */
export const RISK_TIERS = ['low', 'med', 'high'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** A unit judgment role's seats: the three risk tiers and `escalation`, where route-ups and risk triggers go. */
export const JUDGMENT_SEATS = [...RISK_TIERS, 'escalation'] as const;
export type JudgmentSeat = (typeof JUDGMENT_SEATS)[number];
/** An arc role's one seat (M3): lens → frontier, checkpoint → summit in the built-in table. */
export const ARC_SEATS = ['arc'] as const;
export type ArcSeat = (typeof ARC_SEATS)[number];
/** Any role's seat name; `SeatRef` pairs one with a role that has it. */
export type Seat = JudgmentSeat | ArcSeat;
/** Build has the three risk seats; each unit judgment role has four; each arc role has `arc`. */
export type SeatOf<R extends Role> = R extends ArcRole ? ArcSeat : R extends JudgmentRole ? JudgmentSeat : RiskTier;
export const SEATS: { readonly [R in Role]: readonly SeatOf<R>[] } = {
  planCheck: JUDGMENT_SEATS, build: RISK_TIERS, gate: JUDGMENT_SEATS, lens: ARC_SEATS, checkpoint: ARC_SEATS,
};
/** One seat of the table, `role.tier`: `build.escalation` is unrepresentable. */
export type SeatRef = { [R in Role]: Readonly<{ role: R; tier: SeatOf<R> }> }[Role];
/** A seat of a unit role: what a unit's backend call and its usage name. */
export type UnitSeatRef = Extract<SeatRef, Readonly<{ role: UnitRole }>>;
/** An arc role's seat (`lens.arc`, `checkpoint.arc`): what a job's backend call and its usage name (M3). */
export type ArcSeatRef = Extract<SeatRef, Readonly<{ role: ArcRole }>>;
/** Every seat, role by role in `ROLES` order, each role's tiers in seat order. */
export const SEAT_REFS: readonly SeatRef[] = ROLES.flatMap((r) => SEATS[r].map((tier) => ({ role: r, tier }) as SeatRef));

/**
 * What a routing layer names at a seat. The class catalogue (classes.ts) binds each class to a triple; a
 * repo may rebind one in `.roadmap/config.json`. `efficient`: the cheap implementer; `frontier`: the strong
 * default; `summit`: the escalation.
 */
export const MODEL_CLASSES = ['efficient', 'frontier', 'summit'] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];
/** Where a class's binding came from. */
export type ClassSource = 'builtin' | 'repo-config';

export const PROFILES = ['default', 'claude-only'] as const;
export type ProfileName = (typeof PROFILES)[number];

/** A value per seat: every role's own seats and no others. */
export type SeatTable<V> = { readonly [R in Role]: { readonly [S in SeatOf<R>]: V } };
/** The resolved triples: the table `routingRev` hashes. */
export type RoutingTable = SeatTable<Triple>;
/** The built-in seats, or a resolved stack before binding: the class at every seat. */
export type ClassTable = SeatTable<ModelClass>;
/** One layer of the routing stack: a class at any subset of seats. */
export type RoutingLayer = { readonly [R in Role]?: { readonly [S in SeatOf<R>]?: ModelClass } };
/** A repo's class rebinds: any subset of classes, each bound to a triple. */
export type ClassBindings = { readonly [C in ModelClass]?: Triple };
/** Where a seat's class came from, lowest to highest precedence. */
export type RoutingLayerName = 'builtin' | 'repo-config' | 'plan' | 'unit';

/** `role.tier` as a seat; a tier the role does not have (`build.escalation`) is a bug. */
export function seatRef(r: Role, tier: Seat): SeatRef {
  if (!(SEATS[r] as readonly Seat[]).includes(tier)) throw new Error(`the ${r} role has no ${tier} seat`);
  return { role: r, tier } as SeatRef;
}

/** A unit role's seat, from its role and tier (a tier the role does not have is a bug). */
export function unitSeatRef(r: UnitRole, tier: Seat): UnitSeatRef {
  return seatRef(r, tier) as UnitSeatRef;
}

/** The value at `seat` of a per-seat table. */
export function atSeat<V>(table: SeatTable<V>, seat: SeatRef): V {
  return (table[seat.role] as Readonly<Record<Seat, V>>)[seat.tier];
}

/** The per-seat table whose value at each seat is `of(seat)`. */
export function seatTable<V>(of: (seat: SeatRef) => V): SeatTable<V> {
  const out: Partial<Record<Role, Partial<Record<Seat, V>>>> = {};
  for (const seat of SEAT_REFS) (out[seat.role] ??= {})[seat.tier] = of(seat);
  return out as SeatTable<V>;
}

/**
 * Per (role, model): a prompt module, a reviewed reuse of another model's prompt, or unsupported.
 * `P` is the prompt module type step 5 defines.
 */
export type PromptSupport<P> =
  | { readonly type: 'prompt'; readonly prompt: P }
  | { readonly type: 'inherits'; readonly from: ModelId; readonly reviewed: string }
  | { readonly type: 'unsupported'; readonly reason: string };

/** `P` maps each role to its prompt module type, so a module's inputs are typed by its role. */
export type PromptTable<P extends { readonly [R in Role]: unknown }> = {
  readonly [R in Role]: { readonly [M in ModelId]: PromptSupport<P[R]> };
};

export const role: Read<Role> = oneOf(ROLES);
export const riskTier: Read<RiskTier> = oneOf(RISK_TIERS);
export const backend: Read<Backend> = oneOf(BACKENDS);
export const profileName: Read<ProfileName> = oneOf(PROFILES);
export const modelId: Read<ModelId> = oneOf(MODEL_IDS);
export const modelClass: Read<ModelClass> = oneOf(MODEL_CLASSES);

/** Reads a record's `role` and `tier` fields as one seat: a tier the role does not have is refused. */
export function seatFields(f: Fields): SeatRef {
  const r = f.get('role', role);
  return { role: r, tier: f.get('tier', oneOf(SEATS[r] as readonly Seat[])) } as SeatRef;
}

/** `seatFields` limited to the unit roles: a unit's call never sits on an arc seat. */
export function unitSeatFields(f: Fields): UnitSeatRef {
  const r = f.get('role', oneOf(UNIT_ROLES));
  return { role: r, tier: f.get('tier', oneOf(SEATS[r] as readonly Seat[])) } as UnitSeatRef;
}

/** `seatFields` limited to the arc roles (M3): a job's call sits only on `lens.arc` or `checkpoint.arc`. */
export function arcSeatFields(f: Fields): ArcSeatRef {
  return { role: f.get('role', oneOf(ARC_ROLES)), tier: f.get('tier', oneOf(ARC_SEATS)) };
}

export const triple: Read<Triple> = (value, path) => {
  const b = new Fields(value, path).get('backend', backend);
  if (b === 'claude') {
    return object((f): Triple => ({
      backend: f.get('backend', literal('claude')),
      model: f.get('model', oneOf(CLAUDE_MODELS)),
      effort: f.get('effort', oneOf(CLAUDE_EFFORTS)),
    }))(value, path);
  }
  return object((f): Triple => ({
    backend: f.get('backend', literal('codex')),
    model: f.get('model', oneOf(CODEX_MODELS)),
    effort: f.get('effort', oneOf(CODEX_EFFORTS)),
  }))(value, path);
};

/** A seat's value in a routing layer: a class name. A triple there is refused (hard cutover to classes). */
const seatClass: Read<ModelClass> = (value, path) => {
  if (typeof value === 'object' && value !== null) {
    throw new SchemaError(path, `a model class (${MODEL_CLASSES.join(' | ')}); triples are bound only in config.routing.classes`, value);
  }
  return modelClass(value, path);
};

export const routingLayer: Read<RoutingLayer> = object((f) => {
  const out: Partial<Record<Role, Partial<Record<Seat, ModelClass>>>> = {};
  for (const r of ROLES) {
    const seats = f.optional(r, object((g) => {
      const named: Partial<Record<Seat, ModelClass>> = {};
      for (const t of SEATS[r]) {
        const c = g.optional(t, seatClass);
        if (c !== undefined) named[t] = c;
      }
      return named;
    }));
    if (seats !== undefined) {
      if (Object.keys(seats).length === 0) throw new SchemaError(`${f.path}.${r}`, 'at least one seat', seats);
      out[r] = seats;
    }
  }
  return out as RoutingLayer;
});

/** A class rebind: a triple whose effort the model catalogue lists for its model. */
const binding: Read<Triple> = (value, path) => {
  const t = triple(value, path);
  if (!effortSupported(t)) throw new SchemaError(`${path}.effort`, `one of ${modelInfo(t.model).efforts.join(' | ')}`, t.effort);
  return t;
};

/** A repo's `routing.classes`: a triple for any subset of classes. */
export const classBindings: Read<ClassBindings> = object((f) => {
  const out: Partial<Record<ModelClass, Triple>> = {};
  for (const c of MODEL_CLASSES) {
    const t = f.optional(c, binding);
    if (t !== undefined) out[c] = t;
  }
  return out;
});

/**
 * Everything a routing revision was resolved from (M3, G16, H7), recorded on every `plan-applied` since
 * 1.0.0-dev.6 so the tables behind a `routingRev` are rebuilt from the log alone, never from a live config:
 * the profile, the repo config's seats and class rebinds in force, the plan's layer and each unit's layer
 * (`route`, `steer --class`; ascending by unit, only units that have one).
 */
export type RoutingProvenance = Readonly<{
  profile: ProfileName;
  repoConfig: Readonly<{ seats: RoutingLayer | null; classes: ClassBindings | null }>;
  planLayer: RoutingLayer | null;
  unitLayers: Readonly<Record<UnitId, RoutingLayer>>;
}>;

const unitLayers: Read<Readonly<Record<UnitId, RoutingLayer>>> = (value, path) => {
  const f = new Fields(value, path);
  const keys = Object.keys(value as object);
  for (let i = 1; i < keys.length; i++) if (!((keys[i - 1] as string) < (keys[i] as string))) throw new SchemaError(path, 'units ascending', keys);
  const out: Record<UnitId, RoutingLayer> = {};
  for (const key of keys) out[unitId(key, `${path}.${key}`)] = f.get(key, routingLayer);
  f.end();
  return out;
};

export const routingProvenance: Read<RoutingProvenance> = object((f) => ({
  profile: f.get('profile', profileName),
  repoConfig: f.get('repoConfig', object((g) => ({ seats: g.get('seats', nullable(routingLayer)), classes: g.get('classes', nullable(classBindings)) }))),
  planLayer: f.get('planLayer', nullable(routingLayer)),
  unitLayers: f.get('unitLayers', unitLayers),
}));
