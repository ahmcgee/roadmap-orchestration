// The M4a paid fixture (evals/m4a/{setup,driver,check}.ts) validated end to end without paying: the session is the
// scripted root agent (evals/m4a/fake-root.ts) replaying the golden Phase-0 outputs through the staged plugin's real
// CLI, against the fake backends (evals/m4a/scenario.ts) and the fake gh over a local bare origin; real processes,
// real git, the real supervisor, real node-test witness lanes over the product's journeys. Two scripts run side by
// side: `story` (bootstrap, arc 1 with the pack-review hold, a witness fix round, an in-session assessment and a smoke
// survivor, the cutoff question, arc 2 with the mid-arc policy flip, an opportunity admit and a converted one, a pause in
// a hung lane and the lane reuse after it, arc 3 refused at K, stop k-limit) and `vision-silent` (arc 1, then no slice
// candidate, stop vision-silent). The story synchronises on events, never on time, so its turns are the same every run.
// Named tests: evals-m4a.setup-valid, evals-m4a.fake, evals-m4a.intake-filtering, evals-m4a.pack-review-hold,
// evals-m4a.amendments-debt, evals-m4a.policy-flip, evals-m4a.k-limit, evals-m4a.brief, evals-m4a.check-oracle,
// evals-m4a.adjudication-tree, evals-m4a.rerun-refused, evals-m4a.vision-silent, evals-m4a.witness-missing,
// evals-m4a.in-session-smoke, evals-m4a.opportunity, evals-m4a.lane-reuse-after-pause, evals-m4a.untrusted-start,
// evals-m4a.owner-questions, evals-m4a.owner-code-answers, evals-m4a.wake-key, skill.operator-log-format.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { type ArcRef, amendmentsOf } from '../src/chain.ts';
import { captureIssues } from '../src/commands/issues.ts';
import type { Event, Fact, Parent } from '../src/core/events.ts';
import { arcId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { parseDebtBlock } from '../src/docs/debt.ts';
import { readStore, writeStore } from './fakes/gh-store.ts';
import { verdictProblems, stageTree } from '../evals/m4a/adjudicate.ts';
import { type CheckResult, CRITERIA, LEVERS, arcView, chainOf, parseOperatorLog } from '../evals/m4a/check.ts';
import { type OwnerCtx, type Report, codeAnswer, ghOnPath, launchEnv, numberedQuestions, prepareFake, stagePlugin } from '../evals/m4a/driver.ts';
import { itemKey } from '../src/watch.ts';
import { fakeArc, fakeHostDir, prepareArc1 } from '../evals/m4a/fake-root.ts';
import { FILES, LANES, SLOW_LANE, corpusFor, rawCorpus } from '../evals/m4a/golden.ts';
import { DRIFT_CHECKPOINT } from '../evals/m4a/scenario.ts';
import { type ArcView, defectVerdicts, matches, readKey, spanPresent } from '../evals/m4a/key.ts';
import { INJECTION_MARKER, layout } from '../evals/m4a/layout.ts';
import { ANSWER_KEY, needles, toolTraffic } from '../evals/m4a/transcript.ts';
import { type Exit, runUntilExit } from './helpers/proc.ts';
import { type RunScope, assertNoSurvivors, teardown, track } from './helpers/reap.ts';
import { tmpDir } from './helpers/repo.ts';

after(assertNoSurvivors);

const EVALS = fileURLToPath(new URL('../evals/m4a/', import.meta.url));
/** The driver's fake session timeout is 30 min; the test allows it that and a margin. */
const RUN_MS = 35 * 60_000;
const T = { timeout: 2 * RUN_MS };
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));

/** stage-cli.ts's leading arguments: the staged plugin and the fixture's host dir. */
const STAGE_ARGS = (dir: string, host: string): readonly string[] => [layout(dir).plugin, host];

const script = (name: string, args: readonly string[]): Promise<Exit> => runUntilExit(process.execPath, [join(EVALS, name), ...args], { env: ENV, timeoutMs: RUN_MS });

type Checked = Readonly<{ exit: Exit; result: CheckResult }>;

async function check(dir: string): Promise<Checked> {
  const exit = await script('check.ts', [dir]);
  const [line, notExercised] = exit.stdout.split('\n');
  assert.ok(line !== undefined && notExercised !== undefined, `check printed: ${exit.stdout}; stderr: ${exit.stderr}`);
  const result = JSON.parse(line) as CheckResult;
  assert.equal(notExercised, `NOT EXERCISED: ${result.notExercised.join(', ')}`);
  assert.equal(exit.code, result.pass ? 0 : 1, 'check exits non-zero exactly when a criterion fails');
  return { exit, result };
}
const failing = (c: Checked): readonly string[] => c.result.criteria.filter((x) => !x.pass).map((x) => x.name);

type Fixture = Readonly<{ dir: string; driver: Exit; report: Report; checked: Checked }>;

/** Sets up a fixture and runs the driver on fake `name` to its end; any arc left running is stopped. */
async function runFixture(name: 'story' | 'vision-silent'): Promise<Fixture> {
  const dir = join(tmpDir(`m4a-${name}`), 'fx');
  const setup = await script('setup.ts', [dir, ...(name === 'vision-silent' ? ['--vision-silent'] : [])]);
  assert.equal(setup.code, 0, setup.stderr);
  const host = fakeHostDir(dir);
  const scope: RunScope = {
    paths: [dir],
    stop: async () => {
      for (const n of [1, 2, 3]) {
        if (!existsSync(join(layout(dir).product, '.git', 'roadmap-runtime', fakeArc(dir, n)))) continue;
        await runUntilExit(process.execPath, [join(EVALS, 'stage-cli.ts'), ...STAGE_ARGS(dir, host), 'stop', '--repo', layout(dir).product, '--arc', fakeArc(dir, n)], { env: ENV, timeoutMs: 30_000 });
      }
    },
  };
  track(scope);
  const driver = await script('driver.ts', [dir, '--fake', name]).finally(() => teardown(scope));
  const report = JSON.parse(readFileSync(layout(dir).report, 'utf8')) as Report;
  return { dir, driver, report, checked: await check(dir) };
}

const journal = (dir: string, n: number): readonly Event[] => readJournal(absPath(join(layout(dir).product, '.git', 'roadmap-runtime', fakeArc(dir, n))), arcId(fakeArc(dir, n))).events;
type Seq<F> = F & { seq: number };
const factsOf = <K extends Fact['kind']>(events: readonly Event[], kind: K): readonly Seq<Extract<Fact, { kind: K }>>[] =>
  events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [{ ...(e.fact as Extract<Fact, { kind: K }>), seq: e.seq }] : []));
const raisedOf = (events: readonly Event[], reason: string, dir: string, n: number): readonly Readonly<{ id: string; seq: number }>[] =>
  events.flatMap((e) => {
    if (e.type !== 'intent' || e.kind !== 'needsuser.raise') return [];
    const file = JSON.parse(readFileSync(join(layout(dir).product, '.git', 'roadmap-runtime', fakeArc(dir, n), 'needs-user', `${e.expect.id}.json`), 'utf8')) as { reason: string };
    return file.reason === reason ? [{ id: e.expect.id as string, seq: e.seq }] : [];
  });

/** A unit's stage outcomes, `<stage>:<outcome>` in log order, and the facts themselves. */
const outcomesOf = (events: readonly Event[], unit: string): readonly Seq<Extract<Fact, { kind: 'stage-outcome' }>>[] => factsOf(events, 'stage-outcome').filter((f) => f.unit === unit);
const named = (o: readonly Readonly<{ stage: string; outcome: string }>[]): readonly string[] => o.map((f) => `${f.stage}:${f.outcome}`);
/** The `lane` spawns of `unit`'s lane `lane` (spec, suite or journey runs alike). */
const laneSpawns = (events: readonly Event[], unit: string, lane: string): readonly Event[] =>
  events.filter((e) => e.type === 'intent' && e.kind === 'proc.spawn' && JSON.stringify(e.expect).includes(`"unit":"${unit}"`) && (e.expect as { subject?: { purpose?: string; lane?: string } }).subject?.purpose === 'lane' && (e.expect as { subject: { lane?: string } }).subject.lane === lane);
/** One arc's fake backend calls, as calls.jsonl records them. */
const callsOf = (dir: string, n: number): readonly Readonly<{ step: number | null; unit: string | null; argv: readonly string[]; stdin: string }>[] =>
  readFileSync(join(layout(dir).fake, `arc-${n}`, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { step: number | null; unit: string | null; argv: string[]; stdin: string });
/** A stage parent's fields; any other parent is a bug in the story. */
const stageOf = (p: Parent): Extract<Parent, { type: 'stage' }> => {
  if (p.type !== 'stage') throw new Error(`not a stage parent: ${JSON.stringify(p)}`);
  return p;
};
const argAfter = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

/** Every step of each arc's fake scenario was played once, by a call that matched it. */
function assertEveryStepPlayed(dir: string, arcs: readonly number[]): void {
  for (const n of arcs) {
    const d = join(layout(dir).fake, `arc-${n}`);
    const calls = readFileSync(join(d, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { step: number | null });
    const steps = (JSON.parse(readFileSync(join(d, 'scenario.json'), 'utf8')) as { steps: unknown[] }).steps;
    assert.deepEqual(calls.filter((c) => c.step === null), [], `arc ${n}: no call went unmatched`);
    assert.deepEqual(calls.map((c) => c.step).sort((a, b) => a! - b!), steps.map((_, i) => i), `arc ${n}: every step played once`);
  }
}

/** Runs each journey once in `cwd`; its exit code by lane. */
function journeys(cwd: string): Readonly<Record<string, number | null>> {
  return Object.fromEntries(LANES.map((x) => [x.id, spawnSync('node', ['--test', x.journey], { cwd, env: ENV, encoding: 'utf8', timeout: 60_000 }).status]));
}

test('evals-m4a.setup-valid: the messy corpus hides its defects, the key\'s spans are planted, the product and its golden builds behave, the forge filters, and the stage carries no key and no fixture source', T, async () => {
  const dir = join(tmpDir('m4a-setup'), 'fx');
  const out = await script('setup.ts', [dir]);
  assert.equal(out.code, 0, out.stderr);
  const l = layout(dir);

  // The raw corpus: numbered docs, two same-named sub-folders, five ADRs, the vision; about 700 lines; no ids, no rules.
  const raw = rawCorpus();
  const paths = Object.keys(raw);
  assert.ok(paths.includes('0005_Vision.md'));
  assert.deepEqual(paths.filter((p) => p.startsWith('0070_ADRs/')).length, 5);
  for (const sub of ['0020_Berths', '0040_Notifications']) assert.ok(paths.includes(`${sub}.md`) && paths.some((p) => p.startsWith(`${sub}/`)), `${sub} has a same-named sub-folder`);
  const lines = Object.values(raw).join('').split('\n').length;
  assert.ok(lines >= 500 && lines <= 900, `the corpus is about 700 lines (${lines})`);
  for (const [p, text] of Object.entries(raw)) {
    assert.doesNotMatch(text, /```rules|\b[TVPIBM]-\d+\b/, `${p} carries no rules block and no id`);
    assert.doesNotMatch(text, /answer key|\bdefect|planted/i, `${p} names no defect`);
  }
  // Every span of the key is planted in the raw corpus; the golden curation keeps or drops it as the key expects.
  const key = readKey();
  const view = (files: Readonly<Record<string, string>>): ArcView => ({ files: new Map(Object.entries(files)) } as unknown as ArcView);
  for (const d of key.defects) {
    for (const p of d.postconditions) {
      const spans = p.type === 'absent' ? [p.span] : p.type === 'spans-at-most' ? p.spans : [];
      for (const s of spans) {
        assert.ok(spanPresent(view({ [s.file]: raw[s.file]! }), s), `${d.id}: the span of ${s.file} is planted`);
        assert.ok(!spanPresent(view(Object.fromEntries(Object.entries(raw).filter(([f]) => f !== s.file))), s), `${d.id}: only ${s.file} holds it`);
      }
    }
  }
  assert.equal(Object.keys(corpusFor(1)).length, paths.length, 'curation keeps every file');

  // The product: the suite is green at the seed and after each arc's golden builds; the journeys witness what the arcs need.
  const tree = join(tmpDir('m4a-product'), 'tree');
  cpSync(l.product, tree, { recursive: true });
  cpSync(join(FILES, 'golden', 'journeys'), join(tree, 'journeys'), { recursive: true });
  const suite = () => spawnSync('npm', ['test'], { cwd: tree, env: ENV, encoding: 'utf8', timeout: 120_000 });
  assert.equal(suite().status, 0, 'the seed suite is green');
  assert.deepEqual(journeys(tree), { tides: 0, berths: 1, confirm: 1, cutoff: 1, notice: 1 }, 'at the seed only the tide table holds');
  cpSync(join(FILES, 'units', 'guard-first'), tree, { recursive: true });
  assert.equal(suite().status, 0, 'guard\'s first attempt passes its unit tests');
  assert.equal(journeys(tree)['berths'], 1, 'but not the berths journey: its refusal does not name the vessel (the witness fix round)');
  for (const u of ['guard', 'confirm']) cpSync(join(FILES, 'units', u), tree, { recursive: true });
  assert.equal(suite().status, 0);
  assert.deepEqual(journeys(tree), { tides: 0, berths: 0, confirm: 0, cutoff: 1, notice: 1 }, 'arc 1 delivers I-1 and I-2');
  for (const u of ['cutoff', 'notice', 'fits']) cpSync(join(FILES, 'units', u), tree, { recursive: true });
  assert.equal(suite().status, 0);
  assert.deepEqual(journeys(tree), { tides: 0, berths: 0, confirm: 0, cutoff: 0, notice: 0 }, 'arc 2 delivers I-4 and I-5, and the opportunity breaks none');

  // The forge: trusted; the capture keeps issues #1 and #2 and the author's comment, drops the stranger's and the PR entry.
  const before = process.env['PATH'];
  process.env['PATH'] = `${l.forgeBin}:${before ?? ''}`;
  let captured: Awaited<ReturnType<typeof captureIssues>>;
  try {
    captured = await captureIssues({ repo: absPath(l.product), out: null });
  } finally {
    process.env['PATH'] = before;
  }
  assert.ok(captured.kind === 'captured');
  assert.deepEqual(captured.capture.issues.map((i) => [i.id, i.comments.length]), [['issue-1', 0], ['issue-2', 1]]);
  assert.deepEqual(captured.capture.filtered, { comments: 1, pullRequests: 1 });
  assert.ok(!JSON.stringify(captured.capture).includes(INJECTION_MARKER), 'the injection never reaches a capture');
  assert.ok(readFileSync(l.store, 'utf8').includes(INJECTION_MARKER), 'the store holds it');

  // The stage: the plugin without evals/ or test/, nothing in it naming the key, this fixture's sources or this repository.
  stagePlugin(l);
  for (const p of ['executor/evals', 'executor/test', 'executor/node_modules']) assert.ok(!existsSync(join(l.plugin, p)), `the stage lacks ${p}`);
  for (const p of ['executor/bin/roadmap', 'executor/src/cli/main.ts', 'skills/orchestrate/SKILL.md']) assert.ok(existsSync(join(l.plugin, p)), `the stage holds ${p}`);
  assert.ok(!ANSWER_KEY.startsWith(l.dir));
  for (const e of readdirSync(l.stage, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.parentPath.includes('/.git')) continue;
    const text = readFileSync(join(e.parentPath, e.name), 'utf8');
    for (const n of needles()) assert.ok(!text.includes(n), `${join(e.parentPath, e.name)} names ${n}`);
  }
  // The launch env: denied keys dropped, config dirs emptied, the fake gh first.
  const env = launchEnv(l, { PATH: '/usr/bin:/bin', HOME: '/home/x', GH_TOKEN: 't', GITHUB_TOKEN: 't', SSH_AUTH_SOCK: '/s', AWS_SECRET_ACCESS_KEY: 's', GOOGLE_APPLICATION_CREDENTIALS: '/g', ANTHROPIC_API_KEY: 'a' });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'PATH', 'XDG_CONFIG_HOME']);
  assert.equal(ghOnPath(l, env), join(l.forgeBin, 'gh'));
});

describe('evals-m4a: the fake-backed session, story and vision-silent side by side', () => {
  let story: Fixture;
  let silent: Fixture;
  let arc1: readonly Event[];
  let arc2: readonly Event[];

  before(async () => {
    [story, silent] = await Promise.all([runFixture('story'), runFixture('vision-silent')]);
    arc1 = journal(story.dir, 1);
    arc2 = journal(story.dir, 2);
  }, T);

  test('evals-m4a.fake: the story stops k-limit after two chained arcs, every scenario step played, and every criterion passes', () => {
    const { driver, report, checked } = story;
    assert.equal(driver.code, 0, `driver: ${driver.stdout} ${driver.stderr}`);
    assert.deepEqual([report.endedBy, report.stopReason, report.failure], ['stopped', 'k-limit', null]);
    assert.deepEqual(report.turns.map((t) => t.kind), ['start', 'owner', 'wake', 'wake', 'owner', 'wake', 'wake', 'owner', 'wake', 'wake']);
    // Each wake carries exactly the events the story synchronises on (paid run 10 batch: two events 3.7 s apart against
    // the 3 s debounce once made an extra wake); the same lines every run, whatever the timing.
    const wakes = report.turns.filter((t) => t.kind === 'wake').map((t) => t.prompt.split('\n').slice(1).map((x) => {
      const e = JSON.parse(x) as { event: string; reason?: string; run?: string };
      return e.event === 'needs-user' ? `needs-user:${e.reason}` : `${e.event}:${e.run}`;
    }).sort());
    assert.deepEqual(wakes, [
      ['needs-user:pack-review'], ['units:complete'],
      ['units:blocked'], ['needs-user:issue-policy-untrusted'], ['needs-user:divergence-digest', 'units:held'], ['units:complete'],
    ]);
    assert.deepEqual(checked.result.interventions, { n: 1, byLever: { pause: 1 }, malformed: [] }, 'the one intervention, logged once');
    assert.deepEqual(report.owner.map((o) => [o.by, o.answer]), [
      ['code', 'K = 1.'], ['code', 'Yes, I accept that slice.'],
      ['simulator', (JSON.parse(readFileSync(ANSWER_KEY, 'utf8')) as { ownerAnswers: { answer: string }[] }).ownerAnswers[0]!.answer],
      ['code', 'Done: issue creation is restricted to collaborators again.'],
    ]);
    assert.deepEqual(failing(checked), [], JSON.stringify(checked.result.criteria));
    assert.equal(checked.result.criteria.length, CRITERIA.length);
    assertEveryStepPlayed(story.dir, [1, 2]);
  });

  test('evals-m4a.intake-filtering: every capture drops the stranger\'s comment and the PR entry; each checkpoint takes in each issue once', () => {
    for (const events of [arc1, arc2]) {
      const captured = factsOf(events, 'issues-captured');
      assert.ok(captured.length >= 2);
      for (const c of captured) assert.deepEqual(c.filtered, { comments: 1, pullRequests: 1 });
      const intake = factsOf(events, 'issue-intake');
      assert.deepEqual(intake.map((x) => `${x.job}/${x.issue}`), captured.flatMap((c) => [`${c.job}/issue-1`, `${c.job}/issue-2`]));
    }
    const p0 = arcView(chainOf(absPath(layout(story.dir).product)).one!).phase0;
    assert.deepEqual(p0.intake.map((x) => [x.issue, x.outcome.type]), [['issue-1', 'acted'], ['issue-2', 'none']], 'Phase 0 acted on the bug through guard');
  });

  test('evals-m4a.pack-review-hold: review-1\'s blocking finding holds admission until the fixed pack\'s review-2 supersedes it', () => {
    const started = factsOf(arc1, 'pack-review-started');
    const ended = factsOf(arc1, 'pack-review-ended');
    assert.deepEqual(started.map((s) => s.job), ['review-1', 'review-2']);
    assert.notEqual(started[0]!.key, started[1]!.key, 'the apply changed the required-review key');
    assert.deepEqual(ended.map((e) => [e.job, e.findings.map((f) => f.severity)]), [['review-1', ['blocking']], ['review-2', ['note']]]);
    const [item] = raisedOf(arc1, 'pack-review', story.dir, 1);
    assert.ok(item !== undefined && item.seq > ended[0]!.seq, 'the blocking finding raised one item');
    const fix = factsOf(arc1, 'plan-applied').find((p) => p.source?.type === 'command');
    assert.ok(fix !== undefined && fix.seq > item.seq && fix.seq < started[1]!.seq, 'the root agent\'s apply came between the item and review-2');
    const dispatch = factsOf(arc1, 'dispatch');
    assert.ok(dispatch.length > 0 && dispatch.every((d) => d.seq > ended[1]!.seq), 'nothing was admitted before review-2 ended');
    assert.deepEqual(factsOf(arc1, 'needs-user-acked').filter((a) => a.id === item.id), [], 'review-2 superseded the item: nobody acked it');
  });

  test('evals-m4a.amendments-debt: arc 1 banks a gate note and a deferred finding and derives two amendments; arc 2 dispositions all four', () => {
    assert.deepEqual(factsOf(arc1, 'corpus-amendment').map((a) => a.source.type).sort(), ['checkpoint', 'issue']);
    assert.deepEqual(factsOf(arc1, 'debt-banked').map((d) => d.bankReason).sort(), ['finding-deferred', 'gate-note']);
    const { one, two } = chainOf(absPath(layout(story.dir).product));
    const p0 = arcView(two!).phase0;
    assert.deepEqual(p0.amendments.map((a) => a.id), amendmentsOf(one!).map((a) => a.id));
    assert.deepEqual(p0.amendments.map((a) => a.disposition.type).sort(), ['applied', 'deferred']);
    assert.deepEqual(p0.debt.map((d) => d.disposition.type).sort(), ['keep', 'promote']);
    const head = (r: ArcRef) => spawnSync('git', ['-C', layout(story.dir).product, 'show', `${r.view.holistic().completion!.head}:.roadmap/debt.md`], { encoding: 'utf8' }).stdout;
    const ledger = parseDebtBlock(head(two!));
    assert.ok(ledger !== null);
    assert.deepEqual(ledger.items.map((i) => [i.bankReason, i.state]).sort(), [['finding-deferred', 'promoted'], ['gate-note', 'open']]);
  });

  test('evals-m4a.policy-flip: the flip mid-arc holds admission and the checkpoint uncaptured until the owner fixed the policy and the root agent acked', () => {
    assert.ok(story.report.devices.policyFlip !== null && story.report.devices.policyFix !== null);
    const [item] = raisedOf(arc2, 'issue-policy-untrusted', story.dir, 2);
    assert.ok(item !== undefined, 'the checkpoint capture raised the blocking item');
    assert.equal(raisedOf(arc2, 'issue-policy-untrusted', story.dir, 2).length, 1, 'raised once');
    const ack = factsOf(arc2, 'needs-user-acked').find((a) => a.id === item.id);
    assert.ok(ack !== undefined && ack.seq > item.seq);
    const between = (seq: number) => seq > item.seq && seq < ack.seq;
    assert.deepEqual(factsOf(arc2, 'checkpoint-inputs').filter((f) => between(f.seq)), [], 'no checkpoint captured while it was open');
    assert.deepEqual(factsOf(arc2, 'issues-captured').filter((f) => between(f.seq)), []);
    // While it was open, status showed the arc-wide hold: the root agent's last status read before its ack.
    const traffic = toolTraffic(layout(story.dir).transcript);
    const acked = traffic.findIndex((t) => t.kind === 'tool_use' && t.text.includes(`roadmap ack ${item.id}`));
    assert.ok(acked >= 0, 'the root agent acked the item');
    const status = traffic.findLastIndex((t, i) => i < acked && t.kind === 'tool_use' && t.text.includes('roadmap status') && t.text.includes(fakeArc(story.dir, 2)));
    assert.ok(status >= 0, 'the root agent read status on the item');
    assert.match(traffic[status + 1]!.text, /\\"holds\\":\[\\"issue-policy-untrusted\\"\]/, 'admission was held arc-wide');
    const notice = factsOf(arc2, 'dispatch').filter((d) => d.record.unit === 'notice');
    assert.ok(notice.length > 0 && notice.every((d) => d.seq > ack.seq), 'notice was admitted only after the ack');
    assert.ok(factsOf(arc2, 'checkpoint-inputs').some((f) => f.seq > ack.seq), 'the checkpoint captured after the ack');
    // The audit of cutoff waited for the root agent's blocked wake, so the item came after that wake's turn.
    const blockedTurn = story.report.turns.find((t) => t.kind === 'wake' && t.prompt.includes('"run":"blocked"'));
    assert.ok(blockedTurn !== undefined && traffic.some((t) => t.turn === blockedTurn.n && t.kind === 'tool_use' && t.text.includes('roadmap status')), 'the blocked wake read status');
  });

  test('evals-m4a.k-limit: with K = 1 and arc 2 unacked, arc 3 is refused chain-invalid{limit} at phase0 check and at start', () => {
    const traffic = toolTraffic(layout(story.dir).transcript);
    const startArc3 = traffic.findIndex((t) => t.kind === 'tool_use' && t.text.includes('roadmap start') && t.text.includes(fakeArc(story.dir, 3)));
    assert.ok(startArc3 >= 0, 'the session tried arc 3\'s start');
    const refused = traffic[startArc3 + 1]!;
    assert.match(refused.text, /chain-invalid/);
    assert.match(refused.text, /\\"limit\\"|"limit"/);
    assert.equal(chainOf(absPath(layout(story.dir).product)).arcs.length, 2, 'no third arc started');
  });

  test('evals-m4a.brief: the brief spans both arcs, K = 1 with arc 2 unacked, and carries the amendments, intake, debt and P-1', () => {
    const l = layout(story.dir);
    // check.ts restored the scrambled live files (K20) after its from-ref check; the brief reads the committed config.
    assert.equal(spawnSync('git', ['-C', l.product, 'status', '--porcelain', '--', ...story.report.scrambled], { encoding: 'utf8' }).stdout.trim(), '', 'check.ts restored every scrambled path');
    const env = { ...ENV, PATH: `${l.forgeBin}:${ENV['PATH'] ?? ''}` };
    const r = spawnSync(process.execPath, [join(EVALS, 'stage-cli.ts'), ...STAGE_ARGS(story.dir, fakeHostDir(story.dir)), 'brief', '--repo', l.product, '--json'], { env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const { payload } = JSON.parse(r.stdout) as { payload: { chain: { k: number; unackedStarts: string[] }; arcs: { arc: string; amendments: unknown[]; intake: unknown[]; questions: { id: string; state: { type: string } }[]; debt: { banked: unknown[]; dispositioned: unknown[] }; pr: { type: string } }[] } };
    assert.deepEqual(payload.chain.k, 1);
    assert.deepEqual(payload.chain.unackedStarts, [fakeArc(story.dir, 2)]);
    const [one, two] = payload.arcs;
    assert.equal(one!.amendments.length, 2);
    assert.equal(one!.debt.banked.length, 2);
    assert.equal(two!.debt.dispositioned.length, 2);
    assert.ok(one!.intake.length >= 2 && two!.intake.length >= 2);
    assert.deepEqual(two!.questions.map((q) => [q.id, q.state.type]), [['P-1', 'answered']]);
    assert.deepEqual(payload.arcs.map((a) => a.pr.type), ['pr', 'pr']);
  });

  test('evals-m4a.check-oracle: each defect\'s postconditions fail on a pin, census or record mutated against that defect alone', () => {
    const { one, two } = chainOf(absPath(layout(story.dir).product));
    const a1 = arcView(one!);
    const a2 = arcView(two!);
    const key = readKey();
    assert.deepEqual(defectVerdicts(key, { 1: a1, 2: a2 }).filter((d) => !d.pass), [], 'the golden arcs satisfy the key');
    const census = (v: ArcView, rule: string, state: string): ArcView => ({ ...v, obligations: { ...v.obligations, census: v.obligations.census!.map((e) => (e.rule === rule ? { rule: e.rule, state: { type: state } } : e)) as never } });
    const mutations: Readonly<Record<string, () => Readonly<{ 1: ArcView; 2: ArcView }>>> = {
      D1: () => ({ 1: { ...a1, pin: { ...a1.pin, rules: [...a1.pin.rules, { ...a1.pin.rules[0]!, id: 'T-99' as never, text: 'The tide table alone gives every window.' }] } }, 2: a2 }),
      D2: () => ({ 1: { ...a1, obligations: { ...a1.obligations, obligations: a1.obligations.obligations.map((o) => (o.id === 'I-2' ? { ...o, activation: 'must-hold' as const, deliveredBy: [] } : o)) } }, 2: a2 }),
      D3: () => ({ 1: { ...a1, phase0: { ...a1.phase0, corpusDivergences: [] } }, 2: a2 }),
      D4: () => ({ 1: a1, 2: { ...a2, pin: { ...a2.pin, rules: [...a2.pin.rules, { ...a2.pin.rules[0]!, id: 'T-98' as never, text: 'A booking may be cancelled until 24 hours before its window.' }] } } }),
      D5: () => ({ 1: { ...a1, files: new Map([...a1.files, ['0050_Architecture.md', rawCorpus()['0050_Architecture.md']!]]) }, 2: a2 }),
      D6: () => ({ 1: census(a1, 'T-2', 'out-of-slice'), 2: a2 }),
      D7: () => ({ 1: census(a1, 'T-14', 'untestable'), 2: a2 }),
    };
    for (const d of key.defects) {
      const mutate = mutations[d.id];
      assert.ok(mutate !== undefined, `a mutation for ${d.id}`);
      assert.deepEqual(defectVerdicts(key, mutate()).filter((v) => !v.pass).map((v) => v.id), [d.id], `the ${d.id} mutation fails ${d.id} alone`);
    }
    // D2 names the booking-by-text claim only: a template rule and a cancellation-by-text rule beside it (paid run 4) match nothing.
    const rule = (id: string, text: string) => ({ ...a1.pin.rules[0]!, id: id as never, text });
    const siblings = { 1: { ...a1, pin: { ...a1.pin, rules: [...a1.pin.rules, rule('T-97', 'A booking confirmation text reads as the Booking confirmed template, filled in.'), rule('T-96', 'Every cancellation that goes through is confirmed by a text to the vessel\'s phone.')] } }, 2: a2 };
    assert.deepEqual(defectVerdicts(key, siblings).filter((v) => !v.pass).map((v) => v.id), []);
    // D2 and D7 do not own deduplication (D1 does): a claim split into two rules passes when each holds; D2 fails if any split half is must-hold.
    const split = (v: ArcView, id: string, copy: string, text: string): ArcView => ({
      ...v, pin: { ...v.pin, rules: [...v.pin.rules, { ...v.pin.rules[0]!, id: copy as never, text }] },
      obligations: { ...v.obligations, census: [...v.obligations.census!, { ...v.obligations.census!.find((e) => e.rule === id)!, rule: copy as never }] },
    });
    const d2 = a1.pin.rules.find((r) => matches([['booking'], ['confirm'], ['text', 'sms']], r.text) && !/cancel|template/i.test(r.text))!;
    const d7 = a1.pin.rules.find((r) => matches([['backed up', 'backup', 'back up', 'backs up'], ['night']], r.text))!;
    const twoText = split(a1, d2.id, 'T-95', 'A booking\'s confirmation text goes out within a minute.');
    const twoBackup = split(a1, d7.id, 'T-94', 'The ledger can be restored from last night\'s backup.');
    assert.deepEqual(defectVerdicts(key, { 1: twoBackup, 2: a2 }).filter((v) => !v.pass).map((v) => v.id), []);
    assert.deepEqual(defectVerdicts(key, { 1: twoText, 2: a2 }).filter((v) => !v.pass).map((v) => v.id), []);
    const halfMustHold = { ...twoText, obligations: { ...twoText.obligations, obligations: twoText.obligations.obligations.map((o) => ({ ...o, activation: 'must-hold' as const, deliveredBy: [] })) } };
    assert.ok(defectVerdicts(key, { 1: halfMustHold, 2: a2 }).some((v) => v.id === 'D2' && !v.pass), 'D2 still fails when the split claim is must-hold');
    // D5's curation matches the file in either form: repo-relative (under the pin's source root) or corpus-root-relative.
    const root = a1.pin.source.root as string;
    const repoRel = { ...a1, phase0: { ...a1.phase0, curation: a1.phase0.curation.map((c) => ({ ...c, files: c.files.map((f) => (f.startsWith(root) ? f : `${root}/${f}`)) as never })) } };
    assert.deepEqual(defectVerdicts(key, { 1: repoRel, 2: a2 }).filter((v) => !v.pass), []);
    // D4's arc-1 half too: P-1 answered already in arc 1.
    const early = { 1: { ...a1, phase0: { ...a1.phase0, questions: a1.phase0.questions.map((q) => ({ ...q, state: { type: 'answered' as const, answer: '48', at: q.id as never } })) } }, 2: a2 };
    assert.deepEqual(defectVerdicts(key, early).filter((v) => !v.pass).map((v) => v.id), ['D4']);
  });

  test('evals-m4a.adjudication-tree: the adjudicator\'s tree holds the run\'s evidence and nothing that names the key or this repository', () => {
    const tree = join(tmpDir('m4a-adjudication'), 'tree');
    stageTree(story.dir, tree);
    for (const d of ['vision', 'raw-corpus', 'curated-corpus', 'extraction', 'plan', 'product', 'witness/runs']) assert.ok(existsSync(join(tree, d)), `the tree holds ${d}`);
    assert.ok(existsSync(join(tree, 'product', 'src', 'confirm.js')), 'the product snapshot is arc 1\'s head');
    assert.ok(!existsSync(join(tree, 'product', '.git')));
    for (const e of readdirSync(tree, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const text = readFileSync(join(e.parentPath, e.name), 'utf8');
      for (const n of needles()) assert.ok(!text.includes(n), `${join(e.parentPath, e.name)} names ${n}`);
    }
    const item = (rubric: string) => ({ rubric, verdict: 'meets', evidence: [{ path: 'a', quote: 'b' }], findings: [] });
    const ok = { items: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'].map(item), overall: 'fine' };
    assert.deepEqual(verdictProblems(ok), []);
    assert.equal(verdictProblems({ ...ok, items: ok.items.slice(1) }).length, 1, 'all seven, once each');
    assert.ok(verdictProblems({ ...ok, extra: 1 }).length > 0, 'closed');
    assert.ok(verdictProblems({ ...ok, items: [{ ...item('R1'), verdict: 'great' }, ...ok.items.slice(1)] }).length > 0);
  });

  test('evals-m4a.rerun-refused: setup and the driver refuse a fixture dir that was used', async () => {
    const setup = await script('setup.ts', [story.dir]);
    assert.notEqual(setup.code, 0);
    assert.match(setup.stderr, /is not empty/);
    const driver = await script('driver.ts', [story.dir, '--fake', 'story']);
    assert.notEqual(driver.code, 0);
    assert.match(driver.stderr, /a fixture dir is run once/);
  });

  test('evals-m4a.vision-silent: after arc 1, phase0 check offers no slice candidate and the session stops vision-silent', () => {
    const { driver, report, checked } = silent;
    assert.equal(driver.code, 0, `driver: ${driver.stdout} ${driver.stderr}`);
    assert.deepEqual([report.endedBy, report.stopReason], ['stopped', 'vision-silent']);
    assertEveryStepPlayed(silent.dir, [1]);
    const chain = chainOf(absPath(layout(silent.dir).product));
    assert.equal(chain.arcs.length, 1);
    const pass = checked.result.criteria.filter((c) => c.pass).map((c) => c.name);
    assert.deepEqual(pass, ['isolation', 'intake-filtered', 'arc1-complete', 'brief-acked-once', 'no-model-ids', 'host-released', 'profile'], 'the paid run\'s criteria that need a second arc or the k-limit stop fail here');
    assert.match(checked.result.criteria.find((c) => c.name === 'stopped-at-k')!.detail, /vision-silent/);
  });

  test('evals-m4a.witness-missing: guard\'s first build passes its unit lane but fails the berths witness, so a fix round naming the test comes before any gate', () => {
    const guard = outcomesOf(arc1, 'guard');
    assert.deepEqual(named(guard).filter((o) => /^(lanes|gate|build|plan-check):/.test(o)), ['plan-check:approve', 'build:success', 'lanes:witnesses-missing', 'build:success', 'lanes:green', 'gate:approve']);
    const missing = guard.find((o) => o.outcome === 'witnesses-missing')!;
    assert.deepEqual(missing.detail, { kind: 'witnesses-missing', missing: [], failed: [{ lane: 'berths', testId: LANES.find((x) => x.id === 'berths')!.test }] });
    // The fix round's call is the scenario's resume step that expects the failing id in its prompt (every step played once).
    const calls = callsOf(story.dir, 1).filter((c) => c.unit === 'guard');
    assert.equal(calls.length, 4, 'plan-check, build, the witness fix round, gate');
    assert.match(calls[2]!.stdin, /Failing: test "a berth is never booked twice for one tide window" on lane berths/);
    assert.match(calls[2]!.stdin, /witness-check --lane-file/, 'the fix round names the witness check command');
  });

  test('evals-m4a.in-session-smoke: confirm (frontier) makes no plan-check call, assesses and implements in one session; smoke finds W-1 surviving, one fix round, then the gate', () => {
    const confirm = outcomesOf(arc1, 'confirm');
    assert.deepEqual(named(confirm).filter((o) => /^(lanes|gate|build|plan-check):/.test(o)), [
      'plan-check:in-session', 'build:success', 'lanes:smoke-survived', 'build:success', 'lanes:smoke-survived', 'gate:approve',
    ]);
    const calls = callsOf(story.dir, 1).filter((c) => c.unit === 'confirm');
    assert.equal(calls.length, 4, 'assess, implement, the smoke fix round, gate: no plan-check call');
    const session = argAfter(calls[0]!.argv, '--session-id');
    assert.ok(session !== undefined && !calls[0]!.argv.includes('--tools'));
    assert.deepEqual([argAfter(calls[1]!.argv, '--resume'), argAfter(calls[2]!.argv, '--resume')], [session, session], 'one session: implement and the fix round resume the assessment');
    assert.ok(calls[3]!.argv.includes('--tools'), 'the gate still runs');
    const tides = { lane: 'tides', testId: LANES.find((x) => x.id === 'tides')!.test };
    const ran = factsOf(arc1, 'smoke-ran').filter((f) => f.unit === 'confirm');
    assert.equal(ran.length, 2);
    for (const r of ran) assert.deepEqual(r.verdict, { killed: [{ lane: 'confirm', testId: LANES.find((x) => x.id === 'confirm')!.test }], survived: [tides], inconclusive: [] });
    assert.equal(ran[0]!.key, ran[1]!.key, 'the fix round left the production change as it was: the allowance reused the first run');
    const mutants = arc1.filter((e) => e.type === 'intent' && e.kind === 'mutant.apply');
    assert.equal(mutants.length, 1, 'one smoke execution');
    // The fix round changed nothing, so the second lanes attempt reused the unit lane's pass at the same commit.
    assert.equal(factsOf(arc1, 'lane-reused').filter((f) => stageOf(f.parent).unit === 'confirm').length, 1);
    assert.deepEqual(confirm.find((o) => o.outcome === 'smoke-survived')!.detail, { kind: 'smoke-survived', obligations: [], testIds: [tides] });
  });

  test('evals-m4a.opportunity: arc 2\'s checkpoint admits fits as the opportunity O-1 (V-7 joins advances) and converts the over-budget day view into an amendment, which arc 3 applies as T-17', () => {
    const bundle = factsOf(arc2, 'plan-applied').find((p) => p.source?.type === 'bundle');
    assert.ok(bundle !== undefined && bundle.source?.type === 'bundle');
    assert.deepEqual(bundle.source.admits, [{ index: 0, unit: 'fits', class: { type: 'opportunity', id: 'O-1', clauses: ['V-7'] } }]);
    assert.deepEqual(bundle.source.conversions, [{ index: 1, unit: 'dayview', reason: 'over-budget', opportunity: null }]);
    const [amendment] = factsOf(arc2, 'corpus-amendment');
    assert.deepEqual(amendment?.source, { type: 'admit', job: 'ckpt-1', index: 1, reason: 'over-budget' });
    assert.deepEqual(named(outcomesOf(arc2, 'fits')).filter((o) => o.startsWith('ff:')), ['ff:published'], 'fits merged');
    assert.deepEqual(named(outcomesOf(arc2, 'dayview')), [], 'the converted unit never ran');
    const two = chainOf(absPath(layout(story.dir).product)).two!;
    assert.deepEqual(two.plan.holistic?.advances, ['V-5', 'V-7'], 'the opportunity\'s clause joined the slice in force');
    // The bundle's drift audit and its checkpoint ran before notice was admitted (the root agent waited on them).
    const drift = factsOf(arc2, 'checkpoint-inputs').find((f) => f.job === DRIFT_CHECKPOINT)!;
    assert.ok(factsOf(arc2, 'dispatch').filter((d) => d.record.unit === 'notice').every((d) => d.seq > drift.seq));
    const arc3 = JSON.parse(readFileSync(join(layout(story.dir).inputs, fakeArc(story.dir, 3), 'phase0.json'), 'utf8')) as { amendments: { id: string; disposition: unknown }[] };
    assert.equal(amendmentsOf(two).length, 1);
    assert.deepEqual(arc3.amendments, amendmentsOf(two).map((a) => ({ id: a.id, disposition: { type: 'applied', rules: ['T-17'] } })), 'arc 2\'s one amendment, the converted admit');
  });

  test('evals-m4a.lane-reuse-after-pause: the root agent pauses notice in its hung slow lane and resumes it; the resumed attempt reuses the unit lane\'s pass and logs one intervention', () => {
    const notice = outcomesOf(arc2, 'notice');
    assert.deepEqual(named(notice).filter((o) => o.startsWith('lanes:')), ['lanes:interrupted', 'lanes:green']);
    const [first, second] = notice.filter((o) => o.stage === 'lanes');
    const reused = factsOf(arc2, 'lane-reused').filter((f) => stageOf(f.parent).unit === 'notice');
    assert.deepEqual(reused.map((f) => [f.lane, stageOf(f.parent).attempt, stageOf(f.from.parent).attempt]), [['confirm-unit', second!.attempt, first!.attempt]]);
    assert.equal(laneSpawns(arc2, 'notice', 'confirm-unit').length, 1, 'the unit lane ran once');
    assert.equal(laneSpawns(arc2, 'notice', SLOW_LANE.id).length, 2, 'the slow lane ran twice: killed by the pause, then passed');
    const traffic = toolTraffic(layout(story.dir).transcript).filter((t) => t.kind === 'tool_use');
    const pause = traffic.find((t) => t.text.includes('roadmap pause notice'));
    const resume = traffic.find((t) => /roadmap resume --repo/.test(t.text));
    assert.ok(pause !== undefined && resume !== undefined && resume.turn === pause.turn + 1, 'paused in one turn, resumed on the next wake');
    const log = parseOperatorLog(readFileSync(join(layout(story.dir).inputs, 'skill-feedback.md'), 'utf8'));
    assert.deepEqual(log, { n: 1, byLever: { pause: 1 }, malformed: [] });
  });
});

test('skill.operator-log-format: reference.md\'s operator-log example parses with check.ts\'s parser, every lever in the closed list', () => {
  const ref = readFileSync(fileURLToPath(new URL('../../skills/orchestrate/reference.md', import.meta.url)), 'utf8');
  const section = ref.slice(ref.indexOf('\n## The operator log\n'));
  const block = /```operator-log\n([\s\S]*?)\n```/.exec(section);
  assert.ok(block !== null, 'an operator-log fenced block under "The operator log"');
  const parsed = parseOperatorLog(block[1]!);
  assert.equal(parsed.n, 1);
  assert.deepEqual(parsed.malformed, []);
  for (const lever of Object.keys(parsed.byLever)) assert.ok((LEVERS as readonly string[]).includes(lever));
});

test('evals-m4a.untrusted-start: under PUBLIC + ALL, phase0 check and start refuse issue-policy-untrusted before anything runs', T, async () => {
  const dir = join(tmpDir('m4a-untrusted'), 'fx');
  const out = await script('setup.ts', [dir]);
  assert.equal(out.code, 0, out.stderr);
  const l = layout(dir);
  stagePlugin(l);
  prepareFake(l);
  const pathBefore = process.env['PATH'];
  process.env['PATH'] = launchEnv(l, process.env)['PATH'];
  let plan: string;
  try {
    plan = prepareArc1(dir);
  } finally {
    process.env['PATH'] = pathBefore;
  }
  writeStore(l.store, { ...readStore(l.store), policy: { visibility: 'PUBLIC', hasIssuesEnabled: true, issueCreationPolicy: 'ALL' } });
  const env = { ...ENV, PATH: `${join(l.fake, 'arc-1', 'bin')}:${l.forgeBin}:${ENV['PATH'] ?? ''}` };
  const cli = (args: readonly string[]) => spawnSync(process.execPath, [join(EVALS, 'stage-cli.ts'), ...STAGE_ARGS(dir, fakeHostDir(dir)), ...args], { env, encoding: 'utf8', timeout: 300_000 });
  const p0 = cli(['phase0', 'check', '--repo', l.product, '--plan', plan]);
  assert.equal(p0.status, 78, p0.stderr);
  assert.deepEqual((JSON.parse(p0.stdout) as { rows: unknown[] }).rows, [{ kind: 'issue-policy-untrusted', visibility: 'PUBLIC', policy: 'ALL' }]);
  const scope: RunScope = { paths: [dir], stop: async () => {} };
  track(scope);
  const start = cli(['start', '--repo', l.product, '--plan', plan, '--profile', 'default']);
  await teardown(scope);
  assert.equal(start.status, 78, `${start.stdout} ${start.stderr}`);
  assert.match(start.stdout, /issue-policy-untrusted/);
  assert.ok(!existsSync(join(l.fake, 'arc-1', 'calls.jsonl')), 'no backend was called');
});

test('evals-m4a.owner-questions (paid run 1): the owner simulator gets the final text\'s last numbered block only, never a status list or a brief\'s numbered lines before it', () => {
  const text = [
    '1. **Status:** three units are merged.',
    '2. **The crash:** ckpt-8 proposed C-2.',
    '```',
    '# Roadmap brief 0cd1e8d2b06a8a32',
    '- #1 P-5: gateway outbox file format?',
    '1. not a question either',
    '```',
    '## Questions',
    '',
    '1. **P-5:** what file format does the gateway read?',
    '   *If no view: one JSON file per text.*',
    '2. Do you acknowledge brief `0cd1e8d2b06a8a32`?',
  ].join('\n');
  assert.deepEqual(numberedQuestions(text), [
    '1. **P-5:** what file format does the gateway read? *If no view: one JSON file per text.*',
    '2. Do you acknowledge brief `0cd1e8d2b06a8a32`?',
  ]);
  assert.deepEqual(numberedQuestions('Arc started; waiting on watch.'), []);
});

test('evals-m4a.owner-code-answers (paid run 2): a brief-ack question naming `k-limit` is not the K question; K is asked case-sensitively', () => {
  const c = {} as OwnerCtx; // neither question below reaches the forge branch
  assert.equal(codeAnswer(c, 'Do you acknowledge brief a636215e877ff428? If you do, I can chain a third arc. If you have no view, the chain stops after arc 2 (`k-limit`).'), 'I have not read the brief yet; do not acknowledge it.');
  assert.equal(codeAnswer(c, 'K: how many arcs may I run past your last acknowledged brief?'), 'K = 1.');
  assert.equal(codeAnswer(c, 'How many arcs may I run past your last acknowledged brief before I stop and wait (K)? Working assumption: 1.'), 'K = 1.');
  assert.equal(codeAnswer(c, 'Should the cut-off be checked against k-limit style rules?'), null);
});

test('evals-m4a.wake-key (paid run 2): needs-user ids are arc-scoped, so an id reused by the next arc still wakes the session', () => {
  assert.notEqual(itemKey('no-double-promise', 'nu-31'), itemKey('berth-that-fits', 'nu-31'));
});
