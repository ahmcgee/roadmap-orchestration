// M3 step B3: the findings store (src/holistic/findings.ts). Dedupe and dismissals over a real journal
// (findings.dedupe, findings.dismissal-arc-scoped); ruling (P1s never bank); ownership moves, due needs-user items and
// the per-finding instrumentation over folded logs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { type Event, type Fact, type LogRecord, prevHash, serializeEvent } from '../src/core/events.ts';
import { arcId, commandId, findingId, jobId, laneId, obligationId, planRev, sha, sha256, unitId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { Fold } from '../src/core/state.ts';
import { absPath, isoTime } from '../src/core/values.ts';
import { MUTANT_PATCH_INPUT } from '../src/git/mutant.ts';
import {
  type FindingDraft, type RepairUnit, batchable, findingItemsDue, findingMetrics, openFinding, ownershipMoves, repairedObligations, ruleFinding, rulingRefusal,
  visionConflictDraft, witnessFindingDraft,
} from '../src/holistic/findings.ts';
import { inputPath } from '../src/input/inforce.ts';
import { PARK_ESCALATE_MS } from '../src/schedule/types.ts';
import { ARC, AT, H, U1, chain } from './fixtures/log-records.ts';
import { tmpDir } from './helpers/repo.ts';

const I1 = obligationId('I-1');
const B1 = sha('b'.repeat(40));
const B2 = sha('c'.repeat(40));
const V = sha256('e'.repeat(64));

const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
  lens: 'invariants', severity: 'P2', obligation: I1, visionClauses: [], claim: 'I-1 is not what the contract says', cause: 'the parser drops cents',
  evidence: [{ path: 'src/parse.js', blob: B1 }], mutant: null, source: { type: 'job', job: jobId('audit', 1) }, gateHadPassed: true, ...over,
});

describe('opening and dedupe', () => {
  it('findings.dedupe: an active key merges; a dismissed key is suppressed until a cited blob changes; each open takes the next id', () => {
    const runDir = absPath(tmpDir('findings-dedupe'));
    const j = openJournal(runDir, ARC);
    try {
      assert.deepEqual(openFinding({ journal: j, runDir }, draft()), { kind: 'opened', id: 'F-1' });
      assert.deepEqual(openFinding({ journal: j, runDir }, draft({ claim: 'the same, worded otherwise', source: { type: 'job', job: jobId('audit', 2) } })), { kind: 'merged', into: 'F-1' });
      assert.deepEqual(openFinding({ journal: j, runDir }, draft({ cause: 'another cause' })), { kind: 'opened', id: 'F-2' });
      assert.deepEqual(openFinding({ journal: j, runDir }, draft({ lens: 'drift' })), { kind: 'opened', id: 'F-3' }, 'the lens is part of the key');
      const opened = j.view.holistic().findings;
      assert.deepEqual(opened.map((f) => [f.id, f.state]), [['F-1', 'open'], ['F-2', 'open'], ['F-3', 'open']]);
      assert.notEqual(opened[0]!.key, opened[1]!.key);

      ruleFinding(j, findingId('F-1'), 'dismissed', { type: 'checkpoint', job: jobId('ckpt', 1) });
      assert.deepEqual(openFinding({ journal: j, runDir }, draft()), { kind: 'suppressed', dismissal: 'F-1' });
      assert.deepEqual(openFinding({ journal: j, runDir }, draft({ evidence: [{ path: 'src/other.js', blob: B2 }] })), { kind: 'suppressed', dismissal: 'F-1' },
        'a path the dismissal did not cite is not a changed blob');
      assert.deepEqual(openFinding({ journal: j, runDir }, draft({ evidence: [{ path: 'src/parse.js', blob: null }] })), { kind: 'suppressed', dismissal: 'F-1' });
      assert.deepEqual(openFinding({ journal: j, runDir }, draft({ evidence: [{ path: 'src/parse.js', blob: B2 }] })), { kind: 'opened', id: 'F-4' },
        'the cited blob changed: new evidence re-raises it');
      assert.deepEqual(openFinding({ journal: j, runDir }, draft({ evidence: [{ path: 'src/parse.js', blob: B2 }] })), { kind: 'merged', into: 'F-4' });

      // A resolved or deferred finding is not a dismissal: its key opens again.
      ruleFinding(j, findingId('F-2'), 'deferred', { type: 'checkpoint', job: jobId('ckpt', 1) });
      assert.deepEqual(openFinding({ journal: j, runDir }, draft({ cause: 'another cause' })), { kind: 'opened', id: 'F-5' });

      // A vacuity finding's patch is kept before its fact names it.
      const patch = 'diff --git a/src/add.js b/src/add.js\n';
      const v = openFinding({ journal: j, runDir }, draft({ lens: 'vacuity', cause: 'add is never checked', mutant: { patch, lane: laneId('journey') } }));
      assert.deepEqual(v, { kind: 'opened', id: 'F-6' });
      const f6 = j.view.holistic().findings.find((f) => f.id === 'F-6')!;
      assert.deepEqual(f6.mutant, { patchSha256: sha256(createHash('sha256').update(patch, 'utf8').digest('hex')), lane: 'journey' });
      assert.equal(readFileSync(inputPath(runDir, f6.mutant!.patchSha256, MUTANT_PATCH_INPUT), 'utf8'), patch);
    } finally {
      j.close();
    }
  });

  it('findings.dismissal-arc-scoped: a dismissal holds for the arc\'s lifetime, across restarts, and never reaches the next arc', () => {
    const runDir = absPath(tmpDir('findings-arc-a'));
    const a = openJournal(runDir, ARC);
    try {
      assert.deepEqual(openFinding({ journal: a, runDir }, draft()), { kind: 'opened', id: 'F-1' });
      ruleFinding(a, findingId('F-1'), 'dismissed', { type: 'checkpoint', job: jobId('ckpt', 1) });
    } finally {
      a.close();
    }
    const again = openJournal(runDir, ARC);
    try {
      for (let n = 0; n < 3; n++) assert.deepEqual(openFinding({ journal: again, runDir }, draft()), { kind: 'suppressed', dismissal: 'F-1' }, 'after a restart, still suppressed');
      assert.equal(again.view.holistic().findings.length, 1);
    } finally {
      again.close();
    }
    const nextDir = absPath(tmpDir('findings-arc-b'));
    const b = openJournal(nextDir, arcId('arc-2'));
    try {
      assert.deepEqual(openFinding({ journal: b, runDir: nextDir }, draft()), { kind: 'opened', id: 'F-1' }, 'the next arc starts with no dismissal');
    } finally {
      b.close();
    }
  });

  it('findings.drafts: code\'s witness P1 has one stable cause per obligation; a plan-check vision conflict is a P3 from its attempt', () => {
    const w1 = witnessFindingDraft({ obligation: I1, job: jobId('audit', 1), claim: 'I-1 not held at a', evidence: [], gateHadPassed: true });
    const w2 = witnessFindingDraft({ obligation: I1, job: jobId('audit', 2), claim: 'I-1 not held at b', evidence: [], gateHadPassed: false });
    assert.equal(w1.cause, w2.cause);
    assert.deepEqual([w1.lens, w1.severity, w1.obligation], ['witness', 'P1', 'I-1']);
    const c = visionConflictDraft({ unit: U1, attempt: 2, clauses: ['V-2' as never, 'V-1' as never], note: 'A2 accepts any input' });
    assert.deepEqual([c.lens, c.severity, c.obligation, c.source], ['plan-check', 'P3', null, { type: 'stage', unit: U1, stage: 'plan-check', attempt: 2 }]);
  });
});


// ---------------------------------------------------------------------------------------------------
// Folded logs

const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const plan = (rev: number): LogRecord => fact({
  kind: 'plan-applied', rev: planRev(rev), command: rev === 1 ? null : commandId('cmd-0123456789abcdef'), planSha256: H, specs: { u1: H, u2: H }, changes: [],
  ...(rev === 1 ? { scheduling: 'dag' } : {}), visionSha256: V,
});
const opened = (n: number, over: object = {}): LogRecord => fact({
  kind: 'finding-opened', id: `F-${n}`, key: sha256(String(n).repeat(64)), lens: 'invariants', severity: 'P1', obligation: 'I-1', visionClauses: [], claim: 'c',
  evidence: [], mutant: null, source: { type: 'job', job: 'audit-1' }, gateHadPassed: false, ...over,
});
const move = (n: number, to: object): LogRecord => fact({ kind: 'finding-transition', id: `F-${n}`, to });

function folded(records: readonly LogRecord[], events: Event[] = chain(records)): Fold {
  const f = new Fold(ARC);
  for (const e of events) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
  return f;
}

const unitOf = (unit: string, repairs: readonly string[], progress: RepairUnit['progress']): RepairUnit => ({ unit: unitId(unit), repairs: repairs as never, progress });

describe('ruling and ownership', () => {
  it('findings.p1-never-banks: a checkpoint may dismiss a P1, never defer or accept it; a ruling may; a P3 may be deferred', () => {
    const view = folded([plan(1), opened(1), opened(2, { severity: 'P3', lens: 'vision', visionClauses: ['V-1'], obligation: null })]);
    const [p1, p3] = view.holistic().findings;
    const ckpt = { type: 'checkpoint', job: jobId('ckpt', 1) } as const;
    assert.equal(rulingRefusal(p1!, 'dismissed', ckpt), null);
    assert.match(rulingRefusal(p1!, 'deferred', ckpt) ?? '', /P1s never bank/);
    assert.match(rulingRefusal(p1!, 'accepted', ckpt) ?? '', /P1s never bank/);
    assert.equal(rulingRefusal(p1!, 'deferred', { type: 'ruling', ruling: 'C-2' as never }), null, 'a disposition ruling defers it');
    assert.equal(rulingRefusal(p3!, 'deferred', ckpt), null);
  });

  it('findings.ownership: the first live repairer owns a finding, its standing approval fixes it on its branch, its publication resolves it; a unit gone releases it', () => {
    const records = [plan(1), opened(1), opened(2, { lens: 'witness', obligation: 'I-2' }), opened(3, { severity: 'P2', obligation: null })];
    const view = folded(records);
    const f = view.holistic().findings;
    assert.deepEqual(ownershipMoves(f, [unitOf('u1', ['F-1'], { kind: 'working' }), unitOf('u2', ['F-1'], { kind: 'working' })]),
      [{ id: 'F-1', to: [{ state: 'owned', unit: 'u1' }] }], 'the first in plan order owns it');
    assert.deepEqual(ownershipMoves(f, [unitOf('u1', ['F-1'], { kind: 'approved' })]), [{ id: 'F-1', to: [{ state: 'owned', unit: 'u1' }, { state: 'fixed-on-branch', unit: 'u1' }] }]);
    assert.deepEqual(ownershipMoves(f, [unitOf('u1', ['F-1'], { kind: 'published', seq: 99 })]),
      [{ id: 'F-1', to: [{ state: 'owned', unit: 'u1' }, { state: 'fixed-on-branch', unit: 'u1' }, { state: 'resolved' }] }]);
    // A witness P1 resolves by any repair of its obligation published after it opened; nothing else does.
    assert.deepEqual(ownershipMoves(f, [unitOf('u2', ['I-2'], { kind: 'published', seq: 99 })]),
      [{ id: 'F-2', to: [{ state: 'owned', unit: 'u2' }, { state: 'fixed-on-branch', unit: 'u2' }, { state: 'resolved' }] }]);
    assert.deepEqual(ownershipMoves(f, [unitOf('u2', ['I-2'], { kind: 'published', seq: 1 })]), [], 'a publication before the finding opened resolves nothing');
    assert.deepEqual(ownershipMoves(f, [unitOf('u2', ['I-1'], { kind: 'published', seq: 99 })]), [], 'an invariants P1 is resolved only by a repair naming it');

    const owned = folded([...records, move(1, { state: 'owned', unit: 'u1' }), move(3, { state: 'owned', unit: 'u2' }), move(3, { state: 'fixed-on-branch', unit: 'u2' })]).holistic().findings;
    assert.deepEqual(ownershipMoves(owned, [unitOf('u1', ['F-1'], { kind: 'gone' }), unitOf('u2', ['F-3'], { kind: 'working' })]), [
      { id: 'F-1', to: [{ state: 'open' }] },
      { id: 'F-3', to: [{ state: 'owned', unit: 'u2' }] },
    ], 'a cut owner releases it; a voided approval takes it back to owned');
    assert.deepEqual(ownershipMoves(owned, [unitOf('u1', ['F-1'], { kind: 'gone' }), unitOf('u2', ['F-1'], { kind: 'working' })]),
      [{ id: 'F-1', to: [{ state: 'open' }, { state: 'owned', unit: 'u2' }] }, { id: 'F-3', to: [{ state: 'open' }] }],
      'ownership passes to the next live repairer; a finding no unit repairs any more is open');
    assert.deepEqual(batchable(owned, [unitOf('u1', ['F-1'], { kind: 'approved' }), unitOf('u2', ['F-1'], { kind: 'approved' })]), [{ finding: 'F-1', units: ['u1', 'u2'] }]);
    assert.deepEqual(batchable(owned, [unitOf('u1', ['F-1'], { kind: 'approved' }), unitOf('u2', ['F-1'], { kind: 'working' })]), []);
    assert.deepEqual([...repairedObligations(owned, ['F-1', 'F-3', 'I-2'] as never)].sort(), ['I-1', 'I-2'], 'a finding over no obligation repairs none');
  });
});

describe('needs-user items and instrumentation', () => {
  const parked = (unit: string, attempt: number): LogRecord =>
    fact({ kind: 'stage-outcome', unit, stage: 'gate', attempt, outcome: 'refusal', class: 'park', chargeable: false, park: { class: 'operator', kind: 'design' } });

  it('findings.p1-escalates: a parked owner\'s active P1 escalates at the park deadline (blocking), once per park', () => {
    const view = folded([plan(1), opened(1), move(1, { state: 'owned', unit: 'u1' }), opened(2, { severity: 'P2' }), move(2, { state: 'owned', unit: 'u1' }), parked('u1', 4)]);
    const at = Date.parse(AT);
    assert.deepEqual(findingItemsDue(view, new Date(at + PARK_ESCALATE_MS - 1)), []);
    const due = findingItemsDue(view, new Date(at + PARK_ESCALATE_MS));
    assert.equal(due.length, 1);
    assert.deepEqual([due[0]!.reason, due[0]!.parent, due[0]!.content.blocking], ['finding-p1-escalated', { type: 'stage', unit: 'u1', stage: 'gate', attempt: 4 }, true]);
    assert.match(due[0]!.content.summary, /F-1 is owned by unit u1/, 'only the P1');
  });

  it('findings.draining: a P1 or P2 opened while draining raises new-finding-draining once its audit ended; a P3, or one opened before, does not', () => {
    const audit = (kind: 'audit-started' | 'audit-ended'): LogRecord => fact(kind === 'audit-started'
      ? { kind, job: 'audit-1', triggers: [{ type: 'cadence' }], generation: 1, lenses: ['invariants'], integrationSha: B1, planRev: 1, ledgerSha256: null, obligationsSha256: null, visionSha256: V, owners: [], priorFindings: [], highWater: 1 }
      : { kind, job: 'audit-1', covered: [{ lens: 'invariants', from: B2, to: B1 }], findings: ['F-2', 'F-3', 'F-4'], suppressed: 0, outcome: 'completed' });
    const base = [plan(1), opened(1, { source: { type: 'job', job: 'baseline-1' } }), fact({ kind: 'admissions-closed', command: 'cmd-00000000000000aa' }), audit('audit-started'), opened(2), opened(3, { severity: 'P2' }),
      opened(4, { severity: 'P3', lens: 'vision', visionClauses: ['V-1'], obligation: null })];
    assert.deepEqual(findingItemsDue(folded(base), new Date(AT)), [], 'the audit is still running');
    const due = findingItemsDue(folded([...base, audit('audit-ended')]), new Date(AT));
    assert.deepEqual(due.map((d) => [d.reason, d.parent, d.content.blocking]), [['new-finding-draining', { type: 'job', job: 'audit-1' }, true]]);
    assert.match(due[0]!.content.summary, /F-2, F-3 \(P1 or P2\)/);
  });

  it('findings.metrics: lens, severity, gateHadPassed, disposition, merged and time to resolve, per finding', () => {
    const records = [plan(1), opened(1, { gateHadPassed: true }), opened(2, { severity: 'P3', lens: 'vision', visionClauses: ['V-1'], obligation: null }), opened(3, { severity: 'P2' }),
      move(1, { state: 'owned', unit: 'u1' }), move(1, { state: 'fixed-on-branch', unit: 'u1' }), move(1, { state: 'resolved' }),
      move(2, { state: 'ruled', disposition: 'deferred', by: { type: 'checkpoint', job: 'ckpt-1' } })];
    const events = chain(records).map((e, i) => ({ ...e, at: isoTime(new Date(Date.parse(AT) + i * 1000).toISOString()) }));
    const rechained = events.reduce<Event[]>((out, e) => [...out, { ...e, prev: out.length === 0 ? null : prevHash(Buffer.from(serializeEvent(out.at(-1)!))) }], []);
    const view = folded(records, rechained);
    assert.deepEqual(findingMetrics(rechained, view.holistic().findings), [
      { id: 'F-1', lens: 'invariants', severity: 'P1', gateHadPassed: true, disposition: null, merged: true, timeToResolveMs: 5000 },
      { id: 'F-2', lens: 'vision', severity: 'P3', gateHadPassed: false, disposition: 'deferred', merged: false, timeToResolveMs: 5000 },
      { id: 'F-3', lens: 'invariants', severity: 'P2', gateHadPassed: false, disposition: null, merged: false, timeToResolveMs: null },
    ]);
  });
});
