#!/usr/bin/env node
// The local CI runner: runs ci/pipeline.yml's steps in order from the project root, the way CI does, and stops at the
// first failing step (design/ci.md). The file format is a small YAML subset: `name:`, then `steps:` with `- name:` and
// `run:` per step. A step's command runs without a shell; node expands its own test globs. A step keeps the line of its
// `- name:` (`line`) and of its command (`runLine`, the line a failure cites).
//
//   node ci/run.js [--file ci/pipeline.yml]
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const file = args[0] === '--file' && args[1] !== undefined ? args[1] : 'ci/pipeline.yml';

function parsePipeline(text) {
  const pipeline = { name: null, steps: [] };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    let m;
    if ((m = /^name:\s*(\S.*)$/.exec(line)) !== null) pipeline.name = m[1].trim();
    else if (/^steps:\s*$/.test(line)) return;
    else if ((m = /^ {2}- name:\s*(\S.*)$/.exec(line)) !== null) pipeline.steps.push({ name: m[1].trim(), run: null, line: i + 1, runLine: null });
    else if ((m = /^ {4}run:\s*(\S.*)$/.exec(line)) !== null && pipeline.steps.length > 0) Object.assign(pipeline.steps.at(-1), { run: m[1].trim(), runLine: i + 1 });
    else {
      process.stderr.write(`${file}:${i + 1}: unexpected line "${raw}"; a step is "  - name: <name>" followed by "    run: <command>"\n`);
      process.exit(2);
    }
  });
  for (const step of pipeline.steps) {
    if (step.run === null) {
      process.stderr.write(`${file}:${step.line}: step "${step.name}" has no run: line; add "    run: <command>" under it\n`);
      process.exit(2);
    }
  }
  return pipeline;
}

/** The test files a `node --test <globs>` step runs (a glob is a directory and a `*` file pattern). */
function testFilesOf(argv) {
  const patterns = argv.slice(argv.indexOf('--test') + 1).filter((a) => !a.startsWith('--'));
  return patterns.flatMap((p) => {
    if (!p.includes('*')) return [p];
    const re = new RegExp(`^${basename(p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return readdirSync(dirname(p)).filter((f) => re.test(f)).sort().map((f) => join(dirname(p), f));
  });
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;
const tail = (text, n) => text.trimEnd().split('\n').slice(-n).map((l) => `    ${l}`).join('\n');

/**
 * A failing test file's report: the test runner's "failing tests" section, each failing test's file and line, its name,
 * its error and the stack frame it failed at (the rest of the stack and the error's properties are dropped). A file that
 * failed without a failing test (it did not load) reports the tail of its output.
 */
function failingTests(text) {
  const at = text.indexOf('failing tests:');
  if (at < 0) return tail(text, 12);
  const out = [];
  let frames = 0;
  for (const line of text.slice(at + 'failing tests:'.length).trim().split('\n')) {
    if (line.startsWith('test at ')) frames = 0;
    else if (/^\s+at /.test(line)) {
      frames += 1;
      if (frames === 1) out.push(line.replace(/ \{$/, ''));
      continue;
    } else if (frames > 0) continue;
    out.push(line.trimEnd());
  }
  return out.map((l) => (l === '' ? '' : `    ${l}`)).join('\n');
}

function reportFailure(step, argv, result, ms) {
{{failure-report}}
}

const pipeline = parsePipeline(readFileSync(file, 'utf8'));
process.stdout.write(`${pipeline.name ?? 'pipeline'}: ${pipeline.steps.length} steps\n`);
const started = Date.now();
for (const step of pipeline.steps) {
  const argv = step.run.split(/\s+/);
  const t0 = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  const ms = Date.now() - t0;
  if (result.status !== 0) {
    reportFailure(step, argv, result, ms);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`  ${step.name.padEnd(10)} ok      ${seconds(ms)}\n`);
}
process.stdout.write(`Pipeline passed in ${seconds(Date.now() - started)}.\n`);
