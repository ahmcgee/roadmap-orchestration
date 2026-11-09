import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { arcBounds } from './views.ts';
export const invalid = (message: string): never => {throw new ConsoleError('invalid', message);};
export function allowParams(params: Record<string, string>, allowed: readonly string[]) {
  for (const key of Object.keys(params)) if (!['epoch', 'revision', 'minHighWater', ...allowed].includes(key)) invalid(`unknown view query parameter: ${key}`);
}
export function choice<T extends string>(params: Record<string, string>, key: string, values: readonly T[], fallback: T): T {
  const value = params[key] ?? fallback;
  if (!values.includes(value as T)) invalid(`unsupported ${key}`);
  return value as T;
}
export function list(params: Record<string, string>, key: string): string[] {
  if (params[key] === undefined) return [];
  const values = params[key].split(',');
  if (values.some(v => !v) || new Set(values).size !== values.length) invalid(`${key} uses distinct comma-separated values`);
  return values.sort();
}
export function known(values: readonly string[], population: readonly string[], key: string) {
  if (values.some(v => !population.includes(v))) invalid(`unknown ${key} filter`);
}
export function pageLimit(params: Record<string, string>, intervals = false): number {
  return Number(choice(params, 'limit', intervals ? ['25', '50', '100', '200'] : ['25', '50', '100'], intervals ? '100' : '50'));
}
export function instant(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return invalid('time range must use RFC3339 instants');
  const [, y, month, day, h, min, s, offset] = m;
  const leap = Number(y) % 4 === 0 && (Number(y) % 100 !== 0 || Number(y) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1]!;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days || Number(h) > 23 || Number(min) > 59 || Number(s) > 59
    || offset !== 'Z' && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59) || !Number.isFinite(Date.parse(value))) return invalid('impossible time range');
  return new Date(value).toISOString();
}
export function timeParams(params: Record<string, string>) {
  const from = params['from'] === undefined ? null : instant(params['from']), to = params['to'] === undefined ? null : instant(params['to']);
  if (params['window'] !== undefined && (from !== null || to !== null)) invalid('window cannot be combined with from/to');
  if (from && to && from >= to) invalid('from must precede to');
  const window = from !== null || to !== null ? null : choice(params, 'window', ['24h', '7d', 'arc'], '24h');
  const zone = params['zone'] ?? 'UTC';
  if (/^[+-]/.test(zone)) invalid('invalid IANA timezone');
  try {new Intl.DateTimeFormat('en', {timeZone: zone});} catch {invalid('invalid IANA timezone');}
  return {window, from, to, zone};
}
export function resolveTime(e: Envelope, time: ReturnType<typeof timeParams>) {
  const arc = arcBounds(e), end = arc.to ?? e.checkedAt;
  const from = time.from ?? (time.window === 'arc' ? arc.from : time.window === null ? null : new Date(Math.max(Date.parse(arc.from ?? end), Date.parse(end) - (time.window === '7d' ? 7 : 1) * 86400_000)).toISOString());
  // A whole-Arc read includes events at the terminal boundary; explicit ranges stay [from,to).
  const to = time.to ?? new Date(Date.parse(end) + 1).toISOString();
  return {scope: {basis: 'recorded-arc' as const, from, to}, bounds: {from: arc.from, to: end, terminalAt: arc.to}};
}
export function intersects(start: string, end: string | null, from: string | null, to: string | null, verifiedEnd: string) {
  const a = Date.parse(start), b = Date.parse(end ?? verifiedEnd), lo = from === null ? -Infinity : Date.parse(from), hi = to === null ? Infinity : Date.parse(to);
  return a < hi && (a === b ? a >= lo : b > lo);
}
