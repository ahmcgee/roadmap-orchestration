// Shared by the milestone walk tests (test/walk-job.test.ts) and their crash child (walk-child.ts): a holistic arc with one
// milestone MS-1 over u1 (u2 descends from it, u3 is unrelated), a tiny fake product committed in the base repo (a node
// http server and a CLI, its design reference under design/), the walk context over the run's one arbiter, and the
// fake walkthrough's scripted answers (each validated by the frozen reader, so a fake never answers what the executor
// could not have been given).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from '../../src/core/json.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import type { PlanUnit } from '../../src/input/plan.ts';
import type { UnitId } from '../../src/core/ids.ts';
import { rankOf } from '../../src/schedule/ready.ts';
import { validateWalkthroughOutput } from '../../src/prompts/schemas.ts';
import type { WalkContext } from '../../src/walk/walk.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import type { ClaudeAct, Step } from '../helpers/scenario.ts';
import { writeWitnessControl } from '../helpers/witness.ts';
import { admitSpecWire } from '../helpers/holistic.ts';
import { BUILD_REPORT, planCheckStep } from './stage-common.ts';
import { ADVANCES, VISION, obligationsJson } from './brake-common.ts';
import { publishArc } from './publish-common.ts';
import { wired } from './sched-m3-common.ts';
import { type ArcDescriptor, type ArcRun, gateStep } from './unit-common.ts';

type Json = Record<string, unknown>;

/** The fake product: `/health` always answers 200; `/` answers the greeting, or 500 while product/greeting.txt is missing. */
export const PRODUCT: Readonly<Record<string, string>> = {
  'product/server.js': [
    "import { createServer } from 'node:http';",
    "import { existsSync, readFileSync } from 'node:fs';",
    'const port = Number(process.argv[2]);',
    'createServer((req, res) => {',
    "  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }",
    "  if (!existsSync('product/greeting.txt')) { res.writeHead(500); res.end('boom: no greeting'); return; }",
    "  res.writeHead(200); res.end(readFileSync('product/greeting.txt', 'utf8'));",
    "}).listen(port, '127.0.0.1', () => process.stdout.write(`listening on ${port}\\n`));",
    '',
  ].join('\n'),
  'product/cli.js': [
    "import { existsSync, readFileSync } from 'node:fs';",
    'const [cmd, arg] = process.argv.slice(2);',
    "if (cmd === 'ping') { const r = await fetch(arg); process.exit(r.status === 200 ? 0 : 1); }",
    "if (cmd === 'greet') { if (!existsSync('product/greeting.txt')) { process.stderr.write('no greeting\\n'); process.exit(1); } process.stdout.write(readFileSync('product/greeting.txt', 'utf8')); process.exit(0); }",
    "process.stderr.write('usage: cli.js ping <url> | greet\\n'); process.exit(2);",
    '',
  ].join('\n'),
  'product/setup.js': "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('out', { recursive: true });\nwriteFileSync('out/setup.done', 'ok');\n",
  'product/package.json': '{ "type": "module" }\n',
  'design/README.md': '# Greeter design\n\n## Errors\n\nAn error names what failed and how to fix it.\n',
};

/** The repair that makes `/` answer: what r1's build commits. */
export const GREETING = { 'product/greeting.txt': 'hello\n' } as const;

/** MS-1: u1's experience, its bring-up running the fake product (setup, one serve entry, a seed), two shell journeys. */
export function milestoneJson(extra: Json = {}): Json {
  return {
    id: 'MS-1', text: 'Someone can ask the greeter for a greeting, on the web and from the CLI.', units: ['u1'], design: { supplied: true }, references: ['design'],
    bringUp: {
      setup: [['node', 'product/setup.js']],
      serve: [{ name: 'web', argv: ['node', 'product/server.js', '{port:web}'], ready: { http: 'http://127.0.0.1:{port:web}/health' } }],
      env: { GREETER_URL: 'http://127.0.0.1:{port:web}/' },
      seed: [['node', 'product/cli.js', 'ping', 'http://127.0.0.1:{port:web}/health']],
    },
    journeys: [
      { id: 'J-1', text: 'Open the greeter and read the greeting.', via: 'shell', entry: 'http://127.0.0.1:{port:web}/', budget: { steps: 2, seconds: 30 } },
      { id: 'J-2', text: 'Ask the CLI for a greeting.', via: 'shell', entry: 'node product/cli.js greet', budget: null },
    ],
    resources: [],
    ...extra,
  };
}

export type WalkArcOptions = Readonly<{ steps: readonly Step[]; milestone?: Json; walkRounds?: number }>;

/** Lays out the walk arc (u1 in MS-1; u2 after u1; u3 unrelated) and records revision 1 as a start does. */
export function walkArc(opts: WalkArcOptions): ArcDescriptor {
  const control = join(tmpDir('witness-control'), 'control.json');
  writeWitnessControl(control, { trees: { '*': { outcomes: { t1: 'pass' } } } });
  return publishArc({ steps: opts.steps, units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }, { id: 'u3' }] }, (x) => {
    for (const [path, text] of Object.entries(PRODUCT)) {
      mkdirSync(join(x.repo, path, '..'), { recursive: true });
      writeFileSync(join(x.repo, path), text);
    }
    git(x.repo, 'add', '-A');
    git(x.repo, 'commit', '--quiet', '-m', 'the greeter product and its design reference');
    const planDir = join(x.planPath, '..');
    writeFileSync(join(planDir, 'vision.json'), JSON.stringify(VISION));
    writeFileSync(join(planDir, 'obligations.json'), JSON.stringify(obligationsJson({ obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: [] }, control)));
    const plan = JSON.parse(readFileSync(x.planPath, 'utf8')) as Json;
    writeFileSync(x.planPath, JSON.stringify({
      ...plan, baseline: git(x.repo, 'rev-parse', 'main'),
      holistic: { vision: 'vision.json', advances: ADVANCES, obligations: 'obligations.json', audit: { lenses: ['vision'], every: 100 } },
      milestones: [opts.milestone ?? milestoneJson()],
      ...(opts.walkRounds === undefined ? {} : { limits: { walkRounds: opts.walkRounds } }),
    }));
  });
}


/** The walk context over the run's one arbiter (units acquire through the same one), the plan the plan in force. */
export function walkContext(r: ArcRun): Readonly<{ ctx: WalkContext; w: ReturnType<typeof wired> }> {
  const base = wired(r);
  // The rank over the plan in force too (a unit an apply added waits in the arbiter's queue).
  const stage = { ...base.stage, rank: (u: UnitId) => rankOf(r.journal.view, base.stage.plan(), u) };
  const w = { ...base, stage };
  return { ctx: { ...stage, acquireFirst: w.arbiter.acquireFirst }, w };
}

/** Unit `id` of the plan in force (one an apply added included). */
export const unitInForce = (r: ArcRun, id: string): PlanUnit => {
  const u = requirePlanInForce(r.ctx.runDir, r.journal.view).plan.units.find((x) => x.id === id);
  if (u === undefined) throw new Error(`no unit ${id} in the plan in force`);
  return u;
};

export type WalkAnswerSpec = Readonly<{
  journeys?: readonly Readonly<{ journey: string; outcome: 'completed' | 'blocked'; evidence?: readonly string[] }>[];
  findings?: readonly Readonly<{ class: 'breaks' | 'deviates'; journey: string; claim: string; cause: string; against: JsonValue; paths?: readonly string[]; evidence?: readonly string[] }>[];
  polish?: readonly Readonly<{ journey: string; text: string; unit: Readonly<{ id: string; scope: readonly string[]; spec: JsonValue }> }>[];
}>;

/** The file a fake walk keeps its fetch of J-1's entry in (relative to the evidence dir). */
export const J1_EVIDENCE = 'j1-response.txt';

/** A walkthrough's answer: both journeys completed citing J1_EVIDENCE by default. */
export function walkAnswer(spec: WalkAnswerSpec = {}): JsonValue {
  const value = {
    final: true,
    journeys: (spec.journeys ?? [{ journey: 'J-1', outcome: 'completed' }, { journey: 'J-2', outcome: 'completed' }])
      .map((j) => ({ journey: j.journey, outcome: j.outcome, evidence: [...(j.evidence ?? [J1_EVIDENCE])], note: `${j.journey} walked` })),
    findings: (spec.findings ?? []).map((f) => ({
      class: f.class, journey: f.journey, evidence: [...(f.evidence ?? [J1_EVIDENCE])], claim: f.claim, cause: f.cause, against: f.against, paths: [...(f.paths ?? [])],
    })),
    polish: (spec.polish ?? []).map((p) => ({ journey: p.journey, evidence: [J1_EVIDENCE], text: p.text, unit: { id: p.unit.id, scope: [...p.unit.scope], spec: p.unit.spec } })),
    premises: [],
    reasons: ['scripted walk'],
  } as unknown as JsonValue;
  validateWalkthroughOutput(value);
  return value;
}

/** Walk round 1's answer: J-1 is blocked by the 500 it fetched (a P1). */
export const BROKEN_WALK = walkAnswer({
  journeys: [{ journey: 'J-1', outcome: 'blocked' }, { journey: 'J-2', outcome: 'completed' }],
  findings: [{ class: 'breaks', journey: 'J-1', claim: 'GET / answers 500 instead of the greeting', cause: 'GET /: server error when no greeting is configured', against: { type: 'journey' }, paths: ['product/server.js'] }],
});

/** The acting judge's argv, as every walk step expects it: a shell, project settings, no MCP server for shell journeys. */
export const ACTING_ARGV = ['-p', '--strict-mcp-config', '--setting-sources', 'project', '--tools', 'Read,Grep,Glob,Bash,Write,Edit,Agent', '--permission-mode', 'bypassPermissions', '--session-id'];

/** A walkthrough call of walk `job`: it fetches J-1's entry into its evidence dir, then answers `answer`. */
export function walkStep(job: string, answer: JsonValue, extra: readonly ClaudeAct[] = []): Step {
  return {
    as: 'claude', unit: job,
    expect: { argv: ACTING_ARGV, argvLacks: ['--mcp-config', '--resume'], stdinContains: ['<evidence_dir>'] },
    acts: [
      { type: 'fetchFromPrompt', pattern: '(http://127\\.0\\.0\\.1:[0-9]+/)', dirPattern: '<evidence_dir>([^<]+)</evidence_dir>', file: J1_EVIDENCE },
      ...extra,
      { type: 'emit', value: answer },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------
// Agent D: polish proposals and polish units (test/polish-loop.test.ts, the probe's polish.compare row)

export const SCOPE = ['design/**', 'product/**'];
/** A polish proposal on J-1 whose unit is u1's spec renamed (its lanes), scope the reference and the product. */
export function proposal(d: Readonly<{ planPath: string }>, id: string, text: string, extra: Json = {}) {
  const u1 = JSON.parse(readFileSync(join(d.planPath, '..', 'u1.json'), 'utf8')) as Json;
  return { journey: 'J-1', text, unit: { id, scope: SCOPE, spec: admitSpecWire({ ...u1, unit: id, rev: 1, scope: SCOPE, ...extra }) } };
}

/** The build of polish unit `unit` (risk high: the efficient class since dev.17, Codex under the default profile): it commits `files`. */
export const polishBuild = (unit: string, files: Readonly<Record<string, string>>): Step => ({
  as: 'codex', unit, expect: { argv: ['exec', '-C'] },
  acts: [{ type: 'commit', message: `polish ${unit}`, files }, { type: 'emit', value: BUILD_REPORT }],
});
export const polishSteps = (unit: string, files: Readonly<Record<string, string>>): readonly Step[] => [
  { ...planCheckStep({ decision: 'approve', risk: 'high' }), unit }, polishBuild(unit, files), { ...gateStep({ decision: 'approve' }), unit },
];

/** tw-keep's build: the greeting configured, and the reference says so. */
export const KEEP_FILES = { 'design/README.md': '# Greeter design\n\n## Errors\n\nAn error names what failed and how to fix it.\n\n## Greeting\n\nThe greeting ends with a newline.\n', 'product/greeting.txt': 'hello\n' };
