// Fake `gh`, run through the PATH shim in shim.ts (`writeGhShim`):
//   node gh-entry.ts --store /abs/gh-store.json <gh's own argv...>
// A stateful forge in one JSON file (gh-store.ts). It answers exactly the calls the executor's forge layer makes, in the
// shapes the real `gh` prints, and fails loudly (exit 99, the mismatch on stderr) on anything else, so a call the
// fake does not know is a test failure rather than a silent success:
//   gh repo view [<owner/name>] --json owner,name,url[,nameWithOwner]
//   gh pr list|view|create|edit|close
// Every call is appended to gh-calls.jsonl beside the store with the hostname, owner and name it carried. A call that
// names its repository (`-R`) names the store's, or it finds nothing, as on GitHub.
// Calls are expected one at a time (a test drives them sequentially); a mutation is a read-modify-write of the store.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type GhCallRecord, type GhMutation, type GhPull, type GhStore, appendCall, nextSeq, readStore, writeStore } from './gh-store.ts';

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
  };
  json(Object.fromEntries(fields.map((f) => [f, f in known ? known[f] : unknown(`repo view field ${f}`)])));
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
    const p = parseFlags(rest, [...PR_COMMON, '--base', '-B', '--head', '-H', '--title', '-t', '--body', '-b', '--body-file', '-F'], ['--draft']);
    pullRepo(p);
    touched.kind = 'pr-create';
    createPull(p);
    return;
  }
  if (sub === 'edit') {
    const p = parseFlags(rest, [...PR_COMMON, '--base', '-B', '--title', '-t', '--body', '-b', '--body-file', '-F'], []);
    pullRepo(p);
    touched.kind = 'pr-edit';
    editPull(p);
    return;
  }
  if (sub === 'close') {
    const p = parseFlags(rest, [...PR_COMMON, '--comment', '-c'], ['--delete-branch', '-d']);
    pullRepo(p);
    touched.kind = 'pr-close';
    closePull(p);
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
  const number = store.nextNumber;
  const url = `${repoUrl()}/pull/${number}`;
  const pull: GhPull = { number, title, body, state: 'OPEN', url, baseRefName: base, headRefName: head, mergeCommit: null, isDraft: p.flags.has('--draft') };
  save({ nextNumber: number + 1, pulls: [...store.pulls, pull] });
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
  save({ pulls: store.pulls.map((x) => (x.number === found.number ? next : x)) });
  if (Object.keys(fields).length > 0) mutate({ kind: 'pr-edit', number: found.number, fields });
  out(`${found.url}\n`);
}

/** `gh pr close <n> [--comment <text>]`: an open PR closed unmerged, as on GitHub. */
function closePull(p: Parsed): void {
  const found = findPull(p.positional[0]);
  if (found.state !== 'OPEN') throw new GhFail(`Pull request #${found.number} (${found.title}) is already ${found.state === 'MERGED' ? 'merged' : 'closed'}`);
  save({ pulls: store.pulls.map((x) => (x.number === found.number ? { ...x, state: 'CLOSED' as const } : x)) });
  mutate({ kind: 'pr-close', number: found.number, comment: one(p, '--comment') ?? one(p, '-c') ?? null });
  out(`✓ Closed pull request ${found.url}\n`);
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
      case 'pr':
        pr(argv.slice(1));
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
