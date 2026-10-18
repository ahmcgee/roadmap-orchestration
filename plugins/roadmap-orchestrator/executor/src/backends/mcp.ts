// dev.13 (D1): the walkthrough MCP servers. The environment provides the browser drive: the repo config names stdio MCP
// servers (`walkthrough.mcp`, src/routing/layers.ts), and the executor ships no browser code. Two uses:
// - `walkMcpConfig`: the `--mcp-config` file an acting judge session gets (argv.ts `claude-acting-judge`), its `args` and
//   `env` values substituted (`WALK_SUBSTITUTIONS`): `{evidence}` the session's evidence dir, `{viewport}` `WALK_VIEWPORT`.
// - `mcpHandshake`: the bootstrap check (Phase-0/start row `walk-tools-missing`, src/preflight/walktools.ts) that a
//   configured server starts and connects, with no model call: code spawns it as Claude Code would (the command, its
//   args, the caller's env with the server's on top, stdio), sends the MCP `initialize` request over stdin
//   (newline-delimited JSON-RPC 2.0, the stdio transport) and reads the answer; then closes stdin and kills what is left.
//   This is what Claude Code's init event reports as `mcp_servers[].status: connected`. It does not use the server's
//   tools: Playwright MCP launches its browser at the first tool call, so a missing browser is the walk's to find.
import { spawn } from 'node:child_process';
import { canonicalJson } from '../core/json.ts';
import type { AbsPath } from '../core/values.ts';
import { WALK_VIEWPORT, type WalkMcpServer } from '../routing/layers.ts';

/** The servers of `walkthrough.mcp`, by name. */
export type WalkMcpServers = Readonly<Record<string, WalkMcpServer>>;

/** `server` with `{evidence}` and `{viewport}` substituted in its `args` and `env` values (nothing else is). */
export function substituteWalkServer(server: WalkMcpServer, evidenceDir: AbsPath): WalkMcpServer {
  const sub = (s: string): string => s.replaceAll('{evidence}', evidenceDir).replaceAll('{viewport}', WALK_VIEWPORT);
  return { command: server.command, args: server.args.map(sub), env: Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, sub(v)])) };
}

/**
 * The `--mcp-config` file's text for a session whose evidence dir is `evidenceDir`: `{"mcpServers": {<name>: {"type":
 * "stdio", "command", "args", "env"}}}`, canonical JSON, every server substituted.
 */
export function walkMcpConfig(servers: WalkMcpServers, evidenceDir: AbsPath): string {
  const mcpServers = Object.fromEntries(Object.entries(servers).map(([name, s]) => {
    const { command, args, env } = substituteWalkServer(s, evidenceDir);
    return [name, { type: 'stdio', command, args, env }];
  }));
  return `${canonicalJson({ mcpServers })}\n`;
}

/** The protocol version the handshake offers; a server answers with the one it speaks, which any answer accepts. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** How long a server has to answer `initialize` (Playwright MCP answers in about a second; an npx-fetched one takes longer). */
export const MCP_HANDSHAKE_MS = 30_000;
/** How long a server has to exit after its stdin closes before it is killed. */
const MCP_CLOSE_MS = 2_000;

export type McpHandshake = Readonly<{ ok: true }> | Readonly<{ ok: false; detail: string }>;

/**
 * Starts `server` (already substituted) and does the MCP `initialize` handshake over stdio within `timeoutMs`. `ok` on a
 * JSON-RPC result to the request; otherwise `detail` says why (the spawn error, an error answer, an exit, the timeout),
 * with the tail of its stderr. The server runs in its own process group, killed whole once the answer is in.
 */
export function mcpHandshake(
  server: WalkMcpServer, cwd: AbsPath, env: Readonly<Record<string, string | undefined>>, timeoutMs: number = MCP_HANDSHAKE_MS,
): Promise<McpHandshake> {
  return new Promise((resolve) => {
    const child = spawn(server.command, [...server.args], { cwd, env: { ...env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const tail = (): string => (stderr.trim() === '' ? '' : `; stderr: ${stderr.trim().slice(-500)}`);
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    const finish = (outcome: McpHandshake): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        const kill = setTimeout(() => killGroup('SIGKILL'), MCP_CLOSE_MS);
        child.once('exit', () => {
          clearTimeout(kill);
          killGroup('SIGKILL'); // what it started (a browser) outlives it otherwise
          resolve(outcome);
        });
        killGroup('SIGTERM');
      } else {
        killGroup('SIGKILL');
        resolve(outcome);
      }
    };
    const timer = setTimeout(() => finish({ ok: false, detail: `no answer to initialize within ${timeoutMs} ms${tail()}` }), timeoutMs);
    child.on('error', (error) => finish({ ok: false, detail: `${server.command} did not start: ${error.message}` }));
    child.on('exit', (code, signal) => finish({ ok: false, detail: `exited ${signal ?? code} before answering initialize${tail()}` }));
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr = (stderr + d).slice(-4096); });
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (line === '') continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ ok: false, detail: `wrote a line that is not JSON-RPC: ${line.slice(0, 200)}` });
          return;
        }
        const m = message as { id?: unknown; result?: unknown; error?: { message?: unknown } };
        if (m.id !== 1) continue; // a notification or log message before the answer
        finish(m.result !== undefined ? { ok: true } : { ok: false, detail: `answered initialize with an error: ${JSON.stringify(m.error)}` });
        return;
      }
    });
    child.stdin.on('error', () => { /* a server that exits early closes the pipe: its exit reports it */ });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'roadmap-executor', version: '1' } },
    })}\n`);
  });
}
