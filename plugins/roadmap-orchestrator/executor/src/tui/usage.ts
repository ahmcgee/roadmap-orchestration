import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { record } from './projection.ts';

export type UsageWindow = { usedPercent: number; resetsAt: string | null };
export type UsageSnapshot = { at: string; source: 'api' | 'claude-cache'; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; extraUsage: boolean | null };
export type ClaudeUsage = { snapshot: UsageSnapshot | null; pending: boolean; error: string | null };
export const USAGE_INTERVAL_MS = 5 * 60_000;
export const USAGE_STALE_MS = 10 * 60_000;
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

function window(value: unknown, modern: boolean): UsageWindow | null {
  if (value === null || value === undefined) return null;
  const row = record(value); const percent = row[modern ? 'percent' : 'utilization']; const reset = row['resets_at'];
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100
    || (reset !== null && reset !== undefined && (typeof reset !== 'string' || !Number.isFinite(Date.parse(reset))))) {
    throw new Error('Claude usage response contains an invalid limit window');
  }
  return { usedPercent: percent, resetsAt: typeof reset === 'string' ? new Date(reset).toISOString() : null };
}
/** Usage API percentages are 0–100; stream-event utilization uses a different 0–1 scale. */
export function parseUsage(value: unknown, at: string, source: UsageSnapshot['source']): UsageSnapshot {
  const data = record(value);
  if (!['five_hour', 'seven_day', 'limits'].some((key) => Object.hasOwn(data, key))) throw new Error('Claude usage response has no supported limit fields');
  const limits = Array.isArray(data['limits']) ? data['limits'].map(record) : [];
  const session = limits.find((row) => row['kind'] === 'session'); const week = limits.find((row) => row['kind'] === 'weekly_all');
  const extra = record(data['extra_usage'])['is_enabled'] ?? record(data['spend'])['enabled'];
  return { at, source, fiveHour: data['five_hour'] != null ? window(data['five_hour'], false) : window(session, true),
    sevenDay: data['seven_day'] != null ? window(data['seven_day'], false) : window(week, true), extraUsage: typeof extra === 'boolean' ? extra : null };
}
function readObject(path: string): Record<string, unknown> {
  try { return record(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Neither JSON parser snippets nor authentication material may enter the display model.
    throw new Error('Claude usage configuration could not be read');
  }
}

/** Worker-local, read-only account observation. No credential refresh, CLI invocation, or persisted cache. */
export class ClaudeUsageReader {
  #snapshot: UsageSnapshot | null = null;
  #error: string | null = null;
  #pending = false;
  #identity = '';
  #checked = -Infinity;
  #nextAttempt = 0;

  poll(): ClaudeUsage {
    const now = Date.now();
    if (now - this.#checked >= 5000) {
      this.#checked = now;
      try {
        const configured = process.env['CLAUDE_CONFIG_DIR']; const dir = configured || join(homedir(), '.claude');
        const config = readObject(configured ? join(dir, '.claude.json') : join(homedir(), '.claude.json'));
        const account = record(config['oauthAccount'])['accountUuid'];
        const credentials = record(readObject(join(dir, '.credentials.json'))['claudeAiOauth']);
        const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'] || credentials['accessToken'];
        const identity = createHash('sha256').update(`${typeof account === 'string' ? account : ''}:${typeof token === 'string' ? token : ''}`).digest('hex');
        if (identity !== this.#identity) { this.#identity = identity; this.#snapshot = null; this.#error = null; this.#nextAttempt = 0; }
        const cached = record(config['cachedUsageUtilization']); const at = cached['fetchedAtMs'];
        if (!process.env['CLAUDE_CODE_OAUTH_TOKEN'] && typeof account === 'string' && cached['accountUuid'] === account && typeof at === 'number'
          && Number.isFinite(at) && at <= now && at > 0 && (!this.#snapshot || at > Date.parse(this.#snapshot.at))) {
          try {
            this.#snapshot = parseUsage(cached['utilization'], new Date(at).toISOString(), 'claude-cache');
            this.#error = null;
            this.#nextAttempt = Math.max(this.#nextAttempt, at + USAGE_INTERVAL_MS);
          } catch { this.#error = 'Claude usage cache is invalid'; }
        }
        if (!this.#pending && now >= this.#nextAttempt) {
          this.#nextAttempt = now + USAGE_INTERVAL_MS;
          if (typeof token !== 'string' || !token) this.#error = 'Claude OAuth credentials unavailable; sign in with Claude Code';
          else if (!process.env['CLAUDE_CODE_OAUTH_TOKEN'] && typeof credentials['expiresAt'] === 'number' && credentials['expiresAt'] <= now) {
            this.#error = 'Claude login expired; open Claude Code to refresh it';
          } else {
            this.#pending = true;
            void this.refresh(token, identity);
          }
        }
      } catch {
        this.#identity = ''; this.#snapshot = null; this.#nextAttempt = 0;
        this.#error = 'Claude usage configuration could not be read';
      }
    }
    return { snapshot: this.#snapshot, pending: this.#pending, error: this.#error };
  }

  private async refresh(token: string, identity: string): Promise<void> {
    try {
      const response = await fetch(ENDPOINT, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'roadmap-executor-tui' } });
      if (identity !== this.#identity) { await response.body?.cancel(); return; }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          const retry = response.headers.get('retry-after'); const seconds = retry === null ? NaN : Number(retry);
          const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retry ?? '');
          this.#nextAttempt = Math.max(this.#nextAttempt, Date.now() + 15 * 60_000, Number.isFinite(retryAt) ? retryAt : 0);
          throw new Error('Claude usage refresh rate-limited; retrying later');
        }
        throw new Error(response.status === 401 || response.status === 403 ? 'Claude usage access expired or denied; check Claude Code login' : `Claude usage service returned HTTP ${response.status}`);
      }
      let body: unknown;
      try { body = await response.json(); } catch { throw new Error('Claude usage service returned invalid JSON'); }
      const snapshot = parseUsage(body, new Date().toISOString(), 'api');
      if (identity !== this.#identity) return;
      this.#snapshot = snapshot; this.#error = null;
    } catch (error) {
      if (identity !== this.#identity) return;
      // Only our fixed diagnostics are safe; fetch/network errors can include URLs or request context.
      this.#error = error instanceof Error && error.message.startsWith('Claude usage ') ? error.message : 'Claude usage refresh unavailable (network or timeout)';
    } finally { this.#pending = false; }
  }
}
