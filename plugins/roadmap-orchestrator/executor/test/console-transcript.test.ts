import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeTranscript, normalize, renderTranscript } from '../src/tui/transcript.ts';
import { HistoryTail, pairEvents, previewEvent, expandEvent } from '../src/tui/history.ts';
import { tmpDir } from './helpers/repo.ts';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/transcripts/${name}.jsonl`, import.meta.url), 'utf8').trimEnd().split('\n');

test('canonical Claude decoder pairs tools, labels parents, preserves unknown bytes, usage and model', () => {
  const events = pairEvents(fixture('claude').flatMap((line, n) => decodeTranscript(line).map((e, i) => ({ ...e, id: `${n}:${i}` }))));
  assert.equal(events.find(e => e.type === 'thinking')!.text, 'I’ll inspect the implementation before changing it.');
  const tool = events.find(e => e.toolId === 'tool_1')!;
  assert.match(String(tool.input), /src\/main.ts/); assert.equal(tool.output, 'export const ready = true;'); assert.equal(tool.status, 'passed');
  assert.equal(events.filter(e => e.toolId === 'tool_1').length, 1);
  const child = events.find(e => e.toolId === 'nested_1')!;
  assert.equal(child.parent, 'agent_1'); assert.equal(child.status, 'failed'); assert.equal(child.output, 'Exit code 1');
  assert.equal(events.find(e => e.unknown)!.text, fixture('claude')[5]);
  assert.equal(events.find(e => e.type === 'result')!.tokens, 62);
  assert.ok(events.some(e => e.model === 'claude-sonnet-4-5'));
  for (const line of fixture('claude')) for (const expanded of [false, true]) assert.deepEqual(normalize(line, expanded), renderTranscript(decodeTranscript(line), expanded));
});

test('Codex command lifecycle pairs input/output and errors, reasoning and usage stay legible', () => {
  const events = pairEvents(fixture('codex').flatMap((line, n) => decodeTranscript(line).map((e, i) => ({ ...e, id: `${n}:${i}` }))));
  const cmd = events.find(e => e.toolId === 'cmd_1')!;
  assert.equal(cmd.input, 'node check.js'); assert.equal(cmd.output, 'failed check'); assert.equal(cmd.status, 'failed');
  assert.equal(events.filter(e => e.toolId === 'cmd_1').length, 1);
  assert.ok(events.some(e => e.type === 'thinking')); assert.ok(events.some(e => e.type === 'error' && e.text?.includes('quota exceeded')));
  assert.equal(events.find(e => e.type === 'result')!.tokens, 50, 'cached input is a subset, not added twice');
});

test('event previews explicitly truncate; expansion pages recover exact content and reject wrong fields', () => {
  const event = { ...decodeTranscript(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'long Ω '.repeat(4000) }] } }))[0]!, id: '0:0' };
  const preview = previewEvent(event); assert.ok(preview.text!.length <= 4096); assert.ok(preview.truncated.includes('text'));
  let text = ''; for (let after = 0; after < event.text!.length;) { const p = expandEvent(event, 'text', after); assert.ok(p.text.length <= 4096); text += p.text; after = p.next; }
  assert.equal(text, event.text); assert.throws(() => expandEvent(event, 'bad', 0));
});

test('incremental complete-line tail retains partial UTF-8, appends, resets truncation and inode replacement', () => {
  const path = join(tmpDir('history-tail'), 'stdout'); const tail = new HistoryTail();
  const first = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello Ω' }] } });
  const bytes = Buffer.from(first + '\n'); writeFileSync(path, bytes.subarray(0, bytes.length - 3));
  assert.equal(tail.read(path).events.length, 0);
  appendFileSync(path, bytes.subarray(bytes.length - 3));
  const one = tail.read(path); assert.equal(one.events[0]!.text, 'hello Ω'); assert.equal(tail.read(path).events.length, 0);
  appendFileSync(path, fixture('claude')[1] + '\n'); assert.equal(tail.read(path).events.length, 2);
  writeFileSync(path, first + '\n'); assert.equal(tail.read(path).reset, true);
  renameSync(path, path + '.old'); writeFileSync(path, first + '\n'); assert.equal(tail.read(path).reset, true);
});

test('history is paged and oversize records stay explicitly inspectable without unbounded carry', () => {
  const path = join(tmpDir('history-pages'), 'stdout');
  writeFileSync(path, Array.from({ length: 300 }, (_, n) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `message ${n}` }] } })).join('\n') + '\n');
  const tail = new HistoryTail(); tail.read(path);
  const last = tail.page(path); assert.equal(last.events.length, 50); assert.equal(last.events.at(-1)!.text, 'message 299');
  assert.ok(last.before); const older = tail.page(path, last.before!); assert.equal(older.events.at(-1)!.text, 'message 249');
  assert.ok(tail.retained <= 200);
});

test('TUI text is byte-identical to phase 4 for real-shaped streams and projection edge cases', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/transcripts/tui.golden.json', import.meta.url), 'utf8')) as { line: string; collapsed: string[]; expanded: string[] }[];
  for (const row of golden) { assert.deepEqual(normalize(row.line, false), row.collapsed); assert.deepEqual(normalize(row.line, true), row.expanded); }
});

test('paging includes every content block in one record; rewrite growth resets and oversize records are explicit', () => {
  const path = join(tmpDir('history-boundaries'), 'stdout'); const tail = new HistoryTail();
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: Array.from({ length: 120 }, (_, n) => ({ type: 'text', text: `block ${n}` })) } }) + '\n');
  tail.read(path); const last = tail.page(path); const mid = tail.page(path, last.before!); const first = tail.page(path, mid.before!);
  assert.deepEqual([...first.events, ...mid.events, ...last.events].map(e => e.text), Array.from({ length: 120 }, (_, n) => `block ${n}`));
  const initial = readFileSync(path, 'utf8'); writeFileSync(path, initial.replace('block 119', 'changed!!') + '{"type":"turn.started"}\n');
  assert.equal(tail.read(path).reset, true, 'same prefix but rewritten tail followed by growth');
  writeFileSync(path, 'x'.repeat(9 * 1024 * 1024) + '\n');
  let next = tail.read(path); while (next.pending) next = tail.read(path);
  assert.match(tail.page(path).events[0]!.title!, /Oversize/); assert.ok(tail.retained <= 200);
});

test('known string messages remain prose; independent tail lifetimes cannot reuse expansion identities', () => {
  assert.equal(decodeTranscript('{"type":"user","message":{"content":"The seat brief"}}')[0]!.type, 'prompt');
  assert.equal(decodeTranscript('{"type":"assistant","message":{"content":"A message"}}')[0]!.text, 'A message');
  const path = join(tmpDir('history-identities'), 'stdout'); writeFileSync(path, '{"type":"turn.started"}\n');
  assert.notEqual(new HistoryTail().read(path).identity, new HistoryTail().read(path).identity);
});

test('a prior record larger than the normal byte window remains paged and expandable', () => {
  const path = join(tmpDir('history-long-prior'), 'stdout');
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'long earlier '.repeat(100_000) }] } }) + '\n';
  writeFileSync(path, line + '{"type":"turn.started"}\n');
  const tail = new HistoryTail(); tail.read(path); const latest = tail.page(path);
  assert.equal(latest.events.length, 1); assert.ok(latest.before);
  const earlier = tail.page(path, latest.before); assert.equal(earlier.events.length, 1);
  assert.ok(earlier.events[0]!.truncated.includes('text'));
  assert.equal(tail.expand(path, earlier.events[0]!.id, 'text', 1000).text.length, 4096);
});

test('live parent tool calls still pair after subagent traffic leaves the visible window', () => {
  const path = join(tmpDir('history-parent'), 'stdout'); const tail = new HistoryTail();
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'parent-task', name: 'Agent', input: { prompt: 'Inspect the implementation' } }] } }) + '\n');
  tail.read(path);
  appendFileSync(path, Array.from({ length: 250 }, (_, n) => JSON.stringify({ type: 'assistant', parent_tool_use_id: 'parent-task', message: { content: [{ type: 'text', text: `child observation ${n}` }] } })).join('\n') + '\n');
  tail.read(path);
  appendFileSync(path, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'parent-task', content: 'Subagent finished' }] } }) + '\n');
  const result = tail.read(path).events.find(e => e.toolId === 'parent-task')!;
  assert.equal(result.tool, 'Agent'); assert.match(result.input!, /Inspect the implementation/); assert.equal(result.output, 'Subagent finished');
});
