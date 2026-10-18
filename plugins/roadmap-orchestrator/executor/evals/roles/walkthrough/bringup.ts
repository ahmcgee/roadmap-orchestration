// The walkthrough eval's stand-ins for production code other dev.13 agents are writing in parallel, each behind one
// function so the merge swaps it in one place:
//
// - `bringUp`: SWAP AT MERGE for agent C's walk bring-up (src/walk/): the milestone's `setup`, `serve` (ports allocated,
//   `{port:<name>}` substituted, each probed ready), `seed`, with the semantics frozen in SCHEMAS.md "dev.13" (no shell,
//   from the checkout root, `env` added; http ready below 500, log ready a substring). Server output goes to
//   `<logDir>/<name>.log`. `stop` kills the serve entries' process groups.
// - `walkMcpConfig`: SWAP AT MERGE for agent A's `walkthrough.mcp` substitution (src/routing/layers.ts
//   `WALK_SUBSTITUTIONS`): `{evidence}` and `{viewport}` in `args` and `env` values, as `--mcp-config` JSON text.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PORT_PLACEHOLDER, type BringUp } from '../../../src/input/plan.ts';
import { type RepoConfig, WALK_VIEWPORT, parseRepoConfig } from '../../../src/routing/layers.ts';

export type Instance = Readonly<{ ports: Readonly<Record<string, number>>; env: Readonly<Record<string, string>>; stop: () => void }>;

export class BringUpFailed extends Error {
  readonly step: string;
  readonly log: string;
  constructor(step: string, log: string, detail: string) {
    super(`bring-up ${step} failed: ${detail}`);
    this.step = step;
    this.log = log;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      if (a === null || typeof a === 'string') throw new Error('a listening socket without a port');
      s.close(() => resolve(a.port));
    });
  });
}

/** `{port:<name>}` replaced by the allocated port; a name with no port is a bug (the plan parser refuses it). */
export function substitutePorts(text: string, ports: Readonly<Record<string, number>>): string {
  return text.replace(PORT_PLACEHOLDER, (_, name: string) => {
    const p = ports[name];
    if (p === undefined) throw new Error(`{port:${name}} names no serve entry`);
    return String(p);
  });
}

const READY_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Brings `b` up in `checkout`; on a failure everything started is stopped and BringUpFailed names the step and its log. */
export async function bringUp(checkout: string, b: BringUp, logDir: string): Promise<Instance> {
  const ports: Record<string, number> = {};
  for (const s of b.serve) ports[s.name] = await freePort();
  const env: Record<string, string> = Object.fromEntries(Object.entries(b.env).map(([k, v]) => [k, substitutePorts(v, ports)]));
  const childEnv = { ...process.env, ...env };
  const groups: number[] = [];
  const stop = (): void => {
    for (const pid of groups) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
    }
  };
  const runAll = (label: string, cmds: readonly (readonly string[])[]): void => {
    cmds.forEach((argv, i) => {
      const step = `${label}[${i}]`;
      const log = join(logDir, `${label}-${i}.log`);
      const [cmd, ...args] = argv.map((a) => substitutePorts(a, ports)) as [string, ...string[]];
      const r = spawnSync(cmd, args, { cwd: checkout, env: childEnv, encoding: 'utf8', timeout: 120_000 });
      writeFileSync(log, `${r.stdout ?? ''}${r.stderr ?? ''}`);
      if (r.status !== 0) throw new BringUpFailed(step, log, `${argv.join(' ')} exited ${r.status ?? r.signal}`);
    });
  };
  try {
    runAll('setup', b.setup);
    for (const s of b.serve) {
      const log = join(logDir, `${s.name}.log`);
      const fd = openSync(log, 'a');
      const [cmd, ...args] = s.argv.map((a) => substitutePorts(a, ports)) as [string, ...string[]];
      const child = spawn(cmd, args, { cwd: checkout, env: childEnv, stdio: ['ignore', fd, fd], detached: true });
      closeSync(fd);
      if (child.pid === undefined) throw new BringUpFailed(`serve.${s.name}`, log, `${cmd} did not start`);
      groups.push(child.pid);
      child.unref();
      const deadline = Date.now() + READY_MS;
      for (;;) {
        if ('http' in s.ready) {
          const url = substitutePorts(s.ready.http, ports);
          const status = await fetch(url).then((r) => r.status, () => null);
          if (status !== null && status < 500) break;
        } else if (readFileSync(log, 'utf8').includes(s.ready.log)) break;
        if (child.exitCode !== null || Date.now() > deadline) throw new BringUpFailed(`serve.${s.name}`, log, child.exitCode !== null ? `exited ${child.exitCode}` : 'not ready in 30 s');
        await sleep(200);
      }
    }
    runAll('seed', b.seed);
  } catch (e) {
    stop();
    throw e;
  }
  return { ports, env, stop };
}

/** The `--mcp-config` text of `config`'s walk servers for a session whose evidence dir is `evidence`. */
export function walkMcpConfig(config: RepoConfig, evidence: string): string {
  const servers = config.walkthrough?.mcp;
  if (servers === undefined) throw new Error('the repo config names no walkthrough.mcp servers');
  const sub = (v: string): string => v.replaceAll('{evidence}', evidence).replaceAll('{viewport}', WALK_VIEWPORT);
  const out: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    out[name] = { type: 'stdio', command: s.command, args: s.args.map(sub), env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, sub(v)])) };
  }
  return JSON.stringify({ mcpServers: out });
}

/**
 * This repository's walkthrough MCP config (SCHEMAS.md "dev.13", "Repo config"; the devcontainer installs the server and
 * Playwright's Chromium, edd2f51): Playwright MCP, headless, isolated, on Chromium (only Playwright's Chromium is
 * installed; the server defaults to the Chrome channel), screenshots into the evidence dir. Pages are served over HTTP:
 * the server refuses file: URLs.
 */
export const EVAL_REPO_CONFIG: RepoConfig = parseRepoConfig({
  walkthrough: {
    mcp: {
      playwright: { command: 'playwright-mcp', args: ['--headless', '--isolated', '--browser', 'chromium', '--output-dir', '{evidence}', '--viewport-size', '{viewport}'] },
    },
  },
});
