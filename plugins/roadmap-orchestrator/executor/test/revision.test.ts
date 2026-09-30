// M3 step A2: the revisioned-input core (src/commands/apply.ts `evaluateRevision`, `commitUnderFence`;
// src/input/{classify,inforce}.ts; src/recover/revision.ts; src/core/fence.ts; src/commands/reverse.ts), over real
// arcs (real git, real journals). The docs publication is step A4's: a stand-in (test/fixtures/docs-fake.ts) writes
// the docs `ff` it leaves in the log. Named tests: apply.ledger-in-manifest, apply.ledger-edit-refused,
// apply.stale-base, apply.route-unit, apply.route-unsupported, apply.limits-below-spent, apply.obligation-added,
// apply.obligation-witness, apply.obligation-split, apply.obligation-disposed, apply.obligation-restored-edited,
// apply.obligation-split-parent-stays, apply.scope-growth-ruling, apply.holistic-add, apply.core-proposal,
// startup.obligation-dropped, apply.legacy-manifest-queued, apply.legacy-manifest-open, reverse.preimage-restores,
// reverse.conflict-refused, reverse.repair-unit-refused, split.checkpoint-drop-divergence, fence.capture-waits,
// revision.crash-after-payload, revision.crash-after-docs, revision.crash-after-fact (the REVISION_COMMIT matrix row's cells).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  type CommandContext, type CommandOutcome, type RevisionContext, applyCommand, commitUnderFence, evaluateRevision, keepRevision, payloadOf,
} from '../src/commands/apply.ts';
import { newCommandId, readReceipt, submitCommand } from '../src/commands/queue.ts';
import { captureUnderFence, holdFence } from '../src/core/fence.ts';
import type { Fact, IntentOf, PlanAppliedFact } from '../src/core/events.ts';
import {
  type DivergenceId, invocationId, jobId, opKey, planRev, sha, sha256, unitId,
} from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import { type CommandBody, isRevisionManifest } from '../src/core/records.ts';
import { absPath, branchName, branchRef } from '../src/core/values.ts';
import { renderInvariants } from '../src/docs/invariants.ts';
import { type DivergenceDraft, laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { commandScope } from '../src/input/classify.ts';
import {
  RENDER_INPUT, type RoutingBase, inForceFiles, keptInput, keptPayload, planManifestOf, readInputFiles, recordPlan, requirePlanInForce, revisionInForce,
  revisionManifestOf, unitRouting,
} from '../src/input/inforce.ts';
import { commitRevisionNow } from '../src/input/inforce.ts';
import { pinDispatch } from '../src/pipeline/dispatch.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { obligationDropped } from '../src/preflight/checks.ts';
import type { StartupContext } from '../src/preflight/startup.ts';
import { commandReconciler } from '../src/recover/command.ts';
import { recover } from '../src/recover/recover.ts';
import { bytesSha256 as fileSha256Bytes, fileSha256 } from '../src/spec/spec.ts';
import { fakeDocs } from './fixtures/docs-fake.ts';
import { REVISION_COMMIT, crashCells } from './matrix.ts';
import { type ArcDescriptor, type ArcRun, applyBody, commandContextFor, contextFor, setupArc } from './fixtures/unit-common.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, makeRepo, revParse, tmpDir } from './helpers/repo.ts';

const T = { timeout: 60_000 };
type Json = Record<string, unknown>;
const BASE: RoutingBase = { profile: 'default', config: null };
const U1 = unitId('u1');
const HEX64 = 'a'.repeat(64);

// ---------------------------------------------------------------------------------------------------
// Files

const planDirOf = (d: ArcDescriptor): string => dirname(d.planPath);
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const writeJson = (path: string, v: unknown): void => writeFileSync(path, JSON.stringify(v));
function editJson(path: string, edit: (v: Json) => void): void {
  const v = readJson(path);
  edit(v);
  writeJson(path, v);
}
const editPlan = (d: ArcDescriptor, edit: (p: Json & { units: Json[] }) => void): void => editJson(d.planPath, edit as (v: Json) => void);
const specPath = (d: ArcDescriptor, unit: string): string => join(planDirOf(d), `${unit}.json`);
const editSpec = (d: ArcDescriptor, unit: string, edit: (s: Json) => void): void => editJson(specPath(d, unit), edit);
const obligationsPath = (d: ArcDescriptor): string => join(planDirOf(d), 'obligations.json');
const editObligations = (d: ArcDescriptor, edit: (o: Json & { obligations: Json[] }) => void): void => editJson(obligationsPath(d), edit as (v: Json) => void);
const ledgerPathOf = (d: ArcDescriptor): string => join(planDirOf(d), 'rulings.md');

function addUnit(d: ArcDescriptor, id: string): void {
  writeJson(specPath(d, id), { ...readJson(specPath(d, 'u1')), unit: id, rev: 1 });
  editPlan(d, (p) => void p.units.push({ ...p.units[0]!, id, spec: `${id}.json` }));
}

const VISION = {
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null, clauses: [
    { id: 'V-1', kind: 'purpose', text: 'Multiply numbers in one call.', rank: null, state: 'active' },
    { id: 'V-2', kind: 'non-negotiable', text: 'Never lose a digit.', rank: null, state: 'active' },
  ],
};
const JOURNEY = { id: 'journey', argv: ['node', '-e', '0'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], reporter: 'jsonl' };
const LANE_REV = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [JOURNEY], obligations: [], mapping: { paths: [] } }).lanes[0]!);

function obligation(id: string, statement: string, over: Json = {}): Json {
  return {
    id, rev: 1, statement, docRef: { path: 'ARCHITECTURE.md', anchor: 'Architecture', quotedText: 'One module' }, serves: ['V-1'],
    witness: { lane: 'journey', testIds: [`t-${id}`] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: LANE_REV },
    deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' }, ...over,
  };
}
const OBLIGATIONS = {
  schema: 'roadmap/obligations-m3', cutLine: 'the arc ends when mul ships', lanes: [JOURNEY],
  obligations: [obligation('I-1', 'mul multiplies. mul(0, x) is 0.'), obligation('I-2', 'add stays fixed.')],
  mapping: { paths: [{ pattern: 'docs/**', obligations: ['I-1'] }] },
};

/** A ruling sidecar of the architect's (its `consistency` is only parsed here: the revisions judged are A1's to check at `rule`). */
function sidecar(id: string, statement: string, over: Json = {}): Json {
  return {
    schema: 'roadmap/ruling-m3', id, statement, kind: 'disposition', ruledBy: { type: 'architect' }, trigger: 'phase 0', supersedes: [], condition: null,
    docRefs: [{ path: 'ARCHITECTURE.md', anchor: 'Architecture', quotedText: 'One module', relation: 'consistent' }], contractRefs: [], contractOps: [],
    obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
    consistency: { verdict: 'consistent', judgedRevs: { head: 'b'.repeat(40), ledgerSha256: HEX64, obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } },
    ...over,
  };
}
function addRuling(d: ArcDescriptor, id: string, statement: string, over: Json = {}): void {
  writeFileSync(ledgerPathOf(d), `${readFileSync(ledgerPathOf(d), 'utf8')}${id} — ${statement}\n`);
  mkdirSync(`${ledgerPathOf(d)}.d`, { recursive: true });
  writeJson(join(`${ledgerPathOf(d)}.d`, `${id}.json`), sidecar(id, statement, over));
}

/** Records the files as revision 1, as an M3 first start does (payload, `revision.commit`, `plan-applied`). */
function recordFirst(d: ArcDescriptor): void {
  const j = openJournal(absPath(d.runDir), d.arc as never);
  recordPlan(j, absPath(d.runDir), readInputFiles(absPath(d.planPath)), [], BASE);
  j.close();
}

/** A holistic arc: the vision, two obligations, C-2 in force dispositioning I-1 (retired) and I-2 (waived); rev 1 recorded by M3. */
function holisticArc(): ArcRun {
  const d = setupArc({ steps: [] });
  writeJson(join(planDirOf(d), 'vision.json'), VISION);
  writeJson(obligationsPath(d), OBLIGATIONS);
  editPlan(d, (p) => void (p['holistic'] = { vision: 'vision.json', obligations: 'obligations.json' }));
  addRuling(d, 'C-2', 'I-1 may retire and I-2 may be waived.', {
    obligations: ['I-1', 'I-2'], obligationDispositions: [{ id: 'I-1', disposition: 'retired' }, { id: 'I-2', disposition: 'waived' }],
  });
  recordFirst(d);
  return contextFor(d);
}

// ---------------------------------------------------------------------------------------------------
// Commands

const ctxOf = (r: ArcRun): CommandContext => ({ ...commandContextFor(r), docs: fakeDocs(r.journal, absPath(r.d.repo), branchName('main')) });
const rctxOf = (r: ArcRun): RevisionContext => ({ runDir: r.ctx.runDir, view: r.journal.view, hostDir: r.ctx.hostDir, planFile: absPath(r.d.planPath), routingBase: BASE });

async function command(r: ArcRun, body: CommandBody): Promise<Readonly<{ id: string; outcome: CommandOutcome }>> {
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  return { id: file.id, outcome: await applyCommand(ctxOf(r), file) };
}
const reasonOf = (o: CommandOutcome): string => (o.kind === 'rejected' ? o.reason : assert.fail(`expected a rejection, got ${JSON.stringify(o)}`));
const applied = (r: ArcRun): readonly PlanAppliedFact[] =>
  readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [e.fact] : []));
const lastApplied = (r: ArcRun): PlanAppliedFact => {
  const f = r.journal.view.planApplied();
  assert.ok(f !== null);
  return f;
};

function pin(r: ArcRun, unit: string): void {
  const u = r.unit(unit);
  const { spec, sha256: s } = loadUnitSpec(r.ctx, u);
  assert.equal(pinDispatch(r.ctx, u, { rev: spec.rev, sha256: s }).kind, 'pinned');
}

// ---------------------------------------------------------------------------------------------------
// The ledger, the stale base, routing, limits

test('apply.ledger-in-manifest: the manifest hashes the ledger and its sidecars, the obligations and the vision; the revision keeps them and plan-applied records them', T, async () => {
  const r = holisticArc();
  try {
    const d = r.d;
    const body = applyBody(d, planRev(1));
    assert.ok(body.type === 'apply' && isRevisionManifest(body.manifest));
    const m = body.manifest;
    assert.equal(m.rulings.ledgerSha256, fileSha256(absPath(ledgerPathOf(d))));
    assert.deepEqual(Object.keys(m.rulings.sidecars), ['C-2']);
    assert.equal(m.obligations, fileSha256(absPath(obligationsPath(d))));
    assert.equal(m.vision, fileSha256(absPath(join(planDirOf(d), 'vision.json'))));
    const first = lastApplied(r);
    assert.deepEqual([first.rev, first.source, first.rulingsSha256, first.obligationsSha256, first.visionSha256], [1, { type: 'start' }, m.rulings.ledgerSha256, m.obligations, m.vision]);

    addUnit(d, 'u2');
    const { id, outcome } = await command(r, applyBody(d, planRev(1)));
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    const fact = lastApplied(r);
    assert.deepEqual([fact.rev, fact.command, fact.source], [2, id, { type: 'command', command: id }]);
    assert.ok(fact.payloadSha256 !== undefined && fact.routingProvenance !== undefined);
    const payload = keptPayload(r.ctx.runDir, fact.payloadSha256);
    assert.deepEqual(payload.manifest.rulings, m.rulings, 'the payload names the ledger and sidecars in force');
    assert.deepEqual([payload.base, payload.rev, payload.publication], [1, 2, null]);
    const commit = r.journal.view.opsOf('revision.commit').at(-1)!;
    assert.deepEqual([commit.expect.payloadSha256, commit.expect.base, commit.expect.docs], [fact.payloadSha256, 1, false]);
    assert.equal(r.journal.view.doneOf(commit.op)?.kind, 'revision.commit');
    const inForce = revisionInForce(r.ctx.runDir, requirePlanInForce(r.ctx.runDir, r.journal.view), absPath(d.planPath));
    assert.deepEqual([...inForce.sidecars.keys()], ['C-2']);
    assert.equal(inForce.vision?.value.rev, 1);
  } finally {
    r.journal.close();
  }
});

test('apply.ledger-edit-refused: the ledger is executor-owned after start (A3): a differing ledger or sidecar refuses the apply', T, async () => {
  const r = holisticArc();
  try {
    writeFileSync(ledgerPathOf(r.d), `${readFileSync(ledgerPathOf(r.d), 'utf8')}C-3 — A hand-written ruling.\n`);
    assert.match(reasonOf((await command(r, applyBody(r.d))).outcome), /the rulings ledger .*rulings\.md or its sidecars differ from the ledger in force: it is executor-owned after start \(A3\); a ruling lands through `roadmap rule`/);
    writeFileSync(ledgerPathOf(r.d), readFileSync(ledgerPathOf(r.d), 'utf8').replace('C-3 — A hand-written ruling.\n', ''));
    editJson(join(`${ledgerPathOf(r.d)}.d`, 'C-2.json'), (s) => void (s['trigger'] = 'edited by hand'));
    assert.match(reasonOf((await command(r, applyBody(r.d))).outcome), /executor-owned after start \(A3\)/);
    assert.equal(applied(r).length, 1, 'nothing applied');
  } finally {
    r.journal.close();
  }
});

test('apply.stale-base: without --expect-rev an apply is refused when the revision in force came from the executor (A4); with it, it applies', T, async () => {
  const d = setupArc({ steps: [] });
  recordFirst(d);
  const r = contextFor(d);
  try {
    // A machine revision (source executor): the plan in force plus a changed direction.
    const rctx = rctxOf(r);
    const inForce = requirePlanInForce(r.ctx.runDir, r.journal.view);
    const current = inForceFiles(r.ctx.runDir, r.journal.view, inForce, revisionInForce(r.ctx.runDir, inForce, absPath(d.planPath)), absPath(d.planPath));
    const planBytes = Buffer.from(JSON.stringify({ ...JSON.parse(current.planBytes.toString('utf8')), direction: 'Machine direction.' }));
    const v = evaluateRevision(rctx, { ...current, planBytes, plan: { ...current.plan, direction: 'Machine direction.' } }, { type: 'executor' });
    assert.equal(v.kind, 'accepted', JSON.stringify(v));
    if (v.kind !== 'accepted') return;
    const inv = invocationId(r.journal.view.opsOf('revision.commit')[0]!.op, 1);
    const machine = await commitUnderFence(ctxOf(r), v, { type: 'executor' }, { type: 'executor', inv }, { type: 'arc' });
    assert.equal(machine.kind, 'applied');
    assert.deepEqual(lastApplied(r).source, { type: 'executor', inv });

    addUnit(d, 'u2');
    assert.match(reasonOf((await command(r, applyBody(d))).outcome), /stale base: plan rev 2 in force came from the executor .*apply with --expect-rev 2/);
    const ok = await command(r, applyBody(d, planRev(2)));
    assert.equal(ok.outcome.kind, 'applied', JSON.stringify(ok.outcome));
    assert.equal(lastApplied(r).rev, 3);
  } finally {
    r.journal.close();
  }
});

test('apply.route-unit: a unit routing layer re-resolves that unit alone (`routing{routingRev, unit}`), scoped to it, with its provenance recorded', T, async () => {
  const d = setupArc({ steps: [] });
  recordFirst(d);
  const r = contextFor(d);
  try {
    editPlan(d, (p) => void (p.units[0]!['routing'] = { gate: { med: 'summit' } }));
    const scope = commandScope({ runDir: r.ctx.runDir, hostDir: r.ctx.hostDir, planFile: absPath(d.planPath), routingBase: BASE });
    assert.deepEqual(scope(applyBody(d) as Parameters<typeof scope>[0], r.journal.view, r.ctx.plan()), { type: 'units', units: ['u1'] });
    const { outcome } = await command(r, applyBody(d));
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    const plan = requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
    const expected = unitRouting(BASE, plan, plan.units[0]!).rev;
    const fact = lastApplied(r);
    assert.deepEqual(fact.changes, [{ type: 'routing', routingRev: expected, unit: U1 }]);
    assert.deepEqual(fact.routingProvenance?.unitLayers, { u1: { gate: { med: 'summit' } } });
    assert.notEqual(expected, r.ctx.routing(null).rev, 'the unit routing differs from the arc routing');
  } finally {
    r.journal.close();
  }
});

test('apply.route-unsupported: a unit layer seating an unsupported triple (a Codex judgment) is refused with its row', T, async () => {
  const d = setupArc({ steps: [] });
  recordFirst(d);
  const r = contextFor(d);
  try {
    editPlan(d, (p) => void (p.units[0]!['routing'] = { planCheck: { med: 'efficient' } }));
    assert.match(reasonOf((await command(r, applyBody(d))).outcome), /"kind":"unsupported-routing".*"role":"planCheck".*"unit":"u1".*"why":"codex-judgment"/);
  } finally {
    r.journal.close();
  }
});

test('apply.limits-below-spent: a bound below what a unit has spent is refused; at or above it applies (`limits{null}`, `limits{unit}`)', T, async () => {
  const d = setupArc({ steps: [] });
  recordFirst(d);
  const r = contextFor(d);
  try {
    pin(r, 'u1');
    for (const attempt of [1, 2]) {
      r.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'plan-check', attempt, outcome: 'refusal', class: 'retry', chargeable: true } as Fact);
    }
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 2);
    editPlan(d, (p) => void (p['limits'] = { chargeable: 1 }));
    assert.match(reasonOf((await command(r, applyBody(d))).outcome), /unit u1: its chargeable bound 1 is below what it has spent \(2\)/);
    editPlan(d, (p) => void (p['limits'] = { chargeable: 2, convergenceK: 1 }));
    const limited = await command(r, applyBody(d));
    assert.equal(limited.outcome.kind, 'applied', JSON.stringify(limited.outcome));
    assert.deepEqual(lastApplied(r).changes, [{ type: 'limits', unit: null }]);
    editPlan(d, (p) => void (p.units[0]!['limits'] = { reviseRounds: 4 }));
    assert.equal((await command(r, applyBody(d))).outcome.kind, 'applied');
    assert.deepEqual(lastApplied(r).changes, [{ type: 'limits', unit: U1 }]);
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Obligations

test('apply.obligation-added: a new obligation is added, rendered into .roadmap/invariants.md and published before its plan-applied', T, async () => {
  const r = holisticArc();
  try {
    editObligations(r.d, (o) => void o.obligations.push(obligation('I-3', 'mul(1, x) is x.')));
    const tip = revParse(r.d.repo, 'main');
    const { outcome } = await command(r, applyBody(r.d));
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    const fact = lastApplied(r);
    assert.deepEqual(fact.changes, [{ type: 'obligation', id: 'I-3', edit: 'added' }]);
    const head = revParse(r.d.repo, 'main');
    assert.notEqual(head, tip);
    assert.deepEqual(fact.publication, { pub: 'docs-1', head });
    const payload = keptPayload(r.ctx.runDir, fact.payloadSha256!);
    assert.equal(payload.publication?.renders.length, 1);
    const render = payload.publication!.renders[0]!;
    assert.equal(render.path, '.roadmap/invariants.md');
    const bytes = keptInput(r.ctx.runDir, render.sha256, RENDER_INPUT);
    assert.ok(bytes !== null, 'the render is kept');
    assert.match(bytes.toString('utf8'), /## I-3 — mul\(1, x\) is x\./);
    assert.equal(r.journal.view.opsOf('revision.commit').at(-1)!.expect.docs, true);
  } finally {
    r.journal.close();
  }
});

test('apply.obligation-witness: a changed witness with a fresh proof is `witness`; a shrunk test set is weakening and needs a ruling', T, async () => {
  const r = holisticArc();
  try {
    editObligations(r.d, (o) => void (o.obligations[1]!['witness'] = { lane: 'journey', testIds: ['t-I-2', 't-I-2b'] }));
    assert.equal((await command(r, applyBody(r.d))).outcome.kind, 'applied');
    assert.deepEqual(lastApplied(r).changes, [{ type: 'obligation', id: 'I-2', edit: 'witness' }]);
    editObligations(r.d, (o) => void (o.obligations[0]!['witness'] = { lane: 'journey', testIds: ['t-other'] }));
    assert.match(reasonOf((await command(r, applyBody(r.d))).outcome), /I-1 is weakened \(witness no longer names "t-I-1"\) without a ruling in force naming it amended/);
  } finally {
    r.journal.close();
  }
});

test('apply.obligation-split: the architect\'s split keeps the parent\'s text in its children; one dropping text is refused', T, async () => {
  const r = holisticArc();
  try {
    const children = (second: string): void => editObligations(r.d, (o) => {
      o.obligations[0] = { ...o.obligations[0]!, state: { type: 'split', children: ['I-4', 'I-5'] }, witness: null, proofJudgment: null };
      o.obligations.push(obligation('I-4', 'mul multiplies.', { parent: 'I-1' }), obligation('I-5', second, { parent: 'I-1' }));
    });
    children('Zero times anything.');
    assert.match(reasonOf((await command(r, applyBody(r.d))).outcome), /I-1's children drop parent text: "mul\(0, x\) is 0\."/);
    writeJson(obligationsPath(r.d), OBLIGATIONS);
    children('mul(0, x) is 0.');
    assert.equal((await command(r, applyBody(r.d))).outcome.kind, 'applied');
    assert.deepEqual(lastApplied(r).changes, [{ type: 'obligation', id: 'I-1', edit: 'split' }]);
    assert.deepEqual(keptPayload(r.ctx.runDir, lastApplied(r).payloadSha256!).divergences, [], 'the architect\'s split records no divergence');
  } finally {
    r.journal.close();
  }
});

test('apply.obligation-disposed: a weakening a ruling in force dispositions is `disposed`, its disposition in the payload', T, async () => {
  const r = holisticArc();
  try {
    editObligations(r.d, (o) => void (o.obligations[1]!['state'] = { type: 'waived', ruling: 'C-2' }));
    assert.equal((await command(r, applyBody(r.d))).outcome.kind, 'applied');
    const fact = lastApplied(r);
    assert.deepEqual(fact.changes, [{ type: 'obligation', id: 'I-2', edit: 'disposed' }]);
    assert.deepEqual(keptPayload(r.ctx.runDir, fact.payloadSha256!).dispositions, [{ obligation: 'I-2', disposition: 'waived', ruling: 'C-2' }]);
    editObligations(r.d, (o) => void (o.obligations[0]!['statement'] = 'mul multiplies.'));
    assert.match(reasonOf((await command(r, applyBody(r.d))).outcome), /I-1 is weakened \(statement changed\) without a ruling in force naming it amended/);
  } finally {
    r.journal.close();
  }
});

test('apply.obligation-restored-edited: an exempt obligation made active again is `restored`; serves or future → must-hold is `edited`', T, async () => {
  const r = holisticArc();
  try {
    editObligations(r.d, (o) => void (o.obligations[1]!['state'] = { type: 'waived', ruling: 'C-2' }));
    assert.equal((await command(r, applyBody(r.d))).outcome.kind, 'applied');
    editObligations(r.d, (o) => {
      o.obligations[1]!['state'] = { type: 'active' };
      o.obligations[0]!['serves'] = ['V-1', 'V-2'];
    });
    assert.equal((await command(r, applyBody(r.d))).outcome.kind, 'applied');
    assert.deepEqual(lastApplied(r).changes, [{ type: 'obligation', id: 'I-1', edit: 'edited' }, { type: 'obligation', id: 'I-2', edit: 'restored' }]);
  } finally {
    r.journal.close();
  }
});

test('apply.obligation-split-parent-stays: a split parent is never disposed, even with a ruling naming it (H14)', T, async () => {
  const r = holisticArc();
  try {
    editObligations(r.d, (o) => {
      o.obligations[0] = { ...o.obligations[0]!, state: { type: 'split', children: ['I-4'] }, witness: null, proofJudgment: null };
      o.obligations.push(obligation('I-4', 'mul multiplies. mul(0, x) is 0.', { parent: 'I-1' }));
    });
    assert.equal((await command(r, applyBody(r.d))).outcome.kind, 'applied');
    // Retiring the parent (C-2 names I-1 retired): a split parent is never disposed; its family leaves with its children.
    editObligations(r.d, (o) => {
      o.obligations = o.obligations.filter((x) => x['id'] !== 'I-1' && x['id'] !== 'I-4');
      o['mapping'] = { paths: [{ pattern: 'docs/**', obligations: ['I-2'] }] };
    });
    const reason = reasonOf((await command(r, applyBody(r.d))).outcome);
    assert.match(reason, /I-1 is split into I-4 and stays split: disposition its children instead \(H14\)/);
    assert.match(reason, /I-4 is weakened \(removed\) without a ruling in force naming it retired/);
  } finally {
    r.journal.close();
  }
});

test('apply.scope-growth-ruling: a dispatched unit\'s scope grows only with a cited ruling for it naming exactly the added patterns', T, async () => {
  const d = setupArc({ steps: [] });
  addRuling(d, 'C-2', 'u1 may also edit `docs/**`.', { kind: 'decision', appliesTo: { type: 'units', units: ['u1'] } });
  recordFirst(d);
  const r = contextFor(d);
  try {
    pin(r, 'u1');
    const grow = (cites: readonly string[]): void => {
      editPlan(d, (p) => void (p.units[0]!['scope'] = ['src/**', 'test/**', 'contracts/**', 'docs/**']));
      editSpec(d, 'u1', (s) => {
        s['rev'] = 2;
        s['scope'] = ['src/**', 'test/**', 'contracts/**', 'docs/**'];
        s['cites'] = { contracts: ['contracts/api.md'], rulings: cites };
      });
    };
    grow(['C-1']);
    const reason = reasonOf((await command(r, applyBody(d))).outcome);
    assert.match(reason, /unit u1 is dispatched: its scope grows by docs\/\*\* without its spec citing an active ruling for u1 that names exactly those patterns/);
    assert.match(reason, /its spec's scope grows by docs\/\*\*/);
    grow(['C-1', 'C-2']);
    const ok = await command(r, applyBody(d));
    assert.equal(ok.outcome.kind, 'applied', JSON.stringify(ok.outcome));
    assert.deepEqual(lastApplied(r).changes.map((c) => c.type), ['unit-changed', 'spec']);
  } finally {
    r.journal.close();
  }
});

test('apply.holistic-add: `holistic` and the vision may be added (A5); removing holistic is refused', T, async () => {
  const d = setupArc({ steps: [] });
  recordFirst(d);
  const r = contextFor(d);
  try {
    writeJson(join(planDirOf(d), 'vision.json'), VISION);
    editPlan(d, (p) => void (p['holistic'] = { vision: 'vision.json' }));
    const v = evaluateRevision(rctxOf(r), readInputFiles(absPath(d.planPath)), { type: 'apply' });
    assert.equal(v.kind, 'accepted', JSON.stringify(v));
    if (v.kind === 'accepted') assert.deepEqual(v.draft.changes, [{ type: 'holistic' }, { type: 'vision', rev: 1 }]);
    const start = evaluateRevision(rctxOf(r), readInputFiles(absPath(d.planPath)), { type: 'start' });
    assert.ok(start.kind === 'rejected' && start.reasons.some((x) => /the vision is owner-only \(A14\): only an architect `apply` changes it, not a start/.test(x)));
  } finally {
    r.journal.close();
  }
  const h = holisticArc();
  try {
    editPlan(h.d, (p) => void delete p['holistic']);
    assert.match(reasonOf((await command(h, applyBody(h.d))).outcome), /holistic may be added, never removed \(A5\)/);
  } finally {
    h.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// The apply core, the fence

test('apply.core-proposal: the core evaluates an in-memory proposal from any proposer; a rule may change the ledger, an apply may not', T, async () => {
  const r = holisticArc();
  try {
    const rctx = rctxOf(r);
    const inForce = requirePlanInForce(r.ctx.runDir, r.journal.view);
    const current = inForceFiles(r.ctx.runDir, r.journal.view, inForce, revisionInForce(r.ctx.runDir, inForce, absPath(r.d.planPath)), absPath(r.d.planPath));
    assert.equal(evaluateRevision(rctx, current, { type: 'rule' }).kind, 'unchanged', 'the plan in force as files changes nothing');
    const ledger = { ...current.ledger, bytes: Buffer.concat([current.ledger.bytes!, Buffer.from('C-3 — A rule.\n')]) };
    const proposal = { ...current, ledger };
    const asApply = evaluateRevision(rctx, proposal, { type: 'apply' });
    assert.ok(asApply.kind === 'rejected' && asApply.reasons.some((x) => /executor-owned after start \(A3\)/.test(x)));
    const asRule = evaluateRevision(rctx, proposal, { type: 'rule' });
    assert.equal(asRule.kind, 'accepted', JSON.stringify(asRule));
    if (asRule.kind !== 'accepted') return;
    assert.deepEqual(asRule.draft.changes, [], 'a ledger line alone is no plan change');
    assert.deepEqual(asRule.draft.publication?.renders.map((x) => x.path), ['.roadmap/constraints.md']);
    const rule = newCommandId();
    const committed = await commitUnderFence(ctxOf(r), asRule, { type: 'rule' }, { type: 'command', command: rule }, { type: 'command', command: rule });
    assert.equal(committed.kind, 'applied', JSON.stringify(committed));
    const fact = lastApplied(r);
    assert.deepEqual([fact.rev, fact.command, fact.rulingsSha256, fact.publication?.pub], [2, rule, fileSha256Bytes(ledger.bytes), 'docs-1']);
    const now = revisionInForce(r.ctx.runDir, requirePlanInForce(r.ctx.runDir, r.journal.view), absPath(r.d.planPath));
    assert.match(now.ledger.bytes.toString('utf8'), /C-3 — A rule\.\n$/, 'the ledger in force is the kept one, not the live file');
  } finally {
    r.journal.close();
  }
});

test('fence.capture-waits: a capture under the fence waits for a revision holding it, then reads what it committed (H2)', T, async () => {
  const d = setupArc({ steps: [] });
  recordFirst(d);
  const r = contextFor(d);
  try {
    const hold = await holdFence(r.journal);
    const seen: number[] = [];
    const capture = captureUnderFence(r.journal, () => seen.push(r.journal.view.planApplied()!.rev));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [], 'the capture waits while a revision holds the fence');
    addUnit(d, 'u2');
    const v = evaluateRevision(rctxOf(r), readInputFiles(absPath(d.planPath)), { type: 'apply' });
    assert.ok(v.kind === 'accepted');
    keepRevision(r.ctx.runDir, v);
    commitRevisionNow(r.journal, r.ctx.runDir, payloadOf(v.draft, { type: 'start' }), { type: 'arc' });
    hold.release();
    await capture;
    assert.deepEqual(seen, [2], 'it captured the revision the holder committed');
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Re-derivation at Phase 0

test('startup.obligation-dropped: a published obligation missing or weakened with no Phase-0 ruling dispositioning it is refused; a split parent is present', T, () => {
  const published = parseObligations(OBLIGATIONS);
  const repo = absPath(makeRepo(tmpDir('rederive-repo'), { files: { '.roadmap/invariants.md': renderInvariants(published, []), 'README.md': 'x\n' } }));
  const d = setupArc({ steps: [] });
  writeJson(join(planDirOf(d), 'vision.json'), VISION);
  editPlan(d, (p) => {
    p['holistic'] = { vision: 'vision.json', obligations: 'obligations.json' };
    p['baseline'] = revParse(repo, 'main');
  });
  const context = (): StartupContext => {
    const files = readInputFiles(absPath(d.planPath));
    return { repo, planFile: absPath(d.planPath), plan: files.plan, specOf: () => null, profile: 'default', runDir: absPath(d.runDir), hostDir: absPath(d.hostDir) };
  };
  const dropped = (): readonly string[] => obligationDropped(context(), readInputFiles(absPath(d.planPath)));
  writeJson(obligationsPath(d), { ...OBLIGATIONS, obligations: [OBLIGATIONS.obligations[0]] });
  assert.deepEqual(dropped(), ['obligation-dropped: I-2 (removed) has no Phase-0 ruling naming it retired']);
  writeJson(obligationsPath(d), { ...OBLIGATIONS, obligations: [OBLIGATIONS.obligations[0], obligation('I-2', 'add stays fixed, mostly.', { rev: 2 })] });
  assert.deepEqual(dropped(), ['obligation-dropped: I-2 (statement changed) has no Phase-0 ruling naming it amended']);
  addRuling(d, 'C-2', 'I-2 retires with this arc.', { obligations: ['I-2'], obligationDispositions: [{ id: 'I-2', disposition: 'retired' }] });
  writeJson(obligationsPath(d), { ...OBLIGATIONS, obligations: [OBLIGATIONS.obligations[0]] });
  assert.deepEqual(dropped(), [], 'a Phase-0 ruling dispositions it');
  writeJson(obligationsPath(d), {
    ...OBLIGATIONS,
    obligations: [
      { ...OBLIGATIONS.obligations[0], state: { type: 'split', children: ['I-4'] }, witness: null, proofJudgment: null },
      obligation('I-4', 'mul multiplies. mul(0, x) is 0.', { parent: 'I-1' }),
    ],
  });
  assert.deepEqual(dropped(), [], 'a split parent counts as present');
});

// ---------------------------------------------------------------------------------------------------
// The legacy manifest (G15)

/** An apply as 1.0.0-dev.5 queued it: a plan manifest only. */
function legacyBody(d: ArcDescriptor, expectRev: number | null): CommandBody {
  const m = revisionManifestOf(readInputFiles(absPath(d.planPath)));
  assert.ok(!('missing' in m));
  return { type: 'apply', expectRev: expectRev === null ? null : planRev(expectRev), manifest: planManifestOf(m) };
}

test('apply.legacy-manifest-queued: a dev.5 command\'s plan manifest applies (the ledger live, no obligations or vision); its bytes are never rewritten', T, async () => {
  const d = setupArc({ steps: [] });
  const r = contextFor(d);
  try {
    addUnit(d, 'u2');
    const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, legacyBody(d, 1));
    const path = join(r.ctx.runDir, 'commands', 'incoming', `${file.id}.json`);
    const before = readFileSync(path);
    const outcome = await applyCommand(ctxOf(r), file);
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    assert.deepEqual(readFileSync(path), before, 'the command file is untouched');
    const fact = lastApplied(r);
    assert.deepEqual([fact.rev, fact.command, fact.rulingsSha256], [2, file.id, fileSha256(absPath(ledgerPathOf(d)))]);
    assert.equal(fact.visionSha256, undefined);
    assert.deepEqual(keptPayload(r.ctx.runDir, fact.payloadSha256!).manifest.obligations, null);
  } finally {
    r.journal.close();
  }
});

test('apply.legacy-manifest-open: a dev.5 command whose op a dev.5 executor opened is finished by recovery under the legacy reading', T, async () => {
  const d = setupArc({ steps: [] });
  const r = contextFor(d);
  try {
    addUnit(d, 'u2');
    const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, legacyBody(d, 1));
    const bytes = readFileSync(join(r.ctx.runDir, 'commands', 'incoming', `${file.id}.json`));
    const { op } = r.journal.begin({
      kind: 'command.apply', key: opKey(`command:${file.id}`), parent: { type: 'command', command: file.id }, deadlineAt: null,
      body: () => ({ expect: { command: file.id, commandSha256: fileSha256(absPath(join(r.ctx.runDir, 'commands', 'incoming', `${file.id}.json`))) }, post: null }),
    });
    const intent = r.journal.view.latestIntent(op) as IntentOf<'command.apply'>;
    const disposition = await commandReconciler(ctxOf(r))(intent, r.journal.view);
    assert.ok(disposition.kind === 'done' && disposition.outcome.kind === 'applied', JSON.stringify(disposition));
    r.journal.done(op, 'command.apply', disposition.outcome, 'reconciled');
    assert.deepEqual(readFileSync(join(r.ctx.runDir, 'commands', 'incoming', `${file.id}.json`)), bytes);
    assert.deepEqual(applied(r).map((f) => [f.rev, f.command]), [[1, null], [2, file.id]]);
    assert.equal(readReceipt(r.ctx.runDir, file.id, 'applied')?.state, 'applied');
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Checkpoint revisions, divergences, reverse (H13, H14)

const CKPT = jobId('ckpt', 1);

/** A checkpoint job's captured inputs (its trigger a park), so a bundle revision and its divergences may follow. */
function checkpointInputs(r: ArcRun): void {
  const visionSha256 = r.journal.view.planApplied()?.visionSha256 ?? sha256(HEX64);
  r.journal.fact({
    kind: 'checkpoint-inputs', job: CKPT, trigger: { type: 'park', unit: U1, seq: 1 }, generation: 1,
    vector: { plan: 1, specs: {}, obligationsSha256: null, ledgerSha256: null, visionSha256, contracts: [] },
    headSha: sha(revParse(r.d.repo, 'main')), visionSha256, findings: [], observations: [],
  });
}

const divergence = (kind: 'restore-revision' | 'repair-unit'): DivergenceDraft => ({
  job: CKPT, type: 'plan-departed', from: 'plan rev 1', what: 'admitted u2', cites: ['V-1' as never], evidence: ['the park of u1'],
  preimage: { planRev: 1, specs: {}, obligationsSha256: null, ledgerSha256: null, contracts: [] },
  compensation: { hint: kind === 'repair-unit' ? 'src/mul.js changed: a repair unit restores it' : '`reverse` removes u2', kind },
});

/** A bundle revision admitting u2 (the files' plan), with one divergence; the live files keep u2. */
function bundleAdmitsU2(r: ArcRun, kind: 'restore-revision' | 'repair-unit'): void {
  checkpointInputs(r);
  addUnit(r.d, 'u2');
  const v = evaluateRevision(rctxOf(r), readInputFiles(absPath(r.d.planPath)), { type: 'bundle', job: CKPT, cites: ['V-1' as never], evidence: ['the park of u1'] });
  assert.equal(v.kind, 'accepted', JSON.stringify(v));
  if (v.kind !== 'accepted') return;
  keepRevision(r.ctx.runDir, v);
  commitRevisionNow(r.journal, r.ctx.runDir, payloadOf({ ...v.draft, divergences: [divergence(kind)] }, { type: 'bundle', job: CKPT }), { type: 'job', job: CKPT });
  assert.deepEqual(r.journal.view.holistic().divergences.map((x) => [x.id, x.index, x.type]), [['D-1', 0, 'plan-departed']]);
}

test('reverse.preimage-restores: `reverse <D-n>` builds a fresh compensating revision from the preimage and commits it', T, async () => {
  const d = setupArc({ steps: [] });
  recordFirst(d);
  const r = contextFor(d);
  try {
    bundleAdmitsU2(r, 'restore-revision');
    assert.deepEqual(requirePlanInForce(r.ctx.runDir, r.journal.view).plan.units.map((u) => u.id), ['u1', 'u2']);
    const { id, outcome } = await command(r, { type: 'reverse', divergence: 'D-1' as DivergenceId });
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    const fact = lastApplied(r);
    assert.deepEqual([fact.rev, fact.command, fact.changes], [3, id, [{ type: 'unit-removed', unit: 'u2' }]]);
    const plan1 = applied(r)[0]!;
    assert.equal(fact.planSha256, plan1.planSha256, 'the plan of the preimage is back in force');
    assert.match(reasonOf((await command(r, { type: 'reverse', divergence: 'D-9' as DivergenceId })).outcome), /unknown divergence D-9/);
  } finally {
    r.journal.close();
  }
});

test('reverse.conflict-refused: a later revision that changed the touched artifact again refuses the reverse, with reasons', T, async () => {
  const d = setupArc({ steps: [] });
  recordFirst(d);
  const r = contextFor(d);
  try {
    bundleAdmitsU2(r, 'restore-revision');
    editPlan(d, (p) => void (p.units[1]!['risk'] = 'high'));
    assert.equal((await command(r, applyBody(d, planRev(2)))).outcome.kind, 'applied');
    const reason = reasonOf((await command(r, { type: 'reverse', divergence: 'D-1' as DivergenceId })).outcome);
    assert.match(reason, /^reverse rejected \(1 reason\): \(1\) the plan changed again after D-1's act \(plan rev 2\); reverse it with `roadmap apply`$/);
    assert.equal(lastApplied(r).rev, 3, 'nothing reversed');
  } finally {
    r.journal.close();
  }
});

test('reverse.repair-unit-refused: a divergence whose effect is in the product tree is reversed only by a repair unit', T, async () => {
  const d = setupArc({ steps: [] });
  recordFirst(d);
  const r = contextFor(d);
  try {
    bundleAdmitsU2(r, 'repair-unit');
    const reason = reasonOf((await command(r, { type: 'reverse', divergence: 'D-1' as DivergenceId })).outcome);
    assert.match(reason, /D-1's effect is in the product tree: a verified repair unit reverses it \(§2\.8\), not `reverse` \(src\/mul\.js changed: a repair unit restores it\)/);
  } finally {
    r.journal.close();
  }
});

test('split.checkpoint-drop-divergence: a checkpoint split may drop text only citing clauses; code records a `split-dropped` divergence with its preimage', T, async () => {
  const r = holisticArc();
  try {
    checkpointInputs(r);
    const inForce = requirePlanInForce(r.ctx.runDir, r.journal.view);
    const revision = revisionInForce(r.ctx.runDir, inForce, absPath(r.d.planPath));
    const current = inForceFiles(r.ctx.runDir, r.journal.view, inForce, revision, absPath(r.d.planPath));
    const split = {
      ...OBLIGATIONS,
      obligations: [
        { ...OBLIGATIONS.obligations[0], state: { type: 'split', children: ['I-4'] }, witness: null, proofJudgment: null },
        OBLIGATIONS.obligations[1], obligation('I-4', 'mul multiplies.', { parent: 'I-1' }),
      ],
    };
    const proposal = { ...current, obligations: { path: current.obligations!.path, bytes: Buffer.from(JSON.stringify(split)) } };
    const byArchitect = evaluateRevision(rctxOf(r), proposal, { type: 'apply' });
    assert.ok(byArchitect.kind === 'rejected' && byArchitect.reasons.some((x) => /I-1's children drop parent text: "mul\(0, x\) is 0\."/.test(x)));
    const uncited = evaluateRevision(rctxOf(r), proposal, { type: 'bundle', job: CKPT, cites: [], evidence: ['zero is handled by I-2'] });
    assert.ok(uncited.kind === 'rejected' && uncited.reasons.some((x) => /I-1's split drops parent text without citing a vision clause/.test(x)));
    const v = evaluateRevision(rctxOf(r), proposal, { type: 'bundle', cites: ['V-2' as never], job: CKPT, evidence: ['zero is handled by I-2'] });
    assert.equal(v.kind, 'accepted', JSON.stringify(v));
    if (v.kind !== 'accepted') return;
    assert.equal(v.draft.divergences.length, 1);
    const committed = await commitUnderFence(ctxOf(r), v, { type: 'bundle', cites: ['V-2' as never], job: CKPT, evidence: ['zero is handled by I-2'] }, { type: 'bundle', job: CKPT }, { type: 'job', job: CKPT });
    assert.equal(committed.kind, 'applied', JSON.stringify(committed));
    const [d1] = r.journal.view.holistic().divergences;
    assert.ok(d1 !== undefined);
    assert.deepEqual([d1.id, d1.type, d1.cites, d1.job, d1.compensation.kind], ['D-1', 'split-dropped', ['V-2'], CKPT, 'restore-revision']);
    assert.match(d1.what, /drops "mul\(0, x\) is 0\."/);
    assert.deepEqual(d1.preimage, { planRev: 1, specs: {}, obligationsSha256: revision.obligations!.sha256, ledgerSha256: null, contracts: [] });
    assert.deepEqual(lastApplied(r).source, { type: 'bundle', job: CKPT });
    assert.deepEqual(r.journal.view.holistic().checkpoints[0]?.decided, { kind: 'applied', planRev: 2 });
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Crash: the activation payload before any ff (G1). The cells are the matrix row's (test/matrix.ts REVISION_COMMIT).

describe(`matrix row ${REVISION_COMMIT}`, () => {
  const cells = crashCells(REVISION_COMMIT);

  test('lists the revision commit\'s crash points', () => {
    assert.deepEqual(cells.map((c) => `${c.boundary} ${c.label}`), ['B2 revision.commit.after-intent', 'B3 revision.commit.after-docs', 'B4 revision.commit.after-fact']);
  });

  /** An `apply` adding an obligation (a docs publication), its child crashed at `label`; the arc and the command id. */
  async function crashAt(label: string): Promise<Readonly<{ d: ArcDescriptor; id: string }>> {
    const r = holisticArc();
    const d = r.d;
    editObligations(d, (o) => void o.obligations.push(obligation('I-3', 'mul(1, x) is x.')));
    const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(d, planRev(1)));
    r.journal.close();
    const trigger = writeTrigger(tmpDir('revision-crash'), { label, occurrence: 1 });
    const exit = await runFixture('revision-child.ts', [JSON.stringify(d), file.id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 30_000 });
    assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stderr ${exit.stderr}`);
    assertFired(trigger);
    return { d, id: file.id };
  }

  const openCommit = (r: ArcRun): IntentOf<'revision.commit'> => {
    const open = r.journal.view.openIntents().find((i) => i.kind === 'revision.commit') as IntentOf<'revision.commit'> | undefined;
    assert.ok(open !== undefined, 'the commit is open');
    return open;
  };

  /** Per label: the state the crash left, the whole recovery, and what it must come to. */
  const CHECKS: Readonly<Record<string, Readonly<{ name: string; check: (r: ArcRun, id: string) => Promise<void> }>>> = {
    'revision.commit.after-intent': {
      name: 'revision.crash-after-payload: kept payload and intent, no docs ff → recovery aborts the commit and the apply re-evaluates and commits once',
      check: async (r, id) => {
        const open = openCommit(r);
        assert.ok(keptInput(r.ctx.runDir, open.expect.payloadSha256, 'revision.json') !== null, 'its payload is kept before it is named');
        assert.equal(r.journal.view.opsOf('integration.ff').length, 0, 'no ff');
        await recover({ stage: r.ctx, commands: ctxOf(r) });
        assert.equal(r.journal.view.doneOf(open.op), null, 'the crashed commit is aborted, not done');
        assert.deepEqual(applied(r).map((f) => [f.rev, f.command]), [[1, null], [2, id]]);
        assert.equal(r.journal.view.opsOf('integration.ff').length, 1, 'one docs ff, by the re-evaluated commit');
      },
    },
    'revision.commit.after-docs': {
      name: 'revision.crash-after-docs: docs ff published, no plan-applied → recovery appends exactly the payload, with the publication',
      check: async (r, id) => {
        const open = openCommit(r);
        assert.equal(applied(r).length, 1, 'no plan-applied yet');
        const head = revParse(r.d.repo, 'main');
        await recover({ stage: r.ctx, commands: ctxOf(r) });
        const fact = lastApplied(r);
        assert.deepEqual([fact.rev, fact.command, fact.payloadSha256, fact.publication], [2, id, open.expect.payloadSha256, { pub: 'docs-1', head }]);
        const payload = keptPayload(r.ctx.runDir, open.expect.payloadSha256);
        assert.deepEqual(fact.changes, payload.changes);
        assert.equal(canonicalJson(fact.routingProvenance), canonicalJson(payload.routingProvenance));
        assert.equal(r.journal.view.doneOf(open.op)?.kind, 'revision.commit', 'the commit is done');
        assert.equal(r.journal.view.opsOf('integration.ff').length, 1, 'the one docs ff');
        assert.equal(git(r.d.repo, 'rev-parse', branchRef(branchName('main'))), head);
      },
    },
    'revision.commit.after-fact': {
      name: 'revision.crash-after-fact: plan-applied written, the commit open → recovery closes it reconciled with no second fact',
      check: async (r, id) => {
        const open = openCommit(r);
        const before = lastApplied(r);
        assert.deepEqual([before.rev, before.payloadSha256], [2, open.expect.payloadSha256]);
        await recover({ stage: r.ctx, commands: ctxOf(r) });
        assert.deepEqual(applied(r).map((f) => [f.rev, f.command]), [[1, null], [2, id]], 'one plan-applied');
        const done = readJournal(r.ctx.runDir, r.journal.view.arc).events.find((e) => e.type === 'done' && e.op === open.op);
        assert.ok(done !== undefined && done.type === 'done' && done.recoveredBy === 'reconciled', 'the commit closes reconciled');
        assert.equal(r.journal.view.opsOf('integration.ff').length, 1, 'the one docs ff');
      },
    },
  };

  for (const cell of cells) {
    const c = CHECKS[cell.label];
    if (c === undefined) throw new Error(`no check for ${cell.label}`);
    test(`${c.name} (${cell.boundary} ${cell.label})`, T, async () => {
      const { d, id } = await crashAt(cell.label);
      const r = contextFor(d);
      try {
        await c.check(r, id);
        assert.equal(readReceipt(r.ctx.runDir, id as never, 'applied')?.state, 'applied');
        assert.deepEqual(r.journal.view.openIntents(), [], 'recovery leaves nothing open');
      } finally {
        r.journal.close();
      }
    });
  }
});

