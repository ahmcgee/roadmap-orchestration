// Levers, proposals and the ruler fence (plan "Levers, proposals and the fence", G7, RC-3, RC-4, RC-8, RC-9). The tables
// here are frozen in step 0a (SCHEMAS.md "M4b"); the functions are step A2's. A path is the plan.json field it names:
// dotted keys, `[<key>]` for an entry of a keyed list (a resource by name, a lane or unit by id), `<tier>` a build tier.
import type { StationId } from '../core/ids.ts';
import { notYet } from '../core/notyet.ts';
import type { PlanM1 } from '../input/plan.ts';
import type { FlowAction, FlowDropped, FlowLever, FlowMetric, FlowPreimage, FlowProposal, TocStep } from './types.ts';

/** What an applied action may change (the fence: `diffPaths(plan, flowRevision(plan, action)) ⊆ LEVER_PATHS[lever]`, else a bug). */
export const LEVER_PATHS: { readonly [L in FlowLever]: readonly string[] } = {
  concurrency: ['capacity.cpu'],
  'resource-pool': ['resources[<name>].size'],
  'suite-lane': ['suite.lanes[<id>].argv', 'suite.lanes[<id>].cpu'],
  sequence: ['units[<id>].priority'],
  'build-class': ['routing.build.<tier>'],
  host: [],
};

/**
 * The ruler (Goodhart, code-consulted): what the optimizer never touches. A revision after the first admission whose
 * source is `command` (the root agent's `apply`) and that touches one raises a non-blocking `ruler-changed` item.
 * Bundles (checkpoint authority) and the owner's vision applies are not flagged.
 */
export const RULER_PATHS: readonly Readonly<{ path: string; what: string }>[] = [
  { path: 'holistic.obligations', what: 'the obligations file: obligations, their witness lanes, the arc lanes, the census and the impact mapping' },
  { path: 'holistic.audit', what: 'the audit cadence and lens set' },
  { path: 'holistic.advances', what: 'the vision clauses the arc advances' },
  { path: 'vision', what: 'the vision record' },
  { path: 'routing.<judgment role>', what: 'judgment-seat routing in the plan layer: planCheck, gate, lens, checkpoint, packReview, flow' },
  { path: 'units[<id>].routing.<judgment role>', what: 'judgment-seat routing in a unit layer' },
  { path: 'units[<id>].risk', what: 'risk floors' },
];

/** The focusing step each lever serves (G7). */
export const LEVER_STEP: { readonly [L in FlowLever]: TocStep } = {
  'suite-lane': 'exploit', 'build-class': 'exploit', sequence: 'subordinate', concurrency: 'elevate', 'resource-pool': 'elevate', host: 'elevate',
};

/** The one flag a suite-lane argv edit may change in place (RC-4, OI-2): its value only; selectors and every other element never change. */
export const ARGV_FLAGS = ['--test-concurrency'] as const;

/** The verdict metric of an action (G7): a suite lane's per-run service, the wait in front of `target`, or lead; null for `host`. */
export function metricOf(_action: FlowAction, _target: StationId): FlowMetric | null {
  return notYet('metricOf', 'A2');
}

/** The next plan, built from the action only; throws when its diff leaves `LEVER_PATHS[lever]`. */
export function flowRevision(_plan: PlanM1, _action: FlowAction): PlanM1 {
  return notYet('flowRevision', 'A2');
}

/** What `action` would replace in `plan`. */
export function preimageOf(_plan: PlanM1, _action: FlowAction): FlowPreimage {
  return notYet('preimageOf', 'A2');
}

/** The plan paths two plans differ at, in the notation above. */
export function diffPaths(_a: PlanM1, _b: PlanM1): readonly string[] {
  return notYet('diffPaths', 'A2');
}

/** Code's checks after the schema: the first that drops the proposal, or null. B1 supplies the context it needs. */
export function checkProposal(_proposal: FlowProposal, _context: unknown): FlowDropped | null {
  return notYet('checkProposal', 'A2');
}
