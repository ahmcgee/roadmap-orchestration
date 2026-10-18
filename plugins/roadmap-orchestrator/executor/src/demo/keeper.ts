// The demo keeper (plan §4a; SCHEMAS.md "dev.13" "The demo"): the supervisor's one long-lived demo per host. It runs beside
// the supervisor's executor watch (src/supervisor.ts), reads what the arc wants (`demo.desired.json`, src/demo/promote.ts)
// once a second, and makes the host's instance (`demo.json`) match it, one reconcile at a time:
//
//   a trial a crash left           stop its processes; forget it.
//   down wanted                    stop the serving instance's processes; it stays recorded `down`, its checkout kept.
//   a newer version promoted       swap: the new version is brought up beside the old, in the spare slot on spare ports
//                                  (setup, serve, ready, seed: the demo is reseeded on each promotion); only when it is
//                                  ready is the trial stopped, the old instance stopped and the new one restarted on the
//                                  stable ports (serve and ready again; its seeded data stays in its checkout), and
//                                  `current` linked to its slot. If the trial fails, or the restart on the stable ports
//                                  does, the old instance keeps (or goes back to) serving and the failure is recorded.
//   up wanted, nothing running     restore (a host restart, a `demo up` after `down`, a product that died): the serving
//                                  version, which is the promoted one (`refs/roadmap/demo`), is restarted on its stable
//                                  ports from its slot; a slot that is gone is brought up afresh, as a swap.
//
// The stable ports are allocated once per serve name and kept, so the URL never changes. A version that failed is not
// tried again on the same act and boot (`DemoFailure.upSeq`, `boot`): a `demo up` or a host restart retries it. Every
// process runs in a session of its own and is recorded before anything waits on it, so it outlives the executor and the
// supervisor (the demo keeps serving after the arc completes) and a later keeper can stop it. The executor journals each
// failure as `demo-failed` and its P1 (src/demo/promote.ts). With no desired file (an arc that promoted nothing) the
// host's last demo is kept, and restored after a host restart: one demo per host, the latest any arc promoted.
//
// Layout: `<worktreeRoot>/demo/{a,b}` the two slots (detached git worktrees of the arc's repo), `current` a link to the
// serving slot (a product with nothing long-lived is run from `current/bin`), `logs/<ms>-<sha8>/` each bring-up's output
// (`bringup.log`, the one a failure cites, and `<serve>.log` per serve entry).
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readBootId } from '../contain/proc.ts';
import type { ServeName } from '../core/ids.ts';
import { type AbsPath, type BootId, absPath, isoTimeOf } from '../core/values.ts';
import { GitError, worktreeAdd, worktreeList, worktreePrune, worktreeRemove } from '../git/git.ts';
import type { BringUp } from '../input/plan.ts';
import {
  BringUpAborted, type Ports, awaitReady, bringUpEnv, freePort, logLine, processAlive, runStep, startServe, stopSession,
} from './bringup.ts';
import {
  type DemoDesired, type DemoInstance, type DemoProcess, type DemoRecord, type DemoServing, EMPTY_RECORD, currentLink, demoRoot, readDemoRecord,
  readDesired, writeDemoRecord,
} from './records.ts';

export const KEEPER_TICK_MS = 1_000;
/** How long a supervisor whose arc completed waits for the keeper's last reconcile (the final promotion). */
export const KEEPER_FINAL_MS = 30 * 60_000;
/** The supervisor's role variable (src/supervisor.ts `ROLE_ENV`): never passed to the product. */
const ROLE_ENV = 'ROADMAP_ROLE';

type Target = NonNullable<DemoDesired['target']>;
type Where = Pick<DemoDesired, 'arc' | 'repo' | 'worktreeRoot'>;

const slotsOf = (worktreeRoot: AbsPath): readonly AbsPath[] => [absPath(join(demoRoot(worktreeRoot), 'a')), absPath(join(demoRoot(worktreeRoot), 'b'))];

function baseEnv(): Readonly<Record<string, string | undefined>> {
  const env = { ...process.env };
  delete env[ROLE_ENV];
  return env;
}

/** Stops an instance's processes, session by session. A session id names a session only on the boot that recorded it. */
async function stopAll(i: Readonly<{ boot: BootId; processes: readonly DemoProcess[] }>): Promise<void> {
  if (i.boot !== readBootId()) return;
  for (const p of i.processes) await stopSession(p.sid);
}

/** A fresh detached checkout of `sha` at `slot` (whatever was there before removed). */
function checkout(repo: AbsPath, slot: AbsPath, sha: DemoInstance['sha']): void {
  if (worktreeList(repo).some((e) => e.path === slot)) worktreeRemove(repo, slot);
  rmSync(slot, { recursive: true, force: true });
  worktreePrune(repo);
  mkdirSync(join(slot, '..'), { recursive: true });
  worktreeAdd(repo, slot, { type: 'detached', at: sha });
}

/** Points `current` at `slot`, atomically. */
function link(worktreeRoot: AbsPath, slot: AbsPath): void {
  const at = currentLink(worktreeRoot);
  const tmp = `${at}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(slot, tmp);
  renameSync(tmp, at);
}

function logDir(worktreeRoot: AbsPath, sha: string): AbsPath {
  const dir = absPath(join(demoRoot(worktreeRoot), 'logs', `${Date.now()}-${sha.slice(0, 8)}`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The stable ports for `b`: the record's, plus one allocated now for each serve name it does not have yet. */
async function stablePorts(record: DemoRecord, b: BringUp): Promise<Ports> {
  const ports: Record<ServeName, number> = { ...record.ports };
  for (const s of b.serve) if (ports[s.name] === undefined) ports[s.name] = await freePort(new Set(Object.values(ports)));
  return ports;
}

/** Trial ports for `b`: free now and none of the stable ones. */
async function trialPorts(stable: Ports, b: BringUp): Promise<Ports> {
  const taken = new Set(Object.values(stable));
  const ports: Record<ServeName, number> = {};
  for (const s of b.serve) {
    const p = await freePort(taken);
    taken.add(p);
    ports[s.name] = p;
  }
  return ports;
}

/** What starting an instance's serve entries left: the processes started (all, or up to the one that failed) and why not, or null. */
type Served = Readonly<{ processes: readonly DemoProcess[]; failed: string | null }>;

/** A signal that never aborts: the switch to the stable ports, once begun, runs to its end. */
const NEVER = new AbortController().signal;

/** Starts every serve entry of `instance`'s bring-up on `ports` and waits for each to be ready, recording the processes (`save`) before each wait. */
async function serve(instance: DemoInstance, ports: Ports, log: AbsPath, logs: AbsPath, signal: AbortSignal, save: (processes: readonly DemoProcess[]) => void): Promise<Served> {
  const env = bringUpEnv(baseEnv(), instance.bringUp, ports);
  const started: DemoProcess[] = [];
  for (const entry of instance.bringUp.serve) {
    const out = absPath(join(logs, `${entry.name}.log`));
    logLine(log, `# serve.${entry.name}: ${JSON.stringify(entry.argv)} (output ${out})`);
    const p = startServe(entry, instance.slot, env, ports, out);
    if (typeof p === 'string') return { processes: started, failed: p };
    started.push(p);
    save(started);
    const notReady = await awaitReady(entry, p, ports, out, signal);
    if (notReady !== null) return { processes: started, failed: notReady };
  }
  return { processes: started, failed: null };
}

/** The trial: setup, serve and ready, then seed, of a fresh slot on `ports`. */
async function bringUp(instance: DemoInstance, ports: Ports, log: AbsPath, logs: AbsPath, signal: AbortSignal, save: (processes: readonly DemoProcess[]) => void): Promise<Served> {
  const env = bringUpEnv(baseEnv(), instance.bringUp, ports);
  for (const [i, argv] of instance.bringUp.setup.entries()) {
    const r = await runStep(`setup[${i}]`, argv, instance.slot, env, ports, log, signal);
    if (!r.ok) return { processes: [], failed: r.detail };
  }
  const served = await serve(instance, ports, log, logs, signal, save);
  if (served.failed !== null) return served;
  for (const [i, argv] of instance.bringUp.seed.entries()) {
    const r = await runStep(`seed[${i}]`, argv, instance.slot, env, ports, log, signal);
    if (!r.ok) return { processes: served.processes, failed: r.detail };
  }
  return served;
}

/** The keeper's state between ticks: the record, read once and written through (the supervisor is its one writer). */
class Keeper {
  #record: DemoRecord;
  readonly #hostDir: AbsPath;
  readonly #signal: AbortSignal;

  constructor(hostDir: AbsPath, signal: AbortSignal) {
    this.#hostDir = hostDir;
    this.#signal = signal;
    this.#record = readDemoRecord(hostDir) ?? EMPTY_RECORD;
  }

  get record(): DemoRecord {
    return this.#record;
  }

  #save(next: DemoRecord): void {
    this.#record = next;
    writeDemoRecord(this.#hostDir, next);
  }

  #fail(instance: DemoInstance, log: AbsPath, upSeq: number, detail: string): void {
    logLine(log, `# failed: ${detail}`);
    const failure = { arc: instance.arc, milestone: instance.milestone, sha: instance.sha, log, upSeq, boot: readBootId(), at: isoTimeOf(new Date()) };
    this.#save({ ...this.#record, failures: [...this.#record.failures, failure] });
  }

  /** Whether `sha` was already tried (and failed) on this act and boot. */
  #tried(sha: string, upSeq: number): boolean {
    const boot = readBootId();
    return this.#record.failures.some((f) => f.sha === sha && f.upSeq === upSeq && f.boot === boot);
  }

  /** One reconcile against `desired` (see the header). */
  async reconcile(desired: DemoDesired | null): Promise<void> {
    const trial = this.#record.trial;
    if (trial !== null) {
      await stopAll(trial);
      this.#save({ ...this.#record, trial: null });
    }
    const serving = this.#record.serving;
    if (desired !== null && !desired.up) {
      if (serving !== null && serving.state === 'up') {
        await stopAll(serving);
        this.#save({ ...this.#record, serving: { ...serving, state: 'down', processes: [] } });
      }
      return;
    }
    const upSeq = desired?.upSeq ?? 0;
    const target = desired?.target ?? null;
    if (target !== null && desired !== null && (serving === null || serving.sha !== target.sha || serving.arc !== desired.arc)) {
      if (!this.#tried(target.sha, upSeq)) await this.#swap(desired, target, upSeq);
      return;
    }
    if (serving !== null && !this.#running(serving) && !this.#tried(serving.sha, upSeq)) await this.#restore(serving, upSeq);
  }

  #running(s: DemoServing): boolean {
    return s.state === 'up' && s.boot === readBootId() && s.processes.length === s.bringUp.serve.length && s.processes.every(processAlive);
  }

  async #swap(where: Where, target: Target, upSeq: number): Promise<void> {
    const old = this.#record.serving;
    const spare = slotsOf(where.worktreeRoot).find((s) => s !== old?.slot);
    if (spare === undefined) throw new Error('two slots and one serving: a spare slot always exists');
    const logs = logDir(where.worktreeRoot, target.sha);
    const log = absPath(join(logs, 'bringup.log'));
    const instance: DemoInstance = {
      arc: where.arc, repo: where.repo, worktreeRoot: where.worktreeRoot, slot: spare, milestone: target.milestone, sha: target.sha,
      bringUp: target.bringUp, boot: readBootId(), processes: [],
    };
    const stable = await stablePorts(this.#record, target.bringUp);
    const trialAt = await trialPorts(stable, target.bringUp);
    this.#save({ ...this.#record, ports: stable, trial: instance });
    logLine(log, `# demo ${target.milestone} at ${target.sha} in ${spare}: trial ports ${JSON.stringify(trialAt)}, stable ports ${JSON.stringify(stable)}`);
    let trial: Served;
    try {
      checkout(where.repo, spare, target.sha);
      trial = await bringUp(instance, trialAt, log, logs, this.#signal, (processes) => this.#save({ ...this.#record, trial: { ...instance, processes } }));
    } catch (error) {
      if (this.#record.trial !== null) await stopAll(this.#record.trial);
      this.#save({ ...this.#record, trial: null });
      if (error instanceof BringUpAborted) {
        logLine(log, `# abandoned: ${error.message}`);
        return;
      }
      if (!(error instanceof GitError)) throw error;
      this.#fail(instance, log, upSeq, `checkout of ${target.sha}: ${error.message}`);
      return;
    }
    await stopAll({ boot: instance.boot, processes: trial.processes });
    this.#save({ ...this.#record, trial: null });
    if (trial.failed !== null) {
      this.#fail(instance, log, upSeq, trial.failed);
      return;
    }
    // Ready and seeded beside the old one: switch to the stable ports.
    if (old !== null) await stopAll(old);
    const switched = await serve(instance, stable, log, logs, NEVER, (processes) => this.#save({ ...this.#record, serving: { ...instance, processes, state: 'up' } }));
    if (switched.failed === null) {
      this.#save({ ...this.#record, serving: { ...instance, processes: switched.processes, state: 'up' } });
      link(where.worktreeRoot, spare);
      logLine(log, '# serving on the stable ports');
      return;
    }
    await stopAll({ boot: instance.boot, processes: switched.processes });
    this.#save({ ...this.#record, serving: old === null ? null : { ...old, processes: [] } });
    this.#fail(instance, log, upSeq, `on the stable ports: ${switched.failed}`);
    if (old !== null && old.state === 'up') await this.#restore({ ...old, processes: [] }, upSeq);
  }

  /** Restarts the serving version on its stable ports from its slot; a slot that is gone is brought up afresh. */
  async #restore(serving: DemoServing, upSeq: number): Promise<void> {
    await stopAll(serving);
    if (!existsSync(serving.slot)) {
      this.#save({ ...this.#record, serving: null });
      await this.#swap(serving, { milestone: serving.milestone, sha: serving.sha, bringUp: serving.bringUp }, upSeq);
      return;
    }
    const logs = logDir(serving.worktreeRoot, serving.sha);
    const log = absPath(join(logs, 'bringup.log'));
    logLine(log, `# restore ${serving.milestone} at ${serving.sha} from ${serving.slot} on ${JSON.stringify(this.#record.ports)}`);
    const restarted: DemoServing = { ...serving, boot: readBootId(), processes: [], state: 'up' };
    this.#save({ ...this.#record, serving: restarted });
    const served = await serve(restarted, this.#record.ports, log, logs, NEVER, (processes) => this.#save({ ...this.#record, serving: { ...restarted, processes } }));
    if (served.failed === null) {
      this.#save({ ...this.#record, serving: { ...restarted, processes: served.processes } });
      link(serving.worktreeRoot, serving.slot);
      return;
    }
    await stopAll({ boot: restarted.boot, processes: served.processes });
    this.#save({ ...this.#record, serving: restarted });
    this.#fail(serving, log, upSeq, served.failed);
  }
}

/** The running keeper: `finish` ends it (see `startDemoKeeper`). */
export type DemoKeeper = Readonly<{ finish: (final: boolean) => Promise<void> }>;

/**
 * Starts the keeper over the arc whose run dir is `runDir`. `finish(false)` (a stop, a refusal, the crash limit) abandons a
 * trial in progress, leaving the old version serving; `finish(true)` (the arc completed) lets the current reconcile end and
 * runs one more, bounded by `KEEPER_FINAL_MS`, so the final promotion is serving when the supervisor exits. An error stops
 * the keeper and goes to the supervisor's stderr; the demo keeps what it had.
 */
export function startDemoKeeper(hostDir: AbsPath, runDir: AbsPath): DemoKeeper {
  const abort = new AbortController();
  const keeper = new Keeper(hostDir, abort.signal);
  let ending = false;
  const report = (error: unknown): void => void process.stderr.write(`demo keeper stopped: ${(error as Error).stack ?? String(error)}\n`);
  const loop = (async () => {
    while (!ending) {
      await keeper.reconcile(readDesired(runDir));
      if (!ending) await sleep(KEEPER_TICK_MS);
    }
  })().catch(report);
  return {
    finish: async (final) => {
      ending = true;
      if (!final) abort.abort();
      await loop;
      if (!final) return;
      const timer = new AbortController();
      await Promise.race([
        keeper.reconcile(readDesired(runDir)).catch(report),
        sleep(KEEPER_FINAL_MS, undefined, { signal: timer.signal }).catch(() => undefined),
      ]);
      timer.abort();
    },
  };
}

/** One reconcile, as one keeper tick runs it, over the record as it is now (the integrated tests drive the keeper with it). */
export async function reconcileOnce(hostDir: AbsPath, runDir: AbsPath): Promise<DemoRecord> {
  const keeper = new Keeper(hostDir, NEVER);
  await keeper.reconcile(readDesired(runDir));
  return keeper.record;
}
