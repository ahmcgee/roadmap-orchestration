import { createContext, useContext } from 'react';
import type { Activity, Envelope, Signal } from './types.ts';
export const protocol = document.querySelector<HTMLMetaElement>('meta[name="roadmap-protocol"]')!.content;
export const api = `/api/${protocol}`;
export class ApiError extends Error { code?: string; }
// History and evidence are heterogeneous recorded payloads; their renderer narrows by event kind.
export async function get(path: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`${api}${path}`, { ...(signal ? { signal } : {}), cache: 'no-store' });
  let value; try { value = await response.json(); } catch { throw new ApiError('Malformed console response'); }
  if (!response.ok) { const error = new ApiError(value.error?.message || `Console response ${response.status}`); error.code = value.error?.code; throw error; }
  if (value.protocol !== protocol) { const error = new ApiError('Reload required: executor version changed'); error.code = 'protocol'; throw error; }
  return value;
}
export const tabs = ['graph', 'timeline', 'activity', 'effort', 'resources', 'attention'] as const;
export type Tab = typeof tabs[number];
export function route() {
  try {
    const p = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    const valid = p[0] === 'arcs' && p[1] && (p.length === 2 || tabs.includes(p[2] as Tab)) && (p.length <= 3 || (p.length === 5 && ['units', 'invocations'].includes(p[3]!)));
    return valid ? { arc: p[1]!, tab: (p[2] || 'graph') as Tab, unit: p[3] === 'units' ? p[4]! : null, inv: p[3] === 'invocations' ? p[4]! : null, invalid: false } : { arc: null, tab: 'graph' as Tab, unit: null, inv: null, invalid: location.hash !== '' && location.hash !== '#/' };
  } catch { return { arc: null, tab: 'graph' as Tab, unit: null, inv: null, invalid: true }; }
}
export const link = (arc: string, tab: string = route().tab, kind?: 'units' | 'invocations', id?: string) => `#/arcs/${encodeURIComponent(arc)}/${tab}${kind ? `/${kind}/${encodeURIComponent(id!)}` : ''}`;
export const pluralise = (n: number, singular: string, plural = singular + 's') => `${n} ${n === 1 ? singular : plural}`;
export const money = (n: number) => `$${n.toFixed(2)}`;
export function elapsed(ms: number | null | undefined): string { if (ms == null) return 'unrecorded'; if (ms < 1000) return `${Math.round(ms)} ms`; const n = Math.floor(ms / 1000); return n < 60 ? `${n}s` : n < 3600 ? `${Math.floor(n / 60)}m ${n % 60}s` : n < 86400 ? `${Math.floor(n / 3600)}h ${Math.floor(n % 3600 / 60)}m` : `${Math.floor(n / 86400)}d ${Math.floor(n % 86400 / 3600)}h`; }
export const Clock = createContext(Date.now());
export function relativeTime(at: string, now: number) { const n = Math.max(0, Math.floor((now - Date.parse(at)) / 1000)); return n < 2 ? 'just now' : n < 60 ? `${n}s ago` : n < 3600 ? `${Math.floor(n / 60)}m ago` : n < 86400 ? `${Math.floor(n / 3600)}h ago` : `${Math.floor(n / 86400)}d ago`; }
export function Time({ at, prefix = '' }: { at: string | null; prefix?: string }) { const now = useContext(Clock); return at ? <time dateTime={at} title={new Date(at).toLocaleString()}>{prefix}{relativeTime(at, now)}</time> : <span>Time unrecorded</span>; }
export const glyph: Record<Signal, string> = { passed: '●', active: '◐', held: '▰', failed: '×', pending: '○', withdrawn: '–' };
export function SignalMark({ state }: { state: Signal }) { return <span className={`signal signal-${state}`} aria-label={state}>{glyph[state]}</span>; }
export const stageName = (stage: string) => ({ 'pre-build': 'Plan review', build: 'Build', lanes: 'Checks', gate: 'Review', candidate: 'Integration check', ff: 'Merge', snapshot: 'Publish snapshot', verifier: 'Review' }[stage] || (stage.startsWith('lane:') ? (!stage.slice(5)||stage.slice(5)==='null'?'Checks':`Check: ${stage.slice(5)}`) : stage));
export const info = (e: Envelope, a: Activity) => e.data.console.presentation.activityInfo.find(i => i.id === a.id) || { label: stageName(a.stage), attempt: a.attempt, round: 1, spend: 0, findings: [] };
