import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseObservations } from '../evals/observer.ts';
import { runUntilExit } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';

const OBSERVER = fileURLToPath(new URL('../evals/observer.ts', import.meta.url));

/** A fake `codex` that records its stdin and argv and writes a canned reply to the `-o` file. */
function fakeCodex(bin: string, reply: string): void {
  mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh
out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; echo "$1" >> "${bin}/argv"; shift; done
cat > "${bin}/stdin.$(ls ${bin} | grep -c '^stdin')"
printf '%s\\n' '${reply.replaceAll("'", `'\\''`)}' > "$out"
`;
  writeFileSync(join(bin, 'codex'), script, { mode: 0o755 });
}

/** A fake `claude` that records argv (one per line) and stdin, and prints a canned reply on stdout. */
function fakeClaude(bin: string, reply: string): void {
  mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh
for a in "$@"; do echo "$a" >> "${bin}/argv"; done
pwd > "${bin}/cwd"
cat > "${bin}/stdin.0"
printf '%s\\n' '${reply.replaceAll("'", `'\\''`)}'
`;
  writeFileSync(join(bin, 'claude'), script, { mode: 0o755 });
}

const A = '{"severity":"abort","kind":"crash-loop","summary":"loops","evidence":["events.jsonl:3"],"suggestion":"fix"}';
const H = '{"severity":"high","kind":"waste","summary":"wasteful","evidence":["seq 2"],"suggestion":"trim"}';
const N = '{"severity":"note","kind":"other","summary":"minor","evidence":[],"suggestion":"-"}';

describe('observer', () => {
  it('observer.parse: keeps valid lines, reports invalid ones', () => {
    const { ok, invalid } = parseObservations(`${A}\nnot json\n{"severity":"bogus","kind":"other","summary":"x","evidence":[],"suggestion":"y"}\n\n${N}`);
    assert.equal(ok.length, 2);
    assert.equal(invalid.length, 2);
  });

  it('observer.once: delta, cursor, observations file and stdout lines; status by the fixture\'s repo and arc (R-19)', async () => {
    const dir = tmpDir('observer');
    const bin = join(dir, 'bin');
    const host = join(dir, 'host');
    mkdirSync(host);
    const fx = join(dir, 'fx');
    const rt = join(fx, 'stage/product/.git/roadmap-runtime/arc-a');
    mkdirSync(join(rt, 'needs-user'), { recursive: true });
    const ev = (seq: number) => `${JSON.stringify({ seq, type: 'fact', marker: `EV${seq}` })}\n`;
    writeFileSync(join(rt, 'events.jsonl'), ev(1) + ev(2));
    writeFileSync(join(rt, 'needs-user/nu-1.json'), '{"reason":"NUMARK"}');
    writeFileSync(join(fx, 'transcript.jsonl'), `${JSON.stringify({ turn: 1, event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'TRMARK' } }] } } })}\n`);
    // An earlier run's log on the shared host dir, older than this fixture's seed: never read.
    writeFileSync(join(host, 'executor.0.err'), 'OLDRUNERR\n');
    utimesSync(join(host, 'executor.0.err'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    writeFileSync(join(fx, 'seed.json'), '{}');
    utimesSync(join(fx, 'seed.json'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    writeFileSync(join(host, 'executor.1.err'), 'HOSTERR1\n');
    fakeCodex(bin, `${A}\n${H}\n${N}\ngarbage`);
    // R-19: the staged CLI is asked per arc, by the fixture's identity.
    const roadmap = join(fx, 'stage/plugin/executor/bin/roadmap');
    mkdirSync(join(fx, 'stage/plugin/executor/bin'), { recursive: true });
    writeFileSync(roadmap, `#!/bin/sh\necho "STATUSARGS $*"\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir };
    const run = () => runUntilExit(process.execPath, [OBSERVER, fx, '--once', '--model', 'm-x', '--host-dir', host], { env, timeoutMs: 60_000 });

    const first = await run();
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^OBSERVER abort: \[crash-loop\] loops/m);
    assert.match(first.stdout, /^OBSERVER high: \[waste\] wasteful/m);
    assert.doesNotMatch(first.stdout, /OBSERVER note/);
    assert.match(first.stdout, /^OBSERVER tick 1 ok 3 invalid 1$/m);
    const prompt1 = readFileSync(join(bin, 'stdin.0'), 'utf8');
    for (const m of ['EV1', 'EV2', 'NUMARK', 'TRMARK', 'HOSTERR1']) assert.ok(prompt1.includes(m), m);
    assert.ok(!prompt1.includes('OLDRUNERR'), 'an earlier run\'s host log is never read');
    assert.ok(prompt1.includes(`## status arc=arc-a\nSTATUSARGS status --repo ${join(fx, 'stage/product')} --arc arc-a`), prompt1.slice(0, 3000));
    assert.match(readFileSync(join(bin, 'argv'), 'utf8'), /read-only[\s\S]*m-x/);
    const obs = readFileSync(join(fx, 'observer/observations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(obs.length, 4);
    assert.equal(obs[0].tick, 1);
    assert.equal(obs[3].invalid, 'garbage');

    appendFileSync(join(rt, 'events.jsonl'), ev(3));
    appendFileSync(join(host, 'executor.1.err'), 'HOSTERR2\n');
    const second = await run();
    assert.match(second.stdout, /^OBSERVER tick 2 ok 3/m);
    const prompt2 = readFileSync(join(bin, 'stdin.1'), 'utf8');
    const delta2 = prompt2.slice(prompt2.indexOf('# Delta'));
    assert.ok(delta2.includes('EV3') && delta2.includes('HOSTERR2'));
    for (const m of ['EV1', 'EV2', 'NUMARK', 'TRMARK', 'HOSTERR1']) assert.ok(!delta2.slice(0, delta2.indexOf('# Your previous')).includes(m), `${m} repeated`);
    assert.ok(prompt2.includes('wasteful'), 'previous observations are fed back');
  });

  it('observer.claude: one tick through a read-only headless claude (Read/Glob/Grep, strict MCP, no memory)', async () => {
    const dir = tmpDir('observer-claude');
    const bin = join(dir, 'bin');
    const fx = join(dir, 'fx');
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, 'seed.json'), '{}');
    writeFileSync(join(fx, 'transcript.jsonl'), `${JSON.stringify({ turn: 1, event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'TRMARK' } }] } } })}\n`);
    fakeClaude(bin, `${H}\n${N}`);
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir };
    const r = await runUntilExit(process.execPath, [OBSERVER, fx, '--once', '--backend', 'claude', '--host-dir', join(dir, 'host')], { env, timeoutMs: 60_000 });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^OBSERVER high: \[waste\] wasteful/m);
    assert.match(r.stdout, /^OBSERVER tick 1 ok 2$/m);
    const argv = readFileSync(join(bin, 'argv'), 'utf8').split('\n');
    const after = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
    assert.ok(argv.includes('-p'));
    assert.equal(after('--model'), 'claude-sonnet-5-5');
    assert.equal(after('--effort'), 'high');
    assert.equal(after('--output-format'), 'text');
    assert.equal(after('--allowedTools'), 'Read,Glob,Grep');
    const denied = (after('--disallowedTools') ?? '').split(',');
    for (const t of ['Bash', 'Edit', 'Write', 'WebFetch']) assert.ok(denied.includes(t), t);
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(after('--settings') ?? ''), { autoMemoryEnabled: false });
    assert.equal(readFileSync(join(bin, 'cwd'), 'utf8').trim(), fx);
    assert.ok(readFileSync(join(bin, 'stdin.0'), 'utf8').includes('TRMARK'));
    const obs = readFileSync(join(fx, 'observer/observations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(obs.length, 2);
  });
});
