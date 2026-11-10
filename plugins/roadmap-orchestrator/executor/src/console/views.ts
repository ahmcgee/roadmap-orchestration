// Independent, allowlisted shell and graph projections. D1/D2/D4/D8/D9/D11.
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { Envelope } from '../observation/protocol.ts';
import { unitSignal } from './signals.ts';
import { identityIndex, stageFinished, stageIndex } from './indexes.ts';
import { milestoneMembership, milestoneReason, milestoneSignal } from './milestones.ts';
import { CONSOLE_UI_SCHEMA, type GraphView, type ShellView, type Scope, type View, type Preview, type DetailRef } from './view-protocol.ts';

export function preview(text: string, detail: DetailRef, limit = 240): Preview {
  return {text: text.length > limit ? text.slice(0, limit) : text, truncated: text.length > limit, detail};
}
export function arcBounds(e: Envelope) {
  const ended = e.data.events.findLast(ev => ev.type === 'fact' && (ev.fact.kind === 'arc-completed' || ev.fact.kind === 'stop-completed'));
  return {from: e.data.events[0]?.at ?? null, to: ended?.at ?? null};
}
export function versioned<T extends object>(data: T, scope: Scope): T & View {
  return {...data, uiSchema: CONSOLE_UI_SCHEMA, scope, viewVersion: sha256Hex(canonicalJson({data, scope}))};
}
export function shellView(e: Envelope): ShellView {
  const s = e.data.display.status, bounds = arcBounds(e);
  const terminal = e.data.events.findLast(ev => ev.type === 'fact' && (ev.fact.kind === 'arc-completed' || ev.fact.kind === 'stop-completed'));
  const countsByState: Record<string, number> = {};
  for (const u of s.units) countsByState[u.state] = (countsByState[u.state] ?? 0) + 1;
  const blocking = e.data.requests.filter(r => r.blocking).length;
  return versioned({
    identity: {arc: String(e.arc), direction: e.data.plan?.direction.trim() ? {text: e.data.plan.direction.trim().slice(0, 600), truncated: e.data.plan.direction.trim().length > 600} : null},
    lifecycle: {state: terminal?.type === 'fact' ? terminal.fact.kind === 'arc-completed' ? 'complete' : 'no-owner' : s.run.state, startedAt: bounds.from, endedAt: bounds.to},
    progress: {total: s.units.length, countsByState, merged: countsByState['merged'] ?? 0, withdrawn: (countsByState['cut'] ?? 0) + (countsByState['superseded'] ?? 0)},
    spend: {costUsd: e.data.summary.spend.costUsd, estimatedCalls: e.data.summary.spend.estimatedCalls, unavailableCalls: e.data.summary.spend.unavailableCalls},
    attention: {total: e.data.requests.length, blocking, informational: e.data.requests.length - blocking},
    availableRange: {from: bounds.from, to: bounds.to ?? e.data.events.at(-1)?.at ?? null},
  }, {basis: 'current', ...bounds});
}
export function graphView(e: Envelope): GraphView {
  const s = e.data.display.status, identities = identityIndex(e), steps = stageIndex(e.data.events).byUnit;
  const units: GraphView['units'] = s.units.map(u => {
    const identity = identities.get(u.unit)!;
    return {id: String(u.unit), title: identity.title.slice(0, 96), titleTruncated: identity.title.length > 96,
      signal: unitSignal(u.state),
      state: u.state, stage: u.stage, stageFinished: stageFinished(steps.get(u.unit), u.stage), systems: identity.systems, lineageRef: u.lineage || u.supersededBy ? String(u.unit) : null};
  });
  const states = new Map(s.milestones.map(m => [String(m.id), m])), membership = milestoneMembership(e);
  const milestones: GraphView['milestones'] = (e.data.plan?.milestones ?? []).map(m => {
    const state = states.get(m.id)!, members = membership.milestones.find(g => g.id === m.id)!;
    return {id: String(m.id), ...(m.name === undefined ? {} : {name: m.name}), state: state.state, passed: state.passed, memberIds: members.memberIds,
      merged: members.merged, withdrawn: members.withdrawn, signal: milestoneSignal(e, state), reason: milestoneReason(e, membership, m.id), costUsd: e.data.summary.milestones.find(g => g.id === m.id)!.costUsd};
  });
  const edges: GraphView['edges'] = s.edges.map(edge => {
    switch (edge.type) {
      case 'after': return {kind: 'after', source: edge.effective, target: edge.unit, on: edge.on, met: edge.met};
      case 'milestone': return {kind: 'milestone', source: `milestone:${edge.milestone}`, target: edge.unit, passed: edge.passed};
      case 'contingent': return {kind: 'contingent', target: edge.unit, edge: edge.edge, condition: preview(edge.condition, {type: 'unit', id: edge.unit}), resolved: edge.resolved};
    }
  });
  for (const m of milestones) for (const unit of m.memberIds) edges.push({kind: 'feeds', source: unit, target: `milestone:${m.id}`});
  return versioned({units, milestones, noMilestone: {ids: membership.none.ids, merged: membership.none.merged, withdrawn: membership.none.withdrawn}, edges, focus: {activeIds: units.filter(u => u.signal === 'active').map(u => u.id), firstUncleared: milestones.find(m => !m.passed)?.id ?? null}}, {basis: 'current', from: null, to: null});
}
/** Each projection has its own bounded cache. No observations or report objects are retained here. */
export class ConsoleViews {
  #shell = new Map<string, ShellView>();
  #graph = new Map<string, GraphView>();
  shell(e: Envelope) { return this.#read(this.#shell, e, shellView); }
  graph(e: Envelope) { return this.#read(this.#graph, e, graphView); }
  #read<T>(cache: Map<string, T>, e: Envelope, build: (e: Envelope) => T): T {
    const key = `${e.instance}:${e.arc}:${e.epoch}:${e.data.capture.source}`;
    let value = cache.get(key);
    if (!value) value = build(e);
    cache.delete(key); cache.set(key, value);
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
    return value;
  }
}
