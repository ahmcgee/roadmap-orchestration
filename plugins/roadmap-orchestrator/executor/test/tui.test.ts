import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ObserverJournal, readJournal, openJournal, LogCorruptError } from '../src/core/log.ts';
import { arcId, opKey, sha256, unitId } from '../src/core/ids.ts';
import { absPath, isoTime } from '../src/core/values.ts';
import { status } from '../src/status.ts';
import { parseCommand } from '../src/input/cli.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { keepInput, inputPath } from '../src/input/inforce.ts';
import { launchSha256 } from '../src/runner/launch.ts';
import type { LaunchFile } from '../src/core/records.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { claimRecord } from './fixtures/host-records.ts';
import { readBootId } from '../src/contain/proc.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { activityState, assessmentExplanation } from '../src/tui/outcome.ts';
import { sha256Hex } from '../src/core/json.ts';
import { witnessDir } from '../src/git/snapshot.ts';
import { ModelReader } from '../src/tui/models.ts';
import { InvocationRelations } from '../src/tui/relations.ts';
import { ViewerDiagnostics } from '../src/tui/diagnostics.ts';
import { executionSummary } from '../src/tui/execution.ts';
import { parseObligations, laneRevOf } from '../src/holistic/types.ts';
import { Observer } from '../src/tui/observer.ts';
import { TranscriptReader, normalize, PAGE_BYTES, safe } from '../src/tui/transcript.ts';
import { dependencyDrawing } from '../src/tui/graph-view.ts';
import { estateOutline, estateRowLabel } from '../src/tui/estate-tree.ts';
import { graph } from '../src/tui/graph.ts';
import { ViewState, matches } from '../src/tui/state.ts';
import { clip, width, wrap, fit, ink, line, paint, plain, stateTone } from '../src/tui/terminal.ts';
import { contentHeight } from '../src/tui/view.ts';
import { markdown, documentLines } from '../src/tui/markdown.ts';
import { document, project, summary } from '../src/tui/projection.ts';
import { promptLines } from '../src/tui/prompt.ts';
import { originalInput } from '../src/tui/navigation.ts';
import { connect, estate } from '../src/tui/estate.ts';
import { parseDebtLedger } from '../src/debt/types.ts';
import { debtKey } from '../src/debt/ledger.ts';
import { mintDebt } from '../src/debt/mint.ts';
import { renderDebt } from '../src/docs/debt.ts';
import { setupCorpusArc } from './fixtures/corpus-unit.ts';
import type { Display, Entry, Invocation, ObserveRequest } from '../src/tui/types.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';
import { tmpDir, git } from './helpers/repo.ts';

function fixture() {
  const d = setupArc({ steps: [], units: [{ id: 'root' }, { id: 'left', after: ['root'] }, { id: 'right', after: ['root'] }, { id: 'join', after: ['left', 'right'] }] });
  const r = contextFor(d); r.journal.close();
  writeFileSync(join(d.runDir, 'start.json'), JSON.stringify({ v: 1, generation: 1, at: new Date().toISOString(), repo: d.repo, planFile: d.planPath, profile: 'default' }));
  const request: ObserveRequest = { locator: { type: 'host' }, hostDir: absPath(d.hostDir), pinned: { runDir: absPath(d.runDir), arc: arcId(d.arc) }, log: null, token: 1 };
  return { d, request };
}
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, contents(path)); else out[path] = readFileSync(path).toString('base64');
  }
  return out;
}
function observed(): Display {
  const { request } = fixture(); const reply = new Observer().observe(request); assert.equal(reply.error, null); return reply.display!;
}
const entry = (id: string, body: unknown, state = 'active'): Entry => ({ id, label: id, state, body: JSON.stringify(body), provenance: 'test', links: [] });

test('tui parser preserves paired locator contract and rejects noninteractive use', () => {
  assert.deepEqual(parseCommand(['tui']), { command: 'tui', run: { type: 'host' } });
  assert.equal(parseCommand(['tui', '--repo', '/tmp', '--arc', 'test']).command, 'tui');
  assert.throws(() => parseCommand(['tui', '--repo', '/tmp']), /go together/);
  const result = spawnSync(process.execPath, ['bin/roadmap', 'tui'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /interactive terminal/);
});

test('incremental observer verifies appends, partial tails, corruption, replacement, truncation and restart without writes', () => {
  const { d } = fixture(); const dir = absPath(d.runDir); const arc = arcId(d.arc);
  const reader = new ObserverJournal(dir, arc); const file = join(dir, 'events.jsonl');
  const full = readFileSync(file); const lines = full.toString().trimEnd().split('\n').map((s) => s + '\n');
  writeFileSync(file, '');
  for (const line of lines) {
    const bytes = Buffer.from(line); const half = Math.floor(bytes.length / 2);
    appendFileSync(file, bytes.subarray(0, half)); const before = contents(dir);
    assert.deepEqual(reader.read().events, readJournal(dir, arc).events); assert.deepEqual(contents(dir), before);
    appendFileSync(file, bytes.subarray(half)); assert.deepEqual(reader.read().events, readJournal(dir, arc).events);
  }
  const oldView = reader.read().view;
  assert.equal(reader.read().view, oldView, 'unchanged polls reuse the verified fold');
  appendFileSync(file, 'bad\n'); assert.throws(() => reader.read(), LogCorruptError); assert.match(readFileSync(file, 'utf8'), /bad\n$/);
  writeFileSync(file, full); assert.deepEqual(reader.read().events, readJournal(dir, arc).events);
  writeFileSync(file + '.new', lines[0]!); renameSync(file + '.new', file);
  assert.equal(reader.read().events.length, 1);
  writeFileSync(file, ''); assert.equal(reader.read().events.length, 0);
  writeFileSync(file, full); assert.deepEqual(reader.read().events, readJournal(dir, arc).events);
  rmSync(file); assert.equal(reader.read().events.length, 0);
});

test('observer status parity, stale publication and read-only estate provenance exclude unapplied edits', () => {
  const { d, request } = fixture(); const observer = new Observer(); const before = contents(d.runDir);
  const result = observer.observe(request); assert.equal(result.error, null);
  const canonical = status(absPath(d.runDir), arcId(d.arc), absPath(d.hostDir));
  const removeTiming = (s: typeof canonical) => ({ ...s, host: { ...s.host, log: { ...s.host.log, foldMs: 0 } } });
  assert.deepEqual(removeTiming(result.display!.status), removeTiming(canonical));
  assert.deepEqual(contents(d.runDir), before);
  const original = result.display!.estate;
  writeFileSync(d.planPath, 'unapplied invalid plan');
  writeFileSync(join(d.repo, 'contracts/api.md'), 'UNAPPLIED CONTRACT');
  git(d.repo, 'add', 'contracts/api.md'); git(d.repo, 'commit', '-m', 'a newer commit outside the journal snapshot');
  const next = observer.observe(request); assert.equal(next.error, null); assert.deepEqual(next.display!.estate, original);
  assert.ok(original.some((e) => e.provenance.startsWith('commit ') && e.id === 'contracts/api.md' && !e.body.includes('UNAPPLIED')));
  assert.ok(original.some((e) => e.id === 'root' && e.provenance.includes('sha256')));
  assert.ok(original.find((e) => e.id === 'root')!.links.includes('contracts/api.md'));
  assert.ok(original.find((e) => e.id === '.roadmap/invariants.md')!.body.includes('Unavailable'));
  appendFileSync(join(d.runDir, 'events.jsonl'), 'bad\n');
  const failed = observer.observe(request); assert.equal(failed.display, null); assert.match(failed.error!, /corrupt/);
  const ui = new ViewState(); ui.accept(result.display!); ui.error = failed.error;
  assert.match(ui.render(120, 35, false).join('\n'), /STALE/);
});

test('graph preserves branching, joins, conditions and open milestone checkpoints while hiding settled prerequisites', () => {
  const d = observed();
  d.status = { ...d.status, units: d.status.units.map((u) => ({ ...u, state: u.unit === 'root' ? 'merged' : u.state })),
    edges: [...d.status.edges, { type: 'contingent', unit: d.status.units[1]!.unit, edge: 'E-1' as never, condition: 'owner approval', resolved: false },
      { type: 'milestone', unit: d.status.units[3]!.unit, milestone: 'M-1' as never, passed: false }],
    milestones: [{ id: 'M-1', state: 'waiting', passed: false, round: 0, walks: [], findings: [] }] as never };
  d.milestoneUnits['M-1'] = ['left', 'right'];
  const rows = graph(d, true); const ids = rows.map((r) => r.id);
  for (const row of rows) for (const dep of row.from) assert.ok(ids.indexOf(dep) < ids.indexOf(row.id), `${dep} precedes ${row.id}`);
  assert.deepEqual(rows.find((r) => r.id === 'join')!.from, ['left', 'right', 'M-1']);
  const open = graph(d, false); assert.ok(!open.some((r) => r.id === 'root'));
  assert.ok(open.find((r) => r.id === 'left')!.from.includes('root'));
  assert.deepEqual(graph(d, true), rows);
  const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true; ui.selected.set('1:0', 'join');
  ui.accept({ ...d, at: new Date().toISOString() }); assert.equal(ui.selection()!.id, 'join');
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const frame = ui.render(w!, h!, false); assert.equal(frame.length, h);
    assert.match(frame.join('\n'), /Dependency map/); assert.match(frame.join('\n'), /Activity/);
  }
});

test('transcript normalization preserves Claude tools, Codex output, nested metadata, unknown and malformed records', () => {
  const line = JSON.stringify({ type: 'assistant', parent_tool_use_id: 'parent-1', message: { role: 'assistant', content: [
    { type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo yes' } }] } });
  assert.match(normalize(line, false).join('\n'), /parent parent-1.*tool Bash/);
  const output = JSON.stringify({ type: 'item.completed', item: { id: 'x', type: 'command_execution', command: 'test', aggregated_output: 'z'.repeat(1000) } });
  assert.match(normalize(output, false).join('\n'), /expand/); assert.ok(normalize(output, true).join('\n').length > 1000);
  assert.match(normalize('{broken', false)[0]!, /malformed/);
  assert.match(normalize('  {"type":broken}', false)[0]!, /malformed JSON/);
  for (const expanded of [false, true]) {
    assert.deepEqual(normalize('waiting step-05', expanded), ['waiting step-05']);
    assert.deepEqual(normalize('[info] waiting for output', expanded), ['[info] waiting for output']);
    assert.deepEqual(normalize('', expanded), ['']);
    assert.deepEqual(normalize('\x1b[31mwaiting step-05\x1b[0m', expanded), ['waiting step-05']);
  }
  assert.match(normalize('{"type":"future","payload":1}', true)[0]!, /future/);
  assert.match(normalize('{"type":"result","structured_output":{"ok":true}}', true).join('\n'), /final report/);
  assert.equal(safe('\x1b]52;c;secret\x07safe\x1b[2J\x1b[31m\u202e'), 'safe');
  assert.ok(width(clip('你好🙂abc', 7)) <= 7);
});

test('forward paging keeps every byte of a record larger than a page, labelled as fragments', () => {
  const path = join(tmpDir('tui-oversize'), 'stdout'); const big = 'B'.repeat(PAGE_BYTES + 30_000);
  writeFileSync(path, `first\n${big}\nlast\n`);
  const reader = new TranscriptReader(); const label = '[record exceeds page: fragment; raw view available]';
  let page = reader.read(path, PAGE_BYTES, false, false, 0); const shown = [...page.lines];
  while (page.end < page.size) {
    page = reader.read(path, Math.min(page.size, page.end + PAGE_BYTES), false, false, page.end);
    shown.push(...page.lines);
  }
  assert.ok(shown.includes(label), 'a page starting inside the record says so');
  assert.equal(shown.filter((l) => l !== label).join(''), `first${big}last`);
});

test('scrolling before the first log page arrives leaves the follow request alone', () => {
  const ui = new ViewState(); ui.logRequest = { inv: 'x', source: 'transcript', before: null, expanded: false }; ui.follow = true;
  for (const key of ['down', 'up', 'pageup']) ui.key(key, '', 10);
  assert.equal(ui.follow, true); assert.equal(ui.logRequest.before, null); assert.equal(ui.logRequest.after, undefined);
});

test('large transcript paging is bounded, reversible, append-aware, and handles missing/replaced logs', () => {
  const path = join(tmpDir('tui-logs'), 'stdout');
  const lines = Array.from({ length: 12000 }, (_, i) => JSON.stringify({ type: 'message', text: `row-${i} ${'x'.repeat(40)}` }) + '\n');
  writeFileSync(path, lines.join(''));
  const reader = new TranscriptReader(); const tail = reader.read(path, null, false, false);
  assert.ok(tail.start > 0); assert.ok(tail.end - tail.start <= PAGE_BYTES);
  let page = tail; let n = 0;
  while (page.start > 0) { const previous = page.start; page = reader.read(path, page.start, false, false); assert.ok(page.start < previous); n++; }
  assert.ok(n > 8); assert.ok(reader.cache.size <= 8); assert.match(page.lines[0]!, /row-0/);
  let forward = reader.read(path, PAGE_BYTES, false, false, 0);
  const reconstructed = [...forward.lines];
  while (forward.end < forward.size) {
    const next = reader.read(path, Math.min(forward.size, forward.end + PAGE_BYTES), false, false, forward.end);
    assert.ok(next.end > forward.end);
    reconstructed.push(...next.lines); forward = next;
  }
  assert.deepEqual(reconstructed, lines.map((line) => line.trimEnd()), 'forward pages neither skip nor duplicate records');
  appendFileSync(path, 'new output\n'); assert.equal(reader.read(path, null, false, false).lines.at(-1), 'new output');
  assert.equal(reader.latest(path), 'new output');
  assert.equal(reader.read(path, null, true, false).lines.at(-1), 'new output');
  appendFileSync(path, '{"type":"assistant","message":{"content":[{"type":"text","text":"new');
  reader.latest(path);
  appendFileSync(path, ' message"}]}}\n');
  assert.match(reader.latest(path), /new message/);
  writeFileSync(path + '.new', 'replacement\n'); renameSync(path + '.new', path);
  assert.deepEqual(reader.read(path, null, false, false).lines, ['replacement']);
  writeFileSync(path, 'x'.repeat(PAGE_BYTES * 3));
  const huge = reader.read(path, null, true, false); assert.ok(huge.start < huge.end);
  rmSync(path); assert.match(reader.read(path, null, false, false).error!, /pruned/);
});

test('log scrolling freezes viewport, counts new bytes, resumes following; detail defers host handover', () => {
  const ui = new ViewState(); ui.accept(observed()); ui.pane = 1; ui.activityExpanded = true; ui.activityAll = true;
  ui.logRequest = { inv: 'inv', source: 'transcript', before: null, expanded: false };
  const page = { key: 'inv', start: 0, end: 100, size: 100, lines: Array.from({ length: 50 }, (_, i) => `line ${i}`), error: null };
  ui.acceptLog(page, 10); assert.equal(ui.offset, 40);
  ui.move(-5, 10); assert.equal(ui.follow, false); assert.equal(ui.offset, 35);
  ui.acceptLog({ ...page, size: 150 }, 10); assert.equal(ui.offset, 35);
  assert.match(ui.render(80, 24, true).join('\n'), /PAUSED \+50 new bytes/);
  ui.key('', 'f', 10); assert.equal(ui.follow, true); assert.equal(ui.logRequest.before, null);
  ui.acceptLog({ ...page, end: 150, size: 150, lines: [...page.lines, 'new'] }, 10); assert.equal(ui.offset, 41);
  assert.equal(ui.canFollowHost(), false); ui.key('', '1', 10); assert.equal(ui.canFollowHost(), true);
  ui.open(); assert.equal(ui.canFollowHost(), false); ui.key('escape', '', 10); assert.equal(ui.canFollowHost(), true);
  ui.accept({ ...ui.display!, run: { ...ui.display!.run, arc: arcId('next'), runDir: absPath('/tmp/next') } });
  assert.match(ui.notice, /Following host:/);
});

test('estate relationships and filters use recorded references, with reverse navigation', () => {
  const entries = connect([entry('V-1', { id: 'V-1' }), entry('I-1', { serves: ['V-1'], deliveredBy: ['unit'] }), entry('unit', { obligations: ['I-1'] }), entry('inactive', {}, 'withdrawn')]);
  assert.deepEqual(entries[0]!.links, ['I-1']); assert.ok(entries[2]!.links.includes('I-1'));
  assert.ok(matches({ ...entries[2]!, role: 'gate', unit: 'unit' } as Entry, 'unit:unit role:gate status:active'));
  const ui = new ViewState(); ui.accept({ ...observed(), estate: entries }); ui.view = 2;
  assert.equal(ui.rows().length, 3); ui.key('', 'w', 10); assert.equal(ui.rows().length, 4);
  ui.selected.set('2:0', 'V-1'); ui.open(); ui.key('tab', '', 10); ui.open(); assert.equal(ui.detail!.id, 'I-1');
  ui.key('escape', '', 10); assert.equal(ui.detail!.id, 'V-1');
});

test('real CLI PTY: 120x35, resize to 80x24, navigation, status coexistence, signals and terminal restoration; no runtime writes', { timeout: 45000 }, () => {
  const { d } = fixture();
  const runtime = join(d.repo, '.git', 'roadmap-runtime', d.arc); mkdirSync(runtime, { recursive: true }); cpSync(d.runDir, runtime, { recursive: true });
  const before = contents(runtime);
  const script = `import os, pty, subprocess, termios, fcntl, struct, select, time, signal, sys, atexit
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
def size(w,h): fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH',h,w,0,0))
def read_for(seconds):
 out=b''; end=time.monotonic()+seconds
 while time.monotonic()<end:
  if select.select([master],[],[],0.05)[0]:
   try: out+=os.read(master,65536)
   except OSError: break
 return out
def cleanup():
 if p.poll() is None:
  p.terminate()
  try: p.wait(timeout=3)
  except subprocess.TimeoutExpired: p.kill(); p.wait()
atexit.register(cleanup)
size(120,35)
for mode in ['q','SIGTERM','SIGINT']:
 p=subprocess.Popen([sys.argv[1],'bin/roadmap','tui','--repo',sys.argv[2],'--arc',sys.argv[3]],stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'CLAUDE_CONFIG_DIR':sys.argv[2], 'CLAUDE_CODE_OAUTH_TOKEN':''})
 out=b''; ready_by=time.monotonic()+8
 while b'Dependency map' not in out and time.monotonic()<ready_by and p.poll() is None: out+=read_for(.1)
 assert b'ROADMAP' in out and b'Dependency map' in out, out
 assert not (termios.tcgetattr(slave)[3] & termios.ICANON)
 if mode=='q':
  for key, expected in [(b'x',b'Activity expanded'), (b'g',b'All activity'), (b'x',b'Dependency map'), (b'3',b'Estate ('), (b'\\r',b'Not recorded for this run'), (b'\\x1b',None), (b'\\x1b[B\\x1b[B',None), (b'\\r',b'Arc execution plan'), (b'r',b'Raw'), (b'r',b'Readable'), (b'\\x1b',None), (b'1',b'Dependency map'), (b'\\r',b'Unit status: root'), (b'\\x1b[C',b'Unit specification: root'), (b'\\r',b'Dependency map > Unit specification: root'), (b'\\x1b',b'Unit status: root'), (b'\\x1b',b'Dependency map'), (b'\\t',None), (b'?',b'Read-only executor observatory'), (b'?',None)]:
   os.write(master,key); change=read_for(.6 if key==b'\\x1b' else .12)
   deadline=time.monotonic()+3
   while expected and expected not in change and time.monotonic()<deadline: change+=read_for(.1)
   assert not expected or expected in change, (key,expected,change)
   out+=change
  size(80,24); p.send_signal(signal.SIGWINCH); out+=read_for(.15)
  status=subprocess.run([sys.argv[1],'bin/roadmap','status','--repo',sys.argv[2],'--arc',sys.argv[3]],capture_output=True)
  assert status.returncode==0, status.stderr
  os.write(master,b'q')
 else: p.send_signal(getattr(signal,mode))
 out+=read_for(.3); p.wait(timeout=5)
 assert p.returncode==0, out
 assert b'\\x1b[?1049l' in out and b'\\x1b[?25h' in out, out
 assert out.endswith(b'\\x1b[?1049l'), 'viewer rendered after restoring the terminal: '+repr(out[-300:])
 assert termios.tcgetattr(slave)==original
 assert b'?1000h' not in out
print('PTY PASS 120x35 / 80x24, q SIGTERM SIGINT, restored')
`;
  const result = spawnSync('python3', ['-c', script, process.execPath, d.repo, d.arc], { encoding: 'utf8', timeout: 40000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(contents(runtime), before);
});


test('all retained invocations, lost retries, command sources and invalid runner bindings remain observable', () => {
  const dir = absPath(tmpDir('tui-inv')); const arc = arcId('tui-inv'); const host = absPath(tmpDir('tui-host'));
  const journal = openJournal(dir, arc);
  const body = () => ({ expect: { subject: { purpose: 'smoke' as const, check: 'command', target: { type: 'command' as const } }, launchSha256: sha256('1'.repeat(64)) }, post: null });
  for (let i = 0; i < 25; i++) {
    const op = journal.begin({ kind: 'proc.spawn', key: opKey(`spawn:${i}`), parent: { type: 'arc' }, deadlineAt: null, body });
    journal.done(op.op, 'proc.spawn', { kind: 'lost', treeEffects: false }, null);
  }
  const prompt = 'BEGIN RETAINED INPUT\n' + 'Planning instructions and supporting context.\n'.repeat(4000) + 'END RETAINED INPUT\n';
  const promptPath = inputPath(dir, keepInput(dir, Buffer.from(prompt), 'prompt.txt'), 'prompt.txt');
  let launch!: LaunchFile;
  const current = journal.begin({ kind: 'proc.spawn', key: opKey('spawn:running'), parent: { type: 'arc' }, deadlineAt: null, body: (op, inv) => {
    launch = { v: 1, arc, op, inv, argv: ['node', '-e', ''], cwd: dir, env: {}, stdinPath: promptPath,
      deadlineAt: isoTime('2099-01-01T00:00:00.000Z'), stallMs: null, graceMs: 1000, containment: 'session', test: null,
      terminal: { type: 'command', purpose: 'smoke', expectedExit: 0 } };
    return { expect: { ...body().expect, launchSha256: launchSha256(launch) }, post: null };
  } });
  const invDir = invocationDir(dir, current.inv); mkdirSync(invDir, { recursive: true });
  const files = runnerFiles(invDir, current.inv);
  files.write('launch.json', launch);
  writeFileSync(join(invDir, 'stdout'), 'lane output\n'); writeFileSync(join(invDir, 'stderr'), 'stderr detail\n'); writeFileSync(join(invDir, 'runner.log'), 'runner detail\n');
  const request: ObserveRequest = { locator: { type: 'host' }, hostDir: host, pinned: { runDir: dir, arc }, log: null, token: 1 };
  const observer = new Observer(); const first = observer.observe(request); assert.equal(first.error, null);
  assert.equal(first.display!.invocations.length, 26);
  assert.equal(first.display!.invocations.find((i) => i.id === current.inv)!.execution, 'command');
  assert.equal(first.display!.invocations.find((i) => i.id === current.inv)!.scope, 'arc');
  const ui = new ViewState(); ui.accept(first.display!); ui.pane = 1; ui.activityExpanded = true; ui.activityAll = true; assert.equal(ui.rows().length, 21);
  ui.key('', 'a', 10); assert.equal(ui.rows().length, 26);
  for (const source of ['stdout', 'stderr', 'runner.log'] as const) {
    const reply = observer.observe({ ...request, log: { inv: current.inv, source, before: null, expanded: false } });
    assert.equal(reply.error, null); assert.match(reply.log!.lines.join(' '), /output|detail/);
  }
  const event = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'first line\nsecond line\n', is_error: false }] } });
  writeFileSync(join(invDir, 'stdout'), event + '\n');
  const readableOutput = observer.observe({ ...request, log: { inv: current.inv, source: 'stdout', before: null, expanded: true } });
  assert.equal(readableOutput.error, null);
  assert.match(readableOutput.log!.lines.join('\n'), /Tool result.*\n  first line\n  second line/);
  assert.doesNotMatch(readableOutput.log!.lines.join('\n'), /"tool_use_id"|\\n/);
  const rawOutput = observer.observe({ ...request, log: { inv: current.inv, source: 'stdout', before: null, expanded: true, raw: true } });
  assert.deepEqual(rawOutput.log!.lines, [event], 'raw stdout is preserved behind the explicit toggle');
  const friendlyResult = observer.observe({ ...request, log: { inv: current.inv, source: 'result', before: null, expanded: false } });
  assert.match(friendlyResult.log!.lines.join('\n'), /Outcome: unowned/);
  assert.match(friendlyResult.log!.lines.join('\n'), /Unavailable or pruned result/);
  assert.doesNotMatch(friendlyResult.log!.lines.join('\n'), /"invocation":/);
  const rawResult = observer.observe({ ...request, log: { inv: current.inv, source: 'result', before: null, expanded: false, raw: true } });
  assert.match(rawResult.log!.lines.join('\n'), /"invocation":/);
  assert.equal(rawResult.error, null);
  const inputRequest: ObserveRequest = { ...request, log: { inv: current.inv, source: 'prompt', before: PAGE_BYTES, after: 0, expanded: false } };
  const beforeInput = contents(dir);
  const input = observer.observe(inputRequest); assert.equal(input.error, null);
  assert.equal(input.log!.start, 0); assert.match(input.log!.lines[0]!, /BEGIN RETAINED INPUT/);
  assert.ok(input.log!.end < input.log!.size, 'long prompts are paged from the beginning');
  const endInput = observer.observe({ ...inputRequest, log: { inv: current.inv, source: 'prompt', before: null, expanded: false } });
  assert.match(endInput.log!.lines.at(-1)!, /END RETAINED INPUT/);
  assert.deepEqual(contents(dir), beforeInput, 'opening and paging input writes nothing');
  writeFileSync(promptPath, 'tampered input');
  assert.match(observer.observe(inputRequest).error!, /does not hash/);
  rmSync(promptPath);
  assert.match(observer.observe(inputRequest).log!.lines.join(' '), /unavailable or has been pruned/);
  const absentInput = observer.observe({ ...inputRequest, log: { ...inputRequest.log!, inv: first.display!.invocations.at(-1)!.id } });
  assert.match(absentInput.log!.lines.join(' '), /No retained agent input prompt/);
  const file = join(invDir, 'launch.json');
  writeFileSync(file, JSON.stringify({ ...launch, argv: ['changed'] })); assert.match(observer.observe(request).error!, /hash/);
  writeFileSync(file, JSON.stringify({ ...launch, arc: 'wrong' })); assert.match(observer.observe(request).error!, /arc|expected|op/);
  journal.close();
});

test('host observation follows atomic claim handover, pins detail, and continues after release', () => {
  const a = fixture(); const b = fixture(); const observer = new Observer();
  const host = a.request.hostDir; const claimFile = join(host, 'host.lock');
  const publish = (d: typeof a.d): void => {
    const claim = { ...claimRecord({ supervisor: selfIdentity(), bootId: readBootId(), arc: arcId(d.arc) }), repo: absPath(d.repo), runDir: absPath(d.runDir) };
    writeFileSync(claimFile + '.next', JSON.stringify(claim)); renameSync(claimFile + '.next', claimFile);
  };
  const request = { ...a.request, pinned: null };
  publish(a.d); const first = observer.observe(request); assert.equal(first.display!.run.arc, a.d.arc);
  publish(b.d); const pinned = observer.observe({ ...request, pinned: first.display!.run }); assert.equal(pinned.display!.run.arc, a.d.arc);
  const next = observer.observe(request); assert.equal(next.display!.run.arc, b.d.arc);
  rmSync(claimFile); const released = observer.observe(request); assert.equal(released.error, null); assert.equal(released.display!.run.arc, b.d.arc);
});


test('framed views fit both terminal sizes, retain selection and expose provenance without style injection', () => {
  const ui = new ViewState(); const d = observed();
  d.estate = Array.from({ length: 40 }, (_, i) => ({ ...entry(`doc-${i}`, { description: 'document' }),
    label: `Document ${i} 界🙂e\u0301 \x1b[2J`, provenance: 'commit 0123456789' }));
  ui.accept(d); ui.view = 2; ui.selected.set('2:0', 'doc-39');
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const frame = ui.renderFrame(w!, h!, false); const text = frame.map(plain);
    assert.equal(frame.length, h);
    assert.ok(text.every((row) => width(row) === w! - 1), 'borders and wide text stay inside the terminal');
    assert.ok(text.every((row) => !row.includes('\x1b')));
    assert.match(text.join('\n'), /Document 39/);
    assert.match(text.join('\n'), /PROVENANCE/);
    assert.match(text.join('\n'), /above/);
    assert.match(text[1]!, /\[3 Estate\]/, 'active tab remains explicit without colour');
    assert.equal(ui.selection()!.id, 'doc-39');
    const selected = frame.find((row) => row.some((part) => part.selected && part.text.includes('Document 39')));
    assert.ok(selected);
    assert.ok(selected.some((part) => part.tone === 'accent'));
    assert.match(paint(selected, w! - 1, true), /38;5;81/);
  }
  ui.view = 1; const wide = ui.render(120, 35, false); const narrow = ui.render(80, 24, false);
  assert.ok(wide.some((row) => row.includes('╭') && row.includes('Dependency map') && row.includes('Activity')), 'wide layout places both panel headers on the same row');
  assert.ok(!narrow.some((row) => row.includes('╭') && row.includes('Dependency map') && row.includes('Activity')), 'narrow layout stacks the actual panels below the shared navigation tabs');
  assert.ok(narrow.some((row) => row.includes('[1 Dependency map]') && row.includes('Activity')), 'both panes remain discoverable at narrow widths');
  assert.ok(narrow.some((row) => row.includes('Activity')));
  const mono = ui.render(80, 24, true).join('\n');
  assert.doesNotMatch(mono, /[╭╮╰╯│─▸●◇↑↓]/);
  assert.match(mono, /\[1 Dependency map\]/);
});

test('styled output clips untrusted control sequences and colours only the intended fields', () => {
  const row = line(ink('running', 'accent'), ink(' failed-spec.md', 'text'), { text: '\x1b[2J\x1b]52;c;bad\x07界', tone: 'muted' });
  const colored = paint(row, 24, true); const mono = paint(row, 24, false);
  assert.doesNotMatch(colored, /\x1b\[2J|\x1b\]52/);
  assert.doesNotMatch(mono, /\x1b/);
  assert.equal(width(mono), 24);
  assert.match(colored, /38;5;81/);
  assert.match(colored, /38;5;252/);
  assert.doesNotMatch(colored, /38;5;203/, 'a filename containing failed does not turn a row red');
});

test('framed transcript viewport uses the same height for following, paging and resize', () => {
  const ui = new ViewState(); ui.accept(observed());
  ui.logRequest = { inv: 'inv', source: 'transcript', before: null, expanded: false };
  const lines = Array.from({ length: 100 }, (_, i) => `transcript-row-${i}`);
  const page = { key: 'inv', start: 0, end: 1000, size: 1000, lines, error: null };
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const height = contentHeight(h!);
    ui.key('', 'f', height); ui.acceptLog(page, height);
    let text = ui.render(w!, h!, false).join('\n');
    assert.equal(ui.offset, 100 - height);
    assert.match(text, /transcript-row-99/);
    assert.equal(text.match(/transcript-row-/g)?.length, height);
    ui.key('pageup', '', height); const offset = ui.offset;
    ui.acceptLog({ ...page, size: 1200 }, height);
    text = ui.render(w!, h!, false).join('\n');
    assert.equal(ui.offset, offset);
    assert.match(text, /PAUSED \+200 new bytes/);
    assert.doesNotMatch(text, /transcript-row-99/);
    ui.key('', 'f', height); ui.acceptLog(page, height);
    assert.match(ui.render(w!, h!, false).join('\n'), /transcript-row-99/);
  }
});


test('friendly estate projection prioritises intent and criteria, preserves unknown fields and recorded values', () => {
  const plan = { schema: 'roadmap/plan-m1', baseline: 'abc123', direction: 'Ship a useful search tool.', units: [{ id: 'search', after: ['index'] }] };
  const text = project(plan).map((r) => r.text).join('\n');
  assert.match(text, /^Intent: Ship a useful search tool/);
  assert.match(text, /Units \(1\)/); assert.match(text, /Depends on: index/);
  assert.ok(text.indexOf('Record details') > text.indexOf('Units'));
  assert.match(text, /Baseline commit: abc123/);
  assert.equal(summary(JSON.stringify(plan)), 'Ship a useful search tool.');
  const spec = { schema: 'roadmap/spec-m1', unit: 'search', acceptance: [{ id: 'A1', clause: 'Find matching pages.', state: 'active', failLoudIfUndelivered: true }],
    lanes: [{ id: 'tests', argv: ['node', '--test', 'test files/search.js'], expectedExit: 0 }], unknownFlag: false, futureField: { nestedValue: 'retained' }, absent: null };
  const detail = document(JSON.stringify(spec)).map((r) => r.text).join('\n');
  assert.match(detail, /Acceptance criteria \(1\)/);
  assert.match(detail, /A1 \(active, required for completion\): Find matching pages/);
  assert.match(detail, /Command: node --test 'test files\/search.js'/);
  assert.match(detail, /Expected exit code: 0/); assert.match(detail, /Unknown Flag: No/);
  assert.match(detail, /Nested Value: retained/); assert.match(detail, /Absent: Not recorded/);
  assert.doesNotMatch(detail, /"acceptance"|"argv"|\[object Object\]/);
  assert.deepEqual(document('# Contract\nKeep this prose.'), [{ kind: 'text', text: '# Contract' }, { kind: 'text', text: 'Keep this prose.' }]);
  assert.match(project(JSON.parse('{"constructor":"custom","__proto__":"ordinary"}')).map((r) => r.text).join(' '), /custom.*ordinary/);
});

test('friendly agent reports and tools retain decisions, errors, output and unknown events without JSON noise', () => {
  const event = JSON.stringify({ type: 'result', structured_output: { decision: 'revise', reasons: ['Handle empty input.'], directives: ['Add a boundary test.'], passed: false, count: 0 } });
  const normalized = normalize(event, true).join('\n');
  assert.match(normalized, /^final report: Decision: revise.*Handle empty input/);
  assert.match(normalized, /Directives: Add a boundary test/);
  assert.match(normalized, /Passed: No/); assert.match(normalized, /Count: 0/);
  assert.doesNotMatch(normalized, /"decision"|"directives"/);
  const codex = normalize(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'one test failed' } }), false).join('\n');
  assert.match(codex, /Completed command: npm test/); assert.match(codex, /Exit code: 1/); assert.match(codex, /one test failed/);
  assert.match(normalize('{"type":"turn.failed","error":{"message":"quota exceeded"}}', false).join('\n'), /Agent error.*\n.*Message: quota exceeded/);
  const future = normalize('{"type":"future.event","newField":{"deepValue":"kept"}}', true).join('\n');
  assert.match(future, /future.event/); assert.match(future, /Deep Value: kept/);
  const path = join(tmpDir('friendly-transcript'), 'stdout'); writeFileSync(path, event + '\n');
  const reader = new TranscriptReader();
  assert.equal(reader.latest(path), 'final report: Decision: revise · Handle empty input.');
  assert.match(reader.read(path, null, true, true).lines.join('\n'), /Decision: revise/);
  assert.equal(reader.read(path, null, false, false).lines[0], event, 'raw data stays available without projection');
});

test('detail raw toggle preserves source, links and search; recorded result opens at the beginning', () => {
  const ui = new ViewState(); const d = observed();
  const source = entry('spec', { acceptance: [{ id: 'A1', clause: 'Find matching pages.' }], serves: ['V-1'] });
  source.links = ['V-1'];
  ui.accept({ ...d, estate: [source, entry('V-1', { text: 'Make search useful.' })] });
  ui.view = 2; ui.open();
  assert.match(ui.render(80, 24, false).join('\n'), /Acceptance criteria/);
  ui.query = 'matching'; ui.jumpMatch(1, 7, true); assert.match(ui.render(80, 24, false).join('\n'), /matching pages/); ui.query = '';
  ui.key('', 'r', 10); assert.match(ui.render(80, 24, false).join('\n'), /"acceptance":/);
  assert.equal(ui.detail!.body, source.body);
  ui.key('', 'r', 10); ui.key('tab', '', 10); ui.open(); assert.equal(ui.detail!.id, 'V-1');
  ui.key('escape', '', 10); assert.equal(ui.detail!.id, 'spec');
  ui.detail = null; ui.logRequest = { inv: 'test', source: 'runner.log', expanded: false, before: null };
  ui.offset = 30; ui.key('', 's', 10);
  assert.equal(ui.logRequest.source, 'result'); assert.equal(ui.follow, false); assert.equal(ui.offset, 0);
  ui.key('', 'r', 10); assert.equal(ui.logRequest.raw, true);
  ui.key('', 's', 10); assert.equal(ui.logRequest.source, 'prompt'); assert.equal(ui.follow, false);
  ui.key('', 's', 10); assert.equal(ui.logRequest.source, 'transcript'); assert.equal(ui.logRequest.raw, false); assert.equal(ui.follow, true);
});


test('Markdown headings, inline styles, tasks, quotes and fenced code render as inert readable content', () => {
  const source = '# Architecture\n\nUse **strong words** and `literal_code` with [API](https://example.test/api).\n\n- [x] Ready\n  - Nested item\n1. First step\n> A *quoted* observation\n\n```ts\nconst value = "**literal**";\n  keepIndent();\n```\n';
  for (const columns of [75, 115]) {
    const rows = markdown(source, columns, false); const text = rows.map(plain).join('\n');
    assert.match(text, /^Architecture/); assert.doesNotMatch(text, /^# Architecture/);
    assert.ok(rows[0]!.every((span) => span.bold && span.tone === 'accent'));
    assert.ok(rows.some((row) => row.some((span) => span.bold && span.text.includes('strong words'))));
    assert.match(text, /literal_code/); assert.match(text, /API \(https:\/\/example.test\/api\)/);
    assert.match(text, /\[x\] Ready/); assert.match(text, /  • Nested item/); assert.match(text, /1\. First step/);
    assert.match(text, /│ A quoted observation/);
    assert.match(text, /const value = "\*\*literal\*\*";/); assert.match(text, /│   keepIndent\(\);/);
    assert.ok(rows.every((row) => width(plain(row)) <= columns));
  }
  const escaped = markdown('\\*literal\\* \x1b]52;c;bad\x07\x1b[2J', 75, true).map(plain).join('\n');
  assert.equal(escaped.trim(), '*literal*');
  const long = markdown('**' + 'readable words '.repeat(50) + '**', 75, false);
  assert.ok(long.length > 1); assert.ok(long.every((row) => row.every((span) => span.bold)));
  assert.ok(long.every((row) => row.length < 4), 'styled wrapping coalesces adjacent spans');
});

test('Markdown tables wrap cells and convert wide tables to labelled records without hiding columns', () => {
  const table = '| Name | Description |\n| --- | --- |\n| Search | ' + 'Find useful pages '.repeat(15) + ' |\n| Literal | `a|b` and escaped \\| pipe |';
  for (const columns of [75, 115]) {
    const rows = markdown(table, columns, false); const text = rows.map(plain).join('\n');
    assert.ok(rows.every((row) => width(plain(row)) <= columns));
    assert.match(text, /Name.*Description/); assert.match(text, /Find useful pages/);
    assert.match(text, /a\|b and escaped \| pipe/);
    for (const word of ['Find', 'useful', 'pages']) assert.equal(text.split(/\W+/).filter((part) => part === word).length, 15, 'wrapping preserves every word');
  }
  const wide = '| A | B | C | D | E | F | G | H |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| one | two | three | four | five | six | seven | last-value |';
  const narrow = markdown(wide, 75, true).map(plain).join('\n');
  assert.match(narrow, /A: one/); assert.match(narrow, /H: last-value/);
  assert.match(documentLines('{"decision":"approve"}', 75, false).map(plain).join('\n'), /Decision: approve/);
});

test('Markdown estate keeps raw source, searchable text and navigation at both supported sizes', () => {
  const ui = new ViewState(); const d = observed();
  const body = '# System overview\n\nUse **durable records** for recovery.\n\n- Keep provenance\n- Preserve links';
  const doc = { ...entry('architecture', {}), label: 'Architecture', body };
  ui.accept({ ...d, estate: [doc] }); ui.view = 2; ui.open();
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const text = ui.render(w!, h!, false).join('\n');
    assert.match(text, /System overview/); assert.match(text, /Use durable records/); assert.doesNotMatch(text, /\*\*durable records\*\*/);
    assert.match(text, /CLAUDE ACCOUNT/); assert.match(text, /Week/);
  }
  ui.query = 'use durable'; ui.jumpMatch(1, 7, true); assert.match(ui.render(80, 24, false).join('\n'), /durable records/); ui.query = '';
  ui.key('', 'r', 8); assert.match(ui.render(80, 24, false).join('\n'), /\*\*durable records\*\*/);
  assert.equal(ui.detail!.body, body);
});


test('unit navigation names status, specification, plan and input destinations, and restores the complete return location', () => {
  const d = observed();
  const planner: Invocation = { ...entry('planner', {}), label: 'root / planCheck', unit: 'root', role: 'planCheck', attempt: 2, session: 'session', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', quietMs: null, latest: '' };
  d.invocations = [planner];
  const ui = new ViewState(); ui.accept(d); ui.query = 'root'; ui.open();
  assert.equal(ui.detail!.kind, 'unit-status'); assert.equal(ui.query, '');
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const frame = ui.render(w!, h!, false);
    assert.match(frame.join('\n'), /Unit status: root/);
    assert.match(frame.join('\n'), /\[Status\].*Related documents/);
    assert.match(frame.at(-1)!, /←→\/Tab tab.*Esc back.*q quit/);
  }
  ui.key('right', '', 7);
  const related = ui.related();
  assert.deepEqual(related.slice(0, 4).map((row) => row.label), ['Unit specification: root', 'Implementation plan: root (unavailable)', 'Arc execution plan', 'Recorded arc intent']);
  assert.ok(related.some((row) => row.label.startsWith('Contract:')));
  assert.ok(related.some((row) => row.label === 'Plan-check input · attempt 2'));
  assert.match(ui.render(80, 24, false).join('\n'), /Open: Unit specification: root/);
  ui.open(); assert.equal(ui.detail!.kind, 'specification'); assert.equal(ui.pane, 0);
  ui.key('escape', '', 7); assert.equal(ui.detail!.kind, 'unit-status'); assert.equal(ui.pane, 1); assert.equal(ui.linkIndex, 0);
  ui.key('down', '', 7); ui.open(); assert.equal(ui.detail!.kind, 'implementation-plan');
  assert.match(ui.detail!.body, /No settled implementation plan|"unit": "root"/);
  ui.key('escape', '', 7); assert.equal(ui.linkIndex, 1); assert.equal(ui.pane, 1);
  ui.linkIndex = related.findIndex((row) => row.id === 'input:planner'); ui.open();
  assert.equal(ui.detail, null); assert.equal(ui.logRequest!.source, 'prompt');
  assert.equal(ui.follow, false); assert.equal(ui.logRequest!.after, 0); assert.equal(ui.logRequest!.before, PAGE_BYTES);
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const frame = ui.render(w!, h!, false).join('\n');
    assert.match(frame, /Messages.*Output.*Stderr.*Runner.*Result.*\[Input\]/);
    assert.match(frame, /Esc: Unit status: root/);
  }
  ui.key('escape', '', 7); assert.equal(ui.pane, 1); assert.equal(ui.related()[ui.linkIndex]!.id, 'input:planner');
  ui.key('escape', '', 7); assert.equal(ui.detail, null); assert.equal(ui.query, 'root'); assert.equal(ui.selection()!.id, 'root');
  const intent = d.estate.find((row) => row.id === 'intent:arc')!;
  assert.match(intent.body, /does not retain the original planning conversation/);
  assert.match(intent.provenance, /revision .* sha256/);
});

test('filters, help and source tabs act locally and preserve the underlying navigation state', () => {
  const ui = new ViewState(); ui.accept(observed()); ui.open(); ui.offset = 5;
  ui.key('', '/', 7); ui.key('', 'absent', 7); ui.key('escape', '', 7);
  assert.equal(ui.query, ''); assert.equal(ui.offset, 5);
  ui.key('right', '', 7); ui.key('', '/', 7); ui.key('', 'implementation', 7); ui.key('return', '', 7);
  assert.ok(ui.related().length > 1); assert.match(ui.related()[ui.linkIndex]!.label, /Implementation plan/); ui.open(); assert.equal(ui.query, '');
  ui.key('escape', '', 7); assert.equal(ui.query, 'implementation'); assert.equal(ui.pane, 1);
  ui.key('escape', '', 7); assert.equal(ui.query, ''); assert.ok(ui.detail);
  ui.key('backtab', '', 7); assert.equal(ui.pane, 0);
  ui.logRequest = { inv: 'test', source: 'transcript', before: 100, after: 0, expanded: false }; ui.detail = null;
  ui.follow = false; ui.query = 'message'; ui.offset = 4;
  const location = ui.location(); ui.key('', '?', 7); ui.key('down', '', 7);
  ui.key('right', '', 7); ui.key('', 'f', 7); ui.key('', '2', 7);
  assert.equal(ui.help, true); assert.equal(ui.view, 1); assert.equal(ui.logRequest.source, 'transcript'); assert.equal(ui.follow, false);
  ui.key('escape', '', 7); assert.deepEqual(ui.location(), location);
  ui.key('backtab', '', 7); assert.equal(ui.logRequest.source, 'prompt'); assert.equal(ui.query, '');
  assert.equal(ui.follow, false); assert.equal(ui.logRequest.after, 0);
  ui.key('tab', '', 7); assert.equal(ui.logRequest.source, 'transcript'); assert.equal(ui.follow, true);
});


test('repair input is distinguished from the original prompt and linked only through a recorded session', () => {
  const d = observed();
  const initial: Invocation = { ...entry('initial', {}), label: 'root / planCheck', unit: 'root', role: 'planCheck', attempt: 1, inputKind: 'initial', session: 'recorded-session', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', quietMs: null, latest: '' };
  const repair: Invocation = { ...initial, id: 'repair', label: 'root / planCheck / repair', inputKind: 'repair', startedAt: '2026-01-01T00:02:00Z' };
  const unrelated: Invocation = { ...initial, id: 'other-session', session: 'different', startedAt: '2025-01-01T00:00:00Z' };
  d.invocations = [repair, unrelated, initial];
  assert.equal(originalInput(repair, d)!.id, initial.id);
  assert.equal(originalInput({ ...repair, session: '' }, d), null);
  assert.equal(originalInput(repair, { ...d, invocations: [repair, unrelated] }), null);
  const ui = new ViewState(); ui.accept(d); ui.open(); ui.key('right', '', 7);
  assert.equal(ui.related().find((r) => r.label === 'Plan-check input · attempt 1')!.id, 'input:initial');
  assert.match(ui.related().find((r) => r.id === 'input:repair')!.label, /repair prompt/);
  ui.linkIndex = ui.related().findIndex((r) => r.id === 'input:repair'); ui.open();
  ui.acceptLog({ key: 'repair', start: 0, end: 30, size: 30, lines: ['Your answer was refused: return a corrected answer.'], error: null }, 7);
  const frame = ui.render(80, 24, false).join('\n');
  assert.match(frame, /Repair prompt/); assert.match(frame, /b original input/); assert.match(frame, /r raw/);
  ui.key('', 'b', 7); assert.equal(ui.logRequest!.inv, initial.id); assert.equal(ui.logRequest!.after, 0);
  ui.key('escape', '', 7); assert.equal(ui.logRequest!.inv, repair.id);
  ui.key('left', '', 7); assert.equal(ui.logRequest!.source, 'result');
  ui.key('', 'm', 7); assert.equal(ui.logRequest!.source, 'transcript'); assert.equal(ui.logRequest!.raw, false);
});

test('prompt projection formats Markdown and XML envelopes, preserves unknown markup and code, and offers exact raw input', () => {
  const prompt = '<documents>\n<document index="1">\n<source>spec.json for demo &amp; tests</source>\n<document_content>\n# Acceptance\n- **Keep** `literal` text.\n```xml\n<source>literal code</source>\n```\n<custom unknown="yes">kept</custom>\n</document_content>\n</document>\n</documents>\n<scope_envelope>\n{"scope":["src/**"],"resources":[]}\n</scope_envelope>\n<risk_floor>med</risk_floor>';
  for (const ascii of [false, true]) {
    const rendered = promptLines(prompt, 75, ascii); const text = rendered.map(plain).join('\n');
    assert.match(text, /Document 1/);
    assert.match(text, /Source: spec.json for demo & tests/); assert.match(text, /Acceptance/);
    assert.match(text, /Scope envelope/); assert.match(text, /src\/\*\*/); assert.match(text, /Risk floor: med/);
    assert.match(text, /<source>literal code<\/source>/); assert.match(text, /<custom unknown="yes">kept<\/custom>/);
    assert.doesNotMatch(text, /<documents>|<document_content>|"resources":/);
    assert.ok(rendered.every((row) => width(plain(row)) <= 75));
    assert.ok(rendered.some((row) => row.some((part) => part.bold && part.text.includes('Acceptance'))));
  }
  const ui = new ViewState(); ui.logRequest = { inv: 'input', source: 'prompt', before: PAGE_BYTES, after: 0, expanded: false }; ui.follow = false;
  ui.acceptLog({ key: 'input', start: 0, end: prompt.length, size: prompt.length, lines: prompt.split('\n'), error: null }, 7);
  assert.match(ui.logLines().join('\n'), /Document 1/);
  ui.key('', 'r', 7); assert.equal(ui.logRequest.raw, true);
  ui.acceptLog({ key: 'input', start: 0, end: prompt.length, size: prompt.length, lines: prompt.split('\n'), error: null }, 7);
  assert.match(ui.logLines().join('\n'), /<documents>/);
  ui.key('', 'r', 7); assert.equal(ui.logRequest.raw, false);
  ui.logRequest.source = 'stdout'; ui.key('', 'r', 7); assert.equal(ui.logRequest.raw, true);
  ui.key('tab', '', 7); assert.equal(ui.logRequest.raw, false, 'changing sources restores readable defaults');
  const fragment = promptLines('body from an earlier page\n</document_content>\n</document>\n<direction>\nContinue here', 75, false).map(plain).join('\n');
  assert.match(fragment, /body from an earlier page/); assert.match(fragment, /Intent\nContinue here/);
});


test('terminal width keeps text-presentation test symbols narrow and emoji wide, including Activity borders', () => {
  for (const symbol of ['✔', '✓', 'ℹ', '⚠', '©', '®', '™']) assert.equal(width(symbol), 1, symbol);
  for (const symbol of ['✔️', 'ℹ️', '⚠️', '🙂', '🇦🇺', '👩‍💻', '1️⃣', '界']) assert.equal(width(symbol), 2, symbol);
  assert.equal(width('ℹ tests 26'), 10); assert.equal(width('e\u0301'), 1); assert.equal(width('a\u200bb'), 2);
  const ui = new ViewState(); const d = observed();
  d.invocations = [{ ...entry('tests', {}), unit: 'catalog-summary', role: 'lane', attempt: 1, session: '', startedAt: d.at, endedAt: d.at, quietMs: 0, latest: 'ℹ tests 26 · ✔ all pass · ⚠ none' }];
  ui.accept(d);
  for (const columns of [80, 100, 120, 121, 180, 181]) {
    const frame = ui.render(columns, 35, false);
    const activity = frame.findIndex((row) => row.startsWith('╭') && row.includes('Activity'));
    assert.ok(activity >= 0);
    // These rows contain text-presentation glyphs only; code-point length is an independent cell oracle.
    const content = frame.slice(activity + 1).find((row) => row.includes('ℹ tests 26'))!;
    assert.ok(content); assert.equal([...content].length, columns - 1);
    assert.equal([...content].at(-1), '│');
  }
});

test('scrolling reuses formatted pages and unchanged worker snapshots without requesting observations', () => {
  const ui = new ViewState(); ui.follow = false; ui.pane = 1; ui.activityExpanded = true; ui.activityAll = true;
  ui.logRequest = { inv: 'long-report', source: 'result', before: null, expanded: false };
  const lines = Array.from({ length: 500 }, (_, i) => `Report ${i}: ${'Long report detail with words to wrap. '.repeat(4)}`);
  const page = { key: 'result', start: 0, end: 0, size: 0, lines, error: null };
  ui.acceptLog(page, 18); ui.renderFrame(120, 35, false);
  const frame = ui.logFrame(); const observation = ui.observationKey();
  for (let i = 0; i < 30; i++) {
    ui.key('down', '', 18); ui.renderFrame(120, 35, false);
    assert.equal(ui.logFrame(), frame, 'scrolling does not rewrap the report');
    assert.equal(ui.observationKey(), observation, 'scrolling needs no new file observation');
  }
  assert.equal(ui.offset, 30);
  ui.acceptLog({ ...page, lines: [...lines] }, 18);
  assert.equal(ui.logFrame(), frame, 'a cloned, unchanged worker publication preserves layout');
  ui.query = 'Report 42:'; ui.jumpMatch(1, 18, true);
  assert.equal(ui.logFrame(), frame, 'search keeps the full cached page');
  assert.match(plain(frame[ui.offset]!), /Report 42:/);
  assert.equal(ui.observationKey(), observation, 'filtering is local');
  ui.query = ''; ui.renderFrame(80, 24, true);
  const narrow = ui.logFrame(); assert.notEqual(narrow, frame); assert.equal(ui.logFrame(), narrow);
  const updated = [...lines]; updated[0] = 'changed result'; ui.acceptLog({ ...page, lines: updated }, 7);
  assert.notEqual(ui.logFrame(), narrow); assert.equal(ui.logLines()[0], 'changed result');
  ui.key('', 'r', 7); assert.notEqual(ui.observationKey(), observation);
  ui.logRequest = { inv: 'stream', source: 'stdout', before: 65536, after: 0, expanded: false };
  ui.acceptLog({ key: 'stream', start: 0, end: 65536, size: 131072, lines: ['last row'], error: null }, 7);
  ui.offset = 0; const beforePage = ui.observationKey(); ui.key('down', '', 7);
  assert.notEqual(ui.observationKey(), beforePage, 'crossing a page boundary still requests new content');
});


test('dependency tracks show forward branches, joins and crossings with aligned named nodes', () => {
  const d = observed();
  const node = (id: string, from: string[]) => ({ ...entry(id, {}), from, depth: 0, members: [] });
  const nodes = [node('root', []), node('a', ['root']), node('b', ['root']), node('c', ['root']), node('join', ['a', 'c']), node('tail', ['b'])];
  const drawing = dependencyDrawing(nodes, d, 'join', false, 60);
  const rows = drawing.rows.map(plain); const text = rows.join('\n');
  assert.match(text, /├─┬─┐/); assert.match(text, /├─╳─┘/);
  assert.equal(drawing.crossings, true); assert.equal(drawing.hiddenTracks, 0);
  assert.equal(drawing.positions.size, nodes.length);
  const labelColumns = nodes.map((n) => rows[drawing.positions.get(n.id)!]!.indexOf(n.id));
  assert.equal(new Set(labelColumns).size, 1, 'unit labels do not imply tree nesting');
  assert.ok(rows[drawing.positions.get('join')!]!.startsWith('▸ '));
  const ascii = dependencyDrawing(nodes, d, 'join', true, 60).rows.map(plain).join('\n');
  assert.doesNotMatch(ascii, /[│─┆║⇣⇓↓╳●]/); assert.match(ascii, /x/);
  const dense = dependencyDrawing(nodes, d, 'join', false, 35);
  assert.equal(dense.hiddenTracks, 2); assert.equal(dense.positions.size, nodes.length);
  assert.ok(dense.rows.map(plain).every((row) => row.includes('[+2]')));
  const filtered = dependencyDrawing([node('reading-time', ['word-count'])], d, 'reading-time', false, 75).rows.map(plain).join('\n');
  assert.match(filtered, /from word-count \[offscreen\]/); assert.match(filtered, /reading-time/);
  const longEdge = dependencyDrawing([node('root', []), node('middle', ['root']), node('end', ['root', 'middle'])], d, 'end', false, 60).rows.map(plain).join('\n');
  assert.match(longEdge, /├─┐/); assert.match(longEdge, /├─┘/, 'a dependency spanning another node stays connected');
});

test('dependency navigation selects nodes, preserves typed edges, and labels offscreen prerequisites', () => {
  const d = observed(); const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true;
  assert.deepEqual(ui.rows().map((row) => row.id), graph(d, true).map((row) => row.id));
  ui.key('down', '', 18); assert.equal(ui.selection()!.id, 'left');
  ui.key('down', '', 18); assert.equal(ui.selection()!.id, 'right');
  ui.key('down', '', 18); assert.equal(ui.selection()!.id, 'join');
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const frame = ui.render(w!, h!, false); assert.equal(frame.length, h);
    assert.ok(frame.every((row) => width(row) === w! - 1));
    assert.match(frame.join('\n'), /prerequisite to dependent/);
    assert.match(frame.join('\n'), /Waiting for: left/); assert.doesNotMatch(frame.join('\n'), /<- left|<- right/);
    if (w === 80) assert.match(frame.join('\n'), /\[offscreen\]/);
  }
  d.status = { ...d.status, edges: [...d.status.edges, { type: 'contingent', unit: 'left', edge: 'E-1', condition: 'approval', resolved: false }, { type: 'milestone', unit: 'join', milestone: 'M-1', passed: false }] as never,
    milestones: [{ id: 'M-1', passed: false, state: 'waiting', round: 0, walks: [], findings: [] }] as never };
  d.milestoneUnits['M-1'] = ['left', 'right'];
  const next = { ...d };
  const drawing = dependencyDrawing(graph(next, true), next, 'join', false, 90).rows.map(plain).join('\n');
  assert.match(drawing, /⇣/); assert.match(drawing, /⇓/);
  assert.match(drawing, /E-1.*condition/); assert.match(drawing, /M-1.*milestone/);
});

test('Overview prioritizes all retained activity for the map selection and preserves independent Activity navigation', () => {
  const d = observed(); const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true;
  const inv = (id: string, unit: string, running = false): Invocation => ({ ...entry(id, {}, running ? 'running' : 'failed'), unit, role: 'planCheck', attempt: 1, session: id,
    startedAt: d.at, endedAt: running ? null : d.at, quietMs: 0, latest: 'Recorded activity' });
  const recent = Array.from({ length: 20 }, (_, i) => inv(`recent-${i}`, 'right'));
  d.invocations = [inv('live-other', 'right', true), ...recent, inv('old-root', 'root'), inv('old-left', 'left')];
  assert.equal(ui.selection(0)!.id, 'root');
  assert.equal(ui.rows(1)[0]!.id, 'live-other');
  assert.equal(ui.rows(1)[1]!.id, 'old-root');
  assert.equal(ui.rows(1).length, 22, 'retains running and latest 20 unrelated completions');
  assert.equal(ui.selection(1)!.id, 'live-other');
  ui.key('tab', '', 18); ui.key('down', '', 18);
  assert.equal(ui.selection()!.id, 'old-root');
  ui.accept({ ...d, invocations: [...d.invocations] });
  assert.equal(ui.selection()!.id, 'old-root', 'polling does not move the cursor');
  ui.key('backtab', '', 18); ui.key('down', '', 18);
  assert.equal(ui.selection(0)!.id, 'left'); assert.equal(ui.selection(1)!.id, 'live-other');
  ui.key('tab', '', 18); ui.key('down', '', 18); ui.open(); assert.equal(ui.logRequest!.inv, 'old-left');
  ui.key('escape', '', 18); assert.equal(ui.selection()!.id, 'old-left');
  ui.key('', 'g', 18); ui.key('', 'x', 18);
  assert.equal(ui.rows()[0]!.id, 'live-other'); assert.equal(ui.rows().length, 21, 'All activity keeps running-first ordering and its recent history limit');
  assert.equal(ui.activityContext(), null);
});

test('map activity uses recorded unit, milestone and condition membership without matching neighbours or body text', () => {
  const d = observed(); const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true;
  d.status = { ...d.status, edges: [...d.status.edges, { type: 'contingent', unit: 'left', edge: 'E-1', condition: 'approval', resolved: false }] as never,
    milestones: [{ id: 'M-1', passed: false, state: 'walking', round: 1, walks: [{ job: 'walk-job', round: 1, outcome: null }], findings: [] }] as never };
  d.milestoneUnits['M-1'] = ['left', 'right'];
  d.invocations = ['root', 'left', 'right', 'join', 'walk-job', 'arc'].map((unit) => ({ ...entry(`inv-${unit}`, { text: 'left right M-1' }), unit, role: 'build', attempt: 1, session: '', startedAt: d.at, endedAt: null, quietMs: 0, latest: '' }));
  for (const [node, expected] of [['root', ['root']], ['E-1', ['left']], ['M-1', ['left', 'right', 'walk-job']]] as const) {
    ui.selected.set('1:0', node);
    assert.deepEqual([...ui.activityContext()!.invocations], expected.map((id) => `inv-${id}`));
  }
  d.status = { ...d.status, units: d.status.units.map((u) => ['root', 'left'].includes(u.unit) ? { ...u, state: 'merged' } : u) };
  ui.accept({ ...d }); ui.expandedGraph = false;
  assert.ok(graph(ui.display!, false).every((n) => !['root', 'left'].includes(n.id)));
  ui.key('', 'c', 18); ui.selected.set('1:0', 'root');
  assert.deepEqual([...ui.activityContext()!.invocations], ['inv-root']);
  assert.equal(ui.activityContext()!.label, 'root');
  assert.ok(ui.rows(0).some((n) => n.id === 'left'), 'full map retains settled members of open milestones');
});

test('Activity communicates map context in colour and monochrome at both terminal sizes, including no matches', () => {
  const d = observed(); const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true;
  d.invocations = ['left', 'root'].map((unit) => ({ ...entry(`inv-${unit}`, {}, 'failed'), unit, role: 'planCheck', attempt: 1, session: '', startedAt: d.at, endedAt: d.at, quietMs: 0, latest: 'Test failure' }));
  for (const ascii of [false, true]) for (const [w, h] of [[120, 35], [80, 24]] as const) {
    const frame = ui.renderFrame(w, h, ascii); const text = frame.map(plain).join('\n');
    assert.match(text, /Activity.*root/); assert.match(text, /\* 1 linked to map/); assert.match(text, /\* Run\s+root/);
    assert.ok(frame.every((row) => width(plain(row)) === w - 1));
    assert.equal(frame.length, h);
    assert.ok(frame.some((row) => row.some((s) => s.text.trim() === 'root' && s.bold && s.tone === 'accent')));
    if (w === 120) {
      assert.ok(frame.some((row) => row.some((s) => s.text.trim() === 'left' && s.tone === 'muted')));
      assert.ok(frame.some((row) => row.some((s) => s.text.includes('failed') && s.tone === 'fault')), 'unrelated faults keep their status colour');
    }
  }
  ui.selected.set('1:0', 'join');
  assert.match(ui.render(80, 24, false).join('\n'), /No recorded activity for map selection/);
  assert.equal(ui.rows(1).length, 2, 'no matches still shows other activity');
  ui.key('tab', '', 18); ui.query = 'root'; ui.jumpMatch(1, 18, true); assert.equal(ui.rows(1).length, 2);
  assert.equal(ui.selection()!.id, 'inv-root');
});


test('compact activity omits ambiguous attempt numbers; selection labels attempts and expanded Activity has models', () => {
  const d = observed(); const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true;
  d.invocations = [{ ...entry('recorded-invocation', {}), unit: 'root', role: 'lane:suite', attempt: 9,
    session: '', startedAt: d.at, endedAt: d.at, quietMs: 0, latest: 'All checks passed' }];
  for (const [w, h] of [[120, 35], [80, 24]] as const) {
    const text = ui.render(w, h, false).join('\n');
    assert.match(text, /lane:suite/); assert.doesNotMatch(text, /#9/);
  }
  ui.key('tab', '', 18);
  assert.match(ui.render(120, 35, false).join('\n'), /execution attempt 9/);
  ui.key('', 'g', 18); ui.key('', 'x', 18);
  const text = ui.render(120, 35, false).join('\n');
  assert.match(text, /MODEL/); assert.doesNotMatch(text, /#9|\bTRY\b/);
  assert.match(text, /execution attempt 9/);
});


test('one Activity browser preserves selection and filters across expansion, scope, logs and Estate', () => {
  const d = observed(); const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true;
  d.invocations = Array.from({ length: 28 }, (_, i) => ({ ...entry(`inv-${i}`, {}), execution: i % 2 ? 'agent' as const : 'command' as const,
    unit: i === 27 ? 'left' : 'root', role: 'build', attempt: i + 1, session: '', startedAt: d.at, endedAt: d.at, quietMs: 0, latest: 'recorded output' }));
  ui.key('tab', '', 18); ui.key('', 'a', 18); ui.move(15, 18);
  const selected = ui.selection()!.id; const ids = ui.rows().map((r) => r.id);
  ui.query = 'role:build'; ui.key('', 'x', 18);
  assert.equal(ui.activityExpanded, true); assert.equal(ui.selection()!.id, selected);
  assert.deepEqual(ui.rows().map((r) => r.id), ids); assert.equal(ui.query, 'role:build');
  assert.equal(ui.activityContext()!.id, 'root', 'activity filters do not change the map selection');
  ui.key('tab', '', 18); assert.equal(ui.section(), 2, 'Tab reaches Estate in the single navigation tier');
  ui.key('backtab', '', 18); assert.equal(ui.section(), 1); ui.key('', 'x', 18);
  ui.open(); assert.equal(ui.logRequest!.inv, selected);
  ui.key('escape', '', 18); assert.equal(ui.activityExpanded, true); assert.equal(ui.selection()!.id, selected); assert.equal(ui.query, 'role:build');
  ui.key('', 'x', 18); assert.equal(ui.activityExpanded, false); assert.equal(ui.selection()!.id, selected);
  ui.key('backtab', '', 18); assert.equal(ui.query, ''); assert.equal(ui.selection()!.id, 'root');
  ui.key('tab', '', 18); assert.equal(ui.query, 'role:build');
  ui.key('', 'g', 18); assert.equal(ui.activityAll, true); assert.equal(ui.activityContext(), null); assert.equal(ui.selection()!.id, selected);
  ui.key('', 'g', 18); assert.equal(ui.activityContext()!.id, 'root'); assert.equal(ui.selection()!.id, selected);
  ui.key('', '3', 18); assert.equal(ui.view, 2); assert.match(ui.render(80, 24, false).join('\n'), /Estate/);
  ui.key('', '1', 18); ui.key('tab', '', 18); assert.equal(ui.query, 'role:build'); assert.equal(ui.selection()!.id, selected);
  ui.key('', 'x', 18); ui.key('escape', '', 18); assert.equal(ui.query, ''); assert.equal(ui.activityExpanded, true);
  ui.key('escape', '', 18); assert.equal(ui.activityExpanded, false); assert.equal(ui.pane, 1);
});

test('Activity labels agent, command, queued and unavailable execution types in both layouts', () => {
  const d = observed(); const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true;
  d.invocations = ([undefined, 'agent', 'command'] as const).map((execution, i) => ({ ...entry(`inv-${i}`, {}), ...(execution ? { execution } : {}),
    unit: 'root', role: 'same-role', attempt: 1, session: '', startedAt: d.at, endedAt: null, quietMs: 0, latest: '' }));
  d.status = { ...d.status, commands: { ...d.status.commands, pending: [{ id: 'pending', type: 'resume' }] as never } };
  ui.key('tab', '', 18);
  for (const [w, h] of [[120, 35], [80, 24]] as const) for (const ascii of [false, true]) for (const expanded of [false, true]) {
    ui.activityExpanded = expanded;
    for (const [index, kind] of ['Run', 'Agent', 'Command', 'Queued'].entries()) {
      ui.selected.set('1:1', index === 3 ? 'command:pending' : `inv-${index}`);
      const frame = ui.render(w, h, ascii); const text = frame.join('\n');
      assert.match(text, new RegExp(kind)); assert.doesNotMatch(text, /Agents|Overview/);
      assert.match(text, /3 Estate/); assert.ok(frame.every((row) => width(row) === w - 1));
      if (expanded) assert.match(text, /Activity expanded/);
    }
  }
});


test('all-settled maps explain the full-map toggle while arc-wide activity remains independent', () => {
  const d = observed(); const ui = new ViewState();
  d.status = { ...d.status, units: d.status.units.map((u) => ({ ...u, state: 'merged' })) };
  d.invocations = [{ ...entry('flow-inv', {}), label: 'flow-1 / flow', unit: 'flow-1', role: 'flow', execution: 'agent', scope: 'arc', attempt: 1,
    session: '', startedAt: d.at, endedAt: d.at, quietMs: 0, latest: 'Arc coordination completed' }];
  ui.accept(d);
  assert.equal(ui.selection(), null);
  assert.equal(ui.activityContext(), null);
  const settledFrame = ui.render(120, 35, false).join('\n');
  assert.match(settledFrame, /All work settled.*c shows full map/);
  assert.match(settledFrame, /4 settled hidden/);
  ui.key('', 'c', 18); assert.equal(ui.rows().length, 4);
  assert.equal(ui.activityContext()!.invocations.has('flow-inv'), false);
  ui.key('', 'c', 18);
  ui.key('tab', '', 18);
  for (const [w, h] of [[120, 35], [80, 24]] as const) for (const expanded of [false, true]) {
    ui.activityExpanded = expanded;
    const frame = ui.render(w, h, false);
    assert.match(frame.join('\n'), /Arc-wide/); assert.match(frame.join('\n'), /flow-1/);
    assert.ok(frame.every((row) => width(row) === w - 1));
  }
  ui.open(); assert.match(ui.render(120, 35, false).join('\n'), /flow-1.*Arc-wide/);
  d.status = { ...d.status, units: d.status.units.map((u) => u.unit === 'root' ? { ...u, state: 'cut' } : u) };
  assert.deepEqual(graph({ ...d }, false), []);
  d.status = { ...d.status, edges: [...d.status.edges, { type: 'contingent', unit: 'root', edge: 'E-1', condition: 'ready', resolved: true }] as never };
  assert.deepEqual(graph({ ...d }, false), []);
  assert.equal(graph({ ...d }, true).length, 5);
});


test('Estate leads with explicit Vision and Arc slice absences, without treating intent as vision', () => {
  const d = observed(); const ui = new ViewState(); ui.accept(d); ui.key('', '3', 18);
  assert.deepEqual(ui.rows().slice(0, 3).map((e) => e.id), ['vision', 'arc-slice', 'plan']);
  for (const id of ['vision', 'arc-slice']) {
    const item = d.estate.find((e) => e.id === id)!;
    assert.equal(item.state, 'unavailable'); assert.match(item.label, /not recorded/);
    assert.match(item.body, /Not recorded for this run/); assert.match(item.provenance, /revision .*not recorded/);
    ui.selected.set('2:0', id); ui.open();
    assert.match(ui.render(80, 24, false).join('\n'), /Not recorded for this run/);
    ui.key('escape', '', 18);
  }
  assert.ok(d.estate.find((e) => e.id === 'intent:arc'));
});

test('Estate exposes retained structured vision and applied arc slice with provenance and clause links', async () => {
  const { d, planDir } = await setupCorpusArc([]);
  const r = contextFor(d);
  try {
    const before = contents(d.runDir);
    const entries = estate(r.ctx.runDir, r.journal.view, absPath(d.repo));
    assert.deepEqual(entries.slice(0, 3).map((e) => e.id), ['vision', 'arc-slice', 'plan']);
    const vision = entries[0]!; const slice = entries[1]!;
    assert.equal(vision.kind, 'vision'); assert.equal(vision.state, 'active'); assert.match(vision.body, /V-1/);
    assert.deepEqual(JSON.parse(slice.body).advances, ['V-1']);
    assert.match(vision.provenance, /revision .*sha256/); assert.match(slice.provenance, /revision .*sha256/);
    for (const id of ['vision', 'plan', 'phase0', 'V-1']) assert.ok(slice.links.includes(id), id);
    assert.ok(entries.find((e) => e.id === 'V-1')!.links.includes('arc-slice'));
    assert.equal(entries.find((e) => e.id === 'V-1')!.parentId, 'vision');
    assert.equal(entries.find((e) => e.id === 'I-1')!.parentId, 'obligations');
    assert.equal(entries.find((e) => e.id === 'design:u1')!.parentId, 'u1');
    assert.equal(entries.find((e) => e.id === 'corpus-guide')!.parentId, 'corpus');
    assert.equal(entries.find((e) => e.id === '.roadmap/constraints.md')!.parentId, 'rulings');
    writeFileSync(join(d.repo, '.roadmap/vision.json'), 'UNAPPLIED VISION');
    writeFileSync(d.planPath, 'UNAPPLIED PLAN');
    writeFileSync(join(planDir, 'phase0.json'), 'UNAPPLIED SLICE');
    assert.deepEqual(estate(r.ctx.runDir, r.journal.view, absPath(d.repo)), entries);
    assert.deepEqual(contents(d.runDir), before);
  } finally { r.journal.close(); }
});

test('Debt includes inherited dispositions and newly banked items before publication, with snapshot provenance', async () => {
  const baseline = parseDebtLedger({ schema: 'roadmap/debt-m4', items: [
    { id: 'B-1', originArc: 'prior-arc', bankReason: 'gate-note', what: 'Inherited maintenance cost', unit: 'u1', key: debtKey({ unit: unitId('u1'), bankReason: 'gate-note', what: 'Inherited maintenance cost' }), history: [], state: 'open' },
    { id: 'B-2', originArc: 'prior-arc', bankReason: 'gate-note', what: 'Previously resolved debt', unit: null, key: debtKey({ unit: null, bankReason: 'gate-note', what: 'Previously resolved debt' }), history: [], state: 'resolved' },
  ] });
  const { d } = await setupCorpusArc([], { baseline: { '.roadmap/debt.md': renderDebt(baseline) }, phase0: { debt: [{ id: 'B-1', disposition: { type: 'keep', reason: 'Deferred until next slice' } }] } });
  const r = contextFor(d);
  try {
    writeFileSync(join(d.runDir, 'start.json'), JSON.stringify({ v: 1, generation: 1, at: new Date().toISOString(), repo: d.repo, planFile: d.planPath, profile: 'default' }));
    const request: ObserveRequest = { locator: { type: 'host' }, hostDir: absPath(d.hostDir), pinned: { runDir: r.ctx.runDir, arc: arcId(d.arc) }, log: null, token: 1 };
    const observer = new Observer(); const first = observer.observe(request); assert.equal(first.error, null);
    assert.equal(first.display!.estate.find((e) => e.id === 'debt')!.label, 'Debt (1 open)');
    const banked = mintDebt(baseline, [], { type: 'gate-note', unit: unitId('u1'), attempt: 1, index: 0, what: 'New maintenance drag' })!;
    r.journal.fact(banked);
    const before = contents(d.runDir);
    const next = observer.observe(request); assert.equal(next.error, null);
    const entries = next.display!.estate;
    assert.equal(entries.find((e) => e.id === 'debt')!.label, 'Debt (2 open)', 'banking invalidates the estate cache before publication');
    const item = entries.find((e) => e.id === 'B-3')!;
    assert.match(item.body, /New maintenance drag/); assert.ok(item.links.includes('u1')); assert.ok(item.links.includes('debt'));
    assert.match(item.provenance, /baseline .*revision .*phase0 sha256 .*journal seq/);
    assert.match(entries.find((e) => e.id === 'B-1')!.body, /Deferred until next slice/);
    assert.doesNotMatch(entries.find((e) => e.id === '.roadmap/debt.md')!.body, /New maintenance drag/);
    assert.deepEqual(entries.filter((e) => e.kind === 'debt-item').map((e) => ({ id: e.id, state: e.state })), next.display!.status.debt!.ledger.map((e) => ({ id: e.id, state: e.state })));
    const ui = new ViewState(); ui.accept(next.display!); ui.key('', '3', 18);
    ui.selected.set('2:0', 'debt'); ui.key('space', ' ', 18);
    assert.ok(!ui.rows().some((e) => e.id === 'B-2')); ui.key('', 'w', 18); assert.ok(ui.rows().some((e) => e.id === 'B-2'));
    writeFileSync(join(d.repo, '.roadmap/debt.md'), 'UNAPPLIED DEBT');
    git(d.repo, 'add', '.roadmap/debt.md'); git(d.repo, 'commit', '-m', 'outside the observed snapshot');
    assert.deepEqual(estate(r.ctx.runDir, r.journal.view, absPath(d.repo)), entries);
    assert.deepEqual(contents(d.runDir), before);
  } finally { r.journal.close(); }
});

test('Debt distinguishes no record from an empty recorded ledger', async () => {
  const missing = observed().estate.find((e) => e.id === 'debt')!;
  assert.equal(missing.state, 'unavailable'); assert.match(missing.body, /Not recorded for this run/);
  const { d } = await setupCorpusArc([]); const r = contextFor(d);
  try {
    const empty = estate(r.ctx.runDir, r.journal.view, absPath(d.repo)).find((e) => e.id === 'debt')!;
    assert.equal(empty.label, 'Debt (0 open)'); assert.equal(empty.state, 'active'); assert.match(empty.body, /No debt recorded/);
  } finally { r.journal.close(); }
});

test('one navigation tier cycles map, Activity, Estate and Exceptions, preserving each selection', () => {
  const ui = new ViewState(); ui.accept(observed());
  for (let section = 0; section < 4; section++) {
    assert.equal(ui.section(), section);
    for (const [w, h] of [[80, 24], [120, 35]] as const) {
      const frame = ui.render(w, h, false); const labels = ['1 Dependency map', '2 Activity', '3 Estate', '4 Exceptions'];
      for (const label of labels) assert.ok(frame[1]!.includes(label));
      assert.ok(frame[1]!.includes(`[${labels[section]}]`)); assert.doesNotMatch(frame[9]!, /\[Dependency map\]|\[Activity\]|\[Estate\]/);
      assert.ok(frame.every((row) => width(row) === w - 1));
    }
    ui.key('tab', '', 18);
  }
  assert.equal(ui.section(), 0); ui.key('backtab', '', 18); assert.equal(ui.section(), 3);
  ui.key('', '3', 18); ui.move(2, 18); const estateSelection = ui.selection()!.id;
  ui.key('', '1', 18); ui.key('right', '', 18); assert.equal(ui.section(), 1);
  ui.key('right', '', 18); assert.equal(ui.section(), 2); assert.equal(ui.selection()!.id, estateSelection);
});

test('search jumps without filtering, cycles and wraps, and preserves a paused transcript viewport', () => {
  const ui = new ViewState(); ui.accept(observed()); ui.key('', '3', 18);
  const ids = ui.rows().map((e) => e.id);
  ui.key('', '/', 18); ui.key('', 'recorded', 18); ui.key('return', '', 18);
  assert.deepEqual(ui.rows().map((e) => e.id), ids); assert.match(ui.searchFeedback, /Match 1\//);
  const first = ui.selection()!.id; ui.key('', 'n', 18); assert.notEqual(ui.selection()!.id, first);
  ui.key('', 'N', 18); assert.equal(ui.selection()!.id, first);
  ui.key('', '/', 18); ui.key('', 'not-found-anywhere', 18); ui.key('return', '', 18);
  assert.equal(ui.selection()!.id, first); assert.equal(ui.searchFeedback, 'No matches');
  ui.key('escape', '', 18); assert.equal(ui.query, ''); assert.deepEqual(ui.rows().map((e) => e.id), ids);
  ui.logRequest = { inv: 'stream', source: 'transcript', before: null, expanded: false }; ui.detail = null;
  const lines = Array.from({ length: 40 }, (_, i) => i === 5 || i === 25 ? `needle ${i}` : `context ${i}`);
  ui.acceptLog({ key: 'stream', start: 0, end: 100, size: 100, lines, error: null }, 7);
  ui.key('', '/', 7); ui.key('', 'needle', 7); ui.key('return', '', 7);
  assert.equal(ui.follow, false); assert.equal(ui.offset, 5); assert.equal(ui.logLines().length, 40);
  const observation = ui.observationKey();
  ui.key('', 'n', 7); assert.equal(ui.offset, 25); ui.key('', 'n', 7); assert.equal(ui.offset, 5);
  assert.equal(ui.observationKey(), observation); assert.match(ui.searchFeedback, /in page/);
  ui.key('escape', '', 7); assert.equal(ui.offset, 5); assert.ok(ui.logRequest);
  ui.key('', 'f', 7); assert.equal(ui.follow, true);
});

test('model annotations use recorded launch/init metadata and explicit adapters, including partial and replaced streams', () => {
  const path = join(tmpDir('tui-model'), 'stdout'); const reader = new ModelReader();
  const launch = { argv: ['codex', 'exec', '--model', 'requested-model'], terminal: { type: 'backend', session: { backend: 'codex' } } } as unknown as LaunchFile;
  assert.equal(reader.read(launch, path).model, 'requested-model', 'pruned output retains explicit launch choice');
  assert.deepEqual(reader.read({ terminal: { type: 'command' } } as LaunchFile, path), {});
  writeFileSync(path, '{"type":"system","subtype":"init","model":"actual');
  assert.equal(reader.read(launch, path).model, 'requested-model');
  appendFileSync(path, '-model"}\n'); assert.equal(reader.read(launch, path).model, 'actual-model');
  appendFileSync(path, 'large ongoing output\n'.repeat(10000)); assert.equal(reader.read(launch, path).model, 'actual-model');
  writeFileSync(path + '.new', JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-role-model', adapter_metadata: { name: 'Codex-as-Claude', backend: 'codex', model: 'gpt-6.1-sol' } }) + '\n');
  renameSync(path + '.new', path);
  assert.deepEqual(reader.read(launch, path), { model: 'gpt-6.1-sol', backend: 'codex', adapter: 'Codex-as-Claude', requestedModel: 'requested-model' });
  writeFileSync(path, ''); assert.equal(reader.read(null, path).model, undefined);
  assert.equal(reader.read({ ...launch, argv: ['claude', '--model=explicit'] }, path).model, 'explicit');
});

test('open milestones remain visible after passing a gate, retain overlapping membership, and follow replacement units', () => {
  const d = observed(); const ui = new ViewState();
  d.milestoneUnits = { 'MS-1': ['root', 'left'], 'MS-2': ['left', 'join'] };
  d.status = { ...d.status, milestones: [
    { id: 'MS-1', state: 'polishing', passed: true, round: 1, walks: [], findings: [] },
    { id: 'MS-2', state: 'settled', passed: true, round: 1, walks: [], findings: [] },
  ] as never, units: d.status.units.map((u) => ({ ...u, state: 'merged', ...(u.unit === 'root' ? { state: 'superseded', supersededBy: unitId('right') } : {}) })) };
  d.estate.push({ ...entry('MS-1', { units: ['root', 'left'] }), kind: 'milestone', description: 'Article experience' });
  const full = graph(d, true); assert.match(full.find((n) => n.id === 'left')!.label, /\[MS-1, MS-2\]/);
  assert.deepEqual(full.find((n) => n.id === 'MS-1')!.from, ['right', 'left']);
  assert.match(full.find((n) => n.id === 'MS-1')!.label, /polishing.*2\/2 units merged/);
  const open = graph(d, false); assert.ok(open.some((n) => n.id === 'MS-1')); assert.ok(!open.some((n) => n.id === 'MS-2'));
  ui.accept(d); ui.key('', 'm', 18); assert.equal(ui.selection()!.id, 'MS-1'); ui.open();
  assert.ok(ui.related().some((n) => n.id === 'MS-1'), 'status links to milestone definition');
  for (const [w,h] of [[120,35],[80,24]]) { const frame = ui.renderFrame(w!,h!,false); assert.equal(frame.length,h); assert.ok(frame.every((r) => width(plain(r)) === w! - 1)); }
});

test('execution summary counts arc-wide work and explains idle holds without treating ownership as activity', () => {
  const d = observed(); d.status = { ...d.status, run: { ...d.status.run, state: 'running', owner: { state: 'alive', pid: 1, generation: 1 } } as never,
    needsUser: [{ id: 'nu-1', reason: 'pack-review', blocking: true }] as never, holds: ['pack-review'] };
  assert.equal(executionSummary(d).state, 'waiting'); assert.match(executionSummary(d).detail, /No active work.*pack-review.*4 Exceptions/);
  d.invocations = [{ ...entry('review', {}, 'running'), unit: 'review-1', role: 'packReview', execution: 'agent', model: 'gpt-6.1-sol', attempt: 1, session: '', startedAt: d.at, endedAt: null, quietMs: 0, latest: '' }];
  assert.equal(executionSummary(d).state, 'running'); assert.match(executionSummary(d).counts, /1 agent · 0 commands/); assert.match(executionSummary(d).detail, /review-1 \/ packReview/);
  const ui = new ViewState(); ui.accept(d);
  for (const [w,h] of [[120,35],[80,24]]) { const text = ui.render(w!,h!,false).join('\n'); assert.match(text, /1 agent/); assert.match(text, /gpt-6.1-sol/); assert.match(text, /Active: review-1/); }
});

test('arc witness commands link through the obligation revision and lane hash, never a job or lane name guess', async () => {
  const { d, planDir, baseline } = await setupCorpusArc([]);
  const file = join(planDir, 'obligations.json'); const ob = JSON.parse(readFileSync(file,'utf8'));
  ob.obligations[0].deliveredBy = ['u1']; ob.obligations[0].activation = 'future'; writeFileSync(file, JSON.stringify(ob));
  const r = contextFor(d); r.journal.close(); const events = [...readJournal(absPath(d.runDir), arcId(d.arc)).events];
  const lane = parseObligations(ob).lanes[0]!;
  const launch = (op: string, laneRev: string) => ({ type: 'intent', kind: 'proc.spawn', op, ordinal: 1, expect: { subject: { purpose: 'journey', owner: { type: 'job', job: 'baseline-1' }, lane: lane.id, laneRev, at: baseline } } }) as never;
  const relations = new InvocationRelations();
  const linked = relations.read(absPath(d.runDir), [...events, launch('arc/10', laneRevOf(lane)), launch('arc/11', 'wrong-revision')]);
  assert.deepEqual(linked.get('arc/10#1')?.relatedUnits, ['u1']); assert.match(linked.get('arc/10#1')!.context!, /Baseline witness check.*I-1 → u1.*before delivery/);
  assert.equal(linked.has('arc/11#1'), false);
  const witness = { lane: lane.id, laneRev: laneRevOf(lane), envId: '0123456789abcdef', treeSha: '1'.repeat(40), inv: 'arc/10#1', purpose: 'witness' };
  const record = { v: 1, ...witness, runner: lane.reporter, malformed: false, records: [{ testId: 't1', selected: 1, outcome: 'fail' }] };
  const bytes = JSON.stringify(record);
  const fact = { kind: 'witnessed', ...witness, for: { type: 'job', job: 'baseline-1' }, recordsSha256: sha256Hex(bytes) };
  const dir = witnessDir(absPath(d.runDir), { ...fact, seq: 20 } as never); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'witness.json'), bytes);
  const baselineLaunch = { type: 'intent', kind: 'proc.spawn', op: 'arc/10', ordinal: 1, expect: { subject: { purpose: 'journey', owner: { type: 'job', job: 'baseline-1' }, lane: lane.id, laneRev: laneRevOf(lane), at: baseline } } };
  const proven = [...events, baselineLaunch, { type: 'fact', seq: 20, fact }, { type: 'fact', seq: 21, fact: { kind: 'series-certified', at: baseline, parent: { type: 'job', job: 'baseline-1' } } }] as unknown as typeof events;
  assert.equal(relations.read(absPath(d.runDir), proven).get('arc/10#1')!.assessment, 'baseline-red');
  const latched = { type: 'fact', fact: { kind: 'obligation-latched', obligation: 'I-1' } };
  assert.equal(relations.read(absPath(d.runDir), [...events, latched, ...proven.slice(events.length)] as never).get('arc/10#1')!.assessment, undefined, 'a latched future obligation is now must-hold');
  const otherJob = { ...baselineLaunch, expect: { subject: { ...baselineLaunch.expect.subject, owner: { type: 'job', job: 'audit-1' } } } };
  assert.doesNotMatch(relations.read(absPath(d.runDir), [...events, otherJob] as never).get('arc/10#1')!.context!, /Baseline/, 'a check on the same commit is not necessarily the baseline job');
  const auditFact = { ...fact, for: { type: 'job', job: 'audit-1' } };
  const auditDir = witnessDir(absPath(d.runDir), { ...auditFact, seq: 20 } as never);
  mkdirSync(auditDir, { recursive: true }); writeFileSync(join(auditDir, 'witness.json'), bytes);
  const repeat = { ...otherJob, op: 'arc/11' };
  const laterTree = { ...otherJob, op: 'arc/12', expect: { subject: { ...otherJob.expect.subject, at: '2'.repeat(40) } } };
  const audited = [...events, otherJob, repeat, laterTree, { type: 'fact', seq: 20, fact: auditFact },
    { type: 'fact', seq: 21, fact: { kind: 'series-certified', at: baseline, parent: { type: 'job', job: 'audit-1' } } }] as unknown as typeof events;
  const auditResults = relations.read(absPath(d.runDir), audited);
  for (const id of ['arc/10#1', 'arc/11#1']) assert.equal(auditResults.get(id)!.assessment, 'future-gap', 'audit and confirmation rerun checked a future requirement before delivery');
  assert.equal(auditResults.get('arc/12#1')!.assessment, undefined, 'evidence from an earlier tree cannot classify a later check');
  assert.equal(relations.read(absPath(d.runDir), [...audited, latched] as never).get('arc/10#1')!.assessment, 'future-gap', 'later delivery preserves historical check context');
  assert.equal(relations.read(absPath(d.runDir), [...events, latched, ...audited.slice(events.length)] as never).get('arc/10#1')!.assessment, undefined, 'failure after delivery is a regression, not a future gap');
  const candidate = { ...otherJob, expect: { subject: { ...otherJob.expect.subject, owner: { type: 'unit', unit: 'u1' } } } };
  assert.equal(relations.read(absPath(d.runDir), [...events, candidate, ...audited.slice(events.length + 3)] as never).get('arc/10#1')!.assessment, undefined, 'candidate checks must prove the proposed delivery');
  writeFileSync(join(auditDir, 'witness.json'), '{}');
  assert.equal(relations.read(absPath(d.runDir), audited).get('arc/10#1')!.assessment, undefined, 'audit assessment also requires intact witness evidence');


  assert.equal(relations.read(absPath(d.runDir), [...events, baselineLaunch] as never).get('arc/10#1')!.assessment, undefined, 'no assumption before witness evidence');
  writeFileSync(join(dir,'witness.json'), '{}');
  assert.equal(relations.read(absPath(d.runDir), proven).get('arc/10#1')!.assessment, undefined, 'corrupt evidence never suppresses a fault');
  rmSync(join(dir,'witness.json'));
  assert.equal(relations.read(absPath(d.runDir), proven).get('arc/10#1')!.assessment, undefined, 'pruned evidence remains unknown');
  const mutation = { type: 'intent', kind: 'proc.spawn', op: 'arc/30', ordinal: 1, expect: { subject: { purpose: 'mutant', of: { type: 'smoke', unit: 'u1', attempt: 7 }, lane: lane.id } } };
  for (const [kind, assessment] of [['killed','mutation-caught'],['survived','mutation-survived'],['inconclusive','mutation-inconclusive']] as const) {
    const verdict = { killed: [], survived: [], inconclusive: [], [kind]: [{ lane: lane.id, testId: 't1' }] };
    const result = relations.read(absPath(d.runDir), [...events, mutation, { type:'fact', fact: { kind:'smoke-ran', unit:'u1', attempt:7, verdict } }] as never);
    assert.equal(result.get('arc/30#1')!.assessment, assessment); assert.deepEqual(result.get('arc/30#1')!.relatedUnits,['u1']);
  }

  const display = observed(); display.invocations = [{ ...entry('witness',{},'fail'), ...linked.get('arc/10#1'), relatedUnits: ['root'], unit: 'baseline-1', role: 'journey', attempt: 1, session: '', startedAt: display.at, endedAt: display.at, quietMs: 0, latest: '' }];
  const ui = new ViewState(); ui.accept(display); assert.ok(ui.activityContext()!.invocations.has('witness'));
  ui.selected.set('1:0','left'); assert.equal(ui.activityContext()!.invocations.size,0);
});

test('purpose verdicts distinguish baseline gaps and caught mutants from real process failures', () => {
  const inv: Invocation = { ...entry('probe', {}, 'fail'), unit: 'root', role: 'journey', attempt: 1, session: '', startedAt: '', endedAt: '', quietMs: null, latest: '' };
  assert.equal(activityState(inv),'fail');
  assert.equal(activityState({ ...inv, assessment: 'future-gap' }), 'pre-delivery');
  assert.equal(stateTone('pre-delivery'), 'muted', 'historical checks are not shown as current waits or faults');
  assert.match(assessmentExplanation({ ...inv, assessment: 'future-gap' }), /At this check.*historical result/);
  assert.equal(activityState({ ...inv, assessment: 'baseline-red' }),'pre-delivery');
  assert.match(assessmentExplanation({ ...inv, assessment: 'baseline-red' }), /not an executor failure/);
  assert.equal(activityState({ ...inv, assessment: 'mutation-caught' }),'probe passed');
  assert.equal(activityState({ ...inv, state: 'pass', assessment: 'mutation-survived' }),'probe failed');
  for (const state of ['fault','spawn-failed','lost','unowned']) {
    assert.equal(activityState({ ...inv, state, assessment: 'baseline-red' }),state);
    assert.equal(activityState({ ...inv, state, assessment: 'future-gap' }),state);
    assert.equal(activityState({ ...inv, state, assessment: 'mutation-caught' }),state);
  }
});

test('full graph colours only status markers, with merged units and passed settled milestones consistently green', () => {
  const d = observed(); d.status = { ...d.status, units: d.status.units.map((u) => ({ ...u, state: 'merged' })),
    milestones: [{ id: 'MS-1', state: 'settled', passed: true, round: 1, walks: [], findings: [] }] as never };
  d.milestoneUnits = { 'MS-1': ['root','left','right','join'] };
  for (const expanded of [false,true]) for (const ascii of [false,true]) {
    const nodes = graph(d, expanded); const drawing = dependencyDrawing(nodes,d,'MS-1',ascii);
    const green = drawing.rows.flatMap((row) => row.filter((s) => s.tone === 'good'));
    assert.equal(green.length,nodes.length);
    assert.ok(green.every((s) => s.text === (ascii ? '+' : '✓')), 'status colour never bleeds into adjacent connector tracks');
    assert.ok(drawing.rows.flat().filter((s) => /[│║┼╳─┬┴⇓↓]/.test(s.text)).every((s) => s.tone === 'border'));
  }
  d.status = { ...d.status, units: d.status.units.map((u) => u.unit === 'root' ? { ...u,state:'cut' } : u),
    milestones: [{ ...d.status.milestones[0]!, passed:false }] };
  const nodes = graph({ ...d },true); assert.equal(nodes.find((n) => n.id === 'MS-1')!.markerState,'settled');
  const cut = nodes.find((n) => n.id === 'root')!;
  assert.equal(stateTone(cut.markerState ?? cut.state), 'muted', 'cut work is settled, not successful completion');
  assert.deepEqual(graph({ ...d }, false), []);
});

test('walkthrough and bring-up activities show recorded milestone scope rather than their arc scheduling seat', () => {
  const d = observed(); const relations = new InvocationRelations();
  const events = [
    { type:'fact',fact:{ kind:'walk-started',job:'walk-1',milestone:'MS-1' } },
    { type:'intent',kind:'proc.spawn',op:'arc/10',ordinal:1,parent:{type:'job',job:'walk-1'},expect:{subject:{purpose:'arc-backend',job:'walk-1',role:'walkthrough'}} },
    { type:'intent',kind:'proc.spawn',op:'arc/11',ordinal:1,parent:{type:'arc'},expect:{subject:{purpose:'bring-up',milestone:'MS-2',step:'setup'}} },
    { type:'intent',kind:'proc.spawn',op:'arc/12',ordinal:1,parent:{type:'job',job:'flow-1'},expect:{subject:{purpose:'arc-backend',job:'flow-1',role:'flow'}} },
  ] as never;
  const mapped = relations.read(d.run.runDir,events);
  assert.equal(mapped.get('arc/10#1')!.milestone,'MS-1'); assert.equal(mapped.get('arc/11#1')!.milestone,'MS-2');
  assert.equal(mapped.get('arc/12#1')?.milestone,undefined,'unrelated arc jobs do not acquire milestone scope');
  d.invocations = [{ ...entry('arc/10#1',{},'success'), ...mapped.get('arc/10#1'), label:'walk-1 / walkthrough', unit:'walk-1',role:'walkthrough',execution:'agent',scope:'arc',model:'example-model',attempt:1,session:'',startedAt:d.at,endedAt:d.at,quietMs:0,latest:'' }];
  const ui = new ViewState();ui.accept(d);ui.key('','2',18);
  for (const [w,h] of [[120,35],[80,24]]) {
    const frame = ui.render(w!,h!,false).join('\n');assert.match(frame,/Milestone MS-1/);assert.doesNotMatch(frame,/Arc-wide/);
  }
  ui.open();assert.match(ui.render(120,35,false).join('\n'),/walk-1.*Milestone MS-1/);
  assert.doesNotMatch(ui.render(120,35,false).join('\n'),/Arc-wide/);
});

test('replacement chains are explicit history, never prerequisites, and remain discoverable on the full map', () => {
  const d = observed();
  // Lexicographic order would put the replacement first; explicit lineage orders the versions.
  d.status = { ...d.status, units: d.status.units.map((u) => ({ ...u,
    ...(u.unit === 'root' ? { state: 'superseded', supersededBy: unitId('left') } : {}),
    ...(u.unit === 'left' ? { state: 'superseded', supersededBy: unitId('right'), lineage: { reenters: unitId('root'), root: unitId('root'), prepared: true } } : {}),
    ...(u.unit === 'right' ? { state: 'merged', lineage: { reenters: unitId('left'), root: unitId('root'), prepared: true } } : {}),
  })), edges: [{ type: 'after', unit: 'join', on: 'root', effective: 'right', satisfied: true }] as never,
    milestones: [{ id: 'MS-1', state: 'waiting', passed: false, round: 0, walks: [], findings: [] }] as never };
  d.milestoneUnits = { 'MS-1': ['root'] };
  d.invocations = ['root', 'left', 'right', 'join'].map((unit) => ({ ...entry(`inv-${unit}`, {}, 'success'), unit, role: 'build', attempt: 1, session: unit,
    startedAt: d.at, endedAt: d.at, quietMs: null, latest: '' }));
  const full = graph(d, true); const compact = graph(d, false);
  assert.ok(full.findIndex((n) => n.id === 'root') < full.findIndex((n) => n.id === 'left'));
  assert.ok(full.findIndex((n) => n.id === 'left') < full.findIndex((n) => n.id === 'right'));
  for (const id of ['root', 'left', 'right']) {
    assert.ok(!compact.some((n) => n.id === id));
    const node = full.find((n) => n.id === id)!; assert.deepEqual(node.from, []);
    assert.match(node.label, /MS-1/);
  }
  assert.deepEqual(full.find((n) => n.id === 'join')!.from, ['right']);
  assert.deepEqual(full.find((n) => n.id === 'MS-1')!.from, ['right']);
  assert.match(full.find((n) => n.id === 'MS-1')!.label, /1\/1 units merged/);
  const ui = new ViewState(); ui.accept(d); ui.key('', 'c', 18);
  for (const id of ['root', 'left', 'right']) {
    ui.selected.set('1:0', id);
    assert.equal(ui.activityContext()!.label, `${id} · lineage`);
    assert.deepEqual([...ui.activityContext()!.invocations], ['inv-root', 'inv-left', 'inv-right']);
  }
  ui.selected.set('1:0', 'left'); ui.open(); ui.key('right', '', 10);
  assert.ok(ui.related().some((r) => r.label === 'Previous version: root (superseded)'));
  assert.ok(ui.related().some((r) => r.label === 'Replacement: right (merged)'));
  ui.linkIndex = ui.related().findIndex((r) => r.id === 'lineage:right'); ui.open();
  assert.equal(ui.detail!.id, 'right'); ui.key('escape', '', 10); assert.equal(ui.detail!.id, 'left');
  assert.equal(ui.pane, 1); assert.equal(ui.related()[ui.linkIndex]!.id, 'lineage:right');
  ui.key('escape', '', 10); assert.equal(ui.selection()!.id, 'left');
  for (const ascii of [false, true]) {
    const drawing = dependencyDrawing(full, d, 'left', ascii, 76).rows.map(plain).join('\n');
    assert.match(drawing, /Replaces: root.*Replaced by: right/);
    assert.match(drawing, /Needs: right \(replaces root\)/);
    for (const [w, h] of [[120, 35], [80, 24]]) {
      const frame = ui.renderFrame(w!, h!, ascii); assert.equal(frame.length, h);
      assert.ok(frame.every((row) => width(plain(row)) === w! - 1));
      assert.match(frame.map(plain).join('\n'), /Replaces: root/);
    }
  }
});

test('specification revisions stay on their unit; similar names and shared documents never imply lineage', () => {
  const d = observed();
  const spec = d.estate.find((e) => e.kind === 'specification' && e.id === 'root')!;
  spec.body = JSON.stringify({ ...JSON.parse(spec.body), rev: 7 });
  const before = graph(d, true).map((n) => n.id);
  const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true;
  const node = graph(d, true).find((n) => n.id === 'root')!;
  assert.equal(node.specRevision, 7); assert.equal(node.replaces, undefined); assert.equal(node.replacedBy, undefined);
  assert.equal(JSON.parse(node.body).specificationRevision, 7);
  assert.match(ui.render(120, 35, false).join('\n'), /Spec r7/);
  ui.open(); ui.key('right', '', 10); assert.ok(ui.related().every((r) => !r.id.startsWith('lineage:')));
  spec.body = 'This retained specification has been pruned.';
  assert.equal(graph({ ...d }, true).find((n) => n.id === 'root')!.specRevision, undefined);
  assert.deepEqual(graph({ ...d }, true).map((n) => n.id), before);
});

test('stopped snapshots explain pending walkthroughs and the gates units actually wait for', () => {
  const d = observed();
  d.status = { ...d.status, units: d.status.units.map((u) => u.unit === 'join' ? { ...u, state: 'waiting', waitingFor: {
    deps: [], milestones: ['MS-1'], edges: [], admission: [], resources: null, envBlocked: false, drainFor: [],
  } } : u) as typeof d.status.units, milestones: [{ id: 'MS-1', state: 'walking', passed: false, round: 0, walks: [], findings: [] }] as never };
  d.milestoneUnits = { 'MS-1': ['left', 'right'] };
  const summary = executionSummary(d); assert.equal(summary.state, 'stopped'); assert.match(summary.detail, /no work will advance/);
  let nodes = graph(d, true);
  assert.match(nodes.find((n) => n.id === 'MS-1')!.label, /walkthrough pending/);
  assert.equal(nodes.find((n) => n.id === 'MS-1')!.markerState, 'waiting');
  assert.match(nodes.find((n) => n.id === 'MS-1')!.description!, /Executor is stopped/);
  const joined = nodes.find((n) => n.id === 'join')!;
  assert.equal(joined.waitReason, 'Waiting for: MS-1 milestone gate');
  assert.equal(JSON.parse(joined.body).reason, joined.waitReason);
  assert.doesNotMatch(joined.waitReason, /left|right/, 'satisfied prerequisites are not waiting reasons');
  const ui = new ViewState(); ui.accept(d); ui.expandedGraph = true; ui.selected.set('1:0', 'join');
  ui.diagnostics.accept(Buffer.from('roadmap: upgrade default (legacy): retained legacy format\n'), 'stderr');
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const frame = ui.render(w!, h!, false); assert.equal(frame.length, h); assert.ok(frame.every((row) => width(row) === w! - 1));
    const text = frame.join('\n'); assert.match(text, /Executor stopped/); assert.match(text, /walkthrough pending/); assert.match(text, /Waiting for: MS-1 milestone gate/);
  }
  d.status = { ...d.status, run: { ...d.status.run, owner: { state: 'alive', pid: 1, generation: 1 } } as never,
    milestones: [{ ...d.status.milestones[0]!, round: 1, walks: [{ job: 'walk-1', round: 1, outcome: null }] }] as never };
  nodes = graph({ ...d }, true);
  assert.match(nodes.find((n) => n.id === 'MS-1')!.label, /milestone · walking/); assert.equal(nodes.find((n) => n.id === 'MS-1')!.markerState, 'walking');
  assert.doesNotMatch(executionSummary(d).detail, /stopped/);
});


test('worker diagnostics are readable informational notes, never run banners or false faults', () => {
  const ui = new ViewState(); ui.accept(observed());
  const warning = 'roadmap: upgrade default (lane.tier.spec): a spec lane declaring tier; read as its cadence';
  ui.diagnostics.accept(Buffer.from(warning + '\n'), 'stderr');
  ui.diagnostics.accept(Buffer.from(warning + '\n'), 'stderr');
  assert.equal(ui.diagnostics.entries().length, 1);
  assert.equal(JSON.parse(ui.diagnostics.entries()[0]!.body).technicalDetails.length, 1);
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const frame = ui.render(w!, h!, false); assert.equal(frame.length, h); assert.ok(frame.every((row) => width(row) === w! - 1));
    const text = frame.join('\n'); assert.match(text, /Executor stopped · no work will advance/);
    assert.match(text, /4 Exceptions & notes/); assert.match(text, /Exceptions 0/); assert.match(text, /faults 0/);
    assert.doesNotMatch(text, /upgrade default|lane\.tier|Observer:/);
  }
  ui.key('', '4', 18); assert.equal(ui.rows().length, 1); assert.match(ui.selection()!.label, /Viewer note: older run format/);
  ui.open(); const detail = ui.render(120, 35, false).join('\n');
  assert.match(detail, /No action is needed/); assert.match(detail, /Technical Details/); assert.match(detail, /lane\.tier\.spec/);
  ui.key('escape', '', 18); ui.error = 'journal corruption';
  assert.equal(ui.rows().length, 2); assert.equal(ui.rows()[0]!.id, 'observation-error');
  assert.match(ui.render(120, 35, false).join('\n'), /STALE.*journal corruption/);
});

test('diagnostic retention handles split UTF-8 and independent streams, strips controls and bounds memory', () => {
  const diagnostics = new ViewerDiagnostics(); const text = Buffer.from('café unexpected diagnostic\n');
  const split = text.indexOf(Buffer.from('é')) + 1;
  diagnostics.accept(text.subarray(0, split), 'stderr');
  diagnostics.accept(Buffer.from('stdout note\n'), 'stdout');
  diagnostics.accept(text.subarray(split), 'stderr');
  let entry = diagnostics.entries()[0]!;
  assert.equal(entry.label, 'Viewer diagnostics'); assert.match(entry.body, /café unexpected diagnostic/);
  assert.doesNotMatch(entry.description!, /No action is needed/);
  diagnostics.accept(Buffer.from('\x1b[2Jcontrol\n'), 'stderr');
  assert.doesNotMatch(diagnostics.entries()[0]!.body, /\\u001b/);
  diagnostics.accept(Buffer.from('x'.repeat(10000)), 'stdout');
  for (let i = 0; i < 40; i++) diagnostics.accept(Buffer.from(`message ${i}\n`), 'stderr');
  entry = diagnostics.entries()[0]!; const body = JSON.parse(entry.body);
  assert.equal(body.technicalDetails.length, 32); assert.equal(body.technicalDetails.at(-1), 'message 39');
  assert.match(body.retention, /latest 32/);
});


test('large Estate collections disclose progressively, sort naturally and reveal hidden search matches', () => {
  const d = observed();
  const clauses: Entry[] = Array.from({ length: 600 }, (_, i) => ({ ...entry(`V-${i + 1}`, { text: i >= 598 ? 'needle: rare requirement' : `Clause ${i + 1}` }),
    kind: 'vision-clause', parentId: 'vision', label: `V-${i + 1} · world`, links: ['vision'] }));
  const vision: Entry = { ...entry('vision', { clauses: clauses.map((c) => ({ id: c.id, ...JSON.parse(c.body) })) }), kind: 'vision', label: 'Vision' };
  d.estate = [entry('z', {}), ...clauses.toReversed(), { ...entry('plan', {}), label: 'Arc execution plan' }, vision,
    { ...entry('rules', {}), label: 'Constraints & rulings' }, { ...entry('C-10', {}), parentId: 'rules' }, { ...entry('C-2', {}), parentId: 'rules' }, entry('a', {})];
  const ui = new ViewState(); ui.accept(d); ui.key('', '3', 18);
  assert.deepEqual(ui.rows().map((r) => r.id), ['vision', 'plan', 'a', 'rules', 'z']);
  assert.match(estateRowLabel(ui.selection()!, false), /\[\+\] Vision · 600 clauses/);
  for (const [w, h] of [[120, 35], [80, 24]]) {
    const frame = ui.render(w!, h!, false); assert.match(frame.join('\n'), /Space expand/); assert.match(frame.join('\n'), /600 clauses/);
    assert.ok(frame.every((row) => width(row) === w! - 1));
  }
  ui.open(); assert.equal(ui.detail!.id, 'vision');
  const layout = ui.detailFrame(); ui.key('down', '', 10); assert.equal(ui.detailFrame(), layout, 'scrolling a large document reuses its decoded layout');
  ui.key('escape', '', 10); assert.equal(ui.rows().length, 5);
  ui.key('space', ' ', 10); assert.equal(ui.rows().length, 605);
  assert.deepEqual(ui.rows().slice(1, 4).map((r) => r.id), ['V-1', 'V-2', 'V-3']);
  assert.match(estateRowLabel(ui.rows()[1]!, false), /├─ V-1/);
  assert.match(estateRowLabel(ui.rows()[1]!, true), /\+- V-1/);
  ui.key('space', ' ', 10); assert.equal(ui.rows().length, 5);
  ui.key('', '/', 10); ui.key('', 'needle:', 10); ui.key('return', '', 10);
  assert.equal(ui.selection()!.id, 'vision', 'the whole document is also a valid search match');
  ui.key('', 'n', 10); assert.equal(ui.selection()!.id, 'V-599'); assert.ok(ui.expandedEstate.has('vision'));
  ui.key('', 'n', 10); assert.equal(ui.selection()!.id, 'V-600');
  ui.open(); assert.equal(ui.detail!.id, 'V-600'); ui.key('escape', '', 10); assert.equal(ui.selection()!.id, 'V-600');
  ui.accept({ ...d }); assert.equal(ui.selection()!.id, 'V-600'); assert.ok(ui.expandedEstate.has('vision'));
  ui.selected.set('2:0', 'rules'); ui.key('space', ' ', 10);
  const index = ui.rows().findIndex((r) => r.id === 'rules');
  assert.deepEqual(ui.rows().slice(index + 1, index + 3).map((r) => r.id), ['C-2', 'C-10']);
  d.estate.find((e) => e.id === 'rules')!.state = 'withdrawn';
  ui.accept({ ...d });
  assert.ok(!ui.rows().some((r) => r.id === 'C-2'), 'children of a hidden inactive collection do not leak into the root list');
  ui.key('', 'w', 10); assert.ok(ui.rows().some((r) => r.id === 'C-2'));
  ui.accept({ ...d, run: { ...d.run, arc: arcId('another'), runDir: absPath('/tmp/another-estate') } });
  assert.equal(ui.expandedEstate.size, 0, 'new arcs begin collapsed');
});

test('Estate hierarchy survives nested groups, inactive parents and missing records without inferring links as containment', () => {
  const rows = [entry('root', {}), { ...entry('child', {}), parentId: 'root' }, { ...entry('leaf', {}), parentId: 'child' },
    { ...entry('orphan', {}), parentId: 'missing' }, { ...entry('linked', {}), links: ['root'] }];
  assert.deepEqual(estateOutline(rows, new Set()).map((r) => r.id), ['linked', 'orphan', 'root']);
  assert.deepEqual(estateOutline(rows, new Set(['root'])).map((r) => r.id), ['linked', 'orphan', 'root', 'child']);
  assert.match(estateRowLabel(estateOutline(rows).at(-1)!, false), /   └─ leaf/);
  assert.ok(estateOutline(rows.filter((r) => r.id !== 'root'), new Set()).some((r) => r.id === 'child'));
});

test('Activity puts linked running, other running, linked history, other history and queued commands in order', () => {
  const d = observed();
  const inv = (id: string, unit: string, running: boolean): Invocation => ({ ...entry(id, {}, running ? 'running' : 'success'),
    unit, role: 'build', attempt: 1, session: id, startedAt: d.at, endedAt: running ? null : d.at, quietMs: 0, latest: '' });
  d.invocations = [inv('history-other', 'left', false), inv('running-other', 'left', true), inv('history-linked', 'root', false), inv('running-linked', 'root', true)];
  d.status = { ...d.status, commands: { ...d.status.commands, pending: [{ id: 'pending', type: 'resume' }] as never } };
  const ui = new ViewState(); ui.accept(d);
  assert.deepEqual(ui.rows(1).map((r) => r.id), ['running-linked', 'running-other', 'history-linked', 'history-other', 'command:pending']);
  assert.deepEqual([...ui.activityContext()!.invocations], ['history-linked', 'running-linked']);
  ui.key('', '2', 18); ui.key('', 'g', 18);
  assert.deepEqual(ui.rows().map((r) => r.id), ['running-other', 'running-linked', 'history-other', 'history-linked', 'command:pending']);
  assert.equal(ui.activityContext(), null);
  const settled = { ...d, status: { ...d.status, units: d.status.units.map((u) => ({ ...u, state: 'merged' })) } } as Display;
  const empty = new ViewState(); empty.accept(settled);
  assert.equal(empty.selection(0), null); assert.equal(empty.activityContext(), null);
  assert.deepEqual(empty.rows(1).map((r) => r.id), ['running-other', 'running-linked', 'history-other', 'history-linked', 'command:pending']);
});

test('open map hides every settled kind, preserves visible lineage and marks hidden dependencies satisfied', () => {
  const d = observed();
  d.status = { ...d.status, units: d.status.units.map((u) => ({ ...u, waitingFor: null,
    state: u.unit === 'root' ? 'superseded' : u.unit === 'left' ? 'merged' : u.unit === 'right' ? 'cut' : 'running',
    ...(u.unit === 'root' ? { supersededBy: unitId('join') } : {}),
    ...(u.unit === 'join' ? { lineage: { root: unitId('root'), reenters: unitId('root'), prepared: true } } : {}),
  })) as typeof d.status.units,
  edges: [...d.status.edges, { type: 'contingent', unit: 'join', edge: 'E-done', condition: 'approved', resolved: true },
    { type: 'contingent', unit: 'join', edge: 'E-open', condition: 'pending', resolved: false }] as never,
  milestones: [{ id: 'MS-done', state: 'settled', passed: true, round: 1, walks: [], findings: [] },
    { id: 'MS-open', state: 'polishing', passed: true, round: 1, walks: [], findings: [] }] as never };
  d.milestoneUnits = { 'MS-open': ['root'] };
  const ui = new ViewState(); ui.accept(d); ui.selected.set('1:0', 'join');
  assert.deepEqual(new Set(ui.rows().map((r) => r.id)), new Set(['join', 'E-open', 'MS-open']));
  const drawing = dependencyDrawing(graph(d, false), d, 'join', false).rows.map(plain).join('\n');
  assert.doesNotMatch(drawing, /\[offscreen\]/); assert.match(drawing, /Replaces: root/);
  assert.ok(!drawing.includes('root ·'), 'hidden settled nodes draw no row or outgoing rail');
  for (const ascii of [false, true]) {
    const frame = ui.render(200, 50, ascii).join('\n');
    assert.match(frame, /5 settled hidden/); assert.match(frame, /Replaces root/);
    assert.match(frame, ascii ? /Needs: left \+, right \+, E-done \+, E-open/ : /Needs: left ✓, right ✓, E-done ✓, E-open/);
    assert.doesNotMatch(frame, /(?:left|right|E-done) \[offscreen\]/);
  }
  ui.key('', 'c', 18);
  assert.equal(ui.rows().length, 8); assert.ok(ui.rows().some((r) => r.id === 'MS-done'));
  ui.key('', 'c', 18); assert.equal(ui.rows().length, 3);
});

test('r and R cycle running and preparing map units and open walks in both map modes', () => {
  const d = observed();
  d.status = { ...d.status, units: d.status.units.map((u) => ({ ...u, state: u.unit === 'root' ? 'merged' : u.unit === 'left' ? 'preparing' : u.unit === 'join' ? 'running' : 'waiting' })),
    milestones: [{ id: 'MS-live', state: 'walking', passed: false, round: 1, walks: [{ job: 'walk', round: 1, outcome: null }], findings: [] },
      { id: 'MS-due', state: 'walking', passed: false, round: 0, walks: [], findings: [] }] as never };
  for (const full of [false, true]) {
    const ui = new ViewState(); ui.accept(d); if (full) ui.key('', 'c', 18);
    const running = ui.rows().filter((r) => ['MS-live', 'left', 'join'].includes(r.id)).map((r) => r.id);
    ui.selected.set('1:0', running.at(-1)!);
    for (const id of running) { ui.key('', 'r', 18); assert.equal(ui.selection()!.id, id); }
    ui.key('', 'r', 18); assert.equal(ui.selection()!.id, running[0]);
    for (const id of running.toReversed()) { ui.key('', 'R', 18); assert.equal(ui.selection()!.id, id); }
    ui.selected.set('1:0', 'MS-due'); ui.key('', 'r', 18); assert.equal(ui.selection()!.id, 'MS-live');
  }
  const idle = { ...d, status: { ...d.status, units: d.status.units.map((u) => ({ ...u, state: 'waiting' })), milestones: [] } } as Display;
  const ui = new ViewState(); ui.accept(idle); const selected = ui.selection()!.id;
  for (const key of ['r', 'R']) { ui.key('', key, 18); assert.equal(ui.selection()!.id, selected); assert.match(ui.render(120, 35, false).join('\n'), /No running items in dependency map/); }
});

test('r and R cycle only unended Activity invocations, wrap, and report no running items', () => {
  const d = observed();
  d.invocations = ['ended', 'live-a', 'live-b'].map((id) => ({ ...entry(id, {}, 'success'), unit: 'root', role: 'build', attempt: 1, session: id,
    startedAt: d.at, endedAt: id === 'ended' ? d.at : null, quietMs: 0, latest: '' }));
  const ui = new ViewState(); ui.accept(d); ui.key('', '2', 18); ui.selection(); ui.selected.set('1:1', 'ended');
  for (const [key, expected] of [['r', 'live-a'], ['r', 'live-b'], ['r', 'live-a'], ['R', 'live-b'], ['R', 'live-a'], ['R', 'live-b']]) {
    ui.key('', key!, 18); assert.equal(ui.selection()!.id, expected);
  }
  ui.accept({ ...d, invocations: d.invocations.map((inv) => ({ ...inv, endedAt: d.at })) });
  const selected = ui.selection()!.id;
  for (const key of ['r', 'R']) { ui.key('', key, 18); assert.equal(ui.selection()!.id, selected); assert.match(ui.render(120, 35, false).join('\n'), /No running items in Activity/); }
  ui.open(); const raw = ui.logRequest!.raw; ui.key('', 'r', 18); assert.equal(ui.logRequest!.raw, !raw);
});

test('printable ASCII keeps literal cell widths, clipping and wrapping alongside Unicode and controls', () => {
  const ascii = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  assert.equal(width(ascii), ascii.length);
  for (const columns of [-1, 0, 1, 17, 200]) assert.equal(clip(ascii, columns), ascii.slice(0, Math.max(0, columns)));
  assert.deepEqual(wrap('abc def\n\nlast', 4), ['abc ', 'def', '', 'last']);
  assert.deepEqual(wrap('abc', 0), ['a', 'b', 'c']);
  assert.equal(plain(fit(line(ink('abc'), ink('def')), 5)), 'abcde');
  assert.equal(clip('a\x1b[31mb\t界\nc', 8), 'ab    界');
  assert.equal(width('e\u0301界🙂'), 5); assert.equal(clip('e\u0301界🙂', 3), 'e\u0301界');
});
