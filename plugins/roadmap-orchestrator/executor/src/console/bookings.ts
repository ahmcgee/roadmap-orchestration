import type { Event, IntentOf } from '../core/events.ts';
import { parseResourceUnit } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { Booking } from './view-protocol.ts';

/** D6 reserve/reclaim done opens, release done closes. Cleaning never frees ownership. */
export function bookingSummaries(events: readonly Event[]): Booking[] {
  const intents = new Map<string, IntentOf<'resource.transition'>>(), active = new Map<string, Booking>(), rows: Booking[] = [];
  for (const ev of events) {
    if (ev.type === 'intent' && ev.kind === 'resource.transition') intents.set(ev.op, ev);
    if (ev.type !== 'done' || ev.kind !== 'resource.transition') continue;
    const intent = intents.get(ev.op); if (!intent) continue;
    for (const resource of intent.expect.resources) {
      const parsed = parseResourceUnit(resource); if (parsed.type === 'cpu') continue;
      const previous = active.get(resource), edge = intent.expect.edge.type;
      if (previous && (edge === 'reserve' || edge === 'reclaim' || edge === 'release')) {
        previous.endedAt = ev.at; previous.endSeq = ev.seq; previous.state = 'done'; active.delete(resource);
      }
      if (edge !== 'reserve' && edge !== 'reclaim') continue;
      const h = intent.expect.holder;
      const holder = {type: h.type, id: 'unit' in h ? h.unit : h.type === 'job' ? h.job : h.type === 'docs' ? h.pub : h.type === 'sweep' ? h.command : `${h.finding}:${h.attempt}`, ...('unit' in h ? {unitId: h.unit} : {})};
      const row: Booking = {id: sha256Hex(`${ev.op}:${resource}`), resource: parsed.type === 'instance' ? parsed.pool : parsed.name,
        instance: parsed.type === 'instance' ? resource : null, holder, startedAt: ev.at, endedAt: null, state: 'holding', startSeq: ev.seq, endSeq: null};
      rows.push(row); active.set(resource, row);
    }
  }
  return rows;
}
