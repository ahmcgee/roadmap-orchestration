// Delegated adjudication B (plan "Delegated adjudication B", OR-Q21 revised): `node evals/m4a/adjudicate.ts <dir>`,
// once, after a paid run (D5) of the fixture in `<dir>`. Not run by tests: the lead runs it, then adjudicates each
// finding (accept → fix or BACKLOG; reject → reason) and reports a summary to the owner. It gates the PR only through
// the lead's adjudication, never through the verdict itself.
//
// A headless Opus 5.5 xhigh session role-plays the owner of the synthetic vision and grades the run against the rubric
// R1–R7, without the answer key: `claude -p --model claude-opus-5-5 --effort xhigh --tools Read,Glob,Grep
// --output-format stream-json`, in the D5 isolation env (driver.ts `launchEnv`), cwd a fresh tree `adjudication/tree/`
// holding copies of exactly (H15):
//   vision/           the vision document (raw corpus) and arc 1's kept vision record
//   raw-corpus/       the corpus as setup seeded it
//   curated-corpus/   arc 1's pinned corpus (the kept files) and its rules index (rules-index.json)
//   extraction/       arc 1's obligations with the census, the P-n questions with their working assumptions, the
//                     curation digest and the corpus divergences (from the kept Phase-0 record)
//   plan/             arc 1's kept plan and its Phase-0 slice
//   product/          the product at arc 1's completed head (`git archive`, no .git), read-only
//   witness/          the arc lanes' definitions, and every witness run's record and evidence (the run dir's witness
//                     dirs named by arc 1's `witnessed` facts)
//   RUBRIC.md         the rubric
// The answer key stays outside the tree (asserted). The transcript (adjudication/transcript.jsonl) is scanned like the
// root session's (transcript.ts, K22, H14): any hit in a tool input or result voids the verdict (reported void, never
// re-run silently). The verdict's closed schema: {items: [{rubric, verdict: meets|partly|fails, evidence: [{path,
// quote}], findings: [string]}] (R1–R7, each once), overall}. Output: `<dir>/adjudication.json`.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { type ArcRef, completedHeadOf } from '../../src/chain.ts';
import { OBLIGATIONS_INPUT, PLAN_INPUT, VISION_INPUT } from '../../src/input/inforce.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { witnessDir } from '../../src/git/snapshot.ts';
import { runDir } from '../../src/input/cli.ts';
import { absPath } from '../../src/core/values.ts';
import { arcView, chainOf } from './check.ts';
import { launchEnv } from './driver.ts';
import { VISION_DOC, rawCorpus } from './golden.ts';
import { layout } from './layout.ts';
import { json } from './setup.ts';
import { ANSWER_KEY, needles, scanTranscript } from './transcript.ts';

export const RUBRIC = [
  ['R1', 'Readability first: the curated corpus is a design record a person wants to read; prose explains, rules state.'],
  ['R2', 'Claims systematised: every normative claim of the corpus is a T-n rule in a rules block, one claim per rule, under the section it belongs to.'],
  ['R3', 'Restatements collapsed: a claim made several times is one rule, the restatements gone (decision records keep their history).'],
  ['R4', 'Contradictions resolved per the vision, or asked: a contradiction the vision decides is resolved its way and recorded with the clause it cites; one it is silent on is a ranked question with a working assumption.'],
  ['R5', 'Stale text pruned: text the code or a later decision record overtook is gone or brought current.'],
  ['R6', 'The slice fits its advances: the plan\'s units, obligations and the product at the arc\'s head deliver the vision clauses the slice names, and nothing it does not.'],
  ['R7', 'Witnesses prove their claims: each obligation\'s witness lane tests what the obligation states, and its records and evidence show it held.'],
] as const;

export const VERDICTS = ['meets', 'partly', 'fails'] as const;
export type Item = Readonly<{ rubric: string; verdict: (typeof VERDICTS)[number]; evidence: readonly Readonly<{ path: string; quote: string }>[]; findings: readonly string[] }>;
export type Verdict = Readonly<{ items: readonly Item[]; overall: string }>;

/** The closed schema, or the reasons the value breaks it. */
export function verdictProblems(value: unknown): readonly string[] {
  const problems: string[] = [];
  const v = value as { items?: unknown; overall?: unknown };
  if (typeof v !== 'object' || v === null) return ['not an object'];
  for (const k of Object.keys(v)) if (k !== 'items' && k !== 'overall') problems.push(`unknown key ${k}`);
  if (typeof v.overall !== 'string') problems.push('overall is not a string');
  if (!Array.isArray(v.items)) return [...problems, 'items is not an array'];
  const seen = v.items.map((raw: unknown, i) => {
    const it = raw as Record<string, unknown>;
    for (const k of Object.keys(it)) if (!['rubric', 'verdict', 'evidence', 'findings'].includes(k)) problems.push(`items[${i}] has unknown key ${k}`);
    if (!VERDICTS.includes(it['verdict'] as never)) problems.push(`items[${i}].verdict ${JSON.stringify(it['verdict'])}`);
    const ev = it['evidence'];
    if (!Array.isArray(ev) || !ev.every((e: unknown) => typeof (e as { path?: unknown }).path === 'string' && typeof (e as { quote?: unknown }).quote === 'string' && Object.keys(e as object).length === 2)) problems.push(`items[${i}].evidence`);
    const f = it['findings'];
    if (!Array.isArray(f) || !f.every((x: unknown) => typeof x === 'string')) problems.push(`items[${i}].findings`);
    return it['rubric'];
  });
  const ids = RUBRIC.map(([id]) => id);
  if (JSON.stringify([...seen].sort()) !== JSON.stringify([...ids].sort())) problems.push(`items cover ${JSON.stringify(seen)}, not ${ids.join(', ')} once each`);
  return problems;
}

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** The adjudicator's tree (see the header), from arc 1's verified ref and its run dir. */
export function stageTree(dir: string, tree: string): Readonly<{ one: ArcRef }> {
  const l = layout(dir);
  const product = absPath(l.product);
  const { one } = chainOf(product);
  if (one === null) throw new Error(`${dir}: no arc 1 in the product's refs`);
  const head = completedHeadOf(one)?.head;
  if (head === undefined) throw new Error(`${one.arc} has not completed`);
  const view = arcView(one);
  const m = one.manifest;
  const raw = rawCorpus();
  write(join(tree, 'vision', VISION_DOC), raw[VISION_DOC]!);
  if (m.vision === null || m.vision === undefined) throw new Error(`${one.arc} keeps no vision record`);
  write(join(tree, 'vision', 'vision.json'), one.input(m.vision, VISION_INPUT).toString('utf8'));
  for (const [p, text] of Object.entries(raw)) write(join(tree, 'raw-corpus', p), text);
  for (const [p, text] of view.files) write(join(tree, 'curated-corpus', p), text);
  write(join(tree, 'curated-corpus', 'rules-index.json'), json(view.pin.rules.map((r) => ({ id: r.id, file: r.file, section: r.section, text: r.text }))));
  if (m.obligations === null) throw new Error(`${one.arc} keeps no obligations`);
  write(join(tree, 'extraction', 'obligations.json'), one.input(m.obligations, OBLIGATIONS_INPUT).toString('utf8'));
  write(join(tree, 'extraction', 'questions.json'), json(view.phase0.questions));
  write(join(tree, 'extraction', 'curation.json'), json(view.phase0.curation));
  write(join(tree, 'extraction', 'corpus-divergences.json'), json(view.phase0.corpusDivergences));
  write(join(tree, 'plan', 'plan.json'), one.input(one.view.planApplied()!.planSha256, PLAN_INPUT).toString('utf8'));
  write(join(tree, 'plan', 'slice.json'), json(view.phase0.slice));
  mkdirSync(join(tree, 'product'), { recursive: true });
  const archive = spawnSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', l.product, head, join(tree, 'product')], { encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`git archive ${head}: ${archive.stderr}`);
  write(join(tree, 'witness', 'lanes.json'), json(view.obligations.lanes));
  const run = runDir(gitCommonDir(product), one.arc);
  for (const e of one.events) {
    if (e.type !== 'fact' || e.fact.kind !== 'witnessed') continue;
    const src = witnessDir(run, e.fact);
    if (existsSync(src)) cpSync(src, join(tree, 'witness', 'runs', relative(run, src)), { recursive: true });
  }
  write(join(tree, 'RUBRIC.md'), ['# Rubric', '', ...RUBRIC.map(([id, text]) => `- **${id}** ${text}`), ''].join('\n'));
  // Read-only: the adjudicator's tools cannot write anyway; this keeps a slip from changing the evidence.
  for (const e of readdirSync(tree, { recursive: true, withFileTypes: true })) if (e.isFile()) chmodSync(join(e.parentPath, e.name), 0o444);
  return { one };
}

const PROMPT = [
  'You are the owner of the harbour whose vision is in vision/: you wrote it, and you are reviewing what an architect agent',
  'did with your design record in its first arc. Read vision/ first, then raw-corpus/ (the record as it was) and',
  'curated-corpus/ (the record the arc pinned, with its rules index), extraction/ (the obligations and census, the open',
  'questions with their working assumptions, the curation digest and the corpus divergences), plan/ (the plan and the',
  'slice), product/ (the product at the arc\'s completed head) and witness/ (the witness lanes, their records and evidence).',
  'Grade the arc against every item of RUBRIC.md, judging as the owner would: concretely, from the files, citing them.',
  'Your final message is exactly one JSON object and nothing else:',
  '{"items": [{"rubric": "R1", "verdict": "meets" | "partly" | "fails", "evidence": [{"path": "<path in this tree>", "quote": "<exact text>"}], "findings": ["<what is wrong or missing, one per entry>"]}, ... one item for each of R1..R7], "overall": "<two or three sentences>"}',
].join('\n');

export type Adjudication = Readonly<{
  status: 'verdict' | 'void' | 'invalid' | 'failed';
  arc: string;
  hits: readonly string[];
  problems: readonly string[];
  verdict: Verdict | null;
  transcript: string;
}>;

export function adjudicate(dir: string): Adjudication {
  const l = layout(dir);
  const out = join(dir, 'adjudication.json');
  if (existsSync(out)) throw new Error(`${out} exists: the adjudication runs once`);
  const base = join(dir, 'adjudication');
  const tree = join(base, 'tree');
  if (existsSync(base)) throw new Error(`${base} exists: the adjudication runs once`);
  const { one } = stageTree(dir, tree);
  if (resolve(ANSWER_KEY).startsWith(`${resolve(tree)}/`) || resolve(tree).startsWith(`${resolve(dirname(ANSWER_KEY))}/`)) throw new Error('the answer key is inside the adjudicator\'s tree');
  const transcript = join(base, 'transcript.jsonl');
  const r = spawnSync('claude', ['-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--tools', 'Read,Glob,Grep', '--output-format', 'stream-json', '--verbose', PROMPT], {
    cwd: tree, env: launchEnv(l, process.env), encoding: 'utf8', timeout: 120 * 60_000, maxBuffer: 512 * 1024 * 1024,
  });
  const events = r.stdout.split('\n').filter((x) => x.trim() !== '').map((x) => {
    try {
      return JSON.parse(x) as { type?: unknown; result?: unknown };
    } catch {
      return { type: 'unparsed', result: x };
    }
  });
  writeFileSync(transcript, events.map((event) => `${JSON.stringify({ turn: 1, event })}\n`).join(''));
  const hits = scanTranscript(transcript, needles());
  const result = events.find((e) => e.type === 'result')?.result;
  let status: Adjudication['status'] = 'verdict';
  let verdict: Verdict | null = null;
  let problems: readonly string[] = [];
  if (r.status !== 0 || typeof result !== 'string') {
    status = 'failed';
    problems = [`claude exited ${r.status}: ${r.stderr.slice(0, 2000)}`];
  } else {
    const text = result.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    try {
      const value: unknown = JSON.parse(text);
      problems = verdictProblems(value);
      if (problems.length === 0) verdict = value as Verdict;
      else status = 'invalid';
    } catch (error) {
      status = 'invalid';
      problems = [`the final message is not JSON: ${(error as Error).message}`];
    }
  }
  if (hits.length > 0) status = 'void';
  const a: Adjudication = { status, arc: one.arc, hits, problems, verdict, transcript };
  writeFileSync(out, json(a), { flag: 'wx' });
  return a;
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m4a/adjudicate.ts <dir>');
  const a = adjudicate(resolve(dir));
  process.stdout.write(`${JSON.stringify({ status: a.status, hits: a.hits, problems: a.problems, verdicts: a.verdict?.items.map((i) => `${i.rubric}:${i.verdict}`) ?? null })}\n`);
  process.exitCode = a.status === 'verdict' ? 0 : 1;
}

