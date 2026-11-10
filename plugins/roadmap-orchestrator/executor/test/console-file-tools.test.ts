import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpDir } from './helpers/repo.ts';
import { join } from 'node:path';
import { consoleTranscript } from '../src/console/agent-history.ts';
import { HistoryTail, pairEvents, type HistoryEvent } from '../src/tui/history.ts';

// Exercise the exact source helpers compiled into the committed browser bundle.
const { fileDiff, fileHistory, shellWritePath } = await import(new URL('../web-src/app/file-history.ts', import.meta.url).href) as {
  fileDiff: (a: string, b: string, start?: number) => { rows: { kind: string; text: string; old: number | null; next: number | null; mark?: number[] }[]; added: number; removed: number };
  fileHistory: (events: HistoryEvent[]) => Map<string, any>;
  shellWritePath: (command: string) => string | null;
};
const fixture = (name: string) => pairEvents(readFileSync(new URL(`./fixtures/transcripts/file-tools/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').flatMap((line, i) => consoleTranscript(line).map((e, j) => ({ ...e, id: `${i}:${j}` }))));
const tool = (id: string, name: string, input: unknown, output = '', status: 'passed' | 'failed' = 'passed'): HistoryEvent => ({ type: 'tool', id, toolId: id, tool: name, input: JSON.stringify(input), inputFormat: 'json', output, status, legacy: [] });

test('real Edit and Write transcripts preserve create/update provenance, recover prior writes and exact positions', () => {
  for (const name of ['plain2', 'plain4']) {
    const events = fixture(name), views = fileHistory(events);
    const writes = events.filter(e => e.tool === 'Write');
    assert.equal(writes.length, 4);
    assert.deepEqual(writes.map(e => views.get(e.id).kind), ['create', 'create', 'update', 'update']);
    assert.ok(views.get(writes[2]!.id).diff.rows.some((r: any) => r.kind === '+' && /export function/.test(r.text)));
    const edit = events.find(e => e.tool === 'Edit')!;
    assert.equal(views.get(edit.id).diff.added, 2); assert.equal(views.get(edit.id).diff.removed, 2);
    assert.ok(views.get(edit.id).diff.rows.some((r: any) => r.old === 1 && r.kind === '-'));
  }
});

test('Read snapshots support overwrite diffs and replace_all with actual line numbers; errors preserve prior content', () => {
  const events = fixture('edge-cases'), views = fileHistory(events);
  const view = (id: string) => views.get(events.find(e => e.toolId === id)!.id);
  assert.equal(view('overwrite-read').kind, 'update');
  assert.equal(view('overwrite-read').diff.added, 1);
  assert.equal(view('overwrite-read').diff.rows.find((r: any) => r.kind === '-').text, 'const ready = false;');
  assert.equal(view('replace-all').replaceAll, true);
  assert.equal(view('replace-all').diff.added, 2);
  assert.deepEqual(Array.from(view('replace-all').diff.rows.filter((r: any) => r.kind === '-'), (r: any) => r.old), [10, 12]);
  assert.equal(view('multi').diff.added, 2);
  assert.ok(view('multi').diff.rows.every((r: any) => r.kind === '@' || r.old === null));
  assert.equal(view('unknown-write').kind, null);
  assert.equal(view('unrecoverable-overwrite').kind, 'update');
  assert.equal(view('unrecoverable-overwrite').diff, null);
});

test('diff preserves unchanged lines, accurate counts, hunk ranges and cheap changed-word marks', () => {
  const diff = fileDiff('const answer = false;\nkeep\nlast\n', 'const answer = true;\nkeep\nlast\n', 17);
  assert.equal(diff.added, 1); assert.equal(diff.removed, 1);
  assert.equal(diff.rows[0]!.text, '@@ -17,3 +17,3 @@');
  assert.equal(diff.rows.find(r => r.kind === '-')!.old, 17);
  assert.ok(diff.rows.find(r => r.kind === '+')!.mark);
  assert.equal(diff.rows.filter(r => r.kind === ' ').length, 2);
  assert.equal(fileDiff('same\n', 'same\n').rows.length, 0);
  assert.equal(fileDiff('', 'first\n', 1).rows[0]!.text, '@@ -0,0 +1,1 @@');
  assert.equal(fileDiff('last\n', '', 1).rows[0]!.text, '@@ -1,1 +0,0 @@');
  const newlineOnly = fileDiff('same\n', 'same');
  assert.equal(newlineOnly.added, 1); assert.equal(newlineOnly.removed, 1);
  assert.ok(newlineOnly.rows.some(r => /No newline at end of file/.test(r.text)));
  const long = fileDiff('old\n'.repeat(600), 'new\n'.repeat(600));
  assert.equal(long.added, 600); assert.equal(long.removed, 600);
  assert.ok(long.rows.every(r => r.kind === '@' || (r.old === null && r.next === null)));
});

test('tool-result positions work without prior Read; failed or incomplete records never fabricate provenance', () => {
  const e = tool('edit', 'Edit', { file_path: 'a.ts', old_string: 'before', new_string: 'after' });
  e.fileResult = { starts: [23] };
  assert.equal(fileHistory([e]).get('edit').diff.rows.find((r: any) => r.kind === '-').old, 23);
  const write = tool('write', 'Write', { file_path: 'a.ts', content: 'new' }, 'File created successfully at: a.ts', 'failed');
  assert.equal(fileHistory([write]).get('write').kind, null);
  const truncated = { ...write, status: 'passed' as const, truncated: ['input'] };
  assert.equal(fileHistory([truncated]).has('write'), false);
  const decoded = consoleTranscript(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: 'Success' }] }, tool_use_result: { originalFile: 'one\nbefore\nbefore', oldString: 'before', replaceAll: true } }))[0]!;
  assert.deepEqual(decoded.fileResult!.starts, [2, 3]);
});

test('partial Reads do not masquerade as complete overwrite baselines; parent histories stay isolated', () => {
  const read = tool('r', 'Read', { file_path: 'a.ts', offset: 10, limit: 2 }, '10→before\n11→tail');
  const write = tool('w', 'Write', { file_path: 'a.ts', content: 'after' }, 'Updated');
  assert.equal(fileHistory([read, write]).get('w').kind, 'update');
  assert.equal(fileHistory([read, write]).get('w').diff, null);
  const limitedWhole = tool('whole', 'Read', { file_path: 'a.ts', limit: 100 }, '1→before\n2→tail');
  assert.ok(fileHistory([limitedWhole, write]).get('w').diff);
  const plain = tool('plain', 'Read', { file_path: 'a.ts' }, 'before\ntail');
  assert.ok(fileHistory([plain, write]).get('w').diff);
  const first = tool('w1', 'Write', { file_path: 'a.ts', content: 'before' }, 'File created successfully at: a.ts');
  assert.equal(fileHistory([first, { ...write, parent: 'another-agent' }]).get('w').kind, null);
});

test('only a plain single-path cat heredoc receives a shell-write label; shell changes invalidate recovered snapshots', () => {
  assert.equal(shellWritePath("cat > 'notes.md' <<'EOF'\nhello\nEOF"), 'notes.md');
  assert.equal(shellWritePath('cat > notes.md <<EOF\nhello\nEOF'), 'notes.md');
  for (const command of ['cat file', 'cat > a <<EOF\nx\nEOF\ncat > b <<EOF\ny\nEOF', 'tee notes.md', 'cat > "$OUT" <<EOF\nx\nEOF', 'sed -i s/a/b/ file']) assert.equal(shellWritePath(command), null);
  const first = tool('w1', 'Write', { file_path: 'a.ts', content: 'before' }, 'File created successfully at: a.ts');
  const shell = tool('b', 'Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'a.ts\',\'changed\')"' });
  const write = tool('w2', 'Write', { file_path: 'a.ts', content: 'after' }, 'The file a.ts has been updated successfully.');
  assert.equal(fileHistory([first, shell, write]).get('w2').diff, null);
});

test('isolated Edit recovers a unified hunk from its result without an earlier Read', () => {
  const events = fixture('edge-cases'), edit = events.find(e => e.toolId === 'edit-result-patch')!;
  const diff = fileHistory(events).get(edit.id).diff;
  assert.equal(diff.rows[0].text, '@@ -7,2 +7,2 @@');
  assert.equal(diff.rows[1].text, 'const ready = false;');
  assert.equal(diff.rows[1].old, 7);
  assert.equal(diff.rows[2].text, 'const ready = true;');
  assert.equal(diff.added, 1); assert.equal(diff.removed, 1);
  assert.ok(diff.rows[1].mark);
});

test('large tool-result patches stay bounded in previews and expand losslessly through the existing field API', () => {
  const patch = { oldStart: 1, oldLines: 80, newStart: 1, newLines: 80, lines: Array.from({ length: 80 }, (_, i) => '-old line ' + i).concat(Array.from({ length: 80 }, (_, i) => '+new line ' + i)) };
  const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Updated' }] }, tool_use_result: { structuredPatch: [patch] } });
  const path = join(tmpDir('console-file-patch'), 'stdout'); writeFileSync(path, line + '\n');
  const tail = new HistoryTail(consoleTranscript), event = tail.read(path).events[0]!;
  assert.ok(event.truncated.includes('text')); assert.ok(event.text!.length <= 1000);
  let text = '', after = 0;
  for (;;) { const page = tail.expand(path, event.refs!.text!, 'text', after); text += page.text; after = page.next; if (after === page.size) break; }
  assert.deepEqual(JSON.parse(text), { filePatch: [patch] });
});
