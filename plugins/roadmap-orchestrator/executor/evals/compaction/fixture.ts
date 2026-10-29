import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusPin } from '../../src/commands/corpus.ts';
import { arcId, sha } from '../../src/core/ids.ts';
import { sha256Hex } from '../../src/core/json.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath, repoPath } from '../../src/core/values.ts';
import { parseGuideText } from '../../src/corpus/guide.ts';
import { parseRules, ruleTextSha256 } from '../../src/corpus/rules.ts';
import { parseRulesRegistry, type CorpusPin } from '../../src/corpus/types.ts';
import { debtKey } from '../../src/debt/ledger.ts';
import { parseDebtLedger } from '../../src/debt/types.ts';
import { renderConstraints } from '../../src/docs/constraints.ts';
import { renderDebt } from '../../src/docs/debt.ts';
import { renderInvariants } from '../../src/docs/invariants.ts';
import { snapshotRequestOf } from '../../src/git/snapshot.ts';
import { laneRevOf, parseObligations, parseRulingSidecar, parseVision, type RulingSidecar } from '../../src/holistic/types.ts';
import { keepCorpusFiles, readInputFiles, recordPlan } from '../../src/input/inforce.ts';
import { parsePlan } from '../../src/input/plan.ts';
import { APPLY, phase0InputOf, phase0Rows } from '../../src/phase0/rows.ts';
import { parsePhase0Record } from '../../src/phase0/types.ts';
import { snapshotPublishOp } from '../../src/recover/ops.ts';
import { parseRulings } from '../../src/spec/rulings.ts';
import { runOp, IDENTITY } from '../../test/fixtures/git-common.ts';
import { layout, type Layout } from '../m4a/layout.ts';
import { forgeStore, writeForge } from '../m4a/setup.ts';
import { productFiles } from './product.ts';
import { estateId, estateSpec, setName, type Key, type SetName } from './spec.ts';

export const CLI = fileURLToPath(new URL('../../bin/roadmap', import.meta.url));
export const CORPUS_FILE = 'docs/corpus/register.md';
export const RULE_FILE = 'register.md';
export const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
export function write(path: string, bytes: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
export function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
export function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' } });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function validatedPlan(value: unknown): string { parsePlan(value); return json(value); }
export type Fixture = Readonly<{ l: Layout; key: Key; previous: string; next: string; previousHead: string }>;
export const lane = (id: string) => ({ id, argv: ['node', '--test', 'test/register.test.js'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, cadence: 'build', resources: [], evidenceGlobs: [] });
const arcLane = { ...lane('register'), reporter: 'node-test', testPaths: ['test/register.test.js'] };
const laneRev = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'register', lanes: [arcLane], obligations: [], mapping: { paths: [] } }).lanes[0]!);

export async function pin(l: Layout, inputs: string): Promise<CorpusPin> {
  const head = git(l.product, 'rev-parse', 'HEAD');
  const r = await corpusPin({ repo: absPath(l.product), commit: head, baseline: sha(head), out: absPath(join(inputs, 'corpus.json')) });
  if (r.kind !== 'pinned') throw new Error(`pin refused: ${json(r)}`);
  return r.pin;
}
export function obligation(id: string, rule: string, text: string, statement = text): unknown {
  const witness = { lane: 'register', testIds: [id], files: ['test/register.test.js'] };
  return { id, rev: 1, statement, rule: { id: rule, textSha256: ruleTextSha256(text) }, serves: ['V-1'], witness,
    proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev, witness }, deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' } };
}

export function sidecar(id: string, statement: string, head: string, over: Record<string, unknown> = {}): RulingSidecar {
  return parseRulingSidecar({ schema: 'roadmap/ruling-m3', id, statement, kind: 'constraint', ruledBy: { type: 'architect' }, trigger: 'Owner policy review', supersedes: [], condition: null,
    docRefs: [{ path: CORPUS_FILE, anchor: 'Register', quotedText: 'Register', relation: 'consistent' }], contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'standing', status: 'active',
    consistency: { verdict: 'consistent', judgedRevs: { head, ledgerSha256: sha256Hex('previous ledger'), obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } }, ...over });
}
export function ledgerText(sidecars: readonly RulingSidecar[]): string {
  const text = '# Rulings\n\n' + sidecars.map((s) => `${s.id} — ${s.status === 'superseded' ? 'withdrawn by C-40' : s.statement}`).join('\n') + '\n';
  parseRulings(text, 'rulings.md');
  return text;
}
export function loadSidecars(inputs: string): readonly RulingSidecar[] {
  return readdirSync(join(inputs, 'rulings.md.d')).sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5))).map((f) => parseRulingSidecar(readJson(join(inputs, 'rulings.md.d', f))));
}

function writeInputs(l: Layout, inputs: string, baseline: string, obligations: unknown, ledger: string, sidecars: readonly RulingSidecar[], set: SetName, chain?: { previousArc: string; previousHead: string }): void {
  mkdirSync(inputs, { recursive: true });
  write(join(inputs, 'obligations.json'), json(parseObligations(obligations)));
  write(join(inputs, 'rulings.md'), ledger);
  for (const s of sidecars) write(join(inputs, 'rulings.md.d', `${s.id}.json`), json(s));
  write(join(inputs, 'phase0.json'), json(parsePhase0Record({ schema: 'roadmap/phase0-m4', curation: [], corpusDivergences: [], questions: [{ id: 'P-1', rank: 1, text: 'What is the dispatch cutoff?', files: ['register.md'], bears: [estateId(set, 'T-33')], assumption: set === 'dev' ? '72 hours' : 'seven days', state: { type: 'answered', answer: set === 'dev' ? '48 hours before the tide' : 'three days before the loan', at: '2026-10-01T00:00:00.000Z' } }],
    debt: Array.from({ length: 15 }, (_, i) => ({ id: `B-${i + 1}`, disposition: { type: 'keep', reason: 'Index work follows the current slip slice.' } })), amendments: [], slice: { advances: ['V-1'], why: 'Complete reliable slips for the next operator.' } })));
  write(join(inputs, 'slips.json'), json({ schema: 'roadmap/spec-m1', unit: 'slips', rev: 1, lanes: [{ ...lane('unit'), state: 'active' }], acceptance: [{ id: 'A1', clause: `Print the recipient and return date on the slip (${estateId(set, 'T-21')}).`, failLoudIfUndelivered: true, state: 'active' }], scope: ['src/**', 'test/**'], resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [estateId(set, 'C-12'), 'C-38'] }, obligations: ['I-21'] }));
  write(join(inputs, 'plan.json'), validatedPlan({ schema: 'roadmap/plan-m1', arc: chain ? 'arc-next' : 'arc-previous', integrationBranch: chain ? 'arc/next' : 'arc/previous', baseline,
    worktreeRoot: l.worktrees, contracts: [], rulings: 'rulings.md', direction: 'Complete accurate recipient slips.', suite: { lanes: [lane('suite')] }, resources: [], units: [{ id: 'slips', spec: 'slips.json', risk: 'low', scope: ['src/**', 'test/**'], resources: [] }], corpus: 'corpus.json', phase0: 'phase0.json', holistic: { advances: ['V-1'], obligations: 'obligations.json' }, ...(chain ? { chain } : {}) }));
}

/** Real verified completed-arc snapshot: Phase-0 chain checks read it exactly as they read a completed run. */
async function completePrevious(l: Layout, previous: string, head: string): Promise<void> {
  const files = readInputFiles(absPath(join(previous, 'plan.json')), absPath(l.product));
  const rows = phase0Rows(phase0InputOf(files, null, null), APPLY);
  if (rows.rows.length) throw new Error(`previous inputs: ${json(rows.rows)}`);
  const runDir = absPath(join(l.product, '.git', 'roadmap-runtime', 'arc-previous'));
  mkdirSync(runDir, { recursive: true });
  keepCorpusFiles(runDir, rows.opened?.files ?? []);
  const j = openJournal(runDir, arcId('arc-previous'));
  try {
    recordPlan(j, runDir, files, [], { profile: 'default', config: null, arcRoles: 'm4b' });
    j.fact({ kind: 'arc-completed', planRev: j.view.planApplied()!.rev, head: sha(head), highWater: j.view.highWater(), units: [] });
    await runOp(j, snapshotPublishOp(absPath(l.product)), 'snapshot:arc-previous', snapshotRequestOf({ view: j.view, runDir, identity: IDENTITY, message: 'Previous arc completed\n' }));
  } finally { j.close(); }
}

export async function fixture(dir: string, set: SetName): Promise<Fixture> {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`fixture directory is not empty: ${dir}`);
  const l = layout(resolve(dir));
  const spec = estateSpec(set);
  const id = (value: string): string => estateId(set, value);
  for (const d of [l.product, l.inputs, l.worktrees, l.ghConfig, l.xdgConfig, join(l.inputs, '_next')]) mkdirSync(d, { recursive: true });
  write(l.gitConfig, '[user]\n name = Register Owner\n email = owner@example.invalid\n[commit]\n gpgsign = false\n');
  write(join(l.product, 'package.json'), json({ name: spec.key.domain.toLowerCase(), type: 'module', scripts: { test: 'node --test test/' } }));
  for (const [path, bytes] of Object.entries(productFiles(set))) write(join(l.product, path), bytes);
  write(join(l.product, 'README.md'), `# ${spec.key.domain}\n\n${spec.context}\n\nRun: node src/cli.js list\n`);
  const guide = '# Corpus\n\nThe register policy is normative; prose records its history.\n\n```json roadmap-corpus\n' + json({ schema: 'roadmap/corpus-guide-m4', source: { kind: 'same-repo', root: 'docs/corpus' }, include: ['*.md'], vision: 'vision.md' }) + '```\n';
  parseGuideText(guide);
  write(join(l.product, '.roadmap/corpus.md'), guide);
  const vision = `# Vision\n\n## The operator's day\n\n{V-1} ${spec.world}\n\n## Integrity\n\n{V-2} The register never silently loses or duplicates an entry.\n`;
  write(join(l.product, 'docs/corpus/vision.md'), vision);
  write(join(l.product, '.roadmap/vision.json'), json(parseVision({ schema: 'roadmap/vision-m3', rev: 1, confirmation: { ref: `corpus:vision.md#sha256:${sha256Hex(vision)}`, at: '2026-10-01T00:00:00.000Z' }, clauses: [{ id: 'V-1', kind: 'world', text: spec.world, rank: null, state: 'active' }, { id: 'V-2', kind: 'non-negotiable', text: 'The register never silently loses or duplicates an entry.', rank: null, state: 'active' }], questions: [] })));
  write(join(l.product, '.roadmap/config.json'), json({ chain: { k: 4 } }));
  const corpus = '# Register\n\n' + spec.context + '\n\n```rules\n' + Object.entries(spec.rules).sort(([a], [b]) => Number(a.slice(2)) - Number(b.slice(2))).map(([id, text]) => `${id}: ${text}`).join('\n') + '\n```\n';
  write(join(l.product, CORPUS_FILE), corpus);
  const parsedRules = parseRules(corpus, repoPath(RULE_FILE));
  const obs = Array.from({ length: 57 }, (_, i) => {
    const n = i + 1;
    const o = obligation(`I-${n}`, id(`T-${n}`), spec.rules[id(`T-${n}`)]!, n === 52 ? 'One internal comment is grammatical English.' : spec.rules[id(`T-${n}`)]!) as Record<string, unknown>;
    if (n >= 54 && n <= 56) o['state'] = { type: ['retired', 'waived', 'deferred'][n - 54], ruling: `C-${n - 24}` };
    return o;
  });
  const parent = obligation('I-58', 'T-58', spec.rules['T-58']!) as Record<string, unknown>;
  Object.assign(parent, { witness: null, proofJudgment: null, state: { type: 'split', children: ['I-59', 'I-60'] } });
  obs.push(parent);
  for (const n of [59, 60]) obs.push({ ...(obligation(`I-${n}`, 'T-58', spec.rules['T-58']!) as Record<string, unknown>), parent: 'I-58' });
  const obligations = parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'The previous release is complete; the next slice completes slips.', lanes: [arcLane], obligations: obs,
    mapping: { paths: [{ pattern: 'src/**', obligations: obs.map((o) => o['id']) }] }, census: parsedRules.map((r) => { const ob = obs.find((o) => (o['rule'] as { id: string }).id === r.id); return { rule: r.id, state: ob ? { type: 'obligation', id: ob['id'] } : { type: 'prod-only' } }; }) });
  const registry = parseRulesRegistry({ highWater: 85, active: parsedRules.map((r) => ({ id: r.id, textSha256: r.textSha256 })), retired: Array.from({ length: 5 }, (_, i) => ({ id: `T-${81 + i}`, textSha256: sha256Hex(`retired policy ${i}`) })) });
  write(join(l.product, '.roadmap/invariants.md'), renderInvariants(obligations, [], registry));
  const debt = parseDebtLedger({ schema: 'roadmap/debt-m4', items: spec.debt.map((what, i) => ({ id: `B-${i + 1}`, originArc: 'arc-previous', bankReason: 'gate-note', what, unit: null, key: debtKey({ unit: null, bankReason: 'gate-note', what }), history: [], state: 'open' })) });
  write(join(l.product, '.roadmap/debt.md'), renderDebt(debt));
  git(l.product, 'init', '--quiet', '--initial-branch=arc/previous');
  git(l.product, 'config', 'user.name', 'Register Owner');
  git(l.product, 'config', 'user.email', 'owner@example.invalid');
  git(l.product, 'config', 'commit.gpgsign', 'false');
  git(l.product, 'add', '.');
  git(l.product, 'commit', '--quiet', '-m', 'Register policies and CLI');
  const head = git(l.product, 'rev-parse', 'HEAD');
  const sidecars = Object.entries(spec.rulings).sort(([a], [b]) => Number(a.slice(2)) - Number(b.slice(2))).map(([id, statement]) => sidecar(id, statement, head, {
    ...(id === estateId(set, 'C-5') ? { docRefs: [{ rule: estateId(set, 'T-49'), textSha256: ruleTextSha256(spec.rules[estateId(set, 'T-49')]!), relation: 'consistent' }] } : {}),
    ...(id === 'C-34' ? { obligations: ['I-20'], docRefs: [{ rule: estateId(set, 'T-20'), textSha256: ruleTextSha256(spec.rules[estateId(set, 'T-20')]!), relation: 'consistent' }] } : {}),
    ...(id === 'C-38' ? { lifetime: 'arc' } : {}), ...(id === 'C-39' ? { status: 'superseded' } : {}),
    ...(id === 'C-40' ? { supersedes: [{ id: 'C-39', part: null }] } : {}),
    ...(['C-30', 'C-31', 'C-32'].includes(id) ? { kind: 'disposition', obligations: [`I-${Number(id.slice(2)) + 24}`], obligationDispositions: [{ id: `I-${Number(id.slice(2)) + 24}`, disposition: id === 'C-30' ? 'retired' : id === 'C-31' ? 'waived' : 'deferred' }] } : {}),
  }));
  const ledger = ledgerText(sidecars);
  write(join(l.product, '.roadmap/constraints.md'), renderConstraints(parseRulings(ledger, 'rulings.md'), sidecars, 'close-out'));
  write(join(l.product, 'docs/last-check-in.md'), `# Last check-in\n\n${spec.context}\n\nRecent findings: F-1 and F-2 found violations of ${id('T-20')} / I-20 during register mutation. Both were fixed before completion.\nNext slice advances V-1; the slip rule ${id('T-21')} serves it.\n`);
  git(l.product, 'add', '.');
  git(l.product, 'commit', '--quiet', '-m', 'Previous arc close-out');
  const previousHead = git(l.product, 'rev-parse', 'HEAD');
  git(l.product, 'init', '--quiet', '--bare', l.origin);
  git(l.product, 'remote', 'add', 'origin', l.origin);
  git(l.product, 'push', '--quiet', 'origin', 'arc/previous');
  writeForge(l, forgeStore(l));
  const previous = join(l.inputs, 'arc-previous');
  writeInputs(l, previous, previousHead, obligations, ledger, sidecars, set);
  await pin(l, previous);
  await completePrevious(l, previous, previousHead);
  git(l.product, 'switch', '--quiet', '-c', 'work/arc-next');
  git(l.product, 'commit', '--quiet', '--allow-empty', '-m', 'Between arcs');
  const baseline = git(l.product, 'rev-parse', 'HEAD');
  git(l.product, 'branch', 'arc/next', baseline);
  const next = join(l.inputs, 'arc-next');
  // Step 5 drops the already retired obligation; step 12 keeps C-38 (spec cite), drops C-39.
  const carried = parseObligations({ ...obligations, obligations: obligations.obligations.filter((o) => o.id !== 'I-54'),
    mapping: { paths: obligations.mapping.paths.map((p) => ({ ...p, obligations: p.obligations.filter((id) => id !== 'I-54') })) },
    census: obligations.census!.map((e) => e.rule === 'T-54' ? { rule: e.rule, state: { type: 'prod-only' } } : e) });
  const carriedSidecars = sidecars.filter((s) => s.id !== 'C-39');
  writeInputs(l, next, baseline, carried, ledgerText(carriedSidecars), carriedSidecars, set, { previousArc: 'arc-previous', previousHead });
  await pin(l, next);
  write(join(l.dir, 'key.json'), json(spec.key));
  write(join(l.dir, 'golden-compaction.md'), spec.key.goldenRecord);
  if (set === 'holdout') write(fileURLToPath(new URL('./holdout/key-holdout.json', import.meta.url)), json(spec.key));
  return { l, key: spec.key, previous, next, previousHead };
}

export function phase0Cli(f: Fixture): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [CLI, 'phase0', 'check', '--repo', f.l.product, '--plan', join(f.next, 'plan.json')], { cwd: f.l.product, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${f.l.forgeBin}:${process.env['PATH']}`, GIT_CONFIG_GLOBAL: f.l.gitConfig, GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.error) throw r.error;
  return { status: r.status, output: r.stdout + r.stderr };
}
if (import.meta.main) {
  const [dir, flag, value, ...rest] = process.argv.slice(2);
  if (!dir || flag !== '--set' || !value || rest.length) throw new Error('usage: node evals/compaction/fixture.ts <dir> --set dev|holdout');
  const f = await fixture(resolve(dir), setName(value));
  process.stdout.write(json({ product: f.l.product, previous: f.previous, next: f.next }));
}
