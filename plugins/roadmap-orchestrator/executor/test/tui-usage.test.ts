import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ClaudeUsageReader, parseUsage, USAGE_INTERVAL_MS } from '../src/tui/usage.ts';
import { usageLines } from '../src/tui/usage-view.ts';
import { plain, width } from '../src/tui/terminal.ts';
import { tmpDir } from './helpers/repo.ts';

const payload = { five_hour: { utilization: 23.5, resets_at: '2099-01-01T12:00:00Z' }, seven_day: { utilization: 84, resets_at: '2099-01-06T12:00:00Z' }, extra_usage: { is_enabled: false } };
function fixture(t: TestContext) {
  const dir = tmpDir('tui-account');
  const previous = { dir: process.env['CLAUDE_CONFIG_DIR'], token: process.env['CLAUDE_CODE_OAUTH_TOKEN'] };
  process.env['CLAUDE_CONFIG_DIR'] = dir; delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  t.after(() => {
    if (previous.dir === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = previous.dir;
    if (previous.token === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN']; else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = previous.token;
  });
  const credentials = join(dir, '.credentials.json'); const config = join(dir, '.claude.json');
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-secret', expiresAt: Date.now() + 24 * 3600_000 } }));
  writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }));
  return { credentials, config };
}

test('Claude account limits validate percentage units, independent absent windows and current limit rows', () => {
  const snapshot = parseUsage(payload, new Date().toISOString(), 'api');
  assert.equal(snapshot.fiveHour!.usedPercent, 23.5); assert.equal(snapshot.sevenDay!.usedPercent, 84);
  assert.equal(parseUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: null }, snapshot.at, 'api').fiveHour!.usedPercent, 0);
  assert.equal(parseUsage({ five_hour: null, seven_day: null }, snapshot.at, 'api').sevenDay, null);
  const current = parseUsage({ limits: [{ kind: 'weekly_all', percent: 100, resets_at: '2099-01-01T00:00:00Z' }] }, snapshot.at, 'api');
  assert.equal(current.fiveHour, null); assert.equal(current.sevenDay!.usedPercent, 100);
  for (const percent of [-1, 101, NaN, '20']) assert.throws(() => parseUsage({ five_hour: { utilization: percent } }, snapshot.at, 'api'), /invalid limit/);
  assert.throws(() => parseUsage({ five_hour: { utilization: 20, resets_at: 'broken' } }, snapshot.at, 'api'), /invalid limit/);
  assert.throws(() => parseUsage({ error: 'denied' }, snapshot.at, 'api'), /no supported limit/);
});

test('Claude usage refresh stays single-flight, preserves good values on failure and never writes credentials', async (t) => {
  const f = fixture(t); const before = [readFileSync(f.config, 'utf8'), readFileSync(f.credentials, 'utf8')];
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let resolve!: (response: Response) => void; let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET'); assert.ok(options.signal);
    assert.equal((options.headers as Record<string, string>)['Authorization'], 'Bearer fixture-secret');
    calls++;
    return calls === 1 ? new Promise<Response>((done) => { resolve = done; }) : new Response('fixture-secret', { status: 401 });
  });
  const reader = new ClaudeUsageReader(); assert.equal(reader.poll().pending, true);
  now += 6000; reader.poll(); assert.equal(calls, 1);
  resolve(new Response(JSON.stringify(payload))); await setImmediate();
  const good = reader.poll(); assert.equal(good.snapshot!.source, 'api'); assert.equal(good.pending, false);
  now += USAGE_INTERVAL_MS; reader.poll(); await setImmediate();
  const failed = reader.poll(); assert.deepEqual(failed.snapshot, good.snapshot); assert.match(failed.error!, /expired or denied/);
  assert.doesNotMatch(JSON.stringify(failed), /fixture-secret/);
  assert.deepEqual([readFileSync(f.config, 'utf8'), readFileSync(f.credentials, 'utf8')], before);
  writeFileSync(f.config, JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }));
  now += 6000; assert.equal(reader.poll().snapshot, null, 'another account never inherits the previous display');
  await setImmediate();
});

test('fresh Claude cache avoids a request and account-mismatched cache is refused', async (t) => {
  const f = fixture(t); const now = Date.now();
  writeFileSync(f.config, JSON.stringify({ oauthAccount: { accountUuid: 'account-a' }, cachedUsageUtilization: { accountUuid: 'account-a', fetchedAtMs: now, utilization: payload } }));
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline fixture-secret'); });
  const cached = new ClaudeUsageReader().poll(); assert.equal(cached.snapshot!.source, 'claude-cache'); assert.equal(request.mock.callCount(), 0);
  writeFileSync(f.config, JSON.stringify({ oauthAccount: { accountUuid: 'account-b' }, cachedUsageUtilization: { accountUuid: 'account-a', fetchedAtMs: now, utilization: payload } }));
  const reader = new ClaudeUsageReader(); assert.equal(reader.poll().snapshot, null); await setImmediate();
  assert.match(reader.poll().error!, /network or timeout/); assert.doesNotMatch(JSON.stringify(reader.poll()), /fixture-secret/);
});

test('rate-limited usage backs off and honours Retry-After; malformed responses stay isolated', async (t) => {
  fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '3600' } }) : new Response('fixture-secret invalid JSON');
  });
  const reader = new ClaudeUsageReader(); reader.poll(); await setImmediate(); assert.match(reader.poll().error!, /rate-limited/);
  now += 16 * 60_000; reader.poll(); assert.equal(calls, 1);
  now += 45 * 60_000; reader.poll(); await setImmediate(); assert.equal(calls, 2); assert.match(reader.poll().error!, /invalid JSON/);
  assert.doesNotMatch(JSON.stringify(reader.poll()), /fixture-secret/);
});

test('expired or missing Claude login never invokes the service or a CLI', (t) => {
  const f = fixture(t); const request = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not request'); });
  writeFileSync(f.credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-secret', expiresAt: 1 } }));
  assert.match(new ClaudeUsageReader().poll().error!, /login expired/);
  writeFileSync(f.credentials, '{}'); assert.match(new ClaudeUsageReader().poll().error!, /credentials unavailable/);
  assert.equal(request.mock.callCount(), 0);
});

test('usage display distinguishes zero, unavailable, stale and expired at both terminal widths', () => {
  const at = '2099-01-01T00:00:00Z'; const now = Date.parse(at);
  const snapshot = parseUsage({ ...payload, five_hour: { utilization: 0, resets_at: null } }, at, 'api');
  for (const columns of [75, 115]) {
    const rows = usageLines({ snapshot, pending: false, error: null }, columns, false, now);
    assert.ok(rows.every((row) => width(plain(row)) === columns));
    assert.match(rows.map(plain).join('\n'), /0% used/); assert.match(rows.map(plain).join('\n'), /84% used/);
    assert.match(rows.map(plain).join('\n'), /Resets/);
    assert.match(rows.map(plain).join('\n'), /live just now/);
    const absent = usageLines({ snapshot: { ...snapshot, fiveHour: null, sevenDay: null }, pending: false, error: null }, columns, false, now).map(plain).join('\n');
    assert.match(absent, /limits unavailable/);
    const stale = usageLines({ snapshot, pending: false, error: null }, columns, false, now + 11 * 60_000).map(plain).join('\n');
    assert.match(stale, /STALE/);
    const expired = usageLines({ snapshot, pending: false, error: null }, columns, false, Date.parse('2099-02-01')).map(plain).join('\n');
    assert.match(expired, /-- used expired/); assert.doesNotMatch(expired, /84%/);
    const missing = usageLines({ snapshot: null, pending: false, error: 'Claude OAuth credentials unavailable' }, columns, true, now).map(plain).join('\n');
    assert.match(missing, /-- used/); assert.doesNotMatch(missing, /0%/); assert.match(missing, /unavailable/);
  }
});
