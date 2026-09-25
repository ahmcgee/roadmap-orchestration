// The operation/state × boundary crash matrix (plan "Tests", R23). One row per operation or state, one
// cell per boundary. A cell is crashed at each `crashPoint` label it lists, across every occurrence the
// row's scenario produces, and its recovery is checked against the row's oracle. Each step that lands an
// operation turns its `pending` cells into `crash` cells and drives them from its own test file, reading
// the cells from here so the table and the tests cannot drift apart.

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
  /** Not a distinct crash state for this row; `why` says which cell covers it or why none exists. */
  | Readonly<{ status: 'excluded'; why: string }>
  /** Filled by the step that implements the row. */
  | Readonly<{ status: 'pending'; step: string }>;

export type Row = Readonly<{ row: string; test: string; cells: Readonly<Record<Boundary, Cell>> }>;

const pending = (step: string): Readonly<Record<Boundary, Cell>> => ({
  B1: { status: 'excluded', why: EXCLUDED_B1 },
  B2: { status: 'pending', step },
  B3: { status: 'pending', step },
  B4: { status: 'pending', step },
  B5: { status: 'pending', step },
});

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
export const HOST_TAKEOVER = 'host takeover';

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
    // launcher fixture stands in for the executor). The reconcilers that recover them are step 3c's.
    row: PROC_SPAWN,
    test: 'test/runner.test.ts',
    cells: {
      ...pending('3c'),
      B3: {
        status: 'crash',
        labels: [...RUNNER_LABELS, 'launch.after-launch-json', 'launch.after-spawn'],
        recovery: 'runner alive: adopt; exit.json without result.json: re-run the adapter; runner dead with live members: orphan-kill{recovery} and classify lost',
      },
    },
  },
  {
    row: RUNNER_DEATH,
    test: 'test/runner.test.ts',
    cells: {
      ...pending('3c'),
      B3: {
        status: 'crash',
        labels: RUNNER_LABELS,
        recovery: 'orphan path: kill any live members{recovery}, classify lost (or re-run the adapter when exit.json exists); retry is a new inv',
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
      B5: { status: 'pending', step: '10' },
    },
  },
  { row: 'resource.transition reserve/run/clean/release', test: 'pending', cells: pending('10') },
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
  { row: 'needsuser.raise, command.apply', test: 'pending', cells: pending('13') },
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
  { row: 'supervisor/host', test: 'pending', cells: pending('14a') },
  { row: 'adversarial', test: 'pending', cells: pending('14c') },
];

/** Justified exclusions, listed beside the table (plan "Tests"). */
export function exclusions(): readonly Readonly<{ row: string; boundary: Boundary; why: string }>[] {
  return MATRIX.flatMap((r) =>
    (Object.keys(BOUNDARIES) as Boundary[]).flatMap((b) => {
      const cell = r.cells[b];
      return cell.status === 'excluded' ? [{ row: r.row, boundary: b, why: cell.why }] : [];
    }));
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
