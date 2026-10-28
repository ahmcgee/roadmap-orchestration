import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { arcId, findingId, jobId, milestoneId, sha, sha256, unitId } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { LogCorruptError, ObserverJournal, fragmentName, openJournal, readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { type FindingDraft, openFinding, ruleFinding } from '../src/holistic/findings.ts';
import { settleWalks } from '../src/walk/walk.ts';
import { walkArc } from './fixtures/walk-common.ts';
import { contextFor } from './fixtures/unit-common.ts';
import { tmpDir } from './helpers/repo.ts';

const arc = arcId('cursor-transfer');

test('prepared writer includes appended lines, preserves the tail rule and resets the observer after transfer', () => {
  const dir = absPath(tmpDir('cursor-transfer'));
  const path = join(dir, 'events.jsonl');
  const empty = new ObserverJournal(dir, arc);
  assert.equal(empty.read().view.highWater(), 0);
  assert.equal(existsSync(path), false);
  const first = openJournal(dir, arc); first.fact({ kind: 'containment-mode', mode: 'session' }); first.close();
  const cursor = new ObserverJournal(dir, arc);
  assert.equal(cursor.read().view.highWater(), 1);
  const next = openJournal(dir, arc); next.fact({ kind: 'containment-mode', mode: 'session' }); next.close();
  appendFileSync(path, '{"torn');
  const before = readdirSync(dir);
  cursor.read();
  assert.deepEqual(readdirSync(dir), before, 'the pre-claim read writes no fragment');
  const prepared = cursor.open();
  assert.equal(prepared.view.highWater(), 3);
  assert.equal(prepared.derived().tailDiscarded.length, 1);
  prepared.fact({ kind: 'containment-mode', mode: 'session' });
  prepared.close();
  assert.deepEqual(cursor.read().events, readJournal(dir, arc).events);
});

test('cursor transfer equals a cold open after append, tail, saved fragment, replacement, truncation or deletion', () => {
  for (const change of ['append', 'tail', 'fragment', 'replace', 'truncate', 'delete', 'empty'] as const) {
    const dir = absPath(tmpDir('cursor-cold'));
    const path = join(dir, 'events.jsonl');
    const first = openJournal(dir, arc);
    first.fact({ kind: 'containment-mode', mode: 'session' });
    const prefix = readFileSync(path);
    first.fact({ kind: 'containment-mode', mode: 'session' }); first.close();
    const cursor = new ObserverJournal(dir, arc);
    const before = cursor.read().view;
    if (change === 'append') {
      const next = openJournal(dir, arc); next.fact({ kind: 'executor-started', generation: 3 }); next.close();
    } else if (change === 'tail') appendFileSync(path, '{"torn');
    else if (change === 'fragment') {
      const fragment = Buffer.from('{"torn');
      writeFileSync(join(dir, fragmentName(readFileSync(path).length, sha256(sha256Hex(fragment)))), fragment);
    } else if (change === 'replace') {
      writeFileSync(path + '.new', prefix); renameSync(path + '.new', path);
    } else if (change === 'truncate') writeFileSync(path, prefix);
    else if (change === 'delete') rmSync(path);
    else writeFileSync(path, '');
    const coldDir = absPath(tmpDir('cursor-cold-copy'));
    for (const name of readdirSync(dir)) copyFileSync(join(dir, name), join(coldDir, name));
    const cold = openJournal(coldDir, arc);
    const prepared = cursor.open();
    try {
      assert.deepEqual(prepared.derived(), cold.derived(), change);
      assert.deepEqual(prepared.view.holistic(), cold.view.holistic(), change);
      assert.deepEqual(prepared.view.findingsAt(prepared.view.highWater()), cold.view.holistic().findings, change);
      if (change === 'append') {
        assert.equal(prepared.view, before, 'an append advances and transfers the existing verified fold');
        assert.equal(prepared.view.lastExecutorStarted(), 3);
      }
      assert.deepEqual(readdirSync(dir).sort(), readdirSync(coldDir).sort(), change);
      for (const name of readdirSync(dir).filter((name) => name.startsWith('events.torn.'))) {
        assert.deepEqual(readFileSync(join(dir, name)), readFileSync(join(coldDir, name)), change);
      }
    } finally { prepared.close(); cold.close(); }
  }
});

test('a prepared cursor still refuses a complete corruption added or rewritten since its read', () => {
  for (const rewrite of [false, true]) {
    const dir = absPath(tmpDir('cursor-corrupt'));
    const path = join(dir, 'events.jsonl');
    const j = openJournal(dir, arc); j.fact({ kind: 'containment-mode', mode: 'session' }); j.close();
    const cursor = new ObserverJournal(dir, arc); cursor.read();
    if (rewrite) writeFileSync(path, readFileSync(path, 'utf8').replace('session', 'invalid'));
    else appendFileSync(path, 'bad complete line\n');
    let cold: LogCorruptError | undefined;
    try { openJournal(dir, arc); } catch (error) { assert.ok(error instanceof LogCorruptError); cold = error; }
    assert.ok(cold);
    assert.throws(() => cursor.open(), (error: unknown) => error instanceof LogCorruptError && error.offset === cold!.offset && error.detail === cold!.detail);
  }
});

const draft = (cause: string): FindingDraft => ({ lens: 'walkthrough', severity: 'P1', obligation: null, milestone: milestoneId('MS-1'), visionClauses: [], claim: cause, cause,
  evidence: [], mutant: null, source: { type: 'job', job: jobId('walk', 1) }, gateHadPassed: false });

test('historical finding states equal full prefix folds across ownership, reopen, resolution and rulings', () => {
  const dir = absPath(tmpDir('finding-history'));
  const j = openJournal(dir, arc);
  openFinding(j, draft('first'));
  const opened = j.view.findingsAt(j.view.highWater());
  const id = findingId('F-1'), unit = unitId('u1');
  j.fact({ kind: 'finding-transition', id, to: { state: 'owned', unit } });
  openFinding(j, draft('second'));
  j.fact({ kind: 'containment-mode', mode: 'session' });
  j.fact({ kind: 'finding-transition', id, to: { state: 'open' } });
  j.fact({ kind: 'finding-transition', id, to: { state: 'owned', unit } });
  j.fact({ kind: 'finding-transition', id, to: { state: 'fixed-on-branch', unit } });
  j.fact({ kind: 'finding-transition', id, to: { state: 'resolved' } });
  ruleFinding(j, findingId('F-2'), 'dismissed', { type: 'code', reason: 'not-reproduced' });
  assert.equal(opened[0]!.state, 'open', 'previously returned finding states survive later transitions');
  assert.throws(() => j.fact({ kind: 'finding-transition', id, to: { state: 'open' } }), /moves resolved/);
  for (let seq = 0; seq <= j.view.highWater() + 1; seq++) assert.deepEqual(j.view.findingsAt(seq), readJournal(dir, arc, seq).view.holistic().findings, `seq ${seq}`);
  j.close();
});

test('settleWalks uses findings at the end: a later repair cannot pass it, and a later finding cannot prevent the pass', () => {
  const r = contextFor(walkArc({ steps: [] }));
  try {
    const milestone = milestoneId('MS-1');
    const start = (round: number) => r.journal.fact({ kind: 'walk-started', job: jobId('walk', round), milestone, round, sha: sha(r.ctx.plan().baseline), ports: {} });
    const end = (round: number) => r.journal.fact({ kind: 'walk-ended', job: jobId('walk', round), outcome: 'reported', findings: [], proposals: [], dropped: [] });
    start(1); openFinding(r.journal, draft('blocking then')); end(1);
    ruleFinding(r.journal, findingId('F-1'), 'dismissed', { type: 'code', reason: 'not-reproduced' });
    settleWalks(r.ctx);
    const passes = () => r.journal.view.walkFacts().filter(({ fact }) => fact.kind === 'milestone-passed');
    assert.equal(passes().length, 0);
    start(2); end(2); openFinding(r.journal, draft('opened later'));
    settleWalks(r.ctx);
    assert.deepEqual(passes().map(({ fact }) => fact.kind === 'milestone-passed' ? fact.job : null), [jobId('walk', 2)]);
  } finally { r.journal.close(); }
});
