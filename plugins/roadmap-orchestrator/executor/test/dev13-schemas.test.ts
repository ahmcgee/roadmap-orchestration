// dev.13 contracts (SCHEMAS.md "dev.13: milestone walkthroughs and design units"): the ids, the plan's milestones with
// their defaults and refusals, the polish origin, the vision's experience kind, the walk facts and their reader and fold
// rules, the walkthrough and polish-judge answers, the walk roles in force only under milestones (routing revs of an arc
// without them unchanged), the repo config's walkthrough MCP servers and the acting-judge argv. Behaviour is not here.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Envelope, type Event, type Fact, type LogRecord, parseEventLine, prevHash, serializeEvent } from '../src/core/events.ts';
import { InvalidIdError, arcId, canonicalIds, jobId, journeyId, milestoneId, polishId, sha, sha256, visionClauseId } from '../src/core/ids.ts';
import { Fold } from '../src/core/state.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath, isoTime } from '../src/core/values.ts';
import { ARC as LOG_ARC, chain } from './fixtures/log-records.ts';
import { DEFAULT_WALK_ROUNDS, type PlanM1, designUnitOf, hasMilestones, milestonesOf, parsePlan, walkRoundsOf } from '../src/input/plan.ts';
import { parseVision } from '../src/holistic/types.ts';
import { backendArgv, freshJudgmentSession } from '../src/backends/argv.ts';
import { validatePolishJudgeOutput, validateWalkthroughOutput } from '../src/prompts/schemas.ts';
import { arcRolesInForce, arcStack, parseRepoConfig, planStack, resolveRouting, seatsInForce, unsupportedSeats } from '../src/routing/layers.ts';
import { ACTING_ROLES, FRESH_ROLES, ROLES } from '../src/routing/types.ts';
import { ORIGIN_RANK } from '../src/schedule/types.ts';

const A = sha('a'.repeat(40));
const H = sha256('d'.repeat(64));
const AT = isoTime('2026-10-18T12:00:00.000Z');

const envelope = (seq: number): Envelope => ({ v: 1, seq, prev: seq === 1 ? null : H, at: AT, arc: arcId('arc-3') });
function roundTrip(record: LogRecord): Event {
  const e = { ...envelope(2), ...record } as Event;
  const line = serializeEvent(e);
  const back = parseEventLine(line.slice(0, -1));
  assert.deepEqual(back, e);
  return back;
}
const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const refuses = (record: LogRecord, field: RegExp): void =>
  assert.throws(() => roundTrip(record), (err: unknown) => err instanceof SchemaError && field.test(err.field), JSON.stringify(record));

const unit = (id: string, after: string[] = []) => ({ id, spec: `specs/${id}.json`, risk: 'med', scope: [`src/${id}/**`], resources: [], after, contingent: [] });
const MILESTONE = {
  id: 'MS-1', text: 'A visitor signs up and sees their dashboard.', units: ['u1', 'u2'], design: { unit: 'd1' }, references: ['design/web'],
  bringUp: {
    setup: [['npm', 'ci']], serve: [{ name: 'web', argv: ['node', 'server.js', '--port', '{port:web}'], ready: { http: 'http://127.0.0.1:{port:web}/health' } }],
    env: { API_URL: 'http://127.0.0.1:{port:web}' }, seed: [['node', 'seed.js']],
  },
  journeys: [
    { id: 'J-1', text: 'I sign up and land on my dashboard.', via: 'browser', entry: '/signup', budget: { steps: 6, seconds: 90 } },
    { id: 'J-2', text: 'I run the CLI with no arguments.', via: 'shell', entry: 'node cli.js', budget: null },
  ],
  resources: [],
};
const PLAN = {
  schema: 'roadmap/plan-m1', arc: 'arc-1', integrationBranch: 'main', baseline: A, worktreeRoot: '/var/tmp/wt', contracts: [], rulings: 'rulings.md',
  architectureDoc: 'docs/arch.md', direction: 'd', suite: { lanes: [] }, resources: [], units: [unit('d1'), unit('u1', ['d1']), unit('u2', ['d1'])],
  holistic: { vision: 'vision.json', advances: ['V-1'] },
};
const withMilestone = (m: object, plan: object = PLAN) => ({ ...plan, milestones: [{ ...MILESTONE, ...m }] });
const refusedAt = (plan: unknown, field: RegExp): void =>
  assert.throws(() => parsePlan(plan), (err: unknown) => err instanceof SchemaError && field.test(err.field), JSON.stringify(plan).slice(0, 80));

describe('dev.13 ids', () => {
  it('milestones are MS-n, journeys J-n, polish proposals X-n, in the canonical numbered order; walk jobs walk-n', () => {
    assert.equal(milestoneId('MS-12'), 'MS-12');
    for (const bad of ['M-1', 'MS-0', 'ms-1', 'MS1']) assert.throws(() => milestoneId(bad), InvalidIdError, bad);
    assert.throws(() => journeyId('J-01'), InvalidIdError);
    assert.throws(() => polishId('P-1'), InvalidIdError);
    assert.deepEqual(canonicalIds([milestoneId('MS-10'), milestoneId('MS-9')]), ['MS-9', 'MS-10']);
    assert.deepEqual(canonicalIds([polishId('X-2'), polishId('X-1')]), ['X-1', 'X-2']);
    assert.equal(jobId('walk', 3), 'walk-3');
  });
});

describe('dev.13 plan: milestones', () => {
  it('absent: none, three walk rounds, no walk roles; present: read as written, walkRounds from limits', () => {
    const none = parsePlan(PLAN);
    assert.deepEqual([milestonesOf(none), hasMilestones(none), walkRoundsOf(none), DEFAULT_WALK_ROUNDS], [[], false, 3, 3]);
    const plan = parsePlan({ ...withMilestone({}), limits: { walkRounds: 2 } });
    assert.deepEqual(plan.milestones, [MILESTONE]);
    assert.equal(walkRoundsOf(plan), 2);
    assert.equal(designUnitOf(plan.milestones![0]!), 'd1');
    assert.equal(designUnitOf(parsePlan(withMilestone({ design: { supplied: true } })).milestones![0]!), null);
  });

  it('refuses unknown units and design units, a design unit in its own milestone or not planned, no journeys or references, unknown resources and ports', () => {
    refusedAt(withMilestone({ units: ['u1', 'nope'] }), /^plan\.milestones\[0\]\.units\[1\]$/);
    refusedAt(withMilestone({ design: { unit: 'nope' } }), /\.design\.unit$/);
    refusedAt(withMilestone({ units: ['u1', 'd1'] }), /\.design\.unit$/);
    refusedAt(withMilestone({}, { ...PLAN, units: [{ ...unit('d1'), origin: 'checkpoint' }, unit('u1', ['d1']), unit('u2', ['d1'])] }), /\.design\.unit$/);
    refusedAt(withMilestone({ journeys: [] }), /\.journeys$/);
    refusedAt(withMilestone({ references: [] }), /\.references$/);
    refusedAt(withMilestone({ resources: ['db'] }), /\.resources\[0\]$/);
    refusedAt(withMilestone({ bringUp: { ...MILESTONE.bringUp, env: { API: '{port:api}' } } }), /\.bringUp\.env\.API$/);
    refusedAt(withMilestone({ journeys: [{ ...MILESTONE.journeys[0], entry: 'http://127.0.0.1:{port:api}/' }] }), /\.journeys\[0\]\.entry$/);
    refusedAt(withMilestone({ units: [] }), /\.units$/);
    refusedAt(withMilestone({ bringUp: { ...MILESTONE.bringUp, serve: [{ name: 'web', argv: ['x'], ready: { http: 'u', log: 'l' } }] } }), /\.ready$/);
    refusedAt({ ...PLAN, milestones: [] }, /^plan\.milestones$/);
    // Journey ids are unique across the plan's milestones, so a journey alone names its milestone.
    refusedAt({ ...PLAN, milestones: [MILESTONE, { ...MILESTONE, id: 'MS-2' }] }, /journeys/);
    refusedAt({ ...PLAN, milestones: [MILESTONE, { ...MILESTONE, journeys: [{ ...MILESTONE.journeys[0], id: 'J-9' }] }] }, /^plan\.milestones\[1\]$/);
  });

  it('a polish unit carries its milestone and proposal, and only a polish unit does; it ranks after checkpoint units', () => {
    const polish = { ...unit('tweak'), origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-1' } };
    const plan: PlanM1 = parsePlan({ ...PLAN, units: [...PLAN.units, polish] });
    assert.deepEqual(plan.units.at(-1)?.polish, { milestone: 'MS-1', proposal: 'X-1' });
    refusedAt({ ...PLAN, units: [...PLAN.units, { ...polish, polish: undefined }] }, /\.polish$/);
    refusedAt({ ...PLAN, units: [...PLAN.units, { ...unit('tweak'), polish: polish.polish }] }, /\.polish$/);
    assert.ok(ORIGIN_RANK.repair < ORIGIN_RANK.checkpoint && ORIGIN_RANK.checkpoint < ORIGIN_RANK.polish && ORIGIN_RANK.polish < ORIGIN_RANK.planned);
  });
});

describe('dev.13 vision', () => {
  it('an experience clause reads; nothing requires one', () => {
    const v = {
      schema: 'roadmap/vision-m3', rev: 1, confirmation: null, questions: [],
      clauses: [{ id: 'V-1', kind: 'world', text: 'w', rank: null, state: 'active' }, { id: 'V-2', kind: 'experience', text: 'No error leaves the user guessing.', rank: null, state: 'active' }],
    };
    assert.deepEqual(parseVision(v).clauses[1]?.kind, 'experience');
  });
});

describe('dev.13 facts', () => {
  const finding = (f: Record<string, unknown>) => fact(Object.fromEntries(Object.entries({
    kind: 'finding-opened', id: 'F-1', key: H, lens: 'walkthrough', severity: 'P1', obligation: null, visionClauses: [], claim: 'The form posts to a 404.', evidence: [],
    mutant: null, source: { type: 'job', job: 'walk-1' }, gateHadPassed: false, milestone: 'MS-1', ...f,
  }).filter(([, v]) => v !== undefined)));

  it('a walkthrough finding names its milestone, is P1 or P2, from a walk job or (P1) the demo; no other finding names a milestone', () => {
    roundTrip(finding({}));
    roundTrip(finding({ severity: 'P2', obligation: 'I-1' }));
    roundTrip(finding({ source: { type: 'demo', sha: A } }));
    refuses(finding({ milestone: undefined }), /\.milestone$/);
    refuses(finding({ severity: 'P3' }), /\.severity$/);
    refuses(finding({ severity: 'P2', source: { type: 'demo', sha: A } }), /\.source$/);
    refuses(finding({ source: { type: 'job', job: 'audit-1' } }), /\.source\.job$/);
    refuses(finding({ lens: 'invariants' }), /\.milestone$/);
    refuses(finding({ lens: 'invariants', milestone: undefined, source: { type: 'demo', sha: A } }), /\.source$/);
  });

  it('each walk fact round-trips; its rules refuse what cannot be', () => {
    roundTrip(fact({ kind: 'walk-started', job: 'walk-1', milestone: 'MS-1', round: 1, sha: A, ports: { api: 4101, web: 4100 } }));
    roundTrip(fact({ kind: 'walk-ended', job: 'walk-1', outcome: 'reported', findings: ['F-1', 'F-2'], proposals: ['X-1', 'X-2'], dropped: ['X-2'] }));
    roundTrip(fact({ kind: 'walk-ended', job: 'walk-2', outcome: 'bring-up-failed', findings: ['F-3'], proposals: [], dropped: [] }));
    roundTrip(fact({
      kind: 'polish-proposed', id: 'X-1', job: 'walk-1', milestone: 'MS-1', journey: 'J-1', evidence: ['j1.png'], text: 'Tighten the card gutter to the token.',
      unit: { id: 'tweak-gutter', scope: ['design/web/**', 'src/web/card.css'], spec: '{}' },
    }));
    roundTrip(fact({ kind: 'tweak-judged', unit: 'tweak-gutter', decision: 'keep', reason: 'judged' }));
    roundTrip(fact({ kind: 'milestone-passed', milestone: 'MS-1', job: 'walk-2' }));
    roundTrip(fact({ kind: 'demo-promoted', milestone: 'MS-1', sha: A }));
    roundTrip(fact({ kind: 'demo-failed', milestone: 'MS-1', sha: A, log: '/run/demo/up.log' }));
    refuses(fact({ kind: 'walk-started', job: 'flow-1', milestone: 'MS-1', round: 1, sha: A, ports: {} }), /\.job$/);
    refuses(fact({ kind: 'walk-started', job: 'walk-1', milestone: 'MS-1', round: 1, sha: A, ports: { web: 0 } }), /\.ports\.web$/);
    refuses(fact({ kind: 'walk-ended', job: 'walk-1', outcome: 'reported', findings: [], proposals: ['X-1'], dropped: ['X-2'] }), /\.dropped\[0\]$/);
    refuses(fact({ kind: 'walk-ended', job: 'walk-1', outcome: 'bring-up-failed', findings: [], proposals: [], dropped: [] }), /\.findings$/);
    refuses(fact({ kind: 'walk-ended', job: 'walk-1', outcome: 'abandoned', findings: [], proposals: ['X-1'], dropped: [] }), /\.proposals$/);
    refuses(fact({ kind: 'tweak-judged', unit: 'tweak-gutter', decision: 'keep', reason: 'reference-untouched' }), /\.decision$/);
  });

  it('the fold holds a walk to one start and end, its proposals to id order and to its open walk, a pass and a judgment to once', () => {
    const fold = (records: readonly object[]): Fold => {
      const f = new Fold(LOG_ARC);
      for (const e of chain(records.map(fact))) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
      return f;
    };
    const started = { kind: 'walk-started', job: 'walk-1', milestone: 'MS-1', round: 1, sha: A, ports: {} };
    const proposed = (id: string, job = 'walk-1') => ({
      kind: 'polish-proposed', id, job, milestone: 'MS-1', journey: 'J-1', evidence: ['e.png'], text: 't', unit: { id: `t-${id.toLowerCase()}`, scope: ['design/**'], spec: '{}' },
    });
    const ended = (proposals: string[]) => ({ kind: 'walk-ended', job: 'walk-1', outcome: 'reported', findings: [], proposals, dropped: [] });
    const passed = { kind: 'milestone-passed', milestone: 'MS-1', job: 'walk-1' };
    const f = fold([started, proposed('X-1'), proposed('X-2'), ended(['X-1', 'X-2']), passed]);
    assert.deepEqual(f.walkFacts().map((x) => x.fact.kind), ['walk-started', 'polish-proposed', 'polish-proposed', 'walk-ended', 'milestone-passed']);
    assert.equal(f.nextPolishId(), 'X-3');
    assert.equal(f.nextJobId('walk'), 'walk-2');
    assert.throws(() => fold([{ ...started, job: 'walk-2' }]), /next walk job is walk-1/);
    assert.throws(() => fold([started, proposed('X-2')]), /next polish id is X-1/);
    assert.throws(() => fold([proposed('X-1')]), /not a started, unended walk/);
    assert.throws(() => fold([started, proposed('X-1'), ended([])]), /names proposals/);
    assert.throws(() => fold([started, ended([]), proposed('X-1')]), /not a started, unended walk/);
    assert.throws(() => fold([started, passed]), /has not ended/);
    assert.throws(() => fold([started, ended([]), passed, passed]), /a second milestone-passed/);
    const judged = { kind: 'tweak-judged', unit: 't-x-1', decision: 'drop', reason: 'judged' };
    assert.throws(() => fold([judged, judged]), /a second tweak-judged/);
  });
});

describe('dev.13 answers: walkthrough and polish judge', () => {
  const report = (o: object = {}) => ({
    final: true,
    journeys: [{ journey: 'J-1', outcome: 'completed', evidence: ['j1.png'], note: 'done in 4 steps' }],
    findings: [{
      class: 'deviates', journey: 'J-1', evidence: ['j1.png'], claim: 'The card gutter is 13 px.', cause: 'card gutter', against: { type: 'design', path: 'design/web/tokens.json', anchor: 'space.3' },
      paths: ['src/web/card.css'],
    }],
    polish: [], premises: [], reasons: ['J-1 completes'], ...o,
  });
  const refusedReport = (o: object, field: RegExp): void =>
    assert.throws(() => validateWalkthroughOutput(report(o)), (err: unknown) => err instanceof SchemaError && field.test(err.field));

  it('reads a report; breaks cites the journey or a floor, deviates the design, the vision or a floor', () => {
    const r = validateWalkthroughOutput(report());
    assert.equal(r.findings[0]?.against.type, 'design');
    const floor = { type: 'floor', text: 'Body text keeps 4.5:1 contrast.', source: 'V-3' };
    assert.deepEqual(validateWalkthroughOutput(report({ findings: [{ ...report().findings[0], class: 'breaks', against: floor }] })).findings[0]?.against, { ...floor, source: visionClauseId('V-3') });
    refusedReport({ findings: [{ ...report().findings[0], class: 'breaks' }] }, /\.findings\[0\]\.against$/);
    refusedReport({ findings: [{ ...report().findings[0], against: { type: 'journey' } }] }, /\.findings\[0\]\.against$/);
    refusedReport({ findings: [{ ...report().findings[0], journey: 'J-2' }] }, /\.findings\[0\]\.journey$/);
  });

  it('a blocked journey has a breaks finding on it; journeys once; final true only; polish is a unit with an admit spec', () => {
    refusedReport({ journeys: [{ journey: 'J-1', outcome: 'blocked', evidence: [], note: 'n' }] }, /\.journeys\[0\]\.outcome$/);
    refusedReport({ journeys: [report().journeys[0], report().journeys[0]] }, /\.journeys\[1\]$/);
    refusedReport({ final: false }, /\.final$/);
    const spec = {
      schema: 'roadmap/spec-m1', unit: 'tweak-gutter', rev: 1, lanes: [], acceptance: [{ id: 'A1', clause: 'The card gutter uses space.3.', failLoudIfUndelivered: false, state: 'active' }], scope: ['src/web/**'],
      resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] }, obligations: [], repairs: [],
    };
    const polish = { journey: 'J-1', evidence: ['j1.png'], text: 'Use space.3 for the card gutter.', unit: { id: 'tweak-gutter', scope: ['design/web/**', 'src/web/**'], spec } };
    const read = validateWalkthroughOutput(report({ polish: [polish] }));
    assert.equal(typeof read.polish[0]?.unit.spec, 'string', 'the spec is read into spec.json text');
    refusedReport({ polish: [{ ...polish, unit: { ...polish.unit, spec: { ...spec, schema: 'nope' } } }] }, /\.spec/);
  });

  it('the polish judge keeps or drops with evidence and reasons', () => {
    assert.equal(validatePolishJudgeOutput({ final: true, decision: 'drop', evidence: ['before.png', 'after.png'], reasons: ['after is worse'], premises: [] }).decision, 'drop');
    assert.throws(() => validatePolishJudgeOutput({ final: true, decision: 'drop', evidence: [], reasons: ['r'], premises: [] }), /evidence/);
  });
});

describe('dev.13 roles and routing', () => {
  const vision = { vision: 'vision.json', advances: [visionClauseId('V-1')] } as const;
  const doc = { target: 'architecture-doc', holistic: vision } as const;
  const corpus = { target: 'corpus', holistic: { advances: vision.advances } } as const;
  const milestones = parsePlan(withMilestone({})).milestones!;

  it('fresh and acting roles partition the roles', () => {
    assert.deepEqual([...FRESH_ROLES, ...ACTING_ROLES].sort(), [...ROLES].sort());
  });

  it('without milestones no walk seat is in force and every routing rev is unchanged; with them both walk seats are hashed', () => {
    const moved = { walkthrough: { arc: 'summit' }, polishJudge: { arc: 'efficient' } } as const;
    for (const plan of [doc, corpus]) {
      const off = resolveRouting(planStack('default', null, plan, 'm4b'));
      assert.ok(!seatsInForce(off).some((s) => s.role === 'walkthrough' || s.role === 'polishJudge'));
      assert.equal(resolveRouting(planStack('default', null, { ...plan, routing: moved }, 'm4b')).rev, off.rev, 'a walk seat moved changes no rev without milestones');
      const on = resolveRouting(planStack('default', null, { ...plan, milestones }, 'm4b'));
      assert.ok(on.milestones && seatsInForce(on).some((s) => s.role === 'walkthrough') && seatsInForce(on).some((s) => s.role === 'polishJudge'));
      assert.notEqual(on.rev, off.rev);
      assert.equal(on.table.walkthrough.arc.model, 'claude-opus-5-5');
      assert.deepEqual([on.classes.walkthrough.arc, on.classes.polishJudge.arc], ['frontier', 'frontier']);
    }
    assert.throws(() => arcRolesInForce('none', 'm4b', true), /outside a holistic arc/);
  });

  it('a Codex rebind of the walk seats is refused: Codex has no walkthrough prompt', () => {
    const config = parseRepoConfig({ routing: { classes: { frontier: { backend: 'codex', model: 'gpt-5.6-sol', effort: 'high' } } } });
    const r = resolveRouting(planStack('default', config, { ...corpus, milestones }, 'm4b'));
    const roles = unsupportedSeats(r, null).map((x) => (x.kind === 'unsupported-routing' ? `${x.role}:${x.why}` : x.kind));
    assert.ok(roles.includes('walkthrough:codex-judgment') && roles.includes('polishJudge:codex-judgment'), roles.join(' '));
  });

  it('the repo config names the walk MCP servers; args and env default to none', () => {
    const c = parseRepoConfig({ walkthrough: { mcp: { playwright: { command: 'playwright-mcp', args: ['--output-dir', '{evidence}', '--viewport-size', '{viewport}'] }, shell: { command: 'x', env: { A: '1' } } } } });
    assert.deepEqual(c.walkthrough?.mcp, {
      playwright: { command: 'playwright-mcp', args: ['--output-dir', '{evidence}', '--viewport-size', '{viewport}'], env: {} },
      shell: { command: 'x', args: [], env: { A: '1' } },
    });
    assert.equal(parseRepoConfig({}).walkthrough, undefined);
    assert.throws(() => parseRepoConfig({ walkthrough: { mcp: {} } }), (e: unknown) => e instanceof SchemaError && e.field === 'config.walkthrough.mcp');
    assert.throws(() => parseRepoConfig({ walkthrough: { mcp: { 'a b': { command: 'x' } } } }), (e: unknown) => e instanceof SchemaError && /a b/.test(e.field));
    assert.throws(() => parseRepoConfig({ walkthrough: { mcp: { p: { command: 'x', cwd: '/' } } } }), (e: unknown) => e instanceof SchemaError && /cwd/.test(e.field));
    assert.equal(arcStack('default', c, null).profile, 'default');
  });

  it('an acting judge acts: a shell, bypassPermissions, project settings, exactly its MCP servers, the system prompt appended', () => {
    const call = {
      kind: 'claude-acting-judge', role: 'walkthrough', triple: { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, session: freshJudgmentSession(),
      schemaText: '{}', system: 'SYS', mcpConfig: absPath('/run/inputs/abc.mcp.json'), evidenceDirs: [absPath('/run/evidence/jobs/walk-1')],
    } as const;
    const argv = backendArgv(call);
    const after = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
    assert.deepEqual([after('--tools'), after('--permission-mode'), after('--setting-sources'), after('--mcp-config'), after('--append-system-prompt')],
      ['Read,Grep,Glob,Bash,Write,Edit,Agent', 'bypassPermissions', 'project', '/run/inputs/abc.mcp.json', 'SYS']);
    assert.ok(argv.includes('--strict-mcp-config') && !argv.includes('--disable-slash-commands') && !argv.includes('--system-prompt'));
    assert.deepEqual(argv.slice(-2), ['--add-dir', '/run/evidence/jobs/walk-1']);
    const gate = backendArgv({ ...call, role: 'gate', mcpConfig: null });
    assert.ok(!gate.includes('--mcp-config') && gate.includes('--strict-mcp-config'), 'no servers: none load');
  });
});
