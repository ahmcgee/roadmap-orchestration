import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observationOf, verdictOf } from '../holistic/observe.ts';
import { witnessDir } from '../git/snapshot.ts';
import { keptInput, OBLIGATIONS_INPUT } from '../input/inforce.ts';
import { parseObligations, laneRevOf, isMustHold } from '../holistic/types.ts';
import { parseJobId, type ObligationId } from '../core/ids.ts';
import type { Event } from '../core/events.ts';
import type { AbsPath } from '../core/values.ts';
import type { Invocation } from './types.ts';

/** Relationships come from the revision recorded before a launch, never lane names or prose. */
export class InvocationRelations {
  #cache = new Map<string, ReturnType<typeof parseObligations> | null>();
  read(runDir: AbsPath, events: readonly Event[]): Map<string, Pick<Invocation, 'relatedUnits' | 'context' | 'assessment' | 'milestone'>> {
    const result = new Map<string, Pick<Invocation, 'relatedUnits' | 'context' | 'assessment' | 'milestone'>>();
    let obligations: ReturnType<typeof parseObligations> | null = null;
    const latched = new Set<ObligationId>();
    const futureRuns: { id: string; job: string; lane: string; laneRev: string; at: string; baseline: boolean; defs: ReturnType<typeof parseObligations>['obligations'] }[] = [];
    const walks = new Map<string, string>();
    for (const e of events) if (e.type === 'fact' && e.fact.kind === 'walk-started') walks.set(e.fact.job, e.fact.milestone);
    const mutations: { id: string; unit: string; attempt: number; lane: string }[] = [];
    for (const e of events) {
      if (e.type === 'fact' && e.fact.kind === 'plan-applied') {
        const hash = e.fact.obligationsSha256;
        if (hash && !this.#cache.has(hash)) {
          const bytes = keptInput(runDir, hash, OBLIGATIONS_INPUT);
          this.#cache.set(hash, bytes ? parseObligations(JSON.parse(bytes.toString())) : null);
        }
        obligations = hash ? this.#cache.get(hash) ?? null : null;

      }
      if (e.type === 'fact' && e.fact.kind === 'obligation-latched') latched.add(e.fact.obligation);
      if (e.type !== 'intent' || e.kind !== 'proc.spawn') continue;
      const subject = e.expect.subject;
      const id = `${e.op}#${e.ordinal}`;
      const milestone = subject.purpose === 'bring-up' ? subject.milestone : e.parent?.type === 'job' ? walks.get(e.parent.job) : undefined;
      if (milestone) result.set(id, { milestone });
      if (subject.purpose === 'mutant') {
        const of = 'of' in subject ? subject.of : null;
        result.set(id, { ...result.get(id), relatedUnits: of?.type === 'smoke' ? [of.unit] : [], context: 'Mutation probe · tests run against deliberately changed code' });
        if (of?.type === 'smoke') mutations.push({ id, unit: of.unit, attempt: of.attempt, lane: subject.lane });
      }
      if (subject.purpose !== 'journey' || !obligations) continue;
      const lane = obligations.lanes.find((lane) => lane.id === subject.lane && laneRevOf(lane) === subject.laneRev);
      if (!lane) continue;
      const witnessed = obligations.obligations.filter((o) => o.witness?.lane === lane.id);
      const relatedUnits = [...new Set(witnessed.flatMap((o) => o.deliveredBy))];
      const baselineCheck = subject.owner.type === 'job' && parseJobId(subject.owner.job).kind === 'baseline';
      if (subject.owner.type === 'job' && witnessed.length && witnessed.every((o) => !isMustHold(o, latched) && o.state.type === 'active')) futureRuns.push({ id, baseline: baselineCheck, job: subject.owner.job, lane: lane.id, laneRev: subject.laneRev, at: subject.at, defs: witnessed });
      result.set(id, { ...result.get(id), relatedUnits,
        context: `${baselineCheck ? 'Baseline witness check' : 'Witness check'} · ${witnessed.map((o) => o.id).join(', ')} → ${relatedUnits.join(', ')}${witnessed.length && witnessed.every((o) => !isMustHold(o, latched)) ? ' · before delivery' : ''}` });
    }
    // A red exit alone proves neither an expected future-requirement gap nor a successful mutation probe.
    for (const e of events) {
      if (e.type !== 'fact') continue;
      const fact = e.fact;
      if (fact.kind === 'witnessed' && fact.purpose === 'witness' && fact.for.type === 'job') {
        const job = fact.for.job;
        const source = futureRuns.find((r) => r.id === fact.inv && r.job === job && r.lane === fact.lane && r.laneRev === fact.laneRev);
        if (!source) continue;
        const runs = futureRuns.filter((r) => r.job === job && r.lane === fact.lane && r.laneRev === fact.laneRev && r.at === source.at);
        if (!events.some((c) => c.type === 'fact' && c.fact.kind === 'series-certified' && c.fact.parent.type === 'job' && c.fact.parent.job === job && c.fact.at === runs[0]!.at)) continue;
        const entry = { ...fact, seq: e.seq };
        let bytes: string | null;
        try { bytes = readFileSync(join(witnessDir(runDir, entry), 'witness.json'), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') bytes = null; else throw error; }
        const observation = observationOf(entry, bytes);
        if (!observation) continue;
        for (const run of runs) if (run.defs.every((o) => o.witness && verdictOf(observation.record, o.witness) === 'not-held')) {
          result.get(run.id)!.assessment = run.baseline ? 'baseline-red' : 'future-gap';
        }
      }
      if (fact.kind === 'smoke-ran') for (const run of mutations.filter((m) => m.unit === fact.unit && m.attempt === fact.attempt)) {
        const killed = fact.verdict.killed.some((t) => t.lane === run.lane);
        const survived = fact.verdict.survived.some((t) => t.lane === run.lane);
        const inconclusive = fact.verdict.inconclusive.some((t) => t.lane === run.lane);
        result.get(run.id)!.assessment = survived ? 'mutation-survived' : inconclusive ? 'mutation-inconclusive' : killed ? 'mutation-caught' : 'mutation-inconclusive';
      }
    }
    return result;
  }
}
