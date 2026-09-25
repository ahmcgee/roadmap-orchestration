// What each role's prompt is rendered from, and the deterministic text helpers the modules share.
// Inputs are snapshotted by revision at dispatch (DESIGN-1.0.md §2.3), so a prompt is a pure function of
// them: no dates, no random ids, no reads of the filesystem or the environment.
//
// The required input set per role (ROLE_INPUTS) comes from DESIGN-1.0.md §2.1 and §4 "Gate inputs"
// and the M1 plan's gate inputs (R2). Every prompt module must interpolate exactly these fields; the
// test `prompts.fields==required` holds each module to it.
import { createHash } from 'node:crypto';
import type { LaneId, RulingId, Sha, SpecRev, UnitId } from '../core/ids.ts';
import type { JsonValue } from '../core/json.ts';
import type { CommandVerdict, LaneDef } from '../core/records.ts';
import type { AbsPath, RepoPath, RepoPattern } from '../core/values.ts';
import type { RiskTier, Role } from '../routing/types.ts';

/** The spec as the one text every role reads: the executor's Markdown rendering of spec.json at `rev`. */
export type RenderedSpec = Readonly<{ unit: UnitId; rev: SpecRev; markdown: string }>;
/** A product-tree document (a cited contract, the architecture doc) at the dispatched revision. */
export type DocText = Readonly<{ path: RepoPath; text: string }>;
/** One cited C-nn ruling, verbatim from the ledger. */
export type RulingText = Readonly<{ id: RulingId; text: string }>;
/** Implementers get fast lanes only; estate lanes are executor-only (dispatch refuses otherwise). */
export type FastLane = LaneDef & Readonly<{ tier: 'fast' }>;

/** A fix round resumes the build session with what failed. `directives` are the gate's (or, for a
 * conflict or scope-growth round, the executor's) instructions; either list may be empty, not both. */
export type FixRound = Readonly<{ failingEvidenceDirs: readonly AbsPath[]; directives: readonly string[] }>;

/** One executor-run lane at the diff head: the ledger the gate reads. */
export type LaneLedgerEntry = Readonly<{
  lane: LaneId;
  argv: readonly string[];
  expectedExit: number;
  exitCode: number | null;
  verdict: CommandVerdict;
  evidenceDir: AbsPath;
}>;

export type PlanCheckInputs = Readonly<{
  spec: RenderedSpec;
  contracts: readonly DocText[];
  rulings: readonly RulingText[];
  architectureDoc: DocText;
  direction: string;
  /** The scope envelope pinned for the unit. */
  scope: readonly RepoPattern[];
  /** The Phase-0 risk floor. */
  risk: RiskTier;
}>;

export type BuildInputs = Readonly<{
  spec: RenderedSpec;
  contracts: readonly DocText[];
  rulings: readonly RulingText[];
  fastLanes: readonly FastLane[];
  /** Where the implementer writes decisions.json; outside the worktree, snapshotted by the executor. */
  evidenceDir: AbsPath;
  worktree: AbsPath;
  scope: readonly RepoPattern[];
  fixRound: FixRound | null;
}>;

export type GateInputs = Readonly<{
  spec: RenderedSpec;
  contracts: readonly DocText[];
  rulings: readonly RulingText[];
  architectureDoc: DocText;
  direction: string;
  /** `merge-base(T, branch)..head`, recomputed after any merge-in. */
  diff: Readonly<{ base: Sha; head: Sha; text: string }>;
  laneLedger: readonly LaneLedgerEntry[];
  /** Evidence directories the gate may read (lane output, the build's decisions.json). */
  evidence: readonly AbsPath[];
  /** The pinned envelope, and the diff's paths outside it. */
  scope: Readonly<{ patterns: readonly RepoPattern[]; growth: readonly RepoPath[] }>;
  /** Later gate rounds re-check their own prior directives only (§3, sf16); null on the first round. */
  priorRound: Readonly<{ directives: readonly string[] }> | null;
}>;

export type RoleInputs = { readonly planCheck: PlanCheckInputs; readonly build: BuildInputs; readonly gate: GateInputs };

export const ROLE_INPUTS = {
  planCheck: ['spec', 'contracts', 'rulings', 'architectureDoc', 'direction', 'scope', 'risk'],
  build: ['spec', 'contracts', 'rulings', 'fastLanes', 'evidenceDir', 'worktree', 'scope', 'fixRound'],
  gate: ['spec', 'contracts', 'rulings', 'architectureDoc', 'direction', 'diff', 'laneLedger', 'evidence', 'scope', 'priorRound'],
} as const satisfies { readonly [R in Role]: readonly (keyof RoleInputs[R])[] };

// Compile-time half of `prompts.fields==required`: ROLE_INPUTS names every key of each role's inputs.
type Missing<R extends Role> = Exclude<keyof RoleInputs[R], (typeof ROLE_INPUTS)[R][number]>;
const ROLE_INPUTS_COMPLETE: { readonly [R in Role]: [Missing<R>] extends [never] ? true : Missing<R> } = {
  planCheck: true,
  build: true,
  gate: true,
};
void ROLE_INPUTS_COMPLETE;

export type RoleField<R extends Role> = (typeof ROLE_INPUTS)[R][number];

/**
 * One prompt, written for one (role, model). `system` is the standing instruction set; `render` the
 * per-invocation message; `schema` the strict output schema; `fields` the inputs `render` interpolates.
 */
export type PromptModule<R extends Role> = Readonly<{
  system: string;
  render: (inputs: RoleInputs[R]) => string;
  schema: JsonValue;
  fields: readonly RoleField<R>[];
}>;
export type PromptModules = { readonly [R in Role]: PromptModule<R> };

// ---------------------------------------------------------------------------------------------------
// Text helpers. Pure and deterministic.

/** POSIX single-quoting, so a lane's argv renders as one command a shell runs verbatim. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The exact command line for a lane: its cwd under the worktree, its declared env, its argv. */
export function laneCommand(worktree: AbsPath, lane: LaneDef): string {
  const dir = lane.cwd === '.' ? worktree : `${worktree}/${lane.cwd}`;
  const env = Object.keys(lane.env.set).sort().map((k) => `${k}=${shellQuote(lane.env.set[k] ?? '')}`);
  return [`cd ${shellQuote(dir)} &&`, ...(env.length > 0 ? ['env', ...env] : []), ...lane.argv.map(shellQuote)].join(' ');
}

/**
 * Marks text another model wrote (a diff) so a judge reads it as data. The id is a content hash rather
 * than random, so rendering stays deterministic; a closing tag inside the text is defanged first, so
 * the text cannot end its own block.
 */
export function pasted(label: string, body: string): string {
  const id = createHash('sha256').update(`${label}\0${body}`).digest('hex').slice(0, 8);
  const safe = body.replace(/<(\/?)pasted_content/gi, '‹$1pasted_content');
  return `<pasted_content id="${id}">\n${safe}\n</pasted_content id="${id}">`;
}

/** Claude long-context form: each document in its own indexed block with its source. */
export function documentsXml(docs: readonly Readonly<{ source: string; content: string }>[]): string {
  const body = docs.map((d, i) =>
    `<document index="${i + 1}">\n<source>${d.source}</source>\n<document_content>\n${d.content}\n</document_content>\n</document>`);
  return `<documents>\n${body.join('\n')}\n</documents>`;
}

export function rulingsText(rulings: readonly RulingText[]): string {
  return rulings.length === 0 ? '(none cited)' : rulings.map((r) => `${r.id}: ${r.text}`).join('\n');
}

export function bullets(items: readonly string[], empty: string): string {
  return items.length === 0 ? empty : items.map((i) => `- ${i}`).join('\n');
}

/** The implementer's lane list: one exact command per lane, with its expected exit. */
export function fastLanesText(worktree: AbsPath, lanes: readonly FastLane[]): string {
  if (lanes.length === 0) return '(no fast lanes)';
  return lanes.map((l) => {
    const pass = l.env.pass.length === 0 ? '' : `; needs ${l.env.pass.join(', ')} from the environment`;
    return `- ${l.id} (expects exit ${l.expectedExit}${pass}):\n  ${laneCommand(worktree, l)}`;
  }).join('\n');
}

export function laneLedgerText(ledger: readonly LaneLedgerEntry[]): string {
  if (ledger.length === 0) return '(no lanes ran)';
  return ledger.map((l) =>
    `- ${l.lane}: ${l.verdict}, exit ${l.exitCode ?? 'none'} (expected ${l.expectedExit}); argv ${JSON.stringify(l.argv)}; evidence ${l.evidenceDir}`,
  ).join('\n');
}
