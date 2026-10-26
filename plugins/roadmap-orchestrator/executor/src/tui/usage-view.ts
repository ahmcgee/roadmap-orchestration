import { USAGE_STALE_MS, type ClaudeUsage, type UsageWindow } from './usage.ts';
import { fit, ink, line, type Line, type Tone } from './terminal.ts';

const duration = (ms: number): string => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
};
export function usageLines(usage: ClaudeUsage, columns: number, ascii: boolean, now: number): Line[] {
  const snapshot = usage.snapshot; const sep = ascii ? ' | ' : ' · ';
  const old = snapshot !== null && (now - Date.parse(snapshot.at) > USAGE_STALE_MS || usage.error !== null);
  const meter = (name: string, value: UsageWindow | null): Line => {
    const expired = value?.resetsAt !== null && value?.resetsAt !== undefined && Date.parse(value.resetsAt) <= now;
    const percent = value && !expired ? value.usedPercent : null;
    const tone: Tone = percent === null ? 'muted' : percent >= 95 ? 'fault' : percent >= 75 ? 'wait' : 'accent';
    const size = columns >= 100 ? 12 : 6;
    const filled = percent === null ? 0 : Math.floor(percent * size / 100);
    return line(ink(`${name} `, 'muted'), ink((ascii ? '#' : '━').repeat(filled), tone), ink((ascii ? '-' : '┄').repeat(size - filled), 'border'),
      ink(` ${percent === null ? '--' : `${Math.round(percent * 10) / 10}%`} used`, tone), ...(expired ? [ink(' expired', 'wait')] : []));
  };
  const reset = (value: UsageWindow | null): string => value?.resetsAt ? Date.parse(value.resetsAt) <= now ? 'awaiting update' : duration(Date.parse(value.resetsAt) - now) : 'unknown';
  const age = snapshot ? Math.max(0, now - Date.parse(snapshot.at)) : 0;
  const source = snapshot ? `${old ? 'STALE ' : ''}${snapshot.source === 'api' ? 'live' : 'cached'} ${age < 60_000 ? 'just now' : duration(Math.floor(age / 60_000) * 60_000) + ' ago'}` : usage.pending ? 'loading' : 'unavailable';
  const bars = line(ink('CLAUDE ACCOUNT ', 'strong', true), ...meter('5h', snapshot?.fiveHour ?? null), ink(sep, 'muted'), ...meter('Week', snapshot?.sevenDay ?? null));
  const meta = snapshot && !snapshot.fiveHour && !snapshot.sevenDay ? `Session and weekly limits unavailable${sep}${source}` : snapshot ? `Resets 5h ${reset(snapshot.fiveHour)}${sep}week ${reset(snapshot.sevenDay)}${sep}${source}${snapshot.extraUsage ? sep + 'extra usage on' : ''}`
    : usage.error ?? (usage.pending ? 'Loading session and weekly limits' : 'Waiting for Claude usage data');
  // Errors remain visible even when the last good values are retained.
  return [fit(bars, columns), fit(line(ink(usage.error && snapshot ? `${source}${sep}${usage.error}` : meta, old || usage.error ? 'wait' : 'muted')), columns)];
}
