// The whole-pipeline matrix's recording mode, test-only (production code keeps one seam, `crashPoint`).
// Loaded into every roadmap process of a recording run by NODE_OPTIONS=--import=<this file> (the supervisor
// and executor inherit it; runners, backends and lanes get a restricted environment and do not). It swaps
// src/core/crash.ts for a module that never crashes and appends `<entry script> <pid> <label>` to the file
// named by PM_RECORD for every crash point the process reaches, so the test knows exactly which labels a
// scenario passes through, in which process, and how often.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const CRASH = new URL('../../src/core/crash.ts', import.meta.url).href;
/** What the swapped module must export: exactly crash.ts's own exports, or the swap would change behaviour. */
const EXPORTS = ['crashPoint', 'crashTriggerFromEnv'];

const RECORDING = `
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const file = process.env.PM_RECORD;
if (file === undefined || file === '') throw new Error('pm-record: PM_RECORD is not set');
export function crashTriggerFromEnv() {
  return process.env.ROADMAP_TEST_CRASH;
}
export function crashPoint(label) {
  appendFileSync(file, basename(process.argv[1] ?? '?') + ' ' + process.pid + ' ' + label + '\\n');
}
`;

registerHooks({
  load(url, context, nextLoad) {
    if (url !== CRASH) return nextLoad(url, context);
    const source = readFileSync(new URL(url), 'utf8');
    const exported = [...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]).sort();
    if (JSON.stringify(exported) !== JSON.stringify(EXPORTS)) {
      throw new Error(`pm-record: src/core/crash.ts exports ${exported.join(', ')}, the recording module ${EXPORTS.join(', ')}`);
    }
    return { format: 'module', source: RECORDING, shortCircuit: true };
  },
});
