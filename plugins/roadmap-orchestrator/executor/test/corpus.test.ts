// M4a step A1: rules blocks, the corpus guide, the source kinds (same-repo, other-repo, checkout, against local repos
// and a local bare remote), the pin's derivation and re-derivation against the published rules registry, the checkout
// cache's identity (H22) and the read-only materialisation.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { corpusPin } from '../src/commands/corpus.ts';
import { ruleId, sha256 } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { absPath, repoPath } from '../src/core/values.ts';
import { guideAt, parseGuideText } from '../src/corpus/guide.ts';
import { materialiseCorpus, materialisedDir } from '../src/corpus/materialise.ts';
import { pinBytes, pinSha256, rederivePin } from '../src/corpus/pin.ts';
import { EMPTY_REGISTRY, registryAt, registryOf } from '../src/corpus/registry.ts';
import { CorpusFormatError, normalizeText, parseRules } from '../src/corpus/rules.ts';
import { REMOTE_FILE, canonicalRemote, checkoutCacheDir } from '../src/corpus/source.ts';
import { type CorpusPin, parseCorpusPin } from '../src/corpus/types.ts';
import { parseInvariantsBlock, parseRulesRegistryBlock, renderInvariants } from '../src/docs/invariants.ts';
import { parseObligations } from '../src/holistic/types.ts';
import { runUntilExit } from './helpers/proc.ts';
import { commitAll, git, makeRepo, tmpDir, writeFiles } from './helpers/repo.ts';

const F = repoPath('a.md');
const fence = (body: string, info = 'rules'): string => `\`\`\`${info}\n${body}\n\`\`\``;

describe('rules blocks', () => {
  it('rules.parse-valid: ids, normalised text and hash, nearest heading as section', () => {
    const text = ['# Top', 'prose', '## Booking  rules', fence('T-3:   A berth  holds one vessel.\n\nT-1: Tides are published.'), '```sh\n# not a heading\n```', fence('T-7: Late.')].join('\n');
    const rules = parseRules(text, F);
    assert.deepEqual(rules.map((r) => [r.id, r.text, r.section]), [['T-3', 'A berth holds one vessel.', 'Booking rules'], ['T-1', 'Tides are published.', 'Booking rules'], ['T-7', 'Late.', 'Booking rules']]);
    assert.equal(rules[0]!.textSha256, sha256Hex('A berth holds one vessel.'));
    assert.equal(parseRules(fence('T-1: x'), F)[0]!.section, null);
    assert.equal(normalizeText('  a \t b\n c '), 'a b c');
  });
  it('rules.parse-malformed: a bad line, an empty block, an unclosed block, a duplicate id', () => {
    assert.throws(() => parseRules(fence('T-1 missing colon'), F), (e: unknown) => e instanceof CorpusFormatError && /a\.md:2: malformed rule line/.test(e.message));
    assert.throws(() => parseRules(fence('T-0: zero'), F), /malformed rule line/);
    assert.throws(() => parseRules(fence('T-1:'), F), /malformed rule line/);
    assert.throws(() => parseRules(fence(''), F), /a\.md:1: empty rules block/);
    assert.throws(() => parseRules('```rules\nT-1: x\n', F), /unclosed rules block/);
    assert.throws(() => parseRules(`${fence('T-1: x')}\n${fence('T-1: y')}`, F), /duplicate rule id T-1/);
  });
  it('rules.parse-other-fences: only the `rules` info string is a rules block', () => {
    assert.deepEqual(parseRules(`${fence('T-1: x', 'json')}\n${fence('T-2: y', 'rules extra')}`, F), []);
  });
});

describe('the corpus guide', () => {
  const guideJson = { schema: 'roadmap/corpus-guide-m4', source: { kind: 'same-repo', root: 'docs/corpus' }, include: ['**/*.md'], vision: '0005_Vision.md' };
  it('guide.parse: exactly one block', () => {
    assert.equal(parseGuideText(`# Guide\n${fence(JSON.stringify(guideJson), 'json roadmap-corpus')}\n`).vision, '0005_Vision.md');
    assert.throws(() => parseGuideText('# Guide\n'), /0 json roadmap-corpus blocks/);
    const one = fence(JSON.stringify(guideJson), 'json roadmap-corpus');
    assert.throws(() => parseGuideText(`${one}\n${one}`), /2 json roadmap-corpus blocks/);
    assert.throws(() => parseGuideText(fence('{"schema":"x"}', 'json roadmap-corpus')), CorpusFormatError);
  });
});

// ---------------------------------------------------------------------------------------------------
// Fixtures: a product repo with a guide and a corpus under `root`.

const ROOT = 'docs/corpus';
const VISION = '0005_Vision.md';
type Source = Record<string, unknown>;
const guideText = (source: Source, extra = ''): string =>
  `# Corpus guide\n\nRead the numbered docs first.${extra}\n\n${fence(JSON.stringify({ schema: 'roadmap/corpus-guide-m4', source, include: ['*.md', '0070_ADRs'], vision: VISION }), 'json roadmap-corpus')}\n`;
const corpusFiles = (rules: string, prefix = ''): Record<string, string> => ({
  [`${prefix}${VISION}`]: '# Vision\n\nA calm harbour.\n',
  [`${prefix}0010_Overview.md`]: `# Overview\n\n## Berths\n\n${fence(rules)}\n`,
  [`${prefix}0070_ADRs/0001.md`]: '# ADR 1\n\nNo rules here.\n',
  [`${prefix}notes.txt`]: 'not included\n',
});
const RULES_1 = 'T-1: A berth holds one vessel.\nT-2: Tide windows are published daily.';

/** `extra` overrides the corpus; a null entry leaves that file out. */
function productRepo(name: string, source: Source, rules = RULES_1, extra: Record<string, string | null> = {}): string {
  const files = Object.entries({ '.roadmap/corpus.md': guideText(source), ...corpusFiles(rules, `${ROOT}/`), ...extra }).filter((e): e is [string, string] => e[1] !== null);
  return makeRepo(tmpDir(name), { files: Object.fromEntries(files) });
}

/** Where a test writes a repo's pin: inside its git dir, so it is never part of a tree. */
const pinFile = (repo: string): string => join(repo, '.git', 'pin.json');

async function pinIn(repo: string, commit = 'HEAD'): Promise<Awaited<ReturnType<typeof corpusPin>>> {
  return corpusPin({ repo: absPath(repo), commit, out: absPath(pinFile(repo)) });
}

async function pinned(repo: string, commit = 'HEAD'): Promise<{ pin: CorpusPin; file: string }> {
  const out = await pinIn(repo, commit);
  assert.equal(out.kind, 'pinned', JSON.stringify(out));
  if (out.kind !== 'pinned') throw new Error('unreachable');
  const file = pinFile(repo);
  assert.equal(sha256Hex(readFileSync(file)), out.sha256);
  assert.equal(out.sha256, pinSha256(out.pin));
  return { pin: out.pin, file };
}

const refusedProblems = (out: Awaited<ReturnType<typeof corpusPin>>): unknown => (out.kind === 'refused' ? out.rejection.problems : `pinned ${JSON.stringify(out)}`);

/** Commits `.roadmap/invariants.md` publishing `pin`'s registry, as the previous arc's close-out would. */
function publishRegistry(repo: string, pin: CorpusPin): void {
  const obligations = parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [], obligations: [], mapping: { paths: [] } });
  writeFiles(repo, { '.roadmap/invariants.md': renderInvariants(obligations, [], registryOf(pin)) });
  commitAll(repo, 'publish');
}

describe('source kinds', () => {
  it('source.same: files under root matching the include patterns, the vision, rules from non-vision .md files', async () => {
    const repo = productRepo('same', { kind: 'same-repo', root: ROOT });
    const { pin, file } = await pinned(repo);
    assert.deepEqual(pin.source, { kind: 'same-repo', commit: git(repo, 'rev-parse', 'HEAD'), root: ROOT });
    assert.deepEqual(pin.files.map((f) => f.path), ['0005_Vision.md', '0010_Overview.md', '0070_ADRs/0001.md']);
    assert.deepEqual(pin.vision, { path: VISION, sha256: sha256Hex('# Vision\n\nA calm harbour.\n') });
    assert.deepEqual(pin.rules.map((r) => [r.id, r.file, r.section]), [['T-1', '0010_Overview.md', 'Berths'], ['T-2', '0010_Overview.md', 'Berths']]);
    assert.deepEqual([pin.retired, pin.highWater], [[], 2]);
    assert.equal(pin.guideSha256, sha256Hex(readFileSync(join(repo, '.roadmap/corpus.md'))));
    assert.deepEqual(parseCorpusPin(JSON.parse(readFileSync(file, 'utf8'))), pin);
    // A re-run writes the same bytes.
    const again = await pinIn(repo);
    assert.equal(again.kind === 'pinned' && again.sha256, pinSha256(pin));
  });
  it('source.same-at-commit: the corpus at --commit, not at HEAD', async () => {
    const repo = productRepo('same-commit', { kind: 'same-repo', root: ROOT });
    const first = git(repo, 'rev-parse', 'HEAD');
    writeFiles(repo, { [`${ROOT}/0010_Overview.md`]: `# Overview\n\n${fence('T-1: changed.')}\n` });
    commitAll(repo, 'edit');
    const { pin } = await pinned(repo, first);
    assert.equal(pin.source.commit, first);
    assert.equal(pin.rules.length, 2);
  });
  it('source.other: the git repo at the guide path', async () => {
    const corpus = makeRepo(tmpDir('other-corpus'), { files: corpusFiles(RULES_1, 'kb/') });
    const repo = makeRepo(tmpDir('other'), { files: { '.roadmap/corpus.md': guideText({ kind: 'other-repo', path: corpus, root: 'kb' }), 'README.md': 'x\n' } });
    const { pin } = await pinned(repo, git(corpus, 'rev-parse', 'HEAD'));
    assert.deepEqual(pin.source, { kind: 'other-repo', commit: git(corpus, 'rev-parse', 'HEAD'), path: corpus, root: 'kb' });
    assert.deepEqual(pin.rules.map((r) => r.id), ['T-1', 'T-2']);
  });
  it('source.unreadable: no such repo, commit or root', async () => {
    const missing = productRepo('other-missing', { kind: 'other-repo', path: '/nonexistent/corpus', root: 'kb' });
    assert.deepEqual(refusedProblems(await pinIn(missing)), [{ type: 'source-unreadable', detail: 'other-repo /nonexistent/corpus does not exist' }]);
    const same = productRepo('same-bad', { kind: 'same-repo', root: ROOT });
    const bad = await pinIn(same, 'no-such-ref');
    assert.equal(bad.kind === 'refused' && bad.rejection.problems[0]!.type, 'source-unreadable');
    const noRoot = productRepo('same-noroot', { kind: 'same-repo', root: 'docs/elsewhere' });
    assert.equal((await pinIn(noRoot)).kind, 'refused');
  });
  it('source.guide-missing: no guide committed at HEAD', async () => {
    const repo = makeRepo(tmpDir('noguide'), { files: corpusFiles(RULES_1, `${ROOT}/`) });
    writeFiles(repo, { '.roadmap/corpus.md': guideText({ kind: 'same-repo', root: ROOT }) }); // uncommitted: not read
    assert.deepEqual(refusedProblems(await pinIn(repo)), [{ type: 'guide-missing' }]);
  });

  function bareRemote(name: string): { bare: string; work: string } {
    const work = makeRepo(tmpDir(`${name}-work`), { files: corpusFiles(RULES_1, 'kb/') });
    const bare = join(tmpDir(`${name}-bare`), 'corpus.git');
    git(work, 'clone', '--quiet', '--bare', work, bare);
    git(work, 'remote', 'add', 'origin', bare);
    return { bare, work };
  }

  it('source.checkout: cloned once into the cache, fetched before each pin', async () => {
    const { bare, work } = bareRemote('checkout');
    const repo = makeRepo(tmpDir('checkout'), { files: { '.roadmap/corpus.md': guideText({ kind: 'checkout', remote: `${bare}/`, root: 'kb' }), 'README.md': 'x\n' } });
    const first = await pinned(repo, 'origin/main');
    assert.deepEqual(first.pin.source, { kind: 'checkout', commit: git(work, 'rev-parse', 'HEAD'), remote: bare, root: 'kb' });
    const dir = checkoutCacheDir(absPath(repo), bare);
    assert.ok(existsSync(join(dir, 'repo', '.git')));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, REMOTE_FILE), 'utf8')), { remote: bare });
    // A new commit on the remote is fetched by the next pin.
    writeFiles(work, { 'kb/0010_Overview.md': `# Overview\n\n${fence(`${RULES_1}\nT-3: Pilots board at the bar.`)}\n` });
    const next = commitAll(work, 'add T-3');
    git(work, 'push', '--quiet', 'origin', 'main');
    const second = await pinned(repo, 'origin/main');
    assert.equal(second.pin.source.commit, next);
    assert.deepEqual(second.pin.rules.map((r) => r.id), ['T-1', 'T-2', 'T-3']);
    // Re-derivation of a pinned commit reads the clone without fetching.
    const guide = guideAt(absPath(repo), 'HEAD');
    assert.equal(rederivePin(absPath(repo), second.pin, guide, EMPTY_REGISTRY).kind, 'equal');
  });
  it('source.checkout-full-hash: the cache directory is the full sha256 of the canonical remote', () => {
    const repo = absPath(makeRepo(tmpDir('hash'), { files: { 'README.md': 'x\n' } }));
    const remote = 'https://example.invalid/harbour/corpus';
    assert.equal(canonicalRemote(` ${remote}// `), remote);
    assert.notEqual(canonicalRemote(`${remote}.git`), remote);
    const dir = checkoutCacheDir(repo, `${remote}/`);
    assert.equal(dir, join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'roadmap', 'corpus', sha256Hex(remote)));
    assert.match(dir.split('/').at(-1)!, /^[0-9a-f]{64}$/);
  });
  it('source.checkout-remote-mismatch: a remote.json naming another remote refuses before any fetch', async () => {
    const { bare } = bareRemote('mismatch');
    const repo = makeRepo(tmpDir('mismatch'), { files: { '.roadmap/corpus.md': guideText({ kind: 'checkout', remote: bare, root: 'kb' }), 'README.md': 'x\n' } });
    await pinned(repo, 'origin/main');
    const file = join(checkoutCacheDir(absPath(repo), bare), REMOTE_FILE);
    writeFileSync(file, JSON.stringify({ remote: 'https://example.invalid/other' }));
    assert.deepEqual(refusedProblems(await pinIn(repo, 'origin/main')), [{ type: 'source-remote-mismatch' }]);
  });
});

describe('the pin against the registry', () => {
  it('rules.in-vision-refused: a rules block in the vision document', async () => {
    const repo = productRepo('in-vision', { kind: 'same-repo', root: ROOT }, RULES_1, { [`${ROOT}/${VISION}`]: `# Vision\n\n${fence('T-9: calm.')}\n` });
    assert.deepEqual(refusedProblems(await pinIn(repo)), [{ type: 'rules-in-vision' }]);
  });
  it('pin.vision-not-included: the guide names a vision no include pattern covers', async () => {
    const repo = productRepo('vision-missing', { kind: 'same-repo', root: ROOT }, RULES_1, { [`${ROOT}/${VISION}`]: null });
    await assert.rejects(pinIn(repo), /the vision document 0005_Vision\.md is not an included file/);
  });
  it('pin.rederive-equal: the same guide, source and registry re-derive the pin byte for byte', async () => {
    const repo = productRepo('rederive', { kind: 'same-repo', root: ROOT });
    const { pin } = await pinned(repo);
    // Later commits move nothing: the pin names its commit.
    writeFiles(repo, { [`${ROOT}/0010_Overview.md`]: '# changed\n' });
    commitAll(repo, 'later');
    const out = rederivePin(absPath(repo), pin, guideAt(absPath(repo), 'HEAD'), registryAt(absPath(repo), 'HEAD') ?? EMPTY_REGISTRY);
    assert.equal(out.kind, 'equal');
    assert.deepEqual(out.kind === 'equal' && out.opened.files.map((f) => f.path), pin.files.map((f) => f.path));
    // A tampered pin is drift.
    const tampered = { ...pin, highWater: pin.highWater + 1 };
    assert.deepEqual(rederivePin(absPath(repo), tampered, guideAt(absPath(repo), 'HEAD'), EMPTY_REGISTRY), { kind: 'refused', problems: [{ type: 'pin-drift' }] });
    assert.deepEqual(rederivePin(absPath(repo), pin, null, EMPTY_REGISTRY), { kind: 'refused', problems: [{ type: 'guide-missing' }] });
  });
  it('pin.guide-drift: any byte change to the guide, prose included, is drift', async () => {
    const repo = productRepo('guide-drift', { kind: 'same-repo', root: ROOT });
    const { pin } = await pinned(repo);
    writeFiles(repo, { '.roadmap/corpus.md': guideText({ kind: 'same-repo', root: ROOT }, ' Then the ADRs.') });
    commitAll(repo, 'guide prose');
    assert.deepEqual(rederivePin(absPath(repo), pin, guideAt(absPath(repo), 'HEAD'), EMPTY_REGISTRY), { kind: 'refused', problems: [{ type: 'pin-drift' }] });
  });
  it('pin.rule-retired: a registry rule missing from the corpus moves to retired; the high-water holds', async () => {
    const repo = productRepo('retire', { kind: 'same-repo', root: ROOT }, `${RULES_1}\nT-3: Pilots board at the bar.`);
    const first = await pinned(repo);
    publishRegistry(repo, first.pin);
    writeFiles(repo, { [`${ROOT}/0010_Overview.md`]: `# Overview\n\n${fence('T-1: A berth holds one vessel.\nT-4: Harbour dues are posted.')}\n` });
    commitAll(repo, 'retire T-2 and T-3, add T-4');
    const second = await pinned(repo);
    assert.deepEqual(second.pin.rules.map((r) => r.id), ['T-1', 'T-4']);
    assert.deepEqual(second.pin.retired.map((r) => [r.id, r.textSha256]), [['T-2', first.pin.rules[1]!.textSha256], ['T-3', first.pin.rules[2]!.textSha256]]);
    assert.equal(second.pin.highWater, 4);
  });
  it('pin.rule-reused: an id new to the registry at or below its high-water', async () => {
    const repo = productRepo('reused', { kind: 'same-repo', root: ROOT }, `T-1: one.\nT-5: five.`);
    publishRegistry(repo, (await pinned(repo)).pin);
    writeFiles(repo, { [`${ROOT}/0010_Overview.md`]: `# Overview\n\n${fence('T-1: one.\nT-5: five.\nT-3: three.\nT-6: six.')}\n` });
    commitAll(repo, 'reuse T-3');
    assert.deepEqual(refusedProblems(await pinIn(repo)), [{ type: 'rule-reused', id: 'T-3' }]);
  });
  it('pin.retired-back: a retired id that reappears', async () => {
    const repo = productRepo('retired-back', { kind: 'same-repo', root: ROOT });
    publishRegistry(repo, (await pinned(repo)).pin);
    writeFiles(repo, { [`${ROOT}/0010_Overview.md`]: `# Overview\n\n${fence('T-1: A berth holds one vessel.')}\n` });
    commitAll(repo, 'retire T-2');
    const retiring = await pinned(repo);
    assert.deepEqual(retiring.pin.retired.map((r) => r.id), ['T-2']);
    publishRegistry(repo, retiring.pin);
    writeFiles(repo, { [`${ROOT}/0010_Overview.md`]: `# Overview\n\n${fence(RULES_1)}\n` });
    commitAll(repo, 'T-2 back');
    assert.deepEqual(refusedProblems(await pinIn(repo)), [{ type: 'rule-retired-reappears', id: 'T-2' }]);
  });
  it('pin.reword-same-id: a known id whose text changed keeps its id with the new hash (R5)', async () => {
    const repo = productRepo('reword', { kind: 'same-repo', root: ROOT });
    const first = await pinned(repo);
    publishRegistry(repo, first.pin);
    writeFiles(repo, { [`${ROOT}/0010_Overview.md`]: `# Overview\n\n## Berths\n\n${fence('T-1: Each berth holds at most one vessel.\nT-2: Tide windows are published daily.')}\n` });
    commitAll(repo, 'reword T-1');
    const second = await pinned(repo);
    assert.deepEqual(second.pin.rules.map((r) => r.id), ['T-1', 'T-2']);
    assert.notEqual(second.pin.rules[0]!.textSha256, first.pin.rules[0]!.textSha256);
    assert.equal(second.pin.rules[0]!.textSha256, sha256Hex('Each berth holds at most one vessel.'));
    assert.deepEqual([second.pin.retired, second.pin.highWater], [[], 2]);
  });
  it('pin.duplicate-across-files: one id in two files is refused', async () => {
    const repo = productRepo('dup', { kind: 'same-repo', root: ROOT }, RULES_1, { [`${ROOT}/0020_Tides.md`]: `# Tides\n\n${fence('T-2: again.')}\n` });
    await assert.rejects(pinIn(repo), /duplicate rule id T-2 \(also in 0010_Overview\.md\)/);
  });
});

describe('the published registry block', () => {
  it('registry.block-round-trip: rendered after the obligations block, read back, absent when not rendered', () => {
    const obligations = parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [], obligations: [], mapping: { paths: [] } });
    const registry = { highWater: 4, active: [{ id: ruleId('T-1'), textSha256: sha256('a'.repeat(64)) }], retired: [{ id: ruleId('T-3'), textSha256: sha256('b'.repeat(64)) }] };
    const text = renderInvariants(obligations, [], registry);
    assert.deepEqual(parseRulesRegistryBlock(text), registry);
    assert.deepEqual(parseInvariantsBlock(text), obligations);
    assert.equal(parseRulesRegistryBlock(renderInvariants(obligations, [])), null);
    assert.throws(() => parseRulesRegistryBlock(`${text}\n${text}`), /2 json roadmap-rules blocks/);
  });
});

describe('materialisation', () => {
  it('materialise.readonly-views: kept bytes, files 0444, the vision omitted from the gate view, reused once built', async () => {
    const repo = productRepo('mat', { kind: 'same-repo', root: ROOT });
    const { pin } = await pinned(repo);
    const runDir = absPath(tmpDir('mat-run'));
    const bytesOf = (f: { path: string }): Buffer => Buffer.from(git(repo, 'show', `HEAD:${ROOT}/${f.path}`) + '\n', 'utf8');
    const sha = pinSha256(pin);
    const full = materialiseCorpus(runDir, pin, sha, 'full', bytesOf);
    assert.equal(full, materialisedDir(runDir, sha, 'full'));
    assert.equal(full.split('/').at(-1), sha.slice(0, 8));
    assert.equal(readFileSync(join(full, VISION), 'utf8'), '# Vision\n\nA calm harbour.\n');
    assert.equal(statSync(join(full, '0070_ADRs/0001.md')).mode & 0o777, 0o444);
    const gate = materialiseCorpus(runDir, pin, sha, 'without-vision', bytesOf);
    assert.equal(existsSync(join(gate, VISION)), false);
    assert.ok(existsSync(join(gate, '0010_Overview.md')));
    assert.equal(materialiseCorpus(runDir, pin, sha, 'full', () => { throw new Error('not re-read'); }), full);
    assert.throws(() => materialiseCorpus(absPath(tmpDir('mat-bad')), pin, sha, 'full', () => Buffer.from('tampered')), /hash to/);
    assert.equal(pinBytes(pin), readFileSync(pinFile(repo), 'utf8'));
  });
});

const BIN = fileURLToPath(new URL('../bin/roadmap', import.meta.url));
const roadmap = (args: readonly string[]) => runUntilExit(process.execPath, [BIN, ...args], { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/' }, timeoutMs: 20_000 });

describe('bin/roadmap corpus pin', () => {
  it('cli.corpus-pin: prints the pin and its sha256 (exit 0), or the refused row (exit 78)', { timeout: 60_000 }, async () => {
    const repo = productRepo('cli', { kind: 'same-repo', root: ROOT });
    const ok = await roadmap(['corpus', 'pin', '--repo', repo, '--commit', 'HEAD', '--out', pinFile(repo)]);
    assert.equal(ok.code, 0, ok.stderr);
    const printed = JSON.parse(ok.stdout) as { pin: unknown; sha256: string };
    assert.equal(printed.sha256, sha256Hex(readFileSync(pinFile(repo))));
    assert.deepEqual(printed.pin, JSON.parse(readFileSync(pinFile(repo), 'utf8')));
    const empty = makeRepo(tmpDir('cli-noguide'), { files: { 'README.md': 'x\n' } });
    const no = await roadmap(['corpus', 'pin', '--repo', empty, '--commit', 'HEAD', '--out', pinFile(empty)]);
    assert.equal(no.code, 78, no.stderr);
    assert.deepEqual(JSON.parse(no.stdout), { refused: { kind: 'corpus-invalid', problems: [{ type: 'guide-missing' }] } });
    assert.equal(existsSync(pinFile(empty)), false);
  });
});
