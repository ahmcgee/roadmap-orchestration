// The CI ref (dev.81, A3): `origin/<integrationBranch>` is what CI is testing or has tested, so it advances only when
// the previous pushed head has settled. The local integration branch moves freely; each push is a PR push, and pushing
// every ff cancelled the running pipeline before it reported (the atlas2 field blocker).
//
// Derived from the journal at read time; nothing persists the pending state, so a restart recomputes it and an arc
// started before dev.81 adopts it (its last push counts from its own `at`, settled by the timer at worst). A pushed head
// `H` (the last `integration-push` with `result: 'pushed'`) is settled when any of:
//   - an `external-witness` at `H` was recorded after the push (the CI result itself is the signal);
//   - `ci.settleMin` minutes have passed since the push (the backstop for a pipeline that dies without a witness, and
//     for an arc with no external lanes);
//   - the root submitted `roadmap push` after the push (`push-requested`: the manual lever).
// Nothing pushed yet (or only failures, or no origin): nothing is under test, so the next head pushes at once.
import type { Sha } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type IsoTime, isoTimeOf } from '../core/values.ts';

export type CiRef = Readonly<{
  /** The head CI is testing or has tested: the last successful push (`pushed` or `up-to-date`); null when none. */
  ciHead: Sha | null;
  /** The last `pushed` head whose settlement gates the next push; null when nothing was pushed. */
  pushed: Sha | null;
  /** Whether the next push may go: nothing pushed, or the pushed head settled. */
  settled: boolean;
  /** When the timer settles the pushed head; null when settled. */
  settleBy: IsoTime | null;
}>;

export function ciRefOf(view: JournalView, settleMin: number, now: number): CiRef {
  const pushes = view.integrationPushes();
  const ciHead = pushes.findLast((p) => p.fact.result === 'pushed' || p.fact.result === 'up-to-date')?.fact.head ?? null;
  const last = pushes.findLast((p) => p.fact.result === 'pushed');
  if (last === undefined) return { ciHead, pushed: null, settled: true, settleBy: null };
  const due = Date.parse(last.at) + settleMin * 60_000;
  const settled = due <= now || view.ciSettlers().some((s) => s.seq > last.seq && (s.fact.kind === 'push-requested' || s.fact.head === last.fact.head));
  return { ciHead, pushed: last.fact.head, settled, settleBy: settled ? null : isoTimeOf(new Date(due)) };
}
