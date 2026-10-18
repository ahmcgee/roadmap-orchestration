// dev.13 prompt inputs (agent F): a milestone's design references reach the plan-check, build and gate of every unit it
// lists, and of its design unit, as documents; a unit in no milestone gets none. A build in a milestone with a `browser`
// journey gets the walkthrough MCP servers (`--mcp-config`, `{evidence}` its evidence dir); no other build does.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Sha, sha, unitId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { type PlanM1, parsePlan } from '../src/input/plan.ts';
import { buildBrowser, unitMilestones } from '../src/pipeline/stages.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { makeRepo, revParse, tmpDir } from './helpers/repo.ts';

const unit = (id: string, after: string[] = []) => ({ id, spec: `specs/${id}.json`, risk: 'med', scope: [`src/${id}/**`], resources: [], after, contingent: [] });
const bringUp = {
  setup: [['npm', 'ci']], serve: [{ name: 'web', argv: ['node', 'server.js', '--port', '{port:web}'], ready: { http: 'http://127.0.0.1:{port:web}/health' } }],
  env: { API_URL: 'http://127.0.0.1:{port:web}' }, seed: [],
};
const MS1 = {
  id: 'MS-1', text: 'A visitor signs up and sees their dashboard.', units: ['u1', 'u2'], design: { unit: 'd1' }, references: ['design/web'], bringUp,
  journeys: [{ id: 'J-1', text: 'I sign up and land on my dashboard.', via: 'browser', entry: '/signup', budget: { steps: 6, seconds: 90 } }], resources: [],
};
const MS2 = {
  id: 'MS-2', text: 'A developer runs the CLI.', units: ['u2'], design: { supplied: true }, references: ['design/cli', 'design/web'], bringUp: { setup: [], serve: [], env: {}, seed: [] },
  journeys: [{ id: 'J-2', text: 'I run the CLI with no arguments.', via: 'shell', entry: 'node cli.js', budget: null }], resources: [],
};

function planOf(milestones: object[]): PlanM1 {
  return parsePlan({
    schema: 'roadmap/plan-m1', arc: 'arc-1', integrationBranch: 'main', baseline: 'a'.repeat(40), worktreeRoot: '/var/tmp/wt', contracts: [], rulings: 'rulings.md',
    architectureDoc: 'docs/arch.md', direction: 'd', suite: { lanes: [] }, resources: [],
    units: [unit('d1'), unit('u1', ['d1']), unit('u2', ['d1']), unit('loose')], holistic: { vision: 'vision.json', advances: ['V-1'] },
    ...(milestones.length === 0 ? {} : { milestones }),
  });
}

function repo(): { dir: string; tip: Sha } {
  const dir = makeRepo(tmpDir('milestone-inputs'), {
    files: {
      'design/web/DESIGN.md': '# Web\nTokens and layouts.\n', 'design/web/tokens.json': '{"accent":"#0a7"}\n', 'design/web/wire.png': '\u0089PNG\r\n\u001a\n\u0000\u0000IHDR',
      'design/cli/TRANSCRIPTS.md': '$ cli\nusage: cli <cmd>\n', 'src/u1/a.ts': 'export {};\n',
    },
  });
  return { dir, tip: sha(revParse(dir, 'HEAD')) };
}

describe('milestone prompt inputs', () => {
  it('a member gets its milestones and every reference file once, text in full and binaries by path; a design unit gets the journeys', () => {
    const { dir, tip } = repo();
    const ctx = { plan: () => planOf([MS1, MS2]), repo: absPath(dir) };
    const u2 = unitMilestones(ctx, unitId('u2'), tip);
    assert.deepEqual(u2?.of, [
      { as: 'member', id: 'MS-1', text: MS1.text, dirs: ['design/web'] },
      { as: 'member', id: 'MS-2', text: MS2.text, dirs: ['design/cli', 'design/web'] },
    ]);
    assert.deepEqual(u2?.references, [
      { path: 'design/cli/TRANSCRIPTS.md', text: '$ cli\nusage: cli <cmd>\n' },
      { path: 'design/web/DESIGN.md', text: '# Web\nTokens and layouts.\n' },
      { path: 'design/web/tokens.json', text: '{"accent":"#0a7"}\n' },
    ]);
    assert.deepEqual(u2?.binary, ['design/web/wire.png']);
    const d1 = unitMilestones(ctx, unitId('d1'), tip);
    assert.deepEqual(d1?.of, [{ as: 'design', id: 'MS-1', text: MS1.text, dirs: ['design/web'], journeys: MS1.journeys }]);
  });

  it('a unit in no milestone, or a plan without milestones, gets none; a reference dir not there yet has no files', () => {
    const { dir, tip } = repo();
    assert.equal(unitMilestones({ plan: () => planOf([MS1, MS2]), repo: absPath(dir) }, unitId('loose'), tip), null);
    assert.equal(unitMilestones({ plan: () => planOf([]), repo: absPath(dir) }, unitId('u1'), tip), null);
    const fresh = unitMilestones({ plan: () => planOf([{ ...MS1, references: ['design/app'] }]), repo: absPath(dir) }, unitId('d1'), tip);
    assert.deepEqual([fresh?.references, fresh?.binary], [[], []]);
  });

  it('only a Claude build in a milestone with a browser journey gets the MCP servers, with {evidence} its evidence dir', () => {
    const config = parseRepoConfig({ walkthrough: { mcp: { playwright: { command: 'playwright-mcp', args: ['--output-dir', '{evidence}', '--viewport-size', '{viewport}'] } } } });
    const ctx = { plan: () => planOf([MS1, MS2]), routingBase: { profile: 'default', config, arcRoles: null } } as const;
    const work = absPath(join('/run', 'work', 'u1-build-1'));
    for (const u of ['u1', 'u2', 'd1']) {
      const b = buildBrowser(ctx, unitId(u), 'claude', work);
      assert.deepEqual(b?.input, { servers: ['playwright'], bringUps: [{ milestone: 'MS-1', bringUp: planOf([MS1]).milestones![0]!.bringUp }] }, u);
      assert.deepEqual(JSON.parse(b!.mcpConfig), {
        mcpServers: { playwright: { type: 'stdio', command: 'playwright-mcp', args: ['--output-dir', work, '--viewport-size', '1280x800'], env: {} } },
      });
    }
    // MS-2's journeys are shell only: a unit only it lists would get no browser; a unit in none, and a Codex seat, get none.
    assert.equal(buildBrowser({ ...ctx, plan: () => planOf([{ ...MS2, units: ['u1'] }]) }, unitId('u1'), 'claude', work), null);
    assert.equal(buildBrowser(ctx, unitId('loose'), 'claude', work), null);
    assert.equal(buildBrowser(ctx, unitId('u1'), 'codex', work), null);
    // Bootstrap refuses a browser journey without walkthrough.mcp (walk-tools-missing), so a build meeting one fails loud.
    assert.throws(() => buildBrowser({ ...ctx, routingBase: { ...ctx.routingBase, config: null } }, unitId('u1'), 'claude', work), /walkthrough\.mcp/);
  });
});
