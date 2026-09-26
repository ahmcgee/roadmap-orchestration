// argv: <scenario.json>. Runs one step-8b op through its journal in a child process, so crash tests can
// SIGKILL it at a crashPoint (ROADMAP_TEST_CRASH). Scenarios are `Scenario8b` (git8b-common.ts):
//   mergein: merge the integration tip into unit-a in `worktree`
//   candidate: candidate.merge of `unitCommit` onto the integration tip
//   ff: integration.ff of the done candidate.merge op `candidate` in the same run dir
//   snapshot: snapshot.publish of the run dir at its current high-water mark, with one spec
import { readFileSync } from 'node:fs';
import type { IntentOf } from '../../src/core/events.ts';
import { opIdOf, sha } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { planCandidate } from '../../src/git/candidate.ts';
import { planFf } from '../../src/git/ff.ts';
import { ARC, IDENTITY, openArc, runOp } from './git-common.ts';
import { INTEGRATION, MERGEIN_MESSAGE, type Scenario8b, UNIT, UNIT_BRANCH, candidateRequest, fingerprintFor } from './git8b-common.ts';
import { candidateMergeOp, integrationFfOp, mergeinOp, snapshotPublishOp } from '../../src/recover/ops.ts';

const path = process.argv[2];
if (path === undefined) throw new Error('usage: git8b-child <scenario.json>');
const s = JSON.parse(readFileSync(path, 'utf8')) as Scenario8b;
const repo = absPath(s.repo);
const journal = openArc(s.runDir);
switch (s.op) {
  case 'mergein':
    await runOp(journal, mergeinOp(repo), 'mergein:unit-a', {
      worktree: absPath(s.worktree), branch: UNIT_BRANCH, integration: INTEGRATION, identity: IDENTITY, message: MERGEIN_MESSAGE,
    });
    break;
  case 'candidate': {
    const decision = planCandidate(repo, candidateRequest(absPath(s.worktree), sha(s.unitCommit)));
    if (decision.kind !== 'merge') throw new Error(`git8b-child: candidate decision ${decision.kind}`);
    await runOp(journal, candidateMergeOp(repo), 'candidate:unit-a', decision.plan);
    break;
  }
  case 'ff': {
    const candidate = journal.view.latestIntent(opIdOf(s.candidate)) as IntentOf<'candidate.merge'>;
    const decision = planFf(repo, { integration: INTEGRATION, candidate, fingerprint: fingerprintFor(candidate.expect.unitCommit) });
    if (decision.kind !== 'ff') throw new Error(`git8b-child: ff decision ${decision.kind}`);
    await runOp(journal, integrationFfOp(repo, () => true), 'ff:main', decision);
    break;
  }
  case 'snapshot':
    await runOp(journal, snapshotPublishOp(repo), 'snapshot:arc', {
      arc: ARC, runDir: absPath(s.runDir), highWater: journal.view.highWater(), specs: [{ unit: UNIT, path: absPath(s.spec) }],
      identity: IDENTITY, message: `roadmap: snapshot ${ARC}\n`,
    });
    break;
}
journal.close();
