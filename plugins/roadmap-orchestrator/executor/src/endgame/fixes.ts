// The endgame's recorded fixes as the findings store reads them (dev.82, WS-5): each `endgame-fix` of every episode, landed
// once a landing of its episode (`endgame-landed`) holds its commit. src/holistic/findings.ts `targetOf` then moves a finding
// the fix names to fixed-on-branch (owner the fix's command), and to resolved once landed.
import type { JournalView } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { isAncestor } from '../git/ff.ts';
import type { EndgameFixProgress } from '../holistic/findings.ts';

export function endgameFixes(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; repo: AbsPath }>): readonly EndgameFixProgress[] {
  return ctx.journal.view.holistic().endgame.flatMap((e) => e.fixes.map((x) => ({
    command: x.command, closes: x.closes, seq: x.seq, landed: e.landings.some((l) => isAncestor(ctx.repo, x.commit, l.head)),
  })));
}
