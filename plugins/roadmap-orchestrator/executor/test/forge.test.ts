// M4a step A3: the forge module (src/forge/) and the host act `roadmap pr`, against the stateful fake `gh`
// (test/fakes/fake-gh.ts, first on PATH) and local bare origins. Named tests: pr.stacked-bases, pr.body-merge-commits,
// pr.retarget-and-squash-flag, pr.idempotent-rerun, pr.supersede-previous, push.lease, push.never-main.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { openPr } from '../src/commands/pr.ts';
import { type ArcId, type Sha, amendmentIdOf, arcId, divergenceIdOf, ruleId, sha } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { type AbsPath, absPath, branchName } from '../src/core/values.ts';
import { MERGE_COMMIT_LINE } from '../src/forge/pr.ts';
import { PushError, pushBranch, pushWithLease } from '../src/forge/push.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { snapshotRequestOf } from '../src/git/snapshot.ts';
import { CliError, runDir as runDirOf } from '../src/input/cli.ts';
import { readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { executorIdentity } from '../src/pipeline/stages.ts';
import { snapshotPublishOp } from '../src/recover/ops.ts';
import { runOp } from './fixtures/git-common.ts';
import { BASE } from './fixtures/route-common.ts';
import { setupArc } from './fixtures/unit-common.ts';
import { type Forge, makeForge } from './helpers/forge.ts';
import { attachOrigin, makeBareOrigin, mergeOnOrigin, originBranches, originRef } from './helpers/origin.ts';
import { git, revParse, tmpDir } from './helpers/repo.ts';

const T = { timeout: 120_000 };

/** Puts `forge`'s fake gh first on PATH for the in-process calls of one test. */
function using(forge: Forge): void {
  process.env['PATH'] = forge.path;
}
const ORIGINAL_PATH = process.env['PATH'];
const restorePath = (): void => {
  process.env['PATH'] = ORIGINAL_PATH;
};

// ---------------------------------------------------------------------------------------------------
// PRs and pushes over sealed arcs: each arc's run is reduced to what `roadmap pr` reads from its verified ref (the
// plan in force, its corpus amendments, `arc-completed`), as gc.test.ts seals one.

type Stack = Readonly<{ repo: AbsPath; origin: string; forge: Forge; planPath: string }>;

function newStack(): Stack {
  const d = setupArc({ steps: [] });
  const origin = makeBareOrigin();
  attachOrigin(d.repo, origin);
  return { repo: absPath(d.repo), origin, forge: makeForge({ originPath: origin }), planPath: d.planPath };
}

type Sealed = Readonly<{ arc: ArcId; branch: string; head: Sha }>;

/** A commit on `branch` (cut from `from`), then the arc's plan, amendments, completion and terminal snapshot. */
async function sealArc(s: Stack, name: string, from: string, previous: Sealed | null, amendments = 0): Promise<Sealed> {
  const arc = arcId(name);
  const branch = `roadmap/${name}`;
  git(s.repo, 'checkout', '--quiet', '-B', branch, from);
  writeFileSync(join(s.repo, `${name}.txt`), `${name}\n`);
  git(s.repo, 'add', `${name}.txt`);
  git(s.repo, 'commit', '--quiet', '-m', `${name} work`);
  const head = sha(revParse(s.repo, 'HEAD'));
  git(s.repo, 'checkout', '--quiet', 'main');
  const planDir = tmpDir('pr-plan');
  cpSync(dirname(s.planPath), planDir, { recursive: true });
  const planPath = join(planDir, 'plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(planPath, JSON.stringify({ ...plan, arc, integrationBranch: branch, ...(previous === null ? {} : { chain: { previousArc: previous.arc, previousHead: previous.head } }) }));
  const runDir = runDirOf(gitCommonDir(s.repo), arc);
  mkdirSync(runDir, { recursive: true });
  const j = openJournal(runDir, arc);
  try {
    const applied = recordPlan(j, runDir, readInputFiles(absPath(planPath), absPath(s.repo)), [], BASE);
    for (let n = 1; n <= amendments; n++) {
      j.fact({
        kind: 'corpus-amendment', id: amendmentIdOf(n), source: { type: 'divergence', divergence: divergenceIdOf(n) }, rules: [ruleId(`T-${n}`)],
        proposal: `Tighten rule T-${n}.`, why: `divergence D-${n}`, evidence: [],
      });
    }
    j.fact({ kind: 'arc-completed', planRev: applied.rev, head, highWater: j.view.highWater(), units: [] });
    await runOp(j, snapshotPublishOp(s.repo), `snapshot:${arc}`, snapshotRequestOf({ view: j.view, runDir, identity: executorIdentity(), message: `roadmap ${arc}: terminal snapshot\n` }));
  } finally {
    j.close();
  }
  return { arc, branch, head };
}

const pullOf = (forge: Forge, head: string) => {
  const hits = forge.read().pulls.filter((p) => p.headRefName === head);
  assert.equal(hits.length, 1, `one PR for ${head}`);
  return hits[0]!;
};

describe('pr', () => {
  it('pr.stacked-bases and pr.body-merge-commits: PR 1 → main, PR 2 → arc 1; bodies say merge commits and list amendments', T, async () => {
    const s = newStack();
    const mainBefore = originRef(s.origin, 'main');
    const a1 = await sealArc(s, 'arc-1', 'main', null, 2);
    const a2 = await sealArc(s, 'arc-2', a1.head, a1);
    using(s.forge);
    try {
      const pr1 = await openPr({ repo: s.repo, arc: a1.arc, supersedePrevious: false });
      const pr2 = await openPr({ repo: s.repo, arc: a2.arc, supersedePrevious: false });
      assert.deepEqual({ base: pr1.base, created: pr1.created, retargeted: pr1.retargeted, needsRebase: pr1.needsRebase }, { base: 'main', created: true, retargeted: false, needsRebase: false });
      assert.deepEqual({ base: pr2.base, created: pr2.created, needsRebase: pr2.needsRebase }, { base: a1.branch, created: true, needsRebase: false });
      assert.equal(pullOf(s.forge, a1.branch).baseRefName, 'main');
      assert.equal(pullOf(s.forge, a2.branch).baseRefName, a1.branch);
      assert.equal(pullOf(s.forge, a2.branch).url, pr2.url);
      const branches = originBranches(s.origin);
      assert.equal(branches[a1.branch], a1.head);
      assert.equal(branches[a2.branch], a2.head);
      assert.equal(originRef(s.origin, 'main'), mainBefore, 'origin main unchanged');
      const body1 = pullOf(s.forge, a1.branch).body;
      const body2 = pullOf(s.forge, a2.branch).body;
      for (const body of [body1, body2]) assert.ok(body.includes(MERGE_COMMIT_LINE), body);
      assert.match(body1, /`arc-1\/M-1` \(T-1\): Tighten rule T-1\./);
      assert.match(body1, /`arc-1\/M-2` \(T-2\)/);
      assert.match(body2, /None\./);
      assert.match(body2, /Stacked on arc `arc-1`/);
    } finally {
      restorePath();
    }
  });

  it('pr.idempotent-rerun: a second run finds both PRs, pushes and mutates nothing', T, async () => {
    const s = newStack();
    const a1 = await sealArc(s, 'arc-1', 'main', null);
    const a2 = await sealArc(s, 'arc-2', a1.head, a1);
    using(s.forge);
    try {
      const first = [await openPr({ repo: s.repo, arc: a1.arc, supersedePrevious: false }), await openPr({ repo: s.repo, arc: a2.arc, supersedePrevious: false })];
      const mutations = s.forge.read().mutations.length;
      const branches = originBranches(s.origin);
      const again = [await openPr({ repo: s.repo, arc: a1.arc, supersedePrevious: false }), await openPr({ repo: s.repo, arc: a2.arc, supersedePrevious: false })];
      assert.deepEqual(again, first.map((p) => ({ ...p, created: false })));
      assert.equal(s.forge.read().mutations.length, mutations, 'no forge mutation');
      assert.equal(s.forge.read().pulls.length, 2);
      assert.deepEqual(originBranches(s.origin), branches);
    } finally {
      restorePath();
    }
  });

  it('pr.retarget-and-squash-flag: a merge-commit merged base re-targets to its base; a squash flags needs-rebase', T, async () => {
    for (const method of ['merge', 'squash'] as const) {
      const s = newStack();
      const a1 = await sealArc(s, 'arc-1', 'main', null);
      const a2 = await sealArc(s, 'arc-2', a1.head, a1);
      using(s.forge);
      try {
        const pr1 = await openPr({ repo: s.repo, arc: a1.arc, supersedePrevious: false });
        await openPr({ repo: s.repo, arc: a2.arc, supersedePrevious: false });
        const oid = mergeOnOrigin(s.origin, 'main', a1.branch, method);
        s.forge.setPullState(pr1.number, 'MERGED', oid);
        const after = await openPr({ repo: s.repo, arc: a2.arc, supersedePrevious: false });
        if (method === 'merge') {
          assert.deepEqual({ base: after.base, retargeted: after.retargeted, needsRebase: after.needsRebase, created: after.created }, { base: 'main', retargeted: true, needsRebase: false, created: false });
          assert.equal(pullOf(s.forge, a2.branch).baseRefName, 'main');
          const again = await openPr({ repo: s.repo, arc: a2.arc, supersedePrevious: false });
          assert.equal(again.retargeted, false, 'a second run finds it re-targeted');
        } else {
          assert.deepEqual({ base: after.base, retargeted: after.retargeted, needsRebase: after.needsRebase }, { base: a1.branch, retargeted: false, needsRebase: true });
          assert.equal(pullOf(s.forge, a2.branch).baseRefName, a1.branch);
        }
        const merged = await openPr({ repo: s.repo, arc: a1.arc, supersedePrevious: false });
        assert.deepEqual({ number: merged.number, created: merged.created, base: merged.base }, { number: pr1.number, created: false, base: 'main' });
      } finally {
        restorePath();
      }
    }
  });

  it('pr.supersede-previous: arc 2 carrying arc 1\'s PR fixes supersedes its open PR (created or rewritten): it targets main, its body names PR 1, PR 1 is closed with a comment; reruns keep it, a stacked arc 3 walks past it, and the refusals', T, async () => {
    const s = newStack();
    const a1 = await sealArc(s, 'arc-1', 'main', null);
    const a2 = await sealArc(s, 'arc-2', a1.head, a1);
    const a3 = await sealArc(s, 'arc-3', a2.head, a2);
    using(s.forge);
    const pr = (arc: Sealed, supersedePrevious = false) => openPr({ repo: s.repo, arc: arc.arc, supersedePrevious });
    try {
      await assert.rejects(pr(a1, true), (e: unknown) => e instanceof CliError && /first of its chain/.test(e.message));
      await assert.rejects(pr(a2, true), (e: unknown) => e instanceof CliError && /arc-1 has no open PR/.test(e.message));
      const pr1 = await pr(a1);
      // Created superseding: arc 2's PR is new.
      const pr2 = await pr(a2, true);
      assert.deepEqual({ base: pr2.base, created: pr2.created, supersedes: pr2.supersedes }, { base: 'main', created: true, supersedes: pr1.url });
      assert.ok(pullOf(s.forge, a2.branch).body.startsWith(`Roadmap arc \`arc-2\``), 'the code-rendered body');
      assert.match(pullOf(s.forge, a2.branch).body, new RegExp(`^Supersedes ${pr1.url} \\(arc \`arc-1\`\\)`, 'm'));
      assert.equal(pullOf(s.forge, a1.branch).state, 'CLOSED');
      const close = s.forge.read().mutations.filter((m) => m.kind === 'pr-close');
      assert.deepEqual(close.map((m) => m.kind === 'pr-close' && [m.number, m.comment?.includes(pr2.url)]), [[pr1.number, true]], 'closed once, naming its successor');
      const mutations = s.forge.read().mutations.length;
      assert.deepEqual(await pr(a2), { ...pr2, created: false }, 'a plain rerun keeps the supersession');
      assert.deepEqual(await pr(a2, true), { ...pr2, created: false }, 'a flagged rerun changes nothing');
      assert.equal(s.forge.read().mutations.length, mutations, 'no forge mutation on rerun');
      await assert.rejects(pr(a1), (e: unknown) => e instanceof CliError && /closed unmerged; when a later arc's PR superseded it/.test(e.message));
      // Arc 3 stacks on arc 2; once arc 2 merges with a merge commit, the walk passes arc 2 and the arc 1 it superseded.
      assert.equal((await pr(a3)).base, a2.branch);
      s.forge.setPullState(pr2.number, 'MERGED', mergeOnOrigin(s.origin, 'main', a2.branch, 'merge'));
      assert.deepEqual(await pr(a3).then((p) => [p.base, p.retargeted]), ['main', true]);
      await assert.rejects(pr(a3, true), (e: unknown) => e instanceof CliError && /arc-2's PR .* merged already/.test(e.message));
    } finally {
      restorePath();
    }

    // Rewritten superseding: arc 2's PR was open on arc 1's branch first.
    const t = newStack();
    const b1 = await sealArc(t, 'arc-1', 'main', null);
    const b2 = await sealArc(t, 'arc-2', b1.head, b1);
    using(t.forge);
    try {
      const q1 = await openPr({ repo: t.repo, arc: b1.arc, supersedePrevious: false });
      const q2 = await openPr({ repo: t.repo, arc: b2.arc, supersedePrevious: false });
      assert.equal(q2.base, b1.branch);
      const again = await openPr({ repo: t.repo, arc: b2.arc, supersedePrevious: true });
      assert.deepEqual({ number: again.number, base: again.base, retargeted: again.retargeted, supersedes: again.supersedes }, { number: q2.number, base: 'main', retargeted: true, supersedes: q1.url });
      assert.equal(pullOf(t.forge, b2.branch).baseRefName, 'main');
      assert.match(pullOf(t.forge, b2.branch).body, /^Supersedes /m);
      assert.equal(pullOf(t.forge, b1.branch).state, 'CLOSED');
    } finally {
      restorePath();
    }
  });

  it('refuses an arc that has not completed and a PR the owner closed unmerged', T, async () => {
    const s = newStack();
    const a1 = await sealArc(s, 'arc-1', 'main', null);
    using(s.forge);
    try {
      await assert.rejects(openPr({ repo: s.repo, arc: arcId('arc-9'), supersedePrevious: false }), (e: unknown) => e instanceof CliError && /no refs\/roadmap\/arc-9/.test(e.message));
      const pr1 = await openPr({ repo: s.repo, arc: a1.arc, supersedePrevious: false });
      s.forge.setPullState(pr1.number, 'CLOSED');
      await assert.rejects(openPr({ repo: s.repo, arc: a1.arc, supersedePrevious: false }), (e: unknown) => e instanceof CliError && /closed unmerged/.test(e.message));
    } finally {
      restorePath();
    }
  });
});

describe('push', () => {
  it('push.lease: fast-forwards its own ancestor; refuses a diverged remote and a stale lease, leaving origin as it was', T, async () => {
    const s = newStack();
    const a1 = await sealArc(s, 'arc-1', 'main', null);
    const branch = branchName(a1.branch);
    const parent = sha(revParse(s.repo, `${a1.head}^`));
    assert.deepEqual(pushBranch(s.repo, branch, parent), { kind: 'pushed', previous: null });
    assert.deepEqual(pushBranch(s.repo, branch, a1.head), { kind: 'pushed', previous: parent });
    assert.deepEqual(pushBranch(s.repo, branch, a1.head), { kind: 'up-to-date' });

    // Someone else's commit on the remote branch: not in the arc's history, so refused, not overwritten.
    const other = tmpDir('pr-other');
    git(other, 'clone', '--quiet', s.origin, '.');
    git(other, 'checkout', '--quiet', a1.branch);
    git(other, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'foreign');
    git(other, 'push', '--quiet', 'origin', a1.branch);
    const foreign = originRef(s.origin, a1.branch);
    assert.throws(() => pushBranch(s.repo, branch, a1.head), (e: unknown) => e instanceof PushError && /not in the history/.test(e.message));
    assert.equal(originRef(s.origin, a1.branch), foreign);

    // The lease: a push expecting the tip it read earlier is refused once the branch moved.
    assert.throws(() => pushWithLease(s.repo, branch, a1.head, a1.head), PushError);
    assert.equal(originRef(s.origin, a1.branch), foreign);
    const fresh = branchName('roadmap/fresh');
    assert.throws(() => pushWithLease(s.repo, branchName(a1.branch), a1.head, null), PushError, 'expecting absence on an existing branch');
    pushWithLease(s.repo, fresh, a1.head, null);
    assert.equal(originRef(s.origin, 'roadmap/fresh'), a1.head);
  });

  it('push.never-main: neither push form touches main', T, () => {
    const s = newStack();
    const before = originRef(s.origin, 'main');
    git(s.repo, 'commit', '--quiet', '--allow-empty', '-m', 'local main work');
    const head = sha(revParse(s.repo, 'main'));
    const main = branchName('main');
    assert.throws(() => pushBranch(s.repo, main, head), (e: unknown) => e instanceof PushError && /refusing to push main/.test(e.message));
    assert.throws(() => pushWithLease(s.repo, main, head, before === null ? null : sha(before)), PushError);
    assert.equal(originRef(s.origin, 'main'), before);
  });
});
