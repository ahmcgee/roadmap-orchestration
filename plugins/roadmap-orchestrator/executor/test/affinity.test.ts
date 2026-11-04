import { freshJudgmentSession } from '../src/backends/argv.ts';
import { absPath } from '../src/core/values.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedCores, tasksetPath } from '../src/contain/affinity.ts';
import { sessionContainment } from '../src/contain/session.ts';
import type { Parent } from '../src/core/events.ts';
import { canonicalJson, sha256Hex } from '../src/core/json.ts';
import { cpuToken, jobIdOfKind, opKey } from '../src/core/ids.ts';
import type { Journal } from '../src/core/interfaces.ts';
import { pinnedCoresOf } from '../src/core/projections.ts';
import { RUNNER_FILE_READERS } from '../src/core/records.ts';
import { invocationDir, invoke, type LaunchSpec } from '../src/pipeline/invoke.ts';
import { launchSha256 } from '../src/runner/launch.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { workRuns } from '../src/status-work.ts';
import { backend, command, events, open, run, scenario, specFor } from './fixtures/invoke-specs.ts';
import { workload } from './helpers/invocation.ts';

const T = { timeout: 30_000 };
function reserve(journal: Journal, parent: Extract<Parent, { type: 'stage' | 'job' }>, tokens: readonly number[] = [3, 4]): void {
  const durable = journal.begin({ kind: 'resource.transition', key: opKey(`affinity:reserve:${tokens.join('-')}`), parent, deadlineAt: null,
    body: () => ({ expect: { holder: parent, resources: tokens.map(cpuToken), edge: { type: 'reserve' } }, post: null }) });
  journal.done(durable.op, 'resource.transition', { kind: 'transitioned' }, null);
}

for (const purpose of ['backend', 'arc-backend', 'lane', 'unreserved-seat'] as const) {
  test(`affinity.${purpose}: real workload and descendant masks, durable records and status`, T, async () => {
    assert.ok(allowedCores().includes(2) && allowedCores().includes(3), 'this host must allow cores 2 and 3');
    const r = run();
    const journal = open(r.runDir, r.arc);
    try {
      const base = purpose === 'lane'
        ? specFor(command(r, 'lane', workload('workload-affinity.ts')))
        : specFor(backend(r, scenario([])));
      assert.equal(base.origin.type, 'new');
      if (base.origin.type !== 'new') throw new Error('expected a fresh invocation');
      const job = jobIdOfKind('walk')('walk-1');
      const parent = purpose === 'arc-backend' ? { type: 'job' as const, job } : base.origin.parent;
      assert.ok(parent.type === 'stage' || parent.type === 'job');
      reserve(journal, { type: 'job', job: jobIdOfKind('walk')('walk-2') }, [1, 2]);
      if (purpose !== 'unreserved-seat') reserve(journal, parent);
      const spec: LaunchSpec = { ...base, origin: { ...base.origin, parent },
        subject: purpose === 'arc-backend'
          ? { purpose: 'arc-backend', role: 'experienceVerdict', tier: 'arc', job, attempt: 1, routingRev: 'routingRev' in base.subject ? base.subject.routingRev : assert.fail('seat routing') }
          : base.subject,
        launch: (dir) => {
          const content = base.launch(dir);
          return { ...content, argv: workload('workload-affinity.ts'), terminal: purpose === 'arc-backend' && content.terminal.type === 'backend'
            ? { ...content.terminal, role: 'experienceVerdict', session: freshJudgmentSession() } : content.terminal };
        } };
      const outcome = await invoke(journal, sessionContainment, spec);
      assert.equal(outcome.kind, 'result');
      const dir = invocationDir(absPath(r.runDir), outcome.inv);
      const expected = purpose === 'backend' || purpose === 'arc-backend' ? '2-3' : /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))![1];
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'stdout'), 'utf8')), { parent: expected, child: expected });
      const files = runnerFiles(dir, outcome.inv);
      const cores = purpose === 'backend' || purpose === 'arc-backend' ? [2, 3] : null;
      assert.deepEqual(files.read('launch.json')?.pinnedCores, cores);
      assert.deepEqual(files.read('exit.json')?.pinnedCores, cores);
      assert.deepEqual(files.read('exit.json')?.child, { type: 'exited', code: 0 });
      assert.deepEqual(workRuns({ journal, runDir: absPath(r.runDir) }, events(r.runDir))[0]?.pinnedCores, cores);
    } finally { journal.close(); }
  });
}

test('affinity.reserved-core-outside-current-mask fails loudly in a real restricted process', () => {
  const taskset = tasksetPath(process.env);
  assert.ok(taskset);
  const module = new URL('../src/contain/affinity.ts', import.meta.url).href;
  const source = `import { validatePinnedCores } from ${JSON.stringify(module)}; validatePinnedCores([1]);`;
  const child = spawnSync(taskset, ['-c', '0,2-4', process.execPath, '--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /reserved @cpu#2 maps to core 1, outside availableParallelism 4 or current affinity mask 0,2,3,4/);
});

test('affinity.reserved-core-outside-availableParallelism fails loudly', () => {
  const taskset = tasksetPath(process.env);
  assert.ok(taskset);
  const module = new URL('../src/contain/affinity.ts', import.meta.url).href;
  const child = spawnSync(taskset, ['-c', '2-3', process.execPath, '--input-type=module', '-e', `import { validatePinnedCores } from ${JSON.stringify(module)}; validatePinnedCores([2]);`], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /reserved @cpu#3 maps to core 2, outside availableParallelism 2/);
});

test('affinity.dev47 records default at read time without changing launch hashes; malformed lists refuse', () => {
  const r = run();
  const spec = specFor(command(r, 'lane', ['true']));
  const sample = { v: 2, arc: r.arc, op: `${r.arc}/1`, inv: `${r.arc}/1#1`, ...spec.launch(absPath(r.runDir)), deadlineAt: new Date().toISOString(), containment: 'session', test: null };
  for (const name of ['launch.json', 'exit.json'] as const) {
    const raw = name === 'launch.json' ? sample : { v: 2, arc: sample.arc, op: sample.op, inv: sample.inv, child: { type: 'exited', code: 0 }, cause: 'exited', endedAt: sample.deadlineAt, quiescedAt: sample.deadlineAt };
    const parsed = RUNNER_FILE_READERS[name](raw, name);
    assert.equal(Object.hasOwn(parsed, 'pinnedCores'), false);
    assert.equal(pinnedCoresOf(parsed), null);
    if (name === 'launch.json') assert.equal(launchSha256(RUNNER_FILE_READERS[name](raw, name)), sha256Hex(canonicalJson(sample)));
    for (const pinnedCores of [[], [2, 2], [3, 2], [-1], [1.5], ['2']]) assert.throws(() => RUNNER_FILE_READERS[name]({ ...raw, pinnedCores }, name));
  }
});
