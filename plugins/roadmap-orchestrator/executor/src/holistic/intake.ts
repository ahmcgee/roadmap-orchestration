// Checkpoint issue intake (M4a; plan "Forge" executor intake, OR-L6, LR-d, OR-L7, R9, R21, R31, H13, H17, K11).
//
// The capture (`captureCheckpointIssues`, ISSUE_CAPTURE), in a corpus arc, before a checkpoint's `checkpoint-inputs`:
//   1. A capture already recorded for the job the next `checkpoint-inputs` opens (a crash after its fact) is used as is.
//   2. An open `issue-policy-untrusted` item: the checkpoint waits uncaptured (no query) and admission is held arc-wide
//      (src/schedule/scheduler.ts) until it is acknowledged.
//   3. The repo identity is resolved once (`gh repo view`, H13) and the GraphQL policy queried for it. Untrusted
//      (`trusted`, OR-L6): one blocking `issue-policy-untrusted` item (never a second while one is open), nothing fetched,
//      no checkpoint-inputs: never a skip, no checkpoint runs without its issues (R31). Its acknowledgement releases the
//      hold, and the next capture queries the policy again.
//   4. Trusted: the open intake issues fetched (src/forge/issues.ts), kept as `inputs/<sha>.issues.json` (in the snapshot
//      closure, K11), then `issues-captured{job, sha256, repo, filtered}`; the checkpoint-inputs names that sha.
//   A forge failure (`GhError`) is non-fatal (R21): the checkpoint-inputs records `issues: unavailable{reason}`.
// An `architecture-doc` arc captures nothing (its checkpoint-inputs carries no `issues`, read as none), and neither does
// an owner-approved enactment, which makes no call.
//
// The prompt (`issuesInputOf`) gets the kept capture's issues, each body already `<pasted_content>`-wrapped: trusted
// content the checkpoint may act on like any evidence (LR-d, OR-L7).
//
// The outcomes (`intakeReasons`, then `settleIntake`): the output's `issueIntake` names every captured issue exactly once
// and nothing else; an `acted` outcome acts only through ops of the same output (`ops`, each index one of its ops: a
// checkpoint never acts on `units` or `rules`, H17, R29); an `amendment` names active pinned rules. Any breach makes the
// decision invalid. After an applied or no-op decision, each outcome becomes, keyed `(job, issue)` with `job` the
// checkpoint whose capture it covers: a finding opened (lens `issue`, P2 or P3, merged into an active one of its key), an
// amendment (`source: issue{job, issue}`), or the outcome itself, then one `issue-intake` fact. Idempotent: a crash after
// the decision is finished from the consumed output (ISSUE_INTAKE, crash label `amendment.after-decided`).
//
// Issue reuse (M4a rev 3, H5, F27, R65; `issueReuse`): when the latest checkpoint decided before this one's capture
// (applied or no-op) captured issues and recorded their outcomes, and the grounds those outcomes rest on are unchanged
// (the obligations, the ledger and the pin), each issue whose captured content is byte-equal to that checkpoint's keeps
// its outcome there: the prompt lists only the changed and new issues (`issuesUnchangedSince` names that checkpoint), the
// output may omit the unchanged ones, and `settleIntake` carries their outcomes forward (an `acted` one as `none`: the ops
// it names were that output's).
import { crashPoint } from '../core/crash.ts';
import type { CheckpointIssues } from '../core/events.ts';
import { canonicalJson } from '../core/json.ts';
import { type IssueId, type JobId, type NeedsUserId, type Sha256Hex } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import type { CorpusPin } from '../corpus/types.ts';
import { GhError, resolveRepo } from '../forge/gh.ts';
import { captureBytes, fetchIssueCapture } from '../forge/issues.ts';
import { queryPolicy } from '../forge/policy.ts';
import { trusted } from '../forge/trust.ts';
import { type IssueCapture, type IssueIntakeOutcome, parseIssueCapture } from '../forge/types.ts';
import { ISSUES_INPUT, inputPath, keepInput, keptInput } from '../input/inforce.ts';
import { raiseNeedsUser, readNeedsUser } from '../needsuser.ts';
import type { CheckpointIssuesInput } from '../prompts/inputs.ts';
import type { CheckpointOutput } from '../prompts/schemas.ts';
import { appendAmendment, ruleReasons } from './amendments.ts';
import type { Captured, CheckpointContext } from './bundle.ts';
import { issueFindingDraft, openFinding } from './findings.ts';

/** The open `issue-policy-untrusted` item, or null (at most one is ever open). */
export function openPolicyItem(view: JournalView, runDir: AbsPath): NeedsUserId | null {
  return view.needsUser().find((n) => n.ack === null && readNeedsUser(runDir, n.id)?.reason === 'issue-policy-untrusted')?.id ?? null;
}

/** What a checkpoint's capture gave: its `checkpoint-inputs.issues`, or the open untrusted-policy item it waits on. */
export type CaptureResult = Readonly<{ kind: 'issues'; issues: CheckpointIssues }> | Readonly<{ kind: 'held'; needsUser: NeedsUserId }>;

/** Steps 1–4 of the header, for the job the next `checkpoint-inputs` opens. */
export function captureCheckpointIssues(ctx: CheckpointContext): CaptureResult {
  const view = ctx.journal.view;
  const job = view.nextJobId('ckpt');
  const recorded = view.holistic().captures.find((c) => c.job === job);
  if (recorded !== undefined) return { kind: 'issues', issues: { type: 'captured', sha256: recorded.sha256 } };
  const open = openPolicyItem(view, ctx.runDir);
  if (open !== null) return { kind: 'held', needsUser: open };
  let capture: IssueCapture;
  try {
    const repo = resolveRepo(ctx.repo);
    const trust = trusted(queryPolicy(ctx.repo, repo));
    if (trust.kind === 'untrusted') {
      const { visibility, policy } = trust.untrusted;
      const needsUser = raiseNeedsUser(ctx.journal, ctx.runDir, {
        blocking: true,
        subject: { type: 'arc' },
        reason: 'issue-policy-untrusted',
        summary: `The issue policy of ${repo.host}/${repo.owner}/${repo.name} is untrusted (visibility ${visibility}, issue creation ${policy}): anyone may open an issue the checkpoint would read. `
          + 'No issue was read; the checkpoint waits and no unit is admitted until this is acknowledged.',
        recommendation: 'Restrict issue creation to collaborators or disable issues on the repository, then acknowledge this item: the next checkpoint queries the policy again (and raises this again while it is still untrusted).',
        options: [],
        evidence: [],
      }, { type: 'arc' });
      return { kind: 'held', needsUser };
    }
    capture = fetchIssueCapture(ctx.repo, repo, trust);
  } catch (error) {
    if (error instanceof GhError) return { kind: 'issues', issues: { type: 'unavailable', reason: error.message } };
    throw error;
  }
  const sha256 = keepInput(ctx.runDir, Buffer.from(captureBytes(capture), 'utf8'), ISSUES_INPUT);
  crashPoint('issues.after-keep');
  ctx.journal.fact({ kind: 'issues-captured', job, sha256, repo: capture.repo, filtered: capture.filtered });
  return { kind: 'issues', issues: { type: 'captured', sha256 } };
}

/** The kept capture `sha256` names. */
function keptCapture(runDir: AbsPath, sha256: Sha256Hex): IssueCapture {
  const bytes = keptInput(runDir, sha256, ISSUES_INPUT);
  if (bytes === null) throw new Error(`a checkpoint names issues ${sha256}, but ${inputPath(runDir, sha256, ISSUES_INPUT)} is not kept`);
  return parseIssueCapture(JSON.parse(bytes.toString('utf8')));
}

/** The issues a capture holds (none when it is absent or unavailable). */
function capturedIds(runDir: AbsPath, s: Captured): readonly IssueId[] {
  return s.issues?.type === 'captured' ? keptCapture(runDir, s.issues.sha256).issues.map((i) => i.id) : [];
}

/** H5: the checkpoint whose outcomes the unchanged issues keep, and each such issue with its outcome there. */
export type IssueReuse = Readonly<{ since: JobId; unchanged: ReadonlyMap<IssueId, IssueIntakeOutcome> }>;

/** The issue reuse of the checkpoint that captured `s` (see the header), or null when none of its issues is reused. */
export function issueReuse(view: JournalView, runDir: AbsPath, s: Captured): IssueReuse | null {
  if (s.issues?.type !== 'captured') return null;
  const fold = view.holistic();
  const prev = fold.checkpoints.filter((c) => c.inputs.seq < s.seq && c.decided !== null).at(-1);
  if (prev === undefined || (prev.decided!.kind !== 'applied' && prev.decided!.kind !== 'no-op') || prev.inputs.issues?.type !== 'captured') return null;
  const was = prev.inputs;
  if (was.vector.obligationsSha256 !== s.vector.obligationsSha256 || was.vector.ledgerSha256 !== s.vector.ledgerSha256 || was.corpusSha256 !== s.corpusSha256) return null;
  const before = new Map(keptCapture(runDir, prev.inputs.issues.sha256).issues.map((i) => [i.id, canonicalJson(i)]));
  const outcomes = new Map(fold.intake.filter((x) => x.job === was.job).map((x) => [x.issue, x.outcome]));
  const unchanged = new Map(keptCapture(runDir, s.issues.sha256).issues.flatMap((i) => {
    const outcome = outcomes.get(i.id);
    return before.get(i.id) === canonicalJson(i) && outcome !== undefined ? [[i.id, outcome] as const] : [];
  }));
  return unchanged.size === 0 ? null : { since: was.job, unchanged };
}

/**
 * The prompt's issues: the kept capture's (without the reused ones, H5), the reason it is unavailable, or none (an arc or
 * job without a capture).
 */
export function issuesInputOf(runDir: AbsPath, s: Captured, reuse: IssueReuse | null): CheckpointIssuesInput {
  if (s.issues === undefined) return { type: 'captured', issues: [] };
  if (s.issues.type === 'unavailable') return { type: 'unavailable', reason: s.issues.reason };
  return { type: 'captured', issues: keptCapture(runDir, s.issues.sha256).issues.filter((i) => reuse?.unchanged.has(i.id) !== true) };
}

/**
 * Why the output's `issueIntake` is invalid against the capture `s` it was decided on (see the header), or empty. A
 * reused issue (`reuse`) may go without an outcome.
 */
export function intakeReasons(runDir: AbsPath, s: Captured, pin: CorpusPin | null, output: CheckpointOutput, reuse: IssueReuse | null): readonly string[] {
  const captured = capturedIds(runDir, s);
  const known = new Set<string>(captured);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { issue, outcome } of output.issueIntake) {
    if (!known.has(issue)) out.push(`issueIntake names ${issue}, which this checkpoint did not capture`);
    if (seen.has(issue)) out.push(`issueIntake gives ${issue} more than one outcome`);
    seen.add(issue);
    if (outcome.type === 'acted') {
      if (outcome.on.type !== 'ops') out.push(`issueIntake acts on ${issue} through ${outcome.on.type}: a checkpoint acts only through its own ops`);
      else for (const i of outcome.on.indexes) if (i >= output.ops.length) out.push(`issueIntake acts on ${issue} through op index ${i}, which this decision does not have (${output.ops.length} ops)`);
    }
    if (outcome.type === 'amendment') out.push(...ruleReasons(pin, outcome.rules, `issueIntake of ${issue}`));
  }
  for (const id of captured) if (!seen.has(id) && reuse?.unchanged.has(id) !== true) out.push(`issueIntake gives ${id} no outcome`);
  return out;
}

/**
 * Records each outcome of `output.issueIntake` not yet recorded for `(job, issue)` (see the header), then each reused
 * issue the output gave none, carried from `reuse.since`; `job` is the checkpoint whose capture the output covers. The
 * output was validated (`intakeReasons`) when it was decided.
 */
export function settleIntake(journal: Journal, job: JobId, output: CheckpointOutput, reuse: IssueReuse | null): void {
  const given = new Set<string>(output.issueIntake.map((x) => x.issue));
  for (const [issue, was] of reuse?.unchanged ?? []) {
    if (given.has(issue) || journal.view.holistic().intake.some((x) => x.job === job && x.issue === issue)) continue;
    const outcome: IssueIntakeOutcome = was.type === 'acted' ? { type: 'none', reason: `unchanged since ${reuse!.since}, which acted on it through its ops` } : was;
    journal.fact({ kind: 'issue-intake', job, issue, outcome });
    crashPoint('amendment.after-decided');
  }
  for (const { issue, outcome } of output.issueIntake) {
    if (journal.view.holistic().intake.some((x) => x.job === job && x.issue === issue)) continue;
    let recorded: IssueIntakeOutcome;
    switch (outcome.type) {
      case 'finding': {
        const opened = openFinding(journal, issueFindingDraft({ issue, job, severity: outcome.severity, claim: outcome.claim, cause: outcome.cause }));
        recorded = { type: 'finding', finding: opened.kind === 'suppressed' ? opened.by : opened.id };
        break;
      }
      case 'amendment':
        recorded = {
          type: 'amendment',
          amendment: appendAmendment(journal, { source: { type: 'issue', job, issue }, rules: outcome.rules, proposal: outcome.proposal, why: `${issue}, read by ${job}`, evidence: [issue] }),
        };
        break;
      case 'acted':
        if (outcome.on.type !== 'ops') throw new Error(`${job} acted on ${issue} through ${outcome.on.type}, which its validation refuses`);
        recorded = { type: 'acted', on: outcome.on };
        break;
      case 'none':
        recorded = { type: 'none', reason: outcome.reason };
        break;
    }
    journal.fact({ kind: 'issue-intake', job, issue, outcome: recorded });
    crashPoint('amendment.after-decided');
  }
}
