// The one place the console reads milestone membership and its counts. Every view (stations, bands, the milestone
// drawer, blocker text) takes them from here, so an executor change to who counts toward a milestone (dev.59 scope
// item 3: superseded or cut members withdrawn, a re-entry inheriting its parent's milestone) changes this file only.
// Today a milestone's members are exactly its applied plan units; withdrawn members are counted and shown apart.
import type { Envelope } from '../observation/protocol.ts';
import { listWords } from './vocabulary.ts';

export type MemberCounts = {total: number; merged: number; withdrawn: number};
type Units = Envelope['data']['display']['status']['units'];

const withdrawn = (state: string) => state === 'cut' || state === 'superseded';
function counts(ids: readonly string[], states: ReadonlyMap<string, Units[number]>): MemberCounts {
  return {total: ids.length, merged: ids.filter(id => states.get(id)!.state === 'merged').length,
    withdrawn: ids.filter(id => withdrawn(states.get(id)!.state)).length};
}
/** The unit that carries `id`'s work now: itself, or the last unit re-entering it. */
export function lineageHead(states: ReadonlyMap<string, Units[number]>, id: string): string {
  const seen = new Set([id]);
  let head = id;
  for (let next = states.get(head)!.supersededBy; next !== null; next = states.get(head)!.supersededBy) {
    if (seen.has(next)) throw new Error(`the lineage of ${id} re-enters itself at ${next}`);
    seen.add(next); head = next;
  }
  return head;
}
export function milestoneMembership(e: Envelope) {
  const states = new Map(e.data.display.status.units.map(u => [String(u.unit), u]));
  const milestones = (e.data.plan?.milestones ?? []).map(m => {
    const memberIds = m.units.map(String);
    // The executor reaches a milestone when every member's lineage head merged (src/walk/milestones.ts milestoneReached).
    const unmerged = [...new Set(memberIds.map(id => lineageHead(states, id)))].filter(id => states.get(id)!.state !== 'merged');
    return {id: String(m.id), memberIds, ...counts(memberIds, states), unmerged};
  });
  const members = new Set(milestones.flatMap(m => m.memberIds));
  const none = [...states.keys()].filter(id => !members.has(id));
  return {milestones, none: {ids: none, ...counts(none, states)}, states};
}
export type Membership = ReturnType<typeof milestoneMembership>;

/** Why milestone `id` has not passed, in words, or null once it passed. */
export function milestoneReason(e: Envelope, membership: Membership, id: string): string | null {
  const view = e.data.display.status.milestones.find(m => String(m.id) === id)!, m = membership.milestones.find(m => m.id === id)!;
  if (view.passed) return null;
  if (m.unmerged.length) {
    const shown = m.unmerged.slice(0, 4), rest = m.unmerged.length - shown.length;
    const cut = m.unmerged.filter(u => membership.states.get(u)!.state === 'cut');
    return `${m.unmerged.length === 1 ? '1 unit has' : `${m.unmerged.length} units have`} not merged: ${listWords(rest ? [...shown, `${rest} more`] : shown)}`
      + (cut.length ? `. ${listWords(cut)} ${cut.length === 1 ? 'was' : 'were'} withdrawn but still ${cut.length === 1 ? 'counts' : 'count'} toward it` : '');
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
