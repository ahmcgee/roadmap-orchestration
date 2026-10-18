// The demo, executor side (DESIGN-1.0.md §2.12; plan §4a; SCHEMAS.md "dev.13" "The demo"): a stable build of what the arc is
// building, for the owner to pick up when they choose. Walks and lanes never touch it. The supervisor's keeper runs it
// (src/demo/keeper.ts); this module decides what it should run, from the log alone, and records the owner's acts.
//
// - **Settled**: the walk job's rule, one for the rounds brake, the status state and the demo (src/walk/milestones.ts
//   `settledMilestones`). The demo takes the settled milestones whose node passed and that have no active walkthrough P1
//   (`demoSettled`); the settled SHA is the last round's walked SHA, what that walk confirmed.
// - **Promotion** (`promoteDemo`, each scheduler tick of an arc with milestones): unless the demo is held, the settled
//   milestone whose closing walk is the latest is promoted when it is newer (its walk started after the latest
//   promotion's position, on another SHA; the integration branch only moves forward): `demo-promoted{milestone, sha}`,
//   then `refs/roadmap/demo` moved to it. The fact comes first: the ref follows the facts (`syncDemoRef`, after each
//   promotion and on the first tick of every start), so a crash between the two
//   (crash point `demo-promoted`) is mended by the next start. A milestone that stays blocked never promotes, so the demo
//   stays at the last good one.
// - **Completion** (`promoteFinal`, right before `arc-completed`): an arc with a settled milestone and no milestone with an
//   active walkthrough P1 promotes its final tip, named by its last settled milestone, unless held.
// - **The owner's acts** (`actOnDemo`, the `demo` command, a mutation with no scope): `demo-acted{command, act}`. `hold`
//   freezes promotion (refused while held), `release` resumes it and promotes the latest settled milestone at once when
//   newer (refused unless held), `down` stops the instance (refused while down), `up` starts it, or retries a bring-up that
//   failed. Before any act the demo is up and not held.
// - **The keeper's inputs** (`writeDesired`): `<runDir>/demo.desired.json`, rewritten when it changes, carries the act state
//   and the latest promotion with its milestone's bring-up in the plan in force.
// - **Failures** (`journalDemoFailures`): each failure of this arc the host record (`demo.json`) lists and the log does not
//   (by its log path) becomes `demo-failed{milestone, sha, log}`, then a walkthrough P1 on its milestone (source
//   `demo{sha}`, cause `demo bring-up failed`, citing the log): a bring-up that works for walks but not for the demo is a
//   real defect. A crash between the two opens the P1 on the next tick.
// - **The owner's view** (`demoView`, status and the brief): the promotion, whether held and up, what changed since the
//   promotion before it (the milestones settled, the tweaks kept and the walkthrough fixes landed between the two), and the
//   active walkthrough P2s of the passed milestones as known rough edges.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import { durableWrite } from '../core/fsx.ts';
import { canonicalJson } from '../core/json.ts';
import type { CommandId, FindingId, JobId, MilestoneId, ServeName, Sha, UnitId } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import type { DemoAct } from '../core/records.ts';
import { isActive, openFinding } from '../holistic/findings.ts';
import { repairUnits } from '../pipeline/reproduce.ts';
import { type Repairs, activeWalkP1s, settledMilestones } from '../walk/milestones.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { isAncestor } from '../git/ff.ts';
import { refTarget, updateRefCas } from '../git/git.ts';
import { type PlanM1, type PlanUnit, milestoneOf, milestonesOf } from '../input/plan.ts';
import type { Effect } from '../commands/apply.ts';
import { readBootId } from '../contain/proc.ts';
import { detachedAlive } from '../walk/bringup.ts';
import { DEMO_REF, type DemoDesired, currentLink, desiredPath, readDemoRecord } from './records.ts';

/** The cause of every demo bring-up P1: one per milestone while active (dedupe), whatever the SHA. */
export const DEMO_FAILED_CAUSE = 'demo bring-up failed';

/** What the demo reads of an arc: its log, the plan in force, and the units whose specs repair something. */
export type DemoReader = Readonly<{ view: JournalView; plan: PlanM1; repairs: Repairs }>;

/** What promotion writes through: the arc's journal and repo, its run and plan dirs (the desired file, the specs) and the host dir. */
export type DemoContext = Readonly<{ journal: Journal; runDir: AbsPath; planDir: AbsPath; repo: AbsPath; hostDir: AbsPath; plan: () => PlanM1 }>;

/** A settled milestone the demo may promote: its last round's walk (`job`, started at `walkSeq` on `sha`). */
export type SettledMilestone = Readonly<{ milestone: MilestoneId; job: JobId; sha: Sha; walkSeq: number }>;

/** The settled milestones whose node passed and that have no active walkthrough P1, by their last walk's start. */
export function demoSettled(r: DemoReader): readonly SettledMilestone[] {
  return settledMilestones(r.view, r.plan, r.repairs)
    .filter((s) => s.passed && activeWalkP1s(r.view, s.milestone).length === 0)
    .map((s) => ({ milestone: s.milestone, job: s.last.job, sha: s.last.sha, walkSeq: s.last.seq }))
    .sort((x, y) => x.walkSeq - y.walkSeq);
}

const readerOf = (ctx: DemoContext): DemoReader => ({ view: ctx.journal.view, plan: ctx.plan(), repairs: repairUnits(ctx) });

/** A promotion as the log records it, with its position: the seq up to which the promoted SHA holds the arc's work. */
export type Promotion = Readonly<{ milestone: MilestoneId; sha: Sha; seq: number; position: number }>;

/** The demo's facts: the promotions in order, the hold in force, the latest up or down act, the failures journaled. */
export type DemoFacts = Readonly<{
  promotions: readonly Promotion[];
  held: CommandId | null;
  up: boolean;
  /** The seq of the latest `up` or `down` act; 0 before one. */
  upSeq: number;
  failedLogs: ReadonlySet<string>;
  failures: readonly Readonly<{ milestone: MilestoneId; sha: Sha; log: AbsPath; seq: number }>[];
}>;

export function demoFacts(view: JournalView): DemoFacts {
  const facts = view.walkFacts();
  const promotions: Promotion[] = [];
  let held: CommandId | null = null;
  let up = true;
  let upSeq = 0;
  const failures: { milestone: MilestoneId; sha: Sha; log: AbsPath; seq: number }[] = [];
  for (const x of facts) {
    const f = x.fact;
    if (f.kind === 'demo-promoted') {
      // A settlement's promotion holds what its closing walk walked (the milestone's last walk on that SHA before it);
      // the completion's (the final tip, no walk on it) everything before its fact.
      const walk = facts.filter((w) => w.seq < x.seq && w.fact.kind === 'walk-started' && w.fact.milestone === f.milestone && w.fact.sha === f.sha).at(-1);
      promotions.push({ milestone: f.milestone, sha: f.sha, seq: x.seq, position: walk?.seq ?? x.seq });
    } else if (f.kind === 'demo-acted') {
      if (f.act === 'hold') held = f.command;
      else if (f.act === 'release') held = null;
      else {
        up = f.act === 'up';
        upSeq = x.seq;
      }
    } else if (f.kind === 'demo-failed') failures.push({ milestone: f.milestone, sha: f.sha, log: f.log, seq: x.seq });
  }
  return { promotions, held, up, upSeq, failedLogs: new Set(failures.map((f) => f.log)), failures };
}

/** Moves `refs/roadmap/demo` to the latest promotion when it is elsewhere (the ref follows the facts). */
export function syncDemoRef(ctx: Pick<DemoContext, 'journal' | 'repo'>): void {
  const latest = demoFacts(ctx.journal.view).promotions.at(-1);
  if (latest === undefined) return;
  const at = refTarget(ctx.repo, DEMO_REF);
  if (at !== latest.sha) updateRefCas(ctx.repo, DEMO_REF, latest.sha, at ?? 'absent');
}

function promote(ctx: DemoContext, milestone: MilestoneId, sha: Sha): Promotion {
  ctx.journal.fact({ kind: 'demo-promoted', milestone, sha });
  crashPoint('demo-promoted');
  syncDemoRef(ctx);
  const p = demoFacts(ctx.journal.view).promotions.at(-1);
  if (p === undefined) throw new Error('a promotion the log does not hold');
  return p;
}

/** Whether `sha` is newer than the demo's: no promotion yet, or a different SHA the demo's is an ancestor of. */
function newer(ctx: DemoContext, facts: DemoFacts, sha: Sha): boolean {
  const last = facts.promotions.at(-1);
  return last === undefined || (last.sha !== sha && isAncestor(ctx.repo, last.sha, sha));
}

/**
 * Promotes the latest settled milestone when it is newer and the demo is not held; returns the promotion, or null. Newer
 * without a git call: its closing walk started after the latest promotion's position (the integration branch only moves
 * forward, so a later walk walked a descendant), on another SHA.
 */
export function promoteDemo(ctx: DemoContext): Promotion | null {
  const facts = demoFacts(ctx.journal.view);
  if (facts.held !== null) return null;
  const latest = demoSettled(readerOf(ctx)).at(-1);
  const last = facts.promotions.at(-1);
  if (latest === undefined || (last !== undefined && (latest.walkSeq <= last.position || latest.sha === last.sha))) return null;
  return promote(ctx, latest.milestone, latest.sha);
}

/** The completion's promotion of the final tip `head` (see the header); null when it promotes nothing. */
export function promoteFinal(ctx: DemoContext, head: Sha): Promotion | null {
  const view = ctx.journal.view;
  const facts = demoFacts(view);
  if (facts.held !== null) return null;
  const last = demoSettled(readerOf(ctx)).at(-1);
  if (last === undefined) return null;
  if (view.holistic().findings.some((f) => f.lens === 'walkthrough' && f.severity === 'P1' && isActive(f))) return null;
  return newer(ctx, facts, head) ? promote(ctx, last.milestone, head) : null;
}

/** The `demo` command's effect (only what is missing: a re-run after a crash finds its own fact). */
export function actOnDemo(ctx: DemoContext, id: CommandId, act: DemoAct): Effect {
  const view = ctx.journal.view;
  const mine = view.walkFacts().some((x) => x.fact.kind === 'demo-acted' && x.fact.command === id);
  const facts = demoFacts(view);
  if (!mine) {
    if (act === 'hold' && facts.held !== null) return { kind: 'rejected', reason: `demo hold: promotion is already held (by ${facts.held})` };
    if (act === 'release' && facts.held === null) return { kind: 'rejected', reason: 'demo release: promotion is not held' };
    if (act === 'down' && !facts.up) return { kind: 'rejected', reason: 'demo down: the demo is already down' };
    ctx.journal.fact({ kind: 'demo-acted', command: id, act });
  }
  writeDesired(ctx);
  switch (act) {
    case 'hold':
      return { kind: 'applied', verified: ['demo promotion held: the demo keeps its version until `demo release`'] };
    case 'release': {
      const p = promoteDemo(ctx);
      writeDesired(ctx);
      const now = demoFacts(ctx.journal.view).promotions.at(-1);
      return {
        kind: 'applied',
        verified: ['demo promotion released', p !== null ? `promoted ${p.milestone} at ${p.sha}` : now === undefined ? 'nothing settled to promote yet' : `the demo is current (${now.milestone} at ${now.sha})`],
      };
    }
    case 'up':
      return { kind: 'applied', verified: ['the demo is to run: the supervisor brings it up on its stable ports'] };
    case 'down':
      return { kind: 'applied', verified: ['the demo is to stop: the supervisor stops its instance and keeps its checkout'] };
  }
}

/** The keeper's inputs now (see `DemoDesired`). */
export function desiredOf(ctx: Pick<DemoContext, 'journal' | 'repo' | 'plan'>): DemoDesired {
  const facts = demoFacts(ctx.journal.view);
  const plan = ctx.plan();
  const p = facts.promotions.at(-1);
  return {
    v: SCHEMA_VERSION, arc: plan.arc, repo: ctx.repo, worktreeRoot: plan.worktreeRoot, up: facts.up, upSeq: facts.upSeq,
    target: p === undefined ? null : { milestone: p.milestone, sha: p.sha, bringUp: milestoneOf(plan, p.milestone).bringUp },
  };
}

/** Rewrites `demo.desired.json` when its content changed. */
export function writeDesired(ctx: Pick<DemoContext, 'journal' | 'repo' | 'plan' | 'runDir'>): void {
  const path = desiredPath(ctx.runDir);
  const text = canonicalJson(desiredOf(ctx));
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  durableWrite(path, text);
}

/** Journals the host record's failures of this arc the log lacks, and opens the P1 each one owes (see the header). */
export function journalDemoFailures(ctx: DemoContext): void {
  const view = ctx.journal.view;
  const record = readDemoRecord(ctx.hostDir);
  const facts = demoFacts(view);
  for (const f of record?.failures ?? []) {
    if (f.arc !== view.arc || facts.failedLogs.has(f.log)) continue;
    ctx.journal.fact({ kind: 'demo-failed', milestone: f.milestone, sha: f.sha, log: f.log });
  }
  for (const f of demoFacts(ctx.journal.view).failures) {
    const opened = ctx.journal.view.holistic().findings.some((x) => x.source.type === 'demo' && x.source.sha === f.sha && x.evidence.some((e) => e.path === f.log));
    if (opened) continue;
    openFinding(ctx.journal, {
      lens: 'walkthrough', severity: 'P1', obligation: null, visionClauses: [], milestone: f.milestone,
      claim: `The demo could not bring up ${f.milestone} at ${f.sha}; the previous version keeps serving. Its captured output: ${f.log}.`,
      cause: DEMO_FAILED_CAUSE, evidence: [{ path: f.log, blob: null }], mutant: null, source: { type: 'demo', sha: f.sha }, gateHadPassed: false,
    });
  }
}

/** The scheduler's demo step: one per tick on an arc with milestones; the first tick of a start mends the ref. */
export function demoTicker(ctx: DemoContext): Readonly<{ tick: () => void }> {
  let synced = false;
  return {
    tick: () => {
      if (milestonesOf(ctx.plan()).length === 0) return;
      if (!synced) {
        syncDemoRef(ctx);
        synced = true;
      }
      journalDemoFailures(ctx);
      promoteDemo(ctx);
      writeDesired(ctx);
    },
  };
}

/** What changed in a promotion against the one before it. */
export type DemoSince = Readonly<{ milestones: readonly MilestoneId[]; tweaks: readonly UnitId[]; fixes: readonly UnitId[] }>;

/** The owner's view of the arc's demo (status and the brief), or null before its first promotion. */
export type DemoView = Readonly<{
  milestone: MilestoneId;
  sha: Sha;
  held: boolean;
  up: boolean;
  since: DemoSince;
  roughEdges: readonly FindingId[];
}>;

export function demoView(r: DemoReader): DemoView | null {
  const facts = demoFacts(r.view);
  const current = facts.promotions.at(-1);
  if (current === undefined) return null;
  const from = facts.promotions.at(-2)?.position ?? 0;
  const within = (seq: number | null): boolean => seq !== null && seq > from && seq <= current.position;
  const landed = (u: PlanUnit): boolean => r.view.unit(u.id).status === 'retired' && within(r.view.decidedSeq(u.id));
  const walkFindings = new Set(r.view.holistic().findings.filter((f) => f.lens === 'walkthrough').map((f) => f.id as string));
  const kept = new Set(r.view.walkFacts().flatMap((x) => (x.fact.kind === 'tweak-judged' && x.fact.decision === 'keep' ? [x.fact.unit] : [])));
  const passed = new Set(r.view.walkFacts().flatMap((x) => (x.fact.kind === 'milestone-passed' ? [x.fact.milestone] : [])));
  return {
    milestone: current.milestone,
    sha: current.sha,
    held: facts.held !== null,
    up: facts.up,
    since: {
      milestones: demoSettled(r).filter((s) => within(s.walkSeq)).map((s) => s.milestone),
      tweaks: r.plan.units.filter((u) => kept.has(u.id) && landed(u)).map((u) => u.id),
      fixes: r.plan.units.filter((u) => landed(u) && (r.repairs.find((x) => x.unit === u.id)?.repairs ?? []).some((ref) => walkFindings.has(ref))).map((u) => u.id),
    },
    roughEdges: r.view.holistic().findings
      .filter((f) => f.lens === 'walkthrough' && f.severity === 'P2' && isActive(f) && f.milestone !== undefined && passed.has(f.milestone)).map((f) => f.id),
  };
}

/** Where the owner picks the demo up: a server product's URL (its first serve entry) and every stable port, or a CLI's `bin/`. */
export type DemoWhere =
  | Readonly<{ type: 'url'; url: string; ports: Readonly<Record<ServeName, number>> }>
  | Readonly<{ type: 'path'; path: AbsPath }>;

/**
 * `status.demo`: the owner's view (`DemoView`) with what the host runs: `where` (null until the host's instance is this
 * arc's), `serving` (the SHA the instance runs now, alive; null when it is down, starting or another arc's) and `failed`
 * (the latest `demo-failed` after the promotion: the version that did not come up, the previous one serving).
 */
export type DemoStatus = DemoView & Readonly<{ where: DemoWhere | null; serving: Sha | null; failed: Readonly<{ sha: Sha; log: AbsPath }> | null }>;

export function demoStatus(r: DemoReader, hostDir: AbsPath): DemoStatus | null {
  const v = demoView(r);
  if (v === null) return null;
  const facts = demoFacts(r.view);
  const promoted = facts.promotions.at(-1)?.seq ?? 0;
  const failed = facts.failures.filter((f) => f.seq > promoted).at(-1);
  const record = readDemoRecord(hostDir);
  const s = record?.serving ?? null;
  const ours = s !== null && s.arc === r.view.arc ? s : null;
  const first = ours?.bringUp.serve[0];
  const ports = record?.ports ?? {};
  const where: DemoWhere | null = ours === null ? null : first === undefined ? { type: 'path', path: absPath(join(currentLink(ours.worktreeRoot), 'bin')) }
    : { type: 'url', url: `http://127.0.0.1:${ports[first.name]}/`, ports: Object.fromEntries(ours.bringUp.serve.map((e) => [e.name, ports[e.name] as number])) };
  const alive = ours !== null && ours.state === 'up' && ours.boot === readBootId() && ours.processes.length === ours.bringUp.serve.length && ours.processes.every(detachedAlive);
  return { ...v, where, serving: alive ? ours.sha : null, failed: failed === undefined ? null : { sha: failed.sha, log: failed.log } };
}
