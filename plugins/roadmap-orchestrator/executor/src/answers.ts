// The owner-answer channel (M4a, paid runs 12-14: an unattended root agent that never ends its turn never received the
// owner's answer to a ranked Phase-0 question). The owner, or the root agent relaying a chat answer, records it with
// `roadmap answer <P-n> --text <answer>` (src/commands/answer.ts) the moment it is given, whether or not an arc is live.
//
// The store is the answer log: write-once files `$(git-common-dir)/roadmap/answers/<P-n>.<k>.json` (`OwnerAnswer`,
// SCHEMAS.md), beside the ack log (src/chain.ts) and for the same reasons: a live arc is not needed (between arcs there
// is no executor to queue a command to), every reader (`phase0 check`, `start`, `status`, `brief`, `chain status`,
// `watch`) reads one place without a host lock, and nothing is rewritten. The k-th answer to a question supersedes the
// (k-1)-th; the highest k is in force. The log is the owner's input and the only record of it: everything else
// (applied or not) is derived from it and the arcs' Phase-0 records.
//
// **Applied.** An answer is applied when the Phase-0 record of the newest arc that carries its question marks it
// `answered` with the answer's text (`at` is the root agent's to copy). The newest arc first: an arc's live run dir
// (its revision in force, so a mid-arc `apply` counts at once), else its verified snapshot ref. Arcs are ordered by
// their log's first event. A fresh start judges its own record first, then its chain's earlier arcs (`answerProblems`,
// src/phase0/rows.ts).
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type ArcRef, arcsWithRefs, readArcRef } from './chain.ts';
import { crashPoint } from './core/crash.ts';
import { durableMkdir, exclusivePublish } from './core/fsx.ts';
import { type ArcId, type PhaseQuestionId, arcId, compareIds } from './core/ids.ts';
import { canonicalJson } from './core/json.ts';
import { EVENTS_FILE, readJournal } from './core/log.ts';
import { type AbsPath, absPath, isoTimeOf } from './core/values.ts';
import { gitCommonDir } from './git/git.ts';
import { runDir } from './input/cli.ts';
import { PHASE0_INPUT, keptInput, keptPayload, planInForce } from './input/inforce.ts';
import { ANSWER_SCHEMA, type OwnerAnswer, type PhaseQuestion, type QuestionState, parseOwnerAnswer, parsePhase0Record } from './phase0/types.ts';

/**
 * The git common dir of a run dir (`<common>/roadmap-runtime/<arc>`, src/input/cli.ts `runDir`): `status` and `watch`
 * read the repo's answers through it, and git reads it as the repo (every read here is of refs and objects).
 */
export const commonDirOfRun = (run: AbsPath): AbsPath => absPath(dirname(dirname(run)));
export const answersDir = (common: AbsPath): AbsPath => absPath(join(common, 'roadmap', 'answers'));
const FILE = /^(P-[1-9][0-9]*)\.([1-9][0-9]*)\.json$/;
const answerPath = (common: AbsPath, a: Readonly<{ question: PhaseQuestionId; k: number }>): string => join(answersDir(common), `${a.question}.${a.k}.json`);

/** The answer files' names, sorted: what changes when an answer is recorded (`watch` polls it). */
export function answerNames(common: AbsPath): readonly string[] {
  const dir = answersDir(common);
  return existsSync(dir) ? readdirSync(dir).filter((n) => FILE.test(n)).sort() : [];
}

/** Every recorded answer, ascending by question then k; each file holds what its name says, and each question's k run 1, 2, ... */
export function answerLog(common: AbsPath): readonly OwnerAnswer[] {
  const out = answerNames(common).map((n) => {
    const a = parseOwnerAnswer(JSON.parse(readFileSync(join(answersDir(common), n), 'utf8')));
    if (`${a.question}.${a.k}.json` !== n) throw new Error(`${join(answersDir(common), n)} holds answer ${a.k} to ${a.question}`);
    return a;
  }).sort((x, y) => compareIds(x.question, y.question) || x.k - y.k);
  out.forEach((a, i) => {
    const expected = i > 0 && out[i - 1]!.question === a.question ? out[i - 1]!.k + 1 : 1;
    if (a.k !== expected) throw new Error(`${answersDir(common)}: answer ${a.k} to ${a.question} where ${expected} was due (the log is append-only)`);
  });
  return out;
}

/** The answer in force per question (its highest k), ascending by question. */
export const latestAnswers = (log: readonly OwnerAnswer[]): readonly OwnerAnswer[] => log.filter((a, i) => log[i + 1]?.question !== a.question);

// ---------------------------------------------------------------------------------------------------
// The arcs' Phase-0 questions now

/** The questions of a Phase-0 record's bytes. */
const recordQuestions = (bytes: Buffer): readonly PhaseQuestion[] => parsePhase0Record(JSON.parse(bytes.toString('utf8'))).questions;

/** The questions of the Phase-0 record in force at an arc's verified ref, or null when it has none. */
export function refQuestions(ref: ArcRef): readonly PhaseQuestion[] | null {
  const sha = ref.manifest.phase0;
  return sha === undefined ? null : recordQuestions(ref.input(sha, PHASE0_INPUT));
}

/** The questions of the arc's Phase-0 record in force now: its run dir's revision when it has a log, else its ref's; null when neither holds one. */
export function questionsNow(repo: AbsPath, arc: ArcId): readonly PhaseQuestion[] | null {
  const dir = runDir(gitCommonDir(repo), arc);
  if (existsSync(join(dir, EVENTS_FILE))) {
    const inForce = planInForce(dir, readJournal(dir, arc).view);
    const payload = inForce?.fact.payloadSha256;
    if (inForce !== null && payload !== undefined) {
      const sha = keptPayload(dir, payload).manifest.phase0;
      if (sha === undefined) return null;
      const bytes = keptInput(dir, sha, PHASE0_INPUT);
      if (bytes === null) throw new Error(`arc ${arc}'s revision in force names Phase-0 record ${sha}, which its run dir does not keep`);
      return recordQuestions(bytes);
    }
  }
  const ref = readArcRef(repo, arc);
  return ref === null ? null : refQuestions(ref);
}

/** A log's first complete line (newline-terminated; a torn one is not an event yet), read without reading the whole log. */
function firstLine(path: string): string | null {
  const fd = openSync(path, 'r');
  try {
    const chunks: Buffer[] = [];
    for (let at = 0; ;) {
      const chunk = Buffer.alloc(4096);
      const n = readSync(fd, chunk, 0, chunk.length, at);
      if (n === 0) return null;
      const nl = chunk.subarray(0, n).indexOf(0x0a);
      chunks.push(chunk.subarray(0, nl < 0 ? n : nl));
      if (nl >= 0) return Buffer.concat(chunks).toString('utf8');
      at += n;
    }
  } finally {
    closeSync(fd);
  }
}

/** The arcs of the repo (a run dir with a log, or a snapshot ref), newest first: by their log's first event, ties by id. */
export function arcsNewestFirst(repo: AbsPath): readonly ArcId[] {
  const common = gitCommonDir(repo);
  const runtime = join(common, 'roadmap-runtime');
  const began = new Map<ArcId, string>();
  if (existsSync(runtime)) {
    for (const name of readdirSync(runtime).sort()) {
      const events = join(runtime, name, EVENTS_FILE);
      const first = existsSync(events) ? firstLine(events) : null;
      if (first !== null) began.set(arcId(name), (JSON.parse(first) as { at: string }).at);
    }
  }
  for (const arc of arcsWithRefs(repo)) {
    if (began.has(arc)) continue;
    began.set(arc, readArcRef(repo, arc)?.events[0]?.at ?? '');
  }
  return [...began].sort(([a, x], [b, y]) => (x > y ? -1 : x < y ? 1 : a > b ? -1 : a < b ? 1 : 0)).map(([arc]) => arc);
}

/** The newest arc's Phase-0 record in force (arcs without one skipped), or null when no arc has one. */
export function latestRecord(repo: AbsPath): Readonly<{ arc: ArcId; questions: readonly PhaseQuestion[] }> | null {
  for (const arc of arcsNewestFirst(repo)) {
    const questions = questionsNow(repo, arc);
    if (questions !== null) return { arc, questions };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Applied or not

/** Whether `state` applies `a`: answered with its text. */
export const applies = (a: OwnerAnswer, state: QuestionState | undefined): boolean => state?.type === 'answered' && state.answer === a.answer;

/**
 * The answers in force that the records do not apply: each judged by the first record (newest first) carrying its
 * question; one no record carries is unapplied. `records` is lazy so a reader stops at the newest records it needs.
 */
export function unappliedOf(answers: readonly OwnerAnswer[], records: Iterable<readonly PhaseQuestion[]>): readonly OwnerAnswer[] {
  const states = new Map<PhaseQuestionId, QuestionState>();
  const missing = (): boolean => answers.some((a) => !states.has(a.question));
  if (answers.length > 0) {
    for (const questions of records) {
      for (const q of questions) if (!states.has(q.id)) states.set(q.id, q.state);
      if (!missing()) break;
    }
  }
  return answers.filter((a) => !applies(a, states.get(a.question)));
}

/**
 * The unapplied answers now (see the header), of the repo whose git common dir is `common` (git reads it as the repo).
 * Nothing but the answer dir is read while no answer is recorded.
 */
export function unappliedAnswers(common: AbsPath): readonly OwnerAnswer[] {
  const latest = latestAnswers(answerLog(common));
  if (latest.length === 0) return [];
  function* records(): Generator<readonly PhaseQuestion[]> {
    for (const arc of arcsNewestFirst(common)) {
      const q = questionsNow(common, arc);
      if (q !== null) yield q;
    }
  }
  return unappliedOf(latest, records());
}

/** An unapplied answer as one line (`status`, the brief's Markdown, `chain status`). */
export const answerLine = (a: OwnerAnswer): string =>
  `${a.question} answered${a.k > 1 ? ` (answer ${a.k}, superseding ${a.k - 1})` : ''} at ${a.at}: "${a.answer}" — apply it now (Phase-0 record answered{answer, at}, rules to match)`;

// ---------------------------------------------------------------------------------------------------
// Recording (`roadmap answer`)

export type AnswerRefusal =
  | Readonly<{ type: 'no-phase0-record'; arc: ArcId | null }>
  | Readonly<{ type: 'question-unknown' | 'question-not-open'; question: PhaseQuestionId; arc: ArcId }>;
export type AnswerOutcome =
  | Readonly<{ kind: 'recorded'; answer: OwnerAnswer }>
  /** A rerun with the text in force already (a crash after the publish, crash row ANSWER_RECORD): nothing written. */
  | Readonly<{ kind: 'unchanged'; answer: OwnerAnswer }>
  | Readonly<{ kind: 'refused'; refusal: AnswerRefusal }>;

/**
 * Records the owner's answer to `question`, open in the Phase-0 record in force of `arc` (null: the newest arc with
 * one): write-once by link (`exclusivePublish`), the next k for the question (crash label `answer.after-publish`).
 */
export function recordAnswer(repo: AbsPath, question: PhaseQuestionId, text: string, arc: ArcId | null): AnswerOutcome {
  const record = arc === null ? latestRecord(repo) : (() => {
    const questions = questionsNow(repo, arc);
    return questions === null ? null : { arc, questions };
  })();
  if (record === null) return { kind: 'refused', refusal: { type: 'no-phase0-record', arc } };
  const q = record.questions.find((x) => x.id === question);
  if (q === undefined) return { kind: 'refused', refusal: { type: 'question-unknown', question, arc: record.arc } };
  if (q.state.type !== 'open') return { kind: 'refused', refusal: { type: 'question-not-open', question, arc: record.arc } };
  const common = gitCommonDir(repo);
  const previous = answerLog(common).filter((a) => a.question === question).at(-1);
  if (previous?.answer === text) return { kind: 'unchanged', answer: previous };
  const answer: OwnerAnswer = { schema: ANSWER_SCHEMA, question, k: (previous?.k ?? 0) + 1, answer: text, at: isoTimeOf(new Date()), arc: record.arc };
  durableMkdir(answersDir(common));
  exclusivePublish(answerPath(common, answer), canonicalJson(parseOwnerAnswer(JSON.parse(canonicalJson(answer)))));
  crashPoint('answer.after-publish');
  return { kind: 'recorded', answer };
}
