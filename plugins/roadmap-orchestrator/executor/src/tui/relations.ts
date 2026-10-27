import { readFileSync, statSync } from 'node:fs';
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
  #witnesses = new Map<string, { stamp: string; bytes: string }>();
  private witness(path: string): string | null {
    try {
      const st = statSync(path); const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      const cached = this.#witnesses.get(path);
      if (cached?.stamp === stamp) return cached.bytes;
      const bytes = readFileSync(path, 'utf8');
      this.#witnesses.set(path, { stamp, bytes });
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#witnesses.delete(path); return null;
    }
  }
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
    const certified = new Set<string>();
    for (const e of events) if (e.type === 'fact' && e.fact.kind === 'series-certified' && e.fact.parent.type === 'job') certified.add(JSON.stringify([e.fact.parent.job, e.fact.at]));
    const sources = new Map<string, typeof futureRuns[number]>();
    const series = new Map<string, typeof futureRuns>();
    for (const run of futureRuns) {
      const key = JSON.stringify([run.id, run.job, run.lane, run.laneRev]);
      if (!sources.has(key)) sources.set(key, run);
      const group = JSON.stringify([run.job, run.lane, run.laneRev, run.at]);
      const runs = series.get(group) ?? []; runs.push(run); series.set(group, runs);
    }
    const probes = new Map<string, typeof mutations>();
    for (const run of mutations) {
      const key = JSON.stringify([run.unit, run.attempt]);
      const runs = probes.get(key) ?? []; runs.push(run); probes.set(key, runs);
    }
    // A red exit alone proves neither an expected future-requirement gap nor a successful mutation probe.
    for (const e of events) {
      if (e.type !== 'fact') continue;
      const fact = e.fact;
      if (fact.kind === 'witnessed' && fact.purpose === 'witness' && fact.for.type === 'job') {
        const job = fact.for.job;
        const source = sources.get(JSON.stringify([fact.inv, job, fact.lane, fact.laneRev]));
        if (!source) continue;
        const runs = series.get(JSON.stringify([job, fact.lane, fact.laneRev, source.at]))!;
        if (!certified.has(JSON.stringify([job, source.at]))) continue;
        const entry = { ...fact, seq: e.seq };
        const bytes = this.witness(join(witnessDir(runDir, entry), 'witness.json'));
        const observation = observationOf(entry, bytes);
        if (!observation) continue;
        for (const run of runs) if (run.defs.every((o) => o.witness && verdictOf(observation.record, o.witness) === 'not-held')) {
          result.get(run.id)!.assessment = run.baseline ? 'baseline-red' : 'future-gap';
        }
      }
      if (fact.kind === 'smoke-ran') for (const run of probes.get(JSON.stringify([fact.unit, fact.attempt])) ?? []) {
        const killed = fact.verdict.killed.some((t) => t.lane === run.lane);
        const survived = fact.verdict.survived.some((t) => t.lane === run.lane);
        const inconclusive = fact.verdict.inconclusive.some((t) => t.lane === run.lane);
        result.get(run.id)!.assessment = survived ? 'mutation-survived' : inconclusive ? 'mutation-inconclusive' : killed ? 'mutation-caught' : 'mutation-inconclusive';
      }
    }
    return result;
  }
}
