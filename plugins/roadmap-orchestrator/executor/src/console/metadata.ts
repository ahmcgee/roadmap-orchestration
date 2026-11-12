import { canonicalJson, sha256Hex } from '../core/json.ts';
import { captureKey, type Envelope } from '../observation/protocol.ts';
import { identityIndex } from './indexes.ts';
import { tokensFor } from './tokens.ts';
import { CONSOLE_UI_SCHEMA, type ViewVersions, type Metadata } from './view-protocol.ts';
import type { ConsoleViews } from './views.ts';

const hash = (value: unknown) => sha256Hex(canonicalJson(value));
/** Semantic dependencies are hashed once per capture, never by building all tabs on a heartbeat, from tokens kept as the
 * journal and rows change (src/console/tokens.ts). Only the versions are retained (eight captures). */
export class ConsoleMetadata {
  #entries = new Map<string, {versions: ViewVersions}>();
  read(e: Envelope, views: ConsoleViews, selected: string | null): Metadata {
    // A rows-only refresh keeps the capture; a changed row it read again still changes the versions.
    const key = `${captureKey(e)}:${tokensFor(e.data).invocations().digest}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      const s = e.data.display.status, t = tokensFor(e.data);
      const identities = identityIndex(e);
      const units = s.units.map(u => ({id: u.unit, state: u.state, stage: u.stage,
        waitingFor: u.waitingFor ? {...u.waitingFor, tokenWaitMs: u.waitingFor.tokenWaitMs == null ? null : 'recorded'} : null}));
      // The rows' order-free digest and count: a changed row changes it, a row read again unchanged does not.
      const rows = t.invocations(), invocations = {count: rows.count, digest: rows.digest};
      // Journal identity/order and captured side-file dependencies invalidate the typed views. These are tokens, not a page or
      // another journal fold: within one epoch the journal is append-only and verified, so the seq of the last event in a
      // category identifies every event of that category before it. Each is kept as the events are folded (src/console/tokens.ts).
      const at = (seq: number) => ({epoch: e.epoch, seq});
      const journal = at(t.seq), identity = hash([...identities]);
      const stageVersion = at(t.stages.touched);
      const parks = at(t.parks), waiting = at(t.waiting), money = at(t.money);
      const attention = hash({identity,requests:e.data.requests});
      const holistic = hash({holistic: s.holistic, audit: s.audit, findings: s.findings, decisions: s.decisionsSince, audits: at(t.audits)});
      entry = {versions: {
        shell: views.shell(e).viewVersion, graph: views.graph(e).viewVersion,
        timeline: hash({identity, invocations, units, parks, stageVersion}),
        activity: hash({identity, journal, invocations, attention, holistic}), holistic,
        effort: hash({identity, invocations, units, stageVersion, waiting, money, parks, queues: [s.host.jobQueue,s.host.queue], milestones: e.data.plan?.milestones ?? []}),
        resources: hash({identity, host:s.host, owner:s.run.owner.state, units, work: {count: rows.count, digest: rows.resources}, waiting, parks}), attention,
      }};
      this.#entries.set(key, entry);
      while (this.#entries.size > 8) this.#entries.delete(this.#entries.keys().next().value!);
    }
    const {data: _data, ...metadata} = e;
    return {...metadata, uiSchema: CONSOLE_UI_SCHEMA, selected, lastEventAt: tokensFor(e.data).lastAt, viewVersions: entry.versions};
  }
}
