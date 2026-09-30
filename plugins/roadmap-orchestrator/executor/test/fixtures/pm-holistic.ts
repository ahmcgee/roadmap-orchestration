// The holistic whole-pipeline scenario (M3 B8; test/pipeline-matrix.test.ts): an exec-common arc made holistic (a
// vision, obligations witnessed on a fake `journey` arc lane, the required lens set L = {vision}) and run by the real
// supervised `roadmap start` through the whole-pipeline harness (pm-common.ts), keyed per unit and per job.
//
// The story: the start's revision 1; the baseline witness job (A6) runs the journey lane on the baseline before any
// admission; u1 (declaring I-1 must-hold and delivering I-2 future) walks its pipeline, its candidate running the
// journey lane, and its ff latches I-2 (obligation-latched); the final audit `audit-1` (the journey lane, its vision
// lens); the checkpoint `ckpt-1` applies a bundle (an arc-wide limits op: a revision committed through the fence,
// its divergence facts and digest item); the drift audit `audit-2` of generation 2; the checkpoint `ckpt-2`, an
// interpretation-only no-op (H12: one divergence, no revision), which makes generation 2 quiescent; the close-out docs
// publication `docs-1` (docs.commit, its lanes, the docs ff, docs-covered, docs-published, its snapshot); then
// `arc-completed` and the terminal snapshot.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Event, IntentRecord, Parent } from '../../src/core/events.ts';
import { type InvocationId, type JobId, parseInvocationId } from '../../src/core/ids.ts';
import type { JournalView } from '../../src/core/interfaces.ts';
import type { LogSnapshot } from '../../src/core/log.ts';
import { checkpointAnswer, checkpointStep, interpretationOnlyNoop, lensStep } from '../helpers/holistic.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import { writeWitnessControl } from '../helpers/witness.ts';
import { VISION, obligationsJson } from './brake-common.ts';
import { inRevisionAt } from './pm-trace.ts';
import type { ExecRun } from './exec-common.ts';
import type { Scenario } from './pm-common.ts';
import { planCheckStep } from './stage-common.ts';
import { MUL, codexStep, gateStep } from './unit-common.ts';

type Json = Record<string, unknown>;

const MAPPED = ['src/**', 'test/**', 'contracts/**'].map((pattern) => ({ pattern, obligations: ['I-1', 'I-2'] }));
const OBLIGATIONS = [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', activation: 'future' as const, deliveredBy: ['u1'], testIds: ['t2'] }];
/** The applied bundle's one op: an arc-wide limit changed (material, no docs), citing V-1. */
const LIMITS = { op: 'limits', unit: null, limits: [{ field: 'retries', value: 2 }], cites: ['V-1'], evidence: ['scripted evidence'] };

/**
 * Makes the laid-out arc holistic: vision, obligations over a journey witness lane, L = {vision}. The lane passes t1 on
 * every tree and t2 on every tree but the baseline's (I-2 is future: held on the baseline it would be vacuous, A6).
 */
function holistic(r: ExecRun): void {
  const control = join(tmpDir('pm-witness-control'), 'control.json');
  const baseline = git(r.repo, 'rev-parse', 'main^{tree}');
  writeWitnessControl(control, { trees: { [baseline]: { outcomes: { t1: 'pass', t2: 'fail' } }, '*': { outcomes: { t1: 'pass', t2: 'pass' } } } });
  const planDir = join(r.planPath, '..');
  writeFileSync(join(planDir, 'vision.json'), JSON.stringify(VISION));
  writeFileSync(join(planDir, 'obligations.json'), JSON.stringify(obligationsJson({ obligations: OBLIGATIONS, mapping: MAPPED }, control)));
  const plan = JSON.parse(readFileSync(r.planPath, 'utf8')) as Json;
  writeFileSync(r.planPath, JSON.stringify({ ...plan, holistic: { vision: 'vision.json', obligations: 'obligations.json', audit: { lenses: ['vision'] } } }));
  const spec = join(planDir, 'u1.json');
  writeFileSync(spec, JSON.stringify({ ...(JSON.parse(readFileSync(spec, 'utf8')) as Json), obligations: ['I-1', 'I-2'] }));
}

const keyed = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));

export const HOLISTIC: Scenario = {
  arc: () => ({}),
  prepare: holistic,
  steps: () => [
    ...keyed('u1', [
      planCheckStep({ decision: 'approve' }),
      codexStep([{ type: 'commit', message: 'add mul', files: MUL }], { argv: ['exec', '-C'] }),
      gateStep({ decision: 'approve' }),
    ]),
    lensStep('audit-1', 'vision'),
    checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [LIMITS] })),
    lensStep('audit-2', 'vision'),
    checkpointStep('ckpt-2', interpretationOnlyNoop()),
  ],
  hooks: () => [],
};

export const HOLISTIC_OUTCOMES = {
  u1: ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'],
} as const;

// ---------------------------------------------------------------------------------------------------
// Sampling the holistic run's occurrences by the context they fall in

/**
 * Who a log record belongs to: `unit:<u>` (a unit's stage op or fact), `job:<id>` (a job's op or fact), `command` (a
 * command's op or revision: its id is random, so two runs of one scenario name it alike), or `arc`. An op's child
 * (`parent: op`) belongs to its parent's owner; a usage fact to its spawn's.
 */
export function ownerOf(view: JournalView, e: Event): string {
  const ofParent = (p: Parent): string => {
    switch (p.type) {
      case 'stage':
        return `unit:${p.unit}`;
      case 'job':
        return `job:${p.job}`;
      case 'command':
        return 'command';
      case 'op':
        return ofParent(view.latestIntent(p.op).parent);
      case 'arc':
        return 'arc';
    }
  };
  switch (e.type) {
    case 'intent':
      return ofParent(e.parent);
    case 'done':
    case 'abort':
      return ofParent(view.latestIntent(e.op).parent);
    case 'fact': {
      const f = e.fact as Readonly<{ kind: string; inv?: string; job?: unknown; pub?: unknown; for?: Readonly<{ type: string; job?: string }>; unit?: unknown; source?: Readonly<{ type: string; job?: string; command?: string }> }>;
      if (f.kind === 'meter' || f.kind === 'usage-unavailable') return ofParent(view.latestIntent(parseInvocationId(f.inv as InvocationId).op).parent);
      const job = typeof f.job === 'string' ? f.job : typeof f.pub === 'string' ? f.pub : f.for?.type === 'job' ? f.for.job : f.source?.type === 'bundle' ? f.source.job : undefined;
      if (job !== undefined) return `job:${job}`;
      if (f.source?.type === 'command') return 'command';
      return typeof f.unit === 'string' ? `unit:${f.unit}` : 'arc';
    }
  }
}

/**
 * The context of a log record, as the holistic row samples it: `unit` (a unit's own), `unit:journey` (a unit
 * candidate's arc lane), the job kind (`job:baseline`, `job:audit`, `job:ckpt`, `job:docs`: the id's prefix), or `arc`
 * (a command's records too).
 */
export function contextOf(view: JournalView, e: Event): string {
  const owner = ownerOf(view, e);
  if (owner.startsWith('job:')) return owner.slice(0, owner.lastIndexOf('-'));
  if (owner === 'command') return 'arc';
  if (!owner.startsWith('unit:')) return owner;
  const op = e.type === 'intent' ? e : e.type === 'done' || e.type === 'abort' ? view.latestIntent(e.op) : null;
  return op?.kind === 'proc.spawn' && op.expect.subject.purpose === 'journey' ? 'unit:journey' : 'unit';
}

/** The M3 facts whose append the holistic row crashes (each kind's first, at every log.append label). */
export const M3_FACTS: readonly string[] = [
  'witnessed', 'obligation-latched', 'audit-started', 'audit-ended', 'checkpoint-inputs', 'plan-applied', 'divergence', 'divergence-digest',
  'bundle-decided', 'docs-covered', 'docs-published', 'arc-completed',
];

/** Labels only the holistic layer reaches (the row crashes each at occurrence 1, and 2 where it repeats). */
export const M3_ONLY = /^(audit|checkpoint|bundle|closeout|docs|latch|complete)\./;
/** A log append's record is in flight at these labels (the crash leaves it out of the log). */
export const IN_FLIGHT: readonly string[] = ['log.append.before-write', 'log.append.after-partial-write'];

/**
 * A sampled occurrence of `label`: `durable` is how many records the log held when it was reached; `record` the record
 * it cut short (the one in flight at a log append's label, else the last durable), `owner` that record's owner and
 * `ownerRecords` how many of the owner's records were durable then; `why` names the sample.
 */
export type Sampled = Readonly<{ label: string; occurrence: number; why: string; durable: number; seq: number; owner: string; ownerRecords: number }>;

/** What a sampler sees at each executor crash-point line of a recording: the label, its occurrence, the record it cuts short. */
export type Reached = Readonly<{ label: string; occurrence: number; e: Event; durable: number }>;

/**
 * The occurrences `pick` samples, from a recording run's lines in order (`<script> <pid> <label> <unit>`, pm-record.ts)
 * and its log: `pick` names a key (the first occurrence of each label under each key is taken) or null.
 */
export function sampleBy(record: string, snap: LogSnapshot, pick: (x: Reached) => string | null): readonly Sampled[] {
  const lines = record.split('\n').filter((l) => l !== '').map((l) => l.split(' ')).filter(([script]) => script === 'executor.ts');
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  const out: Sampled[] = [];
  let durable = 0;
  for (const [, , label] of lines) {
    const l = label!;
    const occurrence = (seen.get(l) ?? 0) + 1;
    seen.set(l, occurrence);
    if (l === 'log.append.after-fsync') durable += 1;
    const e = snap.events[(IN_FLIGHT.includes(l) ? durable + 1 : durable) - 1];
    if (e === undefined) continue;
    const key = pick({ label: l, occurrence, e, durable });
    if (key === null || taken.has(`${l} ${key}`)) continue;
    taken.add(`${l} ${key}`);
    const owner = ownerOf(snap.view, e);
    const ownerRecords = snap.events.filter((x) => x.seq <= durable && ownerOf(snap.view, x) === owner).length;
    out.push({ label: l, occurrence, why: key, durable, seq: e.seq, owner, ownerRecords });
  }
  return out;
}

/**
 * The holistic row's cells: every M3-only label at occurrence 1, and 2 where it repeats; each log append label at the
 * first append of each M3 fact kind (the plan-applied a bundle's, the start's being the other rows'); every other label
 * at its first occurrence in each holistic context (a job kind, a unit candidate's arc lane, and the arc once the first
 * job has begun: the digest item, the terminal snapshot). Those other labels' occurrences in a unit's own stages and at
 * the start are the straight and bumpy rows' cells.
 */
export function sampleHolistic(record: string, snap: LogSnapshot): readonly Sampled[] {
  const firstJob = snap.events.find((e) => contextOf(snap.view, e).startsWith('job:'))?.seq ?? Infinity;
  return sampleBy(record, snap, ({ label, occurrence, e }) => {
    if (M3_ONLY.test(label)) return occurrence <= 2 ? `#${occurrence}` : null;
    if (label.startsWith('log.append.')) {
      return e.type === 'fact' && M3_FACTS.includes(e.fact.kind) && !(e.fact.kind === 'plan-applied' && e.fact.source?.type === 'start') ? `fact ${e.fact.kind}` : null;
    }
    const ctx = contextOf(snap.view, e);
    return ctx === 'unit' || (ctx === 'arc' && e.seq < firstJob) ? null : ctx;
  });
}

// ---------------------------------------------------------------------------------------------------
// What a holistic run must end as

/**
 * The holistic product: the integration head's tree without the close-out's renderings (`.roadmap/`, which name the
 * run's own paths: its witness lanes' argv), and the renderings by name.
 */
export function holisticProduct(repo: string): unknown {
  const entries = git(repo, 'ls-tree', 'main').split('\n').filter((l) => !l.endsWith('\t.roadmap'));
  const made = spawnSync('git', ['-C', repo, 'mktree'], { input: `${entries.join('\n')}\n`, encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`git mktree in ${repo}: ${made.stderr}`);
  return { product: made.stdout.trim(), renderings: git(repo, 'ls-tree', '-r', '--name-only', 'main', '--', '.roadmap').split('\n') };
}

/**
 * What the holistic layer wrote: each M3 fact kind's count (a witness excepted: a lane a crash cut short runs again and
 * may witness again), the audits' and checkpoints' job ids, the divergences' ids and jobs, the terminal snapshots and
 * whether the completion is active.
 */
export function holisticRecords(snap: LogSnapshot): unknown {
  const facts = snap.events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
  const count = (kind: string): number => facts.filter((f) => f.kind === kind).length;
  return {
    counts: Object.fromEntries(M3_FACTS.filter((k) => k !== 'witnessed').map((k) => [k, count(k)])),
    audits: facts.flatMap((f) => (f.kind === 'audit-started' ? [f.job] : [])),
    ended: facts.flatMap((f) => (f.kind === 'audit-ended' ? [[f.job, f.outcome]] : [])),
    checkpoints: facts.flatMap((f) => (f.kind === 'checkpoint-inputs' ? [f.job] : [])),
    divergences: facts.flatMap((f) => (f.kind === 'divergence' ? [[f.id, f.job]] : [])),
    terminal: snap.view.opsOf('snapshot.publish').filter((i) => i.parent.type === 'arc' && snap.view.doneOf(i.op) !== null).length,
    completion: snap.view.holistic().completion?.active ?? null,
  };
}

/** H2: the input captures appended while a revision.commit was open (none, when the fence holds). */
export function capturesInsideRevisions(events: readonly Event[]): readonly number[] {
  return events.flatMap((e) => (e.type === 'fact' && CAPTURES.includes(e.fact.kind) && inRevisionAt(events, e.seq) ? [e.seq] : []));
}
const CAPTURES: readonly string[] = ['judgment-inputs', 'audit-started', 'checkpoint-inputs'];

/** A log record as the attribution compares it: its kind and its owner. */
export const describeRecord = (snap: LogSnapshot, e: Event): string =>
  `${e.type === 'fact' ? `fact ${e.fact.kind}` : e.type === 'abort' ? 'abort' : `${e.type} ${e.kind}`} (${ownerOf(snap.view, e)})`;
