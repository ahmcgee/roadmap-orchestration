// The docs-only claim at the lanes stage (dev.17, proportional review; DESIGN-1.0.md §4 "Proportional review").
//
// A build answers `docsOnlySince`: the tested SHA since which it says it changed only comments and documentation, or null.
// The claim alone carries nothing over. Code takes the unit's last certified tree (the salvage SHA of its latest lanes
// attempt that ended green) and refuses a claim naming any other. It then reads the diff from that tree to the salvage SHA:
// a docs-class file (the systems map's `docs`) passes, and so does a hunk of a file changed on both sides whose every
// changed line is blank or a whole-line comment by a lexer pass over the whole file at that side (src/pipeline/comments.ts
// `lineKinds`: TypeScript, JavaScript, Go and Python; a line inside a multi-line string, template literal or raw string is
// none, and a Go example's `// Output:` block is none), at least one of them a comment, none a comment a tool may read
// (`TOOL_READ`), with no line matching a tool directive (`DIRECTIVES`) or inside a `/*!` block (`inPreservedBlock`): either
// refuses the claim outright, and so does a changed line of a JSON file that opens with a quote (a key or a value, never a
// comment: a `"//"` key is data). Code clears
// only what it is certain of: a file whose language has no lexer (configuration files among them: YAML, TOML, INI, JSON5),
// a file the lexer cannot read with certainty, and an added or deleted file leave their hunks to the verifier. A mode
// change, a binary file or a submodule refuses the claim. Every hunk
// left goes to the verifier (economy, Haiku 5.5 at high; prompts/verifier), one fresh call with a closed per-hunk answer
// {kind, executable, toolDirective, behaviourChange}; code accepts only when every hunk is answered once and clear
// (`hunkClear`). Accepted, each lane of the stage that does not declare `readsComments` reuses its pass on the certified
// tree (`runLaneSeries` `carry`); refused, or with no answer, the lanes run as normal, uncharged. Either way a claim is
// recorded (`docs-only`). A later candidate that finds a carried lane red records the miss as calibration
// (`docs-only-miss`, src/pipeline/integrate.ts).
import { freshJudgmentSession } from '../backends/argv.ts';
import type { LaneId, Sha, UnitId } from '../core/ids.ts';
import type { LaneDef } from '../core/records.ts';
import { repoPath } from '../core/values.ts';
import { git } from '../git/git.ts';
import { pathClass } from '../input/systems.ts';
import { type LineKind, languageOf, lineKinds } from './comments.ts';
import type { PlanUnit } from '../input/plan.ts';
import { renderPrompt, promptFor } from '../prompts/index.ts';
import type { VerifierHunk } from '../prompts/inputs.ts';
import { hunkClear, validateBuildOutput, validateVerifierOutput, verifierSchemaFor } from '../prompts/schemas.ts';
import { type StageContext, type StageParent, callBackend, dispatchOf, judgmentDeadlineMs, verificationWorktree, verifierDispatch } from './dispatch.ts';
import { type Reusable, laneNow, mapInForce, reusablePass } from './lanes.ts';
import { inMs, judgedAnswer, judgmentOutput } from './stages.ts';

/**
 * Comments a tool reads as an instruction: lint and type-checker suppressions, coverage and formatter pragmas, shebangs,
 * encoding lines, build constraints, generated-code markers, license identifiers. A changed line matching one refuses the
 * claim (the verifier would flag it as a tool directive anyway).
 */
export const DIRECTIVES: readonly RegExp[] = [
  /^#!/, /eslint-(disable|enable|env)|\/\*\s*(global|exported)\s/i, /@ts-(ignore|expect-error|nocheck|check)/, /^\/\/\/\s*<reference/, /@jsx|@flow\b/,
  /\bnoqa\b/i, /type:\s*ignore/, /\bpragma\b/i, /pylint:|mypy:|pyright:|isort:|fmt:\s*(off|on|skip)|\bnosec\b/i, /-\*-.*coding|^#.*coding[:=]/,
  /^\/\/go:|^\/\/\s*\+build|\bnolint\b/i, /prettier-ignore|biome-ignore|deno-lint-ignore|dprint-ignore/, /(istanbul|c8|v8)\s+ignore/, /rubocop:|frozen_string_literal/,
  /SPDX-License-Identifier|@license|@preserve/, /sourceMappingURL|webpackChunkName|@vite-ignore/, /NOLINT|clang-format|swiftlint:|ktlint/, /@generated|DO NOT EDIT/i,
  /#\s*(region|endregion)\b/, /shellcheck\s/, /^\/\/(export|line|extern)\s/, /@(jest|vitest)-environment/,
];

/** One hunk of `git diff -U0`: its text (header included) and its changed lines, each with its side and line number there. */
type Hunk = Readonly<{ text: string; lines: readonly Readonly<{ side: 'before' | 'after'; line: number; text: string }>[] }>;

function hunksOf(diff: string): readonly Hunk[] {
  const out: { text: string[]; lines: { side: 'before' | 'after'; line: number; text: string }[]; next: { before: number; after: number } }[] = [];
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header !== null) out.push({ text: [line], lines: [], next: { before: Number(header[1]), after: Number(header[2]) } });
    else if (out.length > 0 && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      const h = out.at(-1)!;
      const side = line.startsWith('-') ? 'before' : 'after';
      h.text.push(line);
      h.lines.push({ side, line: h.next[side]++, text: line.slice(1) });
    }
  }
  return out.map((h) => ({ text: h.text.join('\n'), lines: h.lines }));
}

/**
 * Comments a tool may read that no directive pattern names: triple-slash and `//!` doc comments (a Rust doctest, a
 * TypeScript triple-slash line), `@` tags (docblock pragmas). Never cleared by code: a hunk holding one asks the verifier.
 */
const TOOL_READ: readonly RegExp[] = [/^\/\/[/!]/, /^(\/\/|#)\s*@/];

/** What code alone makes of a file's diff: a directive (the hunk's header), or the hunks it leaves to the verifier. */
export type CodeReading = Readonly<{ kind: 'refused'; reason: string }> | Readonly<{ kind: 'read'; left: readonly string[] }>;

/**
 * Whether line `n` (1-based) of `lines` lies inside a `/*!` block: a comment minifiers and bundlers keep in their output
 * (a legal header). A text scan, not a lexer pass: it only ever refuses, never clears.
 */
function inPreservedBlock(lines: readonly string[], n: number): boolean {
  for (let i = n - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t.startsWith('/*!')) return i === n - 1 || !t.includes('*/');
    if (i !== n - 1 && t.includes('*/')) return false;
  }
  return false;
}

/**
 * Code's reading of the `-U0` diff of `path` from `before` to `after` (the whole file at each side; null where it does not
 * exist): a hunk with a directive, a line inside a `/*!` block or a JSON line opening with a quote refuses; a hunk is cleared only when both sides lex with certainty (`lineKinds`) and its
 * every changed line is blank or a comment no tool reads, at least one a comment; every other hunk is left to the verifier.
 */
export function readByCode(path: string, before: string | null, after: string | null, diff: string): CodeReading {
  const kinds = { before: before === null ? null : lineKinds(path, before), after: after === null ? null : lineKinds(path, after) };
  const texts = { before: before?.split('\n') ?? [], after: after?.split('\n') ?? [] };
  const left: string[] = [];
  for (const h of hunksOf(diff)) {
    const header = h.text.split('\n')[0]!;
    if (h.lines.some((l) => DIRECTIVES.some((d) => d.test(l.text.trim())))) return { kind: 'refused', reason: `${path} changes a tool directive: ${header}` };
    if (h.lines.some((l) => inPreservedBlock(texts[l.side], l.line))) return { kind: 'refused', reason: `${path} changes a preserved /*! comment: ${header}` };
    if (/\.jsonc?$/i.test(path) && h.lines.some((l) => l.text.trim().startsWith('"'))) return { kind: 'refused', reason: `${path} changes a JSON key or value: ${header}` };
    const read = h.lines.map((l): LineKind => {
      const k = kinds.before === null || kinds.after === null ? undefined : kinds[l.side]![l.line - 1];
      if (k === undefined) return 'other';
      if (texts[l.side][l.line - 1] !== l.text) throw new Error(`${path}: the diff's ${l.side} line ${l.line} is not the file's`);
      return k === 'comment' && TOOL_READ.some((t) => t.test(l.text.trim())) ? 'other' : k;
    });
    if (!(read.every((k) => k !== 'other') && read.includes('comment'))) left.push(h.text);
  }
  return { kind: 'read', left };
}

/** What the unit's latest build answered as `docsOnlySince`, or null (no claim, or no answer). */
function claimOf(ctx: StageContext, unit: UnitId): Sha | null {
  const spawn = ctx.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build' && i.expect.subject.unit === unit).at(-1);
  return spawn === undefined ? null : judgmentOutput(ctx, spawn, validateBuildOutput)?.docsOnlySince ?? null;
}

/** The unit's last certified tree: the commit of the spec series of its latest lanes attempt that ended green; null before one. */
export function certifiedTree(ctx: StageContext, unit: UnitId): Sha | null {
  const attempt = ctx.journal.view.review().greenLanes(unit);
  if (attempt === null) return null;
  const path = verificationWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit, attempt);
  const created = ctx.journal.view.opsOf('worktree.create').find((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'lanes'
    && i.parent.attempt === attempt && i.expect.path === path);
  if (created === undefined || created.expect.checkout.type !== 'detached') throw new Error(`unit ${unit}: lanes attempt ${attempt} ended green without its verification checkout`);
  return created.expect.checkout.at;
}

type Verdict = Readonly<{ kind: 'accepted'; by: 'code' | 'verifier' }> | Readonly<{ kind: 'refused'; reason: string }>;

/** Code's reading of the diff `since..at`, then the verifier's of what code left. */
async function verdictOf(ctx: StageContext, unit: PlanUnit, parent: StageParent, since: Sha, at: Sha): Promise<Verdict> {
  const map = mapInForce(ctx.journal.view);
  const raw = git(ctx.repo, ['diff', '--raw', '--no-renames', '-z', since, at]).split('\0').filter((s) => s !== '');
  const left: VerifierHunk[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const [oldMode, newMode] = raw[i]!.slice(1).split(' ');
    const path = repoPath(raw[i + 1]!);
    if (oldMode === '160000' || newMode === '160000') return { kind: 'refused', reason: `${path} is a submodule` };
    if (oldMode !== '000000' && newMode !== '000000' && oldMode !== newMode) return { kind: 'refused', reason: `${path} changed mode` };
    if (map !== null && pathClass(map, path).kind === 'docs') continue;
    const diff = git(ctx.repo, ['diff', '--no-renames', '-U0', since, at, '--', path]);
    if (/^Binary files /m.test(diff)) return { kind: 'refused', reason: `${path} is binary` };
    const show = (sha: Sha, mode: string): string | null => (mode === '000000' ? null : git(ctx.repo, ['show', `${sha}:${path}`]));
    const read = readByCode(path, show(since, oldMode!), show(at, newMode!), diff);
    if (read.kind === 'refused') return read;
    for (const text of read.left) left.push({ id: `h${left.length + 1}`, path, language: languageOf(path), text });
  }
  if (left.length === 0) return { kind: 'accepted', by: 'code' };
  return askVerifier(ctx, unit, parent, since, at, left);
}

/** One fresh verifier call over `hunks`; accepted only when every hunk is answered once and clear. */
async function askVerifier(ctx: StageContext, unit: PlanUnit, parent: StageParent, since: Sha, at: Sha, hunks: readonly VerifierHunk[]): Promise<Verdict> {
  const seated = verifierDispatch(ctx, unit.id);
  if (seated.kind !== 'pinned') return { kind: 'refused', reason: 'the routing changed since the unit was dispatched; the verifier seat was not called' };
  const dispatch = seated.dispatch;
  const prompt = promptFor('verifier', dispatch.triple.model);
  const ids = hunks.map((h) => h.id);
  const called = await callBackend(ctx, {
    unit: unit.id, parent, request: { kind: 'judgment', dispatch, session: freshJudgmentSession(), evidenceDirs: [] },
    system: prompt.system, ...renderPrompt(prompt, { unit: unit.id, since, at, hunks }), schema: verifierSchemaFor(ids), cwd: ctx.repo,
    deadlineAt: inMs(judgmentDeadlineMs(dispatchOf(ctx.journal.view, unit.id))),
  });
  const judged = judgedAnswer(called, validateVerifierOutput);
  if (judged.kind === 'unanswered') return { kind: 'refused', reason: 'the verifier gave no answer' };
  if (judged.kind === 'refused') return { kind: 'refused', reason: `the verifier's answer was refused: ${judged.reasons.join('; ')}` };
  const answered = new Map(judged.out.hunks.map((h) => [h.id, h]));
  const missing = ids.filter((id) => !answered.has(id));
  if (missing.length > 0 || answered.size !== ids.length) return { kind: 'refused', reason: `the verifier answered hunks ${[...answered.keys()].join(', ')} of ${ids.join(', ')}` };
  const unclear = hunks.filter((h) => !hunkClear(answered.get(h.id)!));
  if (unclear.length === 0) return { kind: 'accepted', by: 'verifier' };
  const why = unclear.map((h) => {
    const a = answered.get(h.id)!;
    return `${h.id} (${h.path}): ${a.kind}${a.executable ? ', executable' : ''}${a.toolDirective ? ', a tool directive' : ''}${a.behaviourChange ? ', a behaviour change' : ''}`;
  });
  return { kind: 'refused', reason: `the verifier did not clear ${why.join('; ')}` };
}

/**
 * The lanes attempt `parent`'s check of its build's docs-only claim at the salvage SHA `at`, over the lanes the attempt runs:
 * the passes to carry over (`runLaneSeries` `carry`), empty when there is no claim or it was refused. Records `docs-only`
 * whenever there was a claim.
 */
export async function docsOnlyCarry(ctx: StageContext, unit: PlanUnit, parent: StageParent, at: Sha, lanes: readonly LaneDef[]): Promise<ReadonlyMap<LaneId, Reusable>> {
  const claim = claimOf(ctx, unit.id);
  if (claim === null) return new Map();
  const since = certifiedTree(ctx, unit.id);
  const refuse = (reason: string): ReadonlyMap<LaneId, Reusable> => {
    ctx.journal.fact({ kind: 'docs-only', unit: unit.id, attempt: parent.attempt, since: since ?? claim, at, verdict: 'refused', reason, carried: [] });
    return new Map();
  };
  if (since === null) return refuse('the unit has no certified tree yet');
  if (since !== claim) return refuse(`the claim names ${claim}; the unit's last certified tree is ${since}`);
  const verdict = await verdictOf(ctx, unit, parent, since, at);
  if (verdict.kind === 'refused') return refuse(verdict.reason);
  const carry = new Map<LaneId, Reusable>();
  for (const lane of lanes) {
    if (lane.readsComments === true || carry.has(lane.id)) continue;
    const pass = reusablePass(ctx, parent, lane, since, laneNow(ctx, lane, since));
    if (pass !== null) carry.set(lane.id, pass);
  }
  ctx.journal.fact({ kind: 'docs-only', unit: unit.id, attempt: parent.attempt, since, at, verdict: verdict.by, reason: null, carried: [...carry.keys()].sort() });
  return carry;
}

/** The lanes the docs-only acceptance of the unit's latest green lanes attempt carried over; none when it made none. */
export function carriedLanes(ctx: StageContext, unit: UnitId): readonly LaneId[] {
  const green = ctx.journal.view.review().greenLanes(unit);
  const last = ctx.journal.view.review().docsOnly.filter((d) => d.unit === unit && d.attempt === green).at(-1);
  return last === undefined ? [] : last.carried;
}
