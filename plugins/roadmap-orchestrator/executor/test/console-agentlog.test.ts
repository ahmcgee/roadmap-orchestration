import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleTranscript, parseSeatBrief } from '../src/console/agent-history.ts';
import { documentsXml } from '../src/prompts/inputs.ts';
import { HistoryTail } from '../src/tui/history.ts';
import { normalize } from '../src/tui/transcript.ts';
import { tmpDir } from './helpers/repo.ts';
const event = (value: unknown) => consoleTranscript(JSON.stringify(value));

test('surveyed CLI housekeeping stays out of history; task and permission events are deliberate prose', () => {
  for (const subtype of ['thinking_tokens', 'background_tasks_changed', 'task_progress']) assert.deepEqual(event({ type: 'system', subtype }), []);
  assert.deepEqual(event({ type: 'tool_progress', elapsed_time_seconds: 30, heartbeat: true }), []);
  for (const subtype of ['task_started', 'task_notification', 'task_updated']) {
    const [e] = event({ type: 'system', subtype, task_id: 'task-1', status: 'completed', description: 'Inspect the page\nlong duplicate command', patch: { status: 'killed' } });
    assert.equal(e!.unknown, undefined); assert.equal(e!.type, 'handoff'); assert.equal(e!.text, 'Inspect the page'); assert.match(e!.title!, /Task completed/);
  }
  const [denial] = event({ type: 'system', subtype: 'permission_denied', tool_name: 'Read', decision_reason: 'Outside the worktree' });
  assert.equal(denial!.status, 'failed'); assert.equal(denial!.text, 'Outside the worktree'); assert.match(denial!.title!, /Permission denied/);
  assert.equal(event({ type: 'system', subtype: 'init', model: 'recorded-model', tools: ['Bash'] })[0]!.session!.model, 'recorded-model');
  assert.match(event({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })[0]!.session!.notice!, /allowed_warning/);
});

test('tool JSON is retained structurally, typed output is prose, encrypted advisors are hidden, future payloads remain inspectable', () => {
  const parts = [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'src/main.ts' } }, { type: 'server_tool_use', name: 'advisor', input: {} }, { type: 'advisor_tool_result', content: { encrypted_content: 'opaque' } }];
  const events = event({ type: 'assistant', message: { content: parts } });
  assert.equal(events.length, 1); assert.equal(events[0]!.inputFormat, 'json'); assert.deepEqual(JSON.parse(events[0]!.input!), parts[0]!.input);
  assert.deepEqual(event({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'opaque' }] } }), []);
  const [output] = event({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: [{ type: 'text', text: 'Readable output' }, { type: 'image' }, { type: 'tool_reference', tool_name: 'Bash' }] }] } });
  assert.equal(output!.output, 'Readable output\n[Image attached]\nTool available: Bash');
  const raw = JSON.stringify({ type: 'future.event', payload: { secret: '<script>inert</script>' } });
  const [future] = consoleTranscript(raw); assert.equal(future!.unknown, true); assert.equal(future!.text, raw);
  assert.match(normalize(JSON.stringify({ type: 'system', subtype: 'thinking_tokens' }), true).join('\n'), /thinking_tokens/, 'TUI retains its original projection');
});

test('seat brief parses the exact builder envelope and preserves Markdown and literal markup within documents', () => {
  const docs = [{ source: 'architecture doc ARCHITECTURE.md', content: '# Architecture\n\n- One\n- Two\n\n```html\n<mode>example</mode>\n<script>inert</script>\n```' }, { source: 'spec.json unit rev 1', content: '## Acceptance\n\n`src/main.ts:12`' }];
  const parsed = parseSeatBrief(`<mode>pre-build</mode>\n${documentsXml(docs)}\n<intent>Review the change</intent>\nReturn the report.`);
  assert.equal(parsed.mode, 'pre-build'); assert.deepEqual(parsed.documents, docs); assert.equal(parsed.instructions, '<intent>Review the change</intent>\nReturn the report.');
  assert.deepEqual(parseSeatBrief(documentsXml(docs)).documents, docs, 'document markup is never interpreted as the prompt mode');
  assert.equal(parseSeatBrief(documentsXml(docs)).mode, null);
  assert.deepEqual(parseSeatBrief('Plain prompt\n<custom>literal</custom>'), { mode: null, documents: [], instructions: 'Plain prompt\n<custom>literal</custom>' });
});

test('console-specific tails page, pair and expand structured fields across hidden events without changing the default decoder', () => {
  const path = join(tmpDir('console-agentlog'), 'stdout'); const tail = new HistoryTail(consoleTranscript);
  const report = { decision: 'approve', reasons: ['Evidence '.repeat(1200)], findings: [], premises: [] };
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', id: 'report', input: report }] } }) + '\n');
  tail.read(path);
  appendFileSync(path, '{"type":"system","subtype":"thinking_tokens"}\n' + JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'report', content: 'Success' }] } }) + '\n');
  const paired = tail.read(path).events[0]!; assert.equal(paired.tool, 'StructuredOutput'); assert.equal(paired.output, 'Success'); assert.ok(paired.truncated.includes('input'));
  let text = ''; for (let after = 0;;) { const page = tail.expand(path, paired.refs!.input!, 'input', after); text += page.text; after = page.next; if (after === page.size) break; }
  assert.deepEqual(JSON.parse(text), report);
  appendFileSync(path, JSON.stringify({ type: 'result', structured_output: report, duration_ms: 200, usage: { output_tokens: 10 } }) + '\n');
  const [result] = tail.read(path).events; assert.equal(result!.report, true); assert.equal(result!.tokens, 10); assert.equal(result!.elapsedMs, 200);
});
