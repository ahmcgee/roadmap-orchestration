// Lane topology (dev.17; src/input/systems.ts, src/git/reusekey.ts, the dev.17 lane reader in src/core/records.ts): the
// systems map's reader, a path's class, candidate selection, a lane's input and its reuse key over real git trees, leaf
// test files, cadence and its dev.16 defaults, the dev.16 lane rev, and Phase-0 row 16.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type LaneId, type SystemName, sha } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { sha256Hex } from '../src/core/json.ts';
import { type LaneDef, cadenceAtOrBefore, laneDef, laneDefOf, specM1 } from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath, repoPath } from '../src/core/values.ts';
import { inputShaOf, reuseKeyText } from '../src/git/reusekey.ts';
import { laneRevMatches, laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { parsePlan } from '../src/input/plan.ts';
import { type SystemsMap, laneInput, laneSelected, laneTestFiles, pathClass, systemsMap, systemsMapInForce, unknownLaneSystems } from '../src/input/systems.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { commitAll, git, makeRepo, tmpDir, writeFiles } from './helpers/repo.ts';

const MAP_JSON = {
  systems: {
    core: { paths: ['src/core/**'], tests: ['test/core/*.test.js'] },
    api: { paths: ['src/api/**'], tests: ['test/api/*.test.js'], dependsOn: ['core'] },
    web: { paths: ['src/web/**'], tests: ['test/web/*.test.js'] },
  },
  shared: [{ paths: ['package-lock.json'], dependents: ['api', 'web'] }],
  contracts: { 'docs/contracts/api.md': ['web'] },
  docs: ['docs/**', '*.md'],
};
const MAP: SystemsMap = systemsMap(MAP_JSON, 'systemsMap');
const p = (s: string) => repoPath(s);
const names = (s: ReadonlySet<SystemName>): readonly string[] => [...s].sort();
const withSystems = (...systems: string[]): Pick<LaneDef, 'systems'> => ({ systems: systems as SystemName[] });

describe('systems.map', () => {
  it('reads a map; every name it uses is declared, and docs is never a system', () => {
    assert.deepEqual(MAP.systems['api' as SystemName]?.dependsOn, ['core']);
    assert.deepEqual(MAP.systems['web' as SystemName]?.dependsOn, [], 'dependsOn absent: none');
    assert.throws(() => systemsMap({ systems: { api: { paths: ['src/**'], dependsOn: ['nope'] } } }, 'm'), SchemaError);
    assert.throws(() => systemsMap({ systems: { docs: { paths: ['docs/**'] } } }, 'm'), /docs class/);
    assert.throws(() => systemsMap({ systems: { api: { paths: ['src/**'] } }, shared: [{ paths: ['x'], dependents: ['nope'] }] }, 'm'), SchemaError);
    assert.throws(() => systemsMap({ systems: { api: { paths: ['src/**'] } }, contracts: { 'c.md': ['nope'] } }, 'm'), SchemaError);
    assert.throws(() => systemsMap({ systems: {} }, 'm'), /at least one system/);
    // The repo config carries it.
    assert.deepEqual(parseRepoConfig({ systemsMap: MAP_JSON }).systemsMap, MAP);
    assert.equal(parseRepoConfig({}).systemsMap, undefined);
  });

  it('a revision before dev.17 records no map: read as none; one that recorded none is none', () => {
    assert.equal(systemsMapInForce(null), null);
    assert.equal(systemsMapInForce({}), null);
    assert.equal(systemsMapInForce({ systemsMap: null }), null);
    assert.equal(systemsMapInForce({ systemsMap: MAP }), MAP);
  });
});

describe('systems.path-class', () => {
  it('a path belongs to the systems that match it, closed over their dependents; a shared area to its dependents; a contract to its consumers', () => {
    const cls = (path: string) => {
      const c = pathClass(MAP, p(path));
      return c.kind === 'systems' ? names(c.systems) : c.kind;
    };
    assert.deepEqual(cls('src/core/a.js'), ['api', 'core'], 'api depends on core: a core change touches api');
    assert.deepEqual(cls('src/api/a.js'), ['api']);
    assert.deepEqual(cls('test/web/a.test.js'), ['web'], 'a test file belongs to its system');
    assert.deepEqual(cls('package-lock.json'), ['api', 'web']);
    assert.deepEqual(cls('docs/contracts/api.md'), ['web'], 'a contract is its consumers\', before the docs class');
    assert.equal(cls('docs/guide.md'), 'docs');
    assert.equal(cls('README.md'), 'docs');
    assert.equal(cls('scripts/build.sh'), 'unmapped');
  });

  it('selection: no systems runs always; an unmapped path runs every lane; a docs-only diff runs only a lane listing docs', () => {
    const api = withSystems('api');
    const web = withSystems('web');
    const docs = withSystems('docs');
    const all = {};
    const on = (lane: Pick<LaneDef, 'systems'>, ...paths: string[]): boolean => laneSelected(MAP, lane, paths.map(p));
    assert.equal(on(api, 'src/web/x.js'), false);
    assert.equal(on(api, 'src/core/x.js'), true, 'through dependsOn');
    assert.equal(on(web, 'src/core/x.js'), false);
    assert.equal(on(web, 'package-lock.json'), true, 'a shared area');
    assert.equal(on(web, 'docs/contracts/api.md'), true, 'a consumed contract');
    assert.equal(on(api, 'scripts/x.sh'), true, 'unmapped: fail-safe');
    assert.equal(on(api, 'docs/guide.md'), false, 'docs-only');
    assert.equal(on(docs, 'docs/guide.md'), true);
    assert.equal(on(all, 'docs/guide.md'), true, 'a lane listing no systems is always selected');
    assert.equal(laneSelected(null, api, [p('src/web/x.js')]), true, 'no map: every lane');
  });

  it('a lane\'s leaf test files: its systems\' tests globs with what they depend on; helpers never', () => {
    const changed = ['test/core/a.test.js', 'test/api/b.test.js', 'test/web/c.test.js', 'test/helpers/h.js'].map(p);
    assert.deepEqual(laneTestFiles(MAP, withSystems('api'), changed), ['test/core/a.test.js', 'test/api/b.test.js']);
    assert.deepEqual(laneTestFiles(MAP, {}, changed), ['test/core/a.test.js', 'test/api/b.test.js', 'test/web/c.test.js'], 'no systems: every system\'s');
  });

  it('Phase 0: a lane naming a system the map lacks (or with no map) is named; docs needs a docs class', () => {
    const lanes = [{ id: 'a' as LaneId, systems: ['api', 'nope'] as SystemName[] }, { id: 'b' as LaneId, systems: ['docs'] as SystemName[] }, { id: 'c' as LaneId }];
    assert.deepEqual(unknownLaneSystems(MAP, lanes), [{ lane: 'a', system: 'nope' }]);
    assert.deepEqual(unknownLaneSystems(systemsMap({ systems: { api: { paths: ['src/**'] } } }, 'm'), lanes), [{ lane: 'a', system: 'nope' }, { lane: 'b', system: 'docs' }]);
    assert.deepEqual(unknownLaneSystems(null, lanes).map((u) => u.system), ['api', 'nope', 'docs']);
  });
});

describe('reusekey.input-sha', () => {
  it('a lane\'s input: its systems\' paths and unmapped paths; a change elsewhere keeps it, a change in it or an unmapped path moves it; no map is the tree id', () => {
    const repo = absPath(makeRepo(tmpDir('reusekey'), {
      files: {
        'src/core/a.js': 'a\n', 'src/api/b.js': 'b\n', 'src/web/c.js': 'c\n', 'test/api/b.test.js': 't\n', 'docs/guide.md': 'g\n', 'scripts/x.sh': 'x\n', 'package-lock.json': '{}\n',
      },
    }));
    const tree = (): ReturnType<typeof sha> => sha(git(repo, 'rev-parse', 'HEAD^{tree}'));
    const at = (files: Record<string, string>) => {
      writeFiles(repo, files);
      commitAll(repo, 'change');
      return tree();
    };
    const api = withSystems('api');
    const open = {};
    const t0 = tree();
    assert.equal(inputShaOf(repo, t0, api, null), t0, 'no map: the tree id');
    const api0 = inputShaOf(repo, t0, api, MAP);
    assert.notEqual(api0, t0, 'a lane reading part of the tree');
    const open0 = inputShaOf(repo, t0, open, MAP);
    assert.notEqual(open0, t0, 'a lane listing no systems reads all but the docs class');
    const t1 = at({ 'src/web/c.js': 'c2\n' });
    assert.equal(inputShaOf(repo, t1, api, MAP), api0, 'another system changed: the same input');
    assert.notEqual(inputShaOf(repo, t1, open, MAP), open0);
    const t2 = at({ 'docs/guide.md': 'g2\n' });
    assert.equal(inputShaOf(repo, t2, api, MAP), api0, 'docs changed');
    assert.equal(inputShaOf(repo, t2, open, MAP), inputShaOf(repo, t1, open, MAP), 'a docs-only change keeps every lane\'s input but a docs lane\'s');
    assert.notEqual(inputShaOf(repo, t2, withSystems('docs'), MAP), inputShaOf(repo, t1, withSystems('docs'), MAP));
    const t3 = at({ 'src/core/a.js': 'a2\n' });
    assert.notEqual(inputShaOf(repo, t3, api, MAP), api0, 'a dependency changed');
    const t4 = at({ 'scripts/x.sh': 'x2\n' });
    assert.notEqual(inputShaOf(repo, t4, api, MAP), inputShaOf(repo, t3, api, MAP), 'an unmapped path is every lane\'s input');
    const t5 = at({ 'package-lock.json': '{"a":1}\n' });
    assert.notEqual(inputShaOf(repo, t5, api, MAP), inputShaOf(repo, t4, api, MAP), 'a shared area its system depends on');
    // A map that leaves nothing of a lane's tree out keys it by the tree id, as a dev.16 observation was.
    const whole = systemsMap({ systems: { all: { paths: ['**'] } } }, 'm');
    assert.equal(inputShaOf(repo, t5, open, whole), t5);
    assert.equal(reuseKeyText({ lane: 'l' as LaneId, laneRev: 'r' as never, envId: 'e' as never, inputSha: t5 }), `${t5}/l/r/e`);
    assert.equal(laneInput(MAP, api)(p('src/web/c.js')), false);
  });
});

describe('lanes.cadence', () => {
  const LANE = { id: 'l', argv: ['true'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, resources: [], evidenceGlobs: [], evidenceExcludes: [] };
  it('a dev.16 tier reads as its kind\'s cadence; tier beside cadence is refused; each kind takes its cadences', () => {
    const cadence = (kind: 'spec' | 'suite' | 'arc', tier: string) => laneDefOf(kind)({ ...LANE, tier }, 'l').cadence;
    assert.deepEqual([cadence('spec', 'fast'), cadence('spec', 'estate')], ['build', 'unit']);
    assert.deepEqual([cadence('suite', 'fast'), cadence('suite', 'estate')], ['build', 'candidate']);
    assert.deepEqual([cadence('arc', 'fast'), cadence('arc', 'estate')], ['build', 'candidate']);
    assert.throws(() => laneDefOf('spec')({ ...LANE, tier: 'fast', cadence: 'build' }, 'l'), /tier/);
    assert.throws(() => laneDefOf('spec')({ ...LANE, cadence: 'candidate' }, 'l'), /cadence/);
    assert.throws(() => laneDefOf('arc')({ ...LANE, cadence: 'batch' }, 'l'), /cadence/);
    assert.equal(laneDefOf('suite')({ ...LANE, cadence: 'batch' }, 'l').cadence, 'batch');
    assert.throws(() => laneDef({ ...LANE, tier: 'fast' }, 'l'), SchemaError, 'the normalised form takes cadence only');
    assert.throws(() => laneDefOf('spec')(LANE, 'l'), /cadence/, 'neither: required');
    assert.ok(cadenceAtOrBefore('build', 'candidate') && cadenceAtOrBefore('candidate', 'candidate') && !cadenceAtOrBefore('batch', 'candidate'));
  });

  it('systems, testArgv and stochastic: validated; never testArgv or stochastic on an arc lane', () => {
    const lane = laneDefOf('suite')({ ...LANE, cadence: 'candidate', systems: ['api'], testArgv: ['node', '--test', '{files}'], stochastic: { runs: 3, minPasses: 2 } }, 'l');
    assert.deepEqual([lane.systems, lane.testArgv, lane.stochastic], [['api'], ['node', '--test', '{files}'], { runs: 3, minPasses: 2 }]);
    assert.throws(() => laneDefOf('suite')({ ...LANE, cadence: 'unit', testArgv: ['node', '--test'] }, 'l'), /\{files\}/);
    assert.throws(() => laneDefOf('suite')({ ...LANE, cadence: 'unit', testArgv: ['{files}', '{files}'] }, 'l'), /\{files\}/);
    assert.throws(() => laneDefOf('suite')({ ...LANE, cadence: 'unit', stochastic: { runs: 1, minPasses: 1 } }, 'l'), /at least 2/);
    assert.throws(() => laneDefOf('suite')({ ...LANE, cadence: 'unit', stochastic: { runs: 2, minPasses: 3 } }, 'l'), /at most runs/);
    assert.throws(() => laneDefOf('suite')({ ...LANE, cadence: 'unit', systems: [] }, 'l'), SchemaError);
    assert.throws(() => parseObligations({
      schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [{ ...LANE, cadence: 'candidate', reporter: 'jsonl', stochastic: { runs: 2, minPasses: 1 } }], obligations: [], mapping: { paths: [] },
    }), /arc lane/);
  });

  it('a batch suite lane needs the holistic layer; a spec\'s forces are unique lane ids', () => {
    const plan = {
      schema: 'roadmap/plan-m1', arc: 'arc-1', integrationBranch: 'main', baseline: 'a'.repeat(40), worktreeRoot: '/tmp/wt', contracts: [], rulings: 'r.md',
      architectureDoc: 'A.md', direction: 'd', suite: { lanes: [{ ...LANE, cadence: 'batch' }] }, resources: [], units: [{ id: 'u1', spec: 'u1.json', risk: 'low', scope: ['src/**'], resources: [] }],
    };
    assert.throws(() => parsePlan(plan), /holistic/);
    const spec = {
      schema: 'roadmap/spec-m1', unit: 'u1', rev: 1, lanes: [], acceptance: [{ id: 'A1', clause: 'c', failLoudIfUndelivered: false, state: 'active' }], scope: ['src/**'],
      resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] },
    };
    assert.deepEqual(specM1({ ...spec, forces: ['e2e'] }, 's').forces, ['e2e']);
    assert.throws(() => specM1({ ...spec, forces: ['e2e', 'e2e'] }, 's'), /forces/);
    assert.equal(specM1(spec, 's').forces, undefined);
  });

  it('upgrade: a dev.16 lane rev (tier in place of cadence) matches the lane it read as; another does not', () => {
    const legacy = { ...LANE, tier: 'fast', reporter: 'jsonl' };
    const parsed = parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [legacy], obligations: [], mapping: { paths: [] } }).lanes[0]!;
    const { cadence: _c, ...rest } = parsed;
    const dev16 = sha256Hex(canonicalJson({ ...rest, tier: 'fast' })).slice(0, 16) as never;
    assert.notEqual(dev16, laneRevOf(parsed));
    assert.equal(laneRevMatches(dev16, parsed), true);
    const estate = sha256Hex(canonicalJson({ ...rest, tier: 'estate' })).slice(0, 16) as never;
    assert.equal(laneRevMatches(estate, parsed), false, 'a build lane was fast');
    assert.equal(laneRevMatches(dev16, { ...parsed, systems: ['api'] as SystemName[] }), false, 'a dev.17 field: no dev.16 form');
  });
});
