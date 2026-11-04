// Availability notices from the actual Claude init, shared by builds, acting walks and spawn recovery.
import {existsSync, readFileSync} from 'node:fs';
import {readClaudeMcp} from '../backends/claude.ts';
import {MalformedOutputError} from '../backends/errors.ts';
import type {WalkMcpServers} from '../backends/mcp.ts';
import type {Journal} from '../core/interfaces.ts';
import {canonicalJson, sha256Hex} from '../core/json.ts';
import {sha256} from '../core/ids.ts';
import type {LaunchFile} from '../core/records.ts';
import type {AbsPath} from '../core/values.ts';
import {openNeedsUser, raiseNeedsUser, readNeedsUser} from '../needsuser.ts';

type Context = Readonly<{journal: Journal; runDir: AbsPath}>;

/** true once init has been consumed (or this invocation has no walkthrough MCP path). Safe to replay. */
export function inspectMcpInit(ctx: Context, launch: LaunchFile): boolean {
  const terminal = launch.terminal;
  if (terminal.type !== 'backend' || (terminal.role !== 'build' && terminal.role !== 'experienceVerdict')) return true;
  const index = launch.argv.indexOf('--mcp-config');
  if (index === -1) return true;
  const configPath = launch.argv[index + 1];
  if (configPath === undefined) throw new Error(`${launch.inv}: --mcp-config has no path`);
  if (!existsSync(terminal.outputPath)) return false;
  let statuses;
  try { statuses = readClaudeMcp(readFileSync(terminal.outputPath, 'utf8')); }
  catch (error) {
    // The adapter owns malformed CLI output and reports it as a backend failure.
    if (error instanceof MalformedOutputError) return true;
    throw error;
  }
  if (statuses === null) return false;
  const servers = (JSON.parse(readFileSync(configPath, 'utf8')) as {mcpServers: WalkMcpServers}).mcpServers;
  for (const [server, config] of Object.entries(servers)) {
    if (ctx.journal.view.walkMcp().some((w) => w.inv === launch.inv && w.server === server)) continue;
    const status = statuses.find((s) => s.name === server) ?? {name:server, status:'missing', error:null};
    const command = [config.command, ...config.args];
    if (status.status === 'connected') {
      const failures = new Set(ctx.journal.view.walkMcp().flatMap((w) => w.server === server && w.connection.type === 'unavailable' ? [w.connection.notice] : []));
      const settles = openNeedsUser(ctx.journal.view).filter((n) => failures.has(n.id)).map((n) => n.id);
      ctx.journal.fact({kind:'walkthrough-mcp', inv:launch.inv, server, command, connection:{type:'connected', settles}});
      continue;
    }
    const signature = sha256(sha256Hex(canonicalJson({status:status.status, error:status.error})));
    const prefix = `Walkthrough MCP ${server} (${signature}):`;
    const existing = ctx.journal.view.needsUser().find((n) => readNeedsUser(ctx.runDir, n.id)?.summary.startsWith(prefix));
    // Raise first: a crash before its status fact reuses the immutable notice on recovery.
    const notice = existing?.id ?? raiseNeedsUser(ctx.journal, ctx.runDir, {
      blocking:false, subject:{type:'arc'}, reason:'walkthrough-mcp',
      summary:`${prefix} status ${status.status}; command ${JSON.stringify(command)}${status.error === null ? '' : `; ${status.error}`}.`,
      recommendation:'Fix walkthrough.mcp so this command connects from the unit worktree (including its dependencies). The arc continues. A later configured Claude build or acting walk reporting this server connected explicitly settles its notices; otherwise review and acknowledge this item by id.',
      options:[], evidence:[terminal.outputPath],
    }, {type:'arc'});
    ctx.journal.fact({kind:'walkthrough-mcp', inv:launch.inv, server, command, connection:{type:'unavailable', status:status.status, error:status.error, signature, notice}});
  }
  return true;
}
