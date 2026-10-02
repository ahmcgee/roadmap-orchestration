// `roadmap gc --repo <path> [--keep K] [--dry-run]` (DESIGN-1.0.md §2.3, §2.9 "Growth across arcs"; plan "Growth
// controls", A20/H5, G6-G8): a CLI act under the host lock, not a queued command. It prunes the run dirs of this
// repo's **sealed** arcs, then the host dir's old generation files and residue archives.
//
// Sealed (A20, H5; `sealingOf`): the arc's `arc-completed` follows its last work (`lastWorkSeq`: no later mutation
// fact, admitting apply, reopen, or stage, job or command intent), its queue holds no pending command, the
// completion head is still in the integration branch's history (`merge-base --is-ancestor`; head equality is not
// required, so a later arc publishing onto the same branch leaves it sealed), and `refs/roadmap/<arc>` verifies
// (manifest and record closure, src/git/snapshot.ts) at a high-water at or past the completion, its `events.jsonl`
// the live log's prefix. Resume keeps the stricter active completion (`HolisticFold.completion.active`).
//
// Under its claim gc reads every arc of the repo, then deletes only if every verification passed (G6): a snapshot
// that does not verify refuses the whole gc and deletes nothing. An arc not sealed is reported and left whole. For
// the sealed arcs, newest completion first, the first K keep their run dir (the authoritative records the snapshot
// carries, plus the queue and state) and lose only their raw evidence; the rest lose the whole run dir, which the
// ref restores (`snapshot.reconstruct-alone`). The deletions, in order:
//   1. raw evidence of each kept sealed arc: every evidence snapshot's captured `files/` (its manifest stays), a
//      witness run's `witness.lines` anywhere under `evidence/` (a job lane's, a candidate journey's, a mutant's; its
//      `witness.json` stays), each invocation's `stdout`, `stderr` and `runner.log`
//      (`result.json`, `reads.json` and the launch records stay), and the implementers' `work/`;
//   2. a `<arc>.gc-deleting` a crashed gc left, then each run dir beyond K: renamed to `<arc>.gc-deleting`, then
//      removed;
//   3. the host's generation files beyond the last K generations before gc's own claim (`pruneGenerationFiles`),
//      keeping every generation an open needs-user item of this repo's arcs cites as evidence;
//   4. residue archives beyond the first K on the chain from the index's `compacted` head, and any archive off the
//      chain (a crashed compaction's link of the live index excepted: the next compaction continues from it).
// A partial gc is safe to re-run: nothing a verification reads is deleted before the last run-dir rename, every
// delete is of a path that the next gc lists again or no longer finds, and the rename makes a half-removed run dir
// a leftover by name (crash point `gc.run-dir.after-rename`). A crashed gc leaves its claim dead with no executor
// recorded; the next gc or start takes it over.
//
// The claim names this repo's arc with the newest log (so it names a run dir), which gc never deletes in that run.
// The host is refused when a live process holds it, and when its last executor died holding it: that arc is
// recovered by its next start, not by gc. `--dry-run` is refused the same way, then reads without claiming (no
// generation issued, no tail repaired) and lists what a gc claiming the next generation would delete.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import { durableRename, durableUnlink } from '../core/fsx.ts';
import { type ArcId, arcId, sha256 } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { HostLockClaim } from '../core/records.ts';
import { EVENTS_FILE, type LogSnapshot, readJournal } from '../core/log.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type IsoTime, absPath, branchRef } from '../core/values.ts';
import { isAncestor } from '../git/ff.ts';
import { gitCommonDir, refTarget } from '../git/git.ts';
import { eventsPrefix, snapshotRef, verifySnapshot } from '../git/snapshot.ts';
import { RESIDUES, hostPath } from '../host/hostdir.ts';
import { isAlive, selfIdentity } from '../host/liveness.ts';
import { type HostRefusal, claimHost, lastGeneration, readClaim, releaseHost } from '../host/lock.ts';
import { readOwner } from '../host/owner.ts';
import { type CompactedHead, RESIDUE_ARCHIVE, verifyIndexBytes } from '../host/residues.ts';
import { runDir as runDirOf } from '../input/cli.ts';
import { planInForce } from '../input/inforce.ts';
import { WITNESS_LINES } from '../holistic/witness.ts';
import { fileNeedsUser, recordOf } from '../needsuser.ts';
import { reconcilePreviousArc } from '../recover/recover.ts';
import { generationFilesToPrune, pruneGenerationFiles } from '../supervisor.ts';
import { pendingCommandIds } from './queue.ts';

/** K when `--keep` is not given: sealed arcs keeping their run dir, generations and archives kept. */
export const DEFAULT_KEEP = 3;
/** The suffix a run dir being removed carries (step 2). */
export const GC_DELETING = '.gc-deleting';

export type Sealing =
  | Readonly<{ kind: 'sealed'; completedAt: IsoTime }>
  | Readonly<{ kind: 'open'; reason: string }>
  /** The snapshot ref does not verify, or is not this log's: gc refuses and deletes nothing. */
  | Readonly<{ kind: 'mismatch'; detail: string }>;

/** Whether the arc whose log `log` is (read from `runDir`) is sealed (A20, H5), against `repo`'s refs. */
export function sealingOf(repo: AbsPath, runDir: AbsPath, log: LogSnapshot): Sealing {
  const { view } = log;
  const completion = view.holistic().completion;
  if (completion === null) return { kind: 'open', reason: 'not completed' };
  if (view.lastWorkSeq() > completion.seq) return { kind: 'open', reason: `work at seq ${view.lastWorkSeq()} follows the completion at seq ${completion.seq}` };
  const pending = pendingCommandIds(runDir);
  if (pending.length > 0) return { kind: 'open', reason: `pending commands ${pending.join(', ')}` };
  const inForce = planInForce(runDir, view);
  if (inForce === null) throw new Error(`arc ${view.arc} completed with no plan in force`);
  const branch = branchRef(inForce.plan.integrationBranch);
  const tip = refTarget(repo, branch);
  if (tip === null) return { kind: 'open', reason: `the integration branch ${branch} is gone` };
  if (!isAncestor(repo, completion.head, tip)) return { kind: 'open', reason: `the completion head ${completion.head} is not in ${branch}'s history (at ${tip})` };

  const ref = snapshotRef(view.arc);
  const at = refTarget(repo, ref);
  if (at === null) return { kind: 'open', reason: `no ${ref}: the terminal snapshot is not published` };
  let check: ReturnType<typeof verifySnapshot>;
  try {
    check = verifySnapshot(repo, at);
  } catch (error) {
    if (error instanceof SchemaError || error instanceof SyntaxError) return { kind: 'mismatch', detail: `${ref} at ${at}: ${error.message}` };
    throw error;
  }
  if (check.kind === 'mismatch') return { kind: 'mismatch', detail: `${ref} at ${at}: ${check.detail}` };
  const { manifest } = check;
  if (manifest.arc !== view.arc) return { kind: 'mismatch', detail: `${ref} at ${at} is a snapshot of arc ${manifest.arc}` };
  if (manifest.highWater < completion.seq) {
    return { kind: 'open', reason: `${ref} is at high-water ${manifest.highWater}, before the completion at seq ${completion.seq}: the terminal snapshot is not published` };
  }
  const lastSeq = log.events.at(-1)?.seq ?? 0;
  if (lastSeq < manifest.highWater) return { kind: 'mismatch', detail: `${ref} at ${at} holds ${manifest.highWater} events; the log holds ${lastSeq}` };
  const logged = manifest.files.find((f) => f.path === EVENTS_FILE);
  if (logged === undefined) throw new Error(`${ref} at ${at} verified without ${EVENTS_FILE}`);
  if (sha256(sha256Hex(eventsPrefix(runDir, manifest.highWater).bytes)) !== logged.sha256) {
    return { kind: 'mismatch', detail: `${ref} at ${at}: its ${EVENTS_FILE} is not the first ${manifest.highWater} lines of ${join(runDir, EVENTS_FILE)}` };
  }
  const completedAt = log.events.find((e) => e.seq === completion.seq)?.at;
  if (completedAt === undefined) throw new Error(`arc ${view.arc}: no event at the completion's seq ${completion.seq}`);
  return { kind: 'sealed', completedAt };
}

export type GcRequest = Readonly<{ hostDir: AbsPath; repo: AbsPath; keep: number; dryRun: boolean }>;

export type GcRefusal =
  | HostRefusal
  /** The host's last executor died holding it: its arc's next start recovers it first. */
  | Readonly<{ kind: 'executor-died'; arc: ArcId; generation: number }>
  | Readonly<{ kind: 'snapshot-mismatch'; arcs: readonly Readonly<{ arc: ArcId; detail: string }>[] }>
  | Readonly<{ kind: 'no-arcs'; runtime: AbsPath }>;

/** What gc did with an arc: `evidence` (sealed, run dir kept), `run-dir` (sealed, beyond K) or `kept` (not sealed, why). */
export type ArcAction = Readonly<{ arc: ArcId; action: 'evidence' | 'run-dir' } | { arc: ArcId; action: 'kept'; reason: string }>;

export type GcReport = Readonly<{
  dryRun: boolean;
  keep: number;
  /** gc's own claim's generation. */
  generation: number;
  arcs: readonly ArcAction[];
  /** Every path deleted (or, dry, to delete), in deletion order; a run dir by its own name. */
  deleted: readonly AbsPath[];
}>;

export type GcOutcome = Readonly<{ kind: 'refused'; rejection: GcRefusal }> | Readonly<{ kind: 'done'; report: GcReport }>;

type ArcDir = Readonly<{ arc: ArcId; runDir: AbsPath }>;

/** Runs gc for `request.repo` against the host dir `request.hostDir`. */
export async function gc(request: GcRequest): Promise<GcOutcome> {
  const { hostDir, repo, keep } = request;
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`gc keep ${keep}: a positive integer`);
  const commonDir = gitCommonDir(repo);
  const runtime = absPath(join(commonDir, 'roadmap-runtime'));
  const names = existsSync(runtime) ? readdirSync(runtime).sort() : [];
  const leftovers = names.filter((n) => n.endsWith(GC_DELETING)).map((n) => absPath(join(runtime, n)));
  const arcs: readonly ArcDir[] = names.filter((n) => !n.endsWith(GC_DELETING)).map((n) => {
    const arc = arcId(n, `${runtime}/${n}`);
    return { arc, runDir: runDirOf(commonDir, arc) };
  });
  if (arcs.length === 0) return { kind: 'refused', rejection: { kind: 'no-arcs', runtime } };

  const held = readClaim(hostDir);
  const busy = held === null ? null : heldRefusal(hostDir, held);
  if (busy !== null) return { kind: 'refused', rejection: busy };
  const named = newestLog(arcs);
  const report = (plan: Plan, generation: number, generations: readonly string[], archives: readonly AbsPath[]): GcOutcome => ({
    kind: 'done',
    report: {
      dryRun: request.dryRun, keep, generation, arcs: plan.actions,
      deleted: [...plan.evidence, ...leftovers, ...plan.runDirs, ...generations.map((n) => hostPath(hostDir, n)), ...archives],
    },
  });
  // Generations: K besides gc's own claim.
  if (request.dryRun) {
    const plan = planGc(request, arcs, named.arc);
    if ('mismatches' in plan) return { kind: 'refused', rejection: { kind: 'snapshot-mismatch', arcs: plan.mismatches } };
    const generation = lastGeneration(hostDir) + 1;
    return report(plan, generation, generationFilesToPrune(hostDir, generation, keep + 1, plan.cited), obsoleteArchives(hostDir, keep));
  }

  const claimed = await claimHost(hostDir, { arc: named.arc, runDir: named.runDir, repo, supervisor: selfIdentity() }, reconcilePreviousArc);
  if (claimed.kind === 'refused') return { kind: 'refused', rejection: claimed.rejection };
  const { claim } = claimed;
  try {
    const plan = planGc(request, arcs, named.arc);
    if ('mismatches' in plan) return { kind: 'refused', rejection: { kind: 'snapshot-mismatch', arcs: plan.mismatches } };
    deleteRunData(plan, leftovers);
    const generations = pruneGenerationFiles(hostDir, claim, keep + 1, plan.cited);
    const archives = obsoleteArchives(hostDir, keep);
    for (const path of archives) durableUnlink(path);
    return report(plan, claim.generation, generations, archives);
  } finally {
    releaseHost(hostDir, claim);
  }
}

/** Why a held host refuses gc: a live holder, or an executor that died holding it; null for a dead claim gc may take over. */
function heldRefusal(hostDir: AbsPath, held: HostLockClaim): GcRefusal | null {
  if (isAlive(held.supervisor, held.bootId)) return { kind: 'host-busy', holder: 'owner', arc: held.arc, generation: held.generation, pid: held.supervisor.pid };
  const owner = readOwner(hostDir);
  if (owner === null || owner.nonce !== held.nonce || owner.executor === null) return null;
  if (isAlive(owner.executor, held.bootId)) return { kind: 'host-busy', holder: 'owner', arc: held.arc, generation: held.generation, pid: owner.executor.pid };
  return { kind: 'executor-died', arc: held.arc, generation: held.generation };
}

/** The arc whose log was written last (a run dir with no log counts as oldest): the one gc's claim names. */
function newestLog(arcs: readonly ArcDir[]): ArcDir {
  const mtime = (a: ArcDir): number => {
    const path = join(a.runDir, EVENTS_FILE);
    return existsSync(path) ? statSync(path).mtimeMs : 0;
  };
  return arcs.reduce((best, a) => (mtime(a) > mtime(best) ? a : best));
}

type Plan = Readonly<{
  actions: readonly ArcAction[];
  /** Raw evidence of the sealed arcs keeping their run dir. */
  evidence: readonly AbsPath[];
  runDirs: readonly AbsPath[];
  /** The evidence paths of every open needs-user item of the repo's arcs. */
  cited: readonly AbsPath[];
}>;

/** Reads and verifies every arc; decides nothing to delete unless every snapshot verified. */
function planGc(request: GcRequest, arcs: readonly ArcDir[], named: ArcId): Plan | Readonly<{ mismatches: readonly Readonly<{ arc: ArcId; detail: string }>[] }> {
  const sealed: { dir: ArcDir; completedAt: IsoTime }[] = [];
  const open = new Map<ArcId, string>();
  const mismatches: { arc: ArcId; detail: string }[] = [];
  const cited: AbsPath[] = [];
  for (const dir of arcs) {
    const log = readJournal(dir.runDir, dir.arc);
    for (const item of log.view.needsUser()) if (item.ack === null) cited.push(...recordOf(dir.runDir, item.id).evidence);
    for (const record of fileNeedsUser(dir.runDir, log.view)) cited.push(...record.evidence);
    const sealing = sealingOf(request.repo, dir.runDir, log);
    if (sealing.kind === 'sealed') sealed.push({ dir, completedAt: sealing.completedAt });
    else if (sealing.kind === 'open') open.set(dir.arc, sealing.reason);
    else mismatches.push({ arc: dir.arc, detail: sealing.detail });
  }
  if (mismatches.length > 0) return { mismatches };

  sealed.sort((a, b) => (a.completedAt === b.completedAt ? (a.dir.arc < b.dir.arc ? -1 : 1) : a.completedAt > b.completedAt ? -1 : 1));
  const whole = new Set(sealed.filter((s, i) => i >= request.keep && s.dir.arc !== named).map((s) => s.dir.arc));
  const actions = arcs.map((d): ArcAction => {
    const reason = open.get(d.arc);
    if (reason !== undefined) return { arc: d.arc, action: 'kept', reason };
    return { arc: d.arc, action: whole.has(d.arc) ? 'run-dir' : 'evidence' };
  });
  return {
    actions,
    evidence: sealed.filter((s) => !whole.has(s.dir.arc)).flatMap((s) => rawEvidence(s.dir)),
    runDirs: arcs.filter((d) => whole.has(d.arc)).map((d) => d.runDir),
    cited,
  };
}

/** The raw evidence an arc's run dir holds (see the header, step 1), existing paths only. */
function rawEvidence({ arc, runDir }: ArcDir): readonly AbsPath[] {
  const out: AbsPath[] = [];
  const add = (path: string): void => {
    if (existsSync(path)) out.push(absPath(path));
  };
  for (const intent of readJournal(runDir, arc).view.opsOf('evidence.snapshot')) {
    const dest = intent.expect.dest;
    if (!dest.startsWith(`${runDir}/`)) throw new Error(`arc ${arc}: evidence snapshot ${intent.op} wrote to ${dest}, outside its run dir`);
    add(join(dest, 'files'));
  }
  const evidence = join(runDir, 'evidence');
  if (existsSync(evidence)) {
    for (const path of readdirSync(evidence, { recursive: true, encoding: 'utf8' }).sort()) if (basename(path) === WITNESS_LINES) add(join(evidence, path));
  }
  const inv = join(runDir, 'inv');
  if (existsSync(inv)) for (const dir of readdirSync(inv).sort()) for (const file of ['stdout', 'stderr', 'runner.log']) add(join(inv, dir, file));
  add(join(runDir, 'work'));
  return [...new Set(out)];
}

/** Steps 1 and 2: raw evidence, leftovers, then each run dir beyond K by rename and removal. */
function deleteRunData(plan: Plan, leftovers: readonly AbsPath[]): void {
  for (const path of plan.evidence) rmSync(path, { recursive: true });
  for (const path of leftovers) rmSync(path, { recursive: true });
  for (const runDir of plan.runDirs) {
    const doomed = `${runDir}${GC_DELETING}`;
    durableRename(runDir, doomed);
    crashPoint('gc.run-dir.after-rename');
    rmSync(doomed, { recursive: true });
  }
}

/** Step 4: residue archives beyond the first `keep` on the index's chain, and any off it but the live index's link. */
function obsoleteArchives(dir: AbsPath, keep: number): readonly AbsPath[] {
  const index = hostPath(dir, RESIDUES);
  const chain: string[] = [];
  let head = existsSync(index) ? headOf(dir, index) : null;
  while (head !== null && existsSync(hostPath(dir, head.archive))) {
    chain.push(head.archive);
    head = headOf(dir, hostPath(dir, head.archive));
  }
  const retained = new Set(chain.slice(0, keep));
  const live = existsSync(index) ? statSync(index).ino : null;
  return readdirSync(dir).sort()
    .filter((name) => RESIDUE_ARCHIVE.test(name) && !retained.has(name) && statSync(hostPath(dir, name)).ino !== live)
    .map((name) => hostPath(dir, name));
}

/**
 * The `compacted` head of an index file (the live one or an archive), or null. A head is only ever the first line,
 * so only that line is read and verified: read-only, beside a live executor's appends too.
 */
function headOf(dir: AbsPath, path: AbsPath): CompactedHead | null {
  const bytes = readFileSync(path);
  const nl = bytes.indexOf(0x0a);
  return nl === -1 ? null : verifyIndexBytes(dir, bytes.subarray(0, nl + 1)).head;
}
