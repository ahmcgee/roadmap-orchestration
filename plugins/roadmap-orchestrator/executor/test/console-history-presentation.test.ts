import assert from 'node:assert/strict';
import { test } from 'node:test';
const { historyGroups, changedFiles } = await import(new URL('../web-src/app/history-presentation.ts', import.meta.url).href);
const tool = (id: string, command: string, extra = {}) => ({ id, type: 'tool', tool: 'Bash', input: JSON.stringify({ command, description: 'Verify replay' }), status: 'passed', ...extra });
test('successful repeated steps group without losing events, errors, active calls, or command meaning', () => {
  const events = [tool('1', 'node verify.js # first'), tool('2', 'node verify.js # second'), tool('3', 'node verify.js', { status: 'failed' }), tool('4', 'node verify.js'), tool('5', 'node verify.js'), tool('6', 'node verify.js')];
  const groups = historyGroups(events, true);
  assert.deepEqual(groups.map((g: any) => g.events.map((e: any) => e.id)), [['1', '2'], ['3'], ['4', '5'], ['6']]);
  assert.deepEqual(groups.flatMap((g: any) => g.events), events);
  for (const commands of [["echo '# one'", "echo '# two'"], ['echo \\#one', 'echo \\#two'], ['echo $(echo a #one)', 'echo $(echo a #two)']]) assert.equal(historyGroups(commands.map((c, i) => tool(String(i), c)), false).length, 2);
  assert.equal(historyGroups([tool('1', 'node verify.js'), tool('2', 'node verify.js', { parent: 'other' })], false).length, 2);
  assert.equal(historyGroups([tool('1', 'node verify.js'), tool('2', 'node verify.js', { truncated: ['input'] })], false).length, 2);
});
test('changed files index deduplicates successful edits, includes recognised shell writes, and retains honest counts', () => {
  const edit = (id: string, path: string, name = 'Edit') => ({ id, type: 'tool', tool: name, input: JSON.stringify({ file_path: path, content: 'new\n' }), status: 'passed' });
  const events = [edit('1', 'a.ts'), edit('2', 'a.ts'), edit('3', 'b.ts', 'Write'), tool('4', "cat > c.ts <<'EOF'\nhello\nEOF"), { ...edit('5', 'failed.ts'), status: 'failed' }, edit('6', 'unknown.ts', 'Write'), { ...edit('8','malformed.ts'), input:JSON.stringify({file_path:{unexpected:'object'}}) }];
  const views = new Map([['1', { diff: { added: 2, removed: 1 } }], ['2', { diff: { added: 1, removed: 2 } }], ['3', { kind: 'create' }]]);
  const files = changedFiles(events, views);
  assert.deepEqual(files.map((f: any) => f.path), ['a.ts', 'b.ts', 'c.ts', 'unknown.ts']);
  assert.deepEqual(files[0], { path: 'a.ts', id: '1', added: 3, removed: 3, counts: true });
  const laterDiff=changedFiles([edit('3','b.ts','Write'),edit('7','b.ts')],new Map([['3',{kind:'create'}],['7',{diff:{added:1,removed:1}}]]));
  assert.equal(laterDiff[0].id,'7','the file target prefers an available diff over its earlier creation');
  assert.equal(files[1].added, 1); assert.equal(files[2].counts, false); assert.equal(files[3].counts, false);
});
