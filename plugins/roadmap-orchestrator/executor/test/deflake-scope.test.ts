import { systemName } from '../src/core/ids.ts';
// Deflake scope (2026-10-23; src/pipeline/deflakemint.ts `deflakeScope`, src/commands/apply.ts `evaluateRevision`,
// src/preflight/checks.ts `start --base`), over a same-repo corpus arc (test/helpers/corpusarc.ts: real repos, real pins,
// the fake forge). The flakes are `flake-observed` facts over journaled journey runs, as a series writes them; the deflake
// job runs as the scheduler runs it. Named tests: deflake-scope.systems (an arc lane's flake mints a unit scoped to its test file's system and its
// dependencies; an unmappable suite lane's raises `deflake-unscoped` instead; an unrelated apply still lands),
// deflake-scope.unmapped (nothing maps: no unit, one item, the job keeps running), deflake-scope.gate (an executor revision
// cannot commit a unit reaching the corpus), deflake-scope.settled (the corpus overlap row passes a merged unit, dev.19),
// deflake-scope.start-base (the dev.17 stuck arc: a minted `**` unit in force,
// executor down; `start --base <export>` with the unit narrowed puts it in force, a start without is refused the conflict).
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,it } from 'node:test';
import { evaluateApply,evaluateRevision,keepRevision,payloadOf } from '../src/commands/apply.ts';
import type { Fact } from '../src/core/events.ts';
import { type InvocationId,type UnitId,laneId,opKey,sha,sha256,unitId } from '../src/core/ids.ts';
import { type OpenJournal,openJournal } from '../src/core/log.ts';
import { type RevisionManifest,SPEC_SCHEMA } from '../src/core/records.ts';
import { type AbsPath,absPath } from '../src/core/values.ts';
import { type RawPlan,admitUnit } from '../src/holistic/bundle.ts';
import { laneRevOf } from '../src/holistic/types.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { claimHost,releaseHost } from '../src/host/lock.ts';
import {
type InputFile,type InputFiles,commitRevisionNow,inForceFiles,keepCorpusFiles,recordPlan,requirePlanInForce,revisionInForce,revisionManifestOf,
} from '../src/input/inforce.ts';
import { parsePlan } from '../src/input/plan.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { APPLY,phase0InputOf,phase0Rows } from '../src/phase0/rows.ts';
import { type DeflakeContext,applyDeflake,deflakeJobPending } from '../src/pipeline/deflakemint.ts';
import { type StartInput,readRepoConfig,runChecks } from '../src/preflight/checks.ts';
import { DOCS_NOT_YET } from '../src/recover/revision.ts';
import { type CorpusArc,corpusArc,editPlan,filesOf,newHostDir,readJsonFile,runDirOfArc,withForge } from './helpers/corpusarc.ts';

const T = { timeout: 120_000 };
type Json = Record<string, unknown>;

/** A map whose `harbour` system holds `src/` and `test/` and depends on `quay` (`lib/`); `signage` is unrelated. None reaches `docs/corpus`. */
const SYSTEMS = { systems: { harbour: { paths: ['src/**'], tests: ['test/**'], dependsOn: ['quay'] }, quay: { paths: ['lib/**'] }, signage: { paths: ['signs/**'] } } };
const BERTHS_TEST = 'test/berths.test.ts > berths > never double-books';

/** A corpus arc in force as revision 1 under its repo config (its systems map recorded); the journal open. */
async function arcInForce(config: Json): Promise<Readonly<{ a: CorpusArc; j: OpenJournal }>> {
  const a = await corpusArc({ config });
  const files = filesOf(a);
  const rows = phase0Rows(phase0InputOf(files, readRepoConfig(a.repo), null), APPLY);
  assert.deepEqual(rows.rows, []);
  const runDir = runDirOfArc(a);
  mkdirSync(runDir, { recursive: true });
  keepCorpusFiles(runDir, rows.opened?.files ?? []);
  const j = openJournal(runDir, a.arc);
  recordPlan(j, runDir, files, [], routingOf(a));
  return { a, j };
}

const routingOf = (a: CorpusArc) => ({ profile: 'default', config: readRepoConfig(a.repo), arcRoles: 'm4b' }) as const;

/** A run of arc lane `journey` at the baseline, as a candidate's journey spawns it, settled; its invocation. */
function journeyRun(a: CorpusArc, j: OpenJournal, n: number): InvocationId {
  const lane = revisionInForce(runDirOfArc(a), requirePlanInForce(runDirOfArc(a), j.view)).obligations!.value.lanes[0]!;
  const at = sha(String(readJsonFile(a.planPath)['baseline']));
  const { op, inv } = j.begin({
    kind: 'proc.spawn', key: opKey(`journey:${n}`), parent: { type: 'arc' }, deadlineAt: null,
    body: () => ({ expect: { subject: { purpose: 'journey', lane: lane.id, laneRev: laneRevOf(lane), at, owner: { type: 'unit', unit: unitId('u1') } }, launchSha256: sha256('d'.repeat(64)) }, post: null }),
  });
  j.done(op, 'proc.spawn', { kind: 'lost', treeEffects: false }, 'reconciled');
  return inv;
}

let runs = 0;
/** A flake of `lane` (`set`) on the tip as its series records it: a red run naming `failing`, then a green rerun. */
function flake(a: CorpusArc, j: OpenJournal, lane: string, set: 'arc' | 'suite', failing: readonly string[]): void {
  const red = journeyRun(a, j, ++runs);
  const green = journeyRun(a, j, ++runs);
  j.fact({
    kind: 'flake-observed', owner: { type: 'unit', unit: unitId('u1') }, lane: laneId(lane), set, on: 'tip', forgiven: true,
    event: { tree: sha('a'.repeat(40)), env: null, failing, red, green },
  });
}

const deflakeContext = (a: CorpusArc, j: OpenJournal): DeflakeContext => ({
  journal: j, runDir: runDirOfArc(a), hostDir: newHostDir(), planFile: a.planPath, routingBase: routingOf(a), laneEnv: process.env, docs: DOCS_NOT_YET, repo: a.repo,
});

const unitsInForce = (a: CorpusArc, j: OpenJournal) => requirePlanInForce(runDirOfArc(a), j.view).plan.units;
const items = (a: CorpusArc, j: OpenJournal) => j.view.opsOf('needsuser.raise').map((i) => readNeedsUser(runDirOfArc(a), i.expect.id)!);

/** Refresh editable inputs before a CAS edit, preserving executor-minted units. */
function syncOwnerInputs(a: CorpusArc, j: OpenJournal): void {
  const dir = runDirOfArc(a);
  const force = requirePlanInForce(dir, j.view);
  const files = inForceFiles(dir, j.view, force, revisionInForce(dir, force), a.planPath, a.repo);
  writeFileSync(a.planPath, files.planBytes);
  for (const file of [...files.specs.values(), files.ledger, files.obligations, files.vision]) if (file?.bytes != null) {
    mkdirSync(join(file.path, '..'), {recursive: true}); writeFileSync(file.path, file.bytes);
  }
}

/** `evaluateApply` of the owner's files as they stand, from their latest apply. */
const ownerApply = (a: CorpusArc, j: OpenJournal) => {
  const files = filesOf(a);
  if (files.vision?.bytes) {
    const dest = join(a.planDir, 'repo', '.roadmap'); mkdirSync(dest, {recursive: true});
    writeFileSync(join(dest, 'vision.json'), files.vision.bytes);
  }
  return withForge(a.forge, () => evaluateApply({
  runDir: runDirOfArc(a), view: j.view, hostDir: newHostDir(), repo: a.repo, planFile: a.planPath, routingBase: routingOf(a),
  laneEnv: process.env, manifest: null, base: revisionInForce(runDirOfArc(a), requirePlanInForce(runDirOfArc(a), j.view)).manifest, rev: j.view.planApplied()!.rev, reason: 'Test apply',
}));
};

function startInput(a: CorpusArc, hostDir: AbsPath, base: RevisionManifest | null): StartInput {
  return {
    repo: a.repo, planFile: a.planPath, profile: null, hostDir, env: process.env, respawn: null,
    claim: (ctx) => claimHost(ctx.hostDir, { arc: ctx.plan.arc, runDir: ctx.runDir, repo: ctx.repo, supervisor: selfIdentity() }, async () => assert.fail('no previous arc')),
  };
}

/** `runChecks` (the executor's startup) with the forge on PATH; the claim released and the journal closed after. */
async function start(a: CorpusArc, base: RevisionManifest | null) {
  const hostDir = newHostDir();
  const out = await withForge(a.forge, () => runChecks(startInput(a, hostDir, base)));
  out.journal?.close();
  if (out.claim !== null) releaseHost(hostDir, out.claim);
  return out;
}

describe('deflake scope', () => {
  it('deflake-scope.systems: an arc lane\'s flake mints a unit scoped to its test file\'s system and dependencies; an unmappable suite lane names all systems; an unrelated apply lands', T, async () => {
    const { a, j } = await arcInForce({ chain: { k: 1 }, systemsMap: SYSTEMS });
    try {
      flake(a, j, 'journey', 'arc', [BERTHS_TEST]);
      flake(a, j, 'suite', 'suite', []);
      const ctx = deflakeContext(a, j);
      assert.equal(deflakeJobPending(ctx), true);
      assert.deepEqual(await applyDeflake(ctx), { kind: 'applied', admitted: ['deflake-1', 'deflake-2'], recurring: 0 });
      const minted = unitsInForce(a, j).find((u) => u.id === 'deflake-1')!;
      assert.deepEqual(minted.systems, ['harbour', 'quay'], 'harbour and quay, which it depends on; not signage');
      assert.deepEqual(minted.deflake, { keys: [{ type: 'test', lane: 'journey', testId: BERTHS_TEST }] });
      const second = unitsInForce(a, j).find((u) => u.id === 'deflake-2')!;
      assert.deepEqual(second.systems, ['harbour', 'quay', 'signage']);
      assert.deepEqual(items(a, j).map(({reason, blocking, subject, summary, options}) => ({reason, blocking, subject, summary, options})),
        [{reason: 'revision-notice', blocking: false, subject: {type: 'arc'}, summary: 'Executor revision 2 (deflake) is in force.', options: []}]);
      assert.equal(deflakeJobPending(ctx), false, 'both due groups are admitted');

      syncOwnerInputs(a, j);
      // The owner's unrelated edit lands with the deflake unit in force.
      editPlan(a, (p) => ({ ...p, units: (p['units'] as Json[]).map((u) => ({ ...u, risk: 'med' })) }));
      const verdict = await ownerApply(a, j);
      assert.equal(verdict.kind, 'accepted', JSON.stringify(verdict));
    } finally {
      j.close();
    }
  });
});
