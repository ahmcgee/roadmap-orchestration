// `snapshot.publish`: copy the run's authoritative records one-way to `refs/roadmap/<arc>` (DESIGN §2.9), so no
// PR diff carries them and the arc's history survives the run dir.
//
// The input is frozen at an event high-water seq: the snapshot carries the first `highWater` lines of
// `events.jsonl` and the state the fold derives from exactly those lines (never the live `state.json` cache,
// which may already be ahead). Beside them, the snapshot is the transitive closure of the authoritative records
// those lines name (G6, H6; `closureOf`), each file carried at a path its naming record determines:
//
// | Snapshot path                          | Named by                                                           |
// |----------------------------------------|--------------------------------------------------------------------|
// | `inputs/<sha256>.<ext>`                | a `plan-applied` (plan, specs, ledger, obligations, vision, payload), |
// |                                        | a `revision.commit` intent (payload), a kept payload (its manifest's |
// |                                        | inputs, sidecars, renders), a `spec.patch` done, a `dispatch`,      |
// |                                        | `judgment-inputs` or `reopened` fact (spec), a `steered` fact (brief), |
// |                                        | a vacuity `finding-opened` (its mutant `.patch`)                   |
// | `routing-provenance/<rev>.json`        | a 1.0.0-dev.5 `plan-applied` (none recorded): reconstructed once at |
// |                                        | adoption (`adoptLegacyProvenance`, H7), or why it cannot be          |
// | `start.json`                           | the latest `executor-started` fact (its generation)                |
// | `inv/<seq>-<ordinal>/result.json`,     | a backend `proc.spawn` done `result` (reads.json: a Claude call's)  |
// | `reads.json`                           |                                                                    |
// | `witness/<seq>-<ordinal>.json`         | a `witnessed` fact (a job's, a candidate's or a mutant's run): its `witness.json` |
// | `needs-user/<id>.json`, `<id>.ack.json`| a done `needsuser.raise` intent; a `needs-user-acked` fact          |
// | `evidence-manifests/<seq>.json`        | a done `evidence.snapshot` (the manifest only, never raw evidence) |
//
// Paths that name a run-dir file mirror it (`inputs/`, `inv/`, `needs-user/`, `routing-provenance/`, `start.json`,
// `events.jsonl`, `state.json`), so the run dir's records are restored by copying the tree into it. A witness run
// keeps its `witness.json` in its own execution's dir (`witnessDir`, written by src/pipeline/lanes.ts
// `runJourneySeries`): a job's `<runDir>/evidence/jobs/<job>/arc-<lane>-<inv>/` (`jobLaneDir`), a unit candidate's
// `<runDir>/evidence/<unit>/<attempt>-candidate/journey/arc-<lane>-<inv>/` (`candidateLaneDir`), a mutant's (written by
// src/pipeline/reproduce.ts) `<runDir>/evidence/mutants/<finding>/<lane>-<inv>/` (`mutantLaneDir`).
//
// `manifest.json` lists every other file's sha256, size and naming record (`namedBy`: the log itself, an event
// seq, or another item's path) with the arc and the high-water mark. `verifySnapshot` recomputes the closure from
// the tree's own events and payloads: the tree holds exactly it, each file hashing as the manifest lists and as
// its naming record states. Raw evidence, stdout and stderr, and worktrees never enter the tree.
//
// The blobs and the tree are written at prepare; the commit (parent = the old ref, or none) has recorded inputs,
// so act and any redo make the same id; the ref moves by CAS.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import {
  type CommitInputs, type Event, type IntentOf, type IntentRecord, type OpOutcome, type RevisionPayload, type WitnessFor, parentUnit, parseEventLine,
  parseRevisionPayload,
} from '../core/events.ts';
import { exclusivePublish, canonicalJson as fileJson } from '../core/fsx.ts';
import {
  type ArcId, type FindingId, type InvocationId, type JobId, type LaneId, type NeedsUserId, type OpId, type PlanRev, type RoutingRev, type Sha, type Sha256Hex, type UnitId, arcId, invocationDirName,
  invocationId, parseOpId, routingRev, sha, sha256,
} from '../core/ids.ts';
import type { GitSteps, IntentBody, JournalView } from '../core/interfaces.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { EVENTS_FILE } from '../core/log.ts';
import { runStart } from '../core/records.ts';
import { fold } from '../core/state.ts';
import { Fields, type Read, SchemaError, arrayOf, literal, nat, object, positive, sortedBy, str, tagged, version } from '../core/validate.ts';
import { type AbsPath, type RefName, type RepoPath, absPath, refName, repoPath } from '../core/values.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../core/version.ts';
import { START_FILE } from '../executor.ts';
import { WITNESS_RECORD_FILE } from '../holistic/witness.ts';
import {
  OBLIGATIONS_INPUT, PLAN_INPUT, RENDER_INPUT, REVISION_INPUT, RULING_INPUT, RULINGS_INPUT, type RoutingBase, SPEC_INPUT, VISION_INPUT, inputPath,
  routingProvenanceOf as rebuiltProvenance,
} from '../input/inforce.ts';
import { parsePlan } from '../input/plan.ts';
import { NEEDS_USER_DIR, needsUserAckPath } from '../needsuser.ts';
import { BRIEF_INPUT } from '../pipeline/rounds.ts';
import { provenanceStack, resolveRouting } from '../routing/layers.ts';
import { type RoutingProvenance, routingProvenance } from '../routing/types.ts';
import { manifestPath } from './evidence.ts';
import { MUTANT_PATCH_INPUT } from './mutant.ts';
import { type Identity, catFileType, commitTree, git, gitRun, lsTree, refTarget, updateRefCas, writeTreeFromIndex } from './git.ts';

export class SnapshotStateError extends Error {
  readonly ref: RefName;
  constructor(ref: RefName, detail: string) {
    super(`snapshot ${ref}: ${detail}`);
    this.name = 'SnapshotStateError';
    this.ref = ref;
  }
}

export const snapshotRef = (arc: ArcId): RefName => refName(`refs/roadmap/${arc}`);

export const SNAPSHOT_SCHEMA = 'roadmap/1.0';
export const SNAPSHOT_MANIFEST = 'manifest.json';
const STATE_FILE = 'state.json';
const INV_DIR = 'inv';

// ---------------------------------------------------------------------------------------------------
// The manifest

/** The record naming a snapshot item: the snapshot itself (the log, its fold), an event of the log, or another item. */
export type NamedBy =
  | Readonly<{ type: 'log' }>
  | Readonly<{ type: 'event'; seq: number }>
  | Readonly<{ type: 'item'; path: RepoPath }>;

/** `namedBy` null: an entry a 1.0.0-dev.5 executor wrote (no closure; `verifySnapshot` reads it by its allowlist). */
export type SnapshotFile = Readonly<{ path: RepoPath; sha256: Sha256Hex; size: number; namedBy: NamedBy | null }>;

export type SnapshotManifest = Readonly<{
  v: SchemaVersion;
  schema: typeof SNAPSHOT_SCHEMA;
  arc: ArcId;
  /** The seq of the last event the snapshot's `events.jsonl` holds. */
  highWater: number;
  /** Ascending by path; every entry has a `namedBy`, or (1.0.0-dev.5) none has. */
  files: readonly SnapshotFile[];
}>;

const namedBy: Read<NamedBy> = tagged('type', {
  log: object((f): NamedBy => ({ type: f.get('type', literal('log')) })),
  event: object((f): NamedBy => ({ type: f.get('type', literal('event')), seq: f.get('seq', positive) })),
  item: object((f): NamedBy => ({ type: f.get('type', literal('item')), path: f.get('path', (v, p) => repoPath(v, p)) })),
});

const snapshotFile: Read<SnapshotFile> = (value, path) => {
  const f = new Fields(value, path);
  const out = {
    path: f.get('path', (v, p) => repoPath(v, p)), sha256: f.get('sha256', (v, p) => sha256(v, p)), size: f.get('size', nat),
    namedBy: f.optional('namedBy', namedBy) ?? null,
  };
  f.end();
  return out;
};

export const snapshotManifest: Read<SnapshotManifest> = (value, path) => {
  const f = new Fields(value, path);
  const out = {
    v: f.get('v', version),
    schema: f.get('schema', literal(SNAPSHOT_SCHEMA)),
    arc: f.get('arc', (v, p) => arcId(v, p)),
    highWater: f.get('highWater', positive),
    files: f.get('files', sortedBy(snapshotFile, (e) => e.path, { nonEmpty: true })),
  };
  f.end();
  const named = out.files.filter((e) => e.namedBy !== null).length;
  if (named !== 0 && named !== out.files.length) throw new SchemaError(`${path}.files`, 'a namedBy on every entry or (1.0.0-dev.5) on none', `${named} of ${out.files.length}`);
  return out;
};

// ---------------------------------------------------------------------------------------------------
// The closure

/** Where an item's bytes come from at collection. */
type Source =
  | Readonly<{ type: 'log' }>
  | Readonly<{ type: 'fold' }>
  /** A 1.0.0-dev.5 revision's routing provenance, as its adoption persisted it (`adoptLegacyProvenance`, H7). */
  | Readonly<{ type: 'provenance'; rev: PlanRev }>
  | Readonly<{ type: 'input'; sha256: Sha256Hex; ext: string }>
  | Readonly<{ type: 'start' }>
  | Readonly<{ type: 'inv'; inv: InvocationId; file: 'result.json' | 'reads.json' }>
  /** A witness run keeps its record in its execution's dir (`witnessDir`): `<dir>/witness.json`. */
  | Readonly<{ type: 'witness'; fact: WitnessedFact }>
  | Readonly<{ type: 'file'; path: AbsPath }>
  | Readonly<{ type: 'ack'; id: NeedsUserId }>;

type Item = Readonly<{
  path: RepoPath;
  namedBy: NamedBy;
  /** The sha256 the naming record states; null when it names the file without one. */
  sha256: Sha256Hex | null;
  /** Only a backend call's reads.json: a Claude call writes one, a Codex call none. */
  optional: boolean;
  source: Source;
  /** start.json only: the generation the naming `executor-started` fact records. */
  generation?: number;
}>;

/** The closure of the records `events` name, in naming order, each path once (its first naming record). */
function closureOf(events: readonly Event[], payloadOf: (sha: Sha256Hex) => RevisionPayload): readonly Item[] {
  const items = new Map<string, Item>();
  const add = (item: Omit<Item, 'optional'> & { optional?: boolean }): void => {
    if (!items.has(item.path)) items.set(item.path, { optional: false, ...item });
  };
  const input = (sha: Sha256Hex, ext: string, by: NamedBy): void =>
    add({ path: repoPath(`inputs/${sha}.${ext}`), namedBy: by, sha256: sha, source: { type: 'input', sha256: sha, ext } });
  const payload = (sha: Sha256Hex, by: NamedBy): void => {
    const path = repoPath(`inputs/${sha}.${REVISION_INPUT}`);
    if (items.has(path)) return;
    input(sha, REVISION_INPUT, by);
    const p = payloadOf(sha);
    const m = p.manifest;
    const from: NamedBy = { type: 'item', path };
    input(m.planSha256, PLAN_INPUT, from);
    for (const s of Object.values(m.specs)) input(s, SPEC_INPUT, from);
    input(m.rulings.ledgerSha256, RULINGS_INPUT, from);
    for (const s of Object.values(m.rulings.sidecars)) input(s, RULING_INPUT, from);
    if (m.obligations !== null) input(m.obligations, OBLIGATIONS_INPUT, from);
    if (m.vision !== null) input(m.vision, VISION_INPUT, from);
    for (const r of p.publication?.renders ?? []) input(r.sha256, RENDER_INPUT, from);
  };

  add({ path: repoPath(EVENTS_FILE), namedBy: { type: 'log' }, sha256: null, source: { type: 'log' } });
  add({ path: repoPath(STATE_FILE), namedBy: { type: 'log' }, sha256: null, source: { type: 'fold' } });
  const intents = new Map<OpId, Readonly<{ seq: number; intent: IntentRecord }>>();
  let started: Readonly<{ seq: number; generation: number }> | null = null;
  for (const e of events) {
    const by: NamedBy = { type: 'event', seq: e.seq };
    if (e.type === 'intent') {
      intents.set(e.op, { seq: e.seq, intent: e });
      if (e.kind === 'revision.commit') payload(e.expect.payloadSha256, by);
      continue;
    }
    if (e.type === 'done') {
      const opened = intents.get(e.op);
      if (opened === undefined) throw new Error(`${EVENTS_FILE}: done ${e.op} at seq ${e.seq} without an intent`);
      const { intent } = opened;
      const byIntent: NamedBy = { type: 'event', seq: opened.seq };
      if (intent.kind === 'spec.patch') input(intent.post.newSha256, SPEC_INPUT, byIntent);
      if (intent.kind === 'needsuser.raise') {
        add({ path: repoPath(`${NEEDS_USER_DIR}/${intent.expect.id}.json`), namedBy: byIntent, sha256: intent.post.sha256, source: { type: 'file', path: intent.expect.path } });
      }
      if (e.kind === 'evidence.snapshot' && e.outcome.kind === 'captured' && intent.kind === 'evidence.snapshot') {
        add({ path: repoPath(`evidence-manifests/${parseOpId(e.op).seq}.json`), namedBy: by, sha256: e.outcome.manifestSha256, source: { type: 'file', path: manifestPath(intent.expect.dest) } });
      }
      if (e.kind === 'proc.spawn' && e.outcome.kind === 'result' && intent.kind === 'proc.spawn') {
        const purpose = intent.expect.subject.purpose;
        if (purpose === 'backend' || purpose === 'arc-backend') {
          const inv = invocationId(intent.op, intent.ordinal);
          const dir = `${INV_DIR}/${invocationDirName(inv)}`;
          add({ path: repoPath(`${dir}/reads.json`), namedBy: by, sha256: null, optional: true, source: { type: 'inv', inv, file: 'reads.json' } });
          add({ path: repoPath(`${dir}/result.json`), namedBy: by, sha256: e.outcome.resultSha256, source: { type: 'inv', inv, file: 'result.json' } });
        }
      }
      continue;
    }
    if (e.type !== 'fact') continue;
    const f = e.fact;
    switch (f.kind) {
      case 'plan-applied':
        if (f.payloadSha256 !== undefined) payload(f.payloadSha256, by);
        input(f.planSha256, PLAN_INPUT, by);
        for (const s of Object.values(f.specs)) input(s, SPEC_INPUT, by);
        if (f.rulingsSha256 !== undefined) input(f.rulingsSha256, RULINGS_INPUT, by);
        if (f.obligationsSha256 !== undefined) input(f.obligationsSha256, OBLIGATIONS_INPUT, by);
        if (f.visionSha256 !== undefined) input(f.visionSha256, VISION_INPUT, by);
        if (f.routingProvenance === undefined) add({ path: repoPath(`${PROVENANCE_DIR}/${f.rev}.json`), namedBy: by, sha256: null, source: { type: 'provenance', rev: f.rev } });
        break;
      case 'dispatch':
        input(f.record.specSha256, SPEC_INPUT, by);
        break;
      case 'judgment-inputs':
      case 'reopened':
        input(f.specSha256, SPEC_INPUT, by);
        break;
      case 'steered':
        input(f.brief, BRIEF_INPUT, by);
        break;
      case 'finding-opened':
        if (f.mutant !== null) input(f.mutant.patchSha256, MUTANT_PATCH_INPUT, by);
        break;
      case 'witnessed':
        // A job's, a candidate's and a mutant's lane run alike (a mutant's record never certifies, G13).
        add({ path: repoPath(`witness/${invocationDirName(f.inv)}.json`), namedBy: by, sha256: f.recordsSha256, source: { type: 'witness', fact: f } });
        break;
      case 'needs-user-acked':
        add({ path: repoPath(`${NEEDS_USER_DIR}/${f.id}.ack.json`), namedBy: by, sha256: null, source: { type: 'ack', id: f.id } });
        break;
      case 'executor-started':
        started = { seq: e.seq, generation: f.generation };
        break;
      default:
        break;
    }
  }
  if (started !== null) {
    add({ path: repoPath(START_FILE), namedBy: { type: 'event', seq: started.seq }, sha256: null, source: { type: 'start' }, generation: started.generation });
  }
  return [...items.values()];
}

// ---------------------------------------------------------------------------------------------------
// TEMPORARY SCAFFOLDING (SCHEMAS.md "Record evolution"; H7): a 1.0.0-dev.5 `plan-applied` records no routing
// provenance. The first start of this release on such an arc (adoption, src/preflight/checks.ts) reconstructs each
// one once, from the revision's kept plan, start.json's profile (the dev.5 start's) and the repo config read at that
// start, and checks it against every routing revision the log recorded under that revision (the backend spawns and
// dispatches it ran, its own `routing` change): all match → `reconstructed`; any differs → `unreconstructable`, with
// why, since the configuration in force then is gone. The record is written once and never rewritten: every later
// snapshot carries these bytes, never the live repo config. Delete once no arc started on 1.0.0-dev.5 is in flight.

const PROVENANCE_DIR = 'routing-provenance';

export type LegacyProvenance =
  | Readonly<{ kind: 'reconstructed'; provenance: RoutingProvenance; matched: readonly RoutingRev[] }>
  | Readonly<{ kind: 'unreconstructable'; reason: string }>;

const legacyProvenance: Read<LegacyProvenance> = tagged('kind', {
  reconstructed: object((f): LegacyProvenance => ({
    kind: f.get('kind', literal('reconstructed')), provenance: f.get('provenance', routingProvenance),
    matched: f.get('matched', arrayOf((v, p) => routingRev(v, p))),
  })),
  unreconstructable: object((f): LegacyProvenance => ({ kind: f.get('kind', literal('unreconstructable')), reason: f.get('reason', str) })),
});

export const legacyProvenancePath = (runDir: AbsPath, rev: PlanRev): AbsPath => absPath(join(runDir, PROVENANCE_DIR, `${rev}.json`));

/** The persisted record of a 1.0.0-dev.5 revision's routing provenance; a missing one (the arc was never adopted) is a bug. */
export function readLegacyProvenance(runDir: AbsPath, rev: PlanRev): LegacyProvenance {
  const path = legacyProvenancePath(runDir, rev);
  return legacyProvenance(JSON.parse(mustRead(path, `the routing provenance of 1.0.0-dev.5 plan rev ${rev}`).toString('utf8')), path);
}

/** The routing revisions the log recorded while each 1.0.0-dev.5 revision was in force (its own `routing` change included). */
function recordedRoutingRevs(events: readonly Event[]): ReadonlyMap<PlanRev, ReadonlySet<RoutingRev>> {
  const out = new Map<PlanRev, Set<RoutingRev>>();
  let current: Set<RoutingRev> | null = null;
  for (const e of events) {
    if (e.type === 'fact' && e.fact.kind === 'plan-applied') {
      current = e.fact.routingProvenance === undefined ? new Set() : null;
      if (current !== null) out.set(e.fact.rev, current);
      for (const c of e.fact.changes) if (c.type === 'routing') current?.add(c.routingRev);
      continue;
    }
    if (current === null) continue;
    if (e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'backend') current.add(e.expect.subject.routingRev);
    if (e.type === 'fact' && e.fact.kind === 'dispatch') current.add(e.fact.record.routingRev);
  }
  return out;
}

/**
 * Adoption (H7): persists the routing provenance of every 1.0.0-dev.5 revision `events` names that has none persisted
 * yet, reconstructed under start.json's profile and `config` (the repo config the adopting start read). Returns why
 * each revision it found unreconstructable is.
 */
export function adoptLegacyProvenance(runDir: AbsPath, events: readonly Event[], config: RoutingBase['config']): readonly string[] {
  const recorded = recordedRoutingRevs(events);
  const pending = [...recorded].filter(([rev]) => !existsSync(legacyProvenancePath(runDir, rev)));
  if (pending.length === 0) return [];
  const startPath = join(runDir, START_FILE);
  const profile = runStart(JSON.parse(mustRead(startPath, 'start.json (a 1.0.0-dev.5 revision\'s routing is reconstructed under its profile)').toString('utf8')), startPath).profile;
  const facts = new Map(events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [[e.fact.rev, e.fact] as const] : [])));
  const out: string[] = [];
  for (const [rev, revs] of pending) {
    const fact = facts.get(rev)!;
    const plan = parsePlan(JSON.parse(mustRead(inputPath(runDir, fact.planSha256, PLAN_INPUT), `plan rev ${rev}`).toString('utf8')));
    const provenance = rebuiltProvenance({ profile, config }, plan);
    const holistic = plan.holistic !== undefined;
    const rebuilt = new Set([null, ...plan.units.map((u) => u.id)].map((u) => resolveRouting(provenanceStack(provenance, holistic, u)).rev));
    const foreign = [...revs].filter((r) => !rebuilt.has(r)).sort();
    const record: LegacyProvenance = foreign.length === 0
      ? { kind: 'reconstructed', provenance, matched: [...revs].sort() }
      : {
        kind: 'unreconstructable',
        reason: `plan rev ${rev} ran under routing revs ${foreign.join(', ')}, which profile ${profile} and the repo config at adoption resolve to none of `
          + `(${[...rebuilt].sort().join(', ')}): the configuration in force then is not recorded`,
      };
    if (record.kind === 'unreconstructable') out.push(record.reason);
    const path = legacyProvenancePath(runDir, rev);
    mkdirSync(dirname(path), { recursive: true });
    exclusivePublish(path, fileJson(record));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Collecting the input

export type SnapshotPublishRequest = Readonly<{
  arc: ArcId;
  runDir: AbsPath;
  /** The journal's high-water seq when the snapshot was decided (`JournalView.highWater()`). */
  highWater: number;
  identity: Identity;
  message: string;
}>;

/**
 * The one way to ask for a snapshot: of the arc `view` folds, at its high-water mark (everything durable so far),
 * with `message` as the commit message. Nothing unit-specific: a unit's publication and a docs publication use it.
 */
export function snapshotRequestOf(input: Readonly<{ view: JournalView; runDir: AbsPath; identity: Identity; message: string }>): SnapshotPublishRequest {
  return { arc: input.view.arc, runDir: input.runDir, highWater: input.view.highWater(), identity: input.identity, message: input.message };
}

type Collected = ReadonlyMap<RepoPath, Readonly<{ bytes: Buffer; namedBy: NamedBy }>>;

/** The first `highWater` complete lines of the event log, byte for byte, and their parsed events. */
export function eventsPrefix(runDir: AbsPath, highWater: number): { bytes: Buffer; events: readonly Event[] } {
  const all = readFileSync(join(runDir, EVENTS_FILE));
  let end = 0;
  const events: Event[] = [];
  for (let n = 0; n < highWater; n++) {
    const nl = all.indexOf(0x0a, end);
    if (nl === -1) throw new Error(`${runDir}/${EVENTS_FILE} has ${n} complete lines, fewer than the high-water mark ${highWater}`);
    events.push(parseEventLine(all.subarray(end, nl).toString('utf8')));
    end = nl + 1;
  }
  const last = events[events.length - 1];
  if (last?.seq !== highWater) throw new Error(`${runDir}/${EVENTS_FILE}: line ${highWater} has seq ${last?.seq}`);
  return { bytes: all.subarray(0, end), events };
}

const mustRead = (path: string, what: string): Buffer => {
  if (!existsSync(path)) throw new Error(`snapshot: ${what} ${path} does not exist`);
  return readFileSync(path);
};

/** Where a job keeps its lanes' evidence (src/pipeline/publish.ts): `<runDir>/evidence/jobs/<job>`. */
export const jobEvidenceRoot = (runDir: AbsPath, job: JobId): AbsPath => absPath(join(runDir, 'evidence', 'jobs', job));

/** A job lane's kind: a suite lane, or an arc lane (whose run is a witness). Lane ids are unique only within each. */
export type JobLaneKind = 'suite' | 'arc';

/**
 * One lane execution's evidence dir, `<job root>/<kind>-<lane>-<seq>-<ordinal>` (`invDir`: its invocation's dir name,
 * `invocationDirName`): immutable, since no other execution (the other kind's lane of the same id, another invocation
 * or attempt) shares its invocation.
 */
export const jobLaneDir = (runDir: AbsPath, job: JobId, kind: JobLaneKind, lane: LaneId, invDir: string): AbsPath =>
  absPath(join(jobEvidenceRoot(runDir, job), `${kind}-${lane}-${invDir}`));

/**
 * A unit candidate's journey lane execution's evidence dir (M3 B2), under its candidate stage attempt's evidence root
 * (`evidence/<unit>/<attempt>-candidate`, src/pipeline/dispatch.ts `evidenceRoot`): `journey/<kind>-<lane>-<seq>-<ordinal>`.
 * Its runs on the candidate and on the tip alone share the dir's parent; their invocations keep them apart.
 */
export const candidateLaneDir = (runDir: AbsPath, unit: UnitId, attempt: number, kind: JobLaneKind, lane: LaneId, invDir: string): AbsPath =>
  absPath(join(runDir, 'evidence', unit, `${attempt}-candidate`, 'journey', `${kind}-${lane}-${invDir}`));

/**
 * A mutant lane execution's evidence dir (M3 B3): `<runDir>/evidence/mutants/<finding>/<lane>-<seq>-<ordinal>`, whether
 * a vacuity repair's `reproduce` stage or its candidate's kill check ran it (src/pipeline/reproduce.ts).
 */
export const mutantLaneDir = (runDir: AbsPath, finding: FindingId, lane: LaneId, invDir: string): AbsPath =>
  absPath(join(runDir, 'evidence', 'mutants', finding, `${lane}-${invDir}`));

type WitnessedFact = Readonly<{ lane: LaneId; inv: InvocationId; for: WitnessFor }>;

/** Where a `witnessed` fact's run keeps its `witness.json`: its execution's dir. */
export function witnessDir(runDir: AbsPath, f: WitnessedFact): AbsPath {
  const inv = invocationDirName(f.inv);
  switch (f.for.type) {
    case 'job':
      return jobLaneDir(runDir, f.for.job, 'arc', f.lane, inv);
    case 'candidate':
      return candidateLaneDir(runDir, f.for.unit, f.for.attempt, 'arc', f.lane, inv);
    case 'mutant':
      return mutantLaneDir(runDir, f.for.finding, f.lane, inv);
  }
}

/** Collects the closure at `request.highWater` from the run dir: every named file must exist and hash as its record says. */
export function collectSnapshot(request: SnapshotPublishRequest): Collected {
  const { arc, runDir, highWater } = request;
  const { bytes: log, events } = eventsPrefix(runDir, highWater);
  const payloadOf = (s: Sha256Hex): RevisionPayload => parseRevisionPayload(JSON.parse(mustRead(inputPath(runDir, s, REVISION_INPUT), 'revision payload').toString('utf8')));
  const startPath = join(runDir, START_FILE);
  const bytesOf = (source: Source): Buffer | null => {
    switch (source.type) {
      case 'log':
        return log;
      case 'fold':
        return Buffer.from(fileJson(fold(arc, events)), 'utf8');
      case 'provenance':
        return mustRead(legacyProvenancePath(runDir, source.rev), `the routing provenance of 1.0.0-dev.5 plan rev ${source.rev} (a start on this release reconstructs it at adoption)`);
      case 'input':
        return mustRead(inputPath(runDir, source.sha256, source.ext), 'kept input');
      case 'start':
        return mustRead(startPath, 'start.json');
      case 'inv': {
        const path = join(runDir, INV_DIR, invocationDirName(source.inv), source.file);
        return source.file === 'reads.json' && !existsSync(path) ? null : mustRead(path, `${source.inv}'s`);
      }
      case 'witness':
        return mustRead(join(witnessDir(runDir, source.fact), WITNESS_RECORD_FILE), `${source.fact.lane} witness record (${source.fact.inv})`);
      case 'file':
        return mustRead(source.path, 'named record');
      case 'ack':
        return mustRead(needsUserAckPath(runDir, source.id), 'needs-user acknowledgement');
    }
  };
  const files = new Map<RepoPath, Readonly<{ bytes: Buffer; namedBy: NamedBy }>>();
  for (const item of closureOf(events, payloadOf)) {
    const bytes = bytesOf(item.source);
    if (bytes === null) continue;
    const problem = namingProblem(item, bytes);
    if (problem !== null) throw new Error(`snapshot: ${problem}`);
    files.set(item.path, { bytes, namedBy: item.namedBy });
  }
  return files;
}

const namer = (by: NamedBy): string => (by.type === 'log' ? 'the log' : by.type === 'event' ? `event ${by.seq}` : by.path);

/** null when `bytes` are what the item's naming record states (its hash; start.json's generation). */
function namingProblem(item: Item, bytes: Buffer): string | null {
  if (item.sha256 !== null && sha256Hex(bytes) !== item.sha256) return `${item.path} hashes to ${sha256Hex(bytes)}, ${namer(item.namedBy)} names ${item.sha256}`;
  if (item.generation !== undefined) {
    const generation = runStart(JSON.parse(bytes.toString('utf8')), item.path).generation;
    if (generation !== item.generation) return `${item.path} is generation ${generation}, ${namer(item.namedBy)} started generation ${item.generation}`;
  }
  if (item.source.type === 'provenance') legacyProvenance(JSON.parse(bytes.toString('utf8')), item.path);
  return null;
}

const byPath = <T extends { readonly path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function manifestOf(arc: ArcId, highWater: number, files: Collected): SnapshotManifest {
  const entries = [...files].map(([path, { bytes, namedBy: by }]) => ({ path, sha256: sha256(sha256Hex(bytes)), size: bytes.length, namedBy: by })).sort(byPath);
  return { v: SCHEMA_VERSION, schema: SNAPSHOT_SCHEMA, arc, highWater, files: entries };
}

/** Writes each file as a blob and the whole set as a tree, through a temporary index. */
function writeSnapshotTree(repo: AbsPath, files: ReadonlyMap<RepoPath, Buffer>): Sha {
  const tmp = mkdtempSync(join(tmpdir(), 'roadmap-snapshot-'));
  try {
    const indexFile = absPath(join(tmp, 'index'));
    const info = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, bytes]) => {
      const blob = sha(git(repo, ['hash-object', '-w', '--stdin'], { input: bytes }).trim());
      return `100644 ${blob}\t${path}\0`;
    });
    git(repo, ['update-index', '--add', '-z', '--index-info'], { indexFile, input: info.join('') });
    return writeTreeFromIndex(repo, indexFile);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------
// Verification

export type SnapshotVerification =
  | Readonly<{ kind: 'verified'; manifest: SnapshotManifest; manifestSha256: Sha256Hex }>
  | Readonly<{ kind: 'mismatch'; detail: string }>;

class Mismatch extends Error {}

/**
 * Re-reads a snapshot commit: its tree holds `manifest.json` and exactly the files it lists, each hashing as
 * listed; `events.jsonl` ends at the manifest's high-water mark; and the listed files are exactly the closure the
 * tree's own events and payloads name (reads.json where a call wrote one), each with its naming record, hashing as
 * that record states.
 */
export function verifySnapshot(repo: AbsPath, commit: Sha): SnapshotVerification {
  const mismatch = (detail: string): SnapshotVerification => ({ kind: 'mismatch', detail });
  const entries = lsTree(repo, commit);
  const manifestEntry = entries.find((e) => e.path === SNAPSHOT_MANIFEST);
  if (manifestEntry === undefined) return mismatch('no manifest.json');
  const manifestText = blobText(repo, manifestEntry.object);
  const manifest = snapshotManifest(JSON.parse(manifestText), `${commit}:${SNAPSHOT_MANIFEST}`);
  const legacy = manifest.files[0]!.namedBy === null;
  const listed = new Map(manifest.files.map((f) => [f.path as string, f]));
  const blobs = new Map<string, Buffer>();
  for (const e of entries) {
    if (e.path === SNAPSHOT_MANIFEST) continue;
    if (legacy && !legacyAllowlisted(e.path)) return mismatch(`${e.path} is not an allowlisted snapshot path`);
    const want = listed.get(e.path);
    if (want === undefined) return mismatch(`${e.path} is not in the manifest`);
    const bytes = Buffer.from(blobText(repo, e.object), 'utf8');
    if (sha256Hex(bytes) !== want.sha256 || bytes.length !== want.size) return mismatch(`${e.path} hashes to ${sha256Hex(bytes)} (${bytes.length} bytes), manifest says ${want.sha256} (${want.size})`);
    blobs.set(e.path, bytes);
  }
  const absent = [...listed.keys()].filter((p) => !blobs.has(p));
  if (absent.length > 0) return mismatch(`manifest lists missing files ${absent.join(', ')}`);
  const log = blobs.get(EVENTS_FILE);
  if (log === undefined) return mismatch('no events.jsonl');
  const lines = log.toString('utf8').split('\n');
  if (lines.pop() !== '' || lines.length !== manifest.highWater) return mismatch(`events.jsonl holds ${lines.length} lines, high-water mark ${manifest.highWater}`);
  const events = lines.map(parseEventLine);
  if (events[events.length - 1]!.seq !== manifest.highWater) return mismatch(`events.jsonl ends at another seq than ${manifest.highWater}`);
  const verified: SnapshotVerification = { kind: 'verified', manifest, manifestSha256: sha256(sha256Hex(manifestText)) };
  if (legacy) {
    warnLegacy(commit);
    return verified;
  }

  let closure: readonly Item[];
  try {
    closure = closureOf(events, (s) => {
      const path = `inputs/${s}.${REVISION_INPUT}`;
      const bytes = blobs.get(path);
      if (bytes === undefined) throw new Mismatch(`the closure names ${path}, which the tree does not hold`);
      return parseRevisionPayload(JSON.parse(bytes.toString('utf8')));
    });
  } catch (e) {
    if (e instanceof Mismatch) return mismatch(e.message);
    throw e;
  }
  const inClosure = new Set<string>();
  for (const item of closure) {
    inClosure.add(item.path);
    const entry = listed.get(item.path);
    if (entry === undefined) {
      if (item.optional) continue;
      return mismatch(`${item.path}, which ${namer(item.namedBy)} names, is not in the snapshot`);
    }
    if (canonicalJson(entry.namedBy) !== canonicalJson(item.namedBy)) return mismatch(`${item.path} is listed as named by ${namer(entry.namedBy!)}, the closure has ${namer(item.namedBy)}`);
    const problem = namingProblem(item, blobs.get(item.path)!);
    if (problem !== null) return mismatch(problem);
  }
  const extra = [...listed.keys()].filter((p) => !inClosure.has(p));
  if (extra.length > 0) return mismatch(`${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not in the snapshot closure`);
  return verified;
}

/** A blob's content. Every snapshot file is UTF-8 text (JSON, the ledger, a brief, a render), so text round-trips its bytes. */
const blobText = (repo: AbsPath, blob: Sha): string => gitRun(repo, ['cat-file', 'blob', blob]).stdout;

// TEMPORARY SCAFFOLDING (SCHEMAS.md "Record evolution"): a snapshot a 1.0.0-dev.5 executor published (no
// `namedBy`) verifies by that release's allowlist and hashes, so recovery closes its open `snapshot.publish`. Delete
// once no arc started on 1.0.0-dev.5 is in flight.
const LEGACY_ALLOWLIST: readonly RegExp[] = [
  /^events\.jsonl$/, /^state\.json$/, /^specs\/[a-z0-9-]+\.json$/, /^needs-user\/[a-z0-9-]+(\.ack)?\.json$/, /^evidence-manifests\/[1-9][0-9]*\.json$/,
];
const legacyAllowlisted = (path: string): boolean => LEGACY_ALLOWLIST.some((re) => re.test(path));
let warnedLegacy = false;
function warnLegacy(commit: Sha): void {
  if (warnedLegacy) return;
  warnedLegacy = true;
  process.stderr.write(`roadmap: upgrade default (snapshot.namedBy): snapshot ${commit} has no closure (written by 1.0.0-dev.5); verified by its allowlist\n`);
}

// ---------------------------------------------------------------------------------------------------
// The op

function prepare(repo: AbsPath, request: SnapshotPublishRequest): IntentBody<'snapshot.publish'> {
  const ref = snapshotRef(request.arc);
  const collected = collectSnapshot(request);
  const files = new Map([...collected].map(([path, { bytes }]) => [path, bytes] as const));
  const manifestBytes = Buffer.from(canonicalJson(manifestOf(request.arc, request.highWater, collected)), 'utf8');
  files.set(repoPath(SNAPSHOT_MANIFEST), manifestBytes);
  const old = refTarget(repo, ref);
  const commit: CommitInputs<readonly [] | readonly [Sha]> = {
    tree: writeSnapshotTree(repo, files),
    parents: old === null ? [] : [old],
    author: request.identity.author,
    committer: request.identity.committer,
    message: request.message,
    gpgsign: false,
  };
  return {
    expect: { ref, old, highWater: request.highWater, manifestSha256: sha256(sha256Hex(manifestBytes)), commit },
    post: { new: commitTree(repo, commit) },
  };
}

function act(repo: AbsPath, intent: IntentOf<'snapshot.publish'>): void {
  const { ref, old, commit } = intent.expect;
  const next = intent.post.new;
  crashPoint('snapshot.act-start', parentUnit(intent.parent));
  const at = refTarget(repo, ref);
  if (at !== old) throw new SnapshotStateError(ref, `at ${at ?? 'nothing'}, recorded old ${old ?? 'absent'}`);
  if (catFileType(repo, commit.tree) !== 'tree') throw new SnapshotStateError(ref, `recorded tree ${commit.tree} is missing`);
  const made = commitTree(repo, commit);
  if (made !== next) throw new SnapshotStateError(ref, `commit ${made}, recorded ${next}`);
  crashPoint('snapshot.after-commit-tree', parentUnit(intent.parent));
  updateRefCas(repo, ref, next, old ?? 'absent');
  crashPoint('snapshot.act-end', parentUnit(intent.parent));
}

/** null when the postcondition holds: ref = new, and its tree verifies (manifest, closure) at the recorded mark. */
export function snapshotPostcondition(repo: AbsPath, intent: IntentOf<'snapshot.publish'>): string | null {
  const { ref, highWater, manifestSha256 } = intent.expect;
  const next = intent.post.new;
  const at = refTarget(repo, ref);
  if (at !== next) return `${ref} at ${at ?? 'nothing'}, expected ${next}`;
  const check = verifySnapshot(repo, next);
  if (check.kind === 'mismatch') return check.detail;
  if (check.manifestSha256 !== manifestSha256) return `manifest hashes to ${check.manifestSha256}, recorded ${manifestSha256}`;
  if (check.manifest.highWater !== highWater) return `high-water mark ${check.manifest.highWater}, recorded ${highWater}`;
  return null;
}

function verify(repo: AbsPath, intent: IntentOf<'snapshot.publish'>): OpOutcome['snapshot.publish'] {
  const problem = snapshotPostcondition(repo, intent);
  if (problem !== null) throw new SnapshotStateError(intent.expect.ref, problem);
  return { kind: 'published' };
}

export function snapshotPublishSteps(repo: AbsPath): GitSteps<'snapshot.publish', SnapshotPublishRequest> {
  return {
    kind: 'snapshot.publish',
    prepare: async (request) => prepare(repo, request),
    act: async (intent) => act(repo, intent),
    verify: async (intent) => verify(repo, intent),
  };
}
