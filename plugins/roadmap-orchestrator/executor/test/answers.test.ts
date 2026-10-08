// The owner-answer channel (src/answers.ts, `roadmap answer`) over real chained corpus arcs: real repos and pins, real
// run dirs and folds, real snapshot refs, the CLI as a child for the crash row (ANSWER_RECORD). Named tests:
// answer.record-supersede, answer.refused, answer.visible, answer.live-record-first, answer.unapplied-row,
// answer.watch-event, answer.crash-rerun.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { answersDir, latestAnswers, answerLog, unappliedAnswers } from '../src/answers.ts';
import { brief } from '../src/commands/brief.ts';
import { chainStatus } from '../src/commands/chain.ts';
import type { BriefId } from '../src/core/ids.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { status } from '../src/status.ts';
import { ActionableFilter, HEARTBEAT_MIN, watch } from '../src/watch.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { type CorpusArc, betweenArc, check, corpusArc, editPhase0, inForce, newHostDir, nextArc, runDirOfArc, seal, withForge } from './helpers/corpusarc.ts';
import { runUntilExit } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { ANSWER_RECORD, crashCells } from './matrix.ts';

const T = { timeout: 120_000 };
const BIN = fileURLToPath(new URL('../bin/roadmap', import.meta.url));
type Json = Record<string, unknown>;

const TEXT = 'Is the cancellation window 24 h or 48 h?';
const question = (state: Json): Json => ({ id: 'P-1', rank: 1, text: TEXT, files: ['0010_Overview.md'], bears: ['T-1'], assumption: '24 h', state });
const OPEN = { type: 'open' };
const answered = (answer: string): Json => ({ type: 'answered', answer, at: '2026-10-08T00:00:00.000Z' });

/** Arc 1 sealed (complete) asking P-1, the between-arc commit, and arc 2 chained over it (not in force) carrying P-1 `p1`. */
async function chained(p1: Json = OPEN): Promise<Readonly<{ a1: CorpusArc; a2: CorpusArc }>> {
  const a1 = await corpusArc();
  editPhase0(a1, (r) => ({ ...r, questions: [question(OPEN)] }));
  const h1 = await seal(a1);
  betweenArc(a1.repo, h1);
  const a2 = await nextArc(a1, h1, 'arc-2');
  editPhase0(a2, (r) => ({ ...r, questions: [question(p1)] }));
  return { a1, a2 };
}

async function cli(a: CorpusArc, args: readonly string[], env: Readonly<Record<string, string>> = {}) {
  const r = await runUntilExit(process.execPath, [BIN, ...args], { env: { PATH: a.forge.path, HOME: process.env['HOME'] ?? '/', ...env }, timeoutMs: 60_000 });
  return { ...r, json: r.code === 0 || r.code === 78 ? (JSON.parse(r.stdout) as Json) : null };
}
const answer = (a: CorpusArc, text: string, more: readonly string[] = [], env: Readonly<Record<string, string>> = {}) => cli(a, ['answer', 'P-1', '--repo', a.repo, '--text', text, ...more], env);
const files = (a: CorpusArc): readonly string[] => {
  const dir = answersDir(gitCommonDir(a.repo));
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe('roadmap answer', () => {
  it('answer.record-supersede: an answer is recorded write-once at once; the same text again writes nothing; another text supersedes (latest wins)', T, async () => {
    const { a1 } = await chained();
    const first = await answer(a1, '48 hours');
    assert.equal(first.code, 0, first.stderr);
    const one = (first.json as { recorded: Json }).recorded;
    assert.deepEqual({ ...one, at: null }, { schema: 'roadmap/answer-m4a', question: 'P-1', k: 1, answer: '48 hours', at: null, arc: 'arc-1' });
    assert.deepEqual(files(a1), ['P-1.1.json']);
    const again = await answer(a1, '48 hours');
    assert.deepEqual([again.code, again.json], [0, { unchanged: one }]);
    assert.deepEqual(files(a1), ['P-1.1.json']);
    const second = await answer(a1, '48 hours before the window opens');
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(files(a1), ['P-1.1.json', 'P-1.2.json']);
    const log = answerLog(gitCommonDir(a1.repo));
    assert.deepEqual(log.map((a) => [a.k, a.answer]), [[1, '48 hours'], [2, '48 hours before the window opens']]);
    assert.deepEqual(latestAnswers(log).map((a) => a.answer), ['48 hours before the window opens']);
  });

  it('answer.refused: no Phase-0 record, a question the newest record does not hold, or one it marks answered are refused (exit 78, nothing written)', T, async () => {
    const fresh = await corpusArc();
    const none = await answer(fresh, 'x');
    assert.deepEqual([none.code, none.json], [78, { refused: { type: 'no-phase0-record', arc: null } }]);
    const { a1, a2 } = await chained(answered('24 hours'));
    const unknown = await cli(a1, ['answer', 'P-7', '--repo', a1.repo, '--text', 'x']);
    assert.deepEqual([unknown.code, unknown.json], [78, { refused: { type: 'question-unknown', question: 'P-7', arc: 'arc-1' } }]);
    inForce(a2).close();
    const closed = await answer(a2, '48 hours');
    assert.deepEqual([closed.code, closed.json], [78, { refused: { type: 'question-not-open', question: 'P-1', arc: 'arc-2' } }], 'arc 2 is the newest arc, and it answered P-1');
    const named = await answer(a2, '48 hours', ['--arc', 'arc-1']);
    assert.equal(named.code, 0, '--arc names the record to answer against');
    const usage = await cli(a1, ['answer', '--repo', a1.repo, '--text', 'x']);
    assert.equal(usage.code, 64);
    assert.deepEqual(files(fresh), []);
  });

  it('answer.visible: status, the brief (payload and Markdown, first) and chain status list an unapplied answer; a record answering it with its text clears it', T, async () => {
    const { a1, a2 } = await chained(answered('48 hours'));
    await answer(a1, '48 hours');
    const hostDir = newHostDir();
    const listed = (await withForge(a1.forge, () => chainStatus({ repo: a1.repo }))).answers;
    assert.deepEqual(listed.map((a) => [a.question, a.answer]), [['P-1', '48 hours']]);
    assert.match(listed[0]!.line, /^P-1 answered at .*: "48 hours" — apply it now/);
    assert.deepEqual(status(runDirOfArc(a1), a1.arc, hostDir).answers.map((a) => a.line), [listed[0]!.line]);
    const b = await withForge(a1.forge, () => brief({ repo: a1.repo, ack: null as BriefId | null }));
    assert.equal(b.kind, 'brief');
    if (b.kind !== 'brief') throw new Error('unreachable');
    assert.deepEqual(b.payload.answers.map((a) => a.question), ['P-1']);
    assert.ok(b.markdown.startsWith(`# Roadmap brief ${b.briefId}\n\n## Owner answers to apply now\n\n- ${listed[0]!.line}\n`), b.markdown);
    // Arc 2 starts with P-1 answered with that text: applied, so nothing is listed anywhere.
    inForce(a2).close();
    assert.deepEqual(unappliedAnswers(gitCommonDir(a1.repo)), []);
    assert.deepEqual(status(runDirOfArc(a1), a1.arc, hostDir).answers, []);
    const after = await withForge(a1.forge, () => brief({ repo: a1.repo, ack: null as BriefId | null }));
    assert.ok(after.kind === 'brief' && after.payload.answers.length === 0 && !after.markdown.includes('Owner answers'));
  });

  it('answer.live-record-first: the newest arc\'s live run dir decides before its ref exists; another text in it is unapplied', T, async () => {
    const { a1, a2 } = await chained(answered('24 hours'));
    await answer(a1, '48 hours', ['--arc', 'arc-1']);
    inForce(a2).close();
    assert.deepEqual(unappliedAnswers(gitCommonDir(a1.repo)).map((a) => a.answer), ['48 hours'], 'arc 2 (no ref yet) answered P-1 otherwise');
  });

  it('answer.unapplied-row: a fresh start\'s record marks every answer in force answered with its text (answer-unapplied), else phase0 check refuses', T, async () => {
    const { a1, a2 } = await chained(OPEN);
    assert.deepEqual((await check(a2)).rows, []);
    await answer(a1, '48 hours');
    const problems = async (): Promise<unknown> => (await check(a2)).rows.flatMap((r): unknown[] => (r.kind === 'phase0-invalid' ? [...r.problems] : [r]));
    assert.deepEqual(await problems(), [{ type: 'answer-unapplied', question: 'P-1' }], 'carried open');
    editPhase0(a2, (r) => ({ ...r, questions: [question(answered('24 hours'))] }));
    assert.deepEqual(await problems(), [{ type: 'answer-unapplied', question: 'P-1' }], 'answered with another text');
    editPhase0(a2, (r) => ({ ...r, questions: [] }));
    assert.deepEqual(await problems(), [{ type: 'answer-unapplied', question: 'P-1' }], 'not carried: arc 1 still has it open');
    editPhase0(a2, (r) => ({ ...r, questions: [question(answered('48 hours'))] }));
    assert.deepEqual((await check(a2)).rows, []);
    // A superseding answer is the one in force.
    await answer(a1, '72 hours', ['--arc', 'arc-1']);
    assert.deepEqual(await problems(), [{ type: 'answer-unapplied', question: 'P-1' }]);
  });

  it('answer.watch-event: watch emits an unapplied answer once (present at start, or new); --actionable\'s filter passes each (question, k) once across arcs', T, async () => {
    const { a1 } = await chained();
    await answer(a1, '48 hours');
    const lines: Json[] = [];
    const stop = new AbortController();
    const running = watch(runDirOfArc(a1), a1.arc, newHostDir(), (l) => void lines.push(JSON.parse(l) as Json), stop.signal);
    const answers = (): Json[] => lines.filter((l) => l['event'] === 'answer');
    const until = async (n: number): Promise<void> => {
      for (const end = Date.now() + 20_000; answers().length < n; await sleep(50)) if (Date.now() > end) assert.fail(JSON.stringify(lines));
    };
    await until(1);
    await answer(a1, '72 hours');
    await until(2);
    await sleep(1_000);
    stop.abort();
    await running;
    assert.deepEqual(answers().map((l) => ({ ...l, at: null })), [
      { event: 'answer', question: 'P-1', k: 1, answer: '48 hours', at: null },
      { event: 'answer', question: 'P-1', k: 2, answer: '72 hours', at: null },
    ]);
    const f = new ActionableFilter(0, HEARTBEAT_MIN);
    const line = JSON.stringify(answers()[0]);
    assert.equal(f.feed('arc-1', line), line);
    assert.equal(f.feed('arc-2', line), null, 'the answer log is the repo\'s: one wake per answer');
    assert.equal(f.feed('arc-1', JSON.stringify(answers()[1])), JSON.stringify(answers()[1]));
  });
});

describe('roadmap answer crash rows', () => {
  for (const cell of crashCells(ANSWER_RECORD)) {
    it(`answer.crash-rerun @ ${cell.label}: ${cell.recovery}`, T, async () => {
      const { a1 } = await chained();
      const trigger = writeTrigger(tmpDir('answer-crash'), { label: cell.label, occurrence: 1 });
      const crashed = await answer(a1, '48 hours', [], { ROADMAP_TEST_CRASH: trigger });
      assertFired(trigger);
      assert.notEqual(crashed.code, 0);
      assert.deepEqual(files(a1), ['P-1.1.json'], 'the answer is durable, whole');
      const recorded = answerLog(gitCommonDir(a1.repo))[0]!;
      const rerun = await answer(a1, '48 hours');
      assert.deepEqual([rerun.code, rerun.json], [0, { unchanged: { ...recorded } }]);
      assert.deepEqual(files(a1), ['P-1.1.json'], 'the rerun writes nothing');
    });
  }
});
