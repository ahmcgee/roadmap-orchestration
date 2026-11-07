import { isIP } from 'node:net';
import { SchemaError, object, str, type Read } from '../core/validate.ts';
import type { RepoConfig } from '../routing/layers.ts';
export type ConsoleSettings = Readonly<{ host: string; port: number }>;
export const literalHost: Read<string> = (v, p) => { const host = str(v, p); if (!isIP(host)) throw new SchemaError(p, 'an IPv4 or IPv6 literal', v); return host; };
export const consolePort: Read<number> = (v, p) => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) throw new SchemaError(p, 'an integer port in [1, 65535]', v); return v; };
export const webConsole = object((f): ConsoleSettings => ({ host: f.optional('host', literalHost) ?? '0.0.0.0', port: f.optional('port', consolePort) ?? 4747 }));
export const consoleSettings = (config: RepoConfig | null): ConsoleSettings => config?.webConsole ?? { host: '0.0.0.0', port: 4747 };
export function consoleUrl(host: string, port: number, connect = true): string {
  const h = connect && host === '0.0.0.0' ? '127.0.0.1' : connect && host === '::' ? '::1' : host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
}
