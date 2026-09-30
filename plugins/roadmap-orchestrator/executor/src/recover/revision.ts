// A revision's activation and its recovery (G1, A2, A19; DESIGN-1.0.md §2.6 "Revisions and activation"; M3 step A2).
//
//   commitRevision   under the fence (src/core/fence.ts): the payload kept, `revision.commit` naming it, the docs
//                    publication when the payload has one, `plan-applied` appended from the payload exactly, then
//                    its divergences, done `applied`. A refused publication aborts the commit (nothing is in force).
//   reconciler       recovery of an open `revision.commit`: the docs `ff` done or no docs step → append from the
//                    payload (done); otherwise abort, and the source re-evaluates (an `apply`'s command op
//                    re-runs it, a bundle re-queues, a start re-reads its files). It never reclassifies.
//
// The docs publication is src/pipeline/publish.ts (step A4), reached through `DocsPublisher`. Which publication
// carried a revision is read from the log alone: the docs `integration.ff` begun after its `revision.commit`
// (one revision commits at a time, and a close-out publication never runs inside one).
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, Parent, PlanAppliedFact, RevisionPayload } from '../core/events.ts';
import type { OpId } from '../core/ids.ts';
import type { Journal, JournalView, Reconciler } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { type Publication, appendRevision, beginRevision, closeRevision, keptPayload } from '../input/inforce.ts';

/** A docs publication's end: its `ff` published (the pub and the new head), or refused before its `ff` (the reason). */
export type DocsOutcome = Readonly<{ kind: 'published'; publication: Publication }> | Readonly<{ kind: 'refused'; reason: string }>;
/** Publishes a revision's rendered `.roadmap/` files and contract ops (A4, src/pipeline/publish.ts) inside its open commit. */
export type DocsPublisher = (payload: RevisionPayload, commit: IntentOf<'revision.commit'>) => Promise<DocsOutcome>;

/** Interim (M3 A2): no docs publication until step A4 (BACKLOG "Scaffolding to delete"); a revision needing one is refused. */
export const DOCS_NOT_YET: DocsPublisher = async () => ({ kind: 'refused', reason: 'a revision that changes the in-tree documents needs the docs publication: not implemented (step A4)' });

export type RevisionCommitContext = Readonly<{ journal: Journal; runDir: AbsPath; docs: DocsPublisher }>;

export type Committed = Readonly<{ kind: 'applied'; fact: PlanAppliedFact }> | Readonly<{ kind: 'refused'; reason: string }>;

/**
 * Activates an evaluated payload (G1). The caller holds the fence from its final synchronous evaluation until this
 * returns. `parent`: the command, bundle job or arc the commit acts for.
 */
export async function commitRevision(ctx: RevisionCommitContext, payload: RevisionPayload, parent: Parent): Promise<Committed> {
  const commit = beginRevision(ctx.journal, ctx.runDir, payload, parent);
  let publication: Publication | null = null;
  if (payload.publication !== null) {
    const docs = await ctx.docs(payload, commit);
    if (docs.kind === 'refused') {
      ctx.journal.abort(commit.op, 'precondition', docs.reason);
      return { kind: 'refused', reason: docs.reason };
    }
    publication = docs.publication;
    crashPoint('revision.commit.after-docs');
  }
  const fact = appendRevision(ctx.journal, commit, payload, publication);
  closeRevision(ctx.journal, commit.op, false);
  return { kind: 'applied', fact };
}

/** Where the docs publication of an open commit stands, from the log: its `ff` published, still open, or not published. */
export type DocsState = Readonly<{ kind: 'published'; publication: Publication }> | Readonly<{ kind: 'open'; op: OpId }> | Readonly<{ kind: 'not-published' }>;

export function docsStateOf(view: JournalView, commit: IntentOf<'revision.commit'>): DocsState {
  const docs = view.opsOf('integration.ff').find((i) => seqOf(i.op) > seqOf(commit.op) && i.expect.subject?.type === 'docs');
  if (docs === undefined) return { kind: 'not-published' };
  const done = view.doneOf(docs.op);
  if (done === null) return view.openIntents().some((i) => i.op === docs.op) ? { kind: 'open', op: docs.op } : { kind: 'not-published' };
  if (done.kind !== 'integration.ff' || done.outcome.kind !== 'published' || docs.expect.subject?.type !== 'docs') return { kind: 'not-published' };
  return { kind: 'published', publication: { pub: docs.expect.subject.pub, head: docs.expect.new } };
}

/** An op id's seq (`<arc>/<seq>`): ops are numbered in log order. */
const seqOf = (op: OpId): number => Number(op.slice(op.lastIndexOf('/') + 1));

/**
 * The reconciler of `revision.commit`: with no docs step, or its `ff` published, it appends from the payload (only
 * what is missing) and is done; otherwise it aborts, and the source re-evaluates. It runs after the git ops' own
 * recovery, so a docs `ff` is closed by then; one still open is a bug.
 */
export function revisionReconciler(runDir: AbsPath, journal: Journal): Reconciler<'revision.commit'> {
  return async (intent, view) => {
    const payload = keptPayload(runDir, intent.expect.payloadSha256);
    let publication: Publication | null = null;
    if (intent.expect.docs) {
      const docs = docsStateOf(view, intent);
      if (docs.kind === 'open') throw new Error(`revision.commit ${intent.op}: its docs ff ${docs.op} is still open; the git ops recover first`);
      if (docs.kind === 'not-published') return { kind: 'abort', detail: `its docs publication did not publish; the source (${JSON.stringify(intent.expect.source)}) re-evaluates` };
      publication = docs.publication;
    }
    appendRevision(journal, intent, payload, publication);
    return { kind: 'done', outcome: { kind: 'applied' } };
  };
}
