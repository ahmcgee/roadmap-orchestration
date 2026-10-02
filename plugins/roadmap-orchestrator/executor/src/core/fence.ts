// The revision fence (A19, G2, H2; DESIGN-1.0.md §2.6 "Revision fence"; M3 step A2). One fence per arc serialises
// every revision (`apply`, `rule`, `reverse`, checkpoint bundles, the executor's machine spec patches) from its final
// synchronous validation, through its docs `ff`, to its `plan-applied`, so two revisions validated against one base
// cannot both commit. It has two halves:
//
//   in-process  a FIFO lock per journal: a writer holds it across its awaited docs publication (`holdFence`)
//   durable     the open `revision.commit` intent (key `revision`, at most one): what a crash leaves; recovery
//               finishes or aborts it before anything else reads or revises (src/recover/revision.ts)
//
// Every capture of revision-sensitive inputs (`judgment-inputs`, `audit-started`, `checkpoint-inputs`, a bundle's
// final staleness check) takes the fence briefly: `captureUnderFence` waits for it, runs the capture synchronously
// (read, then write its fact, nothing awaited), and releases it. So no reader sees the window between a docs `ff`
// and its `plan-applied`, where new contract blobs sit beside an old ledger or plan.
import type { Journal } from './interfaces.ts';

type Lock = { tail: Promise<void>; held: boolean };
const locks = new WeakMap<Journal, Lock>();

const lockOf = (journal: Journal): Lock => {
  let lock = locks.get(journal);
  if (lock === undefined) {
    lock = { tail: Promise.resolve(), held: false };
    locks.set(journal, lock);
  }
  return lock;
};

/** A held fence: `release` exactly once. */
export type FenceHold = Readonly<{ release: () => void }>;

/** The open `revision.commit` while the in-process fence is free: only a crash leaves one, and recovery settles it first. */
function assertNoOrphan(journal: Journal): void {
  const open = journal.view.openIntents().find((i) => i.kind === 'revision.commit');
  if (open !== undefined) throw new Error(`revision.commit ${open.op} is open with no revision in progress: recovery settles it before any revision or capture`);
}

/** Waits for the fence and holds it; the caller releases it once its revision committed or was refused. */
export async function holdFence(journal: Journal): Promise<FenceHold> {
  const lock = lockOf(journal);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = lock.tail;
  lock.tail = before.then(() => mine);
  await before;
  try {
    assertNoOrphan(journal);
  } catch (error) {
    release();
    throw error;
  }
  lock.held = true;
  let released = false;
  return {
    release: () => {
      if (released) throw new Error('the revision fence was released twice');
      released = true;
      lock.held = false;
      release();
    },
  };
}

/** Whether a revision holds the fence now (in process, or durably). */
export function fenceHeld(journal: Journal): boolean {
  return lockOf(journal).held || journal.view.openIntents().some((i) => i.kind === 'revision.commit');
}

/**
 * Takes the fence briefly (H2): waits for any revision to commit, runs `capture` synchronously (it reads the
 * inputs in force and writes its capture fact, awaiting nothing), and releases it.
 */
export async function captureUnderFence<T>(journal: Journal, capture: () => T): Promise<T> {
  const hold = await holdFence(journal);
  try {
    const out = capture();
    if (out instanceof Promise) throw new Error('a capture under the revision fence is synchronous');
    return out;
  } finally {
    hold.release();
  }
}
