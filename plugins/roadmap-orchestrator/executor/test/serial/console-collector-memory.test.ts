// The console's collector worker on an arc shaped like the one that ran it out of memory in the field (dev.63): a small
// journal, witness records whose bytes exceed the collector's whole heap, and an integration branch with a long first-parent
// history over a tree of thousands of files, which the obligations' last-observation walk reads. The real collector worker
// runs under a 384 MB heap and must stay within it capture after capture: what it remembers of evidence and history is
// bounded by bytes (src/observation/memo.ts, src/git/reusekey.ts), not by the arc. Serial tier: it runs a real worker and
// writes a few hundred MB under a temp dir. Synthetic names and data only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';
import type { CollectorReport } from '../../src/console/collector.ts';
import type { HeapReport } from '../../src/console/messages.ts';
import { invocationId, opKey, sha256 } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { LISTING_ENTRIES } from '../../src/git/reusekey.ts';
import { witnessRecord } from '../../src/holistic/types.ts';
import { writeWitnessRecord } from '../../src/holistic/witness.ts';
import type { CollectorMessage, CollectorSizes } from '../../src/observation/collect.ts';
import { RECORD_BYTES } from '../../src/observation/memo.ts';
import { witnessRecordPath } from '../../src/pipeline/lanes.ts';
import { enrichedParityArc } from '../fixtures/status-parity.ts';
import { git } from '../helpers/repo.ts';

const HEAP_MB = 384, FACTS = 50, TESTS = 32_000, FILES = 3_000, COMMITS = 300;
const MB = 1024 * 1024;

/** The arc: the enriched parity arc, then FACTS witnessed facts of its lane with large records, then a long history on main. */
async function heavyArc() {
  const f = await enrichedParityArc();
  const arc = f.d.arc as never, runDir = absPath(f.runDir), repo = absPath(f.d.repo);
  const j = openJournal(runDir, arc);
  let witnessBytes = 0, oldTree = '';
  try {
    const seed = j.view.holistic().witnessed[0]!;
    oldTree = seed.treeSha;
    if (seed.for.type !== 'job') throw new Error('the parity arc\'s witness is a baseline job\'s');
    const parent = { type: 'job', job: seed.for.job } as const;
    const template = witnessRecord(JSON.parse(readFileSync(witnessRecordPath(runDir, seed), 'utf8')), 'witness');
    // One lane's tests, ascending by id, with long ids: about 8 MB a record.
    const tests = [...Array.from({ length: TESTS }, (_, i) => ({ testId: `suite/module-${String(i).padStart(6, '0')}/case ${'x'.repeat(180)}`, selected: 1, outcome: i % 97 === 0 ? 'fail' as const : 'pass' as const })),
      // The obligation's own test, so each record is an observation of it.
      ...template.records];
    for (let n = 0; n < FACTS; n++) {
      const { op } = j.begin({ kind: 'proc.spawn', key: opKey(`memory-witness-${n}`), parent, deadlineAt: null,
        body: () => ({ expect: { subject: { purpose: 'journey', lane: seed.lane, laneRev: seed.laneRev, at: git(repo, 'rev-parse', 'main') as never, owner: parent }, launchSha256: sha256('c'.repeat(64)) }, post: null }) });
      const entry = { ...seed, inv: invocationId(op, 1) };
      const path = witnessRecordPath(runDir, entry);
      mkdirSync(dirname(path), { recursive: true });
      const recordsSha256 = writeWitnessRecord(absPath(dirname(path)), { ...template, inv: entry.inv, records: tests });
      witnessBytes += statSync(path).size;
      const { seq: _seq, ...fact } = entry;
      j.fact({ kind: 'witnessed', ...fact, recordsSha256 });
      j.done(op, 'proc.spawn', { kind: 'result', pressure: null, resultSha256: sha256('c'.repeat(64)), summary: { type: 'command', verdict: 'pass' } }, null);
    }
  } finally { j.close(); }
  // COMMITS commits over FILES files, each changing one: every tree's lane input differs, so the walk reads them all.
  const stamp = (n: number) => `committer Synthetic <synthetic@example.invalid> ${1_700_000_000 + n} +0000\n`;
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  let stream = `commit refs/heads/main\n${stamp(0)}${data('bulk')}from ${git(repo, 'rev-parse', 'main')}\n`;
  for (let i = 0; i < FILES; i++) stream += `M 100644 inline src/bulk/part-${i}.js\n${data(`export const part${i} = ${i};`)}`;
  for (let n = 1; n < COMMITS; n++) stream += `commit refs/heads/main\n${stamp(n)}${data(`change ${n}`)}M 100644 inline src/bulk/part-${n % FILES}.js\n${data(`export const part${n % FILES} = -${n};`)}`;
  execFileSync('git', ['-C', repo, 'fast-import', '--quiet'], { input: stream, timeout: 120_000 });
  git(repo, 'reset', '-q', '--hard');
  return { ...f, arc, runDir, repo, witnessBytes, oldTree };
}

test('the collector stays within its heap on an arc whose evidence and history exceed it', { timeout: 20 * 60_000 }, async (t) => {
  const a = await heavyArc();
  t.after(() => { for (const dir of [a.repo, a.hostDir]) rmSync(dir, { recursive: true, force: true }); });
  assert.ok(a.witnessBytes > HEAP_MB * MB && a.witnessBytes > RECORD_BYTES, `${Math.round(a.witnessBytes / MB)} MB of witness records`);
  assert.ok(COMMITS * FILES > LISTING_ENTRIES, 'the history\'s listings exceed the kept bound');
  const journalMb = statSync(`${a.runDir}/events.jsonl`).size / MB;
  assert.ok(journalMb < 4, `a small journal: ${journalMb} MB`);

  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL('../../src/console/collector.ts', import.meta.url), {
    workerData: { run: { runDir: a.runDir, arc: a.arc }, hostDir: absPath(a.hostDir), common: gitCommonDir(a.repo), port: port1 }, transferList: [port1],
    resourceLimits: { maxOldGenerationSizeMb: HEAP_MB },
  });
  let exited: string | null = null;
  worker.on('error', (e) => { exited = `${(e as NodeJS.ErrnoException).code ?? ''} ${e.message}`; });
  worker.on('exit', (code) => { exited ??= `exit ${code}`; });
  t.after(async () => { port2.close(); await worker.terminate(); });
  const observations: Extract<CollectorMessage, { kind: 'observation' }>[] = [], failures: string[] = [];
  port2.on('message', (m: CollectorMessage) => {
    if (m.kind === 'observation') observations.push(m);
    if (m.kind === 'failed') failures.push(m.error.message);
  });
  const reports: HeapReport<CollectorSizes>[] = [];
  worker.on('message', (m: CollectorReport) => { if (m.kind === 'heap') reports.push(m); });
  const until = async (what: string, ok: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (exited !== null) throw new Error(`the collector died waiting for ${what}: ${exited}`);
      if (failures.length > 0) throw new Error(`a capture failed waiting for ${what}: ${failures.join('; ')}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  await until('the first observation', () => observations.length >= 1, 8 * 60_000);
  // The walk back over the history ran: the obligation observed only on the old tree has it as its last observation.
  const last = observations[0]!.status.notYetTrue.map((o) => o.lastObserved?.treeSha ?? null);
  assert.ok(last.includes(a.oldTree as never), JSON.stringify(observations[0]!.status.notYetTrue));
  // Three more captures, each after a stable input moved (a new ref).
  for (let n = 1; n <= 3; n++) {
    git(a.repo, 'update-ref', `refs/heads/synthetic-poke-${n}`, 'main');
    const seen = observations.length;
    await until(`capture ${n + 1}`, () => observations.length > seen, 4 * 60_000);
  }
  worker.postMessage({ kind: 'report' });
  await until('a heap report', () => reports.some((r) => !r.near), 60_000);
  const report = reports.find((r) => !r.near)!;
  t.diagnostic(`heap report after ${observations.length} captures: ${JSON.stringify(report)}`);
  assert.equal(exited, null, 'the collector is alive');
  assert.ok(report.usedMb < HEAP_MB, `used heap ${report.usedMb} MB`);
  assert.ok(report.sizes.memo.recordBytes <= RECORD_BYTES, `remembered records ${Math.round(report.sizes.memo.recordBytes / MB)} MB`);
  assert.ok(report.sizes.listings <= LISTING_ENTRIES, `${report.sizes.listings} listing entries kept`);
  assert.ok(report.sizes.memo.stamps >= FACTS, 'every witness record read is stamped for the sweep');
});
