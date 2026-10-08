// The forge records (M4a, frozen in step 0a; SCHEMAS.md "M4a"): the repo identity, the issue policy, the canonical issue
// capture, and the one closed shape of an issue's outcome. Types and readers only; A3 owns the behaviour
// (src/forge/{gh,policy,issues,trust,push,pr}.ts), C3 the checkpoint intake, C1 the Phase-0 coverage rows.
import {
  type AmendmentId, type FindingId, type IssueContentRef, type IssueId, type RuleId, type UnitId, amendmentId, findingId, issueContentRef, issueId,
  answerIds, idList, issueNumber, issueOfContent, ruleId, unitId,
} from '../core/ids.ts';
import { type Read, SchemaError, answerSet, arrayOf, bool, literal, nat, object, oneOf, sortedBy, str, tagged, text } from '../core/validate.ts';
import { FINDING_SEVERITIES, type FindingSeverity } from '../holistic/types.ts';

/** Who the forge says a repo is: resolved once per capture (`gh repo view`, H13) and passed to every later call. */
export type RepoIdentity = Readonly<{ host: string; owner: string; name: string }>;
export const repoIdentity: Read<RepoIdentity> = object((f) => ({ host: f.get('host', str), owner: f.get('owner', str), name: f.get('name', str) }));

export const REPO_VISIBILITIES = ['PUBLIC', 'PRIVATE', 'INTERNAL'] as const;
export type RepoVisibility = (typeof REPO_VISIBILITIES)[number];
export const ISSUE_CREATION_POLICIES = ['ALL', 'COLLABORATORS_ONLY'] as const;
export type IssueCreationPolicy = (typeof ISSUE_CREATION_POLICIES)[number];

/** The GraphQL `repository{visibility hasIssuesEnabled issueCreationPolicy}` answer; `trusted` (A3's trust.ts) judges it (OR-L6). */
export type IssuePolicy = Readonly<{ visibility: RepoVisibility; hasIssuesEnabled: boolean; issueCreationPolicy: IssueCreationPolicy }>;
export const issuePolicy: Read<IssuePolicy> = object((f) => ({
  visibility: f.get('visibility', oneOf(REPO_VISIBILITIES)),
  hasIssuesEnabled: f.get('hasIssuesEnabled', bool),
  issueCreationPolicy: f.get('issueCreationPolicy', oneOf(ISSUE_CREATION_POLICIES)),
}));

/** GitHub's `author_association`. A comment is kept when OWNER, MEMBER or COLLABORATOR, or written by a kept issue's author. */
export const AUTHOR_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE'] as const;
export type AuthorAssociation = (typeof AUTHOR_ASSOCIATIONS)[number];

/** The intake labels (REST `issues?labels=…&state=open`). */
export const ISSUE_LABELS = ['roadmap:bug', 'roadmap:feedback'] as const;

// ---------------------------------------------------------------------------------------------------
// The canonical issue capture (`roadmap/issues-capture-m4`; one schema for Phase 0 and checkpoints, H8, H13, R30).
// Canonical JSON, no clock field, so a re-run over unchanged issues is byte-identical. Kept as `inputs/<sha>.issues.json`.

export const ISSUES_CAPTURE_SCHEMA = 'roadmap/issues-capture-m4';

/** One kept comment; `body` is wrapped by the `<pasted_content>` sanitiser (src/prompts/inputs.ts `pasted`). */
export type CapturedComment = Readonly<{ id: IssueContentRef; association: AuthorAssociation; body: string }>;
/** One open issue carrying an intake label; `labels` ascending; `comments` ascending by comment id. */
export type CapturedIssue = Readonly<{ id: IssueId; title: string; labels: readonly string[]; body: string; comments: readonly CapturedComment[] }>;

export type IssueCapture = Readonly<{
  schema: typeof ISSUES_CAPTURE_SCHEMA;
  repo: RepoIdentity;
  policy: IssuePolicy;
  /** Ascending by issue number; empty when issues are disabled. */
  issues: readonly CapturedIssue[];
  /** What the filters dropped: comments by author association, pull-request entries before classification (K25). */
  filtered: Readonly<{ comments: number; pullRequests: number }>;
}>;

const commentNumber = (ref: IssueContentRef): number => Number(/\/c-(\d+)$/.exec(ref)?.[1] ?? 0);

const capturedIssue: Read<CapturedIssue> = object((f) => {
  const out: CapturedIssue = {
    id: f.get('id', (v, p) => issueId(v, p)),
    title: f.get('title', str),
    labels: f.get('labels', sortedBy(str, (l) => l)),
    body: f.get('body', text),
    comments: f.get('comments', arrayOf(object((g) => ({
      id: g.get('id', (v, p) => issueContentRef(v, p)), association: g.get('association', oneOf(AUTHOR_ASSOCIATIONS)), body: g.get('body', text),
    })))),
  };
  out.comments.forEach((c, i) => {
    if (commentNumber(c.id) === 0 || issueOfContent(c.id) !== out.id) throw new SchemaError(`${f.path}.comments[${i}].id`, `a comment of ${out.id} (${out.id}/c-<id>)`, c.id);
    if (i > 0 && !(commentNumber(out.comments[i - 1]!.id) < commentNumber(c.id))) throw new SchemaError(`${f.path}.comments[${i}]`, 'comments strictly ascending by id', c.id);
  });
  return out;
});

export const issueCapture: Read<IssueCapture> = object((f) => {
  const out: IssueCapture = {
    schema: f.get('schema', literal(ISSUES_CAPTURE_SCHEMA)),
    repo: f.get('repo', repoIdentity),
    policy: f.get('policy', issuePolicy),
    issues: f.get('issues', arrayOf(capturedIssue)),
    filtered: f.get('filtered', object((g) => ({ comments: g.get('comments', nat), pullRequests: g.get('pullRequests', nat) }))),
  };
  out.issues.forEach((issue, i) => {
    if (i > 0 && !(issueNumber(out.issues[i - 1]!.id) < issueNumber(issue.id))) throw new SchemaError(`${f.path}.issues[${i}]`, 'issues strictly ascending by number', issue.id);
  });
  if (!out.policy.hasIssuesEnabled && out.issues.length > 0) throw new SchemaError(`${f.path}.issues`, 'none while issues are disabled', out.issues.length);
  return out;
});

export function parseIssueCapture(value: unknown): IssueCapture {
  return issueCapture(value, 'issueCapture');
}

// ---------------------------------------------------------------------------------------------------
// Outcomes (R9, H17, R29): every captured IssueId gets exactly one. `acted` is one closed shape everywhere; Phase 0 may
// use only `units` or `rules`, a checkpoint only `ops` (op indexes exist only in its own output).

export type ActedOn =
  | Readonly<{ type: 'ops'; indexes: readonly number[] }>
  | Readonly<{ type: 'units'; ids: readonly UnitId[] }>
  | Readonly<{ type: 'rules'; ids: readonly RuleId[] }>;
export type ActedOnKind = ActedOn['type'];

const indexes = sortedBy(nat, (n) => String(n).padStart(16, '0'), { nonEmpty: true });
const unitR: Read<UnitId> = (v, p) => unitId(v, p);
const ruleR: Read<RuleId> = (v, p) => ruleId(v, p);
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A judgment answer's lists: unique in any order, returned ascending (`answerSet`), so the model's order never invalidates it. */
const ANSWER_LISTS = {
  indexes: answerSet(nat, String, (a, b) => a - b, { nonEmpty: true }),
  units: answerSet(unitR, (u) => u, byCodeUnit, { nonEmpty: true }),
  rules: answerIds(ruleR, { nonEmpty: true }),
};
/** A record's lists: strictly ascending as written (rule ids in canonical order). */
const RECORD_LISTS = {
  indexes,
  units: sortedBy(unitR, (u) => u, { nonEmpty: true }),
  rules: idList(ruleR, { nonEmpty: true, legacyStringOrder: true }),
};

/**
 * An `acted{on}` limited to `kinds` (Phase 0: units or rules; a checkpoint: ops); each list non-empty. A record's lists
 * are ascending as written; a judgment answer's (`from: 'answer'`) may come in any order and are returned ascending.
 */
export function actedOn(kinds: readonly ActedOnKind[], from: 'record' | 'answer' = 'record'): Read<ActedOn> {
  const lists = from === 'answer' ? ANSWER_LISTS : RECORD_LISTS;
  const all: { readonly [K in ActedOnKind]: Read<ActedOn> } = {
    ops: object((f): ActedOn => ({ type: f.get('type', literal('ops')), indexes: f.get('indexes', lists.indexes) })),
    units: object((f): ActedOn => ({ type: f.get('type', literal('units')), ids: f.get('ids', lists.units) })),
    rules: object((f): ActedOn => ({ type: f.get('type', literal('rules')), ids: f.get('ids', lists.rules) })),
  };
  return tagged('type', Object.fromEntries(kinds.map((k) => [k, all[k]])) as { readonly [K in ActedOnKind]: Read<ActedOn> });
}

/** The `issue-intake` fact's outcome (C3 writes it from a checkpoint's `issueIntake`). */
export type IssueIntakeOutcome =
  | Readonly<{ type: 'finding'; finding: FindingId }>
  | Readonly<{ type: 'amendment'; amendment: AmendmentId }>
  | Readonly<{ type: 'acted'; on: Extract<ActedOn, { type: 'ops' }> }>
  | Readonly<{ type: 'none'; reason: string }>;

export const issueIntakeOutcome: Read<IssueIntakeOutcome> = tagged('type', {
  finding: object((f): IssueIntakeOutcome => ({ type: f.get('type', literal('finding')), finding: f.get('finding', (v, p) => findingId(v, p)) })),
  amendment: object((f): IssueIntakeOutcome => ({
    type: f.get('type', literal('amendment')),
    amendment: f.get('amendment', (v, p) => amendmentId(v, p)),
  })),
  acted: object((f): IssueIntakeOutcome => ({ type: f.get('type', literal('acted')), on: f.get('on', actedOn(['ops'])) as Extract<ActedOn, { type: 'ops' }> })),
  none: object((f): IssueIntakeOutcome => ({ type: f.get('type', literal('none')), reason: f.get('reason', str) })),
});

/** A Phase-0 intake outcome: a finding to open, an amendment to propose, an act on plan units or corpus rules, or none. */
export type Phase0IntakeOutcome =
  | Readonly<{ type: 'finding'; severity: FindingSeverity; claim: string }>
  | Readonly<{ type: 'amendment'; rules: readonly RuleId[]; proposal: string }>
  | Readonly<{ type: 'acted'; on: Exclude<ActedOn, { type: 'ops' }> }>
  | Readonly<{ type: 'none'; reason: string }>;

const rulesList = idList((v, p) => ruleId(v, p), { legacyStringOrder: true });
export const phase0IntakeOutcome: Read<Phase0IntakeOutcome> = tagged('type', {
  finding: object((f): Phase0IntakeOutcome => ({ type: f.get('type', literal('finding')), severity: f.get('severity', oneOf(FINDING_SEVERITIES)), claim: f.get('claim', str) })),
  amendment: object((f): Phase0IntakeOutcome => ({ type: f.get('type', literal('amendment')), rules: f.get('rules', rulesList), proposal: f.get('proposal', str) })),
  acted: object((f): Phase0IntakeOutcome => ({ type: f.get('type', literal('acted')), on: f.get('on', actedOn(['units', 'rules'])) as Exclude<ActedOn, { type: 'ops' }> })),
  none: object((f): Phase0IntakeOutcome => ({ type: f.get('type', literal('none')), reason: f.get('reason', str) })),
});

/** `issues-captured.repo` and a capture's identity compared field by field. */
export const sameRepo = (a: RepoIdentity, b: RepoIdentity): boolean => a.host === b.host && a.owner === b.owner && a.name === b.name;
