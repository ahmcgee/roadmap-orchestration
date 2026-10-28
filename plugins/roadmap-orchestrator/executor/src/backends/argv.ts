// The one backend argv builder. Production launches, the preflight smoke and the probe all call it, so
// what the probe verifies against the real CLIs is exactly what production runs (R21). The prompt always
// travels on stdin; argv[0] is the bare CLI name, resolved through PATH (which is how test shims stand in).
//
// Illegal combinations are unrepresentable: a judgment call is Claude only (Codex judgment is unsupported
// in M1) and takes a `JudgmentSession`. A judgment is fresh, except its repair turn (dev.12: every judgment role), which
// resumes the session its refused answer came from, once. Every judgment's fresh call therefore persists its session (no
// `--no-session-persistence`); each fresh call still mints its own session id, so judgments stay independent of each other.
//
// Codex resume flags, verified against `codex exec resume --help` (codex-cli 0.157.0, 2026-09-25): resume
// accepts `-c`, `-m`, `--json`, `-o` and `--output-schema`, and `--skip-git-repo-check`; it has no `-s` and
// no `-C` (the session runs in the process cwd, which the runner sets from launch.json). The sandbox is
// therefore passed as `-c sandbox_mode=danger-full-access`.
//
// System prompts, verified against `claude --help` (Claude Code 2.1.282) and `codex exec --help`
// (codex-cli 0.157.0), 2026-09-25:
// - `claude -p` takes `--system-prompt <text>` (replaces the default system prompt) and
//   `--append-system-prompt <text>` (appends to it). Judgment passes the module's `system` with
//   `--system-prompt`: a judge is a read-only reviewer returning one structured verdict, and Claude Code's
//   default prompt (an interactive coding agent that edits, runs commands and talks to a user) contradicts
//   that role; its tools (`JUDGMENT_TOOLS`) keep their own definitions. The implementer passes it with
//   `--append-system-prompt`: it does real agentic work with the full tool set, and the default prompt
//   carries the tool-use and environment guidance that work relies on. A resume passes the same flag; the
//   CLI records the system prompt on a conversation's first request and reuses it on resume.
// - `codex exec` has no system-prompt flag (its only instruction channel is the prompt), so the module's
//   `system` leads the stdin text: `promptBytes` is the one function that composes stdin for every call.
//
// Evidence dirs, verified the same way: `claude -p --add-dir <directories...>` adds directories the tools
// may access beyond the cwd. A judgment session runs in the tree it judges and reads beyond it: its read surface is the
// repository and the run dir, plus any dir its role names outside both (dispatch.ts `judgmentReadDirs`, 2026-10-16; named
// in its system text by `judgmentSurface`, since `--system-prompt` drops Claude Code's own list), each
// passed as its own `--add-dir <dir>` pair (the flag is variadic, so it goes last, where no later token can be swallowed
// into its list). Its tools write nothing, so the surface is read-only. The Claude implementer works in its
// worktree but writes decisions.json into an evidence dir outside it and, in a fix round, reads the failing
// lanes' evidence dirs: the same `--add-dir` pairs, last. Codex runs with danger-full-access, so nothing is
// needed on the Codex side.
//
// Advisor (dev.17), verified against the real CLI (Claude Code 2.1.301, 2026-10-22): every Claude build, fresh or resumed,
// passes `--advisor <BUILD_ADVISOR>` (classes.ts). The flag is not in `claude --help` but documented
// (https://code.claude.com/docs/en/advisor) and takes a pinned id; it applies to the one session, so a resume passes it
// again. The CLI exits at launch on a pairing it refuses outright (an advisor that cannot advise, an allowlist excluding it)
// and drops an advisor that ranks below the main model. The advisor's spend is its own `modelUsage` entry (backends/claude.ts).
//
// Output and context, verified against the real CLI (Claude Code 2.1.283, 2026-09-26; captures in
// test/fixtures/backend-output/claude-*):
// - Every Claude call runs `--output-format stream-json --verbose`: stdout is JSONL, a `system/init` event
//   first and the same `type:"result"` object `--output-format json` prints as its last line
//   (`structured_output` under `--json-schema` included). The stream keeps the session's tool calls, so
//   what a judgment read is on record (reads.json, backends/claude.ts); plain `json` keeps the result only.
// - Clean contexts (arc-1 feedback item 19). Run from the operator's own config dir with the default
//   sources, a judgment loaded the repo's CLAUDE.md, the operator's CLAUDE.md and auto-memory, the claude.ai
//   MCP connectors of the logged-in account (their tools too: `--tools` does not restrict MCP tools) and the
//   installed skills. `--setting-sources ''` loads no user, project or local settings, and with them no
//   CLAUDE.md file; `--strict-mcp-config` with no `--mcp-config` loads no MCP server of any source;
//   `--disable-slash-commands` loads no skill. The init event then lists tools Task (the Agent tool), Glob, Grep, Read
//   and StructuredOutput only, no MCP server and no skill; a canary CLAUDE.md is not seen (evals/probe.ts pins
//   both). Auto-memory is turned off by environment for every Claude call (`backendEnv`,
//   preflight/smoke.ts). The implementer keeps `--setting-sources project` so the repo's CLAUDE.md
//   conventions reach it (the unit policy in its prompt overrides their permissions), and no memory the same
//   way. dev.13 (owner 2026-10-18: Claude designs better with a design skill loaded): slash commands are no longer
//   disabled for it, so the project's skills load, as for an acting judge; it gets no MCP server but, in a milestone
//   with a `browser` journey, the walkthrough servers of its `--mcp-config`. Measured on Claude Code 2.1.301
//   (2026-10-18, a Haiku call per variant killed after its init event, under this argv): what loads under `--setting-sources
//   project` is a skill committed under the checkout's `.claude/skills/`, in a git worktree too. A plugin does not: one a
//   repo's `.claude/settings.json` enables loads only where it is installed for that path (installed_plugins.json
//   `projectPath`), so a project-scope install at the repo root reaches neither a unit worktree nor a fresh clone; a
//   user-scope plugin and the user's own skills never load (user settings are not a source). Measured on Claude Code
//   2.1.310 (2026-10-28), project settings also load 19 bundled skills beside the committed project skill.
//   `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` (backendEnv) leaves the project skill, design, doctor and plugin-authoring;
//   `--settings` disabling `cc-plugin-plugin-authoring@builtin` removes plugin-authoring too. Design (unusable headless)
//   and doctor remain; disallowing Skill does not remove their listings. The probe pins exactly that residual pair
//   plus the project canary. The agents-md and telemetry built-in plugins and the logged-in account's email in a
//   user-context block stay. Calls keep the operator's CLAUDE_CONFIG_DIR on
//   purpose: the CLI rewrites `.credentials.json` by temp file and rename, so an arc-private dir linking the
//   operator's file would fork it at the first OAuth refresh and leave the operator's login dead. An isolated
//   dir would need a `claude setup-token` token passed as CLAUDE_CODE_OAUTH_TOKEN, which the CLI never refreshes.
import { randomUUID } from 'node:crypto';
import { type JudgmentSessionId, implementerSessionId, judgmentSessionId } from '../core/ids.ts';
import type { ImplementerSession, JudgmentSession } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { BUILD_ADVISOR } from '../routing/classes.ts';
import type { ActingJudgeRole, FreshRole, Triple } from '../routing/types.ts';

export type CodexTriple = Extract<Triple, { backend: 'codex' }>;
export type ClaudeTriple = Extract<Triple, { backend: 'claude' }>;
export type CodexSession = Extract<ImplementerSession, { backend: 'codex' }>;
export type ClaudeImplementerSession = Extract<ImplementerSession, { backend: 'claude' }>;

/**
 * Tools a judgment session may use: read-only inspection, and `Agent` to delegate reading and sub-judgments to subagents
 * (owner ruling 2026-10-16: the role picks each subagent's type and model by its own calibration; no executor cap beyond
 * Claude Code's defaults, the judgment deadline is the brake). The invariant is that a judge's subagents are read-only,
 * and `--tools` alone keeps it: verified against the real CLI (Claude Code 2.1.301, 2026-10-16, `--tools
 * Read,Grep,Glob,Agent --setting-sources ''`), a subagent's tools are its type's list intersected with the session's
 * `--tools`. The built-in types (claude, general-purpose, Explore, Plan, statusline-setup; no user or project agents load
 * without setting sources) got Agent, Glob, Grep and Read at most (statusline-setup, whose list is Read and Edit, got Read
 * only); none could Write, Edit or run Bash. Subagents inherit the session's cwd and `--add-dir` reads (a read outside
 * both is refused and listed in the result's `permission_denials` like the session's own). The Agent tool's `model`
 * takes the aliases haiku, sonnet, opus and fable; `modelUsage` names the resolved ids (classes.ts `DELEGATE_CLASSES`).
 * So no `--agents` definition or `--disallowedTools` list is needed; evals/probe.ts pins the read-only subagent.
 * The init event lists the Agent tool as `Task`; its tool_use blocks name it `Agent`.
 */
export const JUDGMENT_TOOLS = 'Read,Grep,Glob,Agent';

/**
 * dev.13, the acting judge's tools: a judgment session that uses the product (a walkthrough, the polish judge, and the
 * gate's ad hoc experiments) gets a shell and may write (its evidence, scratch scripts) besides reading and delegating.
 * MCP tools are not restricted by `--tools`, and bypassPermissions allows them, so they need no entry here or in
 * `--allowed-tools`: an acting judge gets exactly the servers of its `--mcp-config` (none when it passes none, under
 * `--strict-mcp-config`). Verified against the real CLI (Claude Code 2.1.301, 2026-10-18, this argv with the Playwright
 * MCP server): the init event lists every `mcp__playwright__browser_*` tool and `mcp_servers: [{name: playwright, status:
 * connected}]` with this `--tools` value, and the same with `,mcp__playwright` appended.
 */
export const ACTING_JUDGE_TOOLS = 'Read,Grep,Glob,Bash,Write,Edit,Agent';

/**
 * dev.17 (design pass): the plan-check's tools, an acting judge's with web search and fetch, so it can check a library, an
 * API or a standard the spec relies on and cite it. What it fetches is untrusted data, never instructions (its prompt says
 * so); a shell is for observing existing code (tests, build- and unit-cadence lanes, tools) in its own checkouts.
 */
export const PLAN_CHECK_TOOLS = `${ACTING_JUDGE_TOOLS},WebSearch,WebFetch`;

/** An acting judge's `--tools` value: plan-check's with the web tools, every other acting judge's `ACTING_JUDGE_TOOLS`. */
export const actingJudgeTools = (role: ActingJudgeRole): string => (role === 'planCheck' ? PLAN_CHECK_TOOLS : ACTING_JUDGE_TOOLS);

/** The file-writing tools an acting judge's `--disallowedTools` rules name for each denied path (`writeDenyRules`). */
export const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;

/**
 * dev.13: the `--disallowedTools` rules that keep an acting judge's file-writing tools off `paths` (each a directory or a
 * file): `<Tool>(//<abs path>)` and `<Tool>(//<abs path>/**)`, Claude Code's permission-rule syntax for an absolute path
 * (`//` is the filesystem root). Deny rules hold under bypassPermissions (verified on Claude Code 2.1.301, 2026-10-18: a
 * Haiku session's Write into a denied directory was refused, "File is in a directory that is denied by your permission
 * settings", and listed in `permission_denials`, while a Write and an Edit beside it succeeded). Bash is not restricted:
 * it stays trusted to the prompt.
 */
export const writeDenyRules = (paths: readonly AbsPath[]): readonly string[] =>
  paths.flatMap((p) => WRITE_TOOLS.flatMap((t) => [`${t}(/${p})`, `${t}(/${p}/**)`]));

export type BackendCall =
  | Readonly<{
    kind: 'claude-judgment';
    /**
     * A judging arc role (a lens, the checkpoint; M3): a read-only session, fresh or a repair turn. The gate (dev.13) and
     * plan-check (dev.17) act; `planCheck` here is only the preflight smoke's read-only probe of the plan-check seat
     * (src/preflight/smoke.ts) and the probe's (evals/probe.ts), never a unit's plan-check.
     */
    role: FreshRole | 'planCheck';
    triple: ClaudeTriple;
    session: JudgmentSession;
    /** The role's JSON schema text; Claude takes the schema inline, not as a path. */
    schemaText: string;
    /** The prompt module's standing instructions: `--system-prompt`. */
    system: string;
    /** Directories outside the cwd the judge must read: one `--add-dir` each. */
    evidenceDirs: readonly AbsPath[];
  }>
  | Readonly<{
    kind: 'claude-build';
    triple: ClaudeTriple;
    session: ClaudeImplementerSession;
    schemaText: string;
    /** The prompt module's standing instructions: `--append-system-prompt`. */
    system: string;
    /**
     * dev.13: the `--mcp-config` file of a build in a milestone with a `browser` journey (the `walkthrough.mcp` servers,
     * src/backends/mcp.ts `walkMcpConfig` with `{evidence}` the build's evidence dir, kept under the run dir's inputs), or
     * null for no server.
     */
    mcpConfig: AbsPath | null;
    /** Directories outside the worktree the implementer reads or writes: one `--add-dir` each. */
    evidenceDirs: readonly AbsPath[];
  }>
  | Readonly<{
    /**
     * dev.13: a judgment that acts (owner 2026-10-18): bypassPermissions, `ACTING_JUDGE_TOOLS`, `--setting-sources project`
     * (project skills load: slash commands are not disabled), `--strict-mcp-config` with the given servers. Its cwd (the
     * launch's) is the detached checkout it works in. Fresh, or resumed once for the repair turn, like a judgment.
     */
    kind: 'claude-acting-judge';
    role: ActingJudgeRole;
    triple: ClaudeTriple;
    session: JudgmentSession;
    schemaText: string;
    /** The prompt module's standing instructions: `--append-system-prompt` (it does agentic work, as the implementer). */
    system: string;
    /**
     * The `--mcp-config` file (src/backends/mcp.ts `walkMcpConfig`, kept under the run dir's inputs), or null for no server
     * (the gate's).
     */
    mcpConfig: AbsPath | null;
    /** Directories outside the cwd it reads or writes (its evidence dir, the walk evidence it compares): one `--add-dir` each. */
    evidenceDirs: readonly AbsPath[];
    /**
     * The paths its Write, Edit and NotebookEdit may not touch (`--disallowedTools`, `writeDenyRules`): the repository and
     * the run dir, less what it writes in (dispatch.ts `actingWriteDenials`).
     */
    denyWrites: readonly AbsPath[];
  }>
  | Readonly<{
    /**
     * dev.17 (design pass): the scaffold writer (`scaffold`, economy), writing a new system's skeleton in the unit worktree
     * (its cwd): bypassPermissions with the full tool set like a Claude build, `--setting-sources project`, no advisor, no MCP
     * server, always a fresh session (a retry is a new attempt).
     */
    kind: 'claude-scaffold';
    triple: ClaudeTriple;
    session: JudgmentSession;
    schemaText: string;
    /** The prompt module's standing instructions: `--append-system-prompt`. */
    system: string;
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
    /** The prompt module's standing instructions: Codex has no system channel, so they lead stdin. */
    system: string;
  }>;

export type Argv = readonly [string, ...string[]];

/** Every Claude call: JSONL, plugin-authoring disabled, and no MCP server but its own `--mcp-config`. */
const CLAUDE_COMMON = [
  '--output-format', 'stream-json', '--verbose',
  '--settings', JSON.stringify({ enabledPlugins: { 'cc-plugin-plugin-authoring@builtin': false } }),
  '--strict-mcp-config',
] as const;

const mcpConfigArgs = (file: AbsPath | null): readonly string[] => (file === null ? [] : ['--mcp-config', file]);

export function backendArgv(call: BackendCall): Argv {
  switch (call.kind) {
    case 'claude-judgment': {
      const session = call.session.mode === 'fresh' ? ['--session-id', call.session.id] : ['--resume', call.session.id];
      return [
        'claude', '-p', ...CLAUDE_COMMON, '--disable-slash-commands', '--setting-sources', '', '--json-schema', call.schemaText, '--model', call.triple.model,
        '--effort', call.triple.effort, '--tools', JUDGMENT_TOOLS, ...session,
        '--system-prompt', call.system, ...call.evidenceDirs.flatMap((dir) => ['--add-dir', dir]),
      ];
    }
    case 'claude-build': {
      const session = call.session.mode === 'fresh' ? ['--session-id', call.session.id] : ['--resume', call.session.id];
      return [
        'claude', '-p', ...CLAUDE_COMMON, ...mcpConfigArgs(call.mcpConfig), '--setting-sources', 'project', '--json-schema', call.schemaText, '--model', call.triple.model,
        '--effort', call.triple.effort, '--advisor', BUILD_ADVISOR, '--permission-mode', 'bypassPermissions', ...session, '--append-system-prompt', call.system,
        ...call.evidenceDirs.flatMap((dir) => ['--add-dir', dir]),
      ];
    }
    case 'claude-acting-judge': {
      const session = call.session.mode === 'fresh' ? ['--session-id', call.session.id] : ['--resume', call.session.id];
      return [
        'claude', '-p', ...CLAUDE_COMMON, ...mcpConfigArgs(call.mcpConfig),
        '--setting-sources', 'project', '--json-schema', call.schemaText, '--model', call.triple.model, '--effort', call.triple.effort,
        '--tools', actingJudgeTools(call.role), ...(call.denyWrites.length === 0 ? [] : ['--disallowedTools', ...writeDenyRules(call.denyWrites)]),
        '--permission-mode', 'bypassPermissions', ...session, '--append-system-prompt', call.system,
        ...call.evidenceDirs.flatMap((dir) => ['--add-dir', dir]),
      ];
    }
    case 'claude-scaffold': {
      if (call.session.mode !== 'fresh') throw new Error(`a scaffold session is always fresh, not a resume of ${call.session.id}`);
      return [
        'claude', '-p', ...CLAUDE_COMMON, '--setting-sources', 'project', '--json-schema', call.schemaText, '--model', call.triple.model, '--effort', call.triple.effort,
        '--permission-mode', 'bypassPermissions', '--session-id', call.session.id, '--append-system-prompt', call.system,
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

/**
 * The stdin text of a backend call. Claude takes `system` by flag (see `backendArgv`), so its stdin is the
 * rendered prompt alone; Codex has no system channel, so its stdin is `system`, a blank line, then the
 * rendered prompt.
 */
export function promptBytes(call: BackendCall, rendered: string): string {
  switch (call.kind) {
    case 'claude-judgment':
    case 'claude-build':
    case 'claude-acting-judge':
    case 'claude-scaffold':
      return rendered;
    case 'codex-build':
      return `${call.system}\n\n${rendered}`;
  }
}

/** A judgment session id is minted per fresh call; only a repair turn resumes one (`resumedJudgmentSession`). */
export function freshJudgmentSession(): JudgmentSession {
  return { backend: 'claude', mode: 'fresh', id: judgmentSessionId(randomUUID()) };
}

/** A repair turn's session: the refused answer's own, resumed. */
export function resumedJudgmentSession(id: JudgmentSessionId): JudgmentSession {
  return { backend: 'claude', mode: 'resume', id };
}

export function freshClaudeImplementerSession(): ClaudeImplementerSession {
  return { backend: 'claude', mode: 'fresh', id: implementerSessionId(randomUUID()) };
}
