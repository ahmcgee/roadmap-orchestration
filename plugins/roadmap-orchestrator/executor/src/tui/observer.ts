import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { keptInput, inputPath } from '../input/inforce.ts';
import { readClaim } from '../host/lock.ts';
import { locate, type Run } from '../cli/locate.ts';
import { ObserverJournal, type LogSnapshot } from '../core/log.ts';
import { invocationId, invocationIdOf, sha256 } from '../core/ids.ts';
import { readJson } from '../core/fsx.ts';
import { JUDGMENT_SESSION_ROLES } from '../routing/types.ts';
import { runStart } from '../core/records.ts';
import { absPath, type AbsPath } from '../core/values.ts';
import { status } from '../status.ts';
import { runnerFiles } from '../runner/files.ts';
import { launchSha256 } from '../runner/launch.ts';
import { invocationDir } from '../pipeline/invoke.ts';
import { recordOf } from '../needsuser.ts';
import { estate } from './estate.ts';
import { activityState, assessmentExplanation } from './outcome.ts';
import { InvocationRelations } from './relations.ts';
import { ModelReader } from './models.ts';
import { TranscriptReader } from './transcript.ts';
import { project, record } from './projection.ts';
import { type Display, type Entry, type Invocation, type LogPage, type ObserveRequest, type ObserveReply, pretty } from './types.ts';

const entry = (id: string, label: string, state: string, value: unknown): Entry => ({ id, label, state, body: pretty(value), links: [], provenance: 'validated runtime snapshot' });

export class Observer {
  #run: Run | null = null;
  #journal: ObserverJournal | null = null;
  #logs = new TranscriptReader();
  #models = new ModelReader();
  #relations = new InvocationRelations();
  #estate: { key: string; entries: Entry[] } | null = null;
  #view: LogSnapshot['view'] | null = null;
  #ended = new Map<string, Invocation>();
  #dirs = new Map<string, AbsPath>();
  #launchHashes = new Map<string, string>();
  #verifiedPrompts = new Map<string, string>();

  observe(request: ObserveRequest): ObserveReply {
    try {
      const run = request.pinned ?? (request.locator.type === 'host' && readClaim(request.hostDir) === null && this.#run !== null ? this.#run : locate(request.locator, request.hostDir));
      if (run.runDir !== this.#run?.runDir) {
        this.#run = run;
        this.#journal = new ObserverJournal(run.runDir, run.arc);
        this.#estate = null;
        this.#ended.clear();
        this.#dirs.clear(); this.#launchHashes.clear(); this.#verifiedPrompts.clear();
      }
      const snapshot = this.#journal!.read();
      if (snapshot.view !== this.#view) { this.#ended.clear(); this.#logs = new TranscriptReader(); this.#models = new ModelReader(); this.#relations = new InvocationRelations(); this.#estate = null; this.#view = snapshot.view; }
      const s = status(run.runDir, run.arc, request.hostDir, snapshot);
      const invocations = this.invocations(run, snapshot, s.run.owner.state === 'alive');
      const exceptions: Entry[] = [
        ...s.needsUser.filter((n) => n.blocking).map((n) => entry(n.id, `Owner request ${n.id}: ${n.reason}`, 'waiting', recordOf(run.runDir, n.id))),
        ...s.parkedBackends.map((b) => entry(`backend:${b}`, `Parked backend ${b}`, 'parked', b)),
        ...s.holds.map((h, i) => entry(`hold:${i}`, `Hold ${pretty(h)}`, 'held', h)),
        ...s.units.filter((u) => u.state === 'blocked' || u.state === 'held' || u.state === 'parked' || u.failures.length > 0)
          .map((u) => entry(`unit:${u.unit}`, `${u.unit}: ${u.state}${u.failures.length ? ' / recorded failures' : ''}`, u.failures.length ? 'failed' : u.state, u)),
        ...invocations.filter((i) => /fault|fail|lost|malformed|refusal|stall/.test(activityState(i))).map((i) => ({ ...i, state: activityState(i), label: `${i.unit} ${i.role}: ${activityState(i)}` })),
      ];
      const startPath = join(run.runDir, 'start.json');
      const start = existsSync(startPath) ? runStart(readJson(startPath), startPath) : null;
      const estateKey = `${snapshot.view.holistic().debt.length}:${snapshot.view.planApplied()?.payloadSha256}:${snapshot.view.integrationHead()}:${s.units.map((u) => {
        const unit = snapshot.view.unit(u.unit); return `${unit.spec?.sha256}:${unit.status}`;
      }).join(',')}`;
      if (this.#estate?.key !== estateKey) this.#estate = { key: estateKey, entries: estate(run.runDir, snapshot.view, start?.repo ?? null) };
      const plan = this.#estate.entries.find((e) => e.id === 'plan');
      const milestoneUnits: Record<string, readonly string[]> = {};
      if (plan) {
        const parsed = JSON.parse(plan.body) as { milestones?: { id: string; units: string[] }[] };
        for (const m of parsed.milestones ?? []) milestoneUnits[m.id] = m.units;
      }
      const display: Display = { run, at: new Date().toISOString(), seq: snapshot.view.highWater(), status: s, invocations,
        estate: this.#estate.entries, exceptions, milestoneUnits };
      let log: LogPage | null = null;
      if (request.log !== null) {
        const selected = invocations.find((i) => i.id === request.log!.inv);
        const dir = this.#dirs.get(request.log.inv);
        if (request.log.source === 'prompt' && dir) {
          const launch = runnerFiles(dir, invocationIdOf(request.log.inv)).read('launch.json');
          if (launch && launchSha256(launch) !== this.#launchHashes.get(request.log.inv)) throw new Error('Recorded prompt launch binding changed');
          const match = launch?.stdinPath ? /^([0-9a-f]{64})\.prompt\.txt$/.exec(basename(launch.stdinPath)) : null;
          const missing = (reason: string): LogPage => ({ key: `${request.log!.inv}:prompt`, start: 0, end: 0, size: 0, lines: [reason], error: reason });
          if (!match) log = missing('No retained agent input prompt is recorded for this invocation.');
          else {
            const hash = sha256(match[1]!); const path = inputPath(run.runDir, hash, 'prompt.txt');
            if (!existsSync(path)) log = missing('The recorded input prompt is unavailable or has been pruned.');
            else {
              const stat = statSync(path); const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
              if (this.#verifiedPrompts.get(path) !== stamp) {
                keptInput(run.runDir, hash, 'prompt.txt');
                this.#verifiedPrompts.delete(path); this.#verifiedPrompts.set(path, stamp);
                while (this.#verifiedPrompts.size > 8) this.#verifiedPrompts.delete(this.#verifiedPrompts.keys().next().value!);
              }
              log = this.#logs.read(path, request.log.before, false, false, request.log.after);
            }
          }
        }
        else if (request.log.source === 'result' && selected && dir) {
          const files = runnerFiles(dir, invocationIdOf(selected.id));
          const result = files.read('result.json');
          const details = { invocation: JSON.parse(selected.body), launch: files.read('launch.json'), runner: files.read('runner.json'),
            result: result ?? 'Unavailable or pruned result', exit: files.read('exit.json') };
          const outcome = record(record(result)['outcome']);
          const friendly = {
            ...(selected.execution === 'agent' ? { model: selected.model ?? 'unavailable', backend: selected.backend ?? 'unavailable', adapter: selected.adapter ?? null, requestedModel: selected.requestedModel ?? null } : {}),
            ...(selected.milestone ? { milestone: selected.milestone } : {}),
            outcome: activityState(selected), processOutcome: selected.state, ...(assessmentExplanation(selected) ? { explanation: assessmentExplanation(selected) } : {}), role: selected.role, unit: selected.unit, attempt: selected.attempt,
            ...(outcome['value'] !== undefined ? { report: outcome['value'] } : {}),
            ...(outcome['detail'] !== undefined ? { detail: outcome['detail'] } : {}),
            startedAt: selected.startedAt, endedAt: selected.endedAt,
            result: result?.type === 'backend' && result.outcome.kind === 'success' ? { ...result, outcome: { kind: result.outcome.kind } } : result ?? 'Unavailable or pruned result', executionDetails: { invocation: selected.id, session: selected.session || null, cwd: details.launch?.cwd ?? null, exit: details.exit, diagnostics: 'Press r for full launch arguments and runner metadata.' },
          };
          log = { key: `${selected.id}:result`, start: 0, end: 0, size: 0,
            lines: request.log.raw ? pretty(details).split('\n') : project(friendly).map((row) => row.text), error: null };
        }
        else if (dir) log = this.#logs.read(join(dir, request.log.source === 'transcript' ? 'stdout' : request.log.source), request.log.before, ['transcript', 'stdout'].includes(request.log.source) && !request.log.raw, request.log.expanded, request.log.after);
        else log = { key: request.log.inv, start: 0, end: 0, size: 0, lines: ['Unavailable or pruned invocation'], error: 'Unavailable or pruned invocation' };
      }
      return { token: request.token, display, log, error: null };
    } catch (error) {
      // Retain the last published model on the UI thread, never publish a partial observation.
      return { token: request.token, display: null, log: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private invocations(run: Run, snapshot: LogSnapshot, alive: boolean): Invocation[] {
    const rows: Invocation[] = [];
    const terminal = new Map<string, { at: string; value: unknown; state: string }>();
    const ordinal = new Map<string, number>();
    for (const e of snapshot.events) {
      if (e.type === 'intent' && e.kind === 'proc.spawn') ordinal.set(e.op, e.ordinal);
      if ((e.type === 'done' && e.kind === 'proc.spawn') || e.type === 'abort') {
        const inv = invocationId(e.op, ordinal.get(e.op) ?? 1);
        terminal.set(inv, { at: e.at, value: e.type === 'abort' ? { reason: e.reason } : { outcome: e.outcome, recoveredBy: e.recoveredBy },
          state: e.type === 'abort' ? `aborted:${e.reason.code}` : e.outcome.kind });
      }
    }
    const relations = this.#relations.read(run.runDir, snapshot.events);
    const retained = new Set<string>();
    for (const e of snapshot.events) {
      if (e.type !== 'intent' || e.kind !== 'proc.spawn') continue;
      const id = invocationId(e.op, e.ordinal);
      retained.add(id);
      const dir = invocationDir(run.runDir, id);
      this.#dirs.set(id, dir); this.#launchHashes.set(id, e.expect.launchSha256);
      const cached = this.#ended.get(id);
      if (cached) { const { assessment: _assessment, ...base } = cached; rows.push({ ...base, ...relations.get(id) }); continue; }
      const files = runnerFiles(dir, id);
      const launch = files.read('launch.json');
      if (launch !== null && launchSha256(launch) !== e.expect.launchSha256) throw new Error(`${dir}/launch.json does not hash to its recorded launchSha256`);
      const result = files.read('result.json');
      const exit = files.read('exit.json');
      files.read('runner.json'); // Validate identity bindings, even though liveness comes from the host owner.
      const done = terminal.get(id);
      const subject = e.expect.subject;
      const unit = subject.purpose === 'mutant' && 'of' in subject && subject.of.type === 'smoke' ? subject.of.unit : 'unit' in subject && subject.unit ? subject.unit : 'owner' in subject && subject.owner.type === 'unit' ? subject.owner.unit : 'job' in subject ? subject.job : e.parent.type === 'job' ? e.parent.job : 'arc';
      const role = launch?.terminal.type === 'backend' ? launch.terminal.role : 'role' in subject ? subject.role : 'lane' in subject ? `${subject.purpose}:${subject.lane}` : subject.purpose;
      const session = result?.type === 'backend' ? result.session ?? '' : launch?.terminal.type === 'backend' && 'id' in launch.terminal.session ? launch.terminal.session.id : '';
      const state = done && done.state !== 'result' ? done.state : result?.type === 'backend' ? result.outcome.kind : result?.type === 'command' ? result.verdict
        : done?.state ?? (exit ? `exited:${exit.cause}` : alive ? 'running' : 'unowned');
      const output = ['stdout', 'stderr'].flatMap((f) => {
        const p = join(dir, f); return existsSync(p) ? [statSync(p).mtimeMs] : [];
      });
      const inputKind = launch?.terminal.type === 'backend' ? launch.terminal.session.mode === 'fresh' ? 'initial'
        : JUDGMENT_SESSION_ROLES.some((judgmentRole) => judgmentRole === role) ? 'repair' : 'resume' : undefined;
      const row: Invocation = {
        ...relations.get(id),
        ...(inputKind ? { inputKind } : {}),
        ...((launch?.terminal.type === 'backend' || result?.type === 'backend') ? this.#models.read(launch, join(dir, 'stdout')) : {}),
        ...('unit' in subject && subject.unit || e.parent.type === 'stage' ? { scope: 'unit' as const }
          : subject.purpose === 'arc-backend' || e.parent.type === 'arc' ? { scope: 'arc' as const } : {}),
        ...(launch ? { execution: launch.terminal.type === 'backend' ? 'agent' as const : 'command' as const } : result ? { execution: result.type === 'backend' ? 'agent' as const : 'command' as const } : {}),
        ...entry(id, `${unit} / ${role}${inputKind === 'repair' ? ' / repair' : inputKind === 'resume' ? ' / resumed' : ''}`, state, { subject, parent: e.parent, session, outcome: state, resultAvailable: result !== null, exit, settlement: done?.value ?? null }),
        unit, role, session, attempt: 'attempt' in subject ? subject.attempt : e.parent.type === 'stage' ? e.parent.attempt : e.ordinal,
        startedAt: e.at, endedAt: done?.at ?? exit?.endedAt ?? null,
        quietMs: output.length ? Math.max(0, Date.now() - Math.max(...output)) : null,
        latest: this.#logs.latest(join(dir, 'stdout')),
      };
      rows.push(row);
      if (done) { this.#ended.set(id, row); this.#logs.forgetLatest(join(dir, 'stdout')); }
    }
    for (const id of this.#ended.keys()) if (!retained.has(id)) this.#ended.delete(id);
    return rows.sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null) || (a.endedAt === null ? a.startedAt.localeCompare(b.startedAt) : b.endedAt!.localeCompare(a.endedAt)));
  }
}
