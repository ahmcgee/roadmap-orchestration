// The operation/state × boundary crash matrix (plan "Tests", R23), and the single index of the crash and
// deterministic-fixture evidence. One row per operation, state or scenario, one cell per boundary. A cell
// is crashed at each `crashPoint` label it lists, across every occurrence the row's scenario produces, and
// its recovery is checked against the row's oracle. Each test file reads its row's cells from here, so the
// table and the tests cannot drift apart; test/matrix.test.ts checks the table itself (no pending cell,
// every label a real crash point, every named test file and fixture test present).

export const BOUNDARIES = {
  B1: 'torn or short intent',
  B2: 'intent durable, before act',
  B3: 'inside act',
  B4: 'act complete, before done',
  B5: 'done, before next stage',
} as const;
export type Boundary = keyof typeof BOUNDARIES;

export type Cell =
  /** Crashed at every listed label, per occurrence; `recovery` is the allowed recovery trace. */
  | Readonly<{ status: 'crash'; labels: readonly string[]; recovery: string }>
  /**
   * SIGKILLed from outside while blocked (`when`), a state no crash point reaches because the process only
   * waits there; `recovery` is the allowed recovery trace.
   */
  | Readonly<{ status: 'kill'; when: string; recovery: string }>
  /** Not a distinct crash state for this row; `why` says which cell covers it or why none exists. */
  | Readonly<{ status: 'excluded'; why: string }>
  /**
   * A deterministic fixture (plan R25): the named test (by the name before its colon, in the row's test file)
   * is the uncrashed hard evidence of this path; `crashedIn` is the row whose cells crash it.
   */
  | Readonly<{ status: 'fixture'; test: string; crashedIn: string }>
  /** Filled by the step that implements the row. */
  | Readonly<{ status: 'pending'; step: string }>;

export type Row = Readonly<{ row: string; test: string; cells: Readonly<Record<Boundary, Cell>> }>;

/**
 * Every op's intent is one `Journal` append, so a torn or short intent is the same state for every kind:
 * the `journal.append` row crashes it once for all of them (the tail is discarded, the op never began).
 */
const EXCLUDED_B1 = 'the intent is one journal append; journal.append B1 covers a torn or short intent for every op kind';

/** A done git or evidence op leaves no open intent: nothing for its reconciler to do. */
const EXCLUDED_B5_OP = 'the done is durable and no intent is open, so recovery has nothing to reconcile for this op; what the next stage does after it is the whole-pipeline row (14c)';

export const JOURNAL_APPEND = 'journal.append';
export const WORKTREE_EVIDENCE = 'evidence.snapshot, worktree.create/remove';
export const SALVAGE = 'salvage.commit';
export const MERGEIN = 'mergein.prepare';
export const CANDIDATE_FF_SNAPSHOT = 'candidate.merge, integration.ff, snapshot.publish';
export const JOURNAL_TAIL = 'journal.tail-repair';
export const PROC_SPAWN = 'proc.spawn backend/lane/teardown/probe';
export const RUNNER_DEATH = 'runner death (executor alive)';
export const PROC_KILL = 'proc.kill';

/** The runner's crash points, in lifecycle order: shared by the proc.spawn and runner-death rows. */
const RUNNER_LABELS = [
  'runner.before-runner-json',
  'runner.after-runner-json',
  'runner.after-child-spawn',
  'runner.child-exited-before-exit-json',
  'runner.after-exit-json',
] as const;
export const SPEC_PATCH = 'spec.patch';
export const RESIDUE_ORDERING = 'resource.transition fail + residue';
export const RESERVE_CYCLE = 'resource.transition reserve/run/clean/release';
export const HOST_TAKEOVER = 'host takeover';
export const NEEDSUSER_RAISE = 'needsuser.raise';
export const COMMAND_APPLY = 'command.apply';
export const PLAN_APPLY = 'command.apply: apply (a plan revision)';
export const PLAN_START = 'start: a later start whose files change the plan (supervised)';
export const SUPERVISOR_HOST = 'supervisor/host';
export const RECOVERY_CRASH = 'crash during recovery';
export const ADVERSARIAL_LIVE_RUNNER = 'adversarial: crash during recovery with a live runner';
export const ADVERSARIAL_TAKEOVER = 'adversarial: cross-arc takeover with a live runner crashed mid-adoption';
export const PIPELINE_STRAIGHT = 'whole pipeline: one unit straight through (supervised roadmap start)';
export const PIPELINE_BUMPY = 'whole pipeline: two units through every bumpy branch (supervised roadmap start)';
export const PIPELINE_RUNNER_DEATH = 'whole pipeline: runner death mid-build';
export const PIPELINE_SUPERVISOR_DEATH = 'whole pipeline: supervisor death mid-run';
export const PIPELINE_HOST_DEATH = 'whole pipeline: supervisor and executor death mid-build';
export const ADVERSARIAL_MALFORMED = 'adversarial: malformed result mid-pipeline';
export const ADVERSARIAL_CANCEL = 'adversarial: cancellation mid-build, then resume';
export const ADVERSARIAL_STALE = 'adversarial: failed publication (stale tip)';
export const ADVERSARIAL_CLEANUP_FAILED = 'adversarial: cleanup-failed';
export const ADVERSARIAL_FOREIGN_MOVE = 'adversarial: foreign ref move';
export const ADVERSARIAL_ORPHAN = 'adversarial: orphan adoption';
export const FIXTURE_REDIRECT = 'fixture: redirect then approve';
export const FIXTURE_RED_LANE = 'fixture: red lane → fix round reading the evidence dir';
export const FIXTURE_CONFLICT = 'fixture: conflict → merge-in → resolve';
export const FIXTURE_RED_CANDIDATE = 'fixture: red candidate → fix → fresh gate → green';

/**
 * The executor's crash points a supervised one-unit run passes through, by boundary (the whole-pipeline
 * rows). The test enumerates them from a recording run (test/fixtures/pm-record.ts) and requires exactly
 * these. Not here: runner.* (occurrences count per process and every runner is its own process, so
 * occurrence 1 always lands in the first runner, the startup smoke's: the proc.spawn and runner-death rows
 * crash them) and sup.* (the supervisor's, crashed by the supervisor/host row on the same one-unit arc).
 */
const PIPELINE_LABELS: Readonly<Record<Boundary, readonly string[]>> = {
  B1: ['log.append.before-write', 'log.append.after-partial-write'],
  B2: [
    'log.append.after-fsync', 'spawn.after-intent', 'resource.after-intent', 'worktree.create.act-start', 'worktree.remove.act-start', 'evidence.act-start',
    'salvage.act-start', 'candidate.act-start', 'ff.act-start', 'snapshot.act-start', 'spec.patch.before-write', 'recover.before-op',
  ],
  B3: [
    'launch.after-launch-json', 'launch.after-spawn', 'worktree.add.inside', 'worktree.remove.inside', 'evidence.after-partial-copy', 'salvage.after-copy-out',
    'salvage.after-commit-tree', 'salvage.after-cas', 'salvage.after-read-tree', 'candidate.after-commit-tree', 'snapshot.after-commit-tree',
    'plan.apply.after-inputs',
  ],
  B4: [
    'spawn.after-runner-exit', 'spawn.after-result', 'spawn.after-usage', 'evidence.act-end', 'salvage.act-end', 'candidate.act-end', 'ff.act-end',
    'snapshot.act-end', 'spec.patch.after-write',
  ],
  B5: ['spawn.after-done', 'resource.after-done', 'unit.after-stage', 'recover.after-op'],
};
/** The bumpy run adds the merge-in's conflicted path. */
const MERGEIN_LABELS: Readonly<Partial<Record<Boundary, readonly string[]>>> = { B2: ['mergein.act-start'], B3: ['mergein.after-merge'], B4: ['mergein.act-end'] };

/** A whole-pipeline row's cells: every label at occurrence 1, and 2 where the label repeats. */
function pipelineCells(extra: Readonly<Partial<Record<Boundary, readonly string[]>>>, recovery: Readonly<Record<Boundary, string>>): Readonly<Record<Boundary, Cell>> {
  const cell = (b: Boundary): Cell => ({ status: 'crash', labels: [...PIPELINE_LABELS[b], ...(extra[b] ?? [])], recovery: recovery[b] });
  return { B1: cell('B1'), B2: cell('B2'), B3: cell('B3'), B4: cell('B4'), B5: cell('B5') };
}

const PIPELINE_RECOVERY: Readonly<Record<Boundary, string>> = {
  B1: 'the torn or unwritten record is absent after the restart (a torn line is discarded with one tail-discarded fact); a lost done leaves its op open for its reconciler, a lost intent never began; the arc ends as uncrashed',
  B2: 'the supervisor restarts the executor; the open op is redone (a spawn with no runner is closed lost and its stage runs again, the call made once); the arc ends as uncrashed: same stage outcomes, tree, one publication per unit, one usage fact per invocation',
  B3: 'the reconciler finishes or redoes the op from its postcondition (a live runner adopted, an exited one re-adapted); the same SHAs; no backend call twice; a start cut short between keeping the plan\'s bytes and its plan-applied fact records revision 1 on the respawn; the arc ends as uncrashed',
  B4: 'the postcondition holds: the op closes reconciled (a spawn with exit.json re-adapted, redone), its result consumed, never dispatched again; the arc ends as uncrashed',
  B5: 'nothing is open for recovery: a stage cut short after its last op runs again as a new attempt (a completed backend call is consumed, not re-run); the arc ends as uncrashed',
};

/** The four deterministic fixtures' cells: the uncrashed test, crashed by the bumpy whole-pipeline row. */
const fixtureCells = (test: string): Readonly<Record<Boundary, Cell>> => {
  const cell: Cell = { status: 'fixture', test, crashedIn: PIPELINE_BUMPY };
  return { B1: cell, B2: cell, B3: cell, B4: cell, B5: cell };
};

/** An adversarial scenario whose every boundary another row or named test already crashes. */
const coveredBy = (why: string): Readonly<Record<Boundary, Cell>> => {
  const cell: Cell = { status: 'excluded', why };
  return { B1: cell, B2: cell, B3: cell, B4: cell, B5: cell };
};

/**
 * The effect-before-done crash point of each op kind's recovery: the reconciler's effect (a redo's act, the
 * spawn's adapter and usage fact, a command's remainder and receipt, a failed teardown's residue) is durable
 * and its done is not. proc.kill has none distinct: its reconciler's effect is the kill's own act, and a
 * kill quiesced but not closed is the proc.kill row's B4 state.
 */
export const RECOVERY_EFFECT_LABELS = {
  'proc.spawn': 'spawn.after-usage',
  'worktree.create': 'worktree.add.inside',
  'worktree.remove': 'worktree.remove.inside',
  'evidence.snapshot': 'evidence.act-end',
  'salvage.commit': 'salvage.act-end',
  'mergein.prepare': 'mergein.act-end',
  'candidate.merge': 'candidate.act-end',
  'integration.ff': 'ff.act-end',
  'snapshot.publish': 'snapshot.act-end',
  'resource.transition': 'residue.after-host-append',
  'spec.patch': 'spec.patch.after-write',
  'needsuser.raise': 'needsuser.raise.after-publish',
  'command.apply': 'command.apply.after-receipt',
} as const;

export const MATRIX: readonly Row[] = [
  {
    // The scenario (test/fixtures/log-child.ts `append3`) appends intent, done, fact, and makes a visible
    // act after each append returns, so occurrences 1-3 of each label cover every record type.
    row: JOURNAL_APPEND,
    test: 'test/log.test.ts',
    cells: {
      B1: {
        status: 'crash',
        labels: ['log.append.before-write', 'log.append.after-partial-write'],
        recovery: 'the record is absent after reopen; a partial line is discarded with a tail-discarded fact; no act for it',
      },
      B2: {
        status: 'crash',
        labels: ['log.append.after-fsync'],
        recovery: 'the record is present and nothing is discarded; its act never happened (the caller acts after append returns)',
      },
      B3: { status: 'excluded', why: 'appending is the act: the journal has no act between write and fsync other than the B1 partial write' },
      B4: { status: 'excluded', why: 'append returns right after fsync; B2 is the same durable state' },
      B5: { status: 'excluded', why: 'the state.json refresh after append is a derived cache that nothing reads' },
    },
  },
  {
    // The scenario is an open of a log whose last line is torn.
    row: JOURNAL_TAIL,
    test: 'test/log.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'tail repair has no intent: it is driven by the file state at every open' },
      B2: { status: 'excluded', why: 'tail repair has no intent: it is driven by the file state at every open' },
      B3: {
        status: 'crash',
        labels: ['log.open.after-fragment-save'],
        recovery: 'the next open saves the same content-addressed fragment again, truncates, and records one fact',
      },
      B4: {
        status: 'crash',
        labels: ['log.open.after-truncate'],
        recovery: 'the next open finds the fragment without its fact and records the fact once',
      },
      B5: { status: 'excluded', why: 'the fact is an ordinary append, covered by journal.append' },
    },
  },
  {
    // B3 internal points: the runner's own (it SIGKILLs itself) and the executor's around starting it (the
    // launcher fixture stands in for the executor in test/runner.test.ts). B2, B4 and B5 crash the executor
    // (test/fixtures/invoke-child.ts) around `invoke` and recover with the proc reconcilers; the scenario is
    // one backend call through the fake.
    row: PROC_SPAWN,
    test: 'test/runner.test.ts (B3), test/recover-spawn.test.ts (B2, B4, B5)',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['spawn.after-intent'],
        recovery: 'no launch.json, no runner: lost{treeEffects: false} reconciled, usage-unavailable{no-result}; the caller retries once as ordinal 2 (new inv, same deadlineAt), which completes',
      },
      B3: {
        status: 'crash',
        labels: [...RUNNER_LABELS, 'launch.after-launch-json', 'launch.after-spawn'],
        recovery: 'runner alive: adopt; exit.json without result.json: re-run the adapter; runner dead with live members: orphan-kill{recovery} and classify lost',
      },
      B4: {
        status: 'crash',
        labels: ['spawn.after-runner-exit', 'spawn.after-result', 'spawn.after-usage'],
        recovery: 'exit.json without result.json: adapter re-run, redone; result.json present: reconciled; no second invocation, exactly one usage fact',
      },
      B5: {
        status: 'crash',
        labels: ['spawn.after-done'],
        recovery: 'nothing is open, recovery does nothing: one done, one usage fact, no second invocation',
      },
    },
  },
  {
    // B3 is driven twice: by the launcher in test/runner.test.ts (what the runner leaves behind), and through
    // `invoke` in test/recover-spawn.test.ts (the live executor settles it, then retries once).
    row: RUNNER_DEATH,
    test: 'test/runner.test.ts, test/recover-spawn.test.ts (B3)',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: { status: 'excluded', why: 'no runner exists before the act; the executor crash at that point is proc.spawn B2' },
      B3: {
        status: 'crash',
        labels: RUNNER_LABELS,
        recovery: 'orphan path: kill any live members{recovery}, classify lost (or re-run the adapter when exit.json exists); retry is a new inv',
      },
      B4: { status: 'excluded', why: 'act complete means the runner wrote exit.json and exited; its death after exit.json is runner.after-exit-json (B3)' },
      B5: { status: 'excluded', why: 'after done the runner has long exited; nothing of it is left to die' },
    },
  },
  {
    // The scenario (invoke-child `pause`): a hanging backend call, then proc.kill{pause} of it; the executor
    // crashes inside the kill. Recovery runs the kill reconciler, then the spawn's.
    row: PROC_KILL,
    test: 'test/invoke.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['kill.after-intent'],
        recovery: 'runner alive, no cancel.json: the kill is re-run (cancel, await, kill) and done redone; the spawn is redone from exit.json as a process-fault',
      },
      B3: {
        status: 'crash',
        labels: ['kill.after-cancel'],
        recovery: 'cancel.json written: the kill is done reconciled (runner already gone) or redone (still stopping); the spawn is redone as a process-fault',
      },
      B4: {
        status: 'crash',
        labels: ['kill.after-quiesced'],
        recovery: 'members empty: the kill is done reconciled; the spawn is closed as a process-fault, live (before the crash) or redone',
      },
      B5: {
        status: 'crash',
        labels: ['kill.after-done'],
        recovery: 'the kill is closed; the spawn is closed as a process-fault, live (before the crash) or redone',
      },
    },
  },
  {
    // Scenarios (test/fixtures/git-child.ts): create a unit worktree on a new branch; snapshot three
    // evidence files; remove the worktree after its snapshot. Hand-made partial worktree states (inside
    // `git worktree add`, which a crashPoint cannot reach) are the named test worktree.partial-add.
    row: WORKTREE_EVIDENCE,
    test: 'test/worktree.test.ts, test/evidence.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['worktree.create.act-start', 'worktree.remove.act-start', 'evidence.act-start'],
        recovery: 'nothing acted: postcondition unmet, state provably untouched → redo; done recoveredBy redone',
      },
      B3: {
        status: 'crash',
        labels: ['worktree.add.inside', 'worktree.remove.inside', 'evidence.after-partial-copy'],
        recovery: 'git worktree add/remove returned: postcondition holds → done recoveredBy reconciled; a partial copy has no manifest → redo fills the gaps, done recoveredBy redone',
      },
      B4: {
        status: 'crash',
        labels: ['evidence.act-end'],
        recovery: 'manifest complete and every hash matches → done recoveredBy reconciled (worktree create/remove: their act ends when git returns, the B3 state)',
      },
      B5: { status: 'excluded', why: EXCLUDED_B5_OP },
    },
  },
  {
    // Scenario: a unit worktree with approved unstaged, pre-staged and deleted paths, plus rejected
    // `.roadmap/`, out-of-scope, excluded and pre-staged out-of-scope content, and an ignored file.
    row: SALVAGE,
    test: 'test/salvage.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: { status: 'crash', labels: ['salvage.act-start'], recovery: 'branch = old → redo; the same salvage SHA; done recoveredBy redone' },
      B3: {
        status: 'crash',
        labels: ['salvage.after-copy-out', 'salvage.after-commit-tree', 'salvage.after-cas', 'salvage.after-read-tree'],
        recovery: 'before the CAS: branch = old → redo, the same SHA, done recoveredBy redone; after it: branch = new → finish the index reconcile, done recoveredBy reconciled',
      },
      B4: { status: 'crash', labels: ['salvage.act-end'], recovery: 'branch = new, postcondition holds → done recoveredBy reconciled' },
      B5: { status: 'excluded', why: EXCLUDED_B5_OP },
    },
  },
  {
    // Scenarios (test/fixtures/git8b-child.ts `mergein`): a clean merge-in (T changed docs, the unit src)
    // and a conflicting one (both changed src/a.ts). act-start and act-end are crashed in both.
    row: MERGEIN,
    test: 'test/mergein.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['mergein.act-start'],
        recovery: 'HEAD = old, no MERGE_HEAD → redo: a clean merge-in makes the same SHA from its recorded inputs, a conflicting one re-runs the merge; done recoveredBy redone',
      },
      B3: {
        status: 'crash',
        labels: ['mergein.after-commit-tree', 'mergein.after-cas', 'mergein.after-merge'],
        recovery: 'before the CAS: HEAD = old → redo, the same SHA, done redone; after it: HEAD = new → finish read-tree, done clean-merged reconciled; conflicted merge written (HEAD = old, MERGE_HEAD = T) → done conflicted reconciled, the pipeline resumes "resolve and commit"',
      },
      B4: { status: 'crash', labels: ['mergein.act-end'], recovery: 'postcondition holds → done reconciled (clean-merged or conflicted)' },
      B5: { status: 'excluded', why: EXCLUDED_B5_OP },
    },
  },
  {
    // Scenarios (test/fixtures/git8b-child.ts): `candidate` merges the unit onto a clean T; `ff` publishes
    // that done candidate; `snapshot` publishes a run dir holding evidence, a needs-user and a spec. Each
    // label names its op by prefix; each op's test file drives its own labels.
    row: CANDIDATE_FF_SNAPSHOT,
    test: 'test/candidate.test.ts, test/ff.test.ts, test/snapshot.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['candidate.act-start', 'ff.act-start', 'snapshot.act-start'],
        recovery: 'ref = old (or absent) → redo with the recorded inputs, the same SHA, done redone; ff: ref = T → redo the CAS only when the fingerprint re-check holds, else done unpublished at T',
      },
      B3: {
        status: 'crash',
        labels: ['candidate.after-commit-tree', 'snapshot.after-commit-tree'],
        recovery: 'object written, ref = old → redo makes the same SHA (no duplicate commit), done redone (integration.ff writes no object: its act is the CAS alone)',
      },
      B4: {
        status: 'crash',
        labels: ['candidate.act-end', 'ff.act-end', 'snapshot.act-end'],
        recovery: 'ref = new and the postcondition holds → done reconciled; ff: published once, new^1 = T, new^2 = the approved unit commit',
      },
      B5: { status: 'excluded', why: EXCLUDED_B5_OP },
    },
  },
  {
    // The scenario (test/fixtures/host-residue.ts `fail`) journals a fail transition of two resources,
    // appends one residue per resource to the host index, then writes the local done.
    row: RESIDUE_ORDERING,
    test: 'test/residue.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['residue.before-host-append'],
        recovery: 'occurrence 1 has no residue durable, occurrence 2 the first only; recovery appends each missing residue once, keyed per resource, then the done (reconciled); nothing released',
      },
      B3: { status: 'excluded', why: 'the only point inside the act, between the per-resource appends, is residue.before-host-append occurrence 2, crashed under B2' },
      B4: {
        status: 'crash',
        labels: ['residue.after-host-append'],
        recovery: 'every residue is durable exactly once; recovery appends nothing and writes the done (reconciled); nothing released',
      },
      B5: {
        status: 'excluded',
        why: 'crashed as the resource.transition reserve/run/clean/release row\'s B5 cell (resource.after-done) in its failed-cleanup scenario (test/resource-recover.test.ts): the fail done is written, and the failed resource stays cleanup-failed through recovery, never released',
      },
    },
  },
  {
    // Scenarios (test/fixtures/res-child.ts `cycle`): the build of u1 reserves [db, queue], probes both,
    // runs, invokes one lane as its workload, then cleans up from the teardown stage. `cycle` releases
    // both; `fail` (queue's teardown fails) records queue cleanup-failed with its residue, then releases
    // db. Recovery is the resources phase alone (recoverReservations), which settles the spawns it needs.
    row: RESERVE_CYCLE,
    test: 'test/resource-recover.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['resource.after-intent'],
        recovery: 'the open transition is closed as it stands (done reconciled; an open fail appends its residues first); the dead holder\'s reserved or running set is cleaned, every declared teardown rerun, then released; the failed resource ends cleanup-failed',
      },
      B3: {
        status: 'crash',
        labels: ['spawn.after-intent', 'launch.after-spawn', 'spawn.after-runner-exit'],
        recovery: 'inside the cycle a probe, the holder\'s lane or a teardown is open: 3c\'s spawn reconciler settles it (lost, adopted or redone); reserved or running → clean; cleaning → every teardown rerun as a new op → released, or the failed resource cleanup-failed',
      },
      B4: { status: 'excluded', why: 'a reserve, run, clean or release has no act beyond its record, so act complete is the B2 state; the fail edge\'s act (the residue append) is the resource.transition fail + residue row' },
      B5: {
        status: 'crash',
        labels: ['resource.after-done'],
        recovery: 'nothing is open; a held set of the dead holder is cleaned and torn down again, then released; after the fail done the failed resource stays cleanup-failed, never released',
      },
    },
  },
  {
    // The scenario (test/fixtures/spec-patch-child.ts) prepares, journals, acts, verifies and closes one
    // spec.patch; recovery runs the reconciler on the open intent and applies its disposition.
    row: SPEC_PATCH,
    test: 'test/spec.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['spec.patch.before-write'],
        recovery: 'the file hashes to old: redo (act, verify, done redone); the file then hashes to new',
      },
      B3: { status: 'excluded', why: 'the write is a durable temp-and-rename: inside act the file is old (B2) or new (B4), never between' },
      B4: {
        status: 'crash',
        labels: ['spec.patch.after-write'],
        recovery: 'the file hashes to new: done patched, reconciled, with no second write',
      },
      B5: { status: 'excluded', why: 'the done is one journal append (journal.append); the re-check after a redirect is the pipeline\'s stage (step 11)' },
    },
  },
  {
    // The scenario (test/fixtures/needsuser-child.ts) raises one blocking needs-user: the body stages the
    // bytes, the intent is appended, the act renames the staged file into place, the done closes it.
    row: NEEDSUSER_RAISE,
    test: 'test/needsuser.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['needsuser.raise.before-publish'],
        recovery: 'the final file is absent and the staged one hashes to the intent: redo (the rename), done redone; the item is then open and blocking',
      },
      B3: { status: 'excluded', why: 'the act is one rename of a durable staged file: inside act the file is staged (B2) or final (B4), never between' },
      B4: {
        status: 'crash',
        labels: ['needsuser.raise.after-publish'],
        recovery: 'the final file hashes to the intent: done raised, reconciled, no second write',
      },
      B5: { status: 'excluded', why: 'the done is one journal append (journal.append); nothing follows a raise inside the op' },
    },
  },
  {
    // The scenarios (test/fixtures/cmd-child.ts): an `ack` of a raised needs-user, and a `sweep` of one host
    // residue (reserve under the sweep holder, teardown, release, cleaned disposition). The command was
    // polled first, so its `accepted` receipt exists before the op begins.
    row: COMMAND_APPLY,
    test: 'test/commands.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['command.apply.before-effect'],
        recovery: 'accepted receipt only, op open: the reconciler applies the whole effect once and writes the applied receipt naming the op; done reconciled',
      },
      B3: {
        status: 'crash',
        labels: ['spawn.after-intent'],
        recovery: 'sweep only: its teardown spawn is open; the reconciler settles it (lost), re-drives the resource left cleaning under the sweep (teardown rerun as a new op), releases it, records the cleaned disposition, writes the receipt',
      },
      B4: {
        status: 'crash',
        labels: ['command.apply.after-effect', 'command.apply.after-receipt'],
        recovery: 'effect complete: every postcondition already holds, so nothing is applied twice (one ack file, one ack fact, one disposition, one teardown); the applied receipt is written if missing, or, present and naming the op, decides alone; done reconciled',
      },
      B5: { status: 'excluded', why: 'the done is one journal append (journal.append) and closes the op: nothing is open for recovery, and a re-delivered command is a no-op (cmd.idempotent)' },
    },
  },
  {
    // An `apply` adding a unit, applied by a child (test/fixtures/apply-child.ts); recovery finishes it.
    row: PLAN_APPLY,
    test: 'test/apply.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['command.apply.before-effect'],
        recovery: 'accepted receipt only, op open: the reconciler evaluates the files again and puts them in force once (one plan-applied fact, one applied receipt)',
      },
      B3: {
        status: 'crash',
        labels: ['plan.apply.after-inputs'],
        recovery: 'the bytes are kept, the fact is not written: the reconciler evaluates again to the same verdict, keeps the same bytes and writes the one fact, then the receipt',
      },
      B4: {
        status: 'crash',
        labels: ['command.apply.after-effect', 'command.apply.after-receipt'],
        recovery: 'the fact is written: the reconciler finds it (the postcondition) and writes the applied receipt if missing, or reads it; no second fact',
      },
      B5: { status: 'excluded', why: 'the done is one journal append (journal.append) and closes the op: nothing is open for recovery, and a re-delivered command is a no-op (cmd.idempotent)' },
    },
  },
  {
    // A finished one-unit arc, then a unit added and `roadmap start`: its first executor crashes before its
    // plan revision's fact, so no generation of the supervisor was ready yet.
    row: PLAN_START,
    test: 'test/apply-exec.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: { status: 'excluded', why: 'a start records its plan revision with no op: keeping the bytes (B3) and the plan-applied fact (journal.append) are its only steps' },
      B3: {
        status: 'crash',
        labels: ['plan.apply.after-inputs'],
        recovery: 'the bytes are kept, the fact is not written, and no generation was ready: the supervisor\'s next executor is a start, not a --respawn, so it classifies the files again and records the revision once; the added unit runs and the arc ends complete with both units merged',
      },
      B4: { status: 'excluded', why: 'the plan-applied fact is one journal append (journal.append); once it is written the plan in force is the new one, so a respawn runs it' },
      B5: { status: 'excluded', why: 'after the fact the start goes on to its smoke and readiness: the whole-pipeline rows crash what follows' },
    },
  },
  {
    // The scenario (test/fixtures/host-claim.ts) takes over a dead claim of the same arc.
    row: HOST_TAKEOVER,
    test: 'test/host.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'a takeover journals nothing: the host files are its state, and each is created by one link or rename' },
      B2: {
        status: 'crash',
        labels: ['host.takeover.after-recovery-claim'],
        recovery: 'the recovery lock is left with a dead holder: the next claim refuses recovery-holder-dead (exit 78, needs-user); host.lock still names the dead claim',
      },
      B3: { status: 'excluded', why: 'the takeover act is one rename of a durable temp claim over host.lock, atomic by construction' },
      B4: {
        status: 'crash',
        labels: ['host.takeover.after-rename'],
        recovery: 'host.lock names the crashed claim and the recovery lock a dead holder: the next claim refuses recovery-holder-dead (exit 78, needs-user); never two owners',
      },
      B5: { status: 'excluded', why: 'after the recovery lock is released the host is simply claimed; host.live-owner-refused and the dead-owner tests cover that state' },
    },
  },
  {
    // The scenario (test/supervisor.test.ts): `roadmap start` of a one-unit claude-only arc whose supervisor
    // dies at the label; then a second start. Oracle: at most one executor ever performs an effect, and the
    // second start takes over cleanly and completes the arc.
    row: SUPERVISOR_HOST,
    test: 'test/supervisor.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'the supervisor journals nothing: its state is host files, each created by one link, rename or write-once create' },
      B2: {
        status: 'crash',
        labels: ['sup.after-claim'],
        recovery: 'claimed with owner record{executor: null}, no executor spawned: the next start takes the dead claim over and runs the arc; one executor, one executor-started',
      },
      B3: {
        status: 'crash',
        labels: ['sup.after-spawn', 'sup.after-owner-publish'],
        recovery: 'the spawned executor waits for a handshake that never comes, sees its supervisor gone and exits 78 having written nothing; the next start (once it has exited, when the owner record names it) takes over and runs the arc; one executor-started',
      },
      B4: {
        status: 'crash',
        labels: ['sup.after-handshake'],
        recovery: 'the handshaken executor is the only owner: it runs the arc to its end unsupervised and exits; the next start takes the dead claim over (no second executor while it lived) and finds the arc complete',
      },
      B5: { status: 'excluded', why: 'after the handshake the supervisor only watches; its death then is the B4 state (the executor runs on), and after the executor exits it is a dead claim, the host takeover row' },
    },
  },
  {
    // One scenario per op kind that has a reconciler (test/fixtures/rec-common.ts `deadRun`): the real code
    // that writes the op (unit driver, paused backend call, needs-user raise, command) is crashed inside it, so
    // the dead executor's log holds an open intent of that kind; then the recovery engine is crashed at the
    // cell's label, at occurrences 1 and 2 (every pass has a resources phase, so both always exist), and a
    // clean recovery follows. Oracle: the fixed point of an uncrashed recovery of the same scenario.
    row: RECOVERY_CRASH,
    test: 'test/recover.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['recover.before-op'],
        recovery: 'the next recovery reaches the same fixed point as an uncrashed one: every open intent closed alike, the same ops begun by recovery, no effect twice (the SHAs the intents recorded, one result and one usage fact per invocation, one residue per resource, one needs-user per cause), recoveredBy as the uncrashed run or reconciled',
      },
      B3: { status: 'excluded', why: 'inside a redo the op runs its own act and crash points; the state it leaves is that op row\'s B3 state, which its reconciler already settles' },
      B4: {
        status: 'crash',
        labels: Object.values(RECOVERY_EFFECT_LABELS),
        recovery: 'the effect is durable and the done is not: the next recovery finds the postcondition and closes the op reconciled; the same fixed point, no effect twice',
      },
      B5: {
        status: 'crash',
        labels: ['recover.after-op'],
        recovery: 'the op is closed: the next recovery leaves it and settles the rest; the same fixed point, no effect twice',
      },
    },
  },
  {
    // The dead executor's build of u1 is parked at a fake-backend barrier, its runner alive; the recovery
    // engine that adopts it dies too (test/recover.test.ts).
    row: ADVERSARIAL_LIVE_RUNNER,
    test: 'test/recover.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['recover.before-op'],
        recovery: 'the runner lives on: the next recovery adopts it, once (done adopted, one result, one usage fact); the driver consumes the build',
      },
      B3: {
        status: 'kill',
        when: 'the recovering executor waits on the adopted runner',
        recovery: 'the runner lives on: the next recovery adopts it (adopted), or, when it exited in between, re-runs the adapter from its exit.json (redone); one result, one usage fact, the build never dispatched again',
      },
      B4: {
        status: 'crash',
        labels: ['spawn.after-result'],
        recovery: 'the adopted runner exited and its result is written, the done is not: the next recovery finds the runner gone and result.json valid (reconciled); one usage fact',
      },
      B5: {
        status: 'crash',
        labels: ['recover.after-op'],
        recovery: 'the adoption is closed (adopted): nothing is open for it; the driver consumes the build',
      },
    },
  },
  {
    // Arc A is stranded with a plan-check runner alive at a barrier; arc B's start takes the dead claim over
    // and adopts A's runner under host.recovery.lock (test/recover.test.ts).
    row: ADVERSARIAL_TAKEOVER,
    test: 'test/recover.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'the takeover appends to A\'s log only through the spawn reconciler: its torn line is the journal.append row' },
      B2: { status: 'excluded', why: 'before the adoption starts, a dead takeover is the host takeover row\'s B2 cell (host.takeover.after-recovery-claim)' },
      B3: {
        status: 'kill',
        when: 'B\'s supervisor waits on A\'s live runner under the recovery lock',
        recovery: 'B\'s next start refuses recovery-holder-dead (exit 78, one host needs-user however often it is refused); A\'s log and runner untouched; once the user clears the dead recovery lock, B adopts A\'s invocation once and runs its arc',
      },
      B4: {
        status: 'crash',
        labels: ['spawn.after-result'],
        recovery: 'A\'s result written, its done not, the recovery lock held by the dead supervisor: B refuses recovery-holder-dead; once cleared, nothing of A survives, so B takes over without writing to A\'s log, and A\'s own recovery closes the invocation reconciled',
      },
      B5: { status: 'excluded', why: 'after the adoption is closed the takeover renames the claim: the host takeover row\'s B4 cell' },
    },
  },
  {
    // The straight scenario (test/fixtures/pm-common.ts STRAIGHT): u1 with a declared resource, decisions.json,
    // work salvage commits, through `roadmap start`. Each cell SIGKILLs the executor at its label; the
    // supervisor restarts it; the oracle (test/oracle.ts) compares the end with the uncrashed run.
    row: PIPELINE_STRAIGHT,
    test: 'test/pipeline-matrix.test.ts',
    cells: pipelineCells({}, PIPELINE_RECOVERY),
  },
  {
    // The bumpy scenario (pm-common.ts BUMPY): u1 redirect, red lane + fix, gate revise; u2 integration moved
    // under it, conflict → merge-in → resolve, red candidate → fix → fresh gate. Two units, because three
    // chargeable failures in one unit park it.
    row: PIPELINE_BUMPY,
    test: 'test/pipeline-matrix.test.ts',
    cells: pipelineCells(MERGEIN_LABELS, PIPELINE_RECOVERY),
  },
  {
    row: PIPELINE_RUNNER_DEATH,
    test: 'test/pipeline-matrix.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: { status: 'excluded', why: 'no runner exists before the act; the executor crash there is the whole-pipeline rows\' spawn.after-intent cells' },
      B3: {
        status: 'kill',
        when: 'the build\'s runner, SIGKILLed while its backend call waits at a barrier after changing the tree (the executor alive)',
        recovery: 'the live executor finds its runner gone: the workload killed (proc.kill{recovery}), the build closed lost{treeEffects: true}, usage unavailable{no-result}; uncharged build:lost-tree-effects → quiesce, and what the workload left is salvaged and verified (lanes, gate) like a report (the plan\'s recovery table, lead ruling 14c); the build never called twice; the arc ends complete with u1 merged, the tree as uncrashed. Without tree effects a lost call is retried once as ordinal 2 (same deadlineAt), then build:lost parks (build-lost)',
      },
      B4: { status: 'excluded', why: 'act complete means the runner wrote exit.json and exited; its death after exit.json is the runner-death row\'s runner.after-exit-json' },
      B5: { status: 'excluded', why: 'after done the runner has long exited; nothing of it is left to die' },
    },
  },
  {
    row: PIPELINE_SUPERVISOR_DEATH,
    test: 'test/pipeline-matrix.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'the supervisor journals nothing; the supervisor/host row crashes its own points' },
      B2: { status: 'excluded', why: 'before its executor is handshaken a dead supervisor is the supervisor/host row\'s B2 and B3 cells (sup.after-claim, sup.after-spawn, sup.after-owner-publish)' },
      B3: {
        status: 'kill',
        when: 'the supervisor, SIGKILLed while its executor\'s build waits at a barrier',
        recovery: 'the executor runs on unsupervised: a start meanwhile is refused host-busy (exit 75, never two executors); it finishes the arc and exits complete; the next start takes the dead claim over and finds the arc complete; nothing recovered, the arc as uncrashed',
      },
      B4: { status: 'excluded', why: 'a supervisor dead after the handshake is this row\'s B3 state; the supervisor/host row\'s B4 cell crashes it at sup.after-handshake' },
      B5: { status: 'excluded', why: 'after its executor exits a dead supervisor is a dead claim: the host takeover row' },
    },
  },
  {
    row: PIPELINE_HOST_DEATH,
    test: 'test/pipeline-matrix.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: { status: 'excluded', why: 'a host death before the build\'s runner starts leaves no survivor: the whole-pipeline rows\' spawn.after-intent cells' },
      B3: {
        status: 'kill',
        when: 'the supervisor and then the executor, SIGKILLed while the build\'s backend call waits at a barrier (its runner lives on)',
        recovery: 'the next start takes the dead claim of the same arc over; its recovery adopts the live runner (or re-adapts its exit.json once it has exited): the build closed adopted or redone and consumed, called once; the arc ends as uncrashed',
      },
      B4: { status: 'excluded', why: 'with the runner exited before the takeover the build is re-adapted from exit.json: the whole-pipeline rows\' spawn.after-runner-exit cells' },
      B5: { status: 'excluded', why: 'after the build\'s done nothing survives the host: the whole-pipeline rows\' spawn.after-done cells' },
    },
  },
  {
    // pm-common.ts MALFORMED: the gate's first answer is not JSON; its uncharged retry approves. Each cell's
    // occurrence is the malformed gate's own (its index among the run's invocations, or among its stages).
    row: ADVERSARIAL_MALFORMED,
    test: 'test/pipeline-matrix.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['spawn.after-intent'],
        recovery: 'the malformed gate\'s spawn, intent durable and no runner: closed lost (reconciled); the gate runs again as a new attempt, gets the malformed answer, retries once uncharged and approves; the arc ends as uncrashed',
      },
      B3: { status: 'excluded', why: 'inside the malformed call are the runner\'s own points (the proc.spawn row); a malformed answer changes nothing there' },
      B4: {
        status: 'crash',
        labels: ['spawn.after-result'],
        recovery: 'the malformed result is written, the done is not: closed reconciled and consumed as gate:malformed (never asked again), then the one uncharged retry; the arc ends as uncrashed',
      },
      B5: {
        status: 'crash',
        labels: ['unit.after-stage'],
        recovery: 'gate:malformed is recorded: the restarted driver runs the retry it decided; nothing recovered; the arc ends as uncrashed',
      },
    },
  },
  {
    // pm-common.ts CANCEL: `pause u1` mid-build, the executor killed inside the proc.kill{pause}, then `resume u1`.
    row: ADVERSARIAL_CANCEL,
    test: 'test/pipeline-matrix.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['kill.after-intent'],
        recovery: 'no cancel.json yet: the kill re-run by its reconciler (redone), the build closed redone from its exit.json and consumed as build:interrupted (uncharged hold); the pause survives the restart; resume re-runs the build; the arc ends as uncrashed',
      },
      B3: {
        status: 'crash',
        labels: ['kill.after-cancel'],
        recovery: 'cancel.json written: the kill closed reconciled or redone, the build redone and consumed as build:interrupted; resume re-runs it; the arc ends as uncrashed',
      },
      B4: {
        status: 'crash',
        labels: ['kill.after-quiesced'],
        recovery: 'the workload is gone: the kill closed reconciled, the build reconciled or redone and consumed as build:interrupted; resume re-runs it; the arc ends as uncrashed',
      },
      B5: {
        status: 'crash',
        labels: ['kill.after-done'],
        recovery: 'the kill is closed: the build redone and consumed as build:interrupted; resume re-runs it; the arc ends as uncrashed',
      },
    },
  },
  {
    // B2: pm-common.ts STALE, integration moved while the crashed executor is down. B5: STALE_LANE, integration
    // moved by someone else while the candidate's suite runs, so the live ff finds the tip stale.
    row: ADVERSARIAL_STALE,
    test: 'test/pipeline-matrix.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['ff.act-start'],
        recovery: 'the ff intent open and integration advanced past its T (what a CAS lost to a mover leaves): closed unpublished at the new tip (reconciled); the driver records ff:cas-stale, a fresh candidate onto the new tip, no new gate, published once',
      },
      B3: { status: 'excluded', why: 'the act is one update-ref CAS: there is no point inside it' },
      B4: {
        status: 'excluded',
        why: 'a CAS that lost to a mover leaves the ff intent open with integration advanced past T, which is this row\'s B2 state once integration moved; a mover cannot be placed between the intent and the CAS from outside the process, and the unmoved ff.act-end is the whole-pipeline rows\' cell',
      },
      B5: {
        status: 'crash',
        labels: ['unit.after-stage'],
        recovery: 'ff:cas-stale is recorded: the restarted driver makes the fresh candidate onto the new tip, no new gate, published once; nothing recovered',
      },
    },
  },
  {
    row: ADVERSARIAL_CLEANUP_FAILED,
    test: 'test/residue.test.ts, test/resource-recover.test.ts',
    cells: coveredBy('crashed by the resource.transition fail + residue row (residue before and after the host append) and the reserve/run/clean/release row\'s failed-cleanup scenario: residues once per resource, never released'),
  },
  {
    row: ADVERSARIAL_FOREIGN_MOVE,
    test: 'test/integrate.test.ts, test/ff.test.ts, test/recover.test.ts',
    cells: coveredBy('ff.foreign-move (the live stop and its needs-user), git.foreign-mover (typed before the intent, recovery-required after it) and recover.no-duplicate-needs-user (integration rewritten under a pending ff, the candidate ref moved: recovery killed around the raise raises it once)'),
  },
  {
    row: ADVERSARIAL_ORPHAN,
    test: 'test/recover.test.ts, test/runner.test.ts, test/recover-spawn.test.ts',
    cells: coveredBy('crashed by the proc.spawn and runner-death rows (orphan kill, lost) and the two adversarial live-runner rows (adoption through a crash in recovery and through a cross-arc takeover); the whole-pipeline host-death row adopts through roadmap start'),
  },
  { row: FIXTURE_REDIRECT, test: 'test/stages.test.ts', cells: fixtureCells('stages.redirect-then-approve') },
  { row: FIXTURE_RED_LANE, test: 'test/stages.test.ts', cells: fixtureCells('stages.red-lane-fix-round') },
  { row: FIXTURE_CONFLICT, test: 'test/unit.test.ts', cells: fixtureCells('fixture conflict → merge-in → resolve') },
  { row: FIXTURE_RED_CANDIDATE, test: 'test/unit.test.ts', cells: fixtureCells('fixture red candidate → fix → fresh gate → green') },
];

/** Justified exclusions, listed beside the table (plan "Tests"). */
export function exclusions(): readonly Readonly<{ row: string; boundary: Boundary; why: string }>[] {
  return MATRIX.flatMap((r) =>
    (Object.keys(BOUNDARIES) as Boundary[]).flatMap((b) => {
      const cell = r.cells[b];
      return cell.status === 'excluded' ? [{ row: r.row, boundary: b, why: cell.why }] : [];
    }));
}

/** The kill cells of one row. */
export function killCells(row: string): readonly Readonly<{ boundary: Boundary; when: string; recovery: string }>[] {
  const r = MATRIX.find((m) => m.row === row);
  if (r === undefined) throw new Error(`matrix: no row ${row}`);
  return (Object.keys(BOUNDARIES) as Boundary[]).flatMap((b) => {
    const cell = r.cells[b];
    return cell.status === 'kill' ? [{ boundary: b, when: cell.when, recovery: cell.recovery }] : [];
  });
}

/** The crash cells of one row, as `(boundary, label)` pairs. */
export function crashCells(row: string): readonly Readonly<{ boundary: Boundary; label: string; recovery: string }>[] {
  const r = MATRIX.find((m) => m.row === row);
  if (r === undefined) throw new Error(`matrix: no row ${row}`);
  return (Object.keys(BOUNDARIES) as Boundary[]).flatMap((b) => {
    const cell = r.cells[b];
    return cell.status === 'crash' ? cell.labels.map((label) => ({ boundary: b, label, recovery: cell.recovery })) : [];
  });
}
