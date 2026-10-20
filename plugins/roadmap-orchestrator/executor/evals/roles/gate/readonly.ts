// The gate eval's read-only comparison arm (dev.13, run.ts `--read-only`): the same cells judged by the dev.12 gate, a
// read-only session on the judgment profile, so the gate's shell is measured against the gate it replaced.
//
// Production makes the gate's call on the acting-judge profile (argv.ts `claude-acting-judge`); the arm's `real` act
// (test/fakes/fake-backend.ts) rewrites that call's argv into the judgment profile's before it runs the real CLI: the
// judgment tools with no shell or write tool and no permission mode, no settings, slash commands off, the system text by
// `--system-prompt` with the read surface listed (dispatch.ts `judgmentSurface`, as a dev.12 judgment's), and the module's
// <your_checkout> section (GATE_CHECKOUT) swapped for the dev.12 gate's one sentence about its working directory. Model,
// effort, schema, session, cwd, stdin and add-dirs stay the call's own. Nothing in production code knows about the arm.
import { ACTING_JUDGE_TOOLS, backendArgv } from '../../../src/backends/argv.ts';
import { judgmentSessionId } from '../../../src/core/ids.ts';
import type { JudgmentSession } from '../../../src/core/records.ts';
import { type AbsPath, absPath } from '../../../src/core/values.ts';
import { judgmentSurface } from '../../../src/pipeline/dispatch.ts';
import { GATE_CHECKOUT } from '../../../src/prompts/gate/claude-opus-5-5.ts';
import { CLAUDE_EFFORTS, CLAUDE_MODELS, type ClaudeEffort, type ClaudeModelId } from '../../../src/routing/types.ts';

/**
 * What the dev.12 gate's system text said of its working directory, where the acting gate's has <your_checkout>; the second
 * sentence is the one addition, since the schema the arm answers is HEAD's.
 */
export const READ_ONLY_CHECKOUT = 'The repository at the diff head is your working directory, read-only. You have no shell, so every finding\'s experiments is empty.';

/** The arm's act data: the arc's repository and run dir, which lead the read surface the rewritten system text lists. */
export type ReadOnlyArm = Readonly<{ repo: string; runDir: string }>;

const value = (argv: readonly string[], flag: string): string => {
  const i = argv.indexOf(flag);
  const v = i === -1 ? undefined : argv[i + 1];
  if (v === undefined) throw new Error(`read-only arm: the gate call has no ${flag}`);
  return v;
};

/** The acting gate's appended system text with its <your_checkout> section replaced by the dev.12 sentence. */
export function readOnlySystem(acting: string): string {
  const at = acting.indexOf(GATE_CHECKOUT);
  if (at === -1 || acting.indexOf(GATE_CHECKOUT, at + 1) !== -1) throw new Error('read-only arm: the gate\'s system text does not hold <your_checkout> exactly once');
  return `${acting.slice(0, at)}${READ_ONLY_CHECKOUT}${acting.slice(at + GATE_CHECKOUT.length)}`;
}

/** The judgment-profile arguments of an acting gate call's arguments `args` (the CLI's argv after `claude`), for the read-only arm. */
export function readOnlyArgs(args: readonly string[], arm: ReadOnlyArm): readonly string[] {
  if (args[0] !== '-p') throw new Error(`read-only arm: not a claude -p call: ${args.slice(0, 2).join(' ')}`);
  if (value(args, '--tools') !== ACTING_JUDGE_TOOLS || args.includes('--mcp-config')) throw new Error('read-only arm: the call is not an acting gate call with no MCP server');
  const model = value(args, '--model');
  const effort = value(args, '--effort');
  if (!(CLAUDE_MODELS as readonly string[]).includes(model) || !(CLAUDE_EFFORTS as readonly string[]).includes(effort)) throw new Error(`read-only arm: ${model}:${effort} is no Claude triple`);
  const session: JudgmentSession = args.includes('--resume')
    ? { backend: 'claude', mode: 'resume', id: judgmentSessionId(value(args, '--resume')) }
    : { backend: 'claude', mode: 'fresh', id: judgmentSessionId(value(args, '--session-id')) };
  const addDirs = args.flatMap((t, i) => (args[i - 1] === '--add-dir' ? [absPath(t)] : []));
  const ctx = { repo: absPath(arm.repo), runDir: absPath(arm.runDir) };
  const surface = judgmentSurface(ctx, readOnlySystem(value(args, '--append-system-prompt')), addDirs);
  const same = (a: readonly AbsPath[], b: readonly AbsPath[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(surface.evidenceDirs, addDirs)) throw new Error(`read-only arm: the call's add-dirs ${addDirs.join(' ')} are not a judgment's read surface over ${arm.repo} and ${arm.runDir}`);
  // `role` is not in a judgment's argv; the call stays the gate's in every record (its launch.json is production's).
  return backendArgv({
    kind: 'claude-judgment', role: 'planCheck', triple: { backend: 'claude', model: model as ClaudeModelId, effort: effort as ClaudeEffort }, session,
    schemaText: value(args, '--json-schema'), system: surface.system, evidenceDirs: surface.evidenceDirs,
  }).slice(1);
}
