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

/**
 * dev.81 (D1): the groups the Graph draws the units of no milestone in, by what raised them, in drawing order. Display
 * only: nothing in the scheduler or the walk reads them. A unit takes the group of its lineage's root (a re-entry's
 * parent, a carrier's cut unit, transitively), so a withdrawn unit and the unit that replaced it share one group.
 *   deflake          origin `deflake`
 *   polish           origin `polish`: under its `polish.milestone`
 *   design           a milestone's design unit: under that milestone
 *   milestone-repair origin `repair`, every repaired id resolving to one milestone: each `F-n` through its
 *                    `finding-opened` (a walkthrough finding's `milestone`, else its raising job's milestone: the job's
 *                    `walk-started`, or a campaign audit's `stage-outcome`), each `I-n` through the findings naming it
 *   audit            origin `repair` resolving to no one milestone: the job that raised its latest finding (`audit-N`, `walk-N`)
 *   hardening        everything else: planned work in no milestone, and a repair no job raised
 *   endgame          (dev.82) a unit the endgame took over (status `endgame.units`: held and handed over, released by
 *                    `resume`, or closed by a fix), or one whose lineage root it took over, whatever raised it; it
 *                    wins over the kinds above
 * Order: the milestone-attached groups in plan order (design, then repair, then polish), Hardening, each audit job newest
 * first, Deflake, then the Endgame, the arc's last group.
 */
export type OutsideGroup = OutsideGroupOf<'design' | 'milestone-repair' | 'polish', {milestone: string}> | OutsideGroupOf<'audit', {job: string}> | OutsideGroupOf<'hardening' | 'deflake' | 'endgame', {}>;
type OutsideGroupOf<K extends string, X> = {kind: K; id: string; label: string; ids: string[]} & X;
type StatusLine = Envelope['data']['display']['status']['units'][number];
type GroupKey = {kind: 'design' | 'milestone-repair' | 'polish'; milestone: string} | {kind: 'audit'; job: string; seq: number} | {kind: 'hardening' | 'deflake' | 'endgame'};
export function outsideGroups(e: Envelope, membership: Membership): OutsideGroup[] {
  const s = e.data.display.status, plan = e.data.plan, lines = new Map(s.units.map(u => [String(u.unit), u]));
  const planUnits = new Map((plan?.units ?? []).map(u => [String(u.id), u]));
  const design = new Map((plan?.milestones ?? []).flatMap(m => 'unit' in m.design ? [[String(m.design.unit), String(m.id)] as const] : []));
  // Each job's milestone (null: it names none), and each finding's own milestone, raising job and journal position.
  const jobMilestone = new Map<string, string | null>(), opened: {id: string; obligation: string | null; job: string | null; milestone: string | null; seq: number}[] = [];
  for (const ev of e.data.events) {
    if (ev.type !== 'fact') continue;
    const f = ev.fact;
    if (f.kind === 'walk-started') jobMilestone.set(String(f.job), String(f.milestone));
    else if (f.kind === 'stage-outcome' && f.stage === 'campaign-audit' && 'job' in f) jobMilestone.set(String(f.job), f.milestone === null ? null : String(f.milestone));
    else if (f.kind === 'finding-opened') opened.push({id: String(f.id), obligation: f.obligation === null ? null : String(f.obligation), job: f.source.type === 'job' ? String(f.source.job) : null, milestone: f.milestone === undefined ? null : String(f.milestone), seq: Number(ev.seq)});
  }
  const rootOf = (id: string): string => {
    const l = lines.get(id)!, from = l.lineage?.reenters ?? l.carries?.unit;
    return from === undefined ? id : rootOf(String(from));
  };
  const repairKey = (line: StatusLine): GroupKey => {
    const found = line.repairs.flatMap(r => opened.filter(f => f.id === String(r) || f.obligation === String(r)));
    const milestones = new Set(found.map(f => f.milestone ?? (f.job === null ? null : jobMilestone.get(f.job) ?? null)));
    if (found.length > 0 && milestones.size === 1 && !milestones.has(null)) return {kind: 'milestone-repair', milestone: [...milestones][0]!};
    const latest = found.filter(f => f.job !== null).sort((a, b) => b.seq - a.seq)[0];
    return latest === undefined ? {kind: 'hardening'} : {kind: 'audit', job: latest.job!, seq: latest.seq};
  };
  const endgame = new Set((s.endgame?.units ?? []).map(u => String(u.unit)));
  const keyOf = (root: string): GroupKey => {
    const line = lines.get(root)!;
    if (line.origin === 'deflake') return {kind: 'deflake'};
    if (line.origin === 'polish') return {kind: 'polish', milestone: String(planUnits.get(root)!.polish!.milestone)};
    if (design.has(root)) return {kind: 'design', milestone: design.get(root)!};
    return line.origin === 'repair' ? repairKey(line) : {kind: 'hardening'};
  };
  const groups = new Map<string, {key: GroupKey; ids: string[]}>();
  for (const id of membership.none.ids) {
    const key: GroupKey = endgame.has(id) || endgame.has(rootOf(id)) ? {kind: 'endgame'} : keyOf(rootOf(id)), gid = key.kind === 'audit' ? `audit:${key.job}` : 'milestone' in key ? `${key.kind}:${key.milestone}` : key.kind;
    const g = groups.get(gid) ?? {key, ids: []};
    if (key.kind === 'audit' && g.key.kind === 'audit' && key.seq > g.key.seq) g.key = key;
    g.ids.push(id); groups.set(gid, g);
  }
  const out: OutsideGroup[] = [];
  for (const m of plan?.milestones ?? []) for (const kind of ['design', 'milestone-repair', 'polish'] as const) {
    const g = groups.get(`${kind}:${m.id}`);
    if (g) out.push({kind, id: `${kind}:${m.id}`, label: kind === 'milestone-repair' ? 'repair' : kind, milestone: String(m.id), ids: g.ids});
  }
  const hardening = groups.get('hardening');
  if (hardening) out.push({kind: 'hardening', id: 'hardening', label: 'Hardening', ids: hardening.ids});
  const audits = [...groups].flatMap(([id, g]) => g.key.kind === 'audit' ? [{id, job: g.key.job, seq: g.key.seq, ids: g.ids}] : []).sort((a, b) => b.seq - a.seq);
  for (const g of audits) out.push({kind: 'audit', id: g.id, label: g.job, job: g.job, ids: g.ids});
  const deflake = groups.get('deflake');
  if (deflake) out.push({kind: 'deflake', id: 'deflake', label: 'Deflake', ids: deflake.ids});
  const last = groups.get('endgame');
  if (last) out.push({kind: 'endgame', id: 'endgame', label: 'Endgame', ids: last.ids});
  if (out.reduce((n, g) => n + g.ids.length, 0) !== membership.none.ids.length) throw new Error('a unit of no milestone fell outside every Graph group');
  return out;
}
