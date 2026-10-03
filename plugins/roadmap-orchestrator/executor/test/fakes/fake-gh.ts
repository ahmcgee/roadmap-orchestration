// Fake `gh`, run through the PATH shim in shim.ts (`writeGhShim`):
//   node gh-entry.ts --store /abs/gh-store.json <gh's own argv...>
// A stateful forge in one JSON file (gh-store.ts). It answers exactly the calls the executor's forge layer makes, in the
// shapes the real `gh` prints, and fails loudly (exit 99, the mismatch on stderr) on anything else, so a call the
// fake does not know is a test failure rather than a silent success:
//   gh repo view [<owner/name>] --json owner,name,url[,nameWithOwner]
//   gh api [--hostname H] graphql -f query=... [-f owner=.. -f name=..]   (repository{visibility hasIssuesEnabled issueCreationPolicy})
//   gh api [--hostname H] [--paginate] [-X M] repos/<owner>/<name>/issues[?labels=a,b&state=open&per_page=N&page=N]
//   gh api ... repos/<owner>/<name>/issues/<n>/comments   (GET)
//   gh api ... repos/<owner>/<name>/issues/<n>/labels     (POST -f labels[]=x | DELETE .../labels/<x>)
//   gh pr list|view|create|edit, gh label create, gh issue edit --add-label/--remove-label
// Every call is appended to gh-calls.jsonl beside the store with the hostname, owner and name it carried. A GraphQL or
// REST call names its repository explicitly, so one that carries the wrong owner or name finds nothing, as on GitHub.
// Calls are expected one at a time (a test drives them sequentially); a mutation is a read-modify-write of the store.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type GhCallRecord, type GhIssue, type GhMutation, type GhPull, type GhStore, appendCall, nextSeq, readStore, writeStore } from './gh-store.ts';

/** A failure the real gh would report: its message on stderr and its exit code (1; 99 for what the fake does not know). */
class GhFail extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

const unknown = (what: string): never => {
  throw new GhFail(`fake gh: ${what} is not a call the fake knows`, 99);
};

type Parsed = Readonly<{ flags: ReadonlyMap<string, readonly string[]>; positional: readonly string[] }>;

/** `--flag value`, `--flag=value`, repeated flags kept in order; `valued` names the flags taking a value, `bool` the rest allowed. */
function parseFlags(argv: readonly string[], valued: readonly string[], bool: readonly string[]): Parsed {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  const put = (k: string, v: string): void => void flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('-') || a === '-') {
      positional.push(a);
      continue;
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    if (valued.includes(name)) {
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined) throw new GhFail(`flag needs an argument: ${name}`);
      put(name, value);
    } else if (bool.includes(name)) put(name, '');
    else throw new GhFail(`unknown flag: ${name}`, 99);
  }
  return { flags, positional };
}

const one = (p: Parsed, flag: string): string | undefined => {
  const v = p.flags.get(flag);
  if (v !== undefined && v.length > 1) throw new GhFail(`flag ${flag} given ${v.length} times`);
  return v?.[0];
};
const all = (p: Parsed, ...flags: string[]): readonly string[] => flags.flatMap((f) => p.flags.get(f) ?? []);

let store: GhStore;
let storePath: string;
const touched = { hostname: null as string | null, owner: null as string | null, name: null as string | null, kind: 'none' };
const out = (text: string): void => void process.stdout.write(text);
const json = (v: unknown): void => out(`${JSON.stringify(v)}\n`);
const save = (patch: Partial<GhStore>): void => {
  store = { ...store, ...patch };
  writeStore(storePath, store);
};
let seq = 0;
const mutate = (m: DistributiveOmit<GhMutation, 'call'>): void => save({ mutations: [...store.mutations, { ...m, call: seq } as GhMutation] });
type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;

/** The host the call addresses (`--hostname`, else GH_HOST) must be the store's. */
function checkHost(hostname: string | null): void {
  const host = hostname ?? process.env['GH_HOST'] ?? store.repo.host;
  touched.hostname = hostname;
  if (host !== store.repo.host) throw new GhFail(`none of the git remotes configured for this repository point to a known GitHub host (asked ${host}, the forge is ${store.repo.host})`);
}

/** The repository a call names must be the store's (GitHub: HTTP 404 Not Found). */
function checkRepo(owner: string, name: string): void {
  touched.owner = owner;
  touched.name = name;
  if (owner !== store.repo.owner || name !== store.repo.name) throw new GhFail(`gh: Not Found (HTTP 404): ${owner}/${name}`);
}

const repoUrl = (): string => `https://${store.repo.host}/${store.repo.owner}/${store.repo.name}`;

// ---------------------------------------------------------------------------------------------------

function repoView(argv: readonly string[]): void {
  touched.kind = 'repo-view';
  const p = parseFlags(argv, ['--json', '--jq', '-q'], []);
  if (p.flags.has('--jq') || p.flags.has('-q')) unknown('repo view --jq');
  const fields = (one(p, '--json') ?? unknown('repo view without --json')).split(',');
  checkHost(null);
  const named = p.positional[0];
  if (named !== undefined) {
    const [o, n] = named.split('/');
    checkRepo(o ?? '', n ?? '');
  }
  const known: Record<string, unknown> = {
    owner: { id: 'MDQ6VXNlcjE=', login: store.repo.owner },
    name: store.repo.name,
    url: repoUrl(),
    nameWithOwner: `${store.repo.owner}/${store.repo.name}`,
    isPrivate: store.policy.visibility === 'PRIVATE',
  };
  json(Object.fromEntries(fields.map((f) => [f, f in known ? known[f] : unknown(`repo view field ${f}`)])));
}

function graphql(fields: ReadonlyMap<string, string>): void {
  touched.kind = 'graphql';
  const query = fields.get('query') ?? unknown('graphql without a query');
  const call = /repository\s*\(([^)]*)\)\s*\{([^}]*)\}/.exec(query);
  if (call === null) return unknown(`graphql query ${query}`);
  const arg = (key: string): string => {
    const m = new RegExp(`${key}\\s*:\\s*(\\$\\w+|"[^"]*")`).exec(call[1] as string);
    if (m === null) return unknown(`graphql repository() without ${key}`);
    const v = m[1] as string;
    if (v.startsWith('"')) return v.slice(1, -1);
    return fields.get(v.slice(1)) ?? unknown(`graphql variable ${v} not passed`);
  };
  const [owner, name] = [arg('owner'), arg('name')];
  touched.owner = owner;
  touched.name = name;
  if (owner !== store.repo.owner || name !== store.repo.name) {
    json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: `Could not resolve to a Repository with the name '${owner}/${name}'.` }] });
    throw new GhFail(`gh: Could not resolve to a Repository with the name '${owner}/${name}'.`);
  }
  const selected = (call[2] as string).split(/\s+/).filter((w) => w !== '');
  const known: Record<string, unknown> = { ...store.policy };
  json({ data: { repository: Object.fromEntries(selected.map((f) => [f, f in known ? known[f] : unknown(`graphql repository field ${f}`)])) } });
}

function paged<T>(items: readonly T[], query: URLSearchParams, paginate: boolean): readonly T[] {
  if (paginate) return items;
  const per = Number(query.get('per_page') ?? 30);
  const page = Number(query.get('page') ?? 1);
  return items.slice((page - 1) * per, page * per);
}

function rest(method: string, endpoint: string, fields: ReadonlyMap<string, string>, listFields: ReadonlyMap<string, readonly string[]>, paginate: boolean): void {
  touched.kind = 'rest';
  const [pathPart, queryPart] = endpoint.replace(/^\//, '').split('?') as [string, string | undefined];
  const query = new URLSearchParams(queryPart ?? '');
  const seg = pathPart.split('/');
  if (seg[0] !== 'repos' || seg[1] === undefined || seg[2] === undefined) return unknown(`api endpoint ${endpoint}`);
  checkRepo(seg[1], seg[2]);
  const rest = seg.slice(3);
  if (rest[0] !== 'issues') return unknown(`api endpoint ${endpoint}`);
  if (!store.policy.hasIssuesEnabled && method === 'GET' && rest.length === 1) {
    throw new GhFail('gh: the contents of this repository are disabled: Issues are disabled for this repo (HTTP 410)');
  }
  if (method === 'GET' && rest.length === 1) {
    const wanted = (query.get('labels') ?? '').split(',').filter((l) => l !== '');
    const state = query.get('state') ?? 'open';
    const hits = store.issues.filter((i) => (state === 'all' || i.state === state) && wanted.every((w) => i.labels.some((l) => l.name === w)));
    json(paged(hits, query, paginate));
    return;
  }
  const n = Number(rest[1]);
  const issue = store.issues.find((i) => i.number === n);
  if (!Number.isInteger(n) || issue === undefined) throw new GhFail(`gh: Not Found (HTTP 404): issue ${rest[1]}`);
  if (method === 'GET' && rest[2] === 'comments' && rest.length === 3) {
    json(paged(store.comments[String(n)] ?? [], query, paginate));
    return;
  }
  if (rest[2] !== 'labels') return unknown(`api ${method} ${endpoint}`);
  if (method === 'POST' && rest.length === 3) {
    const names = [...(listFields.get('labels') ?? []), ...(fields.has('labels') ? [fields.get('labels') as string] : [])];
    addLabels(issue, names);
    json((store.issues.find((i) => i.number === n) as GhIssue).labels);
    return;
  }
  if (method === 'DELETE' && rest.length === 4) {
    removeLabels(issue, [decodeURIComponent(rest[3] as string)]);
    json((store.issues.find((i) => i.number === n) as GhIssue).labels);
    return;
  }
  unknown(`api ${method} ${endpoint}`);
}

function addLabels(issue: GhIssue, names: readonly string[]): void {
  const added = names.filter((l) => !issue.labels.some((x) => x.name === l));
  const unknownLabel = added.find((l) => !store.labels.includes(l));
  if (unknownLabel !== undefined) throw new GhFail(`'${unknownLabel}' not found`);
  const next = { ...issue, labels: [...issue.labels, ...added.map((name) => ({ name }))] };
  save({ issues: store.issues.map((i) => (i.number === issue.number ? next : i)) });
  mutate({ kind: 'labels-add', number: issue.number, labels: names });
}

function removeLabels(issue: GhIssue, names: readonly string[]): void {
  const next = { ...issue, labels: issue.labels.filter((l) => !names.includes(l.name)) };
  save({ issues: store.issues.map((i) => (i.number === issue.number ? next : i)) });
  mutate({ kind: 'labels-remove', number: issue.number, labels: names });
}

function api(argv: readonly string[]): void {
  const p = parseFlags(argv, ['--hostname', '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header'], ['--paginate']);
  const endpoint = p.positional[0] ?? unknown('api without an endpoint');
  if (p.positional.length > 1) unknown(`api with extra arguments ${p.positional.slice(1).join(' ')}`);
  touched.kind = endpoint === 'graphql' ? 'graphql' : 'rest';
  const hostname = one(p, '--hostname') ?? null;
  checkHost(hostname);
  const fields = new Map<string, string>();
  const listFields = new Map<string, string[]>();
  for (const kv of all(p, '-f', '--raw-field', '-F', '--field')) {
    const eq = kv.indexOf('=');
    if (eq === -1) throw new GhFail(`field ${kv} must be key=value`);
    const key = kv.slice(0, eq);
    if (key.endsWith('[]')) listFields.set(key.slice(0, -2), [...(listFields.get(key.slice(0, -2)) ?? []), kv.slice(eq + 1)]);
    else fields.set(key, kv.slice(eq + 1));
  }
  const method = (one(p, '-X') ?? one(p, '--method') ?? (endpoint === 'graphql' || fields.size > 0 || listFields.size > 0 ? 'POST' : 'GET')).toUpperCase();
  if (endpoint === 'graphql') graphql(fields);
  else rest(method, endpoint, fields, listFields, p.flags.has('--paginate'));
}

// ---------------------------------------------------------------------------------------------------

const PULL_FIELDS = ['number', 'title', 'body', 'state', 'url', 'baseRefName', 'headRefName', 'mergeCommit', 'isDraft'] as const satisfies readonly (keyof GhPull)[];

const EMPTY_PULL: GhPull = { number: 0, title: '', body: '', state: 'OPEN', url: '', baseRefName: '', headRefName: '', mergeCommit: null, isDraft: false };

function pullJson(pull: GhPull, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => {
    if (!(PULL_FIELDS as readonly string[]).includes(f)) throw new GhFail(`Unknown JSON field: "${f}"`);
    return [f, pull[f as (typeof PULL_FIELDS)[number]]];
  }));
}

/** `gh` reads the repository from `-R` or the cwd's remote; the fake takes the store's unless `-R` names another. */
function pullRepo(p: Parsed): void {
  touched.kind = 'pr';
  checkHost(null);
  const r = one(p, '-R') ?? one(p, '--repo');
  if (r !== undefined) {
    const [o, n] = r.split('/');
    checkRepo(o ?? '', n ?? '');
  } else {
    touched.owner = store.repo.owner;
    touched.name = store.repo.name;
  }
}

function bodyOf(p: Parsed): string | undefined {
  const file = one(p, '--body-file') ?? one(p, '-F');
  const text = one(p, '--body') ?? one(p, '-b');
  if (file !== undefined && text !== undefined) throw new GhFail('specify only one of `--body` or `--body-file`');
  if (file === undefined) return text;
  return file === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(file), 'utf8');
}

const PR_COMMON = ['-R', '--repo'];

function pr(argv: readonly string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'list') {
    const p = parseFlags(rest, [...PR_COMMON, '--head', '-H', '--base', '-B', '--state', '-s', '--json', '--limit', '-L'], []);
    pullRepo(p);
    touched.kind = 'pr-list';
    const state = (one(p, '--state') ?? one(p, '-s') ?? 'open').toLowerCase();
    const head = one(p, '--head') ?? one(p, '-H');
    const base = one(p, '--base') ?? one(p, '-B');
    const fields = (one(p, '--json') ?? unknown('pr list without --json')).split(',');
    pullJson(store.pulls[0] ?? EMPTY_PULL, fields);
    const hits = store.pulls.filter((x) => (state === 'all' || x.state.toLowerCase() === state) && (head === undefined || x.headRefName === head) && (base === undefined || x.baseRefName === base));
    json(hits.map((x) => pullJson(x, fields)));
    return;
  }
  if (sub === 'view') {
    const p = parseFlags(rest, [...PR_COMMON, '--json'], []);
    pullRepo(p);
    touched.kind = 'pr-view';
    const found = findPull(p.positional[0]);
    json(pullJson(found, (one(p, '--json') ?? unknown('pr view without --json')).split(',')));
    return;
  }
  if (sub === 'create') {
    const p = parseFlags(rest, [...PR_COMMON, '--base', '-B', '--head', '-H', '--title', '-t', '--body', '-b', '--body-file', '-F', '--label', '-l'], ['--draft']);
    pullRepo(p);
    touched.kind = 'pr-create';
    createPull(p);
    return;
  }
  if (sub === 'edit') {
    const p = parseFlags(rest, [...PR_COMMON, '--base', '-B', '--title', '-t', '--body', '-b', '--body-file', '-F', '--add-label', '--remove-label'], []);
    pullRepo(p);
    touched.kind = 'pr-edit';
    editPull(p);
    return;
  }
  unknown(`pr ${sub}`);
}

function findPull(ref: string | undefined): GhPull {
  if (ref === undefined) return unknown('pr without a number or branch');
  const found = /^\d+$/.test(ref) ? store.pulls.find((x) => x.number === Number(ref)) : store.pulls.findLast((x) => x.headRefName === ref && x.state === 'OPEN');
  if (found === undefined) throw new GhFail(`no pull requests found for ${/^\d+$/.test(ref) ? `number ${ref}` : `branch "${ref}"`}`);
  return found;
}

function originHas(branch: string): boolean {
  if (store.originPath === null) return true;
  return spawnSync('git', ['-C', store.originPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'ignore' }).status === 0;
}

function createPull(p: Parsed): void {
  const base = one(p, '--base') ?? one(p, '-B') ?? unknown('pr create without --base');
  const head = one(p, '--head') ?? one(p, '-H') ?? unknown('pr create without --head');
  const title = one(p, '--title') ?? one(p, '-t') ?? unknown('pr create without --title');
  const body = bodyOf(p) ?? '';
  for (const b of [base, head]) if (!originHas(b)) throw new GhFail(`pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between (branch ${b} is not on the remote)`);
  if (store.pulls.some((x) => x.state === 'OPEN' && x.headRefName === head && x.baseRefName === base)) {
    throw new GhFail(`a pull request for branch "${head}" into branch "${base}" already exists`);
  }
  const labels = all(p, '--label', '-l').flatMap((l) => l.split(','));
  const missing = labels.find((l) => !store.labels.includes(l));
  if (missing !== undefined) throw new GhFail(`could not add label: '${missing}' not found`);
  const number = store.nextNumber;
  const url = `${repoUrl()}/pull/${number}`;
  const pull: GhPull = { number, title, body, state: 'OPEN', url, baseRefName: base, headRefName: head, mergeCommit: null, isDraft: p.flags.has('--draft') };
  const entry: GhIssue = {
    number, title, body, state: 'open', labels: labels.map((name) => ({ name })), user: { login: store.repo.owner }, author_association: 'OWNER', pull_request: { url: `${repoUrl()}/pull/${number}` },
  };
  save({ nextNumber: number + 1, pulls: [...store.pulls, pull], issues: [...store.issues, entry] });
  mutate({ kind: 'pr-create', number, base, head, title });
  out(`${url}\n`);
}

function editPull(p: Parsed): void {
  const found = findPull(p.positional[0]);
  const fields: Record<string, string> = {};
  const base = one(p, '--base') ?? one(p, '-B');
  const title = one(p, '--title') ?? one(p, '-t');
  const body = bodyOf(p);
  if (base !== undefined) fields['base'] = base;
  if (title !== undefined) fields['title'] = title;
  if (body !== undefined) fields['body'] = body;
  if (base !== undefined && !originHas(base)) throw new GhFail(`base branch "${base}" not found`);
  const next: GhPull = { ...found, ...(base === undefined ? {} : { baseRefName: base }), ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }) };
  const issues = store.issues.map((i) => (i.number === found.number ? { ...i, ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }) } : i));
  save({ pulls: store.pulls.map((x) => (x.number === found.number ? next : x)), issues });
  if (Object.keys(fields).length > 0) mutate({ kind: 'pr-edit', number: found.number, fields });
  for (const [flag, op] of [['--add-label', addLabels], ['--remove-label', removeLabels]] as const) {
    const names = all(p, flag).flatMap((l) => l.split(','));
    if (names.length > 0) op(store.issues.find((i) => i.number === found.number) as GhIssue, names);
  }
  out(`${found.url}\n`);
}

function label(argv: readonly string[]): void {
  if (argv[0] !== 'create') return unknown(`label ${argv[0]}`);
  const p = parseFlags(argv.slice(1), [...PR_COMMON, '--color', '-c', '--description', '-d'], ['--force', '-f']);
  pullRepo(p);
  touched.kind = 'label-create';
  const name = p.positional[0] ?? unknown('label create without a name');
  if (store.labels.includes(name)) {
    if (!p.flags.has('--force') && !p.flags.has('-f')) throw new GhFail(`label with name "${name}" already exists; use \`--force\` to update its color and description`);
    return;
  }
  save({ labels: [...store.labels, name] });
  mutate({ kind: 'label-create', name });
}

function issue(argv: readonly string[]): void {
  if (argv[0] !== 'edit') return unknown(`issue ${argv[0]}`);
  const p = parseFlags(argv.slice(1), [...PR_COMMON, '--add-label', '--remove-label'], []);
  pullRepo(p);
  touched.kind = 'issue-edit';
  const n = Number(p.positional[0]);
  const found = store.issues.find((i) => i.number === n);
  if (found === undefined) throw new GhFail(`issue ${p.positional[0]} not found`);
  const add = all(p, '--add-label').flatMap((l) => l.split(','));
  const remove = all(p, '--remove-label').flatMap((l) => l.split(','));
  if (add.length > 0) addLabels(found, add);
  if (remove.length > 0) removeLabels(store.issues.find((i) => i.number === n) as GhIssue, remove);
  out(`${repoUrl()}/issues/${n}\n`);
}

// ---------------------------------------------------------------------------------------------------

/** The fake's main (test/fakes/gh-entry.ts, which the shim execs). */
export function main(): void {
  const raw = process.argv.slice(2);
  if (raw[0] !== '--store' || raw[1] === undefined) throw new Error(`fake gh: usage: --store <path> <gh argv...>; got ${JSON.stringify(raw)}`);
  storePath = raw[1];
  const argv = raw.slice(2);
  store = readStore(storePath);
  seq = nextSeq(storePath);
  let status = 0;
  try {
    switch (argv[0]) {
      case 'repo':
        if (argv[1] !== 'view') unknown(`repo ${argv[1]}`);
        repoView(argv.slice(2));
        break;
      case 'api':
        api(argv.slice(1));
        break;
      case 'pr':
        pr(argv.slice(1));
        break;
      case 'label':
        label(argv.slice(1));
        break;
      case 'issue':
        issue(argv.slice(1));
        break;
      default:
        unknown(`gh ${argv.join(' ')}`);
    }
  } catch (error) {
    if (!(error instanceof GhFail)) throw error;
    status = error.code;
    process.stderr.write(`${error.message}\n`);
  }
  const record: GhCallRecord = { seq, argv, cwd: process.cwd(), ...touched, status };
  appendCall(storePath, record);
  process.exit(status);
}
