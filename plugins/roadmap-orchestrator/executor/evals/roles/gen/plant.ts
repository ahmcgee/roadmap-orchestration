// Plants: one defect laid into a swept tree, invisible to the lanes (only in uncovered code, a golden no lane reads, a test
// assertion weakened but still passing, or a deletion nothing tested imports). Each plant picks its file from the files it
// is eligible for (the caller trims the first and last tenth in path order and filters by placement), its symbol and its
// surface form from templates, all from the trial's seed.
//
// A plant applies at one of two phases: `source` (after the sweep's source edits, before goldens are regenerated, so the
// goldens agree with it) or `golden` (after regeneration: a hand edit the generator would not write). The answer it
// returns names the path, the form, and the needle: the defect's text as it reads after planting (a line, a golden entry,
// or the deleted path), which grading looks for in the prompt and in what the session's tools returned.
import type { Rng } from './prng.ts';
import { type FileMap, MEASURE, type Repo, type Swept, sorted } from './tsrepo.ts';

export type Planted = Readonly<{
  kind: string;
  path: string;
  form: string;
  needle: string;
  /** A deletion: its path is the needle, and the prompt's mention of the path is a look at it. */
  deletion: boolean;
}>;

export type PlantContext = Readonly<{ repo: Repo; swept: Swept; rng: Rng }>;

/**
 * A plant: the files it may go in at its phase, and how it applies to one of them (null when that file offers no
 * template, and the caller tries the next candidate). Holdout plants implement the same type.
 */
export type Plant = Readonly<{
  kind: string;
  phase: 'source' | 'golden';
  eligible: (ctx: PlantContext, files: FileMap) => readonly string[];
  apply: (ctx: PlantContext, files: FileMap, path: string) => Readonly<{ files: FileMap; planted: Planted }> | null;
}>;

type Template = Readonly<{ form: string; match: RegExp; replace: (m: RegExpExecArray) => string }>;

const plus1 = (n: string): string => String(Number(n) + 1);

/** Logic edits: each matches a line of one body form, whose local makes the line unique. */
const LOGIC: readonly Template[] = [
  { form: 'flip-compare', match: /if \((\w+Acc) > b\)/, replace: (m) => `if (${m[1]} >= b)` },
  { form: 'flip-compare', match: /i < a % 7; i\+\+\) (\w+Acc)/, replace: (m) => `i <= a % 7; i++) ${m[1]}` },
  { form: 'flip-compare', match: /(\w+Acc) = a >= b \?/, replace: (m) => `${m[1]} = a > b ?` },
  { form: 'swap-operator', match: /return (\w+Acc) \+ b \* /, replace: (m) => `return ${m[1]} - b * ` },
  { form: 'swap-operator', match: /\) (\w+Acc) \+= /, replace: (m) => `) ${m[1]} -= ` },
  { form: 'swap-operator', match: /(\w+Acc) = (.*): scaleBy\(b, (\d+)\) - a;/, replace: (m) => `${m[1]} = ${m[2]}: scaleBy(b, ${m[3]}) + a;` },
  { form: 'nudge-constant', match: /(\w+Acc) = scaleBy\(a, (\d+)\)/, replace: (m) => `${m[1]} = scaleBy(a, ${plus1(m[2]!)})` },
  { form: 'nudge-constant', match: /let (\w+Acc) = (\d+);/, replace: (m) => `let ${m[1]} = ${plus1(m[2]!)};` },
  { form: 'nudge-constant', match: /(\w+Acc) = a >= b \? (\w+)\(a - b \+ (\d+)\)/, replace: (m) => `${m[1]} = a >= b ? ${m[2]}(a - b + ${plus1(m[3]!)})` },
];

/** Applies one template the rng picks among those matching a line of `text`; the new line is the needle. */
function editLine(g: Rng, text: string, templates: readonly Template[]): Readonly<{ text: string; form: string; needle: string }> | null {
  const lines = text.split('\n');
  const options = lines.flatMap((line, i) => templates.flatMap((t) => {
    const m = t.match.exec(line);
    return m === null ? [] : [{ i, t, m }];
  }));
  if (options.length === 0) return null;
  const { i, t, m } = g.pick(options);
  const line = lines[i]!;
  lines[i] = line.slice(0, m.index) + t.replace(m) + line.slice(m.index + m[0].length);
  return { text: lines.join('\n'), form: t.form, needle: lines[i]!.trim() };
}

const replaced = (files: FileMap, path: string, text: string | null): FileMap => {
  const out = new Map(files);
  if (text === null) out.delete(path);
  else out.set(path, text);
  return sorted(out);
};

/** Live modules no test covers (no test file imports them, not a helper, not the compat decoy) that the sweep changed. */
function uncoveredChanged(ctx: PlantContext, files: FileMap): string[] {
  const { repo } = ctx;
  return [...files.keys()].filter((p) => {
    if (!/^packages\/[^/]+\/(src|core|legacy)\/[^/]+\.ts$/.test(p) || p === MEASURE || p.endsWith('-base.ts') || p === repo.compat) return false;
    if (repo.tested.has(p) || repo.tested.has(p.replace('/core/', '/legacy/'))) return false;
    if (p.startsWith(`packages/${repo.deprecated}/`)) return false;
    const before = repo.files.get(p) ?? repo.files.get(p.replace('/core/', '/legacy/'));
    return before !== undefined && before !== files.get(p);
  });
}

/** G0, G3: a collateral logic edit in an uncovered module the sweep touched. */
export const LOGIC_EDIT: Plant = {
  kind: 'logic',
  phase: 'source',
  eligible: uncoveredChanged,
  apply: (ctx, files, path) => {
    const e = editLine(ctx.rng, files.get(path)!, LOGIC);
    return e === null ? null : { files: replaced(files, path, e.text), planted: { kind: 'logic', path, form: e.form, needle: e.needle, deletion: false } };
  },
};

/** G2: one use renamed to the same-signature sibling instead of the new name (the shared helper's rename). */
export const WRONG_SYMBOL: Plant = {
  kind: 'wrong-symbol',
  phase: 'source',
  eligible: (ctx, files) => (ctx.swept.pkg === null ? uncoveredChanged(ctx, files) : []),
  apply: (ctx, files, path) => {
    const { to } = ctx.swept;
    const t: Template = { form: 'sibling-call', match: new RegExp(`\\b${to}\\(`), replace: () => `${ctx.repo.sibling}(` };
    const e = editLine(ctx.rng, files.get(path)!, [t]);
    return e === null ? null : { files: replaced(files, path, e.text), planted: { kind: 'wrong-symbol', path, form: e.form, needle: e.needle, deletion: false } };
  },
};

type GoldenExport = { name: string; params: string; calls: string[] };
type Golden = { package: string; modules: { path: string; exports: GoldenExport[] }[] };

/** G4: one golden entry edited by hand: a stale call name, an extra parameter, or a dropped call. */
export const GOLDEN_EDIT: Plant = {
  kind: 'golden-edit',
  phase: 'golden',
  eligible: (ctx, files) => [...files.keys()].filter((p) => p.startsWith('goldens/') && p !== `goldens/${ctx.repo.deprecated}.json` && ctx.repo.files.get(p) !== files.get(p)),
  apply: (ctx, files, path) => {
    const g = ctx.rng;
    const golden = JSON.parse(files.get(path)!) as Golden;
    const entries = golden.modules.flatMap((m) => m.exports);
    const forms = [
      { form: 'stale-call', ok: (x: GoldenExport) => x.calls.includes(ctx.swept.to), edit: (x: GoldenExport) => { x.calls = x.calls.map((c) => (c === ctx.swept.to ? ctx.swept.from : c)).sort(); } },
      { form: 'params-edit', ok: (x: GoldenExport) => x.params === 'a: number, b: number', edit: (x: GoldenExport) => { x.params = 'a: number, b: number, c: number'; } },
      { form: 'dropped-call', ok: (x: GoldenExport) => x.calls.length >= 2, edit: (x: GoldenExport) => { x.calls.splice(g.int(x.calls.length), 1); } },
    ];
    const options = forms.flatMap((f) => entries.filter(f.ok).map((x) => ({ f, x })));
    if (options.length === 0) return null;
    const { f, x } = g.pick(options);
    f.edit(x);
    return { files: replaced(files, path, `${JSON.stringify(golden)}\n`), planted: { kind: 'golden-edit', path, form: f.form, needle: JSON.stringify(x), deletion: false } };
  },
};

/** G5: one migrated assertion weakened (it still passes: the code it tests is correct). */
export const WEAKENED_ASSERT: Plant = {
  kind: 'weakened-assert',
  phase: 'source',
  eligible: (_ctx, files) => [...files.keys()].filter((p) => p.includes('/test/') && p.endsWith('.test.ts')),
  apply: (ctx, files, path) => {
    const m = /assert\.(equal|deepEqual)\((.+), (-?\d+), ('[^']*')\);/;
    const templates: readonly Template[] = [
      { form: 'typeof', match: m, replace: (x) => `assert.equal(typeof ${x[2]}, 'number', ${x[4]});` },
      { form: 'defined', match: m, replace: (x) => `assert.ok(${x[2]} !== undefined, ${x[4]});` },
      { form: 'finite', match: m, replace: (x) => `assert.ok(Number.isFinite(${x[2]}), ${x[4]});` },
    ];
    const e = editLine(ctx.rng, files.get(path)!, [ctx.rng.pick(templates)]);
    return e === null ? null : { files: replaced(files, path, e.text), planted: { kind: 'weakened-assert', path, form: e.form, needle: e.needle, deletion: false } };
  },
};

/** G6: an uncovered live module deleted though the spec does not declare it removed. */
export const STRAY_DELETION: Plant = {
  kind: 'stray-deletion',
  phase: 'source',
  // A moved module deleted shows as its old path's deletion; only unmoved ones, so the answer names the diff's path.
  eligible: (ctx, files) => uncoveredChanged(ctx, files).filter((p) => !p.includes('/core/')),
  apply: (_ctx, files, path) => ({ files: replaced(files, path, null), planted: { kind: 'stray-deletion', path, form: 'delete', needle: path, deletion: true } }),
};
