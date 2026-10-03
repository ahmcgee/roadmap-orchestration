// Session transcripts (`claude -p --output-format stream-json`, one event per line) and the isolation scan (LR-f, H1,
// K22, H14): every tool call's input and every tool result is searched for the needles; any hit is a finding. Shared
// by the driver (the root session), check.ts (re-scanned) and adjudicate.ts (whose hit voids the verdict).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The answer key: never staged, never read by a session. */
export const ANSWER_KEY = fileURLToPath(new URL('./answer-key.json', import.meta.url));

/** This repository's root and its main checkout (a worktree's common dir names the latter). */
export function repositoryPaths(): readonly string[] {
  const here = dirname(ANSWER_KEY);
  const top = execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const common = resolve(here, execFileSync('git', ['-C', here, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim());
  return [...new Set([top, dirname(common)])];
}

/** What a session must never touch: the key (path and name), the fixture sources, the real repository. */
export function needles(): readonly string[] {
  return [ANSWER_KEY, 'answer-key', 'evals/m4a', ...repositoryPaths()];
}

/** A tool call's input or a tool result, as the transcript carries it. */
export type ToolTraffic = Readonly<{ turn: number; line: number; kind: 'tool_use' | 'tool_result'; text: string }>;

type ContentItem = Readonly<{ type?: unknown; input?: unknown; content?: unknown }>;

/** Every tool call input and tool result in a stream-json transcript (lines `{turn, event}` as the driver writes them). */
export function toolTraffic(file: string): readonly ToolTraffic[] {
  if (!existsSync(file)) return [];
  const out: ToolTraffic[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (raw === '') return;
    const { turn, event } = JSON.parse(raw) as { turn: number; event: { type?: unknown; message?: { content?: unknown } } };
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content as ContentItem[]) {
      if (item.type === 'tool_use') out.push({ turn, line: i + 1, kind: 'tool_use', text: JSON.stringify(item.input ?? null) });
      if (item.type === 'tool_result') out.push({ turn, line: i + 1, kind: 'tool_result', text: JSON.stringify(item.content ?? null) });
    }
  });
  return out;
}

/** Each needle found in the transcript's tool traffic, with where. */
export function scanTranscript(file: string, search: readonly string[]): readonly string[] {
  const hits: string[] = [];
  for (const t of toolTraffic(file)) for (const n of search) if (t.text.includes(n)) hits.push(`${JSON.stringify(n)} in a ${t.kind} (turn ${t.turn}, line ${t.line})`);
  return hits;
}

/** The session's final text of each turn (`result` events). */
export function resultsOf(file: string): readonly Readonly<{ turn: number; text: string }>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').flatMap((raw) => {
    const { turn, event } = JSON.parse(raw) as { turn: number; event: { type?: unknown; result?: unknown } };
    return event.type === 'result' && typeof event.result === 'string' ? [{ turn, text: event.result }] : [];
  });
}
