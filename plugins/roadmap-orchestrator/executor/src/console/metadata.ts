import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { Event } from '../core/events.ts';
import { captureKey, type Envelope } from '../observation/protocol.ts';
import { identityIndex, stageIndex } from './indexes.ts';
import { CONSOLE_UI_SCHEMA, type ViewVersions, type Metadata } from './view-protocol.ts';
import type { ConsoleViews } from './views.ts';

const hash = (value: unknown) => sha256Hex(canonicalJson(value));
/** Semantic dependencies are hashed once per stable capture, never by building all tabs on
 * a heartbeat. Only cheap identity/stage indexes and hashes are retained (eight captures). */
export class ConsoleMetadata {
  #entries = new Map<string, {versions: ViewVersions; identities: ReturnType<typeof identityIndex>; stages: ReturnType<typeof stageIndex>}>();
  read(e: Envelope, views: ConsoleViews, selected: string | null): Metadata {
    const key = captureKey(e);
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
      // Journal identity/order and captured side-file dependencies invalidate the typed views. These are tokens, not a page or
      // another journal fold: within one epoch the journal is append-only and verified, so the seq of the last event in a
      // category identifies every event of that category before it. Hashing the events themselves cost work and memory in
      // proportion to the whole log on every append.
      const through = (match: (ev: Event) => boolean) => ({epoch: e.epoch, seq: e.data.events.findLast(match)?.seq ?? 0});
      const fact = (kinds: readonly string[]) => (ev: Event) => ev.type === 'fact' && kinds.includes(ev.fact.kind);
      const journal = {epoch: e.epoch, seq: e.data.events.at(-1)?.seq ?? 0}, identity = hash([...identities]);
      const stageVersion = hash([...stages.steps]);
      const parks = through(fact(['backend-park','resumed','probe','arc-completed','stop-completed']));
      const waiting = through(ev => ev.type === 'fact' && ev.fact.kind === 'stage-admitted'
        || (ev.type === 'intent' || ev.type === 'done') && ev.kind === 'resource.transition');
      const money = through(fact(['meter','usage-unavailable']));
      const attention = hash({identity,requests:e.data.requests});
      const holistic = hash({holistic: s.holistic, audit: s.audit, findings: s.findings, decisions: s.decisionsSince,
        audits: through(fact(['audit-started','audit-ended']))});
      entry = {identities, stages, versions: {
        shell: views.shell(e).viewVersion, graph: views.graph(e).viewVersion,
        timeline: hash({identity, invocations, units, parks, stageVersion}),
        activity: hash({identity, journal, invocations, attention, holistic}), holistic,
        effort: hash({identity, invocations, units, stageVersion, waiting, money, parks, queues: [s.host.jobQueue,s.host.queue], milestones: e.data.plan?.milestones ?? []}),
        resources: hash({identity, host:s.host, owner:s.run.owner.state, units, work: invocations.map(i => ({id: i.id, role:i.role, attempt:i.attempt, startedAt:i.startedAt, endedAt:i.endedAt, work:i.work})), waiting, parks}), attention,
      }};
      this.#entries.set(key, entry);
      while (this.#entries.size > 8) this.#entries.delete(this.#entries.keys().next().value!);
    }
    const {data: _data, ...metadata} = e;
    return {...metadata, uiSchema: CONSOLE_UI_SCHEMA, selected, viewVersions: entry.versions};
  }
}
