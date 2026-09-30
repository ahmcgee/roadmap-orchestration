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
  'recover.before-op': NONE,
  'recover.after-op': NONE,
  // M3 B7: arc-completed written, its terminal snapshot not: nothing open; the restart publishes the snapshot.
  'complete.after-fact': NONE,
};

/**
 * A journal label's trace, from the record the uncrashed run appended at that occurrence (the executor is
 * the only appender, so its n-th append is seq n). Before the write (or torn in it) the record is lost: a
 * lost done leaves its op open with its act complete (reconciled), a lost usage fact leaves its spawn open
 * (reconciled), a lost intent or other fact leaves nothing open. After the fsync the record is durable: an
 * intent is its op's B2 state, anything else leaves nothing open.
 */
export function appendTrace(label: string, e: Event): Trace {
  const tailDiscarded = label === 'log.append.after-partial-write';
  if (label === 'log.append.after-fsync') {
    if (e.type !== 'intent') return NONE;
    return R(...(FROM_B2[e.kind] ?? ['redone']));
  }
  const lostOpen = e.type === 'done' || (e.type === 'fact' && (e.fact.kind === 'meter' || e.fact.kind === 'usage-unavailable'));
  return { recoveredBy: lostOpen ? ['reconciled'] : [], required: lostOpen, tailDiscarded };
}
