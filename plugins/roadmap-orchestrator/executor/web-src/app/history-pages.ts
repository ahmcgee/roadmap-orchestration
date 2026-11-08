// Pages can jump over retained events when a live transcript grows by more than one page.
// Keep a contiguous suffix with its real cursor rather than joining across that unseen gap.
type Page = { events: { id: string }[]; before: string | null; hasMore: boolean | null };
export function mergeHistoryPages<T extends Page>(old:T,next:T):T {
  const events=new Map<string,T['events'][number]>(old.events.map(event=>[event.id,event]));
  if(next.before!==null&&!next.events.some(event=>events.has(event.id)))return next;
  for(const event of next.events)events.set(event.id,event);
  const kept=[...events.values()].slice(-200),dropped=events.size>kept.length;
  return {...next,events:kept,before:dropped?kept[0]!.id:old.before,hasMore:dropped?true:old.hasMore};
}
