// The concurrent crash matrix's M3 scenarios (test/concurrent-matrix.test.ts; M3 B8): an arc's job steps while its units
// are in flight, run by the real supervised `roadmap start` through the whole-pipeline harness (pm-common.ts), keyed
// per unit and per job. A job's crash points pass no unit: a cell selects the occurrence the recording attributes to
// the job (by its log's records, pm-holistic.ts `ownerOf`), and asserts the op the crash hit is the job's. The
// watcher queues the architect's commands (`audit`, `apply`, `rule`) as the CLI does, in its own process.
//
//   jobs     two units, u1 and u2, each parked in a live build runner (the fake implementer at barrier `<unit>.build`),
//            while an `audit` command runs audit-1 (its vision lens) and its checkpoint ckpt-1 applies a bundle (an
//            arc-wide limits op: the revision, its divergence, the digest item). The builds are released once the digest
//            is raised (the bundle's last record), or when a crashed executor's successor has started (its recovery
//            adopts a pinned runner by waiting for it); each unit's spec lane then parks (cm-pin.ts) until the drift
//            audit audit-2's no-op checkpoint ckpt-2 is decided, so no unit publishes before the jobs' story is over,
//            crashed or not. Then both merge, the final audit audit-3 and ckpt-3 (no-ops), the close-out, completion.
//   batch    u3 parked in a live build runner while an `audit` command runs audit-1, whose lens opens F-1 (a P1 over
//            I-2), and ckpt-1 decides a no-op; then the architect admits the repair units u1 and u2 (each repairing F-1)
//            with an `apply`; both approved, they publish as one batch (batch-1: its slot, the chained candidate, its
//            lanes, the batch ff, its snapshot), resolving F-1. u3's build is released once the batch ff is done, or when
//            a crashed executor's successor has started. Then u3 merges, the final audit and checkpoint, the close-out.
//   preempt  u1's candidate parks in a suite lane holding the publication slot before green (the `c-pin` lane, which
//            parks on its first run only) when a `rule` lands C-2 with a contract op: its docs publication preempts the
//            candidate (the kill of its lane, reason `preempt`), publishes, and u1 runs a fresh candidate onto the new
//            tip, is gated again (the contract its approval bound changed) and merges. A crashed executor's successor
//            releases the parked run (its recovery adopts it by waiting for it): a crash before the preemption can then
//            let the candidate go green first (safety, not the uncrashed order, is claimed).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha } from '../../src/core/ids.ts';
import type { LogSnapshot } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { parseRulingSidecar } from '../../src/holistic/types.ts';
import { rulingContextAt } from '../../src/pipeline/publish.ts';
import { consistencyRevs } from '../../src/spec/rulings.ts';
import { bytesSha256 } from '../../src/spec/spec.ts';
import { release } from '../helpers/barrier.ts';
import { checkpointAnswer, checkpointStep, lensStep } from '../helpers/holistic.ts';
import { fixture } from '../helpers/proc.ts';
import type { Owner } from '../helpers/reap.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import { writeWitnessControl } from '../helpers/witness.ts';
import { ADVANCES, VISION, obligationsJson } from './brake-common.ts';
import { restarted, submit } from './cm-common.ts';
import { type ExecRun, SMOKE_DEFAULT, journalOf, setupExec } from './exec-common.ts';
import type { Hook, Laid } from './pm-common.ts';
import { type Sampled, ownerOf, sampleBy } from './pm-holistic.ts';
import { API_OP, barrierSuite } from './publish-common.ts';
import { planCheckStep } from './stage-common.ts';
import { MUL, MUL_LANE, SUITE_LANE, appendSteps, applyBody, codexStep, gateStep } from './unit-common.ts';

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
const LIMITS = { op: 'limits', unit: null, limits: [{ field: 'retries', value: 2 }], cites: ['V-1'], evidence: ['scripted evidence'] };
const NOOP = checkpointAnswer({ decision: 'no-op' });

const keyed = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
const build = (files: Readonly<Record<string, string>>, barrier?: string): Step =>
  codexStep([...(barrier === undefined ? [] : [{ type: 'barrier' as const, name: barrier, timeoutMs: PIN_TIMEOUT_MS, perUnit: true as const }]), { type: 'commit', message: 'add work', files }], { argv: ['exec', '-C'] });
const pinLane = (barriers: string, name: string): Json =>
  ({ id: name, argv: [process.execPath, CM_PIN, barriers, name], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], state: 'active' });

/** The log's facts of `kind` so far (none before the log exists). */
const factsNow = (r: ExecRun, kind: string): readonly Json[] =>
  existsSync(join(r.runDir, 'events.jsonl')) ? journalOf(r).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [e.fact as unknown as Json] : [])) : [];
const once = (name: string, when: () => boolean, act: () => Promise<unknown> | void): Hook => ({ name, when, act: async () => void (await act()) });

/**
 * Makes `r` holistic: vision, obligation I-1 (must-hold, t1 passing on every tree; src/, test/ and contracts/ map to it)
 * on the journey lane, L = {vision}; each of `units` declares I-1. `i2`: also I-2 (must-hold, t2 passing; lib/ maps to it).
 */
function makeHolistic(r: ExecRun, units: readonly string[], i2 = false): void {
  const control = join(tmpDir('cm-witness-control'), 'control.json');
  writeWitnessControl(control, { trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } } });
  const planDir = join(r.planPath, '..');
  writeFileSync(join(planDir, 'vision.json'), JSON.stringify(VISION));
  const mapping = [...['src/**', 'test/**', 'contracts/**'].map((pattern) => ({ pattern, obligations: ['I-1'] })), ...(i2 ? [{ pattern: 'lib/**', obligations: ['I-2'] }] : [])];
  const obligations = [{ id: 'I-1', testIds: ['t1'] }, ...(i2 ? [{ id: 'I-2', testIds: ['t2'] }] : [])];
  writeFileSync(join(planDir, 'obligations.json'), JSON.stringify(obligationsJson({ obligations, mapping }, control)));
  const plan = JSON.parse(readFileSync(r.planPath, 'utf8')) as Json;
  writeFileSync(r.planPath, JSON.stringify({ ...plan, capacity: { cpu: 16 }, holistic: { vision: 'vision.json', advances: ADVANCES, obligations: 'obligations.json', audit: { lenses: ['vision'] } } }));
  for (const u of units) {
    const spec = join(planDir, `${u}.json`);
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

/** The `rule` record landing C-2 with a contract op on contracts/api.md, its consistency judged at the integration tip now. */
function ruleC2(r: ExecRun): string {
  const tip = sha(git(r.repo, 'rev-parse', 'main'));
  const draft: Json = {
    schema: 'roadmap/ruling-m3', id: 'C-2', statement: 'Helpers take finite numbers only.', kind: 'decision', ruledBy: { type: 'architect' }, trigger: 'review',
    supersedes: [], condition: null,
    docRefs: [{ path: 'contracts/api.md', anchor: '#api-contract', quotedText: 'returns the sum', relation: 'consistent' }],
    ...API_OP, obligations: [], obligationDispositions: [], cites: [], evidence: [],
    appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
    consistency: { verdict: 'consistent', judgedRevs: { head: tip, ledgerSha256: 'a'.repeat(64), obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } },
  };
  const reader = { journal: journalOf(r), runDir: absPath(r.runDir), planFile: absPath(r.planPath), repo: absPath(r.repo) };
  const fresh = consistencyRevs(parseRulingSidecar(draft), rulingContextAt(reader as never, tip));
  if ('reasons' in fresh) throw new Error(fresh.reasons.join('; '));
  const path = join(tmpDir('cm-rule'), 'C-2.json');
  writeFileSync(path, `${JSON.stringify({ ...draft, consistency: { ...(draft['consistency'] as Json), judgedRevs: fresh.revs } }, null, 2)}\n`);
  return path;
}

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
      ...keyed('u1', [approve, build(MUL, 'build'), gateStep({ decision: 'approve' })]),
      ...keyed('u2', [approve, build(TWO, 'build'), gateStep({ decision: 'approve' })]),
      lensStep('audit-1', 'vision'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [LIMITS] })),
      lensStep('audit-2', 'vision'), checkpointStep('ckpt-2', NOOP),
      lensStep('audit-3', 'vision'), checkpointStep('ckpt-3', NOOP),
    ]);
    const pinned = (u: string): boolean => existsSync(join(r.scenarioDir, `${u}.build.reached`));
    const hooks: readonly Hook[] = [
      once('audit', () => pinned('u1') && pinned('u2'), () => submit(r, { type: 'audit', lenses: null })),
      once('release-builds', () => factsNow(r, 'divergence-digest').length > 0 || restarted(r), () => {
        release(r.scenarioDir, 'u1.build');
        release(r.scenarioDir, 'u2.build');
      }),
      once('release-lanes', () => factsNow(r, 'bundle-decided').some((f) => f['job'] === 'ckpt-2'), () => {
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
      ...keyed('u3', [approve, build(TWO, 'build'), gateStep({ decision: 'approve' })]),
      lensStep('audit-1', 'vision', [{ severity: 'P1', obligation: 'I-2', claim: 'I-2 is not held on the audited head' }]), checkpointStep('ckpt-1', NOOP),
      ...keyed('u1', [approve, build(MUL), gateStep({ decision: 'approve' })]),
      ...keyed('u2', [approve, build(DIV), gateStep({ decision: 'approve' })]),
      lensStep('audit-2', 'vision'), checkpointStep('ckpt-2', NOOP),
    ]);
    const batchPublished = (): boolean => {
      if (!existsSync(join(r.runDir, 'events.jsonl'))) return false;
      const { view } = journalOf(r);
      return view.opsOf('integration.ff').some((i) => i.expect.subject?.type === 'batch' && view.doneOf(i.op)?.kind === 'integration.ff');
    };
    const hooks: readonly Hook[] = [
      once('audit', () => existsSync(join(r.scenarioDir, 'u3.build.reached')), () => submit(r, { type: 'audit', lenses: null })),
      once('admit-repairs', () => factsNow(r, 'bundle-decided').some((f) => f['job'] === 'ckpt-1'), () => {
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
  // The contract op changes a contract the approval bound: u1's green candidate onto the new tip is fingerprint-invalid, and a second gate approves.
  appendSteps(r, [...SMOKE_DEFAULT, ...keyed('u1', [planCheckStep({ decision: 'approve' }), build(MUL), gateStep({ decision: 'approve' }), gateStep({ decision: 'approve' })])]);
  const hooks: readonly Hook[] = [
    once('rule', () => existsSync(join(barriers, 'lane.reached')), () => {
      const path = ruleC2(r);
      submit(r, { type: 'rule', path: absPath(path), sha256: bytesSha256(readFileSync(path)) });
    }),
    once('release', () => restarted(r), () => writeFileSync(join(barriers, 'lane.release'), '')),
  ];
  return { peer, laid: { r, barriers, hooks } };
}

// ---------------------------------------------------------------------------------------------------
// Sampling: the stepping job's occurrences

/** The stepping jobs: the jobs scenario's audit-1 (the audit row) and ckpt-1 (the bundle row), the batch scenario's batch-1. */
export const STEPPING = { audit: 'audit-1', bundle: 'ckpt-1', batch: 'batch-1' } as const;
export type JobRow = keyof typeof STEPPING | 'preempt';

/**
 * A job row's cells: every label at its first occurrence whose record belongs to the stepping job (each log append at
 * each fact kind of the job's). The preempt row: from the preempting kill's intent on, the first occurrence of every
 * label whose record belongs to the docs publication or the rule's command, or is the kill (u1's), each log append at
 * each fact kind there.
 */
export function sampleJob(row: JobRow, record: string, snap: LogSnapshot): readonly Sampled[] {
  const from = row === 'preempt' ? snap.events.find((e) => e.type === 'intent' && e.kind === 'proc.kill' && e.expect.reason === 'preempt')?.seq : 0;
  if (from === undefined) throw new Error('the preempt recording has no preempting kill');
  const owned = (owner: string, label: string): boolean => {
    if (row !== 'preempt') return owner === `job:${STEPPING[row]}`;
    return owner.startsWith('job:docs-') || owner === 'command' || (label.startsWith('kill.') && owner === 'unit:u1');
  };
  return sampleBy(record, snap, ({ label, e }) => {
    if (e.seq < from || !owned(ownerOf(snap.view, e), label)) return null;
    if (label.startsWith('log.append.')) return e.type === 'fact' && e.fact.kind !== 'meter' && e.fact.kind !== 'usage-unavailable' ? `fact ${e.fact.kind}` : null;
    return row;
  });
}
