// A milestone product's bring-up (dev.13, plan §2 steps 2–4 and 6; SCHEMAS.md "dev.13", "Bring-up semantics"): code owns
// the product's lifecycle. Every command runs with no shell, from the root of the checkout it brings up, as a contained
// spawn (`proc.spawn{bring-up{milestone, step}}`, a command terminal of purpose `bring-up`) under the owner's parent (a
// walk job), with the bring-up's `env` added to PATH and HOME:
//   1. `setup`, in order, each to exit 0 within BRING_UP_STEP_MS;
//   2. each `serve` entry, started and left running until the owner stops it (`tearDown`: `proc.kill{teardown}`), on the
//      free port code allocated to it (`allocatePorts`), its stdout and stderr linked into the log dir as it runs and
//      copied there when it stops;
//   3. each serve entry probed ready within READY_TIMEOUT_MS: `http`, a GET answering below 500; `log`, the substring in
//      its stdout or stderr (never a regex); a serve process that ends first is not ready;
//   4. `seed`, in order, each to exit 0.
// `{port:<name>}` is substituted everywhere (`substitutePorts`): env values, every argv element, `ready.http` and a
// journey's entry. The first step that fails ends the bring-up `failed`, naming the step and citing its output (copied
// into the log dir); a cancelled step (a stop) ends it `interrupted`. Either way the serve processes started are stopped
// first. A live bring-up runner found by recovery is cancelled (src/runner/reattach.ts): its owner brings the product up
// again.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Parent } from '../core/events.ts';
import { type InvocationId, type ServeName, invocationId, opKey } from '../core/ids.ts';
import type { Containment, Journal } from '../core/interfaces.ts';
import { STDERR_FILE, STDOUT_FILE } from '../core/records.ts';
import { type AbsPath, type IsoTime, absPath, isoTimeOf } from '../core/values.ts';
import { type Argv, type Milestone, PORT_PLACEHOLDER } from '../input/plan.ts';
import { type InvocationOutcome, invocationDir, invoke, killWorkload } from '../pipeline/invoke.ts';
import type { ProductInstance } from '../prompts/inputs.ts';

/** A setup or seed command's deadline. */
export const BRING_UP_STEP_MS = 30 * 60_000;
/** How long a serve entry has to become ready. */
export const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 200;
const BRING_UP_GRACE_MS = 5_000;

/** What a bring-up runs with: the parent's processes and journal, and the host environment it takes PATH and HOME from. */
export type BringUpContext = Readonly<{ journal: Journal; containment: Containment; runDir: AbsPath; hostEnv: Readonly<Record<string, string | undefined>> }>;

/** One bring-up: the milestone's, in `checkout`, under `parent`, its ops keyed by `key`, its logs kept in `logDir`. */
export type BringUpSpec = Readonly<{
  milestone: Milestone;
  checkout: AbsPath;
  ports: Readonly<Record<ServeName, number>>;
  parent: Parent;
  key: string;
  logDir: AbsPath;
  /** The serve processes' deadline: past it their runner ends them (the owner normally stops them first). */
  serveDeadlineAt: IsoTime;
}>;

type Serve = { readonly name: ServeName; readonly inv: InvocationId; readonly done: Promise<InvocationOutcome>; ended: boolean };

/** A running product: what a session is given, and the serve processes `tearDown` stops. */
export type Instance = Readonly<{ product: ProductInstance; serves: readonly Serve[]; logDir: AbsPath }>;

export type BringUpEnd =
  | Readonly<{ kind: 'up'; instance: Instance }>
  /** `step` as the `walk-tools-missing` row names it; `logs` the step's output, copied into the log dir. */
  | Readonly<{ kind: 'failed'; step: string; detail: string; logs: readonly AbsPath[] }>
  | Readonly<{ kind: 'interrupted'; step: string; reason: string }>;

/** One free TCP port on 127.0.0.1 per name, all distinct (each held until every one is chosen). */
export async function allocatePorts(names: readonly ServeName[]): Promise<Readonly<Record<ServeName, number>>> {
  const servers = await Promise.all(names.map(() => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  })));
  const out: Record<ServeName, number> = {};
  names.forEach((n, i) => {
    const address = servers[i]!.address();
    if (address === null || typeof address === 'string') throw new Error('a listening TCP server without a port');
    out[n] = address.port;
  });
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return out;
}

/** `text` with every `{port:<name>}` replaced by its port; a name with no port is a bug (the plan refuses it). */
export function substitutePorts(text: string, ports: Readonly<Record<ServeName, number>>): string {
  return text.replace(PORT_PLACEHOLDER, (_, name: string) => {
    const port = ports[name as ServeName];
    if (port === undefined) throw new Error(`{port:${name}} names no allocated port (${Object.keys(ports).join(', ') || 'none'})`);
    return String(port);
  });
}

/** The bring-up's `env` with its ports substituted: what the product's commands add, and what a session is told. */
export function productEnv(m: Milestone, ports: Readonly<Record<ServeName, number>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(m.bringUp.env).map(([k, v]) => [k, substitutePorts(v, ports)]));
}

function commandEnv(ctx: BringUpContext, env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const base: Record<string, string> = {};
  for (const name of ['PATH', 'HOME']) {
    const value = ctx.hostEnv[name];
    if (value === undefined) throw new Error(`the executor's environment has no ${name}; a bring-up's commands need it`);
    base[name] = value;
  }
  return { ...base, ...env };
}

/** Starts one command (not awaited): its invocation, as soon as its intent is durable, and its end; `name` a serve entry's. */
function start(ctx: BringUpContext, spec: BringUpSpec, step: string, name: ServeName, argv: Argv, env: Readonly<Record<string, string>>, deadlineAt: IsoTime): Serve {
  const done = invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    // An op key has no brackets: `setup[0]` is keyed `setup.0`.
    origin: { type: 'new', key: opKey(`${spec.key}:${step.replace('[', '.').replace(']', '')}`), parent: spec.parent, deadlineAt },
    subject: { purpose: 'bring-up', milestone: spec.milestone.id, step },
    launch: () => ({
      argv: argv.map((a) => substitutePorts(a, spec.ports)), cwd: spec.checkout, env, stdinPath: null, stallMs: null, graceMs: BRING_UP_GRACE_MS,
      terminal: { type: 'command', purpose: 'bring-up', expectedExit: 0 },
    }),
  });
  // `invoke` makes its intent durable before its first await, so the spawn is in the log now.
  const intent = ctx.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'bring-up' && i.expect.subject.step === step && ctx.journal.view.doneOf(i.op) === null).at(-1);
  if (intent === undefined) throw new Error(`${spec.key}: the ${step} spawn has no open intent after its start`);
  const serve: Serve = { name, inv: invocationId(intent.op, intent.ordinal), done, ended: false };
  void done.finally(() => {
    serve.ended = true;
  });
  return serve;
}

/** Copies a step's stdout and stderr into the log dir (`<logDir>/<step>.stdout|stderr`); returns the copies. */
function keepOutput(ctx: BringUpContext, logDir: AbsPath, step: string, inv: InvocationId): readonly AbsPath[] {
  mkdirSync(logDir, { recursive: true });
  const dir = invocationDir(ctx.runDir, inv);
  return [STDOUT_FILE, STDERR_FILE].flatMap((f) => {
    const from = join(dir, f);
    const to = absPath(join(logDir, `${step}.${f}`));
    rmSync(to, { force: true });
    if (!existsSync(from)) return [];
    copyFileSync(from, to);
    return [to];
  });
}

/** How a finished command ended: null when it passed. */
function failure(outcome: InvocationOutcome): Readonly<{ kind: 'failed' | 'interrupted'; detail: string }> | null {
  if (outcome.kind === 'lost') return { kind: 'failed', detail: `${outcome.inv} was lost with its runner` };
  const r = outcome.result;
  if (r.type !== 'command') throw new Error(`${outcome.inv}: a bring-up command produced a ${r.type} result`);
  if (r.verdict === 'pass') return null;
  if (r.verdict === 'cancelled') return { kind: 'interrupted', detail: r.reason };
  return { kind: 'failed', detail: r.verdict === 'fail' ? `exit ${r.exitCode}` : r.verdict };
}

/** Whether serve `s` is ready (see the header). */
async function ready(ctx: BringUpContext, s: Serve, probe: Milestone['bringUp']['serve'][number]['ready'], ports: Readonly<Record<ServeName, number>>): Promise<boolean> {
  if ('http' in probe) {
    try {
      const res = await fetch(substitutePorts(probe.http, ports), { signal: AbortSignal.timeout(2_000) });
      await res.body?.cancel();
      return res.status < 500;
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  }
  const dir = invocationDir(ctx.runDir, s.inv);
  return [STDOUT_FILE, STDERR_FILE].some((f) => existsSync(join(dir, f)) && readFileSync(join(dir, f), 'utf8').includes(probe.log));
}

/** Brings `spec.milestone`'s product up in `spec.checkout` (see the header). */
export async function bringUp(ctx: BringUpContext, spec: BringUpSpec): Promise<BringUpEnd> {
  const { bringUp: b } = spec.milestone;
  const env = productEnv(spec.milestone, spec.ports);
  const runEnv = commandEnv(ctx, env);
  const serves: Serve[] = [];
  const instance: Instance = { product: { checkout: spec.checkout, ports: spec.ports, env }, serves, logDir: spec.logDir };
  const end = async (e: Exclude<BringUpEnd, { kind: 'up' }>): Promise<BringUpEnd> => {
    await tearDown(ctx, instance);
    return e;
  };
  const step = async (name: string, argv: Argv): Promise<Exclude<BringUpEnd, { kind: 'up' }> | null> => {
    const s = start(ctx, spec, name, name as ServeName, argv, runEnv, isoTimeOf(new Date(Date.now() + BRING_UP_STEP_MS)));
    const f = failure(await s.done);
    if (f === null) return null;
    return f.kind === 'interrupted' ? { kind: 'interrupted', step: name, reason: f.detail } : { kind: 'failed', step: name, detail: f.detail, logs: keepOutput(ctx, spec.logDir, name, s.inv) };
  };
  for (const [i, argv] of b.setup.entries()) {
    const f = await step(`setup[${i}]`, argv);
    if (f !== null) return end(f);
  }
  mkdirSync(spec.logDir, { recursive: true });
  for (const entry of b.serve) {
    const name = `serve.${entry.name}`;
    const s = start(ctx, spec, name, entry.name, entry.argv, runEnv, spec.serveDeadlineAt);
    serves.push(s);
    const dir = invocationDir(ctx.runDir, s.inv);
    for (const f of [STDOUT_FILE, STDERR_FILE]) {
      const link = join(spec.logDir, `${name}.${f}`);
      rmSync(link, { force: true });
      symlinkSync(join(dir, f), link);
    }
  }
  for (const [i, entry] of b.serve.entries()) {
    const s = serves[i]!;
    const name = `serve.${entry.name}`;
    const until = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (await ready(ctx, s, entry.ready, spec.ports)) break;
      if (s.ended) {
        const f = failure(await s.done);
        if (f?.kind === 'interrupted') return end({ kind: 'interrupted', step: name, reason: f.detail });
        return end({ kind: 'failed', step: name, detail: `it ended before it was ready (${f?.detail ?? 'exit 0'})`, logs: keepOutput(ctx, spec.logDir, name, s.inv) });
      }
      if (Date.now() > until) {
        const probe = 'http' in entry.ready ? `GET ${substitutePorts(entry.ready.http, spec.ports)} below 500` : `"${entry.ready.log}" in its output`;
        return end({ kind: 'failed', step: name, detail: `not ready within ${READY_TIMEOUT_MS / 1000} s (${probe})`, logs: keepOutput(ctx, spec.logDir, name, s.inv) });
      }
      await sleep(READY_POLL_MS);
    }
  }
  for (const [i, argv] of b.seed.entries()) {
    const f = await step(`seed[${i}]`, argv);
    if (f !== null) return end(f);
  }
  return { kind: 'up', instance };
}

/** Stops every serve process of `instance` still running (`proc.kill{teardown}`), then keeps their output in its log dir. */
export async function tearDown(ctx: BringUpContext, instance: Instance): Promise<void> {
  for (const s of instance.serves) {
    if (!s.ended) await killWorkload(ctx, { inv: s.inv, scope: 'invocation', reason: 'teardown' });
    await s.done;
    keepOutput(ctx, instance.logDir, `serve.${s.name}`, s.inv);
  }
}
