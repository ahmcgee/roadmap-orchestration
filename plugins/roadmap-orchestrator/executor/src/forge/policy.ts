// The issue policy query (OR-L6, H13): one GraphQL call naming the resolved repository explicitly; `trusted`
// (trust.ts) judges the answer.
import type { AbsPath } from '../core/values.ts';
import { ghApi } from './gh.ts';
import { type IssuePolicy, type RepoIdentity, issuePolicy } from './types.ts';

export const POLICY_QUERY = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){visibility hasIssuesEnabled issueCreationPolicy}}';

export function queryPolicy(cwd: AbsPath, repo: RepoIdentity): IssuePolicy {
  const answer = ghApi(cwd, repo, ['graphql', '-f', `query=${POLICY_QUERY}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`]) as { data?: { repository?: unknown } };
  return issuePolicy(answer.data?.repository, `graphql ${repo.host}/${repo.owner}/${repo.name}.repository`);
}
