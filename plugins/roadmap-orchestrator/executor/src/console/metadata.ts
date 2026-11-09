import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { Envelope } from '../observation/protocol.ts';
import { identityIndex, stageIndex } from './indexes.ts';
import { CONSOLE_UI_SCHEMA, type ViewVersions, type Metadata } from './view-protocol.ts';
import type { ConsoleViews } from './views.ts';

const hash = (value: unknown) => sha256Hex(canonicalJson(value));
/** Semantic dependencies are hashed once per stable capture, never by building all tabs on
 * a heartbeat. Only cheap identity/stage indexes and hashes are retained (eight captures). */
export class ConsoleMetadata {
  #entries = new Map<string, {versions: ViewVersions; identities: ReturnType<typeof identityIndex>; stages: ReturnType<typeof stageIndex>}>();
  read(e: Envelope, views: ConsoleViews, selected: string | null): Metadata {
    const key = `${e.instance}:${e.arc}:${e.epoch}:${e.data.capture.source}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      const s = e.data.display.status;
      const identities = identityIndex(e), stages = stageIndex(e.data.events);
      const units = s.units.map(u => ({id: u.unit, state: u.state, stage: u.stage,
        waitingFor: u.waitingFor ? {...u.waitingFor, tokenWaitMs: u.waitingFor.tokenWaitMs == null ? null : 'recorded'} : null}));
      const invocations = e.data.display.invocations.map(i => ({id: i.id, unit: i.unit, role: i.role, attempt: i.attempt, state: i.state, assessment: i.assessment ?? null,
        scope: i.scope ?? null, relatedUnits: i.relatedUnits ?? [], milestone: i.milestone ?? null, execution: i.execution ?? null,
        backend: i.backend ?? null, model: i.model ?? null, requestedModel: i.requestedModel ?? null,
        startedAt: i.startedAt, endedAt: i.endedAt, work: i.work ?? null}));
      // Journal identity/order and captured side-file dependencies suffice for the future typed
      // activity index. This is an invalidation token, not a page or another journal fold.
      const journal = hash(e.data.events), identity = hash([...identities]);
      const stageVersion = hash([...stages.steps]);
      const parks = hash(e.data.events.filter(ev => ev.type === 'fact' && ['backend-park','resumed','probe','arc-completed','stop-completed'].includes(ev.fact.kind)));
      const waiting = hash(e.data.events.filter(ev => ev.type === 'fact' && ev.fact.kind === 'stage-admitted'
        || (ev.type === 'intent' || ev.type === 'done') && ev.kind === 'resource.transition'));
      const money = hash(e.data.events.filter(ev => ev.type === 'fact' && ['meter','usage-unavailable'].includes(ev.fact.kind)));
      const attention = hash(e.data.requests);
      const holistic = hash({holistic: s.holistic, audit: s.audit, findings: s.findings, decisions: s.decisionsSince,
        audits: e.data.events.filter(ev => ev.type === 'fact' && ['audit-started','audit-ended'].includes(ev.fact.kind))});
      entry = {identities, stages, versions: {
        shell: views.shell(e).viewVersion, graph: views.graph(e).viewVersion,
        timeline: hash({identity, invocations, units, parks, stageVersion}),
        activity: hash({identity, journal, invocations, attention, holistic}), holistic,
        effort: hash({identity, invocations, units, stageVersion, waiting, money}),
        resources: hash({host: s.host, units, work: invocations.map(i => ({id: i.id, work: i.work})), waiting, parks}), attention,
      }};
      this.#entries.set(key, entry);
      while (this.#entries.size > 8) this.#entries.delete(this.#entries.keys().next().value!);
    }
    const {data: _data, ...metadata} = e;
    return {...metadata, uiSchema: CONSOLE_UI_SCHEMA, selected, viewVersions: entry.versions};
  }
}
