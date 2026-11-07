// Apply answers use the same eligibility predicate at submission, dry-run, precommit and successful finish.
import type { PlanChange } from '../core/events.ts';
import type { NeedsUserId, UnitId, FindingId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import type { InputFiles } from '../input/inforce.ts';
import { openItems, readNeedsUser } from '../needsuser.ts';
import { parseSpec } from '../spec/spec.ts';

export type ApplyAnswer = Readonly<{ changed: boolean; units: ReadonlySet<UnitId>; repairs: ReadonlySet<string> }>;
export function applyAnswer(changes: readonly PlanChange[], files: Pick<InputFiles, 'specs'>, extraUnits: readonly UnitId[] = [], changed = true): ApplyAnswer {
  const units = new Set(extraUnits);
  for (const change of changes) {
    if ('unit' in change && change.unit !== null) units.add(change.unit);
    if (change.type === 'unit-reentered') units.add(change.reenters);
  }
  const repairs = new Set<string>();
  for (const unit of units) {
    const file = files.specs.get(unit);
    if (file?.bytes != null) for (const ref of parseSpec(file.bytes, file.path).repairs ?? []) repairs.add(ref);
  }
  return { changed, units, repairs };
}

/** The existing repair/settled-finding predicate, shared by explicit and automatic closures. */
export function findingsAnswered(view: JournalView, ids: readonly FindingId[], repairs: ReadonlySet<string>): boolean {
  return ids.every((id) => view.holistic().findings.some((f) => f.id === id && (
    f.state === 'ruled' || f.state === 'resolved' || repairs.has(f.id) || (f.lens === 'witness' && f.obligation !== null && repairs.has(f.obligation))
  )));
}

export function resolutionProblem(ctx: Readonly<{ runDir: AbsPath; view: JournalView }>, id: NeedsUserId, answer: ApplyAnswer): string | null {
  if (!id.startsWith('nu-') || !ctx.view.needsUser().some((n) => n.id === id)) return `${id}: --resolves requires a journal nu-* item`;
  if (!openItems(ctx.runDir, ctx.view).some((n) => n.id === id)) return `${id}: item is not open (acknowledged or superseded)`;
  if (!answer.changed) return `${id}: --resolves requires a changed apply; a no-op answers nothing`;
  const item = readNeedsUser(ctx.runDir, id);
  if (item === null) throw new Error(`journal item ${id} has no needs-user record`);
  switch (item.subject.type) {
    case 'arc': return null; // The architect explicitly asserts that the changed revision answers this request.
    case 'unit': return answer.units.has(item.subject.unit) ? null : `${id}: the apply must change or re-enter unit ${item.subject.unit}`;
    case 'findings': return findingsAnswered(ctx.view, item.subject.findings, answer.repairs) ? null : `${id}: the apply must answer every named finding`;
    case 'host': return `${id}: a host-subject item requires its host action`;
  }
}

export function resolutionProblems(ctx: Readonly<{ runDir: AbsPath; view: JournalView }>, ids: readonly NeedsUserId[], answer: ApplyAnswer): readonly string[] {
  return ids.flatMap((id) => { const problem = resolutionProblem(ctx, id, answer); return problem === null ? [] : [problem]; });
}
