// argv: <scenario.json>. Runs one op through its journal in a child process, so crash tests can SIGKILL it
// at a crashPoint (ROADMAP_TEST_CRASH). Scenarios:
//   {op:'salvage', runDir, worktree, branch, message}
//   {op:'create', runDir, repo, path, checkout}
//   {op:'remove', runDir, repo, path, evidence}   (evidence: the done evidence.snapshot op)
//   {op:'evidence', runDir, source, globs, dest}
import { readFileSync } from 'node:fs';
import type { WorktreeCheckout } from '../../src/core/events.ts';
import { opIdOf } from '../../src/core/ids.ts';
import { capturedEvidence, evidenceSnapshotOp } from '../../src/git/evidence.ts';
import { planSalvage, salvageCommitOp } from '../../src/git/salvage.ts';
import { worktreeCreateOp, worktreeRemoveOp } from '../../src/git/worktree.ts';
import { absPath, refName, repoPattern } from '../../src/core/values.ts';
import { IDENTITY, openArc, rules, runOp } from './git-common.ts';

type Raw = Record<string, unknown>;
const path = process.argv[2];
if (path === undefined) throw new Error('usage: git-child <scenario.json>');
const s = JSON.parse(readFileSync(path, 'utf8')) as Raw;
const str = (k: string): string => {
  const v = s[k];
  if (typeof v !== 'string') throw new Error(`git-child: scenario.${k} must be a string`);
  return v;
};

const runDir = str('runDir');
const journal = openArc(runDir);
switch (s['op']) {
  case 'salvage': {
    const request = { worktree: absPath(str('worktree')), branch: refName(str('branch')), identity: IDENTITY, message: str('message') };
    const decision = planSalvage(rules(runDir), request);
    if (decision.kind !== 'commit') throw new Error('git-child: nothing to salvage');
    await runOp(journal, salvageCommitOp(rules(runDir)), 'salvage:unit', decision.plan);
    break;
  }
  case 'create':
    await runOp(journal, worktreeCreateOp(absPath(str('repo'))), 'worktree:unit', { path: absPath(str('path')), checkout: s['checkout'] as WorktreeCheckout });
    break;
  case 'remove': {
    const captured = capturedEvidence(journal.view, opIdOf(str('evidence')));
    await runOp(journal, worktreeRemoveOp(absPath(str('repo'))), 'worktree:unit', { path: absPath(str('path')), evidence: captured });
    break;
  }
  case 'evidence':
    await runOp(journal, evidenceSnapshotOp, 'evidence:unit', { source: absPath(str('source')), globs: (s['globs'] as string[]).map((g) => repoPattern(g)), dest: absPath(str('dest')) });
    break;
  default:
    throw new Error(`git-child: unknown op ${JSON.stringify(s['op'])}`);
}
journal.close();
