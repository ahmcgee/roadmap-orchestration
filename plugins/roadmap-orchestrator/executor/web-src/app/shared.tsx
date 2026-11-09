import { createContext, useContext } from 'react';
import type { Signal } from './types.ts';
import { preparedRead } from './prepared-read.ts';
export { ApiError } from './prepared-read.ts';
export const protocol = document.querySelector<HTMLMetaElement>('meta[name="roadmap-protocol"]')!.content;
export const api = `/api/${protocol}`;
// History and evidence are heterogeneous recorded payloads; their renderer narrows by event kind.
export async function get(path: string, signal?: AbortSignal): Promise<any> {
  return preparedRead(api, protocol, path, signal);
}
export const tabs = ['graph', 'timeline', 'activity', 'effort', 'resources', 'attention'] as const;
export type Tab = typeof tabs[number];
export function route() {
  try {
    const [pathname, search = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const p = pathname!.split('/').map(decodeURIComponent);
    const valid = p[0] === 'arcs' && p[1] && (p.length === 2 || tabs.includes(p[2] as Tab)) && (p.length <= 3 || (p.length === 5 && ['units', 'milestones', 'invocations', 'events', 'requests', 'scopes', 'resources'].includes(p[3]!)));
    return valid ? { arc: p[1]!, tab: (p[2] || 'graph') as Tab, unit: p[3] === 'units' ? p[4]! : p[3] === 'milestones' ? `milestone:${p[4]}` : null, inv: p[3] === 'invocations' ? p[4]! : null, event: p[3] === 'events' ? p[4]! : null, request: p[3] === 'requests' ? p[4]! : null, scope: p[3] === 'scopes' ? p[4]! : null, resource: p[3] === 'resources' ? p[4]! : null, query: new URLSearchParams(search), invalid: false } : { arc: null, tab: 'graph' as Tab, unit: null, inv: null, event: null, request: null, scope: null, resource:null, query: new URLSearchParams(), invalid: location.hash !== '' && location.hash !== '#/' };
  } catch { return { arc: null, tab: 'graph' as Tab, unit: null, inv: null, event: null, request: null, scope: null, resource:null, query: new URLSearchParams(), invalid: true }; }
}
export const link = (arc: string, tab: string = route().tab, kind?: 'units' | 'invocations' | 'events' | 'requests' | 'scopes' | 'resources', id?: string) => {
  const current=route(), params=new URLSearchParams(current.arc===arc&&current.tab===tab?current.query:undefined);
  if(kind!=='scopes'||current.scope!==id){params.delete('detailSection');params.delete('detailCursor');}
  if(kind!=='resources'||current.resource!==id){params.delete('detailFrom');params.delete('detailTo');params.delete('resourceEvidence');}
  const query=params.toString(),target=kind==='units'&&id!.startsWith('milestone:')?{kind:'milestones',id:id!.slice(10)}:kind?{kind,id:id!}:null;
  return `#/arcs/${encodeURIComponent(arc)}/${tab}${target ? `/${target.kind}/${encodeURIComponent(target.id)}` : ''}${query?`?${query}`:''}`;
};
export const pluralise = (n: number, singular: string, plural = singular + 's') => `${n} ${n === 1 ? singular : plural}`;
export const money = (n: number) => `$${n.toFixed(2)}`;
export function elapsed(ms: number | null | undefined): string { if (ms == null) return 'Not recorded'; if (ms < 1000) return `${Math.round(ms)} ms`; const n = Math.floor(ms / 1000); return n < 60 ? `${n}s` : n < 3600 ? `${Math.floor(n / 60)}m ${n % 60}s` : n < 86400 ? `${Math.floor(n / 3600)}h ${Math.floor(n % 3600 / 60)}m` : `${Math.floor(n / 86400)}d ${Math.floor(n % 86400 / 3600)}h`; }
export const Clock = createContext(Date.now());
/** One display timezone for the whole console. An explicit `zone` in a deep link still overrides it for that view. */
export function displayZone() { try { const z = localStorage.getItem('roadmap.zone'); if (z) return z; } catch { /* storage can be disabled */ } return Intl.DateTimeFormat().resolvedOptions().timeZone; }
function zoneOrUtc(zone: string) { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } catch { return 'UTC'; } }
/** The console's one date format: "9 Nov 2026, 19:01". Short form omits the year. */
export function formatInstant(at: string, zone: string, short = false) { return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(short ? {} : { year: 'numeric' as const }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zoneOrUtc(zone) }).format(new Date(at)); }
export function zoneLabel(zone: string) { return new Intl.DateTimeFormat('en-GB', { timeZone: zoneOrUtc(zone), timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? zone; }

/** A transport failure is never a statement about the arc: name it as such. */
export function loadError(message: string) { return /^(Failed to fetch|NetworkError|Load failed)/.test(message) ? "Couldn't load this view." : message; }
export function relativeTime(at: string, now: number) { const n = Math.max(0, Math.floor((now - Date.parse(at)) / 1000)); return n < 2 ? 'just now' : n < 60 ? `${n}s ago` : n < 3600 ? `${Math.floor(n / 60)}m ago` : n < 86400 ? `${Math.floor(n / 3600)}h ${Math.floor(n % 3600 / 60)}m ago` : `${Math.floor(n / 86400)}d ${Math.floor(n % 86400 / 3600)}h ago`; }
export function Time({ at, prefix = '' }: { at: string | null; prefix?: string }) { const now = useContext(Clock); return at ? <time dateTime={at} title={formatInstant(at, displayZone())}>{prefix}{relativeTime(at, now)}</time> : <span>Time unrecorded</span>; }
export const glyph: Record<Signal, string> = { passed: '✓', active: '◐', held: 'Ⅱ', failed: '×', pending: '○', withdrawn: '–' };
export function SignalMark({ state }: { state: Signal }) {
  return <span className={`signal signal-${state}`} aria-label={state}><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {state==='passed'?<path d="m3 8 3 3 7-7"/>:state==='active'?<><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 0 0 12Z" fill="currentColor" stroke="none"/></>:state==='held'?<path d="M5 3v10M11 3v10" strokeWidth="3"/>:state==='failed'?<path d="m4 4 8 8M12 4l-8 8"/>:state==='withdrawn'?<path d="M3 8h10"/>:<circle cx="8" cy="8" r="5"/>}
  </svg></span>;
}
export const stageName = (stage: string) => ({ 'pre-build': 'Plan review', build: 'Build', lanes: 'Checks', gate: 'Review', candidate: 'Integration check', ff: 'Merge', snapshot: 'Publish snapshot', verifier: 'Review' }[stage] || (stage.startsWith('lane:') ? (!stage.slice(5)||stage.slice(5)==='null'?'Checks':`Check: ${stage.slice(5)}`) : stage));
