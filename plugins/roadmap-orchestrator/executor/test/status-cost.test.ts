import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { statusCostArc } from './fixtures/status-cost.ts';

test('status and summary scale below 15x CPU for 10x journal input, with fixed and growing unit/history counts', { timeout: 60_000 }, async (t) => {
  const small = await statusCostArc(2_000, 8, 8);
  const growing = await statusCostArc(20_000, 80, 80);
  const fixed = await statusCostArc(20_000, 8, 8);
  const child = fileURLToPath(new URL('./fixtures/status-cost-child.ts', import.meta.url));
  const measure = (mode: string, fixture: typeof small): { cpuMs: number; wallMs: number } => {
    const got = spawnSync(process.execPath, [child, mode, fixture.runDir, fixture.arc, fixture.hostDir, String(fixture.units), String(fixture.lines)], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: fixture.forgePath } });
    assert.equal(got.status, 0, `${got.stderr}\n${got.stdout}`);
    return JSON.parse(got.stdout);
  };
  for (const mode of ['status', 'summary']) for (const [name, large] of [['growing', growing], ['fixed', fixed]] as const) {
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < 2; i++) { a.push(measure(mode, small).cpuMs); b.push(measure(mode, large).cpuMs); }
    const ratio = Math.min(...b) / Math.min(...a);
    t.diagnostic(`${mode} ${name}: ${a.map(Math.round)} / ${b.map(Math.round)} ms CPU (including Git); ratio ${ratio.toFixed(2)}`);
    assert.ok(ratio < 15, `${mode} ${name}: 10x input costs ${ratio.toFixed(2)}x CPU`);
    assert.ok(Math.min(...b) < 15_000, `${mode} ${name}: catastrophic CPU regression`);
  }
});
