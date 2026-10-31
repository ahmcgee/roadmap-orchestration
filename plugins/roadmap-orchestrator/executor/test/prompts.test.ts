// Seat prompts (owner ruling 2026-10-17): these tests check the contract (inputs and data rendered, blocks omitted when
// their data is absent, the schema, tool-surface facts, invariants such as "the gate never receives the vision"), never
// method prose: how a seat reads, reports or delegates is the model's, and its wording is free to change.
import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { type Sha, arcId, clauseId, envId, findingId, givenId, invocationId, jobId, journeyId, laneId, laneRev, milestoneId, obligationId, opIdOf, polishId, proposalId, questionId, reviewFindingId, ruleId, rulingId, serveName, sha, sha256, specRev, stationId, systemName, unitId, visionClauseId, witnessItemId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { failureRef } from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath,isoTime,repoPath,repoPattern } from '../src/core/values.ts';

import type { BoundedDiff } from '../src/git/boundeddiff.ts';
import { type ObligationDef } from '../src/holistic/types.ts';
import { RESOLVE_DIRECTIVE,RESPEC_DIRECTIVE,RESPEC_FRESH_DIRECTIVE,STEER_DIRECTIVE,repeatRedDirective,resolveUnmetDirective,smokeFixDirectives,witnessFixDirectives } from '../src/prompts/directives.ts';
import { PROMPTS,SONNET_THINK_FIRST,UnsupportedPromptError,promptFor as livePromptFor,promptSize,renderPrompt,support } from '../src/prompts/index.ts';
import { ROLE_INPUTS,type RoleInputs,type GateInputs,type LensInputs,type WalkthroughInputs,type PolishJudgeInputs,UNIT_POLICY,laneCommand,obligationsText,pasted,pastedAs,targetDocument } from '../src/prompts/inputs.ts';
import { BUILD_SCHEMA, EXPERIENCE_SCHEMA, CLUSTER_REVIEWS, GATE_SCHEMA, ROLE_SCHEMAS, ROLE_VALIDATORS, validateBuildOutput, validateDecisionsFile, validateGateOutput, validatePackReviewOutput } from '../src/prompts/schemas.ts';
import { arcStack,resolveRouting,seatsInForce } from '../src/routing/layers.ts';
import { FRESH_ROLES,MODEL_IDS,PROFILES,ROLES,type Role,WALK_ROLES,atSeat } from '../src/routing/types.ts';

/**
 * The judging roles with a written Opus module and derived Sonnet and Haiku rows: the read-only ones (but the verifier, dev.17,
 * which has a Haiku module only), the gate (dev.13, an acting judge) and pre-build (dev.17, an acting judge).
 */
const modePrompts = new Map<string, unknown>();
function promptFor<R extends keyof TestInputs>(role: R, model: (typeof MODEL_IDS)[number]): {system: string; schema: JsonValue; fields: readonly string[]; render: (i: TestInputs[R]) => string} {
  if (role === 'gate') { const p = livePromptFor('verifier', model); const key = role + p.system; if (!modePrompts.has(key)) modePrompts.set(key, {...p, fields: Object.keys(SAMPLES.gate[0]), render: (i: GateInputs) => p.render({mode: 'gate', brief: i})}); return modePrompts.get(key) as ReturnType<typeof promptFor<R>>; }
  if (role === 'walkthrough' || role === 'polishJudge') { const p = livePromptFor('experienceVerdict', model); const key = role + p.system; if (!modePrompts.has(key)) modePrompts.set(key, {...p, fields: Object.keys(SAMPLES[role][0]), render: (i: WalkthroughInputs | PolishJudgeInputs) => p.render(role === 'walkthrough' ? {mode: 'walkthrough', brief: i as WalkthroughInputs} : {mode: 'polish', brief: i as PolishJudgeInputs})}); return modePrompts.get(key) as ReturnType<typeof promptFor<R>>; }
  if (role === 'lens') { const p = livePromptFor('campaignAudit', model); return {...p, render: (i) => {const {lens: _l, rulings: _r, index: _x, ...brief} = i as LensInputs; return p.render({...brief, method: {traits: [], markers: [], unitKind: 'milestone', expensiveLanes: false, ui: false}});}}; }
  return livePromptFor(role as Role, model) as {system: string; schema: JsonValue; fields: readonly string[]; render: (i: TestInputs[R]) => string};
}

const JUDGING = [...FRESH_ROLES, 'verifier'] as const;

// Two complete input sets per role that differ in every field, so swapping one field shows whether a
// module's rendering depends on it.
const spec = (rev: number, text: string) => ({ unit: unitId('u-one'), rev: specRev(rev), markdown: text });
const doc = (path: string, text: string) => ({ path: repoPath(path), text });
const ruling = (id: string, text: string) => ({ id: rulingId(id), text });
const lane = (id: string, argv: string[]) => ({
  id: laneId(id), argv, cwd: repoPath('.'), env: { set: { CI: '1' }, pass: [] }, expectedExit: 0, cadence: 'build' as const,
  resources: [], evidenceGlobs: [], evidenceExcludes: [],
});
const SHA_A = sha('a'.repeat(40));
const SHA_B = sha('b'.repeat(40));

const index = (c: string, r: string, ledger: string) => ({
  contracts: [{ path: repoPath(c), heading: `${c} heading` }], rulings: [{ id: rulingId(r), line: `${r} first sentence.` }], withdrawn: [], ledger: absPath(ledger),
});
const premise = (claim: string, path: string) => ({ claim, evidence: [{ path, line: 3 }] });

// M3: the vision, obligations and findings the arc roles (and pre-build and the gate) read.
const vision = (rev: number, text: string) => ({
  rev, clauses: [{ id: visionClauseId('V-1'), kind: 'world' as const, text, rank: null, state: 'active' as const }], questions: [], advances: [visionClauseId('V-1')],
});
const obligation = (id: string, statement: string): ObligationDef => ({
  id: obligationId(id), rev: 1, statement, docRef: { path: repoPath('docs/target.md'), anchor: '#a', quotedText: statement }, serves: [visionClauseId('V-1')],
  witness: { lane: laneId('journey'), testIds: ['t1'] }, proofJudgment: { verdict: 'proves', obligationRev: 1,  witness: {  testIds: ['t1'] } },
  deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' },
});
const observed = (id: string, statement: string, tree: typeof SHA_A) => ({
  obligation: obligation(id, statement), exempt: false, latched: false,
  observation: { key: { treeSha: tree, lane: laneId('journey'), laneRev: laneRev('0123456789abcdef'), envId: envId('fedcba9876543210') }, verdict: 'held' as const },
});
const packObligations = (cutLine: string) => ({
  schema: 'roadmap/obligations-m3' as const, cutLine, lanes: [], obligations: [], mapping: { systems: [] },
  census: [{ rule: ruleId('T-1'), state: { type: 'untestable' as const } }],
});
const pinnedRule = (id: string, text: string) => ({ id: ruleId(id), textSha256: sha256('c'.repeat(64)), text, file: repoPath('docs/0010.md'), section: 'Overview' });
const phase0Of = (why: string) => ({
  schema: 'roadmap/phase0-m4' as const, curation: [], corpusDivergences: [], questions: [], debt: [],
  slice: { advances: [visionClauseId('V-1')], why },
});
const corpusTarget = (dir: string, visionDoc: string | null) => ({
  kind: 'corpus' as const, dir: absPath(dir), visionDoc: visionDoc === null ? null : repoPath(visionDoc),
  rulesIndex: [
    pinnedRule('T-1', 'Amounts render with two decimals.'),
    { ...pinnedRule('T-2', 'Totals reconcile monthly.'), section: 'Reports' },
    { ...pinnedRule('T-3', 'Exports are CSV.'), file: repoPath('docs/0020.md'), section: null },
    pinnedRule('T-4', 'Amounts never round twice.'),
  ],
});
const unitCorpusTarget = (dir: string, visionDoc: string | null) => ({
  kind: 'unit-corpus' as const, dir: absPath(dir), visionDoc: visionDoc === null ? null : repoPath(visionDoc),
  rules: [pinnedRule('T-2', 'Totals reconcile monthly.')], others: 3,
});

const findingView = (id: string, claim: string) => ({
  id: findingId(id), lens: 'invariants' as const, severity: 'P1' as const, state: 'open' as const, obligation: obligationId('I-1'), claim, owner: null,
});

const journeySample = (k: 'A' | 'B') => ({
  id: journeyId(k === 'A' ? 'J-1' : 'J-2'), text: `JOURNEY-${k}`, via: k === 'A' ? 'browser' as const : 'shell' as const, entry: `/entry-${k}`,
  budget: k === 'A' ? { steps: 5, seconds: 60 } : null,
});
const instanceSample = (k: 'A' | 'B', port: number) => ({ checkout: absPath(`/wt/${k}.walk`), ports: { [serveName('web')]: port }, env: { MODE: k } });
const walkSample = (k: 'A' | 'B'): WalkthroughInputs => ({
  vision: vision(k === 'A' ? 1 : 2, `VISION-${k}`), milestone: { id: milestoneId(k === 'A' ? 'MS-1' : 'MS-2'), text: `MILESTONE-${k}` }, round: k === 'A' ? 1 : 2,
  journeys: [journeySample(k)], references: [doc(`design/${k}.md`, `REFERENCE-${k}`)],
  tweaks: [{ unit: unitId(`tweak-${k.toLowerCase()}`), proposal: polishId(k === 'A' ? 'X-1' : 'X-2'), text: `TWEAK-${k}` }],
  findings: [{ ...findingView(k === 'A' ? 'F-1' : 'F-2', `FINDING-${k}`), cause: `CAUSE-${k}` }], product: instanceSample(k, k === 'A' ? 4100 : 4200),
  units: [spec(k === 'A' ? 1 : 2, `SPEC-${k}`)], evidenceDir: absPath(`/run/evidence/jobs/walk-${k === 'A' ? 1 : 2}`),
});
const polishSample = (k: 'A' | 'B'): PolishJudgeInputs => ({
  vision: vision(k === 'A' ? 1 : 2, `VISION-${k}`), milestone: { id: milestoneId(k === 'A' ? 'MS-1' : 'MS-2'), text: `MILESTONE-${k}` }, journey: journeySample(k),
  proposal: { id: polishId(k === 'A' ? 'X-1' : 'X-2'), unit: unitId(`tweak-${k.toLowerCase()}`), text: `PROPOSAL-${k}`, evidence: [`shot-${k}.png`] },
  references: [doc(`design/${k}.md`, `REFERENCE-${k}`)], referenceDiff: k === 'A' ? shown(SHA_A, SHA_B, 'DIFF-A') : shown(SHA_B, SHA_A, 'DIFF-B'),
  walkEvidenceDir: absPath(`/run/evidence/jobs/walk-${k === 'A' ? 1 : 2}`),
  before: { ...instanceSample(k, k === 'A' ? 4101 : 4201), entry: `http://127.0.0.1:${k === 'A' ? 4101 : 4201}/` },
  after: { ...instanceSample(k, k === 'A' ? 4102 : 4202), entry: `http://127.0.0.1:${k === 'A' ? 4102 : 4202}/` },
  evidenceDir: absPath(`/run/evidence/jobs/cmp-${k}`),
});

// dev.13: a unit in two milestones (a member of MS-2, the design unit of MS-3), and a build's browser drive.
const milestonesSample = (): RoleInputs['build']['milestones'] => ({
  of: [
    { as: 'member', id: milestoneId('MS-2'), text: 'MEMBER-MILESTONE-B', dirs: [repoPath('design/b')] },
    { as: 'design', id: milestoneId('MS-3'), text: 'DESIGN-MILESTONE-B', dirs: [repoPath('design/b'), repoPath('design/b2')], journeys: [journeySample('A'), journeySample('B')] },
  ],
  references: [doc('design/b/DESIGN.md', 'REFERENCE-B'), doc('design/b2/tokens.json', 'TOKENS-B')], binary: [repoPath('design/b/WIRE-B.png')],
});
const browserSample = (): RoleInputs['build']['browser'] => ({
  servers: ['playwright'],
  bringUps: [{
    milestone: milestoneId('MS-2'),
    bringUp: {
      setup: [['npm', 'ci']], serve: [{ name: serveName('web'), argv: ['node', 'SERVER-B.js', '--port', '{port:web}'], ready: { http: 'http://127.0.0.1:{port:web}/health' } }],
      env: { MODE: 'BRINGUP-B' }, seed: [['node', 'SEED-B.js']],
    },
  }],
});

const flowSample = (k: 'A' | 'B'): RoleInputs['flow'] => {
  const n = k === 'A' ? 1 : 2;
  const lane = laneId(k === 'A' ? 'unit' : 'all');
  return {
    triggers: k === 'A' ? ['floor'] : ['buffer-red', 'requested'],
    chart: k === 'A' ? null : {
      centre: 3.2, ucl: 4.1, mrBar: 0.33, seed: { type: 'previous', arcs: [arcId('arc-one')], points: 12 },
      recent: [{ unit: unitId('u-two'), leadMin: 41, zone: 'yellow' }], inFlight: [{ unit: unitId('u-three'), ageMin: 90, zone: 'red' }],
    },
    stations: [{ station: stationId(k === 'A' ? 'stage:build' : 'suite:all'), meanMin: 10 * n, share: 0.2 * n, pressure: k === 'A' ? null : 0.31 }],
    constraint: k === 'A' ? { station: stationId('stage:build'), internal: false, component: null }
      : { station: stationId('slot:integration'), internal: true, component: stationId('suite:all') },
    accounting: { tAdvances: k === 'A' ? null : 0.5, tOther: k === 'A' ? null : 0.25, tUnits: n, wip: n + 1, oeUsdPerHour: 3 * n },
    levers: [{ lever: 'suite-lane', lane, argv: ['node', '--test', `--test-concurrency=${n}`], cpu: k === 'A' ? null : 4 }],
    givens: k === 'A' ? [] : [{ scope: 'host', id: givenId('G-1'), lever: 'concurrency', note: 'GIVEN-B', state: 'enforced' }],
    window: k === 'A' ? null : {
      proposal: proposalId('flow-1.0'), lever: 'suite-lane', target: stationId('suite:all'), metric: { type: 'suite-run', lane }, openedAt: isoTime('2026-10-08T00:00:00.000Z'), samples: 2,
    },
    verdicts: k === 'A' ? [] : [{ proposal: proposalId('flow-1.0'), lever: 'suite-lane', target: stationId('suite:all'), verdict: 'improved' }],
    rejections: k === 'A' ? [] : [{ key: { station: stationId('stage:build'), lever: 'build-class', target: { type: 'tier', tier: 'low' } }, proposal: proposalId('flow-2.0'), cause: 'rejected' }],
    advances: [{ id: visionClauseId(`V-${n}`), text: `ADVANCES-${k}` }],
    pressure: k === 'A' ? { now: null, threshold: 0.5, available: false, window: null, cpuInUse: 1, hostCpus: 4 }
      : { now: 0.41, threshold: 0.5, available: true, window: 0.33, cpuInUse: 7, hostCpus: 8 },
  };
};

/** A bounded diff shown whole: its stat, one file inlined as `text`, nothing else. */
const shown = (from: Sha, to: Sha, text: string): BoundedDiff => ({
  from, to, dir: absPath(`/run/diff-${text}`),
  orientation: {
    stat: { text: ` 1 file changed\n`, full: true }, moves: { shown: [], more: 0 }, deletions: { shown: [], more: 0, labelled: false },
    packages: { shown: [{ name: 'src', files: 1, added: 1, deleted: 0 }], more: 0 }, substitutions: [], explained: 0,
  },
  inlined: [{ path: repoPath('src/a.js'), kind: 'modified-source', representation: 'line', full: null }], text, omitted: { shown: [], more: 0 }, notInlined: [], overflow: 0,
});
/** A bounded diff with every part of its orientation and a cut listing. */
const partial = (from: Sha, to: Sha, text: string, labelled: boolean): BoundedDiff => {
  const d = shown(from, to, text);
  return {
    ...d,
    orientation: {
      stat: { text: `STAT-${text}`, full: false }, moves: { shown: [{ from: repoPath('src/old.js'), to: repoPath('src/new.js') }], more: 3 },
      deletions: {
        shown: [
          { path: repoPath('src/gone.js'), lines: 40, removes: null, diff: absPath(`${d.dir}/files/src/gone.js.diff`) },
          { path: repoPath('legacy/x.js'), lines: 1, removes: labelled ? 'legacy' : null, diff: absPath(`${d.dir}/files/legacy/x.js.diff`) },
        ],
        more: 0, labelled,
      },
      packages: { shown: [{ name: 'packages/core', files: 12, added: 300, deleted: 120 }], more: 4 },
      substitutions: [{ from: 'oldName', to: 'newName', count: 17 }], explained: 9,
    },
    omitted: {
      shown: [
        { path: repoPath('dist/b.js'), kind: 'derived', why: 'derived', bytes: 900, diff: absPath(`${d.dir}/files/dist/b.js.diff`) },
        { path: repoPath("src/it's.js"), kind: 'new-source', why: 'size', bytes: 200_000, diff: absPath(`${d.dir}/files/src/it's.js.diff`) },
      ],
      more: 2,
    },
    notInlined: [repoPath('dist/b.js'), repoPath('legacy/x.js'), repoPath('src/gone.js'), repoPath("src/it's.js")],
  };
};

type TestInputs = RoleInputs & {gate: GateInputs; lens: LensInputs; walkthrough: WalkthroughInputs; polishJudge: PolishJudgeInputs};
const SAMPLES: { readonly [R in keyof TestInputs]: readonly [TestInputs[R], TestInputs[R]] } = {
  campaignAudit: [
    {method: {traits: [], markers: [], unitKind: 'module', expensiveLanes: false, ui: false},
      vision: vision(1, 'VISION-A'),  obligations: [observed('I-1', 'OBLIGATION-A', SHA_A)], range: { audited: SHA_B, diff: shown(SHA_A, SHA_B, 'RANGE-A') },
      owners: [], priorFindings: [], contracts: [doc('docs/api.md', 'CONTRACT-A')],
      target: { kind: 'full', doc: doc('docs/arch.md', 'ARCH-A') }, checkout: absPath('/wt/audit-1'),
    },
    {method: {traits: ['persistent'], markers: ['M2'], unitKind: 'campaign', expensiveLanes: true, ui: true},
      vision: vision(2, 'VISION-B'),  obligations: [observed('I-2', 'OBLIGATION-B', SHA_B)], range: {
        audited: SHA_A,
        diff: partial(SHA_B, SHA_A, 'RANGE-B', false),
      },
      owners: [{ unit: unitId('u-two'), head: SHA_B, diff: shown(SHA_A, SHA_B, 'OWNER-B') }], priorFindings: [findingView('F-1', 'FINDING-B')], contracts: [doc('docs/b.md', 'CONTRACT-B')],

      target: { kind: 'digest', digest: doc('docs/digest.md', 'DIGEST-B'), doc: repoPath('docs/arch2.md') }, checkout: absPath('/wt/audit-2'),
    },
  ],
  experienceVerdict: [{mode: 'walkthrough', brief: walkSample('A')}, {mode: 'polish', brief: polishSample('B')}],
  build: [
    {target: {kind: 'full', doc: doc('docs/target-0.md', 'TARGET-0')},  notes: ['NOTE-A'],
      systemNotes: [], intent: 'INTENT-A', nonGoals: ['NON-GOAL-A'], spec: spec(1, 'SPEC-A'), contracts: [doc('docs/api.md', 'CONTRACT-A')], index: index('docs/x.md', 'C-7', '/plan/a/rulings.md'),
      method: {traits: [], markers: [], unitKind: 'module', expensiveLanes: false, ui: false}, fastLanes: [lane('unit', ['npm', 'test'])], suiteLanes: [], evidenceDir: absPath('/run/ev/a'), worktree: absPath('/wt/a'),
      systems: [systemName('app-a')], fixRound: null, witnessChecks: [], milestones: null, browser: null, handover: null,
    },
    {target: {kind: 'full', doc: doc('docs/target-1.md', 'TARGET-1')},  notes: ['NOTE-B'],
      systemNotes: [repoPath('docs/systems/SYSTEM-NOTES-B.md')], intent: 'INTENT-B', nonGoals: ['NON-GOAL-B'], spec: spec(2, 'SPEC-B'), contracts: [doc('docs/b.md', 'CONTRACT-B')], index: index('docs/y.md', 'C-8', '/plan/b/rulings.md'),
      method: {traits: ['persistent'], markers: ['M2'], unitKind: 'design', expensiveLanes: true, ui: true}, fastLanes: [lane('lint', ['npx', 'tsc', '--noEmit'])], suiteLanes: [lane('eslint', ['npx', 'eslint', '.'])], evidenceDir: absPath('/run/ev/b'), worktree: absPath('/wt/b'),
      systems: [systemName('app-b')], fixRound: { failingEvidenceDirs: [absPath('/run/inv/9-1')], directives: ['DIRECTIVE-B'] },
      witnessChecks: [{ lane: laneId('journey'), command: 'roadmap witness-check --lane-file /run/ev/b/witness/journey.json' }],
      milestones: milestonesSample(), browser: browserSample(),
      handover: {
        lineage: [unitId('u-one'), unitId('u-zero')],
        diagnosis: {
          units: [{
            unit: unitId('u-zero'), outcomes: [{ ref: failureRef('u-zero/gate#4', 'ref'), text: 'HANDOVER-OUTCOME-B' }],
            lanes: [{ ref: failureRef('u-zero/lanes#3/unit', 'ref'), class: 'red', hostSuspected: ['HANDOVER-HOST-B'] }], reverted: [{ path: repoPath('gen/HANDOVER-REVERTED-B.js'), salvages: 2 }], witnesses: [],
          }],
          reentries: [{ unit: unitId('u-one'), reenters: unitId('u-zero'), fixes: failureRef('u-zero/gate#4', 'ref') }],
        },
        gate: { unit: unitId('u-zero'), attempt: 4, decision: 'revise', directives: ['HANDOVER-DIRECTIVE-B'] },
        findings: [{ id: reviewFindingId('R-3'), unit: unitId('u-zero'), path: repoPath('src/b/HANDOVER-FINDING-PATH-B.ts'), defect: 'requirement-unmet', text: 'HANDOVER-FINDING-B' }],
        unmet: [{ clause: clauseId('A6'), text: 'HANDOVER-CLAUSE-B', why: 'new' }],
        witnesses: [{ test: { lane: laneId('journey'), testId: 'HANDOVER-WITNESS-B' }, reason: 'missing', unit: unitId('u-zero'), attempt: 3 }],
        decisions: [{ unit: unitId('u-zero'), id: clauseId('D1'), text: 'HANDOVER-DECISION-B', state: 'deferred' }],
        report: { unit: unitId('u-zero'), attempt: 5, summary: 'HANDOVER-SUMMARY-B', blockers: ['HANDOVER-BLOCKER-B'] },
        evidence: [absPath('/run/ev/HANDOVER-EVIDENCE-B')],
      },
    },
  ],
  gate: [
    {touches: [],
      standing: [], method: {traits: [], markers: [], unitKind: 'module', expensiveLanes: false, ui: false}, systemNotes: [], intent: 'INTENT-A', nonGoals: ['NON-GOAL-A'], spec: spec(1, 'SPEC-A'), contracts: [doc('docs/api.md', 'CONTRACT-A')],  index: index('docs/x.md', 'C-7', '/plan/a/rulings.md'),
      target: { kind: 'full', doc: doc('docs/arch.md', 'ARCH-A') }, direction: 'DIR-A',  obligations: [], standingObligations: [],
      diff: { bounded: shown(SHA_A, SHA_B, 'DIFF-A'), claims: { acceptance: [clauseId('A1')], witnesses: [], obligations: [] } },
      laneLedger: [{ lane: laneId('unit'), argv: ['npm', 'test'], expectedExit: 0, exitCode: 0, verdict: 'pass', evidenceDir: absPath('/run/inv/3-1'), ignored: null, reused: null }],
      reach: [], traits: [], reachTraits: [], evidence: [absPath('/run/ev/a')], systems: [systemName('app-a')], priorRound: null, checks: { witnesses: null, smoke: null, regenerated: [] },
      escalation: null, largeDiff: null, milestones: null, review: { ledger: [], disputes: [], delta: null }, undeclaredContracts: [],
    },
    {touches: ['BUILDER-TOUCH-B'],
      standing: [{id: 'PRE-B', text: 'Standing item B', evidence: ['src/b.ts:2']}], method: {traits: ['persistent'], markers: ['M2'], unitKind: 'design', expensiveLanes: true, ui: true}, systemNotes: [repoPath('docs/systems/SYSTEM-NOTES-B.md')], intent: 'INTENT-B', nonGoals: ['NON-GOAL-B'], spec: spec(2, 'SPEC-B'), contracts: [doc('docs/b.md', 'CONTRACT-B')],  index: index('docs/y.md', 'C-8', '/plan/b/rulings.md'),
      target: { kind: 'digest', digest: doc('docs/digest.md', 'DIGEST-B'), doc: repoPath('docs/arch2.md') }, direction: 'DIR-B',
      obligations: [observed('I-2', 'OBLIGATION-B', SHA_B)], standingObligations: [observed('I-3', 'STANDING-B', SHA_A).obligation],
      diff: { bounded: partial(SHA_B, SHA_A, 'DIFF-B', true), claims: { acceptance: [clauseId('A1'), clauseId('A2')], witnesses: [witnessItemId('W-1')], obligations: [obligationId('I-2')] } },
      laneLedger: [{ lane: laneId('lint'), argv: ['npx', 'tsc'], expectedExit: 0, exitCode: 0, verdict: 'pass', evidenceDir: absPath('/run/inv/4-1'),
        ignored: { v: 2, written: { files: 42, bytes: 3_250_000 }, captured: { files: 0, bytes: 0 }, uncaptured: [{ dir: '.local/demo/', files: 42, bytes: 3_250_000, reason: 'not-declared' }] },
        reused: { at: SHA_A, inv: invocationId(opIdOf('arc-1/4'), 1) } }],
      reach: [repoPath('REACH-B')], traits: ['persistent'], reachTraits: ['redacts'], evidence: [absPath('/run/ev/b')], systems: [systemName('app')],
      priorRound: {
        directives: ['DIRECTIVE-B'], findings: [{evidence: ["src/b/x.ts:1"],
          severity: 'blocking', path: 'src/b/x.ts', text: 'FINDING-B', contractRef: null, experiments: [{ command: 'node EXPERIMENT-B.mjs', output: 'OUTPUT-B' }], debt: null,
          defect: 'incorrect-behaviour', reraises: null, hunk: null,
        }],
        premises: [premise('PREMISE-B', 'src/b/x.ts')], fixPaths: [repoPath('src/b/x.ts')], changedPremiseFiles: ['src/b/x.ts'],
      },
      checks: {
        witnesses: {
          required: [{ lane: laneId('journey'), testId: 'WITNESS-B', source: { type: 'witness-item', id: witnessItemId('W-1') }, role: 'target' }],
          missing: [{ lane: laneId('journey'), testId: 'WITNESS-B' }], failed: [],
        },
        smoke: { killed: [], survived: [{ lane: laneId('journey'), testId: 'SURVIVOR-B' }], inconclusive: [], notRun: null },
        regenerated: [],
      },
      escalation: { kind: 'risk-trigger' },
      largeDiff: { overflow: 2741, changed: 3012, list: absPath('/run/ev/b/diff/CHANGED-LIST-B.txt') }, milestones: milestonesSample(),
      review: {
        ledger: [{ id: reviewFindingId('R-1'), path: repoPath('src/b/x.ts'), outcome: null, anchorChanged: true, text: 'LEDGER-B' }],
        disputes: [{ finding: reviewFindingId('R-1'), reason: 'DISPUTE-B', text: 'LEDGER-B' }],
        delta: { approved: { attempt: 2, head: SHA_A }, review: [repoPath('src/b/x.ts')], unchanged: [repoPath('src/b/UNCHANGED-B.ts')], moved: ['docs/b.md'] },
      },
      undeclaredContracts: [repoPath('docs/UNDECLARED-B.md')],
    },
  ],
  lens: [
    {
      vision: vision(1, 'VISION-A'), lens: 'invariants', obligations: [observed('I-1', 'OBLIGATION-A', SHA_A)], range: { audited: SHA_B, diff: shown(SHA_A, SHA_B, 'RANGE-A') },
      owners: [], priorFindings: [], contracts: [doc('docs/api.md', 'CONTRACT-A')], rulings: [ruling('C-1', 'RULE-A')], index: index('docs/x.md', 'C-7', '/plan/a/rulings.md'),
      target: { kind: 'full', doc: doc('docs/arch.md', 'ARCH-A') }, checkout: absPath('/wt/audit-1'),
    },
    {
      vision: vision(2, 'VISION-B'), lens: 'vision', obligations: [observed('I-2', 'OBLIGATION-B', SHA_B)], range: {
        audited: SHA_A,
        diff: partial(SHA_B, SHA_A, 'RANGE-B', false),
      },
      owners: [{ unit: unitId('u-two'), head: SHA_B, diff: shown(SHA_A, SHA_B, 'OWNER-B') }], priorFindings: [findingView('F-1', 'FINDING-B')], contracts: [doc('docs/b.md', 'CONTRACT-B')],
      rulings: [ruling('C-2', 'RULE-B')], index: index('docs/y.md', 'C-8', '/plan/b/rulings.md'),
      target: { kind: 'digest', digest: doc('docs/digest.md', 'DIGEST-B'), doc: repoPath('docs/arch2.md') }, checkout: absPath('/wt/audit-2'),
    },
  ],
  packReview: [
    {
      vision: vision(1, 'VISION-A'), plan: 'PLAN-A', specs: [spec(1, 'SPEC-A')], obligations: packObligations('OBLIGATION-A'),
      rulesIndex: [pinnedRule('T-1', 'RULE-A')], phase0: phase0Of('WHY-A'), delta: null,
    },
    {
      vision: vision(2, 'VISION-B'), plan: 'PLAN-B', specs: [spec(2, 'SPEC-B')], obligations: packObligations('OBLIGATION-B'),
      rulesIndex: [pinnedRule('T-2', 'RULE-B')], phase0: phase0Of('WHY-B'),
      delta: {
        since: jobId('review', 1), changed: ['spec u-two'],
        previous: [{ job: jobId('review', 1), finding: { index: 0, severity: 'blocking', target: { type: 'unit', id: unitId('u-two') }, claim: 'PREVIOUS-B', evidence: [] } }],
      },
    },
  ],
  flow: [flowSample('A'), flowSample('B')],
  walkthrough: [walkSample('A'), walkSample('B')],
  polishJudge: [polishSample('A'), polishSample('B')],
  verifier: [
    {mode: 'pre-build', brief: {target: {kind: 'full', doc: doc('docs/target-0.md', 'TARGET-0')}, vision: null, spec: spec(1, 'SPEC-A'), intent: 'INTENT-A', nonGoals: ['NON-GOAL-A'], contracts: [], systems: [systemName('app-a')], method: {traits: [], markers: [], unitKind: 'module', expensiveLanes: false, ui: false}, history: [], standing: []}},
    {mode: 'diagnosis', brief: {target: {kind: 'full', doc: doc('docs/target-1.md', 'TARGET-1')}, vision: null, spec: spec(2, 'SPEC-B'), intent: 'INTENT-B', nonGoals: ['NON-GOAL-B'], contracts: [], systems: [systemName('app-b')], method: {traits: ['persistent'], markers: ['M2'], unitKind: 'design', expensiveLanes: true, ui: true}, history: ['failed build'], standing: []}},
  ],
};

const OUTPUTS: Record<keyof TestInputs, unknown> = {
  campaignAudit: {...{
    findings: [{ severity: 'P1', obligation: 'I-1', visionClauses: ['V-1'], claim: 'I-1 is not held.', cause: 'rounding', evidence: [{ path: 'src/a.ts', line: 3 }], mutant: null }],
    reasons: ['I-1 fails on the audited tree'], premises: [],
  }, requests: []},
  experienceVerdict: {final: true, mode: 'walkthrough', verdict: {
    final: true,
    journeys: [{ journey: 'J-1', outcome: 'blocked', evidence: ['j1-submit.png'], note: 'the submit posts to a 404' }],
    findings: [{
      class: 'breaks', journey: 'J-1', evidence: ['j1-submit.png'], claim: 'Submitting the form leads to a 404.', cause: 'form action', against: { type: 'journey' },
      paths: ['src/form.html'],
    }],
    polish: [],
    premises: [], reasons: ['J-1 cannot be completed'],
  }},
  walkthrough: {
    final: true,
    journeys: [{ journey: 'J-1', outcome: 'blocked', evidence: ['j1-submit.png'], note: 'the submit posts to a 404' }],
    findings: [{
      class: 'breaks', journey: 'J-1', evidence: ['j1-submit.png'], claim: 'Submitting the form leads to a 404.', cause: 'form action', against: { type: 'journey' },
      paths: ['src/form.html'],
    }],
    polish: [],
    premises: [], reasons: ['J-1 cannot be completed'],
  },
  polishJudge: { final: true, decision: 'keep', evidence: ['before.png', 'after.png'], reasons: ['the after page reads as the reference asks'], premises: [] },
  flow: {
    constraint: { station: 'slot:integration', agree: true, reason: 'the suite lane holds the slot' },
    diagnosis: 'Units wait for the integration slot; the unit suite lane is most of its service.',
    proposal: {
      target: 'suite:unit', action: { lever: 'suite-lane', lane: 'unit', argv: ['node', '--test', '--test-concurrency=6', 'test/*.test.js'], reporter: 'node-test', cpu: null },
      rationale: 'six isolated files run one at a time', risks: 'shared state between files',
    },
    noAction: null,
  },
  packReview: {
    findings: [{ severity: 'blocking', target: { type: 'census', rule: 'T-1' }, claim: 'T-1 has no census entry', evidence: [{ path: 'obligations.json', line: 1 }] }],
    dispositions: [{ job: 'review-1', index: 0, disposition: 'still-open' }], reasons: ['the census misses T-1'], premises: [],
  },
  build: {
    summary: 'Added the parser.', grounding: {specWrong: null, touches: []}, tooBig: null, notes: [], blockers: [], experiments: [],  final: true,
  },
  gate: {rulings: [],
    decision: 'revise', ordering: null, reasons: ['A2 untested'], directives: ['Add a test for A2.'],
    findings: [{evidence: ["src/a/parse.ts:1"],
      severity: 'blocking', path: 'src/a/parse.ts', text: 'A2 has no test.', contractRef: null, experiments: [{ command: 'node -e "parse(\'\')"', output: 'TypeError' }], debt: null,
      defect: 'test-inadequate', reraises: null, hunk: null,
    }],
    premises: [], standing: [], clusters: null,
  },
  verifier: {decision: 'approve', ordering: null, findings: [], directives: [], reasons: ['ok'], premises: [], standing: [], clusters: null, rulings: []},
  lens: {
    findings: [{ severity: 'P1', obligation: 'I-1', visionClauses: ['V-1'], claim: 'I-1 is not held.', cause: 'rounding', evidence: [{ path: 'src/a.ts', line: 3 }], mutant: null }],
    reasons: ['I-1 fails on the audited tree'], premises: [],
  },
};

/** Every (role, model) either built-in profile can resolve, the seats of a corpus arc of the dev17 role set with milestones (every role) included. */
function builtinSeats(): readonly (readonly [Role, (typeof MODEL_IDS)[number]])[] {
  const seen = new Map<string, readonly [Role, (typeof MODEL_IDS)[number]]>();
  for (const p of PROFILES) {
    const resolved = resolveRouting({ ...arcStack(p, null, null), arcScope: 'corpus', arcRoles: 'dev17', milestones: true });
    for (const s of seatsInForce(resolved)) {
      const m = atSeat(resolved.table, s).model;
      seen.set(`${s.role}/${m}`, [s.role, m]);
    }
  }
  return [...seen.values()];
}

// A checker for the strict JSON Schema subset schemas.ts emits; enough to show a sample output
// conforms to the schema a backend is handed.
function conforms(schema: JsonValue, value: unknown): boolean {
  const s = schema as { readonly [k: string]: JsonValue };
  if (s['anyOf'] !== undefined) return (s['anyOf'] as JsonValue[]).some((b) => conforms(b, value));
  if (s['enum'] !== undefined && !(s['enum'] as JsonValue[]).includes(value as JsonValue)) return false;
  switch (s['type']) {
    case 'null': return value === null;
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value) && value.every((v) => conforms(s['items'] as JsonValue, v));
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const props = s['properties'] as { readonly [k: string]: JsonValue };
      const keys = Object.keys(value);
      return keys.length === Object.keys(props).length &&
        keys.every((k) => props[k] !== undefined && conforms(props[k], (value as Record<string, unknown>)[k]));
    }
    default: throw new Error(`unexpected schema node ${JSON.stringify(schema)}`);
  }
}

/** Codex strict mode: every object lists every property as required and forbids additional ones. */
function assertStrict(schema: JsonValue, path: string): void {
  if (Array.isArray(schema)) return schema.forEach((s, i) => assertStrict(s, `${path}[${i}]`));
  if (typeof schema !== 'object' || schema === null) return;
  const s = schema as { readonly [k: string]: JsonValue };
  if (s['type'] === 'object') {
    assert.equal(s['additionalProperties'], false, `${path}: additionalProperties`);
    assert.deepEqual(s['required'], Object.keys(s['properties'] as object), `${path}: required`);
  }
  for (const [k, v] of Object.entries(s)) assertStrict(v, `${path}.${k}`);
}

describe('prompts', () => {
  it('prompts.gate-system-traits: declared and actual-diff traits are rendered in every supported gate prompt', () => {
    for (const model of MODEL_IDS) {
      const supported = support('verifier', model);
      if (supported.type !== 'prompt') continue;
      const text = promptFor('gate', model).render(SAMPLES.gate[1]);
      assert.match(text, /<system_traits>- persistent<\/system_traits>/, model);
      assert.match(text, /<reach_traits>- redacts<\/reach_traits>/, model);
    }
  });

  it('prompts.fields==required: every module lists and interpolates exactly its role inputs', () => {
    for (const role of ROLES) {
      const [a, b] = SAMPLES[role];
      assert.deepEqual(Object.keys(a).sort(), [...ROLE_INPUTS[role]].sort(), `${role}: sample keys`);
      for (const model of MODEL_IDS) {
        const s = support(role, model);
        if (s.type !== 'prompt') continue;
        const mod = s.prompt as { fields: readonly string[]; render: (i: unknown) => string };
        assert.deepEqual([...mod.fields].sort(), [...ROLE_INPUTS[role]].sort(), `${role}/${model}: fields`);
        const base = mod.render(a);
        for (const field of mod.fields) {
          const swapped = role === 'experienceVerdict' || role === 'verifier' ? b : { ...a, [field]: (b as Record<string, unknown>)[field] };
          assert.notEqual(mod.render(swapped), base, `${role}/${model} does not interpolate ${field}`);
        }
      }
    }
  });

  it('prompts.every-supported-seat-renders: deterministic, and the schema accepts a sample output', () => {
    const seats = builtinSeats();
    assert.ok(seats.length >= 7);
    for (const role of ['build', 'verifier', 'campaignAudit', 'experienceVerdict', 'packReview'] as const) assert.ok(seats.some(([r]) => r === role), `${role}: seated by a built-in profile`);
    for (const [role, model] of seats) {
      const mod = promptFor(role, model) as { system: string; schema: JsonValue; render: (i: unknown) => string };
      for (const input of SAMPLES[role]) {
        const text = mod.render(input);
        assert.equal(mod.render(input), text, `${role}/${model}: deterministic`);
        assert.ok(text.length > 0 && mod.system.length > 0);
        assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, `${role}/${model}: no timestamps`);
      }
      assert.equal(mod.schema, ROLE_SCHEMAS[role]);
      assertStrict(mod.schema, `${role}/${model}`);
      assert.ok(conforms(mod.schema, OUTPUTS[role]), `${role}/${model}: sample conforms to schema`);
      ROLE_VALIDATORS[role](OUTPUTS[role]);
    }
  });

  it('inherits resolves to the named module; unsupported throws', () => {
    assert.equal(promptFor('build', 'gpt-5.6-sol'), promptFor('build', 'gpt-5.6-luna'));
    assert.throws(() => promptFor('gate', 'gpt-5.6-luna'), UnsupportedPromptError);
    assert.throws(() => promptFor('build', 'claude-fable-5-1'), UnsupportedPromptError);
    for (const role of ROLES) for (const model of MODEL_IDS) {
      const s = PROMPTS[role][model];
      if (s.type === 'inherits') assert.equal(PROMPTS[role][s.from].type, 'prompt', `${role}/${model}: inherits a real module`);
    }
    // W3: every judgment role has one written module, Opus's. Sonnet 5.5 (efficient, 2026-10-15) reads it with the think-first
    // line ending its system prompt (the Sonnet 5.5 guide, reasoning tasks with JSON output); Fable inherits it unchanged.
    for (const role of JUDGING) {
      const opus = promptFor(role, 'claude-opus-5-5');
      assert.equal(PROMPTS[role]['claude-opus-5-5'].type, 'prompt', role);
      const s = PROMPTS[role]['claude-sonnet-5-5'];
      assert.ok(s.type === 'prompt', `${role}/sonnet: a module of its own`);
      assert.equal(s.prompt.system, `${opus.system}\n\n${SONNET_THINK_FIRST}`, `${role}/sonnet: the Opus system prompt, then the line`);
      assert.equal(s.prompt.render, opus.render, `${role}/sonnet: the Opus message`);
      assert.equal(s.prompt.schema, opus.schema, role);
      const fable = PROMPTS[role]['claude-fable-5-1'];
      assert.ok(fable.type === 'inherits' && fable.from === 'claude-opus-5-5', `${role}/fable: inherits Opus`);
    }
    assert.equal(promptFor('build', 'claude-sonnet-5-5'), promptFor('build', 'claude-opus-5-5'), 'the Sonnet build reads the Opus brief unchanged');
    // dev.13 (plan §6): the walk roles have an Opus module only; no Sonnet, Haiku or Codex prompt.
    for (const role of WALK_ROLES) {
      assert.equal(PROMPTS[role]['claude-opus-5-5'].type, 'prompt', role);
      for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-5.6-luna', 'gpt-5.6-sol'] as const) assert.equal(PROMPTS[role][model].type, 'unsupported', `${role}/${model}`);
    }
  });

  it('prompts.haiku: every judgment role resolves a prompt for Haiku 5.5 (economy, 1.0.0-dev.12) with the role\'s schema; no Haiku build prompt', () => {
    for (const role of JUDGING) {
      const s = PROMPTS[role]['claude-haiku-5-5'];
      assert.ok(s.type === 'prompt', `${role}/haiku: a module of its own`);
      assert.equal(s.prompt.schema, ROLE_SCHEMAS[role], role);
    }
    assert.throws(() => promptFor('build', 'claude-haiku-5-5'), (e: unknown) => e instanceof UnsupportedPromptError && /economy, is judgment-only/.test(e.message));
  });

  it('judgment prompts say fresh session, cite C-nn, and grade the contract text itself', () => { for (const mode of ['pre-build', 'diagnosis'] as const) { const mod = promptFor('verifier', 'claude-opus-5-5'); const text = mod.render({mode, brief: {...SAMPLES.verifier[0].brief, history: [], vision: null}}); assert.ok(text.includes('<mode>'+mode+'</mode>')); assert.equal(mod.schema, GATE_SCHEMA); assert.doesNotMatch(text, /RULE-A|C-7 first sentence|rulings\.md/); } });

  it('build prompts cover fast lanes, decisions.json, .roadmap/ and estate lanes', () => { for (const model of ['claude-opus-5-5', 'gpt-5.6-luna'] as const) { const mod = promptFor('build', model); assert.ok(mod.system.includes(UNIT_POLICY)); const text = mod.render(SAMPLES.build[1]); assert.match(text, /\/run\/inv\/9-1/); assert.match(text, /cd \/wt\/b && env CI=1 npx tsc --noEmit/); assert.doesNotMatch(text, /RULE-B|C-8 first sentence|rulings\.md/); assert.deepEqual(Object.keys((ROLE_SCHEMAS.build as {properties: object}).properties), ['summary', 'blockers', 'experiments', 'grounding', 'tooBig', 'notes', 'final']); } });

  it('dev.13: a milestone unit\'s pre-build, build and gate embed its design references as documents and name its milestones; others carry none', () => {
    for (const role of ['build', 'gate'] as const) for (const model of MODEL_IDS) {
      const s = support(role === 'gate' ? 'verifier' : role, model);
      if (s.type !== 'prompt') continue;
      const mod = promptFor(role, model) as {render: (i: unknown) => string};
      const text = mod.render(SAMPLES[role][1]);
      for (const needle of ['REFERENCE-B', 'TOKENS-B', 'design/b/DESIGN.md', 'design/b2/tokens.json', 'design/b/WIRE-B.png', 'MS-2', 'MEMBER-MILESTONE-B', 'MS-3', 'DESIGN-MILESTONE-B']) {
        assert.ok(text.includes(needle), `${role}/${model}: ${needle}`);
      }
      // A design unit sees the journeys its references serve; a member sees none.
      for (const needle of ['J-1', 'JOURNEY-A', '/entry-A', 'J-2', 'JOURNEY-B']) assert.ok(text.includes(needle), `${role}/${model}: ${needle}`);
      if (model.startsWith('claude-')) assert.match(text, /<source>design reference design\/b\/DESIGN\.md<\/source>\n<document_content>\nREFERENCE-B/, `${role}/${model}: a document`);
      const none = mod.render(SAMPLES[role][0]);
      for (const needle of ['<milestones>', 'design reference', 'MILESTONE']) assert.ok(!none.includes(needle), `${role}/${model}: none outside a milestone (${needle})`);
    }
  });

  it('dev.13: only a build with a browser drive is told of its MCP servers and given the bring-up', () => {
    for (const model of ['claude-opus-5-5', 'gpt-5.6-luna'] as const) {
      const mod = promptFor('build', model);
      const text = mod.render(SAMPLES.build[1]);
      for (const needle of ['<browser>', 'playwright', 'npm ci', 'SERVER-B.js', '{port:web}', 'http://127.0.0.1:{port:web}/health', 'MODE=BRINGUP-B', 'SEED-B.js']) {
        assert.ok(text.includes(needle), `build/${model}: ${needle}`);
      }
      assert.ok(!mod.render({ ...SAMPLES.build[1], browser: null }).includes('<browser>'), `build/${model}: no browser block without the drive`);
      assert.ok(!mod.render(SAMPLES.build[0]).includes('<browser>'), `build/${model}`);
    }
  });

  it('build prompts carry the unit policy, which overrides the repository\'s instruction files', () => {
    for (const needle of [/AGENTS\.md/, /CLAUDE\.md/, /overrides/, /[Nn]o cloud/, /[Nn]o sudo/, /package installs/, /kill a process/, /[Nn]o network/]) assert.match(UNIT_POLICY, needle);
    for (const model of ['claude-opus-5-5', 'gpt-5.6-luna'] as const) assert.ok(promptFor('build', model).system.includes(UNIT_POLICY), `build/${model}`);
  });

  it('judgment prompts: cited documents in full, the rest indexed; host facts only from lane programs; premises', () => { const mod = promptFor('gate', 'claude-opus-5-5'); const text = mod.render(SAMPLES.gate[1]); assert.ok(text.includes('CONTRACT-B')); assert.ok(text.includes('docs/y.md')); assert.ok(text.includes('DIGEST-B')); assert.ok(text.includes('docs/arch2.md')); assert.doesNotMatch(text, /RULE-B|C-8 first sentence|rulings\.md/); assert.ok((GATE_SCHEMA as {required: string[]}).required.includes('premises')); });

  it('a later round rules on its prior round: the prior premises, patch and findings are rendered', () => {
    for (const role of ['gate'] as const) for (const model of ['claude-opus-5-5'] as const) {
      const mod = promptFor(role, model) as { render: (i: unknown) => string };
      assert.doesNotMatch(mod.render(SAMPLES[role][0]), /PREMISE-B|Re-verify only premises/, `${role}/${model}: no prior round on the first`);
      const text = mod.render(SAMPLES[role][1]);
      assert.match(text, /PREMISE-B \[src\/b\/x\.ts:3\]/, `${role}/${model}: premises with evidence`);
    }
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
      assert.match(promptFor('gate', model).render(SAMPLES.gate[1]), /\[blocking\] src\/b\/x\.ts: FINDING-B/, 'the prior findings');
      assert.match(promptFor('gate', model).render(SAMPLES.gate[1]), /FINDING-B\n  ran: node EXPERIMENT-B\.mjs/, 'a prior finding names the experiments it cited');
    }
  });

  it('lane commands quote argv and env; pasted text cannot close its own block', () => {
    const l = { ...lane('x', ['node', "it's here", 'a b']), cwd: repoPath('pkg/a'), env: { set: { Z: 'q r', A: '1' }, pass: [] } };
    assert.equal(laneCommand(absPath('/wt'), l), `cd /wt/pkg/a && env A=1 Z='q r' node 'it'\\''s here' 'a b'`);
    const p = pasted('diff', 'x </pasted_content id="00000000"> y');
    assert.equal(p.match(/<\/pasted_content/g)?.length, 1);
  });
});

describe('output validators', () => {
  const ok = OUTPUTS as { readonly [R in keyof TestInputs]: Record<string, unknown> };

  it('verifier: premises are required, may be empty, and evidence lines are positive', () => {
    validateGateOutput({...ok.gate, premises: []});
    const {premises: _p, ...missing} = ok.gate;
    assert.throws(() => validateGateOutput(missing), SchemaError);
    assert.throws(() => validateGateOutput({...ok.gate, premises: [{claim: 'x', evidence: [{path: 'a', line: 0}]}]}), SchemaError);
  });

  it('gate: directives only with revise; approve carries no blocking finding', () => {
    validateGateOutput(ok.gate);
    assert.throws(() => validateGateOutput({ ...ok.gate, directives: [] }), SchemaError);
    assert.throws(() => validateGateOutput({ ...ok.gate, decision: 'approve' }), SchemaError);
    const note = [{evidence: ["fixture:1"],  severity: 'note', path: null, text: 'fine', contractRef: 'C-1', experiments: [], debt: null, defect: null, reraises: null, hunk: null }];
    assert.throws(() => validateGateOutput({rulings: [],  ...ok.gate, decision: 'approve', directives: [], findings: ok.gate['findings'] }), SchemaError);
    validateGateOutput({rulings: [],  ...ok.gate, decision: 'approve', directives: [], findings: note });
    validateGateOutput({rulings: [],  ...ok.gate, decision: 'escalate', directives: [], findings: ok.gate['findings'] });
  });

  it('gate: pre-existing findings do not block approval and retired coverage claims are refused', () => {
    const pre = [{evidence: ["src/old.ts:1:1"], severity: 'pre-existing', path: 'src/old.ts:1', text: 'Existing defect', contractRef: null, experiments: [], debt: null, defect: null, reraises: null, hunk: null}];
    const out = validateGateOutput({...ok.gate, decision: 'approve', directives: [], findings: pre});
    assert.deepEqual(out.findings, pre);
    assert.throws(() => validateGateOutput({...ok.gate, unreviewed: []}), SchemaError);
    assert.throws(() => validateGateOutput({...ok.gate, findings: [{...pre[0], severity: 'minor'}]}), SchemaError);
    const schema = GATE_SCHEMA as {properties: Record<string, unknown>; required: readonly string[]};
    assert.ok(!schema.required.includes('unreviewed'));
  });

  it('gate (dev.13, the gate\'s shell): a finding cites the experiments it rests on, each a command and its output; a live answer gives the list, an omitted experiment list reads as none', () => {
    const experiments = [{ command: 'node probe.mjs', output: 'expected 9, got 2' }];
    const finding = {evidence: ["src/a/parse.ts:1"],  severity: 'blocking', path: 'src/a/parse.ts', text: 'A2 fails on two-digit inputs.', contractRef: null, experiments, debt: null, defect: null, reraises: null, hunk: null };
    assert.deepEqual(validateGateOutput({ ...ok.gate, findings: [finding] }).findings[0]!.experiments, experiments);
    for (const bad of [[{ command: 'node probe.mjs' }], [{ command: 1, output: '' }], 'node probe.mjs']) {
      assert.throws(() => validateGateOutput({ ...ok.gate, findings: [{ ...finding, experiments: bad }] }), SchemaError, JSON.stringify(bad));
    }
    const { experiments: _e, ...dev12 } = finding;
    assert.deepEqual(validateGateOutput({ ...ok.gate, findings: [dev12] }).findings[0]!.experiments, []);
    const item = ((GATE_SCHEMA as { properties: Record<string, { items: { required: readonly string[] } }> }).properties['findings']!).items;
    assert.ok(item.required.includes('experiments'), 'a live gate answers it on every finding');
  });

  it('gate (dev.13, the convergence tail): a finding says whether it is debt, {drag} or null; a live answer gives it on every finding, an omitted experiment list reads as none', () => {
    const note = {evidence: ["src/a/parse.ts:1"],  severity: 'note', path: 'src/a/parse.ts', text: 'parse re-reads the file per call.', contractRef: null, experiments: [], defect: null, reraises: null, hunk: null };
    const debt = { drag: 'Every later reader of big inputs pays the re-read.' };
    assert.deepEqual(validateGateOutput({ ...ok.gate, findings: [{ ...note, debt }] }).findings[0]!.debt, debt);
    assert.equal(validateGateOutput({ ...ok.gate, findings: [{ ...note, debt: null }] }).findings[0]!.debt, null);
    assert.throws(() => validateGateOutput({ ...ok.gate, findings: [note] }), /debt/);
    for (const bad of [{}, { drag: 1 }, 'slow']) assert.throws(() => validateGateOutput({ ...ok.gate, findings: [{ ...note, debt: bad }] }), SchemaError, JSON.stringify(bad));
    const item = ((GATE_SCHEMA as { properties: Record<string, { items: { required: readonly string[] } }> }).properties['findings']!).items;
    assert.ok(item.required.includes('debt'), 'a live gate answers it on every finding');
  });

  it('gate (dev.12, the large-diff gate): a cluster map is ids, paths and a review depth; a dev.11 answer without clusters is refused', () => {
    const clusters = [{ id: 'sweep', paths: ['packages/*/src/**'], review: 'description' }, { id: 'core', paths: ['packages/core/index.ts'], review: 'close' }];
    assert.deepEqual(validateGateOutput({ ...ok.gate, clusters }).clusters, clusters);
    assert.equal(validateGateOutput({ ...ok.gate, clusters: null }).clusters, null);
    const { clusters: _c, ...dev11 } = ok.gate;
    assert.throws(() => validateGateOutput(dev11), /clusters/);
    for (const bad of [
      [], [{ id: 'a', paths: [], review: 'routine' }], [{ id: 'a', paths: ['x'], review: 'opus' }], [{ id: 'a', paths: ['/abs'], review: 'routine' }],
      [{ id: 'a', paths: ['x'], review: 'routine' }, { id: 'a', paths: ['y'], review: 'close' }], [{ id: '', paths: ['x'], review: 'routine' }],
    ]) assert.throws(() => validateGateOutput({ ...ok.gate, clusters: bad }), SchemaError, JSON.stringify(bad));
    const schema = GATE_SCHEMA as { properties: Record<string, unknown>; required: readonly string[] };
    assert.ok(schema.required.includes('clusters'), 'a live gate answers it (null under the threshold)');
  });

  it('build and decisions.json: ids checked, unknown keys refused', () => {
    validateBuildOutput(ok.build);
    assert.throws(() => validateBuildOutput({ ...ok.build, extra: 1 }), SchemaError);
    assert.throws(() => validateBuildOutput({ ...ok.build, lanesRun: [{ lane: '1bad', exit: 0 }] }), SchemaError);
    // decisions.json is the one channel: the report may not carry an echo of it.
    assert.throws(() => validateBuildOutput({ ...ok.build, decisionsRecorded: [{ id: 'impl-1', text: 'a' }] }), SchemaError);
    validateDecisionsFile({ decisions: [{ id: 'impl-1', text: 'a' }] });
    assert.throws(() => validateDecisionsFile({ decisions: [{ id: 'impl-1', text: 'a' }, { id: 'impl-1', text: 'b' }] }), SchemaError);
  });
});

describe('M3 prompts: the vision and the arc roles', () => {
  /** Every Claude model: Opus and Fable have written modules, Sonnet reads them (owner ruling 2026-10-15, efficient judgment). */
  const ARC_MODELS = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'] as const;

  it('the arc roles are supported on every Claude model: lens/Opus and checkpoint/Opus written, Fable inherits, Sonnet adds its line; Codex unsupported', () => {
    for (const role of ['campaignAudit'] as const) {
      assert.equal(PROMPTS[role]['claude-opus-5-5'].type, 'prompt');
      assert.equal(promptFor(role, 'claude-fable-5-1'), promptFor(role, 'claude-opus-5-5'));
      assert.equal(promptFor(role, 'claude-sonnet-5-5').system, `${promptFor(role, 'claude-opus-5-5').system}\n\n${SONNET_THINK_FIRST}`);
    }
    for (const role of ['campaignAudit'] as const) {
      for (const model of ['gpt-5.6-luna', 'gpt-5.6-sol'] as const) assert.throws(() => promptFor(role, model), UnsupportedPromptError);
      for (const model of ARC_MODELS) {
        const s = PROMPTS[role][model];
        if (s.type === 'inherits') assert.match(s.reviewed, /^\d{4}-\d{2}-\d{2}: /, `${role}/${model}: a dated review`);
      }
    }
  });

  it('the vision goes first and in full into every lens and checkpoint prompt, before obligations and plan, and wins a conflict', () => {
    for (const role of ['lens'] as const) for (const model of ARC_MODELS) {
      const mod = promptFor(role, model) as { system: string; fields: readonly string[]; render: (i: unknown) => string };
      assert.match(mod.system, /the vision wins/, `${role}/${model}`);
      assert.match(mod.system, /forecloses? a horizon clause/, `${role}/${model}: the horizon is never foreclosed`);
      assert.match(mod.system, /Never (resolve|answer) an open question yourself/, `${role}/${model}`);
      for (const input of SAMPLES[role]) {
        const text = mod.render(input);
        const v = input.vision;
        assert.ok(text.startsWith(`<vision>\nVision revision ${v.rev}\n`), `${role}/${model}: the message opens with the vision`);
        for (const c of v.clauses) assert.ok(text.includes(`${c.id} (${c.kind}): ${c.text}`), `${role}/${model}: clause ${c.id} in full`);
        const at = text.indexOf(v.clauses[0]!.text);
        assert.ok(at < text.indexOf(input.obligations[0]!.obligation.statement), `${role}/${model}: vision before obligations`);
      }
    }
  });

  it('the vision: world clauses first, withdrawn clauses marked, tradeoffs ranked; the slice, the horizon and the open questions', () => {
    const q = { id: questionId('Q-1'), text: 'Q', bears: [visionClauseId('V-1'), visionClauseId('V-4')], assumption: 'A', state: 'open' as const };
    const v = {
      rev: 3, clauses: [
        { id: visionClauseId('V-1'), kind: 'purpose' as const, text: 'P', rank: null, state: 'active' as const },
        { id: visionClauseId('V-2'), kind: 'tradeoff' as const, text: 'T', rank: 1, state: 'active' as const },
        { id: visionClauseId('V-3'), kind: 'good' as const, text: 'G', rank: null, state: 'withdrawn' as const },
        { id: visionClauseId('V-4'), kind: 'world' as const, text: 'W', rank: null, state: 'active' as const },
      ],
      questions: [q, { ...q, id: questionId('Q-2'), text: 'CLOSED', state: 'closed' as const }],
      advances: [visionClauseId('V-1'), visionClauseId('V-4')],
    };
    const text = promptFor('lens', 'claude-opus-5-5').render({ ...SAMPLES.lens[0], vision: v });
    assert.match(text, /<vision>\nVision revision 3\nV-4 \(world\): W\nV-1 \(purpose\): P\n/);
    assert.match(text, /V-2 \(tradeoff, rank 1\): T/);
    assert.match(text, /Withdrawn, never cite: V-3/);
    assert.doesNotMatch(text, /V-3 \(/);
    assert.match(text, /\nThis arc advances: V-1, V-4\nHorizon \(active, beyond this arc\): V-2\nOpen questions:\n- Q-1 \(bears on V-1, V-4\): Q\n {2}Working assumption: A\n<\/vision>/);
    assert.doesNotMatch(text, /CLOSED/, 'a closed question is omitted');
  });

  it('a latched future obligation renders as must-hold (latched), so a split can keep its restating child must-hold', () => {
    const view = { ...observed('I-1', 'A month reconciles.', SHA_A), obligation: { ...obligation('I-1', 'A month reconciles.'), activation: 'future' as const, deliveredBy: [unitId('report')] } };
    assert.match(obligationsText([{ ...view, latched: true }], { serves: true }), /^- I-1 \(rev 1; must-hold \(latched\); /);
    assert.match(obligationsText([view], { serves: true }), /^- I-1 \(rev 1; future; /);
  });

  it('the lens: prior findings not repeated, no reasoning field, nobody will answer', () => {
    const sys = promptFor('lens', 'claude-opus-5-5').system;
    for (const needle of [/Do not report one again/, /Nobody will answer a question/]) assert.match(sys, needle);
    for (const schema of [ROLE_SCHEMAS.campaignAudit]) assert.doesNotMatch(JSON.stringify(schema), /reasoning/);
    const text = promptFor('lens', 'claude-opus-5-5').render(SAMPLES.lens[1]);
    assert.match(text, /F-1 \[P1, invariants, open\] I-1: FINDING-B/, 'prior findings with their states');
    assert.match(text, /Unit u-two at b{40} \(its diff from a{40}\):\n<orientation>[\s\S]*?<\/orientation>\n<diff>\n[^\n]*\n<pasted_content/, 'owner branches marked as pasted data');
  });

  it('the bounded diff: a range names its chunk and the audited SHA, orients the reader, and lists each file not shown with the readable file holding its diff', () => {
    const mod = promptFor('lens', 'claude-opus-5-5');
    const text = mod.render(SAMPLES.lens[1]);
    const [a, b] = [SHA_A, SHA_B];
    const dir = '/run/diff-RANGE-B';
    assert.ok(text.includes(`<audited_range from="${b}" to="${a}" audited="${a}">`));
    assert.ok(text.includes(`<orientation>\nDiff ${b}..${a}. Files named below are readable with Read.\nStat (summary; the full stat is in ${dir}/stat.txt):\nSTAT-RANGE-B\n`));
    assert.ok(text.includes(`Moved or renamed without content change (no diff below): 4\n- src/old.js → src/new.js\n- and 3 more, all listed in ${dir}/moves.txt\n`));
    assert.ok(text.includes(`Deleted (no diff below; each file holds the whole deleted content): 2\n- src/gone.js (40 lines): ${dir}/files/src/gone.js.diff\n- legacy/x.js (1 line): ${dir}/files/legacy/x.js.diff\n`), 'a lens has no spec: deletions unlabelled');
    assert.ok(text.includes(`- packages/core: 12 files; +300 -120\n- and 4 more packages\n`));
    assert.ok(text.includes(`(removed → added, times; where to look, not a verification):\n- oldName → newName ×17\n- 9 changed files with every changed line explained by these substitutions (a pointer; each is still part of the diff to judge)\n</orientation>`), 'a lens orientation claims nothing');
    assert.match(text, /<diff>\nPer-file diffs with one line of context[^\n]*\n<pasted_content id="[0-9a-f]{8}">\nRANGE-B\n<\/pasted_content id="[0-9a-f]{8}">\n<\/diff>/, 'the inlined diffs, as pasted data');
    assert.ok(text.includes(`<not_inlined>\nFiles with changed content not shown above; each file named holds its whole diff.\n- dist/b.js (derived output, regenerated from sources this diff changes, 900 bytes): ${dir}/files/dist/b.js.diff\n- src/it's.js (new source, over the budget, 200000 bytes): ${dir}/files/src/it's.js.diff\n- and 2 more, all listed in ${dir}/not-inlined.txt\n</not_inlined>`));
    assert.doesNotMatch(text, /git diff/, 'no git command: a judgment has no shell');
    assert.doesNotMatch(mod.render(SAMPLES.lens[0]), /<not_inlined>|full stat|Moved|Deleted/, 'a range shown whole lists nothing');
    // W3: the bounded diff's three parts as the system text describes them, and what the executor records.
    for (const needle of [/<orientation> is a map of the whole range/, /it is not a verdict on any file/, /the absolute path of a readable \.diff file/,
      /it names the file that lists them all/,]) assert.match(mod.system, needle);
    assert.doesNotMatch(mod.system, /git diff|command beside it/);
  });

  it('the bounded gate diff: deletions labelled against the spec removes, unexpected first as given, and what the unit claims as id pointers', () => {
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
      const text = promptFor('gate', model).render(SAMPLES.gate[1]);
      const dir = '/run/diff-DIFF-B';
      assert.ok(text.includes(`Deleted (no diff below; each file holds the whole deleted content): 2, those not in the spec's removes first\n- src/gone.js (40 lines, not in the spec's removes): ${dir}/files/src/gone.js.diff\n- legacy/x.js (1 line, matches removes "legacy"): ${dir}/files/legacy/x.js.diff\n`), model);
      assert.ok(text.includes('Claimed by the unit (stated in full above): acceptance A1, A2; witness items W-1; obligations I-2\n</orientation>'), model);
      assert.ok(text.includes(`Diff ${SHA_A}..${SHA_B}.`) === false && text.includes(`Diff ${SHA_B}..${SHA_A}.`), model);
      assert.match(promptFor('gate', model).render(SAMPLES.gate[0]), /acceptance A1; witness items none; obligations none/, model);
    }
  });

  it('the gate renders standing obligations as compact lines in their own tag after direct obligations', () => {
    for (const model of ARC_MODELS) {
      const mod = promptFor('gate', model);
      assert.ok(mod.fields.includes('standingObligations'));
      const text = mod.render(SAMPLES.gate[1]);
      assert.match(text, /<\/obligations>\n\n<standing_obligations>\n- I-3: STANDING-B\n<\/standing_obligations>/, model);
      assert.match(text, /<obligations>\n- I-2 \(rev 1; must-hold; active\): OBLIGATION-B\n  Anchored at[^]*?  Witness:[^]*?  Observation:[^]*?<\/obligations>/, model);
      assert.match(mod.render(SAMPLES.gate[0]), /<standing_obligations>\n\(none\)\n<\/standing_obligations>/, model);
    }
  });

  it('the gate (R17) never receives the vision: its selected obligations, without the clauses they serve', () => {
    assert.ok(!(Object.keys(SAMPLES.gate[0]) as readonly string[]).includes('vision'));
    assert.ok((Object.keys(SAMPLES.gate[0]) as readonly string[]).includes('obligations'));
    for (const model of ARC_MODELS) {
      const mod = promptFor('gate', model);
      const text = mod.render(SAMPLES.gate[1]);
      assert.match(text, /- I-2 \(rev 1; must-hold; active\): OBLIGATION-B/, model);
      assert.doesNotMatch(mod.system + text, /\bvision\b|V-1|serves/i, `${model}: no vision in the gate`);
    }
  });
});

describe('M4a prompts: the corpus target, checkpoint intake, the pack review, unattended builds', () => {
  const JUDGMENTS = [ ['gate', 'claude-opus-5-5'],
    ['lens', 'claude-opus-5-5']] as const;

  it('corpus target: the rules index by file and section, the read-only corpus dir, the vision doc only where the role reads it', () => {
    const doc = targetDocument(corpusTarget('/run/corpus/0123abcd', 'docs/vision.md'));
    assert.equal(doc.source, 'corpus rules index (the pinned corpus files are read-only under /run/corpus/0123abcd; the vision document is /run/corpus/0123abcd/docs/vision.md (it holds no rules))');
    assert.equal(doc.content, [
      'docs/0010.md:', '  Overview', '    T-1: Amounts render with two decimals.', '    T-4: Amounts never round twice.', '  Reports', '    T-2: Totals reconcile monthly.',
      'docs/0020.md:', '  (before any heading)', '    T-3: Exports are CSV.',
    ].join('\n'));
    assert.doesNotMatch(targetDocument(corpusTarget('/run/corpus/0123abcd', null)).source, /vision/);
    assert.match(targetDocument(corpusTarget('/d', null), { hashes: true }).content, new RegExp(`T-1 \\[textSha256 ${'c'.repeat(64)}\\]: Amounts`));
    for (const [role, model] of JUDGMENTS) {
      const mod = promptFor(role, model) as {system: string; fields: readonly string[]; render: (i: unknown) => string};
      assert.ok(mod.fields.includes('target'), `${role}/${model}`);
      const target = role === 'gate' ? unitCorpusTarget('/run/corpus/0123abcd', role === 'gate' ? null : 'docs/vision.md') : corpusTarget('/run/corpus/0123abcd', 'docs/vision.md');
      const text = mod.render({ ...SAMPLES[role][0], target });
      assert.match(text, /<source>corpus rules index \(the pinned corpus files are read-only under \/run\/corpus\/0123abcd/, `${role}/${model}`);
      assert.match(text, / {4}T-2( \[textSha256 c{64}\])?: Totals reconcile monthly\./, `${role}/${model}`);
      if (role === 'gate') {
        assert.match(text, /3 other active rules are readable in \/run\/corpus\/0123abcd/);
        assert.doesNotMatch(text, /Amounts render with two decimals/);
      } else assert.match(text, /Amounts render with two decimals/);
      assert.doesNotMatch(text, /ARCH-A/, `${role}/${model}: the corpus replaces the architecture doc`);
      assert.equal(/textSha256/.test(text), false, `${role}/${model}: only the checkpoint, which writes rule refs, gets the hashes`);
    }
  });

  it('a lens cannot receive a unit corpus target', () => {
    // @ts-expect-error lenses require the complete corpus index
    const bad: LensInputs = { ...SAMPLES.lens[0], target: unitCorpusTarget('/d', null) };
    void bad;
  });

  it('the gate never sees the vision doc: its corpus target carries none, by type and in text (M3 R17)', () => {
    // @ts-expect-error a gate's corpus target cannot name the vision doc
    const bad: GateInputs = { ...SAMPLES.gate[1], target: unitCorpusTarget('/run/corpus/0123abcd', 'docs/vision.md') };
    void bad;
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
      const mod = promptFor('gate', model);
      const text = mod.render({ ...SAMPLES.gate[1], target: { ...unitCorpusTarget('/run/corpus/0123abcd', null), visionDoc: null } });
      assert.doesNotMatch(mod.system + text, /\bvision\b|V-1|serves/i, model);
      assert.ok((GATE_SCHEMA as {properties: {findings: {items: {properties: object}}}}).properties.findings.items.properties.hasOwnProperty('contractRef'), model);
    }
  });

  it('the pack review is the ported Phase-0 review brief: read-only, the architect adjudicates', () => {
    assert.equal(PROMPTS.packReview['claude-opus-5-5'].type, 'prompt');
    const fable = PROMPTS.packReview['claude-fable-5-1'];
    assert.ok(fable.type === 'inherits' && /^\d{4}-\d{2}-\d{2}: /.test(fable.reviewed) && !/placeholder/.test(fable.reviewed));
    const mod = promptFor('packReview', 'claude-opus-5-5');
    for (const needle of [
      /before its first unit is admitted/, /You change nothing/, /adjudicates it/, /holds the arc's first admission/, /Nobody will answer a question/, /fresh session/,
      /Read-only: write no code, create no files, make no commit and edit nothing/, /Judge the pack as drafted/, /Never answer an open question yourself/,
    ]) assert.match(mod.system, needle);
    const text = mod.render(SAMPLES.packReview[1]);
    assert.ok(text.startsWith('<vision>\nVision revision 2\n'), 'the vision first');
    assert.match(text, /<source>spec\.json for unit u-one, revision 2 \(rendered\)<\/source>\n<document_content>\nSPEC-B/);
    assert.match(text, /<rules_index>\ndocs\/0010\.md:\n {2}Overview\n {4}T-2: RULE-B\n<\/rules_index>/);
    assert.match(text, /"census":\[\{"rule":"T-1"/);
    assert.match(text, /"why":"WHY-B"/);
    const out = validatePackReviewOutput(OUTPUTS.packReview);
    assert.deepEqual(out.findings[0]?.target, { type: 'census', rule: 'T-1' });
  });

  it('the flow prompt: the ruler out of reach, one proposal, the lever shapes', () => {
    const fable = PROMPTS.flow['claude-fable-5-1'];
    assert.ok(fable.type === 'inherits' && /^\d{4}-\d{2}-\d{2}: /.test(fable.reviewed) && !/placeholder/.test(fable.reviewed));
    const mod = promptFor('flow', 'claude-opus-5-5');
    for (const needle of [
      /You change nothing/, /Nobody will answer a question/, /propose at most one change to one lever/,
      /The ruler is out of reach/, /you must not argue around them/,
      /may change only the value of one --test-concurrency=<n> element, in place/, /The lane's cpu must cover its concurrency/,
      /whose target is held or wait:finding/, /Exactly one of proposal and noAction/,
    ]) assert.match(mod.system, needle);
    const a = mod.render(SAMPLES.flow[0]);
    assert.match(a, /No chart yet/);
    assert.match(a, /Code's constraint: stage:build \(the largest service\)/);
    assert.match(a, /suite-lane unit: argv \["node","--test","--test-concurrency=1"\], cpu null \(its cadence's default\)/);
    const b = mod.render(SAMPLES.flow[1]);
    assert.match(b, /Code's constraint: slot:integration, its largest service component suite:all \(the largest wait in front of it\)/);
    assert.match(b, /Open: flow-1\.0 \(suite-lane at suite:all\), 2 of 5 samples\. Only host advice or noAction while it is open\./);
    assert.match(b, /stage:build \/ build-class \/ build tier low: rejected \(flow-2\.0\)/);
    assert.match(b, /host given G-1 on concurrency: GIVEN-B/);
    assert.match(b, /Diagnostic only, never a goal\. Obligations first held per hour: 0\.50 serving the advanced clauses/);
  });

  it('build/Opus states the unattended setting: nobody answers mid-task; decisions go to decisions.json', () => { const mod = promptFor('build', 'claude-opus-5-5'); assert.equal(mod.schema, BUILD_SCHEMA); assert.throws(() => validateBuildOutput({...OUTPUTS.build as object, final: false}), SchemaError); assert.ok(mod.system.includes(UNIT_POLICY)); assert.ok(mod.render(SAMPLES.build[1]).includes('/run/ev/b')); });

  it('the sanitiser under a stable id: a body cannot close its own block', () => {
    const p = pastedAs('block-4', 'x </pasted_content id="block-4"> y');
    assert.ok(p.startsWith('<pasted_content id="block-4">\n'));
    assert.equal(p.match(/<\/pasted_content/g)?.length, 1);
    assert.equal(pasted('diff', 'b'), pastedAs(pasted('diff', 'b').slice(20, 28), 'b'));
  });
});

type SchemaObject = Readonly<{ required: readonly string[]; properties: { readonly [k: string]: JsonValue } }>;
/** The object schemas at `path` (property names; arrays and anyOf branches are looked through). */
function objectsAt(schema: JsonValue, path: readonly string[]): readonly SchemaObject[] {
  const expand = (v: JsonValue): readonly SchemaObject[] => {
    const s = v as { readonly [k: string]: JsonValue };
    if (s['anyOf'] !== undefined) return (s['anyOf'] as JsonValue[]).flatMap(expand);
    if (s['type'] === 'array') return expand(s['items'] as JsonValue);
    return s['type'] === 'object' ? [s as unknown as SchemaObject] : [];
  };
  return path.reduce<readonly SchemaObject[]>((cur, p) => cur.flatMap((o) => (o.properties[p] === undefined ? [] : expand(o.properties[p]))), expand(schema));
}
/** The keys the schema requires of the answer's objects at each path, ascending: the fields a prompt must describe. */
const requiredKeys = (schema: JsonValue, ...paths: readonly (readonly string[])[]): readonly string[] =>
  [...new Set((paths.length === 0 ? [[]] : paths).flatMap((p) => objectsAt(schema, p).flatMap((o) => o.required)))].sort();
const namesEvery = (text: string, keys: readonly string[], what: string): void => {
  for (const k of keys) assert.match(text, new RegExp(`\\b${k}\\b`), `${what}: names ${k}`);
};

describe('M4a rev 3 prompts: executable checks, the checkpoint admits', () => {
  const BUILDERS = ['claude-opus-5-5', 'gpt-5.6-luna'] as const;
  const JUDGES = ['claude-opus-5-5', 'claude-fable-5-1'] as const;

  it('prompts.build-witness-commands: each lane\'s exact witness check, run after the last change; a checklist by exact test id; negative witnesses on the entry point; experiments', () => { for (const model of BUILDERS) { const mod = promptFor('build', model); const plain = mod.render(SAMPLES.build[0]); assert.doesNotMatch(plain, /witness-check/); const text = mod.render({...SAMPLES.build[1], fixRound: null}); assert.match(text, /- journey:\n {2}roadmap witness-check --lane-file \/run\/ev\/b\/witness\/journey\.json/); const props = (BUILD_SCHEMA as {properties: Record<string, unknown>}).properties; assert.ok(props['experiments'] && props['grounding'] && props['blockers'] && props['final']); assert.ok(!props['lanesRun'] && !props['changedPaths'] && !props['docsOnlySince']); } });

  it('prompts.build-suite-lanes: the plan\'s resource-free suite lanes as references for targeted checks, reported as experiments; nothing without them', () => {
    for (const model of BUILDERS) {
      const mod = promptFor('build', model);
      assert.doesNotMatch(mod.render(SAMPLES.build[0]), /[Ss]uite lanes?/, `${model}: no suite section without suite lanes`);
      const text = mod.render({ ...SAMPLES.build[1], fixRound: null });
      assert.match(text, /- eslint \(expects exit 0\):\n {2}cd \/wt\/b && env CI=1 npx eslint \./, `${model}: the exact command`);
      for (const needle of [/full lanes stage/, /targeted checks/, /experiments/, /[Dd]o not rehearse the full suite/]) {
        assert.match(text, needle, `build/${model}: ${needle}`);
      }
    }
  });

  it('prompts.build-handover: a fresh session\'s handover renders every record it carries; no handover block without one', () => {
    for (const model of BUILDERS) {
      const mod = promptFor('build', model);
      assert.doesNotMatch(mod.render(SAMPLES.build[0]), /HANDOVER-|[Hh]andover\b(?! in this message)/, `${model}: no handover without one`);
      const text = mod.render({ ...SAMPLES.build[0], handover: SAMPLES.build[1].handover });
      for (const needle of [
        'u-one, u-zero', 'HANDOVER-OUTCOME-B', 'u-zero/lanes#3/unit', 'HANDOVER-HOST-B', 'gen/HANDOVER-REVERTED-B.js', 'u-zero gate attempt 4', 'revise', 'HANDOVER-DIRECTIVE-B',
        'R-3', 'src/b/HANDOVER-FINDING-PATH-B.ts', 'requirement-unmet', 'HANDOVER-FINDING-B', 'A6', 'HANDOVER-CLAUSE-B', 'journey/HANDOVER-WITNESS-B missing',
        'D1 (deferred): HANDOVER-DECISION-B', 'HANDOVER-SUMMARY-B', 'HANDOVER-BLOCKER-B', '/run/ev/HANDOVER-EVIDENCE-B',
      ]) assert.ok(text.includes(needle), `build/${model}: ${needle}`);
    }
  });

  it('gate: the executable checks block (missing with what requires it, killed, survived, inconclusive, why smoke did not run) and the D3 and H1 defect classes', () => {
    for (const model of JUDGES) {
      const mod = promptFor('gate', model);
      assert.doesNotMatch(mod.render(SAMPLES.gate[0]), /executable_checks/, `${model}: no block when neither check applied`);
      const text = mod.render(SAMPLES.gate[1]);
      assert.match(text, /<executable_checks>\nWitness presence: 1 required witness test on the arc lanes at this head\.\n- missing \(absent, skipped, selected zero times, or a malformed record\): journey WITNESS-B \(W-1, target\)\n- failing: none\nMutation smoke \(the unit's production change reverted, its test files kept, the target witness tests run again\):\n- killed: none\n- survived: journey SURVIVOR-B\n- inconclusive: none\n<\/executable_checks>/, model);
      const notRun = mod.render({ ...SAMPLES.gate[1], checks: { witnesses: null, smoke: { killed: [], survived: [], inconclusive: [], notRun: 'no-test-paths' }, regenerated: [] } });
      assert.match(notRun, /<executable_checks>\nMutation smoke did not run: a target lane declares no testPaths, so its test files cannot be told from production code\.\n<\/executable_checks>/);
      // dev.12: the regenerate checks, one line per derived entry the diff touches, in each state.
      const gen = ['node', 'tools/gen.ts'];
      const regenerated = mod.render({ ...SAMPLES.gate[1], checks: { witnesses: null, smoke: null, regenerated: [
        { state: 'verified', outputs: [repoPattern('goldens/**')], argv: gen },
        { state: 'differs', outputs: [repoPattern('dist/a.js')], argv: gen, evidenceDir: absPath('/run/ev/regen') },
        { state: 'not-run', outputs: [repoPattern('dist/b.js')], argv: gen },
        { state: 'no-generator', outputs: [repoPattern('docs/api.md')] },
      ] } });
      assert.match(regenerated, new RegExp([
        '<executable_checks>', 'Regenerated outputs this diff touches \\(plan `derived` entries\\):',
        '- goldens/\\*\\*: verified by regeneration\\. The executor ran \\["node","tools/gen\\.ts"\\] in a clean checkout of this head and every output came out byte-identical to the commit[^\\n]*',
        '- dist/a\\.js: NOT verified\\. [^\\n]*the differences are in /run/ev/regen\\.',
        '- dist/b\\.js: not verified\\. The plan declares \\["node","tools/gen\\.ts"\\] as their generator, but it did not run at this head\\.',
        '- docs/api\\.md: not verified\\. The plan declares no generator for them[^\\n]*', '</executable_checks>',
      ].join('\\n')), model);
      assert.deepEqual(Object.keys((GATE_SCHEMA as {properties: object}).properties).filter((k) => ['findings', 'premises', 'standing'].includes(k)).sort(), ['findings', 'premises', 'standing']);

      assert.doesNotMatch(mod.system + text, /\bvision\b|V-1|serves/i, `${model}: still no vision in the gate`);
    }
  });

  it('prompts.lens-cause-shape: cause as "<affected operation>: <failure condition>", a stable identity for one whole-campaign audit', () => {
    const mod = promptFor('campaignAudit', 'claude-opus-5-5');
    assert.match(mod.system, /cause, the root cause as "<affected operation>: <failure condition>" in lowercase words/);
    for (const sample of SAMPLES.campaignAudit) assert.doesNotMatch(mod.render(sample), /specs_only/);
  });

  it('pack review: spec to rule to census cross-check; deterministic time fixtures, existing tests included; negative witnesses on the real entry point (F07, F12, F19, F20)', () => {
    const sys = promptFor('packReview', 'claude-opus-5-5').system;
    for (const needle of [/Cross-check each spec through its rules to the census/, /whose rule's census state is not obligation for it/, /naming a rule the census marks out-of-slice/,
      /do not pin the product's own clock seam/, /the existing tests the change affects included/, /real clock or the host time zone/, /fixed date the change invalidates/,
      /real wait in a fast lane/, /calls a helper instead of driving the real entry point/]) assert.match(sys, needle);
  });

  it('resolve, respec and steer directives request targeted checks and executor certification', () => {
    for (const directive of [RESOLVE_DIRECTIVE, RESPEC_DIRECTIVE, RESPEC_FRESH_DIRECTIVE, STEER_DIRECTIVE,
      resolveUnmetDirective([{ clause: 'A1', text: 'Implement the change.' }])]) {
      assert.match(directive, /run targeted checks and return your report for executor certification/);
      assert.doesNotMatch(directive, /run the fast lanes/);
    }
  });

  it('fix-round directives: witnesses missing or failing name what requires them; smoke survivors; a repeated red is not flaky', () => {
    const required = [
      { lane: laneId('journey'), testId: 'a > b', source: { type: 'obligation' as const, id: obligationId('I-3') }, role: 'target' as const },
      { lane: laneId('journey'), testId: 'a > b', source: { type: 'witness-item' as const, id: witnessItemId('W-2') }, role: 'target' as const },
      { lane: laneId('journey'), testId: 'c', source: { type: 'obligation' as const, id: obligationId('I-4') }, role: 'preservation' as const },
    ];
    const d = witnessFixDirectives([{ lane: laneId('journey'), testId: 'a > b' }], [{ lane: laneId('journey'), testId: 'c' }], required);
    assert.equal(d.length, 4);
    assert.match(d[0]!, /the gate is not called until every one does/);
    assert.match(d[1]!, /^Missing: test "a > b" on lane journey, which witnesses I-3 \(what this unit delivers or repairs\) and W-2 \(what this unit delivers or repairs\)\. No test with exactly this id ran/);
    assert.match(d[2]!, /^Failing: test "c" on lane journey, which witnesses I-4 \(a must-hold this unit keeps\)\. .*never weaken, skip or rename the test/);
    // Paid M4b run 6: every required id, each once with all its sources, so a fix round cannot trade one for another.
    assert.equal(d[3], [
      'Every required witness test, which must all exist and pass together under exactly these ids:',
      '- test "a > b" on lane journey, which witnesses I-3 (what this unit delivers or repairs) and W-2 (what this unit delivers or repairs)',
      '- test "c" on lane journey, which witnesses I-4 (a must-hold this unit keeps)',
      'Never rename a test that has one of these ids to give it another: the id it had then goes missing. When two ids name the same behaviour, keep a test under each.',
    ].join('\n'));
    assert.throws(() => witnessFixDirectives([], [], required), /names a missing or failing test/);
    assert.throws(() => witnessFixDirectives([{ lane: laneId('journey'), testId: 'z' }], [], required), /not a required witness/);
    const s = smokeFixDirectives([{ lane: laneId('journey'), testId: 'a > b' }], required);
    assert.match(s[0]!, /reverted this unit's production changes, kept its test files/);
    assert.match(s[1]!, /^Survived: test "a > b" on lane journey/);
    assert.match(s[2]!, /already existed before this unit, leave that test as it is/);
    assert.throws(() => smokeFixDirectives([], required), /names a surviving test/);
    assert.match(repeatRedDirective(laneId('unit'), { attempt: 2 }), /^Lane unit failed exactly as it did in attempt 2: .* deterministic, not flaky/);
  });
});

describe('W3 seat prompts (2026-10-16)', () => {
  it('prompts.delegation: the Codex build brief, which has no Agent tool, names none', () => {
    assert.doesNotMatch(promptFor('build', 'gpt-5.6-luna').system, /Agent tool|subagent/);
  });

  it('prompts.gate-bounded-diff: the gate\'s system text describes the three parts of its diff input', () => { const mod = promptFor('gate', 'claude-opus-5-5'); const text = mod.render(SAMPLES.gate[1]); for (const tag of ['orientation', 'diff', 'not_inlined']) assert.ok(text.includes('<'+tag+'>')); assert.ok(text.includes('/files/dist/b.js.diff')); });

  it('prompts.gate-round-2: the gate\'s system text names the answer\'s finding classes and unreviewed field, and how code treats them', () => { const schema = GATE_SCHEMA as {properties: Record<string, JsonValue>; required: string[]}; assert.ok(schema.required.includes('standing')); assert.ok(!schema.required.includes('unreviewed')); const out = validateGateOutput(OUTPUTS.gate); assert.ok(Array.isArray(out.findings)); assert.ok(Array.isArray(out.rulings)); assert.deepEqual((schema.properties['findings'] as {items: {properties: {severity: {enum: string[]}}}}).items.properties.severity.enum, ['blocking', 'note', 'pre-existing', 'ride-along']); });

  it('prompts.gate-large-diff: <large_diff> only over the threshold, with its overflow, path count and list, before the ask; the system text says clusters is null otherwise', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const) {
      const mod = promptFor('gate', model) as { system: string; render: (i: GateInputs) => string };
      assert.match(mod.system, /clusters is null unless[^.]*<large_diff>/);
      const [small, large] = SAMPLES.gate;
      assert.doesNotMatch(mod.render(small), /<large_diff>/, `${model}: under the threshold the plain prompt`);
      const text = mod.render({ ...small, largeDiff: large.largeDiff });
      const section = /<large_diff>\n[^]*<\/large_diff>/.exec(text)?.[0] ?? '';
      for (const needle of ['2741', '3012', '/run/ev/b/diff/CHANGED-LIST-B.txt']) assert.ok(section.includes(needle), `${model}: the section carries ${needle}`);
      for (const depth of CLUSTER_REVIEWS) assert.ok(section.includes(depth), `${model}: the schema's review depth ${depth}`);
      assert.ok(text.indexOf('<large_diff>') < text.lastIndexOf('Gate unit'), 'before the ask');
    }
  });

  it('prompts.escalation-preface: only at the escalation seat, naming a route-up\'s first answer or the risk trigger', () => {
    for (const [role, name] of [['gate', 'gate']] as const) {
      const mod = promptFor(role, 'claude-opus-5-5') as { render: (i: unknown) => string };
      const base = SAMPLES[role][0];
      assert.doesNotMatch(mod.render(base), /<escalation>/, `${role}: nothing below the seat`);
      const routed = mod.render({ ...base, escalation: { kind: 'route-up', first: { decision: 'escalate', reasons: ['FIRST-REASON'] } } });
      assert.match(routed, new RegExp(`<escalation>\\nThis ${name} is an escalation[^]*decided escalate, and the unit was routed up\\. Its reasons:\\n- FIRST-REASON\\n[^]*not as facts[^]*</escalation>`));
      assert.match(mod.render({ ...base, escalation: { kind: 'route-up', first: null } }), /gave no answer \(its session was refused\)/);
      assert.match(mod.render({ ...base, escalation: { kind: 'risk-trigger' } }), /A runtime risk trigger[^]*straight to the escalation seat/);
      assert.ok(routed.indexOf('<escalation>') < routed.lastIndexOf(role === 'gate' ? 'Gate unit' : 'Check the spec'), `${role}: before the ask`);
    }
  });
});

describe('dev.13 prompts: the walkthrough', () => {
  it('prompts.walkthrough-contract: Fable inherits the Opus module with a dated review; the vision opens the message and the ask closes it; the system text names every field the schema requires', () => {
    const fable = PROMPTS.experienceVerdict['claude-fable-5-1'];
    assert.ok(fable.type === 'inherits' && fable.from === 'claude-opus-5-5' && /^\d{4}-\d{2}-\d{2}: /.test(fable.reviewed) && !/placeholder/i.test(fable.reviewed));
    const sample = SAMPLES.walkthrough[0];
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
      const mod = promptFor('walkthrough', model);
      assert.equal(mod, promptFor('walkthrough', 'claude-opus-5-5'), `${model}: the Opus module`);
      assert.equal(mod.schema, EXPERIENCE_SCHEMA, model);
      assert.deepEqual(mod.fields, Object.keys(SAMPLES.walkthrough[0]), model);
      const text = mod.render(sample);
      assert.ok(text.startsWith('<vision>'), `${model}: the vision first`);
      assert.ok(text.endsWith('return your report.'), `${model}: the ask last`);
      for (const needle of [sample.evidenceDir, sample.product.checkout, 'port 4100', 'MODE=A', 'entry /entry-A', 'via browser', '5 steps', '60 s', 'round="1"']) {
        assert.ok(text.includes(needle), `${model}: renders ${needle}`);
      }
      namesEvery(mod.system, requiredKeys(mod.schema, [], ['journeys'], ['findings'], ['findings', 'against'], ['polish'], ['polish', 'unit']), `walkthrough/${model}`);
    }
  });
});

describe('dev.13 prompts: the polish judge', () => {
  it('prompts.polishJudge-contract: Fable inherits the Opus module with a dated review; the vision opens the message and the ask closes it; both instances, the proposal, the diff and the evidence dirs render; the system text names every field the schema requires', () => {
    const fable = PROMPTS.experienceVerdict['claude-fable-5-1'];
    assert.ok(fable.type === 'inherits' && fable.from === 'claude-opus-5-5' && /^\d{4}-\d{2}-\d{2}: /.test(fable.reviewed) && !/placeholder/i.test(fable.reviewed));
    assert.ok(!/PLACEHOLDER/.test(promptFor('polishJudge', 'claude-opus-5-5').system), 'the step-0 placeholder is gone');
    for (const [i, sample] of SAMPLES.polishJudge.entries()) {
      for (const model of ['claude-opus-5-5', 'claude-fable-5-1'] as const) {
        const mod = promptFor('polishJudge', model);
        assert.equal(mod, promptFor('polishJudge', 'claude-opus-5-5'), `${model}: the Opus module`);
        assert.equal(mod.schema, EXPERIENCE_SCHEMA, model);
        assert.deepEqual(mod.fields, Object.keys(SAMPLES.polishJudge[0]), model);
        const text = mod.render(sample);
        assert.ok(text.startsWith('<vision>'), `${model}: the vision first`);
        assert.ok(text.endsWith(`return your decision on proposal ${sample.proposal.id}.`), `${model}: the ask last`);
        const k = i === 0 ? 'A' : 'B';
        for (const needle of [
          `VISION-${k}`, `MILESTONE-${k}`, `JOURNEY-${k}`, `PROPOSAL-${k}`, `REFERENCE-${k}`, `DIFF-${k}`, `shot-${k}.png`, sample.walkEvidenceDir, sample.evidenceDir,
          sample.before.checkout, sample.before.entry, sample.after.checkout, sample.after.entry, `MODE=${k}`, `via="${sample.journey.via}"`,
        ]) assert.ok(text.includes(needle), `${model}: renders ${needle}`);
        assert.ok(text.indexOf('<before>') < text.indexOf('<after>'), `${model}: before, then after`);
        namesEvery(mod.system, requiredKeys(mod.schema, []), `polishJudge/${model}`);
      }
    }
  });
});

it('non-active obligations render only their id and state', () => {
  const waived = { ...observed('I-2', 'HIDDEN STATEMENT', SHA_A), obligation: { ...obligation('I-2', 'HIDDEN STATEMENT'), state: { type: 'waived' as const, reason: 'test disposition', rev: 2 } } };
  const text = obligationsText([waived], { serves: true });
  assert.equal(text, '- I-2: waived by test disposition');
  assert.doesNotMatch(text, /Anchored at/);
});

it('prompt sizes count exact UTF-8 stdin bytes and canonical JSON inputs', () => {
  const module = { system: 'System π', fields: ['text', 'object'] as const, render: (i: { text: string; object: { z: number; a: string } }) => i.text };
  const inputs = { text: '你好', object: { z: 2, a: 'é' } };
  const measured = renderPrompt(module, inputs);
  assert.deepEqual(measured.prompt, { bytes: 6, inputs: { text: 8, object: Buffer.byteLength('{"a":"é","z":2}') } });
  assert.deepEqual(promptSize(module, inputs, inputs.text), measured.prompt);
  assert.equal(renderPrompt(module, inputs, 'codex').prompt.bytes, Buffer.byteLength('System π\n\n你好'));
});

it('ordering answers: only infeasible/escalate can declare nonempty unique blocker identities; older answers stay readable', () => {
  const ok = OUTPUTS as { readonly [R in keyof TestInputs]: Record<string, unknown> };
  const ordering = { blockers: ['u-one', 'u-two'] };
  const gate = { ...ok.gate, decision: 'escalate', directives: [], ordering };
  assert.deepEqual((validateGateOutput(gate) as { ordering: unknown }).ordering, ordering);
  for (const invalid of [{ blockers: [] }, { blockers: ['u-one', 'u-one'] }]) {
    assert.throws(() => validateGateOutput({ ...gate, ordering: invalid }), SchemaError);
  }
  assert.throws(() => validateGateOutput({ ...gate, decision: 'approve' }), /ordering/);
  const { ordering: _g, ...oldGate } = gate;
  assert.equal('ordering' in validateGateOutput(oldGate), false);
});
