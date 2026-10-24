// M4a test support (step 0b): the stateful fake `gh`, the bare-origin and corpus helpers, and the fake backend's
// packReview and new checkpoint fields. The fakes are exercised through their real entry points (PATH shims).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CORPUS_GUIDE_FENCE, parseCorpusGuide } from '../src/corpus/types.ts';
import { validateCheckpointOutput, validatePackReviewOutput } from '../src/prompts/schemas.ts';
import { DEFAULT_REPO, type Forge, makeForge } from './helpers/forge.ts';
import { checkpointAnswer, checkpointStep, packReviewAnswer, packReviewStep, packTargetOf } from './helpers/holistic.ts';
import { buildCorpus, sampleCorpus } from './helpers/corpus.ts';
import { attachOrigin, makeBareOrigin, makeRepoWithOrigin, mergeOnOrigin, originBranches, originRef } from './helpers/origin.ts';
import { git, makeRepo, tmpDir } from './helpers/repo.ts';
import { writeScenario } from './helpers/scenario.ts';

type Run = Readonly<{ status: number | null; stdout: string; stderr: string }>;
const gh = (forge: Forge, args: readonly string[], cwd: string = forge.dir): Run => {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', env: { PATH: forge.path } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const ok = (r: Run): Run => {
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const data = (r: Run): unknown => JSON.parse(ok(r).stdout);

const { host, owner, name } = DEFAULT_REPO;

describe('fakes.gh-repo-view', () => {
  it('answers the identity the store holds, in gh\'s shape, and refuses another repo or host', () => {
    const forge = makeForge();
    assert.deepEqual(data(gh(forge, ['repo', 'view', '--json', 'owner,name,url'])), {
      owner: { id: 'MDQ6VXNlcjE=', login: owner }, name, url: `https://${host}/${owner}/${name}`,
    });
    assert.equal(gh(forge, ['repo', 'view', 'someone/else', '--json', 'name']).status, 1);
    const wrongHost = spawnSync('gh', ['repo', 'view', '--json', 'name'], { cwd: forge.dir, encoding: 'utf8', env: { PATH: forge.path, GH_HOST: 'github.com' } });
    assert.equal(wrongHost.status, 1);
    assert.equal(gh(forge, ['repo', 'view']).status, 99, 'text output is not a call the fake knows');
  });
});

describe('fakes.gh-pr', () => {
  function withOrigin() {
    const { work, origin } = makeRepoWithOrigin({ files: { 'a.txt': 'one\n' } });
    for (const b of ['arc1', 'arc2']) {
      git(work, 'checkout', '--quiet', '-b', b);
      git(work, 'commit', '--quiet', '--allow-empty', '--message', b);
      git(work, 'push', '--quiet', 'origin', b);
    }
    const forge = makeForge({ originPath: origin });
    return { work, origin, forge };
  }

  it('create needs a pushed head, prints the URL, lists by head and records the mutation', () => {
    const { forge } = withOrigin();
    const body = join(forge.dir, 'body.md');
    writeFileSync(body, 'merges with merge commits\n');
    assert.equal(gh(forge, ['pr', 'create', '--base', 'main', '--head', 'unpushed', '--title', 't', '--body-file', body]).status, 1);
    const created = ok(gh(forge, ['pr', 'create', '--base', 'main', '--head', 'arc1', '--title', 'Arc 1', '--body-file', body]));
    assert.equal(created.stdout, `https://${host}/${owner}/${name}/pull/1\n`);
    assert.equal(gh(forge, ['pr', 'create', '--base', 'main', '--head', 'arc1', '--title', 'again', '--body', 'x']).status, 1, 'a duplicate open PR');
    const listed = data(gh(forge, ['pr', 'list', '--head', 'arc1', '--state', 'open', '--json', 'number,baseRefName,headRefName,state,body'])) as object[];
    assert.deepEqual(listed, [{ number: 1, baseRefName: 'main', headRefName: 'arc1', state: 'OPEN', body: 'merges with merge commits\n' }]);
    assert.deepEqual(data(gh(forge, ['pr', 'list', '--head', 'arc2', '--json', 'number'])), []);
    assert.deepEqual(forge.read().mutations, [{ call: 2, kind: 'pr-create', number: 1, base: 'main', head: 'arc1', title: 'Arc 1' }]);
  });

  it('edit re-targets the base (which must exist on origin) and a merged PR leaves the open list', () => {
    const { forge } = withOrigin();
    ok(gh(forge, ['pr', 'create', '--base', 'arc1', '--head', 'arc2', '--title', 'Arc 2', '--body', 'b']));
    assert.equal(gh(forge, ['pr', 'edit', '1', '--base', 'nope']).status, 1);
    ok(gh(forge, ['pr', 'edit', 'arc2', '--base', 'main']));
    assert.deepEqual(data(gh(forge, ['pr', 'view', '1', '--json', 'baseRefName,mergeCommit'])), { baseRefName: 'main', mergeCommit: null });
    forge.setPullState(1, 'MERGED', 'a'.repeat(40));
    assert.deepEqual(data(gh(forge, ['pr', 'list', '--head', 'arc2', '--json', 'number'])), []);
    assert.deepEqual(data(gh(forge, ['pr', 'list', '--head', 'arc2', '--state', 'merged', '--json', 'number,state,mergeCommit'])), [{ number: 1, state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } }]);
    assert.deepEqual(forge.read().mutations.map((m) => m.kind), ['pr-create', 'pr-edit']);
    assert.equal(gh(forge, ['pr', 'list', '--json', 'nonsense']).status, 1);
  });

  it('a call the fake does not know exits 99 and is logged, so nothing succeeds silently', () => {
    const forge = makeForge();
    const r = gh(forge, ['release', 'create', 'v1']);
    assert.equal(r.status, 99);
    assert.match(r.stderr, /not a call the fake knows/);
    assert.equal(gh(forge, ['pr', 'merge', '1']).status, 99);
    assert.equal(gh(forge, ['api', 'graphql']).status, 99, 'no forge API call is known: the executor reads only PRs');
    assert.deepEqual(forge.calls().map((c) => [c.argv[0], c.status]), [['release', 99], ['pr', 99], ['api', 99]]);
    assert.deepEqual(forge.read().mutations, []);
  });
});

describe('fakes.origin', () => {
  it('a bare origin takes pushes; originRef and originBranches read it', () => {
    const repo = makeRepo(tmpDir('repo'), { files: { 'a.txt': 'one\n' } });
    const origin = makeBareOrigin();
    assert.equal(originRef(origin, 'main'), null);
    attachOrigin(repo, origin);
    assert.equal(originRef(origin, 'main'), git(repo, 'rev-parse', 'HEAD'));
    assert.deepEqual(Object.keys(originBranches(origin)), ['main']);
  });

  it('mergeOnOrigin: merge keeps both parents; squash leaves a single-parent commit with the branch unreachable', () => {
    for (const method of ['merge', 'squash'] as const) {
      const { work, origin } = makeRepoWithOrigin({ files: { 'a.txt': 'one\n' } });
      git(work, 'checkout', '--quiet', '-b', 'arc1');
      git(work, 'commit', '--quiet', '--allow-empty', '--message', 'arc work');
      writeFileSync(join(work, 'b.txt'), 'two\n');
      git(work, 'add', 'b.txt');
      git(work, 'commit', '--quiet', '--message', 'b');
      git(work, 'push', '--quiet', 'origin', 'arc1');
      const tip = originRef(origin, 'arc1') as string;
      const merged = mergeOnOrigin(origin, 'main', 'arc1', method);
      assert.equal(originRef(origin, 'main'), merged);
      const parents = git(origin, 'rev-list', '--parents', '-n', '1', merged).split(' ').length - 1;
      assert.equal(parents, method === 'merge' ? 2 : 1);
      const reachable = spawnSync('git', ['-C', origin, 'merge-base', '--is-ancestor', tip, merged]).status === 0;
      assert.equal(reachable, method === 'merge');
      assert.equal(git(origin, 'show', `${merged}:b.txt`), 'two');
    }
  });
});

describe('fakes.corpus', () => {
  it('builds a same-repo corpus: a guide the frozen reader accepts, rules blocks, a rules-free vision doc, the expected rules', () => {
    const built = sampleCorpus();
    assert.deepEqual(Object.keys(built.files).sort(), [
      '.roadmap/corpus.md', 'docs/corpus/0005_Vision.md', 'docs/corpus/0010_Overview.md', 'docs/corpus/0020_Berths.md',
    ]);
    const block = new RegExp(`\`\`\`${CORPUS_GUIDE_FENCE}\\n([\\s\\S]*?)\\n\`\`\``).exec(built.guide)?.[1];
    assert.ok(block !== undefined);
    const guide = parseCorpusGuide(JSON.parse(block));
    assert.deepEqual(guide.source, { kind: 'same-repo', root: 'docs/corpus' });
    assert.equal(guide.vision, '0005_Vision.md');
    assert.deepEqual(built.expected, [
      { id: 'T-1', text: 'A berth is never double-booked.', file: '0010_Overview.md', section: 'Scope' },
      { id: 'T-2', text: 'A booking names one berth and one tide window.', file: '0020_Berths.md', section: 'Booking' },
      { id: 'T-3', text: 'A cancelled booking frees its berth at once.', file: '0020_Berths.md', section: 'Booking' },
    ]);
    assert.ok(!built.corpusFiles['0005_Vision.md']?.includes('```rules'), 'no rules block in the vision doc');
    assert.match(built.files['docs/corpus/0020_Berths.md'] as string, /```rules\nT-2: A booking[^\n]*\nT-3: A cancelled[^\n]*\n```/);
  });

  it('a source other than same-repo keeps the corpus out of the product files', () => {
    const built = buildCorpus({
      docs: [{ path: 'a.md', title: 'A', sections: [{ heading: 'S', rules: [{ n: 1, text: 'x' }] }] }],
      source: { kind: 'checkout', remote: 'file:///origin.git', root: 'corpus' as never },
    });
    assert.deepEqual(Object.keys(built.files), ['.roadmap/corpus.md']);
    assert.deepEqual(Object.keys(built.corpusFiles), ['a.md']);
  });
});

describe('fakes.pack-review', () => {
  /** A claude call through the shim as job `job`, its prompt `stdin`; returns the structured output (or the exit code). */
  function claude(binDir: string, job: string, stdin: string): { code: number | null; out: unknown } {
    const r = spawnSync('claude', ['-p', '--session-id', '00000000-0000-4000-8000-000000000001'], {
      input: stdin, encoding: 'utf8', cwd: tmpDir('elsewhere'), env: { PATH: `${binDir}:/usr/bin:/bin`, RESOURCE_OWNER: `arc/${job}` },
    });
    const last = r.stdout.split('\n').filter((l) => l !== '').at(-1);
    return { code: r.status, out: last === undefined ? undefined : (JSON.parse(last) as { structured_output?: unknown }).structured_output };
  }

  it('answers per review job in its own order, blocking and note findings the frozen reader accepts', () => {
    const s = writeScenario(tmpDir('scenario'), [
      packReviewStep('review-1', [{ severity: 'blocking', target: packTargetOf.census('T-2'), claim: 'census omits T-2' }, { claim: 'a note' }]),
      packReviewStep('review-1', []),
      packReviewStep('review-2', [{ target: packTargetOf.unit('docks'), severity: 'note' }]),
    ]);
    // A prompt that mentions lens kinds in its plan text still takes the review job's step.
    const first = validatePackReviewOutput(claude(s.binDir, 'review-1', '{"audit": {"lens": "drift"}}').out);
    assert.deepEqual(first.findings.map((f) => [f.severity, f.target.type, f.claim]), [['blocking', 'census', 'census omits T-2'], ['note', 'plan', 'a note']]);
    assert.equal(validatePackReviewOutput(claude(s.binDir, 'review-2', 'inputs').out).findings[0]?.target.type, 'unit');
    assert.deepEqual(validatePackReviewOutput(claude(s.binDir, 'review-1', 'inputs').out).findings, []);
    assert.equal(claude(s.binDir, 'review-1', 'inputs').code, 99, 'no step left for review-1');
  });

  it('an answer the reader refuses is never built', () => {
    assert.throws(() => packReviewAnswer([{ severity: 'major' as 'note' }]));
    assert.throws(() => packReviewAnswer([{ target: { type: 'unit' } }]));
  });
});

describe('fakes.checkpoint-m4a', () => {
  it('carries corpusAmendments in the frozen shape through the shim', () => {
    const answer = checkpointAnswer({ decision: 'no-op', corpusAmendments: [{ rules: ['T-3'], proposal: 'reword', why: 'drift' }] });
    const s = writeScenario(tmpDir('scenario'), [checkpointStep('ckpt-1', answer)]);
    const r = spawnSync('claude', ['-p', '--session-id', '00000000-0000-4000-8000-000000000001'], {
      input: 'checkpoint inputs', encoding: 'utf8', cwd: tmpDir('elsewhere'), env: { PATH: `${s.binDir}:/usr/bin:/bin`, RESOURCE_OWNER: 'arc/ckpt-1' },
    });
    const out = validateCheckpointOutput((JSON.parse(r.stdout.split('\n').filter((l) => l !== '').at(-1) as string) as { structured_output: unknown }).structured_output);
    assert.deepEqual(out.corpusAmendments, [{ rules: ['T-3'], proposal: 'reword', why: 'drift' }]);
  });

  it('an answer always carries corpusAmendments (the schema requires it), empty unless its spec names some', () => {
    const plain = checkpointAnswer({ decision: 'no-op' }) as Record<string, unknown>;
    assert.deepEqual(plain['corpusAmendments'], []);
    assert.deepEqual(validateCheckpointOutput(plain).corpusAmendments, []);
  });
});
