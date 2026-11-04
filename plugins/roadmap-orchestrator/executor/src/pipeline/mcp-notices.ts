// Availability notices from the actual Claude init, shared by builds, acting walks and spawn recovery.
import {closeSync, openSync, readFileSync, readSync} from 'node:fs';
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

/** A live invocation's cursor: each complete stdout line is parsed once, through the first init.
 * Reads are small even when recovery inspects a completed build with a large stdout tail.
 */
export function mcpInitInspector(ctx: Context, launch: LaunchFile): () => boolean {
  let offset = 0;
  let fragments: Buffer[] = [];
  let consumed = false;
  const terminal = launch.terminal;
  const index = launch.argv.indexOf('--mcp-config');
  if (terminal.type !== 'backend' || (terminal.role !== 'build' && terminal.role !== 'experienceVerdict') || index === -1) return () => true;
  const configPath = launch.argv[index + 1];
  if (configPath === undefined) throw new Error(`${launch.inv}: --mcp-config has no path`);
  return () => {
    if (consumed) return true;
    let fd: number;
    try { fd = openSync(terminal.outputPath, 'r'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    try {
      const chunk = Buffer.allocUnsafe(4096);
      for (let size = readSync(fd, chunk, 0, chunk.length, offset); size !== 0; size = readSync(fd, chunk, 0, chunk.length, offset)) {
        offset += size;
        let start = 0;
        for (let nl = chunk.indexOf(0x0a, start); nl !== -1 && nl < size; nl = chunk.indexOf(0x0a, start)) {
          fragments.push(chunk.subarray(start, nl + 1));
          const init = readClaudeMcp(Buffer.concat(fragments).toString('utf8'));
          fragments = [];
          start = nl + 1;
          if (init === null) continue;
          consumed = true;
          if (init.servers !== null) recordMcpInit(ctx, launch, configPath, init.servers);
          return true;
        }
        // Keep bytes, including split UTF-8 characters, without reparsing or repeatedly copying a partial line.
        if (start < size) fragments.push(Buffer.from(chunk.subarray(start, size)));
      }
      return false;
    } catch (error) {
      // The adapter owns malformed CLI output and reports it as a backend failure.
      if (error instanceof MalformedOutputError) { consumed = true; fragments = []; return true; }
      throw error;
    } finally { closeSync(fd); }
  };
}

/** One inspection during spawn recovery; live polling retains the same inspector between ticks. */
export function inspectMcpInit(ctx: Context, launch: LaunchFile): boolean {
  return mcpInitInspector(ctx, launch)();
}

function recordMcpInit(ctx: Context, launch: LaunchFile, configPath: string, statuses: readonly import('../backends/claude.ts').ClaudeMcpStatus[]): void {
  const terminal = launch.terminal;
  if (terminal.type !== 'backend') throw new Error(`${launch.inv}: MCP init without backend terminal`);
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
}
