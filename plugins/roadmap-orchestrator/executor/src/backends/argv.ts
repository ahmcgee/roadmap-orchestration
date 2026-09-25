// The one backend argv builder. Production launches, the preflight smoke and the probe all call it, so
// what the probe verifies against the real CLIs is exactly what production runs (R21). The prompt always
// travels on stdin; argv[0] is the bare CLI name, resolved through PATH (which is how test shims stand in).
//
// Illegal combinations are unrepresentable: a judgment call is Claude only (Codex judgment is unsupported
// in M1) and takes a `JudgmentSession`, whose only mode is `fresh`, so a resumed judgment cannot be built.
//
// Codex resume flags, verified against `codex exec resume --help` (codex-cli 0.157.0, 2026-09-25): resume
// accepts `-c`, `-m`, `--json`, `-o` and `--output-schema`, and `--skip-git-repo-check`; it has no `-s` and
// no `-C` (the session runs in the process cwd, which the runner sets from launch.json). The sandbox is
// therefore passed as `-c sandbox_mode=danger-full-access`.
import { randomUUID } from 'node:crypto';
import { implementerSessionId, judgmentSessionId } from '../core/ids.ts';
import type { ImplementerSession, JudgmentSession } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import type { JudgmentRole, Triple } from '../routing/types.ts';

export type CodexTriple = Extract<Triple, { backend: 'codex' }>;
export type ClaudeTriple = Extract<Triple, { backend: 'claude' }>;
export type CodexSession = Extract<ImplementerSession, { backend: 'codex' }>;
export type ClaudeImplementerSession = Extract<ImplementerSession, { backend: 'claude' }>;

/** Tools a judgment session may use: read-only inspection of the tree it judges. */
export const JUDGMENT_TOOLS = 'Read,Grep,Glob';

export type BackendCall =
  | Readonly<{
    kind: 'claude-judgment';
    role: JudgmentRole;
    triple: ClaudeTriple;
    session: JudgmentSession;
    /** The role's JSON schema text; Claude takes the schema inline, not as a path. */
    schemaText: string;
  }>
  | Readonly<{
    kind: 'claude-build';
    triple: ClaudeTriple;
    session: ClaudeImplementerSession;
    schemaText: string;
  }>
  | Readonly<{
    kind: 'codex-build';
    triple: CodexTriple;
    session: CodexSession;
    /** Only a fresh exec names its working root; a resume runs in the process cwd. */
    cwd: AbsPath;
    /** The `-o` file: Codex writes the final, schema-constrained message there. */
    outputPath: AbsPath;
    schemaPath: AbsPath;
  }>;

export type Argv = readonly [string, ...string[]];

export function backendArgv(call: BackendCall): Argv {
  switch (call.kind) {
    case 'claude-judgment':
      return [
        'claude', '-p', '--output-format', 'json', '--json-schema', call.schemaText, '--model', call.triple.model,
        '--tools', JUDGMENT_TOOLS, '--session-id', call.session.id, '--no-session-persistence',
      ];
    case 'claude-build': {
      const session = call.session.mode === 'fresh' ? ['--session-id', call.session.id] : ['--resume', call.session.id];
      return [
        'claude', '-p', '--output-format', 'json', '--json-schema', call.schemaText, '--model', call.triple.model,
        '--permission-mode', 'bypassPermissions', ...session,
      ];
    }
    case 'codex-build': {
      const model = ['-m', call.triple.model, '-c', `model_reasoning_effort=${call.triple.effort}`];
      const output = ['--json', '-o', call.outputPath, '--output-schema', call.schemaPath];
      if (call.session.mode === 'fresh') {
        return ['codex', 'exec', '-C', call.cwd, '-s', 'danger-full-access', '--skip-git-repo-check', ...model, ...output, '-'];
      }
      return [
        'codex', 'exec', 'resume', call.session.id, '-c', 'sandbox_mode=danger-full-access', '--skip-git-repo-check',
        ...model, ...output, '-',
      ];
    }
  }
}

/** A judgment session id is minted per call and never reused: judgment never resumes. */
export function freshJudgmentSession(): JudgmentSession {
  return { backend: 'claude', mode: 'fresh', id: judgmentSessionId(randomUUID()) };
}

export function freshClaudeImplementerSession(): ClaudeImplementerSession {
  return { backend: 'claude', mode: 'fresh', id: implementerSessionId(randomUUID()) };
}
