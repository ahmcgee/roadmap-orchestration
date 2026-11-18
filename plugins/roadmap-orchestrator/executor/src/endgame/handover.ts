// The endgame's handover (dev.83): what the architect needs to finish the worklist by hand, rendered once per opened episode
// and kept by hash (src/endgame/open.ts). Agent-facing plain text:
//   - the endgame branch, its base and worktree;
//   - each worklist entry, required then optional, with its evidence paths;
//   - each remaining unit: spec path and rev, branch tip, worktree dirty paths, last decided outcome;
//   - the audited range (coverage base and invariants watermark);
//   - the environments up (the estate, from the resource table).
import { existsSync } from 'node:fs';
import type { Sha } from '../core/ids.ts';
import { type AbsPath, type RefName } from '../core/values.ts';
import { refTarget } from '../git/git.ts';
import { integrationHeadNow } from '../holistic/cadence.ts';
import { coverageBase, lensCoverage } from '../holistic/coverage.ts';
import { environmentsOf } from '../input/plan.ts';
import { type StageContext, unitBranch, unitWorktree } from '../pipeline/dispatch.ts';
import { dirtyPaths } from '../pipeline/lanes.ts';
import { loadUnitSpec } from '../pipeline/stages.ts';
import { environmentState } from '../resources/environments.ts';
import type { Worklist, WorklistEntry } from './worklist.ts';

export type HandoverInput = Readonly<{ episode: number; base: Sha; branch: RefName; worktree: AbsPath; worklist: Worklist }>;

function entryLine(e: WorklistEntry): string {
  switch (e.type) {
    case 'finding':
      return `finding ${e.finding} ${e.severity}${e.obligation === null ? '' : ` obligation ${e.obligation}`} evidence: ${e.evidence.length === 0 ? 'none' : e.evidence.join(', ')}`;
    case 'obligation':
      return `obligation ${e.obligation} not held on the integration head`;
    case 'attestation':
      return `obligation ${e.obligation}: external lane ${e.lane} has no attestation at the integration head; once CI has a result for the final head, submit \`roadmap witness ${e.obligation} --at <head> --result <pass|fail> --evidence <url|file>\` (the arc raises one \`external-witness-owed\` item naming the head when nothing else holds completion)`;
    case 'unit':
      return `unit ${e.unit}`;
    case 'polish-refused':
      return `polish proposal ${e.proposal} refused: ${e.reasons.join('; ')}`;
  }
}

/** The handover text for an episode about to open. */
export function renderHandover(ctx: Pick<StageContext, 'journal' | 'runDir' | 'repo' | 'plan' | 'planDir'>, x: HandoverInput): string {
  const view = ctx.journal.view;
  const plan = ctx.plan();
  const lines: string[] = [
    `# Endgame handover: arc ${plan.arc}, episode ${x.episode}`,
    '',
    `branch: ${x.branch}`, `base: ${x.base}`, `worktree: ${x.worktree}`,
    '',
    '## Required',
    ...x.worklist.required.map((e) => `- ${entryLine(e)}`),
    '',
    '## Optional',
    ...x.worklist.optional.map((e) => `- ${entryLine(e)}`),
    '',
    '## Remaining units',
  ];
  for (const e of x.worklist.required) {
    if (e.type !== 'unit') continue;
    const unit = plan.units.find((u) => u.id === e.unit);
    if (unit === undefined) throw new Error(`the worklist names unit ${e.unit}, which the plan in force does not list`);
    const spec = loadUnitSpec(ctx, unit);
    const worktree = unitWorktree(plan.worktreeRoot, plan.arc, unit.id);
    const d = view.unit(unit.id).decided;
    lines.push(
      `- ${unit.id}: spec ${spec.path} rev ${spec.spec.rev}; branch tip ${refTarget(ctx.repo, unitBranch(plan.arc, unit.id)) ?? 'none'}; `
      + `dirty: ${existsSync(worktree) ? dirtyPaths(worktree).join(', ') || 'none' : 'no worktree'}; `
      + `last outcome: ${d === null ? 'none' : `${d.stage}#${d.attempt} ${d.outcome}`}`,
    );
  }
  const head = integrationHeadNow(ctx);
  const base = coverageBase(ctx, head);
  lines.push('', '## Audited range', base === null ? 'none' : `from ${base.head} to ${lensCoverage(view.holistic(), base, 'invariants').watermark} (integration head ${head})`);
  const up = environmentsOf(plan).filter((env) => environmentState(view, env.name) === 'up').map((env) => env.name);
  lines.push('', '## Environments up', up.length === 0 ? 'none' : up.join(', '), '');
  return lines.join('\n');
}
