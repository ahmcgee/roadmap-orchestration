// A child executor for the plan-check shape crash tests (test/plancheck-shape.test.ts): argv <ArcDescriptor json> <unit>.
// As unit-child, but the routing's plan layer comes from ROADMAP_TEST_ROUTING_LAYER (JSON; absent: none), so a medium
// unit's builder can be a frontier one. Runs the unit driver to its end and prints the result as JSON.
import { resolveRouting } from '../../src/routing/layers.ts';
import type { RoutingLayer } from '../../src/routing/types.ts';
import { runUnit } from '../../src/pipeline/unit.ts';
import { admitAll } from './stage-common.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [json, id] = process.argv.slice(2);
if (json === undefined || id === undefined) throw new Error(`usage: shape-child <arc descriptor json> <unit>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = contextFor(JSON.parse(json) as ArcDescriptor);
const raw = process.env['ROADMAP_TEST_ROUTING_LAYER'];
const routing = resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: raw === undefined ? null : JSON.parse(raw) as RoutingLayer, unit: null });
const result = await runUnit({ ...r.ctx, routing: () => routing }, r.unit(id), admitAll);
process.stdout.write(`${JSON.stringify(result)}\n`);
r.journal.close();
