// adopted-arc coverage (LR-D0b): migrate to corpus arcs when holistic architecture-doc scaffolding is deleted (BACKLOG)
// Shared by the checkpoint tests (test/checkpoint.test.ts) and their crash child (checkpoint-child.ts): an audit-common
// arc whose required lens set is the vision lens alone (one lens call per audit), the checkpoint context over the run's
// one arbiter (the command context's docs publisher and routing base), and the readers the tests assert with.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { applyCommand } from '../../src/commands/apply.ts';
import { submitCommand } from '../../src/commands/queue.ts';
import { type CommandId, commandId } from '../../src/core/ids.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { runAudit } from '../../src/holistic/audit.ts';
import type { CheckpointContext } from '../../src/holistic/checkpoint.ts';
import type { Clock } from '../../src/holistic/cadence.ts';
import type { Step } from '../helpers/scenario.ts';
import { admitSpecWire, lensStep } from '../helpers/holistic.ts';
import { type AuditArcOptions, auditArc, auditContext, factsOf } from './audit-common.ts';
import { type ArcDescriptor, type ArcRun, applyBody } from './unit-common.ts';

type Json = Record<string, unknown>;

/** A holistic arc with obligation I-1 (must-hold, t1 passing on every tree) and L = {vision}; `extra` overrides. */
export function checkpointArc(steps: readonly Step[], extra: Partial<AuditArcOptions> = {}): ArcDescriptor {
  return auditArc({
    steps, units: [{ id: 'u1' }], obligations: [{ id: 'I-1', testIds: ['t1'] }], trees: { '*': { outcomes: { t1: 'pass' } } }, mapping: [],
    audit: { lenses: ['vision'] }, ...extra,
  }).d;
}

export type Wired = ReturnType<typeof auditContext>['w'];

/** The checkpoint context: the audit context plus the command context's plan file, routing base and docs publisher. */
export function checkpointContext(r: ArcRun, clock: Clock = () => 0): Readonly<{ ctx: CheckpointContext; w: Wired }> {
  const { ctx, w } = auditContext(r, clock);
  return { ctx: { ...ctx, planFile: w.commands.planFile, routingBase: w.commands.routingBase, docs: w.commands.docs }, w };
}

let commands = 0;
/** An `audit-requested` fact, as the `audit` command (B7) writes it. */
export function requestAudit(r: ArcRun): CommandId {
  const command = commandId(`cmd-${(++commands).toString(16).padStart(16, 'c')}`);
  r.journal.fact({ kind: 'audit-requested', command, lenses: null });
  return command;
}

/** Requests an audit and runs it to a completed end (its vision lens answered by `lensStep(job, 'vision')`). */
export async function completedAudit(r: ArcRun, ctx: CheckpointContext): Promise<void> {
  requestAudit(r);
  const out = await runAudit(ctx);
  assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
}

/** The vision lens step of each of `jobs`. */
export const visionLenses = (...jobs: readonly string[]): readonly Step[] => jobs.map((j) => lensStep(j, 'vision'));

/** Edits plan.json in place and applies it (an architect's `roadmap apply`). */
export async function applyPlanEdit(r: ArcRun, w: Wired, edit: (plan: Json) => void): Promise<void> {
  const plan = JSON.parse(readFileSync(r.d.planPath, 'utf8')) as Json;
  edit(plan);
  writeFileSync(r.d.planPath, JSON.stringify(plan));
  const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(r.d)));
  assert.equal(out.kind, 'applied', JSON.stringify(out));
}

/** Rewrites the vision file with `clauses` added at the next rev and applies it (owner-only: an architect apply). */
export async function applyVision(r: ArcRun, w: Wired, clauses: readonly Json[]): Promise<void> {
  const file = join(r.d.planPath, '..', 'vision.json');
  const vision = JSON.parse(readFileSync(file, 'utf8')) as Json & { rev: number; clauses: Json[] };
  writeFileSync(file, JSON.stringify({ ...vision, rev: vision.rev + 1, clauses: [...vision.clauses, ...clauses] }));
  const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(r.d)));
  assert.equal(out.kind, 'applied', JSON.stringify(out));
}

/** An arc-wide limits op on a bound field (never convergenceK), citing V-1, with `evidence`. */
export const limitsOp = (field: string, value: number, evidence: readonly string[] = ['scripted evidence']): JsonValue =>
  ({ op: 'limits', unit: null, limits: [{ field, value }], cites: ['V-1'], evidence: [...evidence] });

/** An `admit` of `id`: u1's spec file renamed to `id` at rev 1 (in the admit wire form), `lanes` replacing its lanes when given. */
export function admitOp(d: ArcDescriptor, id: string, lanes?: readonly Json[]): JsonValue {
  const spec = JSON.parse(readFileSync(join(d.planPath, '..', 'u1.json'), 'utf8')) as Json;
  return {
    op: 'admit', unit: { id, risk: 'med', scope: ['contracts/**', 'src/**', 'test/**'], after: [], origin: 'checkpoint' },
    spec: admitSpecWire({ ...spec, unit: id, rev: 1, ...(lanes === undefined ? {} : { lanes }) }), targets: [],
    cites: ['V-1'], evidence: ['scripted evidence'],
  };
}

/** The facts of `kind`, in log order. */
export function factsOfKind<K extends ReturnType<typeof factsOf>[number]['kind']>(r: ArcRun, kind: K) {
  return factsOf(r).filter((f): f is Extract<ReturnType<typeof factsOf>[number], { kind: K }> => f.kind === kind);
}
