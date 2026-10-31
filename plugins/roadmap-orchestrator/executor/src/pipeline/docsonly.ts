import { verificationWorktree } from './dispatch.ts';
import type { StageContext } from './dispatch.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { UnitId, Sha, LaneId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
export function certifiedTree(ctx: StageContext, unit: UnitId): Sha | null {
  const attempt = ctx.journal.view.review().greenLanes(unit);
  if (attempt === null) return null;
  const path = verificationWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit, attempt);
  const created = ctx.journal.view.opsOf('worktree.create').find((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'lanes'
    && i.parent.attempt === attempt && i.expect.path === path);
  if (created === undefined || created.expect.checkout.type !== 'detached') throw new Error(`unit ${unit}: lanes attempt ${attempt} ended green without its verification checkout`);
  return created.expect.checkout.at;
}
export function carriedLanes(_ctx: StageContext, _unit: UnitId): ReadonlySet<LaneId> { return new Set(); }
