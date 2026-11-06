// Measure after imports, with fresh process caches. Linux cutime/cstime includes waited-for Git children.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { status } from '../../src/status.ts';
import { statusSummary } from '../../src/status/summary.ts';
const [mode, runDir, arc, hostDir, units, lines] = process.argv.slice(2);
const hz = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }); assert.equal(hz.status, 0, hz.stderr);
const ticks = Number(hz.stdout.trim()); assert.ok(ticks > 0);
const children = () => { const stat = readFileSync('/proc/self/stat', 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return (Number(fields[13]) + Number(fields[14])) * 1000 / ticks; };
const childBefore = children(), began = process.cpuUsage(), wall = performance.now();
const value = mode === 'status' ? status(absPath(runDir), arcId(arc), absPath(hostDir)) : statusSummary(absPath(runDir), arcId(arc), absPath(hostDir));
const cpu = process.cpuUsage(began), childMs = children() - childBefore, wallMs = performance.now() - wall;
if ('units' in value) {
  assert.equal(value.units.length, Number(units)); assert.equal(value.host.log.events, Number(lines));
  assert.equal(value.commands.receipts.length, 10); assert.equal(value.answers.length, 1);
  assert.equal(value.notYetTrue.length, 2); assert.equal(value.notYetTrue[0]!.lastObserved?.verdict, 'held');
  assert.equal(value.notYetTrue[1]!.lastObserved?.verdict, 'not-held');
  assert.ok(value.units.every((u) => u.certification?.lanes.length === 2 && u.certification.lanes[0]!.state === 'green' && u.certification.lanes[1]!.state === 'reused' && u.work.length === 1));
} else {
  assert.equal(value.progress.total, Number(units)); assert.equal(value.progress.remaining, 2);
  assert.equal(value.progress.held, 0); assert.ok(value.completion.unmet.includes('units-open'));
}
process.stdout.write(JSON.stringify({ cpuMs: (cpu.user + cpu.system) / 1000 + childMs, wallMs }));
