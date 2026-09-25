// Routing vocabulary. Model ids live only here and in routing configuration (profiles,
// `.roadmap/config.json`, `plan.routing`, per-unit route layers); executor-written records name a Role
// and a RoutingRev instead. Profiles, layering and prompt modules are step 5.
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

export const RISK_TIERS = ['low', 'med', 'high'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const PROFILES = ['default', 'claude-only'] as const;
export type ProfileName = (typeof PROFILES)[number];

export type RoutingTable = { readonly [R in Role]: { readonly [T in RiskTier]: Triple } };
/** One layer of the routing stack: any subset of seats. */
export type RoutingLayer = { readonly [R in Role]?: { readonly [T in RiskTier]?: Triple } };
/** Where a seat's triple came from, lowest to highest precedence. */
export type RoutingLayerName = 'builtin' | 'repo-config' | 'plan' | 'unit';

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

export const routingLayer: Read<RoutingLayer> = object((f) => {
  const out: { [R in Role]?: { [T in RiskTier]?: Triple } } = {};
  for (const r of ROLES) {
    const seats = f.optional(r, object((g) => {
      const tiers: { [T in RiskTier]?: Triple } = {};
      for (const t of RISK_TIERS) {
        const tr = g.optional(t, triple);
        if (tr !== undefined) tiers[t] = tr;
      }
      return tiers;
    }));
    if (seats !== undefined) {
      if (Object.keys(seats).length === 0) throw new SchemaError(`${f.path}.${r}`, 'at least one tier', seats);
      out[r] = seats;
    }
  }
  return out;
});
