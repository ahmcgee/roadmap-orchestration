// The demo's two files (SCHEMAS.md "dev.13" "The demo"): what the executor wants (`demo.desired.json`, in the run dir, derived
// from the log and rewritten whenever it changes) and what the host runs (`demo.json`, in the host dir, written by the
// supervisor alone). The executor promotes and the supervisor's keeper brings versions up (src/demo/keeper.ts); these two
// files are the whole protocol between them: the keeper reads the desired file, and the executor reads the host record for
// the failures it journals (`demo-failed`) and status for where the demo is.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, readJson } from '../core/fsx.ts';
import { type ArcId, type MilestoneId, type ServeName, type Sha, arcId, milestoneId, serveName, sha } from '../core/ids.ts';
import { Fields, type Read, arrayOf, bool, int, literal, nat, nullable, object, oneOf, positive } from '../core/validate.ts';
import { type AbsPath, type BootId, type IsoTime, type RefName, absPath, bootId, isoTime, refName } from '../core/values.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../core/version.ts';
import { hostPath } from '../host/hostdir.ts';
import { type BringUp, DEMO_NAME, bringUpR } from '../input/plan.ts';

/** `<runDir>/demo.desired.json`: the executor's view of what the demo should run (`writeDesired`, src/demo/promote.ts). */
/** The demo's ref: the promoted SHA (beside the arcs' snapshot refs; `DEMO_NAME` is no arc's). */
export const DEMO_REF: RefName = refName(`refs/roadmap/${DEMO_NAME}`);
export const DESIRED_FILE = 'demo.desired.json';
/** `<hostDir>/demo.json`: the host's one demo instance, written by the supervisor's keeper only. */
export const DEMO_FILE = 'demo.json';

/**
 * What the arc wants the demo to be: `up` (the latest `demo up|down` act; up before any) and `upSeq` (that act's seq, 0 before
 * one: a new act retries a bring-up that failed), and `target`, the latest promotion with its milestone's bring-up in the
 * plan in force, or null before the arc's first promotion. Derived from the log, never authoritative.
 */
export type DemoDesired = Readonly<{
  v: SchemaVersion;
  arc: ArcId;
  repo: AbsPath;
  worktreeRoot: AbsPath;
  up: boolean;
  upSeq: number;
  target: Readonly<{ milestone: MilestoneId; sha: Sha; bringUp: BringUp }> | null;
}>;

/** A process of a demo instance: a serve entry's, by its identity and session (the keeper stops the whole session). */
export type DemoProcess = Readonly<{ name: ServeName; pid: number; start: number; sid: number }>;

/**
 * A version of the product the keeper brought up: from `slot` (a detached checkout of `sha` under `<worktreeRoot>/demo/`),
 * the processes of its serve entries (none for a product with nothing long-lived), on the boot that started them.
 */
export type DemoInstance = Readonly<{
  arc: ArcId;
  repo: AbsPath;
  worktreeRoot: AbsPath;
  slot: AbsPath;
  milestone: MilestoneId;
  sha: Sha;
  bringUp: BringUp;
  boot: BootId;
  processes: readonly DemoProcess[];
}>;

/** The serving instance: `up` while it should run (a host restart restores it), `down` after `demo down` (its slot kept). */
export type DemoServing = DemoInstance & Readonly<{ state: 'up' | 'down' }>;

/**
 * A bring-up of `sha` that failed (the previous version kept serving): `log` its captured output. `upSeq` and `boot` say
 * which attempt it was: the keeper does not try the same version again until a new `demo up` act or a host restart.
 */
export type DemoFailure = Readonly<{ arc: ArcId; milestone: MilestoneId; sha: Sha; log: AbsPath; upSeq: number; boot: BootId; at: IsoTime }>;

/**
 * The host's demo: the stable port of each serve name (allocated once, the first time a bring-up names it, and kept, so the
 * URL never changes), the serving instance, a `trial` the keeper was bringing up beside it (a crash leaves one: the next
 * reconcile stops it first), and the failures in order.
 */
export type DemoRecord = Readonly<{
  v: SchemaVersion;
  ports: Readonly<Record<ServeName, number>>;
  serving: DemoServing | null;
  trial: DemoInstance | null;
  failures: readonly DemoFailure[];
}>;

const shaR: Read<Sha> = (v, p) => sha(v, p);
const absR: Read<AbsPath> = (v, p) => absPath(v, p);
const milestoneR: Read<MilestoneId> = (v, p) => milestoneId(v, p);
const port = int(1, 65_535);

const portMap: Read<Readonly<Record<ServeName, number>>> = (value, path) => {
  const f = new Fields(value, path);
  const out: Record<ServeName, number> = {};
  for (const key of Object.keys(value as object)) out[serveName(key, `${path}.${key}`)] = f.get(key, port);
  f.end();
  return out;
};

export const demoDesired: Read<DemoDesired> = object((f) => ({
  v: f.get('v', literal(SCHEMA_VERSION)),
  arc: f.get('arc', (v, p) => arcId(v, p)),
  repo: f.get('repo', absR),
  worktreeRoot: f.get('worktreeRoot', absR),
  up: f.get('up', bool),
  upSeq: f.get('upSeq', nat),
  target: f.get('target', nullable(object((g) => ({ milestone: g.get('milestone', milestoneR), sha: g.get('sha', shaR), bringUp: g.get('bringUp', bringUpR) })))),
}));

const demoProcess: Read<DemoProcess> = object((f) => ({
  name: f.get('name', (v, p) => serveName(v, p)), pid: f.get('pid', positive), start: f.get('start', nat), sid: f.get('sid', positive),
}));

const instanceFields = (f: Fields): DemoInstance => ({
  arc: f.get('arc', (v, p) => arcId(v, p)),
  repo: f.get('repo', absR),
  worktreeRoot: f.get('worktreeRoot', absR),
  slot: f.get('slot', absR),
  milestone: f.get('milestone', milestoneR),
  sha: f.get('sha', shaR),
  bringUp: f.get('bringUp', bringUpR),
  boot: f.get('boot', (v, p) => bootId(v, p)),
  processes: f.get('processes', arrayOf(demoProcess)),
});

export const demoRecord: Read<DemoRecord> = object((f) => ({
  v: f.get('v', literal(SCHEMA_VERSION)),
  ports: f.get('ports', portMap),
  serving: f.get('serving', nullable(object((g): DemoServing => ({ ...instanceFields(g), state: g.get('state', oneOf(['up', 'down'] as const)) })))),
  trial: f.get('trial', nullable(object(instanceFields))),
  failures: f.get('failures', arrayOf(object((g): DemoFailure => ({
    arc: g.get('arc', (v, p) => arcId(v, p)), milestone: g.get('milestone', milestoneR), sha: g.get('sha', shaR), log: g.get('log', absR),
    upSeq: g.get('upSeq', nat), boot: g.get('boot', (v, p) => bootId(v, p)), at: g.get('at', (v, p) => isoTime(v, p)),
  })))),
}));

export const desiredPath = (runDir: AbsPath): AbsPath => absPath(join(runDir, DESIRED_FILE));

export function readDesired(runDir: AbsPath): DemoDesired | null {
  const path = desiredPath(runDir);
  return existsSync(path) ? demoDesired(readJson(path), DESIRED_FILE) : null;
}

export function readDemoRecord(hostDir: AbsPath): DemoRecord | null {
  const path = hostPath(hostDir, DEMO_FILE);
  return existsSync(path) ? demoRecord(readJson(path), DEMO_FILE) : null;
}

export function writeDemoRecord(hostDir: AbsPath, record: DemoRecord): void {
  atomicJson(hostPath(hostDir, DEMO_FILE), record);
}

export const EMPTY_RECORD: DemoRecord = { v: SCHEMA_VERSION, ports: {}, serving: null, trial: null, failures: [] };

/** The demo's own directory: its slots (`a`, `b`), the `current` link to the serving slot, and the bring-up logs. */
export const demoRoot = (worktreeRoot: AbsPath): AbsPath => absPath(join(worktreeRoot, DEMO_NAME));
export const currentLink = (worktreeRoot: AbsPath): AbsPath => absPath(join(demoRoot(worktreeRoot), 'current'));
