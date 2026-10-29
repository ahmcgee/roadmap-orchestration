import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEnv, stagePlugin } from '../m4a/driver.ts';
import { fixture, json, write, type Fixture } from './fixture.ts';
import { gradeA, gradeB, proposals, type Exchange, type Grade } from './grade.ts';
import type { SetName } from './spec.ts';

export type Stage = 'a' | 'b' | 'both';
export type Budget = { spent: number; cap: number | null };
export type Trial = Readonly<{ trial: number; dir: string; a: Grade | null; b: Grade | null; costUsd: number; failure: string | null }>;
export const ISOLATION = ['--strict-mcp-config', '--settings', '{"autoMemoryEnabled":false}'] as const;
export const LIMITS = { turnMs: 30 * 60_000, sessionMs: 90 * 60_000, turns: 30 } as const;
const SOURCE = fileURLToPath(new URL('../../', import.meta.url));

type Turn = Readonly<{ session: string; text: string }>;
/** One process group per turn, with isolation checked at init, costs at result, raw streams kept in full. */
export async function invoke(f: Fixture, name: string, prompt: string, session: string | null, owner: boolean, budget: Budget, deadline: number): Promise<Turn> {
  if (budget.cap !== null && budget.spent >= budget.cap) throw new Error('cost cap reached');
  const argv = ['-p', '--model', 'claude-opus-5-5', '--effort', owner ? 'medium' : 'high', ...(owner ? ['--tools', ''] : ['--plugin-dir', f.l.plugin, '--permission-mode', 'bypassPermissions']), ...ISOLATION,
    '--output-format', 'stream-json', '--verbose', ...(session === null ? [] : ['--resume', session]), prompt];
  write(join(f.l.dir, `${name}.argv.json`), json(argv));
  const env = launchEnv(f.l, process.env);
  const child = spawn('claude', argv, { cwd: owner ? f.l.config : f.l.product, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', result: Turn | null = null, failure: Error | null = null;
  let sid = session;
  let sawInit = false, sawCost = false;
  const kill = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  };
  const refuse = (message: string): void => { failure ??= new Error(message); kill('SIGKILL'); };
  const line = (raw: string): void => {
    appendFileSync(join(f.l.dir, `${name}.jsonl`), raw + '\n');
    if (!raw.trim()) return;
    let e: Record<string, unknown>;
    try { e = JSON.parse(raw) as Record<string, unknown>; } catch { refuse('malformed stream-json'); return; }
    if (typeof e['session_id'] === 'string') sid = e['session_id'];
    if (e['type'] === 'system' && e['subtype'] === 'init') {
      sawInit = true;
      if ((Array.isArray(e['mcp_servers']) && e['mcp_servers'].length > 0) || e['memory_paths'] !== undefined) refuse('isolation: MCP servers or memory paths in init');
    }
    // The key is outside stage. A tool invocation reaching for it invalidates the trial.
    if (!owner && e['type'] === 'assistant') {
      const message = e['message'] as { content?: { type?: string }[] } | undefined;
      for (const block of message?.content ?? []) if (block.type === 'tool_use' && [SOURCE, 'evals/compaction', 'key.json', 'key-dev.json', 'key-holdout.json', 'golden-compaction.md'].some((s) => JSON.stringify(block).includes(s))) refuse('needle: tool traffic reached hidden answer material');
    }
    if (e['type'] === 'result') {
      if (typeof e['total_cost_usd'] !== 'number' || !Number.isFinite(e['total_cost_usd']) || e['total_cost_usd'] < 0) { refuse('result lacks valid total_cost_usd'); return; }
      if (sawCost) { refuse('multiple result rows'); return; }
      sawCost = true;
      budget.spent += e['total_cost_usd'];
      appendFileSync(join(f.l.dir, 'costs.jsonl'), json({ name, costUsd: e['total_cost_usd'], totalUsd: budget.spent }).trim() + '\n');
      if (budget.cap !== null && budget.spent > budget.cap) refuse(`cost cap exceeded: ${budget.spent} > ${budget.cap}`);
      if (e['is_error'] === true) refuse(`model result error: ${String(e['result'])}`);
      if (typeof e['result'] === 'string' && sid !== null) result = { text: e['result'], session: sid };
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (s: string) => {
    buffer += s;
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) { const raw = buffer.slice(0, at); buffer = buffer.slice(at + 1); line(raw); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s: string) => { stderr += s; });
  const timer = setTimeout(() => refuse('turn/session timeout'), Math.max(1, Math.min(LIMITS.turnMs, deadline - Date.now())));
  const trace = setInterval(() => process.stdout.write(`TRACE ${name} spend=$${budget.spent.toFixed(2)}\n`), 30_000);
  let status: number | null;
  try { status = await new Promise<number | null>((done, reject) => { child.on('error', reject); child.on('close', done); }); }
  finally { clearTimeout(timer); clearInterval(trace); kill('SIGKILL'); writeFileSync(join(f.l.dir, `${name}.stderr`), stderr); }
  if (buffer.trim()) line(buffer);
  if (failure) throw failure;
  if (status !== 0 || !sawInit || !sawCost || result === null) throw new Error(`${name}: exited ${status}, init=${sawInit}, cost=${sawCost}, result=${result !== null}: ${stderr}`);
  return result;
}

export async function stageA(f: Fixture, budget: Budget): Promise<Grade> {
  stagePlugin(f.l);
  const exchanges: Exchange[] = [];
  const deadline = Date.now() + LIMITS.sessionMs;
  let session: string | null = null;
  let prompt = '/roadmap-orchestrator:estate-compaction\nReview the estate with me. The previous arc is complete; its final inputs are at ' + f.previous + '. Survey the current product, corpus, previous inputs, and docs/last-check-in.md. Propose numbered batches per the skill. Use top-level numbered action headings (for example, 1. retire T-n), Items, Replacement and Gives up fields, and unnumbered subpoints. Save approved decisions to ../roadmap-inputs/_next/compaction.md. End with a final text without numbered decisions once the review is complete.';
  let ended = false;
  for (let n = 1; n <= LIMITS.turns && Date.now() < deadline; n++) {
    const turn = await invoke(f, `architect-${n}`, prompt, session, false, budget, deadline);
    session = turn.session;
    if (proposals(turn.text).length === 0) { ended = true; break; }
    // Only plain owner terms and the batch enter the simulator; never the key's plants/traps structure.
    const ownerPrompt = `You are the terse product owner. These are your decisions and preferences:\n${f.key.ownerAnswers.join('\n')}\n\nReply to this batch only. Use explicit numbered approve/reject answers.\n\n${turn.text}`;
    const owner = await invoke(f, `owner-${n}`, ownerPrompt, null, true, budget, deadline);
    exchanges.push({ batch: turn.text, reply: owner.text });
    write(join(f.l.dir, 'exchanges.json'), json(exchanges));
    prompt = owner.text;
  }
  if (!ended) throw new Error('review turn/session cap reached');
  const path = join(f.l.inputs, '_next/compaction.md');
  return gradeA(existsSync(path) ? readFileSync(path, 'utf8') : '', exchanges, f.key);
}
export async function stageB(f: Fixture, budget: Budget): Promise<Grade> {
  stagePlugin(f.l);
  write(join(f.l.inputs, '_next/compaction.md'), readFileSync(join(f.l.dir, 'golden-compaction.md'), 'utf8'));
  await invoke(f, 'application', `/roadmap-orchestrator:orchestrate\nApply ../roadmap-inputs/_next/compaction.md per the orchestrate skill's Phase 0 Compaction paragraph and step 12, and estate-compaction's Applying the record, to the next arc inputs at ${f.next}. The checkout is on its between-arc branch; amend its single between-arc commit, repin and refresh the baseline and integration branch. Run phase0 check until exit 0. Do not start. For this pre-start application evaluation, mark each decision Applied: arc-next when applied, or Blocked: <the refusal row> if it cannot be applied as approved.`, null, false, budget, Date.now() + LIMITS.sessionMs);
  return gradeB(f);
}
export async function trial(dir: string, set: SetName, stage: Stage, n: number, budget: Budget): Promise<Trial> {
  const before = budget.spent;
  let a: Grade | null = null, b: Grade | null = null, failure: string | null = null;
  try {
    if (stage !== 'b') a = await stageA(await fixture(join(dir, 'a'), set), budget);
    if (stage !== 'a') b = await stageB(await fixture(join(dir, 'b'), set), budget);
  } catch (e) { failure = String(e); }
  const row = { trial: n, dir, a, b, costUsd: budget.spent - before, failure };
  write(join(dir, 'row.json'), json(row));
  return row;
}
