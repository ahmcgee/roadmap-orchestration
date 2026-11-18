// The diagnosis role eval (dev.83, E2): the production verifier prompt in diagnosis mode, its schema (DIAGNOSIS_SCHEMA) and
// backend argv, over the dev set's generated repositories (dev.ts). Graded mechanically: the cause, the evidence citing the
// estate dump, and a brief that proposes no production-code path. --dry-run renders and grades the reference answer for free;
// --fake expected|code grades a canned answer without a call.
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { backendArgv, freshJudgmentSession } from '../../../src/backends/argv.ts';
import { laneId, sha, specRev, systemName, unitId } from '../../../src/core/ids.ts';
import { SchemaError } from '../../../src/core/validate.ts';
import { absPath, repoPath } from '../../../src/core/values.ts';
import { promptFor } from '../../../src/prompts/index.ts';
import type { RoleInputs } from '../../../src/prompts/inputs.ts';
import { DIAGNOSIS_SCHEMA, validateDiagnosisOutput } from '../../../src/prompts/schemas.ts';
import { intOption, usdOption } from '../pool.ts';
import { DEV, type DiagnosisCase } from './dev.ts';

const exec = promisify(execFile);
const MODEL = 'claude-opus-5-5' as const;
const method = { traits: [], markers: [], unitKind: 'module', expensiveLanes: false, ui: false } as const;

/** A case laid out for one trial: its repository (base, then the fix commits) and each lanes attempt's lane output. */
export type Trial = Readonly<{ checkout: string; evidence: string; base: string; head: string; attempts: readonly string[]; baseRun: string }>;

const git = (cwd: string, args: readonly string[]): string => {
  const r = spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
};
/** Runs the case's lane in `cwd` and keeps its output in `dir` (stdout, stderr), as a lane's evidence dir holds it. */
function runLane(c: DiagnosisCase, cwd: string, dir: string): void {
  const r = spawnSync(c.lane.argv[0]!, c.lane.argv.slice(1), { cwd, encoding: 'utf8' });
  if (r.status === 0 || !r.stderr.includes(c.failure)) throw new Error(`case ${c.id}: the lane must fail with its line in ${cwd} (exit ${r.status}): ${r.stderr}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout'), r.stdout);
  writeFileSync(join(dir, 'stderr'), r.stderr);
}

/** The case's repository and evidence under `dir`: the lane red after the first build and each of the four fixes, and on the base. */
export function layOut(c: DiagnosisCase, dir: string): Trial {
  const checkout = join(dir, 'checkout'), evidence = join(dir, 'evidence');
  mkdirSync(checkout, { recursive: true });
  git(checkout, ['init', '-q', '-b', 'main']);
  write(checkout, c.base);
  git(checkout, ['add', '-A']);
  git(checkout, ['commit', '-q', '-m', 'base']);
  const base = git(checkout, ['rev-parse', 'HEAD']);
  const attempts: string[] = [];
  const lanes = (): void => { const at = join(evidence, 'u1', `${attempts.length + 1}-lanes`, c.lane.id); runLane(c, checkout, at); attempts.push(at); };
  write(checkout, { 'src/profile.js': "export const profilePath = (user) => `/profile/${user}`;\n" });
  git(checkout, ['add', '-A']);
  git(checkout, ['commit', '-q', '-m', 'feat: profile page after sign-in']);
  lanes();
  for (const fix of c.fixes) {
    write(checkout, fix.files);
    git(checkout, ['commit', '-q', '-am', fix.message]);
    lanes();
  }
  const baseTree = join(dir, 'base');
  git(checkout, ['worktree', 'add', '-q', '--detach', baseTree, base]);
  const baseRun = join(evidence, 'u1', `${attempts.length}-lanes`, '_base', c.lane.id);
  runLane(c, baseTree, baseRun);
  git(checkout, ['worktree', 'remove', '--force', baseTree]);
  return { checkout, evidence, base, head: git(checkout, ['rev-parse', 'HEAD']), attempts, baseRun };
}

/** The verifier's diagnosis inputs for a laid-out trial, as surface.ts `runReview` builds them. */
export function diagnosisInput(c: DiagnosisCase, t: Trial): RoleInputs['verifier'] {
  const history = t.attempts.map((evidence, i) => JSON.stringify({ ref: `u1/lanes#${i + 1}`, outcome: 'red', detail: null, evidence }));
  return {
    mode: 'diagnosis',
    brief: {
      target: { kind: 'full', doc: { path: repoPath('ARCHITECTURE.md'), text: c.base['ARCHITECTURE.md']! } }, vision: null,
      spec: { unit: unitId('u1'), rev: specRev(1), markdown: c.spec }, intent: c.intent, nonGoals: ['No change to the directory or its accounts from this repository'],
      contracts: [], systems: [systemName('app')], method, history, standing: [],
      evidence: {
        trigger: [`repeat-red:${c.lane.id}:${'0'.repeat(64)}`],
        failures: [{ lane: laneId(c.lane.id), signature: c.failure, specific: true, excerpt: [c.failure] }],
        baseComparison: [{ lane: laneId(c.lane.id), base: sha(t.base), result: 'fail', evidence: absPath(t.baseRun) }],
        environment: { tripped: [], retryableParks: [], hostSuspected: [] },
        knownDefects: [],
        flaky: [],
      },
    },
  };
}

/** A canned answer: the expected diagnosis, or a code-change one that must fail. */
export function referenceAnswer(c: DiagnosisCase, kind: 'expected' | 'code'): unknown {
  return kind === 'expected'
    ? { cause: 'environment', evidence: [`${c.expect.cites}: journey-user is locked (state locked, lockedBy failed-attempts)`, `${c.lane.id} is red on the base with the same line`],
      brief: 'The journey account journey-user is locked in the test estate directory; ask for it to be unlocked and its failed attempts reset. Change no code, and revert no further client identifiers.',
      reasons: ['The same rejection on the base and after four different client identifiers rules out the unit and its config.'] }
    : { cause: 'unit', evidence: ['src/signin.js:9'], brief: 'Relax the state check in src/signin.js so a locked account may sign in.', reasons: ['The check rejects the journey user.'] };
}

export type DiagnosisChecks = Readonly<{ cause: boolean; cites: boolean; noCodeChange: boolean }>;
/** The mechanical grade: the expected cause, evidence citing the dump, and a brief naming no production-code path. */
export function gradeDiagnosis(c: DiagnosisCase, answer: unknown): Readonly<{ pass: boolean; void: string | null; checks: DiagnosisChecks | null }> {
  try {
    const out = validateDiagnosisOutput(answer);
    const checks = { cause: out.cause === c.expect.cause, cites: out.evidence.some((e) => e.includes(c.expect.cites)), noCodeChange: !c.expect.production.some((p) => out.brief.includes(p)) };
    return { pass: checks.cause && checks.cites && checks.noCodeChange, void: null, checks };
  } catch (error) {
    // A malformed model answer voids the trial; programming and harness errors stay loud.
    if (!(error instanceof SchemaError)) throw error;
    return { pass: false, void: error.message, checks: null };
  }
}

const USAGE = 'usage: node evals/roles/run.ts diagnosis --set dev --n 3 [--dry-run] [--fake expected|code] [--cap USD] [--out DIR]';

export async function runDiagnosis(argv: readonly string[]): Promise<boolean> {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { set: { type: 'string' }, n: { type: 'string', default: '3' }, out: { type: 'string' }, 'dry-run': { type: 'boolean' }, fake: { type: 'string' }, cap: { type: 'string' } } });
  if (positionals.length !== 1 || positionals[0] !== 'diagnosis' || values.set !== 'dev') throw new Error(USAGE);
  if (values.fake !== undefined && values.fake !== 'expected' && values.fake !== 'code') throw new Error(`--fake ${values.fake}: expected or code`);
  const n = intOption('n', values.n, 1, 100), cap = usdOption('cap', values.cap);
  const out = values.out === undefined ? mkdtempSync(join(tmpdir(), 'roles-diagnosis-')) : resolve(values.out);
  mkdirSync(out, { recursive: true });
  const prompt = promptFor('verifier', MODEL);
  const rows: { cell: string; trial: number; pass: boolean; void: string | null; checks: DiagnosisChecks | null; usd: number }[] = [];
  let spent = 0;
  for (const c of DEV) for (let trial = 0; trial < n; trial++) {
    if (cap !== null && spent >= cap) throw new Error(`eval cap reached at $${spent}`);
    const dir = join(out, `${c.id}-${trial}`);
    const t = layOut(c, dir);
    const text = prompt.render(diagnosisInput(c, t));
    writeFileSync(join(dir, 'prompt.txt'), `${prompt.system}\n${text}`);
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(DIAGNOSIS_SCHEMA));
    let answer: unknown = referenceAnswer(c, values.fake === 'code' ? 'code' : 'expected');
    let usd = 0;
    if (!values['dry-run'] && values.fake === undefined) {
      const args = backendArgv({ kind: 'claude-acting-judge', role: 'verifier', triple: { backend: 'claude', model: MODEL, effort: 'medium' }, session: freshJudgmentSession(), schemaText: JSON.stringify(DIAGNOSIS_SCHEMA), system: prompt.system, mcpConfig: null, evidenceDirs: [absPath(t.evidence)], denyWrites: [] });
      const child = exec(args[0]!, args.slice(1), { cwd: t.checkout, timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 });
      child.child.stdin!.end(text);
      const result = await child;
      writeFileSync(join(dir, 'transcript.jsonl'), result.stdout);
      const terminal = result.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).findLast((e) => e['type'] === 'result');
      if (terminal === undefined) throw new Error('no terminal result');
      answer = terminal['structured_output'] ?? null;
      usd = typeof terminal['total_cost_usd'] === 'number' ? terminal['total_cost_usd'] : 0;
    }
    writeFileSync(join(dir, 'answer.json'), JSON.stringify(answer));
    const graded = gradeDiagnosis(c, answer);
    spent += usd;
    rows.push({ cell: c.id, trial, ...graded, usd });
    process.stdout.write(`${values['dry-run'] ? 'DRY' : 'TRIAL'} diagnosis/${c.id}#${trial} ${graded.void === null ? (graded.pass ? 'PASS' : `FAIL ${JSON.stringify(graded.checks)}`) : `void: ${graded.void}`}\n`);
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ role: 'diagnosis', set: 'dev', rows, spent }, null, 2));
  return rows.every((r) => r.pass);
}
