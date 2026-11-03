import { systemName } from '../src/core/ids.ts';
// dev.13 prompt inputs (agent F): a milestone's design references reach the pre-build, build and gate of every unit it
// lists, and of its design unit, as documents; a unit in no milestone gets no references. Every Claude build gets
// configured MCP servers, with bring-ups from membership, design ownership and repaired findings' origin milestones.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Sha, arcId, jobId, sha, unitId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { specM1 } from '../src/core/records.ts';
import { openFinding } from '../src/holistic/findings.ts';
import { bringUpDraft } from '../src/walk/report.ts';
import { absPath } from '../src/core/values.ts';
import { type PlanM1, parsePlan } from '../src/input/plan.ts';
import { buildBrowser, unitMilestones } from '../src/pipeline/stages.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { makeRepo, revParse, tmpDir } from './helpers/repo.ts';

const unit = (id: string, after: string[] = []) => ({ id, spec: `specs/${id}.json`, risk: 'med', systems: [systemName('app')], resources: [], after, contingent: [] });
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

  const config = parseRepoConfig({ walkthrough: { mcp: { playwright: { command: 'playwright-mcp', args: ['--output-dir', '{evidence}', '--viewport-size', '{viewport}'] } } } });
  const work = absPath(join('/run', 'work', 'u1-build-1'));
  const spec = (unit: string, repairs: string[] = []) => specM1({
    schema: 'roadmap/spec-m1', unit, rev: 1, intent: 'Repair the product.', nonGoals: ['No unrelated changes.'],
    lanes: [], acceptance: [{ id: 'A1', clause: 'The product works.', failLoudIfUndelivered: true, state: 'active' }],
    resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] }, ...(repairs.length === 0 ? {} : { repairs }),
  }, '$');

  it('every Claude build gets configured servers, with member/design bring-ups in plan order regardless of journey type', (t) => {
    const journal = openJournal(absPath(tmpDir('build-browser')), arcId('arc-1'));
    t.after(() => journal.close());
    const plan = planOf([MS1, MS2]);
    const ctx = { plan: () => plan, journal, routingBase: { profile: 'default', config, arcRoles: null } } as const;
    for (const [u, ids] of [['u1', ['MS-1']], ['u2', ['MS-1', 'MS-2']], ['d1', ['MS-1']], ['loose', []]] as const) {
      const b = buildBrowser(ctx, spec(u), 'claude', work);
      assert.deepEqual(b?.input, { servers: ['playwright'], bringUps: plan.milestones!.filter((m) => ids.some((id) => id === m.id)).map((m) => ({ milestone: m.id, bringUp: m.bringUp })) }, u);
      assert.deepEqual(JSON.parse(b!.mcpConfig), {
        mcpServers: { playwright: { type: 'stdio', command: 'playwright-mcp', args: ['--output-dir', work, '--viewport-size', '1280x800'], env: {} } },
      });
    }
    const shellPlan = planOf([{ ...MS2, units: ['u1'] }]);
    assert.deepEqual(buildBrowser({ ...ctx, plan: () => shellPlan }, spec('u1'), 'claude', work)?.input.bringUps,
      [{ milestone: 'MS-2', bringUp: shellPlan.milestones![0]!.bringUp }]);
    assert.deepEqual(buildBrowser({ ...ctx, plan: () => planOf([]) }, spec('loose'), 'claude', work)?.input, { servers: ['playwright'], bringUps: [] });
    assert.equal(buildBrowser(ctx, spec('u1'), 'codex', work), null);
    // No build-level refusal; bootstrap's browser-journey refusal is covered in walk-mcp.test.ts.
    for (const config of [null, parseRepoConfig({})]) {
      assert.equal(buildBrowser({ ...ctx, routingBase: { ...ctx.routingBase, config } }, spec('u1'), 'claude', work), null);
    }
  });

  it("a standalone repair gets its walked finding's origin bring-up; membership and repeated findings deduplicate in plan order", (t) => {
    const journal = openJournal(absPath(tmpDir('build-browser-repair')), arcId('arc-1'));
    t.after(() => journal.close());
    const plan = planOf([MS1, MS2]);
    const [m1, m2] = plan.milestones!;
    const job = jobId('walk', 1);
    journal.fact({ kind: 'walk-started', job, milestone: m1!.id, round: 1, sha: plan.baseline, ports: {} });
    const f1 = openFinding(journal, bringUpDraft(job, m1!, 'setup', 'failed', []));
    const f2 = openFinding(journal, bringUpDraft(job, m1!, 'seed', 'failed', []));
    assert.ok(f1.kind === 'opened' && f2.kind === 'opened');
    journal.fact({ kind: 'walk-ended', job, outcome: 'bring-up-failed', findings: [f1.id, f2.id], proposals: [], dropped: [] });
    const ctx = { plan: () => plan, journal, routingBase: { profile: 'default', config, arcRoles: null } } as const;
    const refs = [f2.id, f1.id, 'I-1'];
    assert.deepEqual(buildBrowser(ctx, spec('loose', refs), 'claude', work)?.input.bringUps, [{ milestone: m1!.id, bringUp: m1!.bringUp }]);
    assert.deepEqual(buildBrowser(ctx, spec('u2', refs), 'claude', work)?.input.bringUps, [m1!, m2!].map((m) => ({ milestone: m.id, bringUp: m.bringUp })));
    // An uncited finding supplies no bring-up.
    assert.deepEqual(buildBrowser(ctx, spec('loose', ['I-1']), 'claude', work)?.input.bringUps, []);
  });
});
