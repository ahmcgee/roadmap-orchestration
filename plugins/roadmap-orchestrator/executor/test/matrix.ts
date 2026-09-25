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

export const JOURNAL_APPEND = 'journal.append';
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
  { row: 'evidence.snapshot, worktree.create/remove', test: 'pending', cells: pending('8a') },
  { row: 'salvage.commit', test: 'pending', cells: pending('8a') },
  { row: 'mergein.prepare', test: 'pending', cells: pending('8b') },
  { row: 'candidate.merge, integration.ff, snapshot.publish', test: 'pending', cells: pending('8b') },
  { row: 'resource.transition + residue', test: 'pending', cells: pending('10') },
  { row: 'spec.patch', test: 'pending', cells: pending('9') },
  { row: 'needsuser.raise, command.apply', test: 'pending', cells: pending('13') },
  { row: 'supervisor/host', test: 'pending', cells: pending('7, 14a') },
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
