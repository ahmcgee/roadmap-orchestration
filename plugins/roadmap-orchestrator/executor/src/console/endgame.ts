// dev.82: the endgame as the console shows it, projected from status `phase` and `endgame` (src/status/endgame.ts) and the
// journal's finding facts. Read only, like every view.
//   shellPhase    the header's phase track: body (what still holds the endgame off), endgame (its step) or closed out
//   endgameView   the Endgame view: the exit checklist, the worklist (required, optional, then entries the open episode's
//                 fixes closed), the current episode's fixes, landings, reviews and handover, and the earlier episodes
// The handover is read from the run dir (`readEvidence`) and shown only when its bytes match the hash its episode recorded.
import { sha256Hex } from '../core/json.ts';
import type { Envelope } from '../observation/protocol.ts';
import type { EpisodeView } from '../status/endgame.ts';
import { activityKey } from './backend-holds.ts';
import { readEvidence } from './evidence.ts';
import { versioned } from './views.ts';
import type { DetailRef, EndgameEntry, EndgameEpisodeView, EndgameRef, EndgameView, ShellPhase } from './view-protocol.ts';

/** The handover's shown bytes: a longer one is cut here and says so. */
export const HANDOVER_SHOWN = 64 * 1024;

export function shellPhase(e: Envelope): ShellPhase {
  const s = e.data.display.status, p = s.phase, episodes = s.endgame?.episodes.length ?? 0;
  switch (p.kind) {
    case 'body': return {kind: 'body', planned: p.planned.length, milestones: p.milestones.length, episodes};
    case 'endgame': return {kind: 'endgame', step: p.step, episode: p.episode, required: p.required, optional: p.optional, episodes};
    case 'closed-out': return {kind: 'closed-out', episodes};
  }
}

export function endgameView(e: Envelope): EndgameView {
  const s = e.data.display.status, g = s.endgame, phase = shellPhase(e);
  const at = new Map(e.data.events.map(ev => [Number(ev.seq), ev.at]));
  const opened = new Map<string, {seq: number; severity: string; claim: string; obligation: string | null}>();
  for (const ev of e.data.events) if (ev.type === 'fact' && ev.fact.kind === 'finding-opened') opened.set(String(ev.fact.id), {seq: Number(ev.seq), severity: ev.fact.severity, claim: ev.fact.claim, obligation: ev.fact.obligation === null ? null : String(ev.fact.obligation)});
  const statements = new Map([...s.nowTrue, ...s.notYetTrue].map(o => [String(o.obligation), o.statement]));
  const units = new Set(s.units.map(u => String(u.unit)));
  const detail = (id: string): DetailRef | null => {
    if (/^F-\d+$/.test(id)) { const f = opened.get(id); return f === undefined ? null : {type: 'event', id: activityKey(e.epoch, f.seq, 'finding-opened')}; }
    return /^I-\d+$/.test(id) || !units.has(id) ? null : {type: 'unit', id};
  };
  const ref = (id: string): EndgameRef => ({id, detail: detail(id)});
  const time = (seq: number | null): string | null => seq === null ? null : at.get(seq) ?? null;
  const lanesOf = (job: string): string[] => [...new Set(s.host.work.flatMap(w => w.parent.type === 'job' && String(w.parent.job) === job && w.lane !== null ? [String(w.lane)] : []))].sort();
  const episode = (x: EpisodeView): EndgameEpisodeView => ({
    episode: x.episode, planRev: Number(x.planRev), enteredAt: time(x.enteredSeq),
    state: x.left === null ? 'open' : x.left.cause === 'planned-unit' ? 'reversed' : 'complete', leftAt: time(x.left?.seq ?? null),
    opened: x.opened === null ? null : {at: time(x.opened.seq), base: x.opened.base, handover: handoverText(e, x.opened.handover, x.opened.handoverSha256),
      advisory: x.opened.sizeGuard ? x.opened.item?.recommendation ?? null : null, sizeGuard: x.opened.sizeGuard},
    fixes: x.fixes.map(f => ({command: String(f.command), at: time(f.seq), commit: f.commit, closes: f.closes.map(ref), note: f.note, landed: f.landed})),
    landings: x.landings.map(l => ({job: String(l.job), at: time(l.seq), old: l.old, head: l.head, lanes: lanesOf(String(l.job))})),
    reviews: x.reviews.map(r => ({job: String(r.job), at: time(r.seq), from: r.from, to: r.to,
      findings: r.findings.map(id => ({...ref(String(id)), severity: opened.get(String(id))?.severity ?? null, claim: opened.get(String(id))?.claim ?? ''}))})),
    jobs: x.jobs.map(j => ({job: String(j.job), request: j.request, command: j.command === null ? null : String(j.command), startedAt: time(j.startSeq), outcome: j.outcome, detail: j.detail})),
    released: x.released.map(r => ref(String(r.unit))),
  });
  const episodes = g?.episodes ?? [];
  const live = episodes.at(-1)?.left === null ? episodes.at(-1)! : null;
  const fixesOf = (id: string) => (live?.fixes ?? []).filter(f => f.closes.includes(id as never)).map(f => ({command: String(f.command), commit: f.commit, landed: f.landed}));
  const entry = (w: NonNullable<typeof g>['worklist']['required'][number], required: boolean): EndgameEntry => {
    switch (w.type) {
      case 'finding': { const f = opened.get(String(w.finding)); return {kind: 'finding', id: String(w.finding), required, closed: false, severity: w.severity,
        text: `${f?.claim ?? ''}${w.obligation === null ? '' : ` (over ${w.obligation})`}`, detail: detail(String(w.finding)), fixes: fixesOf(String(w.finding))}; }
      case 'obligation': return {kind: 'obligation', id: String(w.obligation), required, closed: false, severity: null, text: statements.get(String(w.obligation)) ?? 'Not held on the integration head', detail: null, fixes: fixesOf(String(w.obligation))};
      case 'unit': return {kind: 'unit', id: String(w.unit), required, closed: false, severity: null, text: s.units.find(u => String(u.unit) === String(w.unit))?.state === 'awaiting-admission' ? 'Handed over: held at admission' : 'Finding-raised work still open', detail: detail(String(w.unit)), fixes: fixesOf(String(w.unit))};
      case 'polish-refused': return {kind: 'polish-refused', id: String(w.proposal), required, closed: false, severity: null, text: w.reasons.join('; '), detail: null, fixes: []};
    }
  };
  const worklist = g === null ? [] : [...g.worklist.required.map(w => entry(w, true)), ...g.worklist.optional.map(w => entry(w, false))];
  const listed = new Set(worklist.map(w => w.id));
  for (const f of live?.fixes ?? []) for (const id of f.closes) {
    if (listed.has(id)) continue;
    listed.add(id);
    const kind = /^F-\d+$/.test(id) ? 'finding' : /^I-\d+$/.test(id) ? 'obligation' : 'unit';
    const text = kind === 'finding' ? opened.get(id)?.claim ?? '' : kind === 'obligation' ? statements.get(id) ?? '' : 'Cut by the fix';
    const f = opened.get(id);
    worklist.push({kind, id, required: kind !== 'finding' || f === undefined || f.severity === 'P1' || f.obligation !== null, closed: true, severity: f?.severity ?? null, text, detail: detail(id), fixes: fixesOf(id)});
  }
  const exit = g?.exit ?? null;
  const views = episodes.map(episode);
  return versioned({
    phase, branch: g === null ? null : String(g.branch).replace(/^refs\/heads\//, ''), tip: g?.tip ?? null, landed: g?.landed ?? false,
    exit: exit === null ? null : [
      {key: 'worklist', label: 'Required worklist empty', met: exit.worklist},
      {key: 'review', label: 'Independent review covers the endgame range', met: exit.review},
      {key: 'audit', label: 'Audit covers the endgame range', met: exit.audit},
      {key: 'obligations', label: 'Obligations witnessed at the final tip', met: exit.obligations},
    ],
    worklist, audited: g?.audited ?? null,
    current: views.at(-1) ?? null, history: views.slice(0, -1).reverse(),
  }, {basis: 'current', from: null, to: null});
}

function handoverText(e: Envelope, path: string, hash: string): {text: string | null; truncated: boolean} {
  let bytes: Buffer;
  try { bytes = readEvidence(e.data.display.run.runDir, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {text: null, truncated: false}; throw error; }
  if (sha256Hex(bytes) !== hash) return {text: null, truncated: false};
  return {text: bytes.subarray(0, HANDOVER_SHOWN).toString('utf8'), truncated: bytes.length > HANDOVER_SHOWN};
}
