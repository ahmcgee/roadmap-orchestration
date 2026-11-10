// The one place the console reads milestone membership and its counts. Every view (stations, bands, the milestone
// drawer, blocker text) takes them from here, and this module takes them from the executor's recorded membership,
// status `milestones[]` (src/walk/milestones.ts `milestoneMembership`): a milestone's units, their re-entries and the
// units carrying a cut one forward count for it; superseded and cut members are withdrawn from its counts.
import type { Envelope } from '../observation/protocol.ts';
import { listWords } from './vocabulary.ts';

/** `total`: the live members (withdrawn ones excluded); `merged`: those of them merged; `withdrawn`: superseded or cut. */
export type MemberCounts = {total: number; merged: number; withdrawn: number};

const withdrawn = (state: string) => state === 'cut' || state === 'superseded';
export function milestoneMembership(e: Envelope) {
  const s = e.data.display.status, states = new Map(s.units.map(u => [String(u.unit), u]));
  const milestones = s.milestones.map(m => {
    const memberIds = m.members.map(String), out = new Set(m.withdrawn.map(String));
    const unmerged = memberIds.filter(id => !out.has(id) && states.get(id)!.state !== 'merged');
    return {id: String(m.id), memberIds, total: m.live, merged: m.merged, withdrawn: out.size, unmerged};
  });
  const members = new Set(milestones.flatMap(m => m.memberIds));
  const none = [...states.keys()].filter(id => !members.has(id)), live = none.filter(id => !withdrawn(states.get(id)!.state));
  return {milestones, none: {ids: none, total: live.length, merged: live.filter(id => states.get(id)!.state === 'merged').length, withdrawn: none.length - live.length}, states};
}
export type Membership = ReturnType<typeof milestoneMembership>;

/** Why milestone `id` has not passed, in words, or null once it passed. */
export function milestoneReason(e: Envelope, membership: Membership, id: string): string | null {
  const view = e.data.display.status.milestones.find(m => String(m.id) === id)!, m = membership.milestones.find(m => m.id === id)!;
  if (view.passed) return null;
  if (m.total === 0) return `it has no live member: ${listWords(m.memberIds)} ${m.memberIds.length === 1 ? 'was' : 'were'} withdrawn, so it is never reached`;
  if (m.unmerged.length) {
    const shown = m.unmerged.slice(0, 4), rest = m.unmerged.length - shown.length;
    return `${m.unmerged.length === 1 ? '1 unit has' : `${m.unmerged.length} units have`} not merged: ${listWords(rest ? [...shown, `${rest} more`] : shown)}`;
  }
  if (view.walks.some(w => w.outcome === null)) return 'its walkthrough is running';
  if (view.state === 'blocked') return 'its last walkthrough found problems that are still open';
  return arcStopped(e) ? 'its walkthrough has not run, and the arc is stopped' : 'its walkthrough is due';
}
/** A gate's status mark: running while its walkthrough runs, or is due on a live arc; a stopped arc runs nothing. */
export function milestoneSignal(e: Envelope, m: Envelope['data']['display']['status']['milestones'][number]): 'passed' | 'active' | 'held' | 'pending' {
  if (m.passed) return 'passed';
  if (m.walks.some(w => w.outcome === null) || m.state === 'walking' && !arcStopped(e)) return 'active';
  return m.state === 'blocked' ? 'held' : 'pending';
}
/** The arc has no owner: nothing runs until it is resumed. */
export const arcStopped = (e: Envelope): boolean => e.data.display.status.run.state === 'no-owner';
/** Each unpassed milestone's reason, keyed by id, for the blocker text that names a milestone. */
export function milestoneReasons(e: Envelope, membership = milestoneMembership(e)): ReadonlyMap<string, string> {
  return new Map(membership.milestones.flatMap(m => {const reason = milestoneReason(e, membership, m.id); return reason === null ? [] : [[m.id, reason] as const];}));
}
