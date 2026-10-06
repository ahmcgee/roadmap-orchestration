// The recovery trace each executor crash point allows (test/oracle.ts `Trace`), shared by the whole-pipeline
// matrix (test/pipeline-matrix.test.ts) and the concurrent one (test/concurrent-matrix.test.ts).
import type { Event } from '../../src/core/events.ts';
import { type Trace, UNCRASHED } from '../oracle.ts';

export const R = (...recoveredBy: Trace['recoveredBy']): Trace => ({ recoveredBy, required: true, tailDiscarded: false });
export const NONE: Trace = UNCRASHED;

/**
 * The op kinds' recovery from their B2 state (intent durable, act not begun): a spawn has no launch.json
 * yet, so it is closed lost (reconciled); an open transition or command is closed as it stands; every other
 * op is redone from its recorded inputs.
 */
export const FROM_B2: Readonly<Record<string, Trace['recoveredBy']>> = {
  'proc.spawn': ['reconciled'], 'resource.transition': ['reconciled'], 'command.apply': ['reconciled'],
  // A start's revision (no docs step) is finished from its kept payload by the next start (settlePlan): reconciled.
  'revision.commit': ['reconciled'],
};

/** Every executor label but the journal's: what recovery does to the op it cut short. */
export const LABEL_TRACE: Readonly<Record<string, Trace>> = {
  'spawn.after-intent': R('reconciled'),
  'launch.after-launch-json': R('reconciled'),
  // The runner lives on: adopted, or once it has exited its exit.json is adapted again.
  'launch.after-spawn': R('adopted', 'redone'),
  'spawn.after-runner-exit': R('redone'),
  'spawn.after-result': R('reconciled'),
  'spawn.after-usage': R('reconciled'),
  'spawn.after-done': NONE,
  'resource.after-intent': R('reconciled'),
  'resource.after-done': NONE,
  'worktree.create.act-start': R('redone'),
  'worktree.add.inside': R('reconciled'),
  'worktree.remove.act-start': R('redone'),
  'worktree.remove.inside': R('reconciled'),
  'evidence.act-start': R('redone'),
  'evidence.after-partial-copy': R('redone'),
  'evidence.act-end': R('reconciled'),
  'salvage.act-start': R('redone'),
  'salvage.after-copy-out': R('redone'),
  'salvage.after-commit-tree': R('redone'),
  'salvage.after-cas': R('reconciled'),
  'salvage.after-read-tree': R('reconciled'),
  'salvage.act-end': R('reconciled'),
  'mergein.act-start': R('redone'),
  'mergein.after-merge': R('reconciled'),
  'mergein.act-end': R('reconciled'),
  'candidate.act-start': R('redone'),
  'candidate.after-commit-tree': R('redone'),
  'candidate.act-end': R('reconciled'),
  'ff.act-start': R('redone'),
  'ff.act-end': R('reconciled'),
  'snapshot.act-start': R('redone'),
  'snapshot.after-commit-tree': R('redone'),
  'snapshot.act-end': R('reconciled'),
  'spec.patch.before-write': R('redone'),
  'spec.patch.after-write': R('reconciled'),
  // The start kept plan.json's bytes but wrote no plan-applied fact: the respawn records revision 1.
  'plan.apply.after-inputs': NONE,
  // The start's revision.commit is open (its plan-applied written or not): finished from its kept payload, reconciled.
  'revision.commit.after-intent': R('reconciled'),
  'revision.commit.after-fact': R('reconciled'),
  'unit.after-stage': NONE,
  // M4a rev 3 N1: a lane-reused fact written, the next lane not begun; a clean census, the series-certified fact unwritten
  // (the series is then uncertified: never reused, its lanes run again); a red class's red.json written, its rerun not begun
  // (the stage runs again as a new attempt, reading the class back). Every op is closed: nothing for recovery to reconcile.
  'lanes.after-reused': NONE,
  'lanes.after-census-before-certified': NONE,
  'redlane.after-class': NONE,
  'recover.before-op': NONE,
  'recover.after-op': NONE,
  // M3 B7: arc-completed written, its terminal snapshot not: nothing open; the restart publishes the snapshot.
  'complete.after-fact': NONE,
  // M3 (the holistic row): a digest item's raise, as the needs-user row's.
  'needsuser.raise.before-publish': R('redone'),
  'needsuser.raise.after-publish': R('reconciled'),
  // A job's facts: nothing open; the job resumes from them.
  'latch.after-fact': NONE,
  'audit.after-started': NONE,
  'audit.after-lens': NONE,
  'audit.before-ended': NONE,
  'audit.after-ended': NONE,
  'checkpoint.after-inputs': NONE,
  'checkpoint.after-call': NONE,
  'bundle.after-applied': NONE,
  'bundle.after-decided': NONE,
  // M4a (a corpus arc): the pack review's facts, a checkpoint's kept issue capture, its amendment settlement.
  'packreview.after-started': NONE,
  'packreview.after-call': NONE,
  'packreview.after-ended': NONE,
  'issues.after-keep': NONE,
  'amendment.after-decided': NONE,
  'debt.after-approval': NONE,
  // M4a rev 3 N3 (a corpus arc's unit stages): the frontier dispatch pinned (in-session unwritten); the assessment read (the
  // implementing call not begun); the witness lane files published (no build call); the witness check's series certified
  // (its verdict unwritten); the smoke's patch kept, its mutant applied, its mutant lanes witnessed, its smoke-ran written.
  // Each op is closed: the stage runs again as a new attempt, consuming what is recorded.
  'plancheck.after-pin-in-session': NONE,
  'build.after-assess': NONE,
  'witnesscheck.after-lane-files': NONE,
  'witnesscheck.after-witnessed': NONE,
  'smoke.after-patch-kept': NONE,
  'smoke.after-apply': NONE,
  'smoke.after-witnessed': NONE,
  'smoke.after-ran-before-outcome': NONE,
  // The smoke's mutant.apply, as the mutant.apply row's: intent durable or its checkout made (redone), the patched tree made
  // (reconciled), the apply done with its lanes not run (nothing open).
  'mutant.act-start': R('redone'),
  'mutant.after-worktree': R('redone'),
  'mutant.act-end': R('reconciled'),
  'mutant.after-done': NONE,
  // M4a rev 3 N2: a decision record's conversion amendment (or an overrun's debt item) written: settled again from the record.
  'bundle.after-conversion-amendment': NONE,
  'bundle.after-overrun-debt': NONE,
  // The close-out's docs.commit: open (redone, then the unpublished holder abandoned) or done.
  'docs.act-start': R('redone'),
  'docs.after-commit-tree': R('redone'),
  'docs.act-end': R('reconciled'),
  'closeout.after-ff': NONE,
  'closeout.before-published': NONE,
  'docs.after-snapshot': NONE,
  // A batch's chained candidate made, the batch not published: nothing open; the batch is abandoned and runs again.
  'batch.after-candidate': NONE,
};

/**
 * Where a batch job's op recovers otherwise than a unit's (M3 B2): a batch ff's intent durable with its CAS not acted
 * closes unpublished at T (reconciled), for a batch CAS is never redone; the batch runs again as its next attempt.
 */
export const BATCH_TRACE: Readonly<Record<string, Trace>> = { 'ff.act-start': R('reconciled') };

/**
 * A journal label's trace, from the record the uncrashed run appended at that occurrence (the executor is
 * the only appender, so its n-th append is seq n). Before the write (or torn in it) the record is lost: a
 * lost done leaves its op open with its act complete (reconciled), a lost usage fact leaves its spawn open
 * (reconciled), a lost intent or other fact leaves nothing open. After the fsync the record is durable: an
 * intent is its op's B2 state, anything else leaves nothing open. M3: a fact a `revision.commit` writes inside
 * its op (its plan-applied, its divergences; `inRevision`: that op was open when the record was appended) leaves
 * the revision open, lost or durable: recovery finishes it from its kept payload (reconciled).
 */
export function appendTrace(label: string, e: Event, inRevision = false): Trace {
  const tailDiscarded = label === 'log.append.after-partial-write';
  const revisionFact = e.type === 'fact' && inRevision;
  if (label === 'log.append.after-fsync') {
    if (revisionFact) return R('reconciled');
    if (e.type !== 'intent') return NONE;
    return R(...(FROM_B2[e.kind] ?? ['redone']));
  }
  const lostOpen = e.type === 'done' || revisionFact || (e.type === 'fact' && (e.fact.kind === 'meter' || e.fact.kind === 'usage-unavailable'));
  return { recoveredBy: lostOpen ? ['reconciled'] : [], required: lostOpen, tailDiscarded };
}

/** Whether a `revision.commit` was open (its intent appended, its done not yet) when `seq` was appended, in `events`. */
export function inRevisionAt(events: readonly Event[], seq: number): boolean {
  const open = new Set<string>();
  for (const e of events) {
    if (e.seq >= seq) break;
    if (e.type === 'intent' && e.kind === 'revision.commit') open.add(e.op);
    if ((e.type === 'done' || e.type === 'abort') && open.has(e.op)) open.delete(e.op);
  }
  return open.size > 0;
}
