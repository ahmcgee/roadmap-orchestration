// Persistent TUI example: real git, stages and runner records; scripted model backends only.
// Run from executor/: node test/fixtures/tui-lineage-demo.ts [new-directory]
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arcId, unitId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { readInputFiles, recordPlan } from '../../src/input/inforce.ts';
import { at, record, start } from '../../src/pipeline/stages.ts';
import { runUnit } from '../../src/pipeline/unit.ts';
import { Observer } from '../../src/tui/observer.ts';
import { VISION, ADVANCES } from './brake-common.ts';
import { admitAll, planCheckStep } from './stage-common.ts';
import { contextFor, setupArc, stepUntil, mulBuild, gateStep } from './unit-common.ts';

const base = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync('/var/tmp/roadmap-lineage-demo-');
if (process.argv[2]) mkdirSync(base); // Never overwrite an existing example.
const tmp = process.env['TMPDIR']; process.env['TMPDIR'] = base;
const exitHooks = new Set(process.listeners('exit'));
const initial = setupArc({ units: [{ id: 'multiply' }, { id: 'invoice', after: ['multiply'] }], steps: [
  planCheckStep({ decision: 'approve', notes: 'Scripted example: first multiplication implementation.' }), mulBuild(),
  planCheckStep({ decision: 'approve', notes: 'Scripted example: replaces multiply, preserving its history.' }),
  mulBuild({ 'src/mul.js': 'export function mul(a, b) {\n  // Replacement implementation; retain the multiplication contract.\n  return a * b;\n}\n' }),
  gateStep({ decision: 'approve' }),
] });
// Test helpers normally delete fixtures on exit. This explicit demo command retains its own directories.
for (const hook of process.listeners('exit')) if (!exitHooks.has(hook)) process.removeListener('exit', hook);
if (tmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = tmp;
// Make the simulation visible in the captured streams as well as the example's description.
for (const backend of ['claude', 'codex']) {
  const shim = join(initial.binDir, backend);
  const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'scripted-fixture' });
  writeFileSync(shim, readFileSync(shim, 'utf8').replace('#!/bin/sh\n', `#!/bin/sh\nprintf '%s\\n' '${init}'\n`));
}
const d = { ...initial, arc: 'lineage-example', runDir: join(initial.repo, '.git', 'roadmap-runtime', 'lineage-example') };
mkdirSync(d.runDir, { recursive: true });
const plan = JSON.parse(readFileSync(d.planPath, 'utf8'));
plan.arc = d.arc;
writeFileSync(join(dirname(d.planPath), 'vision.json'), JSON.stringify(VISION));
plan.holistic = { vision: 'vision.json', advances: ADVANCES };
plan.direction = 'SCRIPTED TUI EXAMPLE: multiply was held, then replaced by multiply-v2. Invoice still declares multiply as its prerequisite. No model calls or live executor.';
plan.milestones = [{ id: 'MS-1', text: 'Multiplication is ready for downstream invoice calculations.', units: ['multiply'], design: { supplied: true }, references: ['contracts'],
  bringUp: { setup: [], serve: [], env: {}, seed: [] }, journeys: [{ id: 'J-1', text: 'Multiply two numbers.', via: 'shell', entry: 'node --test test/mul.test.js', budget: null }], resources: [] }];
writeFileSync(d.planPath, JSON.stringify(plan, null, 2));
let r = contextFor(d);
try {
  await stepUntil(r, 'multiply', (f) => f.stage === 'lanes' && f.outcome === 'green');
  record(r.ctx, at(start(r.ctx, unitId('multiply'), 'gate'), 'gate'), 'interrupted');
  assert.equal(r.journal.view.unit(unitId('multiply')).status, 'held');
  const spec = JSON.parse(readFileSync(join(dirname(d.planPath), 'multiply.json'), 'utf8'));
  writeFileSync(join(dirname(d.planPath), 'multiply-v2.json'), JSON.stringify({ ...spec, unit: 'multiply-v2' }, null, 2));
  plan.units.push({ ...plan.units[0], id: 'multiply-v2', spec: 'multiply-v2.json', reenters: { unit: 'multiply' } });
  writeFileSync(d.planPath, JSON.stringify(plan, null, 2));
  recordPlan(r.journal, absPath(d.runDir), readInputFiles(absPath(d.planPath), absPath(d.repo)), [
    { type: 'unit-added', unit: unitId('multiply-v2') },
    { type: 'unit-reentered', unit: unitId('multiply-v2'), reenters: unitId('multiply'), reset: false },
  ], { profile: 'default', config: null, arcRoles: 'm4b' });
} finally { r.journal.close(); }
r = contextFor(d);
try { assert.deepEqual(await runUnit(r.ctx, r.unit('multiply-v2'), admitAll), { kind: 'merged' }); }
finally { r.journal.close(); }
writeFileSync(join(d.runDir, 'start.json'), JSON.stringify({ v: 1, generation: 1, at: new Date().toISOString(), repo: d.repo, planFile: d.planPath, profile: 'default' }));
const reply = new Observer().observe({ locator: { type: 'host' }, hostDir: absPath(d.hostDir), pinned: { arc: arcId(d.arc), runDir: absPath(d.runDir) }, log: null, token: 1 });
assert.equal(reply.error, null);
assert.deepEqual(reply.display!.exceptions, []);
assert.ok(reply.display!.invocations.filter((i) => i.execution === 'agent').every((i) => i.model === 'scripted-fixture'));
assert.equal(reply.display!.status.units.find((u) => u.unit === 'multiply')?.state, 'superseded');
assert.ok(reply.display!.status.edges.some((e) => e.type === 'after' && e.unit === 'invoice' && e.on === 'multiply' && e.effective === 'multiply-v2'));
writeFileSync(join(base, 'demo.json'), JSON.stringify({ ...d, scripted: true, base }, null, 2));
writeFileSync(join(base, 'observed.json'), JSON.stringify(reply.display, null, 2));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const cli = fileURLToPath(new URL('./exec-cli.ts', import.meta.url));
writeFileSync(join(base, 'tui'), `#!/bin/sh\nexec ${[process.execPath, cli, d.hostDir, 'tui', '--repo', d.repo, '--arc', d.arc].map(quote).join(' ')} "$@"\n`);
chmodSync(join(base, 'tui'), 0o755);
writeFileSync(join(base, 'README.txt'), `Scripted replacement-lineage example (no model calls).\nOpen: ${base}/tui\n\nmultiply: superseded, with retained planning/build history.\nmultiply-v2: prepared from multiply and merged, with its own history.\ninvoice: still declares multiply; effective dependency is multiply-v2.\nMS-1: originally lists multiply; progress follows multiply-v2. Walkthrough not run.\n\nStopped snapshot, not a live executor. Agent model labels say scripted-fixture; fixture backends supplied deterministic answers.\nSelect either version to highlight both versions' activity. Enter, then Related documents, links between versions.\n`);
process.stdout.write(`Staged scripted example: ${base}/tui\n`);
