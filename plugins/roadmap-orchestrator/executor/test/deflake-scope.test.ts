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
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { evaluateApply, evaluateRevision, keepRevision, payloadOf } from '../src/commands/apply.ts';
import { EXPORT_FILE, exportBase, exportInputs } from '../src/commands/inputs.ts';
import type { Fact } from '../src/core/events.ts';
import { atomicJson } from '../src/core/fsx.ts';
import { type InvocationId, type UnitId, laneId, opKey, sha, sha256, unitId } from '../src/core/ids.ts';
import { laneRevOf } from '../src/holistic/types.ts';
import { type OpenJournal, openJournal } from '../src/core/log.ts';
import { type RevisionManifest, SPEC_SCHEMA } from '../src/core/records.ts';
import { type AbsPath, absPath, isoTimeOf } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { START_FILE } from '../src/executor.ts';
import { type RawPlan, admitUnit } from '../src/holistic/bundle.ts';
import {
  type InputFile, type InputFiles, commitRevisionNow, inForceFiles, keepCorpusFiles, recordPlan, requirePlanInForce, revisionInForce, revisionManifestOf,
} from '../src/input/inforce.ts';
import { parsePlan } from '../src/input/plan.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { APPLY, phase0InputOf, phase0Rows } from '../src/phase0/rows.ts';
import { scopeOverlapFix } from '../src/phase0/types.ts';
import { type DeflakeContext, applyDeflake, deflakeJobPending } from '../src/pipeline/deflakemint.ts';
import { type StartInput, readRepoConfig, runChecks } from '../src/preflight/checks.ts';
import { DOCS_NOT_YET } from '../src/recover/revision.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { claimHost, releaseHost } from '../src/host/lock.ts';
import { type CorpusArc, corpusArc, editPlan, filesOf, newHostDir, readJsonFile, runDirOfArc, withForge } from './helpers/corpusarc.ts';
import { tmpDir } from './helpers/repo.ts';

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
/** A flake of `lane` (`set`) as its series records it: a red run naming `failing`, then a green rerun. */
function flake(a: CorpusArc, j: OpenJournal, lane: string, set: 'arc' | 'suite', failing: readonly string[]): void {
  const red = journeyRun(a, j, ++runs);
  const green = journeyRun(a, j, ++runs);
  j.fact({
    kind: 'flake-observed', owner: { type: 'unit', unit: unitId('u1') }, lane: laneId(lane), set, forgiven: true,
    event: { tree: sha('a'.repeat(40)), env: null, failing, red, green },
  });
}

const deflakeContext = (a: CorpusArc, j: OpenJournal): DeflakeContext => ({
  journal: j, runDir: runDirOfArc(a), hostDir: newHostDir(), planFile: a.planPath, routingBase: routingOf(a), laneEnv: process.env, docs: DOCS_NOT_YET, repo: a.repo,
});

const unitsInForce = (a: CorpusArc, j: OpenJournal) => requirePlanInForce(runDirOfArc(a), j.view).plan.units;
const items = (a: CorpusArc, j: OpenJournal) => j.view.opsOf('needsuser.raise').map((i) => readNeedsUser(runDirOfArc(a), i.expect.id)!);

/** The files in force with unit `id` admitted as a deflake unit of the journey lane, scoped `scope` (as the deflake job builds it). */
function withDeflakeUnit(a: CorpusArc, j: OpenJournal, id: UnitId, scope: readonly string[]): InputFiles {
  const runDir = runDirOfArc(a);
  const inForce = requirePlanInForce(runDir, j.view);
  const current = inForceFiles(runDir, j.view, inForce, revisionInForce(runDir, inForce), a.planPath, a.repo);
  const raw = JSON.parse(current.planBytes.toString('utf8')) as RawPlan;
  const specs = new Map<UnitId, InputFile>(current.specs);
  const spec = {
    schema: SPEC_SCHEMA, unit: id, rev: 1, lanes: [], scope, resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] },
    acceptance: [{ id: 'A-1', state: 'active', failLoudIfUndelivered: true, clause: 'The journey lane passes on every run.' }],
  };
  const path = absPath(join(a.planDir, `${id}.json`));
  const admitted = admitUnit(raw, specs, { id, risk: 'med', scope: scope as never, after: [], resources: [], origin: 'deflake', deflake: { keys: [{ type: 'lane', lane: laneId('journey') }] } },
    JSON.stringify(spec), path, `deflake unit ${id}`);
  assert.ok(!('reasons' in admitted), JSON.stringify(admitted));
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  return { ...current, plan, planBytes, specs: new Map(plan.units.map((u) => [u.id, specs.get(u.id)!] as const)) };
}

/** What a dev.17 executor committed: the deflake revision with deflake-1 scoped `**` (no gate refused it then). */
function commitDev17Unit(a: CorpusArc, j: OpenJournal): void {
  const runDir = runDirOfArc(a);
  const rctx = { runDir, view: j.view, hostDir: newHostDir(), planFile: a.planPath, routingBase: routingOf(a), laneEnv: process.env };
  const narrow = evaluateRevision(rctx, withDeflakeUnit(a, j, unitId('deflake-1'), ['src/**']), { type: 'deflake' });
  assert.equal(narrow.kind, 'accepted');
  if (narrow.kind !== 'accepted') return;
  const wide = withDeflakeUnit(a, j, unitId('deflake-1'), ['**']);
  const manifest = revisionManifestOf(wide);
  assert.ok(!('missing' in manifest));
  const verdict = { ...narrow, next: wide, draft: { ...narrow.draft, manifest } };
  keepRevision(runDir, verdict);
  commitRevisionNow(j, runDir, payloadOf(verdict.draft, { type: 'deflake' }), { type: 'arc' });
}

/** `evaluateApply` of the owner's files as they stand, from their latest apply. */
const ownerApply = (a: CorpusArc, j: OpenJournal) => withForge(a.forge, () => evaluateApply({
  runDir: runDirOfArc(a), view: j.view, hostDir: newHostDir(), repo: a.repo, planFile: a.planPath, routingBase: routingOf(a),
  laneEnv: process.env, manifest: null, base: null, rulings: [], visionEdit: false,
}));

function startInput(a: CorpusArc, hostDir: AbsPath, base: RevisionManifest | null): StartInput {
  return {
    repo: a.repo, planFile: a.planPath, profile: null, hostDir, env: process.env, respawn: null, base,
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
  it('deflake-scope.systems: an arc lane\'s flake mints a unit scoped to its test file\'s system and dependencies; an unmappable suite lane raises deflake-unscoped; an unrelated apply lands', T, async () => {
    const { a, j } = await arcInForce({ chain: { k: 1 }, systemsMap: SYSTEMS });
    try {
      flake(a, j, 'journey', 'arc', [BERTHS_TEST]);
      flake(a, j, 'suite', 'suite', []);
      const ctx = deflakeContext(a, j);
      assert.equal(deflakeJobPending(ctx), true);
      assert.deepEqual(await applyDeflake(ctx), { kind: 'applied', admitted: ['deflake-1'], recurring: 0, unscoped: 1 });
      const minted = unitsInForce(a, j).find((u) => u.id === 'deflake-1')!;
      assert.deepEqual(minted.scope, ['lib/**', 'src/**', 'test/**'], 'harbour and quay, which it depends on; not signage');
      assert.deepEqual(minted.deflake, { keys: [{ type: 'test', lane: 'journey', testId: BERTHS_TEST }] });
      const [item, ...more] = items(a, j);
      assert.deepEqual(more, []);
      assert.deepEqual([item!.reason, item!.blocking, item!.subject], ['deflake-unscoped', false, { type: 'arc' }]);
      assert.match(item!.summary, /for lane suite: its scope \*\* would reach the corpus file set/);
      assert.match(item!.recommendation, /systems/);
      assert.equal(deflakeJobPending(ctx), false, 'the unscoped group waits on its item');

      // The owner's unrelated edit lands with the deflake unit in force.
      editPlan(a, (p) => ({ ...p, units: (p['units'] as Json[]).map((u) => ({ ...u, risk: 'med' })) }));
      const verdict = await ownerApply(a, j);
      assert.equal(verdict.kind, 'accepted', JSON.stringify(verdict));
    } finally {
      j.close();
    }
  });

  it('deflake-scope.unmapped: with no systems map and no lane systems no `**` unit is minted; one deflake-unscoped item, raised once; the job keeps running', T, async () => {
    const { a, j } = await arcInForce({ chain: { k: 1 } });
    try {
      flake(a, j, 'journey', 'arc', [BERTHS_TEST]);
      const ctx = deflakeContext(a, j);
      assert.deepEqual(await applyDeflake(ctx), { kind: 'applied', admitted: [], recurring: 0, unscoped: 1 });
      assert.deepEqual(unitsInForce(a, j).map((u) => u.id), ['u1']);
      assert.equal(j.view.planApplied()!.rev, 1, 'no revision');
      const [item] = items(a, j);
      assert.equal(item!.reason, 'deflake-unscoped');
      assert.match(item!.summary, new RegExp(`${BERTHS_TEST}.*scope \\*\\*.*\\(\\*\\*\\)`));
      // The key flakes again: still one item, nothing due.
      flake(a, j, 'journey', 'arc', [BERTHS_TEST]);
      assert.equal(deflakeJobPending(ctx), false);
      assert.deepEqual(await applyDeflake(ctx), { kind: 'none' });
      assert.equal(items(a, j).length, 1);
    } finally {
      j.close();
    }
  });

  it('deflake-scope.gate: an executor revision (the deflake revision) cannot commit a unit whose scope reaches the corpus', T, async () => {
    const { a, j } = await arcInForce({ chain: { k: 1 } });
    try {
      const rctx = { runDir: runDirOfArc(a), view: j.view, hostDir: newHostDir(), planFile: a.planPath, routingBase: routingOf(a), laneEnv: process.env };
      const over = evaluateRevision(rctx, withDeflakeUnit(a, j, unitId('deflake-1'), ['**']), { type: 'deflake' });
      assert.deepEqual(over, {
        kind: 'rejected',
        reasons: [`${JSON.stringify({ kind: 'corpus-invalid', problems: [{ fix: scopeOverlapFix(unitId('deflake-1')), type: 'scope-overlaps-corpus', unit: 'deflake-1' }] })}`],
      });
      assert.equal(evaluateRevision(rctx, withDeflakeUnit(a, j, unitId('deflake-1'), ['src/**']), { type: 'deflake' }).kind, 'accepted');
    } finally {
      j.close();
    }
  });

  it('deflake-scope.start-base: a dev.17 `**` deflake unit in force, executor down: start --base <export> with it narrowed starts; without --base it is refused the conflict', T, async () => {
    const { a, j } = await arcInForce({ chain: { k: 1 } });
    const runDir = runDirOfArc(a);
    try {
      commitDev17Unit(a, j);
      atomicJson(join(runDir, START_FILE), { v: SCHEMA_VERSION, generation: 1, at: isoTimeOf(new Date()), repo: a.repo, planFile: a.planPath, profile: 'default' });
    } finally {
      j.close();
    }
    // Every start is refused while it stands: the row names the unit and the fix.
    const stuck = await start(a, null);
    assert.equal(stuck.kind, 'refused');
    assert.match(JSON.stringify(stuck.kind === 'refused' ? stuck.rejections : []), /scope-overlaps-corpus.*deflake-1.*--base <export>\/export\.json/);

    // The way out, with no executor running: export, sync over the inputs, narrow, start --base.
    const out = absPath(join(tmpDir('deflake-export'), 'export'));
    await exportInputs({ repo: a.repo, arc: a.arc, out });
    cpSync(out, a.planDir, { recursive: true, filter: (src) => !src.endsWith(EXPORT_FILE) && !src.startsWith(join(out, 'repo')) });
    editPlan(a, (p) => ({ ...p, units: (p['units'] as Json[]).map((u) => (u['id'] === 'deflake-1' ? { ...u, scope: ['src/**'] } : u)) }));
    const spec = join(a.planDir, 'deflake-1.json');
    writeFileSync(spec, JSON.stringify({ ...readJsonFile(spec), scope: ['src/**'] }));

    const refused = await start(a, null);
    assert.equal(refused.kind, 'refused');
    assert.match(JSON.stringify(refused.kind === 'refused' ? refused.rejections : []), /plan-change-refused.*conflict: .*plan\.json at \$\.units\[deflake-1\]\.scope: you and the arc both changed it since the base/);

    const based = await start(a, exportBase(absPath(join(out, EXPORT_FILE)), 'start'));
    assert.equal(based.kind, 'passed', JSON.stringify(based.kind === 'refused' ? based.rejections : 'passed'));
    const j2 = openJournal(runDir, a.arc);
    try {
      assert.deepEqual(unitsInForce(a, j2).find((u) => u.id === 'deflake-1')!.scope, ['src/**']);
      assert.equal(j2.view.planApplied()!.source.type, 'start');
    } finally {
      j2.close();
    }
  });
  it('deflake-scope.settled: a dev.17 `**` deflake unit refuses an unrelated apply while it builds, and no longer once it merged', T, async () => {
    const { a, j } = await arcInForce({ chain: { k: 1 } });
    try {
      commitDev17Unit(a, j);
      editPlan(a, (p) => ({ ...p, units: (p['units'] as Json[]).map((u) => ({ ...u, risk: 'med' })) }));
      const building = await ownerApply(a, j);
      assert.equal(building.kind, 'rejected');
      assert.match(JSON.stringify(building), /scope-overlaps-corpus.*deflake-1/);
      j.fact({ kind: 'stage-outcome', unit: unitId('deflake-1'), stage: 'snapshot', attempt: 1, outcome: 'published', class: 'retire', chargeable: false } as Fact);
      assert.equal(j.view.unit(unitId('deflake-1')).status, 'retired');
      const merged = await ownerApply(a, j);
      assert.equal(merged.kind, 'accepted', JSON.stringify(merged));
    } finally {
      j.close();
    }
  });
});
