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
export const RETRY_RECLAIM = 'resource.transition retry reclaim (M2: reclaim → teardown → disposition → release)';
export const RESIDUE_COMPACT = 'residue-index compaction at start (M3: tmp → link archive → rename)';
export const GC = 'roadmap gc (M3: verify all → raw evidence → run dir rename → removal → host files)';
export const PROBE_JOB = 'probe job (M2: smoke spawn → probe fact)';
export const HOST_TAKEOVER = 'host takeover';
export const NEEDSUSER_RAISE = 'needsuser.raise';
export const COMMAND_APPLY = 'command.apply';
export const PLAN_APPLY = 'command.apply: apply (a plan revision)';
export const PLAN_START = 'start: a later start whose files change the plan (supervised)';
export const REVISION_COMMIT = 'revision.commit: a revision\'s activation (payload, docs ff, plan-applied; M3 G1)';
export const STEER = 'command.apply: steer (M3: class revision, brief, pre-steer snapshot, steered)';
export const MERGE_IN = 'command.apply: merge-in (M3: merge-tree plan, mergein.prepare, merged-in)';
export const DOCS_PUBLICATION = 'command.apply: rule, its docs publication (M3 A4: slot, docs.commit, lanes, docs ff, activation, snapshot)';
export const PREEMPT = 'docs publication preempting a candidate before green (M3 A4, A7: preempt kill of its suite lane)';
export const LATCH = 'obligation-latched after a unit ff{published}, before its snapshot (M3 B2)';
export const BATCH_PUBLICATION = 'repair batch publication (M3 B2, G5, H4: slot under batch{finding, attempt}, chained candidate, job lanes, batch ff, finish)';
export const MUTANT_APPLY = 'mutant.apply: a vacuity repair\'s reproduce (M3 B3: detached worktree, patch applied, mutant lane, worktree removed)';
export const AUDIT_JOB = 'cadence audit job (M3 B5: audit-started under the fence, job lanes, lens calls, audit-ended)';
export const CHECKPOINT_JOB = 'checkpoint job (M3 B6: checkpoint-inputs under the fence, the checkpoint call)';
export const BUNDLE_ACTIVATE = 'bundle activation (M3 B6: bundle-decided or plan-applied{source: bundle}, divergences, finding dispositions, digest)';
export const TERMINAL_SNAPSHOT = 'close-out publication and arc completion (M3 B7, A8, A20, G8: close-out ff, docs-published, arc-completed, terminal snapshot)';
export const SUPERVISOR_HOST = 'supervisor/host';
export const RECOVERY_CRASH = 'crash during recovery';
export const ADVERSARIAL_LIVE_RUNNER = 'adversarial: crash during recovery with a live runner';
export const ADVERSARIAL_TAKEOVER = 'adversarial: cross-arc takeover with a live runner crashed mid-adoption';
export const PIPELINE_STRAIGHT = 'whole pipeline: one unit straight through (supervised roadmap start)';
export const PIPELINE_BUMPY = 'whole pipeline: two units through every bumpy branch (supervised roadmap start)';
export const PIPELINE_HOLISTIC = 'whole pipeline: a holistic arc through baseline, a unit, audits, checkpoints, close-out and completion (supervised roadmap start)';
export const PIPELINE_RUNNER_DEATH = 'whole pipeline: runner death mid-build';
export const PIPELINE_SUPERVISOR_DEATH = 'whole pipeline: supervisor death mid-run';
export const PIPELINE_HOST_DEATH = 'whole pipeline: supervisor and executor death mid-build';
export const ADVERSARIAL_MALFORMED = 'adversarial: malformed result mid-pipeline';
export const ADVERSARIAL_CANCEL = 'adversarial: cancellation mid-build, then resume';
export const ADVERSARIAL_STALE = 'adversarial: failed publication (stale tip)';
export const ADVERSARIAL_CLEANUP_FAILED = 'adversarial: cleanup-failed';
export const ADVERSARIAL_FOREIGN_MOVE = 'adversarial: foreign ref move';
export const ADVERSARIAL_ORPHAN = 'adversarial: orphan adoption';
export const CONCURRENT_BUILD = 'concurrent: A through the pipeline, peer B in a live build runner';
export const CONCURRENT_JUDGMENT = 'concurrent: A through the pipeline, peer B in a live judgment runner';
export const CONCURRENT_LANE = 'concurrent: A through the pipeline, peer B in a lane holding estate#1';
export const CONCURRENT_TEARDOWN = 'concurrent: A through the pipeline, peer B in a teardown';
export const CONCURRENT_PUBLICATION = 'concurrent: A through the pipeline, peer B waiting for the publication slot (in memory)';
export const CONCURRENT_RESIDUE = 'concurrent: A through the pipeline, peer B in a retryable residue park';
export const CONCURRENT_AUDIT = 'concurrent job: an audit job stepping (audit-1: its checkout, lens call, evidence, facts), units u1 and u2 in live build runners';
export const CONCURRENT_BUNDLE = 'concurrent job: a checkpoint job activating a bundle (ckpt-1: its call, its revision, divergence), units u1 and u2 in live build runners';
export const CONCURRENT_BATCH = 'concurrent job: a repair batch publishing (batch-1: its slot, chained candidate, lanes, batch ff, snapshot), unit u3 in a live build runner';
export const CONCURRENT_PREEMPT = 'concurrent job: a rule\'s docs publication preempting u1\'s candidate before green (the preempt kill, docs commit, lanes, docs ff, revision, snapshot)';
export const CONCURRENT_DEBT = 'concurrent job: a corpus arc\'s gate approval banking its note (u1\'s, u2\'s) while the audit and checkpoint jobs step';
export const INPUT_CAPTURE_FENCE = 'input capture under the fence (M3 H2: judgment-inputs, audit-started, checkpoint-inputs never inside an open revision.commit)';
export const NOOP_DIVERGENCE = 'no-op divergences (M3 H12: bundle-decided{no-op}, then its interpretation divergences keyed (job, i))';
export const REVERSE = 'reverse <D-n> (M3 H13: a compensating revision, committed as revision.commit)';
export const FF_ELIGIBILITY = 'ff eligibility (M3 B2/B3: a unit ff redone only while its fingerprint and finding eligibility hold)';
export const JOB_RESIDUE = 'job-owned residue (M3 G4, H4: a job lane\'s failed cleanup, reclaimed under the job)';
export const DEBT_BANK = 'debt bank (M4a DEBT_BANK: a corpus arc\'s approval, then its gate notes banked as debt-banked facts)';
export const PACK_REVIEW_JOB = 'pack review job (M4a PACK_REVIEW_JOB: PackReviewInputs kept, pack-review-started, the call, pack-review-ended, the blocking item)';
export const ISSUE_CAPTURE = 'checkpoint issue capture (M4a ISSUE_CAPTURE: identity, policy, fetch, the capture kept, issues-captured, checkpoint-inputs)';
export const CORPUS_AMENDMENT = 'corpus amendments and issue intake (M4a CORPUS_AMENDMENT / ISSUE_INTAKE: after the decision, corpus-amendment and issue-intake facts keyed by source)';
export const BRIEF_ACK = 'brief ack (M4a CLI brief --ack: the pending marker, the ack commands under deterministic ids, the committed marker)';
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
    'revision.commit.after-intent',
  ],
  B3: [
    'launch.after-launch-json', 'launch.after-spawn', 'worktree.add.inside', 'worktree.remove.inside', 'evidence.after-partial-copy', 'salvage.after-copy-out',
    'salvage.after-commit-tree', 'salvage.after-cas', 'salvage.after-read-tree', 'candidate.after-commit-tree', 'snapshot.after-commit-tree',
    'plan.apply.after-inputs',
  ],
  B4: [
    'spawn.after-runner-exit', 'spawn.after-result', 'spawn.after-usage', 'evidence.act-end', 'salvage.act-end', 'candidate.act-end', 'ff.act-end',
    'snapshot.act-end', 'spec.patch.after-write', 'revision.commit.after-fact',
  ],
  B5: ['spawn.after-done', 'resource.after-done', 'unit.after-stage', 'recover.after-op'],
};
/** A supervised run to its end adds its completion (M3 B7: every arc writes `arc-completed`, then its terminal snapshot). */
const COMPLETE_LABELS: Readonly<Partial<Record<Boundary, readonly string[]>>> = { B5: ['complete.after-fact'] };
/** The bumpy run adds the merge-in's conflicted path. */
const MERGEIN_LABELS: Readonly<Partial<Record<Boundary, readonly string[]>>> = { B2: ['mergein.act-start'], B3: ['mergein.after-merge'], B4: ['mergein.act-end'], ...COMPLETE_LABELS };

/**
 * The labels the holistic whole-pipeline row crashes (test/fixtures/pm-holistic.ts `sampleHolistic` selects the
 * occurrences from a recording run and requires exactly these): the M3-only labels, and the M1 labels the holistic
 * layer's jobs, a candidate's arc lane and the arc's own records reach.
 */
const HOLISTIC_LABELS: Readonly<Record<Boundary, readonly string[]>> = {
  B1: ['log.append.before-write', 'log.append.after-partial-write'],
  B2: [
    'log.append.after-fsync', 'spawn.after-intent', 'resource.after-intent', 'worktree.create.act-start', 'worktree.remove.act-start', 'evidence.act-start',
    'ff.act-start', 'snapshot.act-start', 'revision.commit.after-intent', 'needsuser.raise.before-publish', 'audit.after-started', 'checkpoint.after-inputs',
    'docs.act-start', 'packreview.after-started',
  ],
  B3: [
    'launch.after-launch-json', 'launch.after-spawn', 'worktree.add.inside', 'worktree.remove.inside', 'evidence.after-partial-copy', 'snapshot.after-commit-tree',
    'plan.apply.after-inputs', 'audit.after-lens', 'docs.after-commit-tree', 'closeout.after-ff',
  ],
  B4: [
    'spawn.after-runner-exit', 'spawn.after-result', 'spawn.after-usage', 'evidence.act-end', 'ff.act-end', 'snapshot.act-end', 'revision.commit.after-fact',
    'needsuser.raise.after-publish', 'audit.before-ended', 'checkpoint.after-call', 'bundle.after-applied', 'bundle.after-decided', 'docs.act-end',
    'closeout.before-published', 'packreview.after-call', 'packreview.after-ended', 'issues.after-keep', 'amendment.after-decided', 'debt.after-approval',
  ],
  B5: ['spawn.after-done', 'resource.after-done', 'latch.after-fact', 'audit.after-ended', 'docs.after-snapshot', 'complete.after-fact'],
};

const HOLISTIC_RECOVERY: Readonly<Record<Boundary, string>> = {
  B1: 'the M3 fact (a witness, the latch, an audit\'s start or end, a checkpoint\'s inputs, the bundle\'s plan-applied or divergence, the digest, a no-op decision, docs-covered, docs-published, arc-completed) is absent after the restart, a torn line discarded once: the job resumes and writes it once (a capture from the same inputs), the arc ends as uncrashed',
  B2: 'the job\'s open op (its slot or lane reservation, checkout, lane, lens, checkpoint or pack-review call, evidence, docs commit, docs ff, snapshot, the bundle\'s revision, the digest item) is closed as its reconciler says (a spawn lost, the rest redone or reconciled), or a capture fact (pack-review-started included) is durable with nothing run: the job resumes as the same job from its recorded inputs, every backend call made once; an unpublished close-out is abandoned and runs again as the next docs publication; the arc ends as uncrashed',
  B3: 'inside the job\'s op: its reconciler finishes or redoes it (a live lane adopted, the same SHAs), a lens read resumes at the next lens, a close-out ff published is finished (docs-covered, docs-published, the snapshot, the slot released); the arc ends as uncrashed',
  B4: 'the op\'s postcondition holds (reconciled); a read call (the pack review\'s included) or a decided bundle is consumed from the record (never asked again), its aftermath written only where missing (the review ended once; a checkpoint\'s issue capture kept, recorded once with the same bytes; its amendments and issue outcomes once each; a gate note banked once after its approval); one plan-applied, one divergence per (job, index), one digest; the arc ends as uncrashed',
  B5: 'nothing is open: the job, the close-out or the completion runs on from its facts (no second latch, audit-ended, docs-published or arc-completed; the terminal snapshot published by the restart); the arc ends as uncrashed',
};

/** A whole-pipeline row's cells: every label at occurrence 1, and 2 where the label repeats. */
function pipelineCells(extra: Readonly<Partial<Record<Boundary, readonly string[]>>>, recovery: Readonly<Record<Boundary, string>>): Readonly<Record<Boundary, Cell>> {
  const cell = (b: Boundary): Cell => ({ status: 'crash', labels: [...PIPELINE_LABELS[b], ...(extra[b] ?? [])], recovery: recovery[b] });
  return { B1: cell('B1'), B2: cell('B2'), B3: cell('B3'), B4: cell('B4'), B5: cell('B5') };
}

const PIPELINE_RECOVERY: Readonly<Record<Boundary, string>> = {
  B1: 'the torn or unwritten record is absent after the restart (a torn line is discarded with one tail-discarded fact); a lost done leaves its op open for its reconciler, a lost intent never began; the arc ends as uncrashed',
  B2: 'the supervisor restarts the executor; the open op is redone (a spawn with no runner is closed lost and its stage runs again, the call made once; the start\'s revision.commit is finished from its kept payload, reconciled); the arc ends as uncrashed: same stage outcomes, tree, one publication per unit, one usage fact per invocation',
  B3: 'the reconciler finishes or redoes the op from its postcondition (a live runner adopted, an exited one re-adapted); the same SHAs; no backend call twice; a start cut short between keeping the plan\'s bytes and its plan-applied fact records revision 1 on the respawn; the arc ends as uncrashed',
  B4: 'the postcondition holds: the op closes reconciled (a spawn with exit.json re-adapted, redone), its result consumed, never dispatched again; the start\'s revision.commit with its plan-applied written closes reconciled, no second fact; the arc ends as uncrashed',
  B5: 'nothing is open for recovery: a stage cut short after its last op runs again as a new attempt (a completed backend call is consumed, not re-run); the arc ends as uncrashed',
};

/** Every label a row here crashes, by the boundary it is crashed at (one boundary per label). */
const LABEL_BOUNDARY: ReadonlyMap<string, Boundary> = new Map([
  ...(Object.entries(PIPELINE_LABELS) as [Boundary, readonly string[]][]).flatMap(([b, ls]) => ls.map((l) => [l, b] as const)),
  ...(Object.entries(HOLISTIC_LABELS) as [Boundary, readonly string[]][]).flatMap(([b, ls]) => ls.map((l) => [l, b] as const)),
  ['kill.after-intent', 'B2'], ['kill.after-cancel', 'B3'], ['kill.after-quiesced', 'B4'], ['kill.after-done', 'B5'],
  ['docs.after-lanes', 'B4'], ['revision.commit.after-docs', 'B4'], ['batch.after-candidate', 'B4'], ['command.apply.after-effect', 'B4'], ['command.apply.after-receipt', 'B4'],
]);

/**
 * A concurrent job row's cells (M3 B8; test/concurrent-matrix.test.ts, test/fixtures/cm-holistic.ts): `labels`, each at
 * the first occurrence the recording attributes to the stepping job (`sampleJob`), by boundary; `recovery` per
 * boundary, plus the peers' oracle. A boundary none of them falls on is the job's `none` reason.
 */
function jobCells(labels: readonly string[], recovery: Readonly<Record<Boundary, string>>, peers: string, none: string): Readonly<Record<Boundary, Cell>> {
  const at = (b: Boundary): Cell => {
    const ls = labels.filter((l) => {
      const found = LABEL_BOUNDARY.get(l);
      if (found === undefined) throw new Error(`matrix: no boundary for ${l}`);
      return found === b;
    });
    return ls.length === 0 ? { status: 'excluded', why: none } : { status: 'crash', labels: ls, recovery: `${recovery[b]}; ${peers}` };
  };
  return { B1: at('B1'), B2: at('B2'), B3: at('B3'), B4: at('B4'), B5: at('B5') };
}

/** A job's checkout, evidence and call ops (audit-1's, ckpt-1's): the generic M1 labels a job reaches. */
const JOB_OPS = [
  'worktree.create.act-start', 'worktree.add.inside', 'resource.after-intent', 'resource.after-done', 'spawn.after-intent', 'launch.after-launch-json',
  'launch.after-spawn', 'spawn.after-runner-exit', 'spawn.after-result', 'spawn.after-usage', 'spawn.after-done', 'evidence.act-start', 'evidence.act-end',
  'worktree.remove.act-start', 'worktree.remove.inside',
] as const;
const LOG_APPENDS = ['log.append.before-write', 'log.append.after-partial-write', 'log.append.after-fsync'] as const;
const PEERS_IN_BUILDS = 'peers u1 and u2: each build open at the crash, adopted (or re-adapted once it exited) and consumed once, never dispatched again; each unit\'s workloads disjoint; no unit published before the jobs\' story ended';

/**
 * The whole-pipeline labels a concurrent row leaves out: their occurrences in a concurrent run are the start's
 * or recovery's, not the stepping unit's, and the whole-pipeline and recovery rows crash them.
 */
export const CONCURRENT_EXCLUDED_LABELS: Readonly<Record<string, string>> = {
  'recover.before-op': 'a recovery occurrence: the crash during recovery rows and the whole-pipeline rows crash it',
  'recover.after-op': 'a recovery occurrence: the crash during recovery rows and the whole-pipeline rows crash it',
  'plan.apply.after-inputs': 'a start occurrence (the plan put in force before any unit runs): the whole-pipeline and plan-start rows crash it',
  'revision.commit.after-intent': 'a start occurrence (its revision 1 commit): the whole-pipeline and revision.commit rows crash it',
  'revision.commit.after-fact': 'a start occurrence (its revision 1 commit): the whole-pipeline and revision.commit rows crash it',
};

/**
 * A concurrent row's cells (test/concurrent-matrix.test.ts, plan F20, G8): the whole-pipeline labels the stepping
 * unit A reaches, each crashed at A's own occurrences (the selector names A; occurrence 1, and 2 where A repeats
 * the label, as the whole-pipeline rows sample), while the peer B holds `peer`. The recovery of each cell is A's
 * whole-pipeline trace plus the peer's oracle. Not here, as in the whole-pipeline rows: runner.* (per-process
 * counts, the proc.spawn and runner-death rows) and sup.* (the supervisor/host row); nor the peer's own labels
 * (its probe, retry and residue points: the probe job and retry reclaim rows), which a pinned peer does not
 * reach while A walks.
 */
function concurrentCells(peer: string): Readonly<Record<Boundary, Cell>> {
  const cell = (b: Boundary): Cell => ({
    status: 'crash',
    labels: PIPELINE_LABELS[b].filter((l) => !(l in CONCURRENT_EXCLUDED_LABELS)),
    recovery: `A: ${PIPELINE_RECOVERY[b]}; the crash is attributed from the log to A's op at the recorded stage; peer B: ${peer}`,
  });
  return { B1: cell('B1'), B2: cell('B2'), B3: cell('B3'), B4: cell('B4'), B5: cell('B5') };
}

/** A deterministic fixture's cells: the uncrashed test, crashed by `crashedIn` (the four M1 fixtures: the bumpy whole-pipeline row). */
const fixtureCells = (test: string, crashedIn: string = PIPELINE_BUMPY): Readonly<Record<Boundary, Cell>> => {
  const cell: Cell = { status: 'fixture', test, crashedIn };
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
    // M2 step 1. The scenario (test/fixtures/pool-child.ts `retry`): u1's build reserves estate#1, runs, and its
    // teardown fails (cleanup-failed, residue durable first); the retry of the park then reclaims it: reclaim →
    // the recorded teardown → the residue's cleaned disposition → release (F2). Every occurrence of every label is
    // crashed; recovery is the resources phase, then the park's next probe (retryReclaim) runs again.
    row: RETRY_RECLAIM,
    test: 'test/pool-crash.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['resource.after-intent'],
        recovery: 'the open reclaim or release is closed as it stands; a retry holder found cleaning resumes the reclaim order (teardown again, the disposition unless recorded, release); a released instance is never dirty',
      },
      B3: {
        status: 'crash',
        labels: ['spawn.after-intent', 'launch.after-spawn', 'spawn.after-runner-exit'],
        recovery: 'the retry\'s teardown is settled by the spawn reconciler, then rerun as a new op; the residue is disposed by a passing teardown of that instance',
      },
      B4: {
        status: 'crash',
        labels: ['retry.before-disposition'],
        recovery: 'the teardown passed, the residue is undisposed and owned by the arc (A9); recovery reruns the teardown, records the cleaned disposition, releases',
      },
      B5: {
        status: 'crash',
        labels: ['retry.after-disposition', 'resource.after-done'],
        recovery: 'the disposition is durable, the instance still cleaning under the retry: recovery reruns the idempotent teardown and releases without a second disposition',
      },
    },
  },
  {
    // M3 step A5a. The scenario (test/fixtures/compact-child.ts): a start's compaction of an index over the
    // threshold. Recovery is the next start's compaction; the oracle: the index verifies at every crash and reads
    // the same residues and dispositions, then compacts to the same kept lines, with one archive byte-identical
    // to the index before compaction.
    row: RESIDUE_COMPACT,
    test: 'test/compact.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'compaction journals nothing: the tmp is written before anything reads it, and the index is replaced by one rename' },
      B2: {
        status: 'crash',
        labels: ['residue.compact.after-tmp'],
        recovery: 'the index is unchanged beside a stray tmp; the next compaction removes the tmp and compacts',
      },
      B3: {
        status: 'crash',
        labels: ['residue.compact.after-link'],
        recovery: 'the archive is linked to the unchanged index; the next compaction finds it (same inode) and completes',
      },
      B4: {
        status: 'crash',
        labels: ['residue.compact.after-rename'],
        recovery: 'the index is compacted; the next compaction is below the threshold and changes nothing',
      },
      B5: { status: 'excluded', why: 'the rename is the last act: after it the compaction is complete (B4)' },
    },
  },
  {
    // M3 step A5b. The scenario (test/gc.test.ts): `roadmap gc --keep 1` over two sealed arcs, as a CLI child.
    // Recovery is the next gc, which takes over the dead claim; the oracle: it deletes the leftover and nothing else
    // is left to delete, and the kept arc is still sealed.
    row: GC,
    test: 'test/gc.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'gc journals nothing: it verifies every arc before its first delete, and a crash before that leaves only its dead claim' },
      B2: { status: 'excluded', why: 'every delete but a run dir\'s is of one path the next gc lists again or no longer finds; B3 is the one two-step delete' },
      B3: {
        status: 'crash',
        labels: ['gc.run-dir.after-rename'],
        recovery: 'the run dir is a `<arc>.gc-deleting` leftover beside a dead claim; the next gc takes the claim over and removes the leftover',
      },
      B4: { status: 'excluded', why: 'the removal of the renamed dir is idempotent by name: a crash inside it is B3\'s leftover, partly removed' },
      B5: { status: 'excluded', why: 'host files and archives are single-path deletes listed again by the next gc (B2)' },
    },
  },
  {
    // M2 step 3. The scenarios (test/fixtures/probe-child.ts `probe`): one probe job of a backend target (a claude
    // outage park: the backend's smoke) and one of the host target (a unit's blocked-lane park: the host sample
    // and the smoke's shell command), each ending in its `probe` fact. Recovery is `recover`, then the next
    // probe of whatever is still due. A resource target's spawn and reclaim order are the retry reclaim row.
    row: PROBE_JOB,
    test: 'test/probe-crash.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'excluded',
        why: 'a spawn intent durable before its runner is the proc.spawn row\'s B2 (spawn.after-intent), reconciled lost the same way for a smoke spawn; B3 launch.after-launch-json crashes this row\'s spawn before its runner starts',
      },
      B3: {
        status: 'crash',
        labels: ['launch.after-launch-json', 'launch.after-spawn'],
        recovery: 'a runner never started is closed lost, a started one is adopted and its result recorded once; either way no probe fact, so the target is due again and the next probe records the one pass',
      },
      B4: {
        status: 'crash',
        labels: ['probe.before-fact'],
        recovery: 'the smoke is done and nothing is open; with no probe fact the target is due again and the next probe records the one pass',
      },
      B5: {
        status: 'crash',
        labels: ['probe.after-fact'],
        recovery: 'the pass is durable and the park recovered: nothing is open and nothing is due',
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
    // An `apply` adding an obligation (so it has a docs publication), applied by a child with the stand-in docs
    // publisher (test/fixtures/revision-child.ts); the whole recovery runs. A start's own revision (no docs step)
    // reaches the B2 and B4 labels in the whole-pipeline rows, which crash them there.
    row: REVISION_COMMIT,
    test: 'test/revision.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['revision.commit.after-intent'],
        recovery: 'the payload is kept and named, no docs ff: the commit is aborted (no needs-user) and the apply re-evaluates and commits once (that commit done live): one plan-applied, one docs ff; the command done reconciled',
      },
      B3: {
        status: 'crash',
        labels: ['revision.commit.after-docs'],
        recovery: 'the docs ff published, no plan-applied: recovery appends exactly the kept payload with that publication, never reclassifying; done reconciled; the apply finds its fact',
      },
      B4: {
        status: 'crash',
        labels: ['revision.commit.after-fact'],
        recovery: 'plan-applied written, its divergences and done not: recovery appends only what is missing; done reconciled; one plan-applied',
      },
      B5: { status: 'excluded', why: 'the done is one journal append (journal.append) and closes the commit: nothing is open for recovery' },
    },
  },
  {
    // `steer u1 --class frontier` of a unit parked after its build, applied by a child (test/fixtures/steer-child.ts);
    // recovery (src/recover/recover.ts) finishes what the crash left, then the command's reconciler.
    row: STEER,
    test: 'test/steer.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['command.apply.before-effect'],
        recovery: 'accepted receipt only, op open: the reconciler applies the whole effect once (the class revision\'s commit and the snapshot done live): one class revision, the brief kept, one pre-steer snapshot, one steered fact, the applied receipt; the command done reconciled',
      },
      B3: {
        status: 'crash',
        labels: ['revision.commit.after-intent', 'revision.commit.after-fact'],
        recovery: 'the class revision is open or its fact written: recovery finishes it from its payload (one plan-applied naming the command; commit done reconciled, no needs-user), then the reconciler finds it (planAppliedBy) and writes the brief, the snapshot (done live) and the one steered fact; the command done reconciled',
      },
      B4: {
        status: 'crash',
        labels: ['command.apply.after-effect', 'command.apply.after-receipt'],
        recovery: 'the steered fact is written (the postcondition; commit and snapshot done live): nothing is applied twice; the applied receipt is written if missing, or read; the command done reconciled; the unit then runs its one steer round',
      },
      B5: { status: 'excluded', why: 'the done is one journal append (journal.append) and closes the op; the steer round that follows is the driver\'s (steer.round-uncharged)' },
    },
  },
  {
    // `merge-in u1` of a unit parked after its lanes, the integration tip advanced cleanly beside it, applied by a
    // child (test/fixtures/mergein-child.ts); recovery finishes the open mergein.prepare, then the command's reconciler.
    row: MERGE_IN,
    test: 'test/mergein.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['command.apply.before-effect'],
        recovery: 'accepted receipt only, op open: the reconciler plans the merge again (merge-tree), acts once (mergein.prepare done live), writes the one merged-in fact and the applied receipt; the command done reconciled',
      },
      B3: {
        status: 'crash',
        labels: ['mergein.act-start', 'mergein.after-commit-tree', 'mergein.after-cas'],
        recovery: 'the command\'s mergein.prepare is open: its reconciler redoes it (HEAD = old: the same SHA; done redone) or finishes it (after-cas, HEAD = the merge; done reconciled); the command\'s reconciler then finds it done and writes the one merged-in fact; the command done reconciled',
      },
      B4: {
        status: 'crash',
        labels: ['mergein.act-end', 'command.apply.after-effect', 'command.apply.after-receipt'],
        recovery: 'the merge is made (act-end: mergein.prepare done reconciled after recovery; else done live), or the merged-in fact written: nothing is merged twice; one merged-in fact, the applied receipt; the command done reconciled; the unit re-enters at its lanes',
      },
      B5: { status: 'excluded', why: 'the done is one journal append (journal.append) and closes the op; the lanes that follow are the driver\'s (mergein.reenters-lanes)' },
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
    cells: pipelineCells(COMPLETE_LABELS, PIPELINE_RECOVERY),
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
    // The holistic scenario (test/fixtures/pm-holistic.ts HOLISTIC), a corpus arc (M4a D0): review-1 (the pack review),
    // each checkpoint's issue capture and amendment settlement, baseline-1, u1 with a journey lane and I-2 latched,
    // audit-1, ckpt-1 applying a bundle (revision, divergence, digest), audit-2, ckpt-2 an interpretation-only no-op,
    // the close-out docs-1, arc-completed and the terminal snapshot, through `roadmap start`. Its occurrences are
    // sampled by context (`sampleHolistic`): each M3-only label at 1 and 2, each log append at each M3 fact kind's
    // first, every other label at its first occurrence in each job kind, a candidate's arc lane and the arc's own
    // records after the first job. Each cell asserts the op the crash hit (the log at the crash holds the recording's
    // records up to it), then the whole-pipeline oracle plus the holistic record counts of the uncrashed run.
    row: PIPELINE_HOLISTIC,
    test: 'test/pipeline-matrix.test.ts',
    cells: {
      B1: { status: 'crash', labels: HOLISTIC_LABELS.B1, recovery: HOLISTIC_RECOVERY.B1 },
      B2: { status: 'crash', labels: HOLISTIC_LABELS.B2, recovery: HOLISTIC_RECOVERY.B2 },
      B3: { status: 'crash', labels: HOLISTIC_LABELS.B3, recovery: HOLISTIC_RECOVERY.B3 },
      B4: { status: 'crash', labels: HOLISTIC_LABELS.B4, recovery: HOLISTIC_RECOVERY.B4 },
      B5: { status: 'crash', labels: HOLISTIC_LABELS.B5, recovery: HOLISTIC_RECOVERY.B5 },
    },
  },
  // The concurrent rows (M2 step 8; test/fixtures/cm-common.ts): B starts and reaches its pin, then A starts and
  // walks the straight scenario; each cell crashes one of A's occurrences, restarts, and checks A's M1 trace and
  // B's oracle.
  {
    row: CONCURRENT_BUILD,
    test: 'test/concurrent-matrix.test.ts',
    cells: concurrentCells('its build runner adopted (or re-adapted once it exited) and consumed once, never dispatched again; each unit\'s workload intervals disjoint'),
  },
  {
    row: CONCURRENT_JUDGMENT,
    test: 'test/concurrent-matrix.test.ts',
    cells: concurrentCells('its gate runner adopted and consumed once against its recorded judgment-inputs: the approval binds the recorded head and the contracts at the recorded tip'),
  },
  {
    row: CONCURRENT_LANE,
    test: 'test/concurrent-matrix.test.ts',
    cells: concurrentCells('its lane adopted; the lanes reservation it held cleaned by a teardown bound to estate#1 as the lane was (A took estate#2); no instance ever had two owners'),
  },
  {
    row: CONCURRENT_TEARDOWN,
    test: 'test/concurrent-matrix.test.ts',
    cells: concurrentCells('its teardown adopted and run to its end (passed, never killed)'),
  },
  {
    row: CONCURRENT_PUBLICATION,
    test: 'test/concurrent-matrix.test.ts',
    cells: concurrentCells('safety only: one publication holder at a time, and each grant of the slot after a release goes to the best-ranked unit that was waiting for it; no claim that the order is the uncrashed one'),
  },
  {
    row: CONCURRENT_RESIDUE,
    test: 'test/concurrent-matrix.test.ts',
    cells: concurrentCells('the respawn is not refused by its own residue; the park\'s outstanding targets and its nextProbeAt are unchanged (no probe of it before that time but the resume\'s)'),
  },
  // The concurrent job rows (M3 B8; test/fixtures/cm-holistic.ts): the jobs scenario (two units pinned in live builds
  // while `roadmap audit` runs audit-1 and ckpt-1 applies a bundle) and the preempt scenario (a rule's docs publication
  // preempting u1's candidate); each cell crashes one of the stepping job's occurrences (a job's crash points pass no
  // unit: the recording attributes the occurrence to the job by its log's records), asserts the op it hit and the peers'
  // state at the crash, then the end.
  {
    row: CONCURRENT_AUDIT,
    test: 'test/concurrent-matrix.test.ts',
    cells: jobCells([...LOG_APPENDS, 'audit.after-started', 'audit.after-lens', 'audit.before-ended', 'audit.after-ended', 'issues.after-keep', ...JOB_OPS], {
      B1: 'audit-started or audit-ended lost (a torn line discarded once): the audit captures again from the same state, or ends again, once',
      B2: 'the audit\'s open op closed by its reconciler (a spawn lost, the rest redone or reconciled), or audit-started durable with nothing run: the job resumes as audit-1 from its recorded inputs, its lens asked once',
      B3: 'inside the audit\'s op or after its lens was read: finished or redone; the job resumes, consuming the call it made',
      B4: 'the op\'s postcondition holds (reconciled), or every lens read and the end not written: the job resumes and ends once; or the audit ended and its checkpoint\'s issue capture kept (the corpus arc\'s, its last record still the audit\'s): the restart captures again (the same bytes) and records it once',
      B5: 'nothing open: the job runs on from its facts; one audit-ended, the lens called once',
    }, PEERS_IN_BUILDS, 'no audit label falls on this boundary'),
  },
  {
    row: CONCURRENT_BUNDLE,
    test: 'test/concurrent-matrix.test.ts',
    cells: jobCells([...LOG_APPENDS, 'checkpoint.after-inputs', 'checkpoint.after-call', 'plan.apply.after-inputs', 'revision.commit.after-intent', 'revision.commit.after-fact', 'bundle.after-applied', ...JOB_OPS], {
      B1: 'checkpoint-inputs lost: captured again once; the bundle\'s plan-applied or divergence lost inside its revision.commit: the revision finished from its kept payload (reconciled)',
      B2: 'the checkpoint\'s open op closed by its reconciler, or checkpoint-inputs durable with nothing asked, or the bundle\'s revision.commit open: the job resumes as ckpt-1, asks once, and the revision is finished from its payload (reconciled) or aborted and activated again; one plan-applied{bundle}',
      B3: 'inside the checkpoint\'s op, or the revision\'s bytes kept before its commit: finished or redone; the call consumed, never asked again',
      B4: 'the call read or the revision\'s plan-applied written: consumed and finished (reconciled); one plan-applied, one divergence, one digest',
      B5: 'nothing open: the aftermath written only where missing',
    }, PEERS_IN_BUILDS, 'no checkpoint label falls on this boundary'),
  },
  {
    row: CONCURRENT_BATCH,
    test: 'test/concurrent-matrix.test.ts',
    cells: jobCells([
      'resource.after-intent', 'resource.after-done', 'candidate.act-start', 'candidate.after-commit-tree', 'candidate.act-end', 'batch.after-candidate',
      ...JOB_OPS.filter((l) => !l.startsWith('resource.')), 'evidence.after-partial-copy', ...LOG_APPENDS, 'ff.act-start', 'ff.act-end', 'snapshot.act-start',
      'snapshot.after-commit-tree', 'snapshot.act-end',
    ], {
      B1: 'a batch lane\'s witness lost: the lane runs again and witnesses once more',
      B2: 'the batch\'s slot reserve, chained candidate.merge, checkout, lane or batch ff durable, not acted: closed (the ff unpublished at T: a batch CAS is never redone), the batch holder abandoned and batch-1 run again as its next attempt, published once',
      B3: 'inside the chain\'s act, a checkout or a lane: redone to the same commits, or adopted; the batch published once',
      B4: 'the candidate made (abandoned, run again), or the batch ff moved integration with no done (reconciled published, finishBatch writes the snapshot and releases); both members retired by the one ff',
      B5: 'nothing open: the batch goes on from its records',
    }, 'peer u3: its build open at the crash, adopted (or re-adapted once it exited) and consumed once; it merges after the batch; F-1 resolved once', 'no batch label falls on this boundary'),
  },
  {
    // The jobs scenario's units approve with a note each (the corpus arc banks it as `debt-banked`, src/pipeline/gate.ts
    // `bankGateNotes`); a crash at each unit's `debt.after-approval` while the other unit and the stepping jobs go on.
    row: CONCURRENT_DEBT,
    test: 'test/concurrent-matrix.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'each fact is one journal append; journal.append B1 covers a torn or short one' },
      B2: { status: 'excluded', why: 'no intent: the banked facts are written from the gate call\'s recorded result' },
      B3: { status: 'excluded', why: 'there is no act between the approval and the banking beyond the fact appends B4 crashes between' },
      B4: {
        status: 'crash',
        labels: ['debt.after-approval'],
        recovery: 'the approval written, no debt-banked: the restart consumes the recorded gate call (never asked again), keeps the approval and banks the note once, whatever the peer unit and the jobs were doing; one approval and one debt-banked per unit, the holistic records as uncrashed',
      },
      B5: { status: 'excluded', why: 'a banked fact is durable and keyed by its source: a re-read of the answer mints nothing again (mintDebt)' },
    },
  },
  {
    row: CONCURRENT_PREEMPT,
    test: 'test/concurrent-matrix.test.ts',
    cells: jobCells([
      'kill.after-intent', 'kill.after-cancel', 'kill.after-quiesced', 'kill.after-done', 'resource.after-intent', 'resource.after-done', 'docs.act-start',
      'docs.after-commit-tree', 'docs.act-end', 'worktree.create.act-start', 'worktree.add.inside', 'spawn.after-intent', 'launch.after-launch-json',
      'launch.after-spawn', 'spawn.after-runner-exit', 'spawn.after-result', 'spawn.after-usage', 'spawn.after-done', 'evidence.act-start',
      'evidence.after-partial-copy', 'evidence.act-end', 'worktree.remove.act-start', 'worktree.remove.inside', 'docs.after-lanes', 'ff.act-start', 'ff.act-end',
      'revision.commit.after-docs', ...LOG_APPENDS, 'revision.commit.after-fact', 'snapshot.act-start', 'snapshot.after-commit-tree', 'snapshot.act-end',
      'docs.after-snapshot', 'command.apply.after-effect', 'command.apply.after-receipt',
    ], {
      B1: 'the rule\'s plan-applied lost inside its revision.commit: finished from its payload (reconciled) with the docs ff it published',
      B2: 'the preempt kill or the publication\'s op open: the kill finished, the candidate\'s slot released, the lane closed; an unpublished docs holder abandoned and the rule re-evaluated and published once',
      B3: 'inside the kill (cancel written) or the docs commit or a lane: finished or redone; the rule publishes once',
      B4: 'the kill quiesced, the docs committed or published, the revision\'s fact or the receipt written: reconciled, nothing twice',
      B5: 'the kill or the snapshot done: the publication finishes and releases the slot',
    }, 'peer u1 (its candidate preempted, or, when the restart released its pinned lane first, green before the publication): safety, not the uncrashed order: one holder of the slot at a time, the rule applied once with one docs ff, u1 published once onto the tree the uncrashed run ended with', 'no preempt label falls on this boundary'),
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
  {
    // `rule` landing C-2 with a contract op (so its docs publication commits constraints.md and contracts/api.md), applied
    // by a child with the real publisher (test/fixtures/publish-child.ts); the whole recovery runs, its command
    // reconciler with the real publisher too. Each label occurs once in the run (the recording mode lists them), so
    // each is crashed at occurrence 1; the command.apply the crash leaves open is closed reconciled in every cell.
    row: DOCS_PUBLICATION,
    test: 'test/publish.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['revision.commit.after-intent', 'docs.act-start'],
        recovery: 'the commit is open with no docs ff (its docs.commit redone to its recorded commit, or never begun): the commit is aborted, the docs holder abandoned (checkout removed, slot released), and the rule re-evaluates and publishes again (docs-2, or docs-1 when the crashed commit never took the slot): one plan-applied, integration at that publication\'s commit',
      },
      B3: {
        status: 'crash',
        labels: ['docs.after-commit-tree', 'ff.act-start'],
        recovery: 'docs.commit mid-act: redone to the same commit, then aborted with its revision and republished as docs-2; the docs ff mid-act: redone (a docs ff has no unit to re-check), the revision appended from its payload with docs-1 (its revision.commit closed reconciled), then finishDocs (docs-covered where docs-only, snapshot, release)',
      },
      B4: {
        status: 'crash',
        labels: ['docs.act-end', 'docs.after-lanes', 'ff.act-end', 'revision.commit.after-docs'],
        recovery: 'before its ff (committed: the docs.commit closed reconciled; or its lanes run): the revision aborted, abandoned and republished as docs-2; its ff published (done or not; an open ff closed reconciled): the revision appended from its payload exactly with docs-1 (its revision.commit closed reconciled), never reclassified, then finishDocs; one plan-applied either way',
      },
      B5: {
        status: 'crash',
        labels: ['revision.commit.after-fact', 'docs.after-snapshot'],
        recovery: 'plan-applied written: the revision.commit closed reconciled (after its fact) or already done (after the snapshot), then finishDocs writes only what is missing (one snapshot) and releases the slot; the rule finds its fact and writes the ledger back',
      },
    },
  },
  {
    // Unit u1's candidate parks in its suite lane (a barrier) holding the slot before green; `rule` is applied in the
    // same child (test/fixtures/publish-child.ts), preempting it: the kill of its lane with reason `preempt` is crashed (each
    // kill.* label occurs once, at occurrence 1). In every cell the lane's spawn is closed redone (B4, B5: or live, settled
    // by its invoke before the crash), the rule's revision.commit (waiting for the slot) aborted and re-evaluated, and u1's
    // candidate records green only after the publication.
    row: PREEMPT,
    test: 'test/publish.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['kill.after-intent'],
        recovery: 'the preempt kill is open, the lane alive: the kill redone, the lane closed, the candidate\'s slot released (it never recorded green), the rule re-evaluates and publishes once; the unit then runs a fresh candidate and merges',
      },
      B3: {
        status: 'crash',
        labels: ['kill.after-cancel'],
        recovery: 'cancel.json written: the kill redone (its runner not yet gone) or reconciled, the candidate abandoned, the slot released; the rule publishes once, then the unit merges',
      },
      B4: {
        status: 'crash',
        labels: ['kill.after-quiesced'],
        recovery: 'the lane is quiesced, the kill not done: reconciled; the candidate abandoned; the rule publishes once, then the unit merges',
      },
      B5: {
        status: 'crash',
        labels: ['kill.after-done'],
        recovery: 'the kill is done (live), the candidate\'s outcome not recorded: its slot released by recovery; the rule publishes once, then the unit merges',
      },
    },
  },
  {
    // u1 completes future obligation I-2 (held on its candidate) and runs to its merge in a child
    // (test/fixtures/brake-child.ts); the whole recovery runs, then the unit driver finishes the unit. Each label occurs
    // once in the run (occurrence 1).
    row: LATCH,
    test: 'test/brake.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: { status: 'excluded', why: 'no latch is written before the ff published: the candidate.merge, integration.ff, snapshot.publish row crashes the ff intent and its act' },
      B3: { status: 'excluded', why: 'the latch is one fact append (the journal.append row crashes a torn append); the ff act itself is the candidate.merge, integration.ff, snapshot.publish row' },
      B4: {
        status: 'crash',
        labels: ['ff.act-end'],
        recovery: 'the ff moved integration, its done not written: reconciled published; the ff stage runs again, reads the published ff back and writes the missing latch; one ff, one publication, one obligation-latched, before the snapshot',
      },
      B5: {
        status: 'crash',
        labels: ['latch.after-fact'],
        recovery: 'the latch is durable, the ff stage outcome not (its ff done live, nothing open): the stage runs again, reads the published ff back, writes no second latch, records published; one ff, one publication; the snapshot follows',
      },
    },
  },
  {
    // Two approved units repairing F-1 publish as one batch in a child (test/fixtures/batch-child.ts); recovery runs, then
    // a published batch is finished (`finishBatch`) and any other runs again as the next attempt of the same job.
    // resource.after-intent is crashed at occurrences 1-6 (the slot's reserve and run, the first lane's reserve, run,
    // clean and release under job{batch-1}) and 11-12 (the slot's clean and release after the ff); 7-10, the second
    // lane's same four edges, repeat 3-6. Every other label occurs once (occurrence 1).
    row: BATCH_PUBLICATION,
    test: 'test/batch.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['resource.after-intent', 'candidate.act-start', 'ff.act-start'],
        recovery: 'a transition, the chained candidate.merge or the batch ff is durable, not acted: closed (the transition reconciled, the merge redone to its recorded chain, the ff reconciled unpublished at T: a batch CAS is never redone); before the ff, the batch holder abandoned (checkouts removed, slot released) and the batch runs again as attempt 2 of batch-1 and publishes once; the slot\'s clean after the ff leaves it cleaning for finishBatch, which writes nothing twice and releases it; its release leaves the batch complete',
      },
      B3: {
        status: 'crash',
        labels: ['candidate.after-commit-tree'],
        recovery: 'inside the chain\'s act: the merge redone to the same commits; the batch abandoned and run again as attempt 2 of batch-1, published once',
      },
      B4: {
        status: 'crash',
        labels: ['batch.after-candidate', 'ff.act-end'],
        recovery: 'the candidate made, nothing open (abandoned, run again as attempt 2) or the ff moved integration with no done: reconciled published, the batch holder left holding the slot; finishBatch writes the snapshot and releases it; both members retired by the one ff',
      },
      B5: {
        status: 'crash',
        labels: ['snapshot.act-end'],
        recovery: 'the batch published and its snapshot acted: the snapshot reconciled, the slot left held; finishBatch writes nothing twice and releases it',
      },
    },
  },
  {
    // The vacuity repair v1 runs to its merge in a child (test/fixtures/repair-child.ts): its reproduce applies F-1's
    // mutant at the tip (occurrence 1 of each label), its candidate's kill check on the candidate tree (occurrence 2);
    // each label is crashed at both; recovery runs, then the unit driver finishes the unit, the stage cut short (the
    // reproduce or the candidate) running again with one new apply.
    row: MUTANT_APPLY,
    test: 'test/repair.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['mutant.act-start'],
        recovery: 'the intent is durable, nothing made: redone (the worktree made, the patch applied), done; the cut-short reproduce or candidate runs again as a new attempt, removing that worktree first; one reproduced, one candidate green, the unit merges',
      },
      B3: {
        status: 'crash',
        labels: ['mutant.after-worktree'],
        recovery: 'the worktree made, the patch not applied: the worktree removed and the act redone; the reproduce or candidate runs again, removing the leftover; one reproduced, one candidate green, the unit merges',
      },
      B4: {
        status: 'crash',
        labels: ['mutant.act-end'],
        recovery: 'the patched worktree is exactly the recorded outcome: done reconciled with the patched tree; the reproduce or candidate runs again, removing the leftover; one reproduced, one candidate green, the unit merges',
      },
      B5: {
        status: 'crash',
        labels: ['mutant.after-done'],
        recovery: 'the apply done, its lane never run: no intent open for it; the reproduce or candidate runs again as a new attempt, removing the leftover worktree; one reproduced, one candidate green, the unit merges and resolves F-1',
      },
    },
  },
  {
    // A completing arc runs under the scheduler in a child (test/fixtures/sched-m3-child.ts) through its close-out; recovery
    // runs, then the scheduler again: the arc completes once. Each label is reached once per completion; B5 is also
    // crashed at the arc's second completion after a reopen (complete.after-fact#2: the first terminal snapshot does not
    // cover the second fact).
    row: TERMINAL_SNAPSHOT,
    test: 'test/scheduler-m3.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: { status: 'excluded', why: 'the close-out\'s docs.commit, slot and lanes before its ff are the docs publication row\'s crash points: an unpublished docs holder is abandoned (abandonDocs) and the close-out runs again as the next docs-n' },
      B3: {
        status: 'crash',
        labels: ['closeout.after-ff'],
        recovery: 'the close-out ff published, the slot still held by its docs holder: recovery finishes it (finishDocs: the plan in force names no such pub, so docs-covered and docs-published, then the snapshot and the release); the scheduler finds the close-out done and completes: one docs-published, one arc-completed, one terminal snapshot',
      },
      B4: {
        status: 'crash',
        labels: ['closeout.before-published'],
        recovery: 'docs-covered written, docs-published not: recovery\'s finishDocs writes only docs-published, the snapshot and the release; the arc completes once',
      },
      B5: {
        status: 'crash',
        labels: ['complete.after-fact'],
        recovery: 'arc-completed written, its terminal snapshot not: the next start publishes the terminal snapshot (the completion still active, the fact is not written again) and the run ends complete',
      },
    },
  },
  {
    // A requested audit of two lenses runs in a child (test/fixtures/audit-child.ts); recovery runs, then the audit is run
    // again: a running audit resumes as the same job from its recorded inputs. spawn.after-runner-exit is crashed at
    // occurrence 1 (the arc lane) and 2 (the vision lens call; 3, the invariants call, repeats it), audit.after-lens at 1
    // and 2 (after each lens's read); every other label occurs once (occurrence 1).
    row: AUDIT_JOB,
    test: 'test/audit.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['audit.after-started'],
        recovery: 'audit-started durable, nothing run: the job resumes as audit-1 from its recorded inputs (no second capture); its lanes and both lenses run once; one audit-ended, completed',
      },
      B3: {
        status: 'crash',
        labels: ['spawn.after-runner-exit', 'audit.after-lens'],
        recovery: 'inside the job: its arc lane\'s spawn closed redone and the lane run again on resume (no witnessed fact before); or a lens call\'s spawn closed redone (its result re-derived from exit.json), consumed on resume and never asked again; or a lens read (the first, or both) with its findings opened; the job resumes, consumes the calls it already made and asks only the rest; one audit-ended',
      },
      B4: {
        status: 'crash',
        labels: ['audit.before-ended'],
        recovery: 'every lens read and the lens checkout removed, the end not written: the job resumes, consumes both calls, asks nothing, writes one audit-ended',
      },
      B5: {
        status: 'crash',
        labels: ['audit.after-ended'],
        recovery: 'the audit ended: nothing to resume; no audit is due; no call was asked twice',
      },
    },
  },
  {
    // A checkpoint after a completed audit runs in a child (test/fixtures/checkpoint-child.ts); recovery runs, then the
    // checkpoint again. Each label is reached once per checkpoint; this row and BUNDLE_ACTIVATE crash every cell at the
    // arc's first checkpoint and at its second (`#2`: ckpt-1 applied with its digest open, then ckpt-2 crashed).
    row: CHECKPOINT_JOB,
    test: 'test/checkpoint.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['checkpoint.after-inputs'],
        recovery: 'checkpoint-inputs durable, nothing asked: the job resumes as ckpt-1 from its recorded inputs (no second capture), asks once, and decides once',
      },
      B3: { status: 'excluded', why: 'the call is a proc.spawn: its runner-exit cells (spawn.*) cover a crash inside it; the job consumes the recorded call on resume' },
      B4: {
        status: 'crash',
        labels: ['checkpoint.after-call'],
        recovery: 'the call read, nothing decided: the job resumes, consumes the recorded call (no second call), activates once',
      },
      B5: { status: 'excluded', why: 'the decision is the job\'s last record: the BUNDLE_ACTIVATE row covers what follows it' },
    },
  },
  {
    row: BUNDLE_ACTIVATE,
    test: 'test/checkpoint.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: { status: 'excluded', why: 'an applied bundle commits through revision.commit, whose crash cells are the REVISION_COMMIT row\'s; the job resumes undecided when it aborted' },
      B3: { status: 'excluded', why: 'the activation holds the fence and awaits only the revision\'s docs publication, covered by the docs publication rows' },
      B4: {
        status: 'crash',
        labels: ['bundle.after-decided', 'bundle.after-applied'],
        recovery: 'decided (a no-op) or applied, its aftermath not written: the next run settles it from the recorded output, writing each missing interpretation divergence (job, index), finding disposition and digest once, and asks nothing',
      },
      B5: { status: 'excluded', why: 'the aftermath is idempotent derivations: settling again writes nothing' },
    },
  },
  // M3 plan rows whose crash states other rows' cells reach (plan "Crash safety"): each names its uncrashed evidence and
  // the row that crashes it.
  {
    // Every holistic whole-pipeline cell asserts the fence invariant on the run's log (no capture fact inside an open
    // revision.commit), and crashes the bundle's revision.commit before the drift audit's capture.
    row: INPUT_CAPTURE_FENCE,
    test: 'test/audit.test.ts',
    cells: fixtureCells('audit.starts-in-ff-window (H2)', PIPELINE_HOLISTIC),
  },
  {
    // The holistic whole-pipeline row crashes ckpt-2's no-op at its bundle-decided append and at bundle.after-decided: the
    // restart's scheduler settles the lost interpretation divergence (M3 B8 found it lost: nothing re-ran the settle).
    row: NOOP_DIVERGENCE,
    test: 'test/checkpoint.test.ts',
    cells: fixtureCells('noop.interpretation-divergence (H12)', PIPELINE_HOLISTIC),
  },
  {
    // `reverse D-1` of a checkpoint's bundle revision that admitted u2 (compensation restore-revision, a plan-only
    // preimage: no docs publication), applied by a child (test/fixtures/revision-child.ts); the whole recovery runs.
    // Every label is reached once (one command, one compensating commit), so occurrence 1 is the only one.
    row: REVERSE,
    test: 'test/revision.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['command.apply.before-effect'],
        recovery: 'accepted receipt only, op open: the reconciler runs the reverse once: one compensating plan-applied naming the command, its commit done live (recoveredBy null), the preimage plan in force, the applied receipt; command done reconciled',
      },
      B3: {
        status: 'crash',
        labels: ['plan.apply.after-inputs', 'revision.commit.after-intent', 'revision.commit.after-fact'],
        recovery: 'the payload kept with no commit: the reverse re-evaluates and commits once (commit done live); the commit open, its plan-applied written or not: the revision reconciler appends only what is missing from the payload (no docs step, no needs-user; commit done reconciled), then the reverse finds its fact (planAppliedBy); one plan-applied, the applied receipt; command done reconciled',
      },
      B4: {
        status: 'crash',
        labels: ['command.apply.after-effect', 'command.apply.after-receipt'],
        recovery: 'the compensating revision is committed (done live): nothing is reversed twice; the applied receipt is written if missing, or read; command done reconciled',
      },
      B5: { status: 'excluded', why: 'the done is one journal append (journal.append) and closes the op: nothing is open for recovery, and a re-delivered command is a no-op (cmd.idempotent)' },
    },
  },
  {
    // u1 (selecting I-1) run by a child (test/fixtures/unit-child.ts) to its ff and crashed there; while no executor runs a
    // P1 over I-1 is opened (B2 also crashed without it, the control); the recovery engine's ff redo re-checks with the
    // real `unitRedo` (src/pipeline/integrate.ts), then the unit driver runs. The fingerprint half is crashed with a stub
    // re-check (ff.test.ts ff.fingerprint-callback-gates-redo, in the candidate.merge, integration.ff, snapshot.publish row).
    row: FF_ELIGIBILITY,
    test: 'test/repair.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['ff.act-start'],
        recovery: 'the CAS never happened: with a P1 over I-1 opened while down the ff is not redone (done unpublished at T, reconciled); the driver records ff:cas-stale, its fresh candidate finding-blocked (uncharged), and it publishes only once the P1 is ruled; without the P1 it is redone (published, redone) and the unit finishes once',
      },
      B3: { status: 'excluded', why: 'the act is one update-ref CAS: no point inside it' },
      B4: {
        status: 'crash',
        labels: ['ff.act-end'],
        recovery: 'the CAS happened, then a P1 over I-1 opened: done published (reconciled), the P1 left open; a P1 cannot undo a publication; the driver reads ff:published and finishes once',
      },
      B5: { status: 'excluded', why: EXCLUDED_B5_OP },
    },
  },
  {
    // test/job-residue-restart.test.ts: every occurrence of every label in the `retry` scenario (test/fixtures/job-child.ts:
    // job audit-1 reserves estate#1, runs, its teardown fails into a job-owned residue, then the job reclaims it), counted
    // by a recording run (job-residue.occurrences); recovery is the resources phase, then the residue's probe.
    // job-residue.dead-holder crashes launch.after-spawn at the job's lane (the `lane` scenario); the concurrent batch row
    // crashes a batch job's lanes and slot.
    row: JOB_RESIDUE,
    test: 'test/job-residue-restart.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['resource.after-intent', 'residue.before-host-append'],
        recovery: 'reserve, run or clean open: the dead job\'s set is cleaned under its owner label (cleaning with no residue of its own is a live run\'s clean) and its first teardown fails into one job-owned residue; an open fail is closed with its residue appended once; reclaim or release open: the instance, cleaning with the job\'s residue, resumes the reclaim order; the probe reclaims what is cleanup-failed; one cleaned disposition, free',
      },
      B3: {
        status: 'crash',
        labels: ['launch.after-spawn'],
        recovery: 'a job\'s runner started, the executor dead (its lane, the cleanup\'s teardown, the reclaim\'s): recovery settles the spawn and reruns the teardown under the job\'s owner label: released, or (a failed lane cleanup) a job-owned residue the probe reclaims; the reclaim\'s resumes its order',
      },
      B4: {
        status: 'crash',
        labels: ['retry.before-disposition', 'residue.after-host-append'],
        recovery: 'the reclaim\'s teardown passed, the disposition not written: recovery reruns it, records one cleaned disposition, releases; the fail\'s residue durable, its done not: closed with nothing appended, the probe reclaims it',
      },
      B5: {
        status: 'crash',
        labels: ['retry.after-disposition', 'resource.after-done'],
        recovery: 'the disposition durable, the instance cleaning under the job\'s retry: recovery releases it, no second disposition; after each transition\'s done the holder\'s state is recovered as at B2, nothing open',
      },
    },
  },
  {
    // A corpus arc's gate approves with a note: `approval`, then `debt-banked` keyed by its source (src/pipeline/gate.ts
    // `bankGateNotes`), driven in a child (test/fixtures/corpus-gate-child.ts) that a restart recovers and steps on.
    row: DEBT_BANK,
    test: 'test/corpus-judgment.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'each fact is one journal append; journal.append B1 covers a torn or short one' },
      B2: { status: 'excluded', why: 'no intent: the approval and the banked items are facts written from the gate call\'s recorded result, which recovery closed before (proc.spawn rows)' },
      B3: { status: 'excluded', why: 'there is no act between the approval and the banking beyond the fact appends B4 crashes between' },
      B4: {
        status: 'crash',
        labels: ['debt.after-approval'],
        recovery: 'the approval written, no debt-banked: the restart consumes the recorded gate call (never asked again), keeps the approval and banks each note once; one approval, one debt-banked per source, gate:approve once',
      },
      B5: { status: 'excluded', why: 'a banked fact is durable and keyed by its source: a re-read of the answer mints nothing again (mintDebt); the stage-outcome after it is the gate\'s own row' },
    },
  },
  {
    // A corpus arc's pack review before its first admission (src/holistic/packreview.ts `runPackReview`), driven in a child
    // (test/fixtures/corpus-job-child.ts) that a restart in process recovers and runs again.
    row: PACK_REVIEW_JOB,
    test: 'test/packreview.test.ts',
    cells: {
      B1: { status: 'excluded', why: EXCLUDED_B1 },
      B2: {
        status: 'crash',
        labels: ['packreview.after-inputs', 'packreview.after-started'],
        recovery: 'the inputs kept (content-addressed), no fact: the restart keeps the same bytes as review-1 and starts it once; started, nothing asked: the job resumes from its kept inputs alone and asks once',
      },
      B3: { status: 'excluded', why: 'the call is a proc.spawn: its runner-exit cells (spawn.*) cover a crash inside it; the job consumes the recorded call on resume' },
      B4: {
        status: 'crash',
        labels: ['packreview.after-call', 'packreview.after-ended'],
        recovery: 'the call recorded, nothing ended: the restart consumes it (never asked again) and ends the job once; ended, its blocking item not raised: the restart raises it once (settlePackReviews); one review, one item',
      },
      B5: { status: 'excluded', why: 'the item is the job\'s last record; the hold is a pure function of the facts, the items and the current key' },
    },
  },
  {
    // A corpus arc's checkpoint capture (src/holistic/intake.ts `captureCheckpointIssues`) against the fake gh, driven in a
    // child (test/fixtures/corpus-job-child.ts) that a restart in process recovers and runs again.
    row: ISSUE_CAPTURE,
    test: 'test/intake.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'each fact is one journal append; journal.append B1 covers a torn or short one' },
      B2: { status: 'excluded', why: 'the identity, policy and fetch are forge reads that write nothing: a crash before the capture is kept re-queries and re-fetches' },
      B3: { status: 'excluded', why: 'the capture\'s bytes are kept content-addressed (keepInput) in one write the B4 cell follows' },
      B4: {
        status: 'crash',
        labels: ['issues.after-keep'],
        recovery: 'the capture kept, no issues-captured: the restart re-queries and re-fetches (the same bytes), records one issues-captured, then the checkpoint-inputs naming its sha, and asks once',
      },
      B5: { status: 'fixture', test: 'intake.capture-reused', crashedIn: ISSUE_CAPTURE },
    },
  },
  {
    // A corpus arc's checkpoint decision and what follows it (src/holistic/bundle.ts `settleDecided`): the amendments and
    // issue outcomes, each crash point after one of their facts, at the first, third and sixth.
    row: CORPUS_AMENDMENT,
    test: 'test/intake.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'each fact is one journal append; journal.append B1 covers a torn or short one' },
      B2: { status: 'excluded', why: 'no intent: the facts are written from the decided output, which the decision\'s own rows (BUNDLE_ACTIVATE, REVISION_COMMIT) settle' },
      B3: { status: 'excluded', why: 'nothing is acted between the facts beyond their appends' },
      B4: {
        status: 'crash',
        labels: ['amendment.after-decided'],
        recovery: 'the decision durable and some of its amendments and outcomes written: the next run settles it from the consumed output (never asked again), writing each missing corpus-amendment (by source) and issue-intake (by job and issue) once, the issue finding once',
      },
      B5: { status: 'excluded', why: 'the settlement is idempotent per source and (job, issue): settling again writes nothing' },
    },
  },
  {
    // `roadmap brief --ack` (src/commands/brief.ts), a CLI process crashed at each label and run again (or a plain `brief`
    // after it), over two chained corpus arcs' refs.
    row: BRIEF_ACK,
    test: 'test/brief.test.ts',
    cells: {
      B1: { status: 'excluded', why: 'the pending marker is published write-once by link (exclusivePublish): it is there whole or not at all, and before it nothing is written' },
      B2: {
        status: 'crash',
        labels: ['brief.ack.after-pending'],
        recovery: 'the pending marker durable, nothing enqueued: the next brief, brief --ack or start finishes it from its bytes alone, enqueueing each item\'s ack under its deterministic id and committing the marker; the rerun reports the same commands',
      },
      B3: { status: 'excluded', why: 'each ack command is one write-once publish; a crash between two is the B4 rerun\'s case (a command file with its own bytes counts as enqueued)' },
      B4: {
        status: 'crash',
        labels: ['brief.ack.after-enqueue'],
        recovery: 'every ack enqueued, the marker still pending: the rerun finds each command file with its own bytes (enqueues nothing again) and commits the marker; each command once',
      },
      B5: { status: 'excluded', why: 'the committed marker is the ack\'s last write; a rerun of a committed id reports its commands and writes nothing' },
    },
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
