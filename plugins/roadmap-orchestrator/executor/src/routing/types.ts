// Routing vocabulary. Every routing layer names a model CLASS per seat; a class binds a full triple in one
// place, the class catalogue (classes.ts), which `.roadmap/config.json` may rebind per repo. Model ids live
// only in the model and class catalogues, a repo's class rebinds and launch argv; executor-written records
// name a role, a seat and a RoutingRev instead.
import { Fields, type Read, SchemaError, literal, object, oneOf } from '../core/validate.ts';

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-fable-5-1'] as const;
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
/** Claude takes no effort flag; its triples carry the literal 'default'. */
export type Effort = CodexEffort | 'default';

/** A Claude triple with a Codex effort, or a model on the other backend, is unrepresentable. */
export type Triple =
  | { readonly backend: 'claude'; readonly model: ClaudeModelId; readonly effort: 'default' }
  | { readonly backend: 'codex'; readonly model: CodexModelId; readonly effort: CodexEffort };

export const ROLES = ['planCheck', 'build', 'gate'] as const;
export type Role = (typeof ROLES)[number];
export type JudgmentRole = 'planCheck' | 'gate';
export type ImplementerRole = 'build';

/** A unit's risk. Never `escalation`: that seat is a judgment role's route-up target, not a risk. */
export const RISK_TIERS = ['low', 'med', 'high'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** A judgment role's seats: the three risk tiers and `escalation`, where route-ups and risk triggers go. */
export const JUDGMENT_SEATS = [...RISK_TIERS, 'escalation'] as const;
export type JudgmentSeat = (typeof JUDGMENT_SEATS)[number];
/** Any role's seat name; `SeatRef` pairs one with a role that has it. */
export type Seat = JudgmentSeat;
/** Build has the three risk seats; each judgment role has four. */
export type SeatOf<R extends Role> = R extends JudgmentRole ? JudgmentSeat : RiskTier;
export const SEATS: { readonly [R in Role]: readonly SeatOf<R>[] } = { planCheck: JUDGMENT_SEATS, build: RISK_TIERS, gate: JUDGMENT_SEATS };
/** One seat of the table, `role.tier`: `build.escalation` is unrepresentable. */
export type SeatRef = { [R in Role]: Readonly<{ role: R; tier: SeatOf<R> }> }[Role];
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
/** A built-in profile, or a resolved stack before binding: the class at every seat. */
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

export const triple: Read<Triple> = (value, path) => {
  const b = new Fields(value, path).get('backend', backend);
  if (b === 'claude') {
    return object((f): Triple => ({
      backend: f.get('backend', literal('claude')),
      model: f.get('model', oneOf(CLAUDE_MODELS)),
      effort: f.get('effort', oneOf(['default'] as const)),
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
