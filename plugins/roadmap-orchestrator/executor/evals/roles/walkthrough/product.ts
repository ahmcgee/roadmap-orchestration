// The `ledgerly` fixture product: the base product under ledgerly/ (real files, with `{{hook}}` places) made concrete for
// one trial. Data hooks take the seed's data (currency, teams, month); slot hooks take the families' contributions
// (families.ts), every other slot hook its clean default. A hook alone on its line replaces the whole line (an empty text
// removes it). Every hook a file holds must be resolved and every contribution must land on a hook its file holds: both
// fail loud, so the product never carries a hook mark or a stray change. A contribution may instead be an edit of the
// resolved file (`Edit`, applied in slot order once every hook is resolved), its `find` occurring exactly once, so a
// family in another form than its dev one can change any place, not only a hook. `gitignore` becomes `.gitignore`.
//
// Seed data: the team `platform` and two more from a pool, budgets, alert shares, a currency, a month and the one before
// it, and each month's entries (samples/<month>.csv), drawn so that this month one team is within its limit, one near it
// and one over it.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Rng, rng } from '../gen/prng.ts';
import { FAMILIES, type Contribution, type FamilyTable } from './families.ts';
import type { Slot } from './slots.ts';

export const BASE_DIR = fileURLToPath(new URL('./ledgerly/', import.meta.url));

export type FileMap = ReadonlyMap<string, string>;

/** A literal replacement in one file: `find` must occur exactly once when it is applied. */
export type Edit = Readonly<{ file: string; find: string; replace: string }>;

/** Applies `edits` in order; each `find` occurs exactly once in its file at that point, so a drift fails loud. */
export function applyEdits(files: FileMap, edits: readonly Edit[]): FileMap {
  const out = new Map(files);
  for (const e of edits) {
    const text = out.get(e.file);
    if (text === undefined) throw new Error(`an edit of ${e.file}, which the product does not hold`);
    const at = text.indexOf(e.find);
    if (at < 0 || text.indexOf(e.find, at + 1) >= 0) throw new Error(`${e.file}: ${at < 0 ? 'no' : 'more than one'} occurrence of ${JSON.stringify(e.find)}`);
    out.set(e.file, text.slice(0, at) + e.replace + text.slice(at + e.find.length));
  }
  return out;
}

export type Team = Readonly<{ id: string; name: string; budget: number; alertAt: number }>;
export type Entry = Readonly<{ team: string; month: string; vendor: string; amount: number; note: string }>;
export type SeedData = Readonly<{ currency: string; teams: readonly Team[]; month: string; prev: string; entries: readonly Entry[] }>;

const TEAM_POOL = [['data', 'Data'], ['payments', 'Payments'], ['search', 'Search'], ['identity', 'Identity'], ['mobile', 'Mobile'], ['growth', 'Growth'], ['observability', 'Observability']] as const;
const VENDORS = [
  ['Hetzner', 'build runners'], ['Datadog', 'metrics and APM'], ['GitHub', 'Actions minutes'], ['Sentry', 'error tracking'],
  ['Fastly', 'CDN egress'], ['PagerDuty', 'on-call seats'], ['Cloudflare', 'DNS and WAF'], ['Grafana Labs', 'hosted logs'],
  ['Snyk', 'dependency scanning'], ['Linear', 'issue tracker seats'], ['Tailscale', 'team plan'], ['AWS', 'S3 and EC2'],
] as const;
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'] as const;

const prevMonth = (m: string): string => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
};

/** Splits `total` minor units into `k` positive whole-cent parts with random proportions. */
function split(g: Rng, total: number, k: number): number[] {
  const weights = Array.from({ length: k }, () => 1 + g.next() * 3);
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.max(100, Math.round((total * w) / sum)));
  parts[parts.length - 1] = Math.max(100, total - parts.slice(0, -1).reduce((a, b) => a + b, 0));
  return parts;
}

function monthEntries(g: Rng, teams: readonly Team[], month: string, shares: readonly number[]): Entry[] {
  return teams.flatMap((team, i) => {
    const total = Math.round(team.budget * shares[i]!);
    const k = g.range(2, 4);
    const vendors = g.shuffle(VENDORS).slice(0, k);
    return split(g, total, k).map((amount, j) => ({ team: team.id, month, vendor: vendors[j]![0], amount, note: vendors[j]![1] }));
  });
}

export function seedData(seed: string): SeedData {
  const g = rng(`data:${seed}`);
  const others = g.shuffle(TEAM_POOL).slice(0, 2);
  const team = (id: string, name: string, lo: number, hi: number): Team => ({ id, name, budget: g.range(lo, hi) * 100 * 100, alertAt: g.pick([0.75, 0.8, 0.85]) });
  const teams = [team('platform', 'Platform', 36, 60), ...others.map(([id, name]) => team(id, name, 15, 40))];
  const month = g.pick(MONTHS);
  const prev = prevMonth(month);
  // This month: one team within (45-65%), one near (just past its alert share), one over (105-115%).
  const states = g.shuffle(['within', 'near', 'over'] as const);
  const share = (s: 'within' | 'near' | 'over', t: Team): number =>
    s === 'within' ? 0.45 + g.next() * 0.2 : s === 'near' ? t.alertAt + 0.03 + g.next() * (0.95 - t.alertAt - 0.03) : 1.05 + g.next() * 0.1;
  const entries = [
    ...monthEntries(g, teams, prev, teams.map(() => 0.4 + g.next() * 0.3)),
    ...monthEntries(g, teams, month, teams.map((t, i) => share(states[i]!, t))),
  ];
  return { currency: g.pick(['EUR', 'USD', 'GBP']), teams, month, prev, entries };
}

const csvOf = (entries: readonly Entry[]): string =>
  `team,month,vendor,amount,note\n${entries.map((e) => `${e.team},${e.month},${e.vendor},${(e.amount / 100).toFixed(2)},${e.note}`).join('\n')}\n`;

function teamsConf(teams: readonly Team[]): string {
  return teams.map((t) => `[team.${t.id}]\nname = ${t.name}\nbudget = ${t.budget / 100}\nalert_at = ${t.alertAt}`).join('\n\n');
}

/** The base product's files (path to text), `gitignore` already named `.gitignore`. */
export function baseFiles(): FileMap {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, d.name);
      if (d.isDirectory()) walk(abs);
      else out.set(relative(BASE_DIR, abs), readFileSync(abs, 'utf8'));
    }
  };
  walk(BASE_DIR);
  const ignore = out.get('gitignore');
  if (ignore === undefined) throw new Error('the base product has no gitignore');
  out.delete('gitignore');
  out.set('.gitignore', ignore);
  return out;
}

/** Slot hooks and their clean defaults, per file. A family's contribution replaces a default (or, for `css`, appends). */
const PAGE_HOOKS = { layout: '', lead: '', 'after-lead': '', card: '', script: '' } as const;
const DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'web/pages/entries.js': { ...PAGE_HOOKS, primary: '' },
  'web/pages/entry-new.js': { ...PAGE_HOOKS, primary: '', 'shown-errors': 'errors', action: '/entries' },
  'web/pages/entry.js': { ...PAGE_HOOKS, primary: '' },
  'web/pages/budgets.js': { ...PAGE_HOOKS },
  'web/pages/budget.js': { ...PAGE_HOOKS, primary: '' },
  'web/pages/budget-edit.js': { ...PAGE_HOOKS, primary: '', 'shown-errors': 'errors', action: '/budgets/${team.id}/limit' },
  'web/pages/statements.js': { ...PAGE_HOOKS, primary: '' },
  'web/pages/statement.js': { ...PAGE_HOOKS, primary: '', 'print-link': '/statements/${month}/print' },
  'web/static/app.css': { css: '' },
  'server/main.js': { routes: '' },
  'src/commands/import.js': { 'progress-start': '', 'progress-checked': '', 'input-error': '    throw e;' },
  'src/commands/report.js': { 'progress-start': '', 'progress-checked': '', 'input-error': '    throw e;' },
  'README.md': { 'qs-init': '   node bin/ledgerly.js init --data .ledgerly', 'qs-report': '   node bin/ledgerly.js report --team {{team}} --month {{month}} --data .ledgerly' },
};
/** Hooks with no default: their family (always plant or twin) writes them. */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  'bin/ledgerly.js': ['dispatch'], 'src/config.js': ['unknown-key'], 'server/api.js': ['validation-response'], 'ci/run.js': ['failure-report'],
};

const HOOK = /\{\{([a-z][a-z-]*)\}\}/g;

/** Resolves every hook of `text` from `values`; a hook alone on its line replaces the line. */
function resolve(path: string, text: string, values: Readonly<Record<string, string>>): string {
  const lookup = (name: string): string => {
    const v = values[name];
    if (v === undefined) throw new Error(`${path}: hook {{${name}}} has no value`);
    return v;
  };
  return text.split('\n').flatMap((line) => {
    const alone = /^\s*\{\{([a-z][a-z-]*)\}\}\s*$/.exec(line);
    if (alone !== null) {
      const v = lookup(alone[1]!);
      return v === '' ? [] : v.split('\n');
    }
    return [line.replace(HOOK, (_, name: string) => lookup(name))];
  }).join('\n');
}

/** The product of a trial: the base files with the seed's data and every slot's contributions (`families`: their forms). */
export function productFiles(data: SeedData, slots: readonly Slot[], families: FamilyTable = FAMILIES): FileMap {
  const all: readonly Contribution[] = slots.flatMap((s) => families[s.family].apply(s.state, s.at));
  const contributions = all.filter((c) => 'hook' in c);
  const edits = all.filter((c) => 'find' in c);
  const slotValues = new Map<string, Record<string, string>>(Object.entries(DEFAULTS).map(([f, h]) => [f, { ...h }]));
  const set = new Map<string, Set<string>>();
  for (const c of contributions) {
    const values = slotValues.get(c.file) ?? {};
    const known = Object.hasOwn(values, c.hook) || (REQUIRED[c.file] ?? []).includes(c.hook);
    if (!known) throw new Error(`a contribution to ${c.file} {{${c.hook}}}, a hook that file does not hold`);
    const done = set.get(c.file) ?? new Set<string>();
    if (c.hook === 'css') values[c.hook] = values[c.hook] === '' ? c.text : `${values[c.hook]}\n${c.text}`;
    else if (done.has(c.hook)) throw new Error(`two contributions to ${c.file} {{${c.hook}}}`);
    else values[c.hook] = c.text;
    done.add(c.hook);
    set.set(c.file, done);
    slotValues.set(c.file, values);
  }
  for (const [file, hooks] of Object.entries(REQUIRED)) {
    for (const h of hooks) if (!set.get(file)?.has(h)) throw new Error(`${file} {{${h}}}: no family wrote it`);
  }
  const dataValues: Record<string, string> = {
    currency: data.currency, 'teams-conf': teamsConf(data.teams), month: data.month, team: 'platform', 'team-ids': data.teams.map((t) => t.id).join(', '),
  };
  const out = new Map<string, string>();
  for (const [path, text] of baseFiles()) {
    const once = resolve(path, text, { ...dataValues, ...(slotValues.get(path) ?? {}) });
    // A slot's text may carry data hooks ({{team}} in a quickstart line): resolve them too.
    out.set(path, resolve(path, once, dataValues));
  }
  out.set(`samples/${data.prev}.csv`, csvOf(data.entries.filter((e) => e.month === data.prev)));
  out.set(`samples/${data.month}.csv`, csvOf(data.entries.filter((e) => e.month === data.month)));
  return applyEdits(out, edits);
}
