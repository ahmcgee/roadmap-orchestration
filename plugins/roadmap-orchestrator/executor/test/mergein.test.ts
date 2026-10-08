// Integrated tests of mergein.prepare (src/git/mergein.ts, src/recover/mergein.ts): real git, the unit's
// real worktree, crash cells in a child process killed at crashPoints. The plan's merge.conflict-mergein
// and the mergein.prepare matrix row.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import type { Sha } from '../src/core/ids.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import { candidatePostcondition, planCandidate } from '../src/git/candidate.ts';
import { classifyMergein, mergeHead, mergeinCompleted, parentsOf } from '../src/git/mergein.ts';
import { diffBase, unitDiffPaths } from '../src/git/transient.ts';
import { IDENTITY, openArc, runOp } from './fixtures/git-common.ts';
import {
  INTEGRATION, MERGEIN_MESSAGE, type Scene, UNIT_BRANCH, candidateRequest, crashChild8b, recover8b, revOf, scene, sharedBase,
} from './fixtures/git8b-common.ts';
import { git, writeFiles } from './helpers/repo.ts';
import { MERGEIN, crashCells } from './matrix.ts';
import { candidateMergeOp, mergeinOp } from '../src/recover/ops.ts';
import { applyCommand } from '../src/commands/apply.ts';
import { readReceipt, submitCommand } from '../src/commands/queue.ts';
import { type CommandId, type NeedsUserId, commandId } from '../src/core/ids.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { unitBranch } from '../src/pipeline/dispatch.ts';
import { latestSpecSeries } from '../src/pipeline/lanes.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { commitAll, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import {
  type ArcRun, U1, commandContextFor, contextFor, gateStep, isGateCall, mulBuild, outcomes, setupArc, unitWorktreePath,
} from './fixtures/unit-common.ts';
import { events } from './fixtures/invoke-specs.ts';
import { MERGE_IN } from './matrix.ts';

type Kind = 'clean' | 'conflict';
type Checkout = Scene & Readonly<{ wt: AbsPath }>;

let base: string;
before(() => {
  base = sharedBase();
});

/** The scene with the unit's worktree on unit-a. */
function checkout(kind: Kind): Checkout {
  const s = scene(base, kind);
  const wt = absPath(join(s.root, 'wt'));
  git(s.repo, 'worktree', 'add', '--quiet', wt, 'unit-a');
  return { ...s, wt };
}

const request = (c: Checkout) => ({ worktree: c.wt, branch: UNIT_BRANCH, integration: INTEGRATION, identity: IDENTITY, message: MERGEIN_MESSAGE });

async function mergein(c: Checkout): Promise<IntentOf<'mergein.prepare'>> {
  const journal = openArc(c.runDir);
  const intent = await runOp(journal, mergeinOp(c.repo), 'mergein:unit-a', request(c));
  journal.close();
  return intent;
}

/** The oracle per scenario: clean → HEAD = the recorded merge (the control SHA), index and files at it; conflict → markers + MERGE_HEAD = T. */
function assertMergedIn(c: Checkout, intent: IntentOf<'mergein.prepare'>, kind: Kind, control: Sha | null): void {
  assert.equal(intent.expect.old, c.unit);
  assert.equal(intent.expect.integrationTip, c.tip);
  if (kind === 'clean') {
    assert.equal(intent.post.type, 'clean-merged');
    if (intent.post.type !== 'clean-merged') return;
    assert.equal(intent.post.new, control, 'the same merge-in SHA');
    assert.equal(revOf(c.wt, 'HEAD'), control);
    assert.deepEqual(parentsOf(c.repo, intent.post.new), [c.unit, c.tip]);
    assert.equal(git(c.wt, 'status', '--porcelain=v2', '--untracked-files=all'), '', 'index and files at the merge');
    assert.equal(readFileSync(join(c.wt, 'docs/readme.md'), 'utf8'), '# readme, integrated\n');
    assert.equal(mergeHead(c.wt), null);
    assert.equal(git(c.repo, 'rev-list', '--count', `${c.unit}..unit-a`), '2', 'the merge and T\'s one commit: no duplicate');
  } else {
    assert.equal(intent.post.type, 'conflicted');
    assert.deepEqual(intent.expect.merge, { type: 'conflicted', conflicts: ['src/a.ts'] });
    assert.equal(revOf(c.wt, 'HEAD'), c.unit, 'HEAD = old');
    assert.equal(mergeHead(c.wt), c.tip, 'MERGE_HEAD = T');
    assert.match(readFileSync(join(c.wt, 'src/a.ts'), 'utf8'), /^<<<<<<< [^\n]*\nexport const a = 100;\n=======\nexport const a = -1;\n>>>>>>> /);
    assert.deepEqual(classifyMergein(intent), { kind: 'conflicted' });
  }
}

describe('mergein.prepare', () => {
  it('merge.conflict-mergein: candidate conflicts; merge-in leaves MERGE_HEAD; resolve + commit is completed; a fresh candidate merges clean', async () => {
    const c = checkout('conflict');
    const conflict = planCandidate(c.repo, candidateRequest(absPath(join(c.root, 'candidate')), c.unit));
    assert.deepEqual(conflict, { kind: 'conflict', tip: c.tip, conflicts: ['src/a.ts'] });
    assert.equal(git(c.repo, 'for-each-ref', 'refs/roadmap-run'), '', 'a conflict writes no candidate');

    const intent = await mergein(c);
    assertMergedIn(c, intent, 'conflict', null);
    assert.throws(() => mergeinCompleted(intent), /not completed: conflicted/);

    // What the resumed implementer does: resolve and commit.
    writeFiles(c.wt, { 'src/a.ts': 'export const a = 99;\n' });
    git(c.wt, 'add', 'src/a.ts');
    git(c.wt, 'commit', '--quiet', '--no-edit');
    const completed = mergeinCompleted(intent);
    const head = revOf(c.wt, 'HEAD');
    assert.deepEqual(completed, { kind: 'completed', head });
    assert.deepEqual(parentsOf(c.repo, head), [c.unit, c.tip], 'parents [old, T]');

    // The diff base is recomputed after the merge-in: it is T now, and the unit diff is the resolution.
    assert.equal(diffBase(c.repo, c.tip, head), c.tip);
    assert.deepEqual(unitDiffPaths(c.repo, c.tip, head), ['src/a.ts']);

    const fresh = planCandidate(c.repo, candidateRequest(absPath(join(c.root, 'candidate')), head));
    assert.equal(fresh.kind, 'merge');
    if (fresh.kind !== 'merge') return;
    const journal = openArc(c.runDir);
    const cand = await runOp(journal, candidateMergeOp(c.repo), 'candidate:unit-a', fresh.plan);
    journal.close();
    assert.equal(candidatePostcondition(c.repo, cand), null);
    assert.deepEqual(parentsOf(c.repo, cand.post.new), [c.tip, head]);
  });

  it('a clean merge-in commits [old, T] with recorded inputs and moves the worktree to it', async () => {
    const a = checkout('clean');
    const b = checkout('clean');
    const ia = await mergein(a);
    const ib = await mergein(b);
    if (ia.post.type !== 'clean-merged') throw new Error('expected a clean merge-in');
    assertMergedIn(a, ia, 'clean', ia.post.new);
    assertMergedIn(b, ib, 'clean', ia.post.new);
  });

  it('refuses a dirty worktree before any intent', async () => {
    const c = checkout('clean');
    writeFiles(c.wt, { 'src/a.ts': 'uncommitted\n' });
    const journal = openArc(c.runDir);
    await assert.rejects(runOp(journal, mergeinOp(c.repo), 'mergein:unit-a', request(c)), /status not clean/);
    assert.equal(journal.view.highWater(), 0);
    journal.close();
  });
});

describe(`matrix row ${MERGEIN}`, () => {
  const EXPECTED: Readonly<Record<string, Readonly<Partial<Record<Kind, 'redone' | 'reconciled'>>>>> = {
    'mergein.act-start': { clean: 'redone', conflict: 'redone' },
    'mergein.after-commit-tree': { clean: 'redone' },
    'mergein.after-cas': { clean: 'reconciled' },
    'mergein.after-merge': { conflict: 'reconciled' },
    'mergein.act-end': { clean: 'reconciled', conflict: 'reconciled' },
  };
  let control: Sha;
  before(async () => {
    const intent = await mergein(checkout('clean'));
    if (intent.post.type !== 'clean-merged') throw new Error('expected a clean merge-in');
    control = intent.post.new;
  });

  it('covers exactly the row\'s crash labels', () => {
    assert.deepEqual(crashCells(MERGEIN).map((c) => c.label).sort(), Object.keys(EXPECTED).sort());
  });

  it('parks when HEAD moved to something that is neither old, the merge, nor a merge of [old, T]', async () => {
    const c = checkout('conflict');
    const scenario = { op: 'mergein', runDir: c.runDir, repo: c.repo, worktree: c.wt } as const;
    assert.equal(await crashChild8b(scenario, 'mergein.act-start', 1), true);
    writeFiles(c.wt, { 'src/b.ts': 'someone else\n' });
    git(c.wt, 'commit', '--quiet', '-am', 'foreign commit');
    const journal = openArc(c.runDir);
    const recovery = await recover8b(journal, mergeinOp(c.repo));
    assert.equal(recovery.kind, 'parked');
    assert.equal(journal.view.openIntents().length, 1, 'a parked intent stays open');
    journal.close();
  });

  it('an open conflicted merge-in the implementer already resolved and committed recovers as completed', async () => {
    const c = checkout('conflict');
    const scenario = { op: 'mergein', runDir: c.runDir, repo: c.repo, worktree: c.wt } as const;
    assert.equal(await crashChild8b(scenario, 'mergein.act-end', 1), true);
    writeFiles(c.wt, { 'src/a.ts': 'export const a = 99;\n' });
    git(c.wt, 'add', 'src/a.ts');
    git(c.wt, 'commit', '--quiet', '--no-edit');
    const journal = openArc(c.runDir);
    const recovery = await recover8b(journal, mergeinOp(c.repo));
    assert.equal(recovery.kind, 'closed');
    const done = journal.view.doneOf(recovery.intent.op);
    assert.deepEqual(done?.outcome, { kind: 'completed', head: revOf(c.wt, 'HEAD') });
    journal.close();
  });

  for (const cell of crashCells(MERGEIN)) {
    for (const [kind, expected] of Object.entries(EXPECTED[cell.label] ?? {}) as [Kind, 'redone' | 'reconciled'][]) {
      it(`${cell.boundary} ${cell.label} (${kind}): ${cell.recovery}`, async () => {
        const c = checkout(kind);
        const scenario = { op: 'mergein', runDir: c.runDir, repo: c.repo, worktree: c.wt } as const;
        assert.equal(await crashChild8b(scenario, cell.label, 1), true, 'the scenario reaches the label');

        const journal = openArc(c.runDir);
        const recovery = await recover8b(journal, mergeinOp(c.repo));
        assert.equal(recovery.kind, 'closed', recovery.kind !== 'closed' ? recovery.detail : '');
        if (recovery.kind !== 'closed') return;
        assert.equal(recovery.recoveredBy, expected);
        assert.deepEqual(journal.view.doneOf(recovery.intent.op)?.outcome, { kind: kind === 'clean' ? 'clean-merged' : 'conflicted' });
        assert.equal(journal.view.openIntents().length, 0);
        journal.close();
        assertMergedIn(c, recovery.intent as IntentOf<'mergein.prepare'>, kind, control);
      });

      it(`${cell.label} (${kind}): the scenario reaches it exactly once`, async () => {
        const c = checkout(kind);
        const scenario = { op: 'mergein', runDir: c.runDir, repo: c.repo, worktree: c.wt } as const;
        assert.equal(await crashChild8b(scenario, cell.label, 2), false);
        if (kind === 'clean') assert.equal(revOf(c.wt, 'HEAD'), control);
        else assert.equal(mergeHead(c.wt), c.tip);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------
// `roadmap merge-in <u>` (src/commands/mergein.ts): the command over a unit-common arc whose unit u1 built,
// passed its lanes and parked at the gate (two escalations), while `main` moved on.

const TC = { timeout: SCENARIO_TIMEOUT_MS };
/** What u1 does before it parks: builds mul, lanes green, the gate escalates twice. */
const TO_PARK: readonly Step[] = [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' })];
/** A commit on `main` u1 did not touch, and one conflicting with u1's `src/mul.js` (add/add, same lines). */
const CLEAN_ADVANCE = { 'docs/notes.md': 'main moved on\n' } as const;
const CONFLICT_ADVANCE = { 'src/mul.js': 'export function mul(a, b) {\n  return b * a;\n}\n' } as const;

type Parked = Readonly<{ r: ArcRun; old: Sha; tip: Sha; item: NeedsUserId; branch: string }>;

/** u1 driven to its gate park (its needs-user raised as the executor does), then `main` advanced by `advance`. */
async function parkedArc(advance: Readonly<Record<string, string>>, after: readonly Step[] = []): Promise<Parked> {
  const d = setupArc({ steps: [...TO_PARK, ...after] });
  const r = contextFor(d);
  const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
  assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'escalation', JSON.stringify(parked));
  const f = r.journal.view.unit(U1).decided;
  assert.ok(f !== null);
  const item = raiseNeedsUser(r.journal, r.ctx.runDir, parked.needsUser, { type: 'stage', unit: U1, stage: f.stage, attempt: f.attempt });
  const branch = unitBranch(r.ctx.plan().arc, U1);
  const old = revOf(d.repo, branch);
  assert.equal(git(d.repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  writeFiles(d.repo, advance);
  const tip = commitAll(d.repo, 'main moves on') as Sha;
  return { r, old, tip, item, branch };
}

const submitMergeIn = (r: ArcRun) => submitCommand(r.ctx.runDir, r.ctx.plan().arc, { type: 'merge-in', unit: U1 });

async function mergeInCommand(r: ArcRun) {
  const file = submitMergeIn(r);
  return { id: file.id, outcome: await applyCommand(commandContextFor(r), file) };
}

const prepares = (r: ArcRun, id: CommandId) =>
  r.journal.view.opsOf('mergein.prepare').filter((i) => i.parent.type === 'command' && i.parent.command === id);

/** The postconditions of an applied clean merge-in of u1 by `id`; returns the merged head. */
function assertCleanMergedIn(p: Parked, id: CommandId): Sha {
  const { r, old, tip, branch } = p;
  const view = r.journal.view;
  const ops = prepares(r, id);
  assert.equal(ops.length, 1, 'one mergein.prepare parented by the command');
  assert.equal(view.opsOf('mergein.prepare').length, 1);
  assert.deepEqual(view.doneOf(ops[0]!.op)?.outcome, { kind: 'clean-merged' });
  const head = revOf(r.d.repo, branch);
  assert.deepEqual(parentsOf(r.ctx.repo, head), [old, tip], 'the unit branch head is the merge [old, T]');
  assert.equal(git(r.d.repo, 'rev-list', '--merges', '--count', `${old}..${branch}`), '1', 'exactly one merge commit');
  const wt = unitWorktreePath(r);
  assert.equal(revOf(wt, 'HEAD'), head);
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.deepEqual(view.holistic().mergedIn.map(({ unit, command, integrationTip, head: h }) => ({ unit, command, integrationTip, head: h })), [
    { unit: U1, command: id, integrationTip: tip, head },
  ]);
  assert.equal(view.ackOf(p.item)?.command, id, 'the park\'s needs-user is acknowledged by the command');
  const u = view.unit(U1);
  assert.equal(u.status, 'active');
  assert.equal(u.entry?.kind, 'merge-in');
  assert.equal(u.approval, null);
  const receipt = readReceipt(r.ctx.runDir, id, 'applied');
  assert.ok(receipt?.state === 'applied', JSON.stringify(receipt));
  return head;
}

describe('merge-in command', () => {
  it('mergein.clean: a parked unit takes the integration tip: one mergein.prepare done clean-merged, [old, T], merged-in, the park acked, the unit active at a merge-in entry', TC, async () => {
    const p = await parkedArc(CLEAN_ADVANCE);
    try {
      const { id, outcome } = await mergeInCommand(p.r);
      assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
      assertCleanMergedIn(p, id);
      assert.equal(readFileSync(join(unitWorktreePath(p.r), 'docs/notes.md'), 'utf8'), CLEAN_ADVANCE['docs/notes.md']);
    } finally {
      p.r.journal.close();
    }
  });

  it('mergein.conflict-no-act: a conflicting integration tip is rejected naming the path; nothing begun, merged or moved; the unit stays parked', TC, async () => {
    const p = await parkedArc(CONFLICT_ADVANCE);
    try {
      const wt = unitWorktreePath(p.r);
      const { id, outcome } = await mergeInCommand(p.r);
      assert.equal(outcome.kind, 'rejected');
      if (outcome.kind !== 'rejected') return;
      assert.match(outcome.reason, /conflicts in src\/mul\.js/);
      const view = p.r.journal.view;
      assert.deepEqual(view.opsOf('mergein.prepare'), []);
      assert.deepEqual(prepares(p.r, id), []);
      assert.deepEqual(view.holistic().mergedIn, []);
      assert.equal(revOf(p.r.d.repo, p.branch), p.old);
      assert.equal(revOf(wt, 'HEAD'), p.old);
      assert.equal(git(wt, 'status', '--porcelain'), '');
      assert.equal(mergeHead(wt), null);
      const u = view.unit(U1);
      assert.equal(u.status, 'park-pending');
      assert.equal(u.entry, null);
      assert.equal(view.ackOf(p.item), null);
    } finally {
      p.r.journal.close();
    }
  });

  it('mergein.reenters-lanes: after a clean merge-in the unit runs its lanes at the merged head, a gate over the diff from T, then candidate, ff and snapshot; a second merge-in and one of an undispatched unit are rejected', TC, async () => {
    const p = await parkedArc(CLEAN_ADVANCE, [gateStep({ decision: 'approve' })]);
    const { r, tip } = p;
    try {
      const { id, outcome } = await mergeInCommand(r);
      assert.equal(outcome.kind, 'applied');
      const head = assertCleanMergedIn(p, id);

      const again = await mergeInCommand(r);
      assert.equal(again.outcome.kind, 'rejected');
      if (again.outcome.kind === 'rejected') assert.match(again.outcome.reason, /already contains the integration tip .*nothing to merge/);

      const seen = outcomes(r.d).length;
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      assert.deepEqual(outcomes(r.d).slice(seen), ['lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published']);
      const series = latestSpecSeries(r.ctx, U1);
      assert.ok(series !== null && series.stage === 'lanes');
      const laneRuns = r.journal.view.opsOf('proc.spawn').flatMap((i) => {
        const s = i.expect.subject;
        return s.purpose === 'lane' && i.parent.type === 'stage' && i.parent.stage === 'lanes' && i.parent.attempt === series.attempt ? [s.at] : [];
      });
      assert.ok(laneRuns.length > 0);
      assert.deepEqual([...new Set(laneRuns)], [head], 'the lanes ran at the merged head');
      const gates = events(r.d.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.stage === 'gate' ? [e.fact] : []));
      assert.deepEqual(gates.map((g) => g.outcome), ['escalate', 'escalate', 'approve']);
      const inputs = r.journal.view.judgmentInputs(U1, 'gate', gates[2]!.attempt);
      assert.ok(inputs !== null, 'the gate after the merge-in recorded its inputs');
      assert.equal(inputs.head, head, 'the gate judged the merged head');
      assert.equal(inputs.tip, tip);
      assert.equal(diffBase(r.ctx.repo, tip, head), tip, 'after the merge-in the diff base is the tip');
      const gateCall = readCalls(r.d.scenarioPath).filter(isGateCall).at(-1);
      assert.ok(gateCall !== undefined);
      assert.ok(gateCall.stdin.includes(`base="${tip}" head="${head}"`) || gateCall.stdin.includes(`${tip}..${head}`), 'the gate prompt diffs from the integration tip');
      git(r.d.repo, 'merge-base', '--is-ancestor', head, 'main');
    } finally {
      r.journal.close();
    }

    const fresh = contextFor(setupArc({ steps: [] }));
    try {
      const { outcome } = await mergeInCommand(fresh);
      assert.equal(outcome.kind, 'rejected');
      if (outcome.kind === 'rejected') assert.match(outcome.reason, /no worktree on its branch yet/);
    } finally {
      fresh.journal.close();
    }
  });
});

/** How the command's mergein.prepare is closed, per crash label (each label is reached once in the child). */
const MERGEIN_RECOVERED_BY: Readonly<Record<string, 'redone' | 'reconciled' | null>> = {
  'command.apply.before-effect': null, 'mergein.act-start': 'redone', 'mergein.after-commit-tree': 'redone', 'mergein.after-cas': 'reconciled',
  'mergein.act-end': 'reconciled', 'command.apply.after-effect': null, 'command.apply.after-receipt': null,
};

describe(`matrix row ${MERGE_IN}`, () => {
  const cells = crashCells(MERGE_IN);

  it('lists the row\'s crash points', () => {
    assert.deepEqual(cells.map((c) => `${c.boundary} ${c.label}`), [
      'B2 command.apply.before-effect', 'B3 mergein.act-start', 'B3 mergein.after-commit-tree', 'B3 mergein.after-cas',
      'B4 mergein.act-end', 'B4 command.apply.after-effect', 'B4 command.apply.after-receipt',
    ]);
  });

  for (const cell of cells) {
    it(`mergein.crash-cells ${cell.boundary} ${cell.label}: ${cell.recovery}`, TC, async () => {
      const p = await parkedArc(CLEAN_ADVANCE);
      const cmd = submitMergeIn(p.r);
      p.r.journal.close();

      const trigger = writeTrigger(tmpDir('mergein-crash'), { label: cell.label, occurrence: 1 });
      const exit = await runFixture('mergein-child.ts', [JSON.stringify(p.r.d), cmd.id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 60_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}: code ${exit.code}, stderr ${exit.stderr}`);
      assertFired(trigger);

      const r = contextFor(p.r.d);
      try {
        assert.ok(r.journal.view.openIntents().some((i) => i.kind === 'command.apply'), 'the command\'s op is open');
        const report = await recover({ stage: r.ctx, commands: commandContextFor(r) });
        assert.deepEqual(report.parked, []);
        assert.deepEqual(r.journal.view.openIntents(), []);
        assertCleanMergedIn({ ...p, r }, commandId(cmd.id));
        const apply = r.journal.view.opsOf('command.apply').filter((i) => i.expect.command === cmd.id);
        assert.equal(apply.length, 1);
        assert.equal(r.journal.view.doneOf(apply[0]!.op)?.outcome.kind, 'applied');
        assert.equal(r.journal.view.doneOf(apply[0]!.op)?.recoveredBy, 'reconciled', 'the command\'s op is closed by its reconciler');
        const merges = prepares(r, commandId(cmd.id));
        assert.equal(merges.length, 1, 'one mergein.prepare');
        const prepared = r.journal.view.doneOf(merges[0]!.op);
        assert.ok(prepared !== null && prepared.kind === 'mergein.prepare' && prepared.outcome.kind === 'clean-merged');
        assert.equal(prepared.recoveredBy, MERGEIN_RECOVERED_BY[cell.label], 'the merge is redone (HEAD = old), finished (HEAD = the merge), or was done live');
      } finally {
        r.journal.close();
      }
      // Re-opening the log folds every record the recovery wrote.
      const again = contextFor(p.r.d);
      assert.deepEqual(again.journal.view.openIntents(), []);
      assert.equal(again.journal.view.unit(U1).entry?.kind, 'merge-in');
      again.journal.close();
    });
  }
});
