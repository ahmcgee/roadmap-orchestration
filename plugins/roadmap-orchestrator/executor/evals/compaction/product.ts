// A small, working register CLI. Neither domain retains the obsolete bridge/printer code.
import type { SetName } from './spec.ts';
export function productFiles(set: SetName): Readonly<Record<string, string>> {
  const commands = set === 'dev' ? ['reserve', 'cancel', 'arrive', 'depart', 'list', 'export', 'inspect', 'search']
    : ['accept', 'freeze', 'thaw', 'dispatch', 'list', 'export', 'inspect', 'search'];
  return {
    'src/register.js': `export function insert(rows, row) {
  if (!row.id || !row.operator || !row.container || !row.window) throw new Error('missing record fields');
  if (rows.some(r => r.id === row.id)) throw new Error('duplicate identifier');
  if (rows.some(r => !r.cancelled && r.container === row.container && r.window === row.window)) throw new Error('occupied container and window');
  return [...rows, { ...row, createdAt: row.createdAt ?? new Date().toISOString(), cancelled: false }];
}
export function cancel(rows, id, operator) {
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error('unknown record id');
  if (row.operator !== operator) throw new Error('different operator');
  return rows.map(r => r.id === id ? { ...r, cancelled: true } : r);
}
export function ordered(rows) { return [...rows].sort((a,b) => a.createdAt.localeCompare(b.createdAt)); }
export function exportRows(rows, format) {
  if (format === 'json') return JSON.stringify(ordered(rows));
  if (format === 'csv') return ['id,container,window,cancelled', ...ordered(rows).map(r => [r.id,r.container,r.window,r.cancelled].join(','))].join('\\n');
  throw new Error('unknown export format');
}
`,
    'src/cli.js': `import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { insert, cancel, ordered, exportRows } from './register.js';
const commands = ${JSON.stringify(commands)};
const [command, id, container, window] = process.argv.slice(2);
const path = process.env.REGISTER_FILE ?? 'register.json';
try {
  if (!commands.includes(command)) throw new Error('usage: ' + commands.join('|'));
  const rows = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  const operator = process.env.REGISTER_OPERATOR ?? 'office';
  if (command === 'list') process.stdout.write(JSON.stringify(ordered(rows)) + '\\n');
  else if (command === 'export') process.stdout.write(exportRows(rows, id ?? 'json') + '\\n');
  else if (command === 'inspect' || command === 'search') {
    if (!id) throw new Error('missing record id');
    const found = rows.filter(r => r.id === id);
    if (!found.length) throw new Error('unknown record id');
    process.stdout.write(JSON.stringify(found) + '\\n');
  } else {
    if (!id) throw new Error('missing record id');
    let next;
    if (command === commands[0]) next = insert(rows, { id, container, window, operator });
    else if (command === 'cancel') next = cancel(rows, id, operator);
    else {
      const row = rows.find(r => r.id === id);
      if (!row) throw new Error('unknown record id');
      if (row.operator !== operator) throw new Error('different operator');
      next = rows.map(r => r.id === id ? { ...r, state: command } : r);
    }
    writeFileSync(path + '.pending', JSON.stringify(next));
    renameSync(path + '.pending', path);
    process.stdout.write(id + '\\n');
  }
} catch (e) { process.stderr.write(e.message + '\\n'); process.exitCode = 2; }
`,
    'test/register.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { insert, cancel, exportRows } from '../src/register.js';
const first = { id:'a', operator:'office', container:'one', window:'morning', createdAt:'2026-10-01T00:00:00Z' };
test('list', () => assert.equal(spawnSync(process.execPath, ['src/cli.js', 'list']).stdout.toString(), '[]\\n'));
test('I-20', () => {
  const rows = insert([], first);
  assert.throws(() => insert(rows, {...first, id:'b'}), /occupied/);
  assert.throws(() => insert(rows, {...first, container:'two'}), /duplicate/);
});
test('cancelled exports', () => {
  const rows = cancel(insert([], first), 'a', 'office');
  assert.equal(JSON.parse(exportRows(rows, 'json'))[0].cancelled, true);
  assert.match(exportRows(rows, 'csv'), /a,one,morning,true/);
});
`,
  };
}
