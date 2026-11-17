// Shared by the endgame tests over a real arc (test/endgame-commands.test.ts, test/endgame-recovery.test.ts) and the
// landing's crash child (endgame-land-child.ts). The arc (`endgameArc`): u1 planned, F-1 a P1 the audit found, r1 admitted
// to repair it, then u1 cut, so the arc is in the endgame with r1 held; the scheduler's entry and the open step
// (src/endgame/open.ts) made it episode 1, with the endgame branch and worktree at the integration head. `endgameRun` wires
// a process over such an arc as the executor wires it.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type CommandContext, applyCommand } from '../../src/commands/apply.ts';
import { submitCommand, terminalReceipt } from '../../src/commands/queue.ts';
import { type Sha, findingId, jobId, sha, unitId } from '../../src/core/ids.ts';
import type { CommandBody, EndgameAct } from '../../src/core/records.ts';
import { endgameJobDue, runEndgameJob } from '../../src/endgame/jobs.ts';
import { endgameWorktree, openEndgame, repairsReader } from '../../src/endgame/open.ts';
import { endgameHeld } from '../../src/endgame/phase.ts';
import { openFinding } from '../../src/holistic/findings.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import { type HolisticContexts, holisticContexts } from '../../src/schedule/scheduler.ts';
import { git } from '../helpers/repo.ts';
import { addUnit, completingArc, wired } from './sched-m3-common.ts';
import { type ArcDescriptor, type ArcRun, applyBody, contextFor } from './unit-common.ts';

export const F1 = findingId('F-1');
export const R1 = unitId('r1');

type Json = Record<string, unknown>;
export type Receipt = Readonly<{ state: string; reason?: string; verified?: readonly string[] }>;
export type EndgameRun = Readonly<{
  d: ArcDescriptor; r: ArcRun; h: HolisticContexts; worktree: string; commands: CommandContext;
  /** Commits `files` on the endgame branch (in its worktree). */
  commit: (files: Readonly<Record<string, string>>, message: string) => Sha;
  /** Applies one command now, as the scheduler would: its receipt. */
  command: (body: CommandBody) => Promise<Receipt>;
}>;

export const head = (d: ArcDescriptor): Sha => sha(git(d.repo, 'rev-parse', 'main'));
export const endgame = (act: EndgameAct): CommandBody => ({ type: 'endgame', act });

/** The arc `d` opened in this process, wired as the executor wires it. */
export function endgameRun(d: ArcDescriptor): EndgameRun {
  const r = contextFor(d);
  const w = wired(r);
  const h = holisticContexts(w);
  const command = async (body: CommandBody): Promise<Receipt> => {
    const file = submitCommand(r.ctx.runDir, r.journal.view.arc, body);
    await applyCommand(w.commands, file);
    const receipt = terminalReceipt(r.ctx.runDir, file.id);
    if (receipt === null) throw new Error(`${file.id} has no terminal receipt`);
    return receipt;
  };
  const plan = r.ctx.plan();
  const worktree = endgameWorktree(plan.worktreeRoot, plan.arc);
  const commit = (files: Readonly<Record<string, string>>, message: string): Sha => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(worktree, path)), { recursive: true });
      writeFileSync(join(worktree, path), text);
    }
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', message);
    return sha(git(worktree, 'rev-parse', 'HEAD'));
  };
  return { d, r, h, worktree, commands: w.commands, commit, command };
}

/** Lays out the endgame arc (see the header) and opens its episode 1. */
export async function endgameArc(): Promise<EndgameRun> {
  const d = completingArc();
  const e = endgameRun(d);
  const { r, h } = e;
  openFinding(r.journal, {
    lens: 'drift', severity: 'P1', obligation: null, visionClauses: [], claim: 'add() drops the carry', cause: 'carry', evidence: [{ path: 'src/add.js', blob: null }],
    mutant: null, source: { type: 'job', job: jobId('audit', 1) }, gateHadPassed: true,
  });
  addUnit(d, 'r1');
  const planDir = join(d.planPath, '..');
  const spec = JSON.parse(readFileSync(join(planDir, 'r1.json'), 'utf8')) as Json;
  writeFileSync(join(planDir, 'r1.json'), JSON.stringify({ ...spec, repairs: ['F-1'] }));
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Json & { units: Json[] };
  writeFileSync(d.planPath, JSON.stringify({ ...plan, units: plan.units.map((u) => (u['id'] === 'u1' ? { ...u, cut: { reason: 'the endgame test needs no planned work' } } : u)) }));
  const applied = await e.command(applyBody(d));
  assert.equal(applied.state, 'applied', JSON.stringify(applied));
  const inForce = () => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
  assert.deepEqual([...endgameHeld(r.journal.view, inForce(), repairsReader(h.audit))], [R1], 'r1 is held before the entry');
  r.journal.fact({ kind: 'endgame-entered', episode: 1, planRev: r.journal.view.planApplied()!.rev });
  await openEndgame(h.audit, h.laneEnv);
  return e;
}

/** Runs the endgame job due now to its end; it must be one. */
export async function runDue(e: EndgameRun): Promise<void> {
  const due = endgameJobDue(e.h.audit, e.h.laneEnv);
  assert.ok(due !== null, 'an endgame job is due');
  await runEndgameJob(e.h.audit, due);
}
