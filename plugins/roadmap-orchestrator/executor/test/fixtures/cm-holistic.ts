// Concurrent campaign audits and root decisions, repair batches and preempting docs publication.
// The jobs story keeps u1/u2 in live build runners while campaign audit raises an owner request and
// root apply changes scheduling priority without draining those builds, then root acknowledges the request by id.
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogSnapshot } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { readNeedsUser } from '../../src/needsuser.ts';

import { release } from '../helpers/barrier.ts';
import { lensAnswer,lensStep,packReviewStep } from '../helpers/holistic.ts';
import { fixture } from '../helpers/proc.ts';
import type { Owner } from '../helpers/reap.ts';
import { tmpDir } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import { writeWitnessControl } from '../helpers/witness.ts';
import { ADVANCES,obligationsJson } from './brake-common.ts';
import { restarted,submit } from './cm-common.ts';
import { corpusTarget } from './corpus-target.ts';
import { type ExecRun,SMOKE_DEFAULT,journalOf,setupExec } from './exec-common.ts';
import type { Hook,Laid } from './pm-common.ts';
import { type Sampled,ownerOf,sampleBy } from './pm-holistic.ts';
import { barrierSuite } from './publish-common.ts';
import { planCheckStep } from './stage-common.ts';
import { MUL,MUL_LANE,SUITE_LANE,appendSteps,applyBody,codexStep,gateStep,syncInputs } from './unit-common.ts';

type Json = Record<string, unknown>;

export const HOLISTIC_PEERS = ['jobs', 'preempt', 'batch'] as const;
export type HolisticPeer = (typeof HOLISTIC_PEERS)[number];

const CM_PIN = fixture('cm-pin.ts');
const PIN_TIMEOUT_MS = 300_000;
const TWO = {
  'src/two.js': 'export const two = 2;\n',
  'test/two.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { two } from '../src/two.js';\n\ntest('two', () => {\n  assert.equal(two, 2);\n});\n",
} as const;
const DIV = {
  'src/div.js': 'export function div(a, b) {\n  return a / b;\n}\n',
  'test/div.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { div } from '../src/div.js';\n\ntest('div', () => {\n  assert.equal(div(6, 3), 2);\n});\n",
} as const;
const DIV_LANE = { id: 'div', argv: ['node', '--test', 'test/div.test.js'] } as const;
const TWO_LANE = { id: 'two', argv: ['node', '--test', 'test/two.test.js'] } as const;

const keyed = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
const build = (files: Readonly<Record<string, string>>, barrier?: string): Step =>
  codexStep([...(barrier === undefined ? [] : [{ type: 'barrier' as const, name: barrier, timeoutMs: PIN_TIMEOUT_MS, perUnit: true as const }]), { type: 'commit', message: 'add work', files }], { argv: ['exec', '-C'] });
const pinLane = (barriers: string, name: string): Json =>
  ({ id: name, argv: [process.execPath, CM_PIN, barriers, name], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, cadence: 'build', resources: [], evidenceGlobs: [], state: 'active' });

/** The log's facts of `kind` so far (none before the log exists). */
const factsNow = (r: ExecRun, kind: string): readonly Json[] =>
  existsSync(join(r.runDir, 'events.jsonl')) ? journalOf(r).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [e.fact as unknown as Json] : [])) : [];
const once = (name: string, when: () => boolean, act: () => Promise<unknown> | void): Hook => ({ name, when, act: async () => void (await act()) });

/**
 * Makes `r` holistic on a corpus target (corpus-target.ts, M4a D0): obligation I-1 (must-hold, t1 passing on every
 * tree; src/, test/ and contracts/ map to it) on the journey lane, L = {vision}; each of `units` declares I-1. `i2`: also
 * I-2 (must-hold, t2 passing; lib/ maps to it).
 */
function makeHolistic(r: ExecRun, units: readonly string[], i2 = false): void {
  const control = join(tmpDir('cm-witness-control'), 'control.json');
  writeWitnessControl(control, { trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } } });
  const mapping = [...['app'].map((system) => ({ system, obligations: ['I-1'] })), ...(i2 ? [{ system: 'lib', obligations: ['I-2'] }] : [])];
  // The journey lane's test paths and each witness's file in the baseline (a fresh start requires both, plan defects 2026-10-16).
  const obligations = [{ id: 'I-1', testIds: ['t1'], files: ['test/add.test.js'] }, ...(i2 ? [{ id: 'I-2', testIds: ['t2'], files: ['test/add.test.js'] }] : [])];
  corpusTarget(r, { obligations: obligationsJson({ obligations, mapping, laneExtra: { journey: { testPaths: ['test/**'] } } }, control), advances: ADVANCES, planExtra: { capacity: { cpu: 16 } } });
  for (const u of units) {
    const spec = join(r.planPath, '..', `${u}.json`);
    writeFileSync(spec, JSON.stringify({ ...(JSON.parse(readFileSync(spec, 'utf8')) as Json), obligations: ['I-1'] }));
  }
}

/**
 * The architect's admission of the repair units u1 (mul) and u2 (div), each declaring I-1 and repairing F-1 (the P1 the
 * audit opened), into the plan file (u3's spec renamed, their own lanes); `roadmap apply` puts it in force.
 */
function admitRepairs(r: ExecRun): void {
  const planDir = join(r.planPath, '..');
  const spec = JSON.parse(readFileSync(join(planDir, 'u3.json'), 'utf8')) as Json & { lanes: Json[] };
  const lane = (l: Readonly<{ id: string; argv: readonly string[] }>): Json => ({ ...spec.lanes[0], id: l.id, argv: [...l.argv] });
  for (const [u, l] of [['u1', MUL_LANE], ['u2', DIV_LANE]] as const) {
    writeFileSync(join(planDir, `${u}.json`), JSON.stringify({ ...spec, unit: u, rev: 1, lanes: [lane(l)], repairs: ['F-1'] }));
  }
  const plan = JSON.parse(readFileSync(r.planPath, 'utf8')) as Json & { units: Json[] };
  const u3 = plan.units.find((u) => u['id'] === 'u3')!;
  writeFileSync(r.planPath, JSON.stringify({ ...plan, units: [...plan.units, ...['u1', 'u2'].map((id) => ({ ...u3, id, spec: `${id}.json`, origin: 'repair' }))] }));
}

/** Gives unit `u`'s spec one lane: a one-shot pin (cm-pin.ts) at `name`. */
function pinSpecLane(r: ExecRun, u: string, barriers: string, name: string): void {
  const spec = join(r.planPath, '..', `${u}.json`);
  writeFileSync(spec, JSON.stringify({ ...(JSON.parse(readFileSync(spec, 'utf8')) as Json), lanes: [pinLane(barriers, name)] }));
}

/** Refresh editable files from the executor's current revision before making an owner edit. */
function exportCurrentInputs(r: ExecRun): void {
  syncInputs({ d: r, ctx: { runDir: absPath(r.runDir) }, journal: journalOf(r) });
}

/** An approving gate's note: the corpus arc banks it as debt after the approval (DEBT_BANK, `debt.after-approval`). */
const gateNote = (what: string) => ({evidence: ["fixture:1"],
  severity: 'note', path: null, text: `The ${what} helper has no overflow test.`, contractRef: null, experiments: [],
  debt: { drag: `Every caller of ${what} must guard overflow itself until it has one.` },
}) as const;

export type HolisticConcurrent = Readonly<{ peer: HolisticPeer; laid: Laid }>;

/** Lays out the `peer` scenario for test `t`: the arc, its keyed steps (after the unkeyed startup smoke) and the watcher's hooks. */
export function layoutHolisticConcurrent(t: Owner, peer: HolisticPeer): HolisticConcurrent {
  const barriers = tmpDir('cm-barriers');
  if (peer === 'jobs') {
    const r = setupExec(t, { steps: [], units: [{ id: 'u1' }, { id: 'u2' }] });
    makeHolistic(r, ['u1', 'u2']);
    pinSpecLane(r, 'u1', barriers, 'u1-lanes');
    pinSpecLane(r, 'u2', barriers, 'u2-lanes');
    const approve = planCheckStep({ decision: 'approve' });
    appendSteps(r, [
      ...SMOKE_DEFAULT,
      packReviewStep('review-1'),
      ...keyed('u1', [approve, build(MUL, 'build'), gateStep({ decision: 'approve', findings: [gateNote('mul')] })]),
      ...keyed('u2', [approve, build(TWO, 'build'), gateStep({ decision: 'approve', findings: [gateNote('two')] })]),
      {...lensStep('audit-1', 'vision'), acts: [{type: 'emit', value: {...lensAnswer() as Record<string, import('../../src/core/json.ts').JsonValue>, requests: [{op: 'request', summary: 'Prioritize u1 before starting more work.', evidence: ['src/mul.js:1'], dismisses: null, counterEvidence: null}]}}]}, lensStep('audit-2', 'vision'),
    ]);
    const pinned = (u: string): boolean => existsSync(join(r.scenarioDir, `${u}.build.reached`));
    const applied = (): boolean => journalOf(r).view.opsOf('command.apply').some((i) => journalOf(r).view.planAppliedBy(i.expect.command)?.rev === 2 && journalOf(r).view.doneOf(i.op) !== null);
    const request = () => journalOf(r).view.needsUser().find((n) => readNeedsUser(absPath(r.runDir), n.id)?.reason === 'owner-request');
    const acknowledged = (): boolean => {
      const ack = request()?.ack;
      return ack != null && journalOf(r).view.opsOf('command.apply').some((i) => i.expect.command === ack.command && journalOf(r).view.doneOf(i.op) !== null);
    };
    const hooks: readonly Hook[] = [
      once('audit', () => pinned('u1') && pinned('u2'), () => submit(r, { type: 'audit' })),
      once('root-apply', () => factsNow(r, 'audit-ended').some((f) => f['job'] === 'audit-1') && !factsNow(r, 'plan-applied').some((f) => f['rev'] === 2), () => {
        exportCurrentInputs(r);
        const plan = JSON.parse(readFileSync(r.planPath, 'utf8')) as Json;
        writeFileSync(r.planPath, JSON.stringify({...plan, units: (plan['units'] as Json[]).map((u) => u['id'] === 'u1' ? {...u, priority: 'high'} : u)}));
        submit(r, applyBody(r));
      }),
      once('root-ack', () => applied() && request() !== undefined, () => submit(r, { type: 'ack', needsUser: request()!.id, choice: null })),
      once('release-builds', () => acknowledged() || restarted(r), () => {
        release(r.scenarioDir, 'u1.build');
        release(r.scenarioDir, 'u2.build');
      }),
      once('release-lanes', () => factsNow(r, 'audit-ended').some((f) => f['job'] === 'audit-1'), () => {
        release(barriers, 'u1-lanes');
        release(barriers, 'u2-lanes');
      }),
    ];
    return { peer, laid: { r, barriers, hooks } };
  }
  if (peer === 'batch') {
    const r = setupExec(t, { steps: [], units: [{ id: 'u3', lanes: [TWO_LANE] }] });
    makeHolistic(r, ['u3'], true);
    const approve = planCheckStep({ decision: 'approve' });
    appendSteps(r, [
      ...SMOKE_DEFAULT,
      packReviewStep('review-1'),
      ...keyed('u3', [approve, build(TWO, 'build'), gateStep({ decision: 'approve' })]),
      lensStep('audit-1', 'vision', [{ severity: 'P1', obligation: 'I-2', claim: 'I-2 is not held on the audited head' }]),
      ...keyed('u1', [approve, build(MUL), gateStep({ decision: 'approve' })]),
      ...keyed('u2', [approve, build(DIV), gateStep({ decision: 'approve' })]),
      lensStep('audit-2', 'vision'),
    ]);
    const batchPublished = (): boolean => {
      if (!existsSync(join(r.runDir, 'events.jsonl'))) return false;
      const { view } = journalOf(r);
      return view.opsOf('integration.ff').some((i) => i.expect.subject?.type === 'batch' && view.doneOf(i.op)?.kind === 'integration.ff');
    };
    const hooks: readonly Hook[] = [
      once('audit', () => existsSync(join(r.scenarioDir, 'u3.build.reached')), () => submit(r, { type: 'audit' })),
      once('admit-repairs', () => factsNow(r, 'audit-ended').some((f) => f['job'] === 'audit-1'), () => {
        exportCurrentInputs(r);
        admitRepairs(r);
        submit(r, applyBody(r));
      }),
      once('release-peer', () => batchPublished() || restarted(r), () => release(r.scenarioDir, 'u3.build')),
    ];
    return { peer, laid: { r, barriers, hooks } };
  }
  // The pin parks on its first run only (publish-common.ts `barrierSuite`): the preempting kill ends that run, and every
  // later run (the publication's own suite, u1's fresh candidate) passes at once.
  const r = setupExec(t, { steps: [], suite: [SUITE_LANE, { ...barrierSuite(barriers), id: 'c-pin' }] });
  // Editing the cited ledger changes the approval fingerprint. After the docs publication preempts the
  // candidate, the unit is gated again; a plain ledger edit rewrites no contract and needs no new build.
  appendSteps(r, [...SMOKE_DEFAULT, ...keyed('u1', [
    planCheckStep({ decision: 'approve' }), build(MUL), gateStep({ decision: 'approve' }),
    gateStep({ decision: 'approve' }),
  ])]);
  const hooks: readonly Hook[] = [
    once('rule', () => existsSync(join(barriers, 'lane.reached')), () => {
      exportCurrentInputs(r);
      writeFileSync(join(r.planPath, '..', 'rulings.md'), 'C-1 — Helpers take finite numbers.\n');
      submit(r, applyBody(r));
    }),
    once('release', () => restarted(r), () => writeFileSync(join(barriers, 'lane.release'), '')),
  ];
  return { peer, laid: { r, barriers, hooks } };
}

// ---------------------------------------------------------------------------------------------------
// Sampling: the stepping job's occurrences

/** Audit and root-apply stages in the jobs story, and the repair batch's job. */
export const STEPPING = { audit: 'audit-1', apply: 'root-apply', batch: 'batch-1' } as const;
export type JobRow = keyof typeof STEPPING | 'preempt';

/**
 * A job row's cells: every label at its first occurrence whose record belongs to the stepping job (each log append at
 * each fact kind of the job's); the apply row includes the separate named ack's command boundaries too.
 * The preempt row: from the preempting kill's intent on, the first occurrence of every
 * label whose record belongs to the docs publication or the rule's command, or is the kill (u1's), each log append at
 * each fact kind there.
 */
export function sampleJob(row: JobRow, record: string, snap: LogSnapshot): readonly Sampled[] {
  const source = snap.view.opsOf('revision.commit').find((i) => i.expect.rev === 2)?.expect.source;
  const applyOp = row === 'apply' && source?.type === 'command' ? snap.view.opsOf('command.apply').find((i) => i.expect.command === source.command) : undefined;
  const apply = applyOp === undefined ? null : snap.events.find((e) => e.type === 'intent' && e.op === applyOp.op);
  // Include the named ack as well as the priority apply: closure still has crash coverage on every append boundary.
  const ack = snap.view.needsUser().find((n) => n.ack !== null)?.ack;
  const ackOp = row === 'apply' && ack !== undefined ? snap.view.opsOf('command.apply').find((i) => i.expect.command === ack?.command) : undefined;
  const until = applyOp === undefined ? Infinity : snap.events.find((e) => e.type === 'done' && e.op === (ackOp ?? applyOp).op)?.seq ?? Infinity;
  const request = row === 'apply' ? snap.events.find((e) => e.type === 'intent' && e.kind === 'needsuser.raise' && e.parent.type === 'job' && e.parent.job === 'audit-1') : null;
  const from = row === 'apply' ? request?.seq ?? apply?.seq : row === 'preempt' ? snap.events.find((e) => e.type === 'intent' && e.kind === 'proc.kill' && e.expect.reason === 'preempt')?.seq : 0;
  if (from === undefined) throw new Error('the preempt recording has no preempting kill');
  const owned = (owner: string, label: string): boolean => {
    if (row === 'apply') return owner === 'command' || owner === 'job:audit-1' && label.startsWith('needsuser.raise.');
    if (row !== 'preempt') return owner === `job:${STEPPING[row]}`;
    return owner.startsWith('job:docs-') || owner === 'command' || (label.startsWith('kill.') && owner === 'unit:u1');
  };
  return sampleBy(record, snap, ({ label, e }) => {
    if (e.seq < from || e.seq >= until || !owned(ownerOf(snap.view, e), label)) return null;
    if (label.startsWith('log.append.')) return e.type === 'fact' && e.fact.kind !== 'meter' && e.fact.kind !== 'usage-unavailable' ? `fact ${e.fact.kind}` : null;
    if (row === 'apply' && e.type !== 'fact' && e.op === ackOp?.op) return 'ack';
    return row;
  });
}
