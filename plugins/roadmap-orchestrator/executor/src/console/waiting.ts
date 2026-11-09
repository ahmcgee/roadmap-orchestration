import type { Waited, WaitReason } from '../core/waiting.ts';
const QUEUED_ADMISSIONS = new Set(['dependency', 'contingent-edge', 'milestone', 'host-pressure', 'compare', 'deflake', 'repair-batch']);
export function waitingCategory(reason: WaitReason): 'held' | 'queued' {
  return reason.startsWith('admission-hold:') && !QUEUED_ADMISSIONS.has(reason.slice('admission-hold:'.length)) ? 'held' : 'queued';
}
export function waitingBreakdown(waited: Waited, source: 'admission' | 'reservation') {
  const categories = new Set(Object.keys(waited.byReasonMs).map((r) => source === 'reservation' ? 'queued' : waitingCategory(r as WaitReason)));
  const kind = categories.size === 1 ? [...categories][0] : null;
  return { held: kind === 'held' ? waited.totalMs : 0, queued: kind === 'queued' ? waited.totalMs : 0, unallocated: kind === null ? waited.totalMs : 0 };
}
