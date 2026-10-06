// Background run observer for paid fixture runs. Agent-facing: output is `OBSERVER ...` lines for a Monitor.
//   node evals/observer.ts <fixtureDir> [--interval-min 10] [--model gpt-6-astra] [--max-hours 7] [--host-dir D] [--once]
// Every tick it collects what is new since its cursor (<fixtureDir>/observer/cursor.json), asks a read-only
// Codex session what looks wrong, appends the parsed observations to <fixtureDir>/observer/observations.jsonl and
// prints abort/high ones. It never acts on the run. It loops until <fixtureDir>/report.json exists or max-hours.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEVERITIES = ['abort', 'high', 'note'] as const;
const KINDS = ['stall', 'crash-loop', 'churn', 'waste', 'scope-drift', 'wrong-decision', 'harness', 'executor-bug', 'skill-gap', 'cost', 'other'] as const;
type Severity = (typeof SEVERITIES)[number];
type Kind = (typeof KINDS)[number];

export type Observation = Readonly<{ severity: Severity; kind: Kind; summary: string; evidence: readonly string[]; suggestion: string }>;
export type Cursor = Readonly<{ tick: number; seq: Readonly<Record<string, number>>; transcriptLines: number; needsUser: readonly string[]; hostBytes: Readonly<Record<string, number>> }>;

const EMPTY_CURSOR: Cursor = { tick: 0, seq: {}, transcriptLines: 0, needsUser: [], hostBytes: {} };
const DELTA_CAP = 200_000;
const SECTION_CAP = 50_000;
const CODEX_TIMEOUT_MS = 20 * 60_000;
const REPO_EXECUTOR = fileURLToPath(new URL('..', import.meta.url));

const tail = (text: string, cap: number): string => (text.length <= cap ? text : `[...older truncated]\n${text.slice(text.length - cap)}`);
const clip = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n)}...`);
const lines = (path: string): string[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l !== '') : []);

type Block = { type?: string; name?: string; input?: unknown; is_error?: boolean; content?: unknown; text?: string };
type StreamEvent = { type?: string; subtype?: string; num_turns?: number; total_cost_usd?: number; result?: string; message?: { content?: Block[] } };

function summariseTranscriptLine(line: string): string[] {
  let outer: { turn?: number; event?: StreamEvent };
  try {
    outer = JSON.parse(line);
  } catch {
    return [`(unparseable transcript line) ${clip(line, 200)}`];
  }
  const e: StreamEvent = outer.event ?? {};
  const turn = `t${outer.turn ?? '?'}`;
  const out: string[] = [];
  if (e.type === 'assistant' || e.type === 'user') {
    for (const b of e.message?.content ?? []) {
      if (b.type === 'tool_use') out.push(`${turn} CALL ${String(b.name)} ${clip(JSON.stringify(b.input), 300)}`);
      else if (b.type === 'tool_result') out.push(`${turn} RESULT${b.is_error === true ? ' ERROR' : ''} ${clip(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 300)}`);
      else if (b.type === 'text') out.push(`${turn} ${e.type === 'assistant' ? 'SAY' : 'USER'} ${clip(String(b.text), 500)}`);
    }
  } else if (e.type === 'result') {
    out.push(`${turn} END ${String(e.subtype)} turns=${String(e.num_turns)} cost=${String(e.total_cost_usd)} ${clip(String(e.result ?? ''), 300)}`);
  } else if (e.type === 'system' && e.subtype === 'init') {
    out.push(`${turn} SESSION-START`);
  }
  return out;
}

function newestTail(dir: string, prefix: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 3)
    .map((x) => x.f);
}

/** The delta since `cursor`, as prompt text, plus the advanced cursor. Pure of side effects except reading. */
export function collectDelta(fixtureDir: string, cursor: Cursor, hostDir: string): { text: string; cursor: Cursor } {
  const sections: string[] = [];
  const seq = { ...cursor.seq };
  const runtime = join(fixtureDir, 'stage/product/.git/roadmap-runtime');
  const needsUser = new Set(cursor.needsUser);
  const arcs = existsSync(runtime) ? readdirSync(runtime) : [];
  for (const arc of arcs) {
    const fresh: string[] = [];
    let max = seq[arc] ?? 0;
    for (const l of lines(join(runtime, arc, 'events.jsonl'))) {
      let s: number;
      try {
        s = (JSON.parse(l) as { seq: number }).seq;
      } catch {
        continue;
      }
      if (s > (seq[arc] ?? 0)) {
        fresh.push(clip(l, 700));
        max = Math.max(max, s);
      }
    }
    seq[arc] = max;
    sections.push(`## events arc=${arc} (new, seq<=${max})\n${tail(fresh.join('\n'), SECTION_CAP) || '(none)'}`);
    const nuDir = join(runtime, arc, 'needs-user');
    for (const f of existsSync(nuDir) ? readdirSync(nuDir).filter((n) => n.endsWith('.json')) : []) {
      if (needsUser.has(`${arc}/${f}`)) continue;
      needsUser.add(`${arc}/${f}`);
      sections.push(`## needs-user ${arc}/${f}\n${clip(readFileSync(join(nuDir, f), 'utf8'), 3000)}`);
    }
  }
  const tl = lines(join(fixtureDir, 'transcript.jsonl'));
  const summary = tl.slice(cursor.transcriptLines).flatMap(summariseTranscriptLine);
  sections.push(`## root session transcript (new lines ${cursor.transcriptLines + 1}..${tl.length}, summarised)\n${tail(summary.join('\n'), SECTION_CAP) || '(none)'}`);

  const hostBytes = { ...cursor.hostBytes };
  const files = [...newestTail(hostDir, 'executor.', '.err'), ...newestTail(hostDir, 'supervisor.', '.err')];
  for (const f of files) {
    const buf = readFileSync(join(hostDir, f));
    const from = hostBytes[f] ?? 0;
    hostBytes[f] = buf.length;
    const fresh = buf.subarray(from).toString('utf8');
    if (fresh.trim() !== '') sections.push(`## host stderr ${f} (new bytes ${from}..${buf.length})\n${tail(fresh, 10_000)}`);
  }

  const next: Cursor = { tick: cursor.tick, seq, transcriptLines: tl.length, needsUser: [...needsUser], hostBytes };
  return { text: tail(sections.join('\n\n'), DELTA_CAP), cursor: next };
}

function statusSnapshot(fixtureDir: string): string {
  const bin = join(fixtureDir, 'stage/plugin/executor/bin/roadmap');
  if (!existsSync(bin)) return `(no staged plugin at ${bin})`;
  const r = spawnSync(bin, ['status'], { cwd: join(fixtureDir, 'stage/product'), encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 ? tail(r.stdout, 20_000) : `(status failed: exit ${String(r.status)} ${clip(r.stderr ?? '', 500)})`;
}

const PREAMBLE = `You are a read-only observer of a roadmap-orchestrator arc run (a paid fixture). You never act on the run; you only report.

Pipeline, briefly: a root agent session (Claude, the "architect") drives a detached Node executor through the CLI. The executor
owns every backend call, git ref, lock and evidence dir, and appends facts to a per-arc events.jsonl (seq-ordered). Work flows:
plan-check (the plan is vetted against the corpus/vision), build (implementer lanes in git worktrees, possibly parallel), gate
(judgment on each lane's output), candidate merge into an integration branch, lens audits, checkpoint bundles (holistic
reconcile to the vision), and needs-user items raised when the architect must decide. Executor source for reference:
${REPO_EXECUTOR} (src/, SCHEMAS.md, ../skills). The fixture dir is your cwd; you may read any file under it.

Below is the DELTA since your last tick, then your previous observations. Report NEW issues only (do not repeat earlier ones unless
materially worse). Output ONLY JSON lines, one object per line, no prose, no code fences:
{"severity":"abort"|"high"|"note","kind":"stall|crash-loop|churn|waste|scope-drift|wrong-decision|harness|executor-bug|skill-gap|cost|other","summary":"...","evidence":["file:line or seq refs"],"suggestion":"..."}
"abort" = the run can no longer produce valid evidence or is burning budget pointlessly (crash loop, stuck with no path, harness
broken). "high" = a likely defect worth fixing before the next run. "note" = minor. If nothing new, output nothing.
The suggestion is about fixing the product/harness for the next run, never about acting on this run.
`;

/** JSON lines out of the observer's reply; invalid lines are returned separately. */
export function parseObservations(reply: string): { ok: Observation[]; invalid: string[] } {
  const ok: Observation[] = [];
  const invalid: string[] = [];
  for (const raw of reply.split('\n')) {
    const l = raw.trim();
    if (l === '') continue;
    try {
      const o = JSON.parse(l) as Partial<Observation>;
      const good =
        SEVERITIES.includes(o.severity as Severity) && KINDS.includes(o.kind as Kind) && typeof o.summary === 'string' &&
        Array.isArray(o.evidence) && o.evidence.every((e) => typeof e === 'string') && typeof o.suggestion === 'string';
      if (good) ok.push(o as Observation);
      else invalid.push(l);
    } catch {
      invalid.push(l);
    }
  }
  return { ok, invalid };
}

export type Options = Readonly<{ fixtureDir: string; model: string; hostDir: string }>;

/** One tick. Returns the stdout lines it emitted. */
export function tick(opts: Options): string[] {
  const dir = join(opts.fixtureDir, 'observer');
  mkdirSync(dir, { recursive: true });
  const cursorPath = join(dir, 'cursor.json');
  const obsPath = join(dir, 'observations.jsonl');
  const cursor: Cursor = existsSync(cursorPath) ? (JSON.parse(readFileSync(cursorPath, 'utf8')) as Cursor) : EMPTY_CURSOR;
  const n = cursor.tick + 1;
  const { text, cursor: advanced } = collectDelta(opts.fixtureDir, cursor, opts.hostDir);
  const previous = lines(obsPath).slice(-20).join('\n');
  const prompt = `${PREAMBLE}\n# Status snapshot\n${statusSnapshot(opts.fixtureDir)}\n\n# Delta (tick ${n})\n${text}\n\n# Your previous observations (last 20)\n${previous || '(none)'}\n`;
  const promptPath = join(dir, `prompt-${n}.md`);
  const outPath = join(dir, `reply-${n}.txt`);
  writeFileSync(promptPath, prompt);
  const at = new Date().toISOString();
  const out: string[] = [];
  const r = spawnSync('codex', ['exec', '-s', 'read-only', '--skip-git-repo-check', '-m', opts.model, '-C', opts.fixtureDir, '-o', outPath, '-'], {
    input: prompt, encoding: 'utf8', timeout: CODEX_TIMEOUT_MS,
  });
  if (r.status !== 0 || !existsSync(outPath)) {
    // Do not advance the cursor: the next tick retries the same delta.
    appendFileSync(obsPath, `${JSON.stringify({ tick: n, at, error: `codex exec failed: status=${String(r.status)} signal=${String(r.signal)} ${clip(r.stderr ?? '', 500)}` })}\n`);
    return [`OBSERVER tick ${n} error codex-failed`];
  }
  const { ok, invalid } = parseObservations(readFileSync(outPath, 'utf8'));
  for (const o of ok) appendFileSync(obsPath, `${JSON.stringify({ tick: n, at, ...o })}\n`);
  for (const l of invalid) appendFileSync(obsPath, `${JSON.stringify({ tick: n, at, invalid: l })}\n`);
  for (const o of ok) if (o.severity !== 'note') out.push(`OBSERVER ${o.severity}: [${o.kind}] ${o.summary} | evidence: ${o.evidence.join(', ')} | suggestion: ${o.suggestion}`);
  out.push(`OBSERVER tick ${n} ok ${ok.length}${invalid.length > 0 ? ` invalid ${invalid.length}` : ''}`);
  writeFileSync(cursorPath, JSON.stringify({ ...advanced, tick: n }));
  return out;
}

function main(argv: readonly string[]): void {
  const args = argv.slice(2);
  const flag = (name: string, dflt: string): string => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : dflt;
  };
  const fixtureDir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]?.startsWith('--') && args[i - 1] !== '--once'));
  if (fixtureDir === undefined) throw new Error('usage: node evals/observer.ts <fixtureDir> [--interval-min 10] [--model gpt-6-astra] [--max-hours 7] [--host-dir D] [--once]');
  const opts: Options = { fixtureDir, model: flag('--model', 'gpt-6-astra'), hostDir: flag('--host-dir', '/var/tmp/roadmap') };
  const intervalMs = Number(flag('--interval-min', '10')) * 60_000;
  const deadline = Date.now() + Number(flag('--max-hours', '7')) * 3_600_000;
  const once = args.includes('--once');
  for (;;) {
    for (const l of tick(opts)) console.log(l);
    if (once) return;
    if (existsSync(join(fixtureDir, 'report.json'))) return void console.log('OBSERVER done report.json');
    if (Date.now() + intervalMs > deadline) return void console.log('OBSERVER done max-hours');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv);
