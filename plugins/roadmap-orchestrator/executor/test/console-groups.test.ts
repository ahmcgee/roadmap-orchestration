// dev.81 (D1, D2): the Graph's groups for units of no milestone, read from a field arc recorded with production writers
// (scale-arc.ts --field), and the arc's shapes the field lacks (repairs raised by walks and audits, a deflake, a design
// unit, polish) added to its recorded status and journal as the executor records them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Observations } from './helpers/observations.ts';
import { absPath } from '../src/core/values.ts';
import { graphView } from '../src/console/views.ts';
import { graphShape } from '../src/console/view-shapes.ts';
import { milestoneMembership, outsideGroups } from '../src/console/milestones.ts';
import type { Envelope } from '../src/observation/protocol.ts';
import { generateScaleArc } from './helpers/scale-arc.ts';
import { tmpDir } from './helpers/repo.ts';
const { graphData } = await import(new URL('../web-src/app/graph-data.ts', import.meta.url).href);
const { graphLayout } = await import(new URL('../web-src/app/graph-layout.ts', import.meta.url).href);

type Line = Envelope['data']['display']['status']['units'][number];
type Fact = Extract<Envelope['data']['events'][number], { type: 'fact' }>['fact'];

test('dev.81: units of no milestone group by what raised them; withdrawn units hide behind their successors', { timeout: 120_000 }, async t => {
  const m = await generateScaleArc(tmpDir('console-groups'), { preset: 'design', field: true });
  const e = new Observations(absPath(m.hostDir), 'groups', 'reader').read({ runDir: absPath(m.runDir), arc: m.arc as never });
  const line = (id: string) => e.data.display.status.units.find(u => String(u.unit) === id)!;
  /** `e` with each named unit's status line changed, facts appended and the plan changed, as a later capture would read. */
  const variant = (lines: Record<string, Partial<Line>>, facts: Fact[] = [], plan: (p: NonNullable<Envelope['data']['plan']>) => void = () => {}): Envelope => {
    const data = structuredClone(e.data) as { -readonly [K in keyof Envelope['data']]: Envelope['data'][K] };
    const status = data.display.status as unknown as { units: Line[] };
    status.units = status.units.map(u => ({ ...u, ...lines[String(u.unit)] }));
    const last = data.events.at(-1)!;
    data.events = [...data.events, ...facts.map((fact, i) => ({ ...last, seq: Number(last.seq) + 1 + i, type: 'fact', fact }) as Envelope['data']['events'][number])];
    plan(data.plan!);
    return { ...e, data };
  };
  const groupsOf = (x: Envelope) => outsideGroups(x, milestoneMembership(x)).map(g => [g.id, g.ids]);

  await t.test('status lines carry the origin and the repaired ids, defaulted', () => {
    for (const u of e.data.display.status.units) { assert.equal(u.origin, 'planned'); assert.deepEqual(u.repairs, []); }
  });

  await t.test('planned work of no milestone is Hardening; a re-entry shares its parent\'s group', () => {
    const graph = graphView(e);
    assert.ok(graphShape(graph), 'the graph view keeps its shape');
    assert.deepEqual(graph.groups, [{ kind: 'hardening', id: 'hardening', label: 'Hardening', ids: ['u47-docs', 'u48-docs', 'u48-docs-r2'] }]);
    assert.deepEqual(graph.units.find(u => u.id === 'u50')!.carriedBy, ['u50-carry']);
    assert.equal(graph.units.find(u => u.id === 'u48-docs')!.supersededBy, 'u48-docs-r2');
  });

  const audit = e.data.events.flatMap(ev => ev.type === 'fact' && ev.fact.kind === 'finding-opened' && ev.fact.source.type === 'job' ? [{ id: ev.fact.id, job: String(ev.fact.source.job) }] : []);
  const walk = e.data.events.flatMap(ev => ev.type === 'fact' && ev.fact.kind === 'walk-started' ? [{ fact: ev.fact }] : [])[0]!;
  const opened = (id: string, job: string, milestone?: string): Fact => {
    const base = e.data.events.find(ev => ev.type === 'fact' && ev.fact.kind === 'finding-opened')!;
    assert.ok(base.type === 'fact' && base.fact.kind === 'finding-opened');
    return { ...base.fact, id, lens: milestone ? 'walkthrough' : base.fact.lens, obligation: null, source: { type: 'job', job }, ...(milestone ? { milestone } : {}) } as Fact;
  };

  await t.test('a repair a walk raised groups under the walk\'s milestone; one an audit raised under the audit job', () => {
    const x = variant({ 'u48-docs': { origin: 'repair', repairs: ['F-900'] as never }, 'u47-docs': { origin: 'repair', repairs: [audit[0]!.id] } },
      [opened('F-900', String(walk.fact.job), String(walk.fact.milestone))]);
    assert.deepEqual(groupsOf(x), [[`milestone-repair:${walk.fact.milestone}`, ['u48-docs', 'u48-docs-r2']], [`audit:${audit[0]!.job}`, ['u47-docs']]]);
    // A walk's finding with no milestone of its own still resolves through the walk.
    const y = variant({ 'u48-docs': { origin: 'repair', repairs: ['F-901'] as never } }, [opened('F-901', String(walk.fact.job))]);
    assert.equal(groupsOf(y)[0]![0], `milestone-repair:${walk.fact.milestone}`);
  });

  await t.test('an obligation repair resolves through the findings naming it; findings of several milestones or none fall to their latest job', () => {
    const x = variant({ 'u47-docs': { origin: 'repair', repairs: ['I-1'] as never } });
    const latest = e.data.events.flatMap(ev => ev.type === 'fact' && ev.fact.kind === 'finding-opened' && ev.fact.obligation === 'I-1' && ev.fact.source.type === 'job' ? [String(ev.fact.source.job)] : []).at(-1)!;
    assert.deepEqual(groupsOf(x).find(([id]) => String(id).startsWith('audit:')), [`audit:${latest}`, ['u47-docs']]);
    const none = variant({ 'u47-docs': { origin: 'repair', repairs: ['F-999'] as never } });
    assert.deepEqual(groupsOf(none), [['hardening', ['u47-docs', 'u48-docs', 'u48-docs-r2']]], 'a repair no job raised is Hardening');
  });

  await t.test('a deflake, a design unit and polish take their own groups, in drawing order', () => {
    const milestone = e.data.plan!.milestones![1]!;
    const x = variant({ 'u47-docs': { origin: 'deflake' }, 'u48-docs': { origin: 'polish' } }, [], p => {
      (p.units.find(u => u.id === 'u48-docs') as { polish?: unknown }).polish = { milestone: milestone.id, proposal: 'P-1' };
      (p.milestones![0] as { design: unknown }).design = { unit: 'u48-docs-r2' };
    });
    // The re-entry's group is its root's (polish): a lineage is never split across groups, so the design entry on the
    // re-entry alone does not move it.
    assert.deepEqual(groupsOf(x), [[`polish:${milestone.id}`, ['u48-docs', 'u48-docs-r2']], ['deflake', ['u47-docs']]]);
    const y = variant({}, [], p => { (p.milestones![1] as { design: unknown }).design = { unit: 'u47-docs' }; });
    assert.deepEqual(groupsOf(y), [[`design:${milestone.id}`, ['u47-docs']], ['hardening', ['u48-docs', 'u48-docs-r2']]]);
  });

  await t.test('hidden by default: the field arc draws no withdrawn unit, and every edge lands on a drawn one', () => {
    const graph = graphView(e), hidden = graphData({ ...e, data: graph }), shown = graphData({ ...e, data: graph }, true);
    const withdrawn = graph.units.filter(u => u.signal === 'withdrawn').map(u => u.id);
    assert.ok(withdrawn.length >= 5 && withdrawn.includes('u50') && withdrawn.includes('u48-docs'));
    assert.equal(hidden.hiddenWithdrawn, withdrawn.length);
    const drawn = new Set(hidden.units.map((u: { id: string }) => u.id));
    assert.ok(withdrawn.every(id => !drawn.has(id)));
    for (const [s, d] of hidden.graph.edges as [string, string][]) for (const end of [s, d]) assert.ok(end.startsWith('milestone:') || drawn.has(end), `${s} -> ${d} ends at a drawn unit`);
    const a = graphLayout(hidden), b = graphLayout(shown);
    assert.equal(a.positions.size + withdrawn.length, b.positions.size);
    for (const id of withdrawn) {
      const next = shown.units.find((u: { id: string }) => u.id === id).successor as string | null;
      if (next === null) continue;
      assert.equal(b.bands.find((g: { ids: string[] }) => g.ids.includes(id))!.id, b.bands.find((g: { ids: string[] }) => g.ids.includes(next))!.id, `${id} is drawn in ${next}'s band`);
      assert.equal(b.positions.get(id)!.x, b.positions.get(next)!.x, `${id} shares ${next}'s column`);
    }
  });
});
