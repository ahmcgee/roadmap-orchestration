// dev.81 (D3): the printed status folds history that grows with an arc (work rows, settled units' certification lanes,
// applied receipts' postconditions), while the envelope the console views and the TUI read keeps it whole. On a field arc
// recorded with production writers: a retired unit's printed bytes do not grow with its invocations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/core/json.ts';
import { absPath } from '../src/core/values.ts';
import { cpuSummaries } from '../src/console/tab-projections.ts';
import { unitView } from '../src/console/details.ts';
import type { Status } from '../src/status.ts';
import { VERIFIED_SHOWN, wireStatus } from '../src/status-wire.ts';
import type { WorkRun } from '../src/status-work.ts';
import { Observations } from './helpers/observations.ts';
import { generateScaleArc } from './helpers/scale-arc.ts';
import { tmpDir } from './helpers/repo.ts';

const bytes = (v: unknown) => Buffer.byteLength(canonicalJson(v));
/** `s` with each unit's (and the host's) work rows repeated `n` times under fresh invocation ids, and every applied receipt's
 * postconditions repeated `n` times: what a longer arc of the same shape records. */
function longer(s: Status, n: number): Status {
  const more = (rows: readonly WorkRun[]) => rows.flatMap((r) => Array.from({ length: n }, (_, i) => ({ ...r, inv: `${r.inv}-${i}` }) as WorkRun));
  return { ...s, units: s.units.map((u) => ({ ...u, work: more(u.work) })), host: { ...s.host, work: more(s.host.work) },
    commands: { ...s.commands, receipts: s.commands.receipts.map((r) => r.state === 'applied' ? { ...r, verified: Array.from({ length: n }, () => r.verified).flat() } : r) } };
}

test('dev.81 D3: the printed status keeps a retired unit\'s bytes flat in its invocations; the views still read every run', { timeout: 120_000 }, async () => {
  const m = await generateScaleArc(tmpDir('status-wire'), { preset: 'design', field: true });
  const e = new Observations(absPath(m.hostDir), 'wire', 'reader').read({ runDir: absPath(m.runDir), arc: m.arc as never });
  const s = e.data.display.status, retired = s.units.filter((u) => u.state === 'merged' && u.work.length > 0);
  assert.ok(retired.length >= 10, `${retired.length} retired units with recorded work`);

  // The fixture's stopped arc keeps no applied receipt in its last ten: add one as an apply records it (`verified` one line per
  // postcondition), so the fold is read on the shape the field showed (6,913 lines in one receipt).
  const receipt = { v: 2, command: 'cmd-0000000000000901', state: 'applied', at: s.run.heartbeatAt ?? '2026-11-07T20:00:00.000Z', op: 'op-1', verified: ['unit u1 admitted', 'unit u2 admitted', 'plan rev 2 in force'] } as unknown as Status['commands']['receipts'][number];
  const base: Status = { ...s, commands: { ...s.commands, receipts: [...s.commands.receipts, receipt] } };
  const wide = longer(base, 50), now = wireStatus(base), later = wireStatus(wide);
  for (const u of retired) {
    const id = u.unit, full = (x: Status) => bytes(x.units.find((l) => l.unit === id)), printed = (x: ReturnType<typeof wireStatus>) => bytes(x.units.find((l) => l.unit === id));
    assert.ok(full(wide) > full(base) + 49 * bytes(u.work) * 0.9, `${id}: the full line grows with its runs`);
    // Totals grow in digits only: a few bytes, never a row's worth.
    assert.ok(printed(later) - printed(now) < 32, `${id}: ${printed(now)} printed bytes became ${printed(later)} with 50x its runs`);
    const line = now.units.find((l) => l.unit === id)!;
    assert.equal('work' in line, false);
    assert.deepEqual([line.workTotals.builds + line.workTotals.lanes, line.workTotals.measured], [u.work.length, u.work.filter((r) => r.measured !== null).length]);
    if (line.certification !== null) assert.equal('lanes' in line.certification, false, `${id}: a settled unit's certification lanes are counted`);
  }
  assert.ok(bytes(later.host) - bytes(now.host) < 32, 'host work is totals');
  assert.equal('work' in now.host, false);
  // A live unit keeps its certification lanes.
  for (const u of now.units) if (u.certification !== null && !['merged', 'cut', 'superseded'].includes(u.state)) assert.ok('lanes' in u.certification, `${u.unit} keeps its lanes`);

  // Applied receipts: the first postconditions and the count; the record on disk has them all.
  const applied = later.commands.receipts.filter((r) => r.state === 'applied');
  assert.ok(applied.length > 0 && applied.some((r) => r.state === 'applied' && r.verifiedTotal > VERIFIED_SHOWN), 'a long applied receipt is folded');
  for (const r of applied) {
    const whole = wide.commands.receipts.find((w) => w.command === r.command)!;
    assert.ok(whole.state === 'applied' && r.state === 'applied' && 'verifiedTotal' in r);
    assert.deepEqual([r.verified, r.verifiedTotal], [whole.verified.slice(0, VERIFIED_SHOWN), whole.verified.length]);
  }

  // The envelope is untouched: the CPU evidence and a retired unit's detail still read every run.
  const unit = retired[0]!;
  const cpu = cpuSummaries(e).filter((g) => g.parent.type === 'unit' && g.parent.id === String(unit.unit));
  assert.equal(cpu.reduce((n, g) => n + g.measuredCalls + g.unmeasuredCalls + g.excludedCalls + g.zeroWallCalls, 0) > 0, true, 'CPU evidence covers the retired unit');
  const detail = unitView(e, String(unit.unit), { section: 'invocations', limit: '100' });
  assert.ok('invocations' in detail && detail.invocations.rows.length > 0, 'the unit detail lists its invocations');
  assert.equal(e.data.display.status.units.find((l) => l.unit === unit.unit)!.work.length, unit.work.length, 'wireStatus never mutates the full status');
});
