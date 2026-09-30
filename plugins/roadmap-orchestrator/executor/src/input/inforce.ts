// The plan in force (owner ruling 2026-09-29; SCHEMAS.md "Plan in force"): not the files, but a fold of the
// event log. The latest `plan-applied` fact names a revision, the hash of plan.json's bytes and of every unit's
// spec.json; the bytes themselves are kept content-addressed in the run dir (`inputs/<sha256>.plan.json`,
// `inputs/<sha256>.spec.json`). `roadmap apply` and a `start` whose files differ are the only ways a new
// revision comes into force; an edited file that was never applied is ignored, also by a respawn.
//
// A unit's spec in force is the one its record names once it is dispatched (`UnitState.spec`: its first
// dispatch, the executor's own `spec.patch`es, a reopen, an evidence-only apply), and the manifest's before.
// Stages load exactly those bytes, never the live file.
//
// An arc started before plan revisions existed has no `plan-applied` fact until its first start on this
// release records the baseline; until then `status` reads the files, with the upgrade warning, and `apply`
// (also a dry run) is rejected (src/core/upgrade.ts).
//
// M3 (G1, A2, A3, A14; step A2): the revisioned set is the plan, the specs, the rulings ledger with its sidecars
// (`<ledger>.d/C-<n>.json` beside the ledger file), the obligations and the vision (`plan.holistic`). A revision's
// manifest hashes them all (`RevisionManifest`) and keeps their bytes (`inputs/<sha>.rulings.md`, `.ruling.json`,
// `.obligations.json`, `.vision.json`). Its evaluated payload is kept as `inputs/<sha>.revision.json` and named by a
// `revision.commit` intent (`beginRevision`) before any docs `ff`; `plan-applied` is appended from it exactly, then
// its divergences (`appendRevision`). The inputs in force beyond plan and specs are the latest `plan-applied`'s
// payload manifest's (`revisionInForce`); a revision a dev.5 executor wrote has no payload: its ledger is the live
// file (`rulingsFromLiveFile`, scaffolding), with no sidecars, obligations or vision.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import {
  type IntentOf, type Parent, type PlanAppliedFact, type PlanChange, REVISION_FENCE_KEY, type RevisionPayload, parseRevisionPayload,
} from '../core/events.ts';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import { type OpId, type PlanRev, type RulingId, type Sha256Hex, type UnitId, opKey, planRev, rulingId } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { PlanManifest, RevisionManifest, SpecM1 } from '../core/records.ts';
import { rulingsFromLiveFile, specBytesFromLiveFile } from '../core/upgrade.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { type Obligations, type RulingSidecar, type Vision, parseObligations, parseRulingSidecar, parseVision } from '../holistic/types.ts';
import { type RepoConfig, type ResolvedRouting, planStack, resolveRouting } from '../routing/layers.ts';
import type { ProfileName, RoutingLayer, RoutingProvenance } from '../routing/types.ts';
import { bytesSha256, parseSpec } from '../spec/spec.ts';
import { type PlanM1, type PlanUnit, parsePlan } from './plan.ts';

export const PLAN_INPUT = 'plan.json';
export const SPEC_INPUT = 'spec.json';
export const RULINGS_INPUT = 'rulings.md';
export const RULING_INPUT = 'ruling.json';
export const OBLIGATIONS_INPUT = 'obligations.json';
export const VISION_INPUT = 'vision.json';
export const REVISION_INPUT = 'revision.json';
/** An executor-rendered `.roadmap/` document a revision's docs publication commits (`RevisionPayload.publication.renders`). */
export const RENDER_INPUT = 'render';

/** Where the run dir keeps the input whose bytes hash to `sha256`. */
export const inputPath = (runDir: AbsPath, sha: string, ext: string): AbsPath => absPath(join(runDir, 'inputs', `${sha}.${ext}`));

/** Keeps `bytes` once under `inputs/<sha256>.<ext>` and returns the hash; the name certifies the content. */
export function keepInput(runDir: AbsPath, bytes: Buffer, ext: string): Sha256Hex {
  const sha = bytesSha256(bytes);
  const path = inputPath(runDir, sha, ext);
  if (!existsSync(path) || bytesSha256(readFileSync(path)) !== sha) {
    durableMkdir(dirname(path));
    durableWrite(path, bytes);
  }
  return sha;
}

/** The kept bytes hashing to `sha`, or null when none were kept. */
export function keptInput(runDir: AbsPath, sha: Sha256Hex, ext: string): Buffer | null {
  const path = inputPath(runDir, sha, ext);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytesSha256(bytes) !== sha) throw new Error(`${path} does not hash to its name`);
  return bytes;
}

// ---------------------------------------------------------------------------------------------------
// The files as they are now

/** A revisioned input file: its path and bytes, null when the file does not exist. */
export type InputFile = Readonly<{ path: AbsPath; bytes: Buffer | null }>;

/**
 * plan.json, the spec.json of each of its units, and (M3) the rulings ledger with its sidecars, the obligations and
 * the vision: what an apply or a start would put in force. A revision built in memory (a rule, a bundle, a reverse)
 * has the same shape, its paths naming where the files are.
 */
export type InputFiles = Readonly<{
  /** The plan file read: its directory is where unit spec paths and the rulings ledger resolve. */
  planFile: AbsPath;
  plan: PlanM1;
  planBytes: Buffer;
  /** Per unit of `plan`: the spec file's path and bytes, or null when the file does not exist. */
  specs: ReadonlyMap<UnitId, InputFile>;
  /** M3: the ledger `plan.rulings` names. */
  ledger: InputFile;
  /** M3: the ruling sidecars beside it (`<ledger>.d/C-<n>.json`), ascending by id. */
  sidecars: ReadonlyMap<RulingId, Readonly<{ path: AbsPath; bytes: Buffer }>>;
  /** M3 (A5): the obligations and vision files `plan.holistic` names; null when it names none. */
  obligations: InputFile | null;
  vision: InputFile | null;
}>;

export const specFilePath = (planFile: AbsPath, unit: PlanUnit): AbsPath => absPath(join(dirname(planFile), unit.spec));
export const ledgerPath = (planFile: AbsPath, plan: PlanM1): AbsPath => absPath(join(dirname(planFile), plan.rulings));
/** Where the ruling sidecars of a ledger live: `<ledger>.d/`, one `C-<n>.json` each. */
export const sidecarDir = (ledger: AbsPath): AbsPath => absPath(`${ledger}.d`);
export const sidecarPath = (ledger: AbsPath, id: RulingId): AbsPath => absPath(join(sidecarDir(ledger), `${id}.json`));
const SIDECAR_NAME = /^(C-[0-9]+)\.json$/;

const inputFile = (path: AbsPath): InputFile => ({ path, bytes: existsSync(path) ? readFileSync(path) : null });
const rulingNumber = (id: RulingId): number => Number(id.slice(2));

/** The sidecar files of `ledger` by id, ascending; a file there not named `C-<n>.json` is refused (SchemaError). */
function readSidecars(ledger: AbsPath): ReadonlyMap<RulingId, Readonly<{ path: AbsPath; bytes: Buffer }>> {
  const dir = sidecarDir(ledger);
  if (!existsSync(dir)) return new Map();
  const entries = readdirSync(dir).map((name) => {
    const m = SIDECAR_NAME.exec(name);
    if (m === null) throw new SchemaError(join(dir, name), 'a ruling sidecar named C-<n>.json', name);
    const path = sidecarPath(ledger, rulingId(m[1], join(dir, name)));
    return [rulingId(m[1]), { path, bytes: readFileSync(path) }] as const;
  });
  return new Map(entries.sort(([a], [b]) => rulingNumber(a) - rulingNumber(b)));
}

/** Reads the plan (parsed: throws SchemaError or SyntaxError) and the bytes of every input it names. */
export function readInputFiles(planFile: AbsPath): InputFiles {
  const planBytes = readFileSync(planFile);
  const plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  const specs = new Map(plan.units.map((u) => [u.id, inputFile(specFilePath(planFile, u))] as const));
  const ledger = ledgerPath(planFile, plan);
  const beside = (path: string): InputFile => inputFile(absPath(join(dirname(planFile), path)));
  return {
    planFile, plan, planBytes, specs, ledger: inputFile(ledger), sidecars: readSidecars(ledger),
    obligations: plan.holistic?.obligations === undefined ? null : beside(plan.holistic.obligations),
    vision: plan.holistic === undefined ? null : beside(plan.holistic.vision),
  };
}

/** The plan part of an apply's manifest (a dev.5 command's is all of it). */
export const planManifestOf = (m: PlanManifest): PlanManifest => ({ planSha256: m.planSha256, specs: m.specs });

/** The manifest of the files, or why it cannot be made: each missing file, one reason each. */
export function revisionManifestOf(files: InputFiles): RevisionManifest | Readonly<{ missing: readonly string[] }> {
  const specs: Record<UnitId, Sha256Hex> = {};
  const missing: string[] = [];
  for (const [unit, s] of files.specs) {
    if (s.bytes === null) missing.push(`unit ${unit}: its spec ${s.path} does not exist`);
    else specs[unit] = bytesSha256(s.bytes);
  }
  const ledger = files.ledger.bytes;
  if (ledger === null) missing.push(`the rulings ledger ${files.ledger.path} does not exist`);
  const optional = (what: string, f: InputFile | null): Sha256Hex | null => {
    if (f === null) return null;
    if (f.bytes === null) {
      missing.push(`the ${what} file ${f.path} does not exist`);
      return null;
    }
    return bytesSha256(f.bytes);
  };
  const obligations = optional('obligations', files.obligations);
  const vision = optional('vision', files.vision);
  if (missing.length > 0 || ledger === null) return { missing };
  return {
    planSha256: bytesSha256(files.planBytes), specs,
    rulings: { ledgerSha256: bytesSha256(ledger), sidecars: Object.fromEntries([...files.sidecars].map(([id, x]) => [id, bytesSha256(x.bytes)])) },
    obligations, vision,
  };
}

/** Keeps the plan's and every spec's bytes (all must exist) and returns their manifest. */
export function keepInputFiles(runDir: AbsPath, files: InputFiles): PlanManifest {
  const specs: Record<UnitId, Sha256Hex> = {};
  for (const [unit, s] of files.specs) {
    if (s.bytes === null) throw new Error(`keepInputFiles: the spec of ${unit} (${s.path}) does not exist`);
    specs[unit] = keepInput(runDir, s.bytes, SPEC_INPUT);
  }
  return { planSha256: keepInput(runDir, files.planBytes, PLAN_INPUT), specs };
}

/** Keeps every input's bytes (all must exist) and returns the revision manifest. */
export function keepRevisionFiles(runDir: AbsPath, files: InputFiles): RevisionManifest {
  const bytes = (f: InputFile): Buffer => {
    if (f.bytes === null) throw new Error(`keepRevisionFiles: ${f.path} does not exist`);
    return f.bytes;
  };
  return {
    ...keepInputFiles(runDir, files),
    rulings: {
      ledgerSha256: keepInput(runDir, bytes(files.ledger), RULINGS_INPUT),
      sidecars: Object.fromEntries([...files.sidecars].map(([id, x]) => [id, keepInput(runDir, x.bytes, RULING_INPUT)])),
    },
    obligations: files.obligations === null ? null : keepInput(runDir, bytes(files.obligations), OBLIGATIONS_INPUT),
    vision: files.vision === null ? null : keepInput(runDir, bytes(files.vision), VISION_INPUT),
  };
}

// ---------------------------------------------------------------------------------------------------
// Routing provenance (H7)

/** What a plan's routing resolves under besides the plan: the arc's profile and the repo config read at its start. */
export type RoutingBase = Readonly<{ profile: ProfileName; config: RepoConfig | null }>;

/** The arc routing of `plan` (no unit layer). */
export const planRouting = (base: RoutingBase, plan: PlanM1): ResolvedRouting => resolveRouting(planStack(base.profile, base.config, plan));
/** A unit's routing: the arc's stack with the unit's own layer on top (`route`, `steer --class`). */
export const unitRouting = (base: RoutingBase, plan: PlanM1, unit: PlanUnit): ResolvedRouting =>
  resolveRouting({ ...planStack(base.profile, base.config, plan), unit: unit.routing ?? null });

/** Everything `plan`'s routing revisions resolve from, as its `plan-applied` records it (H7). */
export function routingProvenanceOf(base: RoutingBase, plan: PlanM1): RoutingProvenance {
  const unitLayers: Record<UnitId, RoutingLayer> = {};
  for (const u of [...plan.units].sort((a, b) => (a.id < b.id ? -1 : 1))) if (u.routing !== undefined) unitLayers[u.id] = u.routing;
  return {
    profile: base.profile,
    repoConfig: { seats: base.config?.routing?.seats ?? null, classes: base.config?.routing?.classes ?? null },
    planLayer: plan.routing ?? null,
    unitLayers,
  };
}

// ---------------------------------------------------------------------------------------------------
// Revisions: the payload, its activation record, and `plan-applied` appended from it (G1)

/** Keeps a revision's payload as `inputs/<sha>.revision.json` (canonical JSON, validated) and returns its hash. */
export function keepPayload(runDir: AbsPath, payload: RevisionPayload): Sha256Hex {
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  parseRevisionPayload(JSON.parse(bytes.toString('utf8')));
  return keepInput(runDir, bytes, REVISION_INPUT);
}

/** The kept payload hashing to `sha`; a missing one is a bug (it is kept before anything names it). */
export function keptPayload(runDir: AbsPath, sha: Sha256Hex): RevisionPayload {
  const bytes = keptInput(runDir, sha, REVISION_INPUT);
  if (bytes === null) throw new Error(`revision payload ${sha} is named in the log but ${inputPath(runDir, sha, REVISION_INPUT)} does not exist`);
  return parseRevisionPayload(JSON.parse(bytes.toString('utf8')));
}

/** The open `revision.commit` (A19: at most one, its key), or null: the revision fence's durable half. */
export function openRevision(view: JournalView): IntentOf<'revision.commit'> | null {
  return (view.openIntents().find((i) => i.kind === 'revision.commit') as IntentOf<'revision.commit'> | undefined) ?? null;
}

/** The docs publication that carried a revision: its pub and the integration head its `ff` published. */
export type Publication = NonNullable<PlanAppliedFact['publication']>;

/**
 * The `plan-applied` fact of a payload: every M3 field from it (`obligationsSha256` and `visionSha256` exactly
 * when the manifest names them, A5), `publication` from the docs publication that carried it, and the DAG
 * scheduling of an arc's revision 1 in a log with no dispatch (M2).
 */
export function planAppliedOf(view: JournalView, payload: RevisionPayload, payloadSha256: Sha256Hex, publication: Publication | null): PlanAppliedFact {
  const m = payload.manifest;
  const dag = payload.rev === 1 && !view.unitsWithState().some((u) => view.dispatchOf(u) !== null);
  return {
    kind: 'plan-applied', rev: payload.rev, command: payload.source.type === 'command' ? payload.source.command : null,
    planSha256: m.planSha256, specs: m.specs, changes: payload.changes, ...(dag ? { scheduling: 'dag' as const } : {}),
    source: payload.source, payloadSha256, rulingsSha256: m.rulings.ledgerSha256,
    ...(m.obligations === null ? {} : { obligationsSha256: m.obligations }), ...(m.vision === null ? {} : { visionSha256: m.vision }),
    ...(publication === null ? {} : { publication }), routingProvenance: payload.routingProvenance,
  };
}

/**
 * Appends what the revision `commit` names, only what is missing (recovery runs it again): `plan-applied` from the
 * payload exactly, then its divergences in order, each once per `(job, index)`. The caller writes the done.
 */
export function appendRevision(journal: Journal, commit: IntentOf<'revision.commit'>, payload: RevisionPayload, publication: Publication | null): PlanAppliedFact {
  const inForce = journal.view.planApplied();
  let fact: PlanAppliedFact;
  if (inForce !== null && inForce.rev === commit.expect.rev) {
    if (inForce.payloadSha256 !== commit.expect.payloadSha256) throw new Error(`plan rev ${inForce.rev} is in force from another payload than ${commit.op}'s ${commit.expect.payloadSha256}`);
    fact = inForce;
  } else {
    if ((inForce?.rev ?? 0) !== commit.expect.base) throw new Error(`${commit.op} commits rev ${commit.expect.rev} on rev ${commit.expect.base}, but rev ${inForce?.rev ?? 0} is in force`);
    fact = planAppliedOf(journal.view, payload, commit.expect.payloadSha256, publication);
    journal.fact(fact);
    crashPoint('revision.commit.after-fact');
  }
  const index = new Map<string, number>();
  for (const d of payload.divergences) {
    const i = index.get(d.job) ?? 0;
    index.set(d.job, i + 1);
    if (journal.view.holistic().divergences.some((x) => x.job === d.job && x.index === i)) continue;
    journal.fact({ kind: 'divergence', id: journal.view.nextDivergenceId(), index: i, ...d });
  }
  return fact;
}

/**
 * Keeps `payload`, then opens its `revision.commit` (the fence's durable half, A19): the payload before anything
 * names it. The caller holds the in-process fence (src/core/fence.ts).
 */
export function beginRevision(journal: Journal, runDir: AbsPath, payload: RevisionPayload, parent: Parent): IntentOf<'revision.commit'> {
  const sha = keepPayload(runDir, payload);
  crashPoint('plan.apply.after-inputs');
  const open = openRevision(journal.view);
  if (open !== null) throw new Error(`revision.commit ${open.op} is open: one revision commits at a time (the fence, A19)`);
  const { op } = journal.begin({
    kind: 'revision.commit', key: opKey(REVISION_FENCE_KEY), parent, deadlineAt: null,
    body: () => ({ expect: { source: payload.source, base: payload.base, rev: payload.rev, payloadSha256: sha, docs: payload.publication !== null }, post: null }),
  });
  crashPoint('revision.commit.after-intent');
  return journal.view.latestIntent(op) as IntentOf<'revision.commit'>;
}

/** Closes a commit whose facts are appended; `recovered`: recovery closed it. */
export function closeRevision(journal: Journal, op: OpId, recovered: boolean): void {
  journal.done(op, 'revision.commit', { kind: 'applied' }, recovered ? 'reconciled' : null);
}

/**
 * Commits a revision with no docs publication at once: its payload kept, its `revision.commit`, `plan-applied` and
 * divergences, done. A payload with a publication commits through src/recover/revision.ts `commitRevision`.
 */
export function commitRevisionNow(journal: Journal, runDir: AbsPath, payload: RevisionPayload, parent: Parent): PlanAppliedFact {
  if (payload.publication !== null) throw new Error(`revision ${payload.rev} carries a docs publication; it commits through src/recover/revision.ts`);
  const commit = beginRevision(journal, runDir, payload, parent);
  const fact = appendRevision(journal, commit, payload, null);
  closeRevision(journal, commit.op, false);
  return fact;
}

/**
 * Puts `files` in force as the next plan revision of source `start` (an arc's first start, the baseline of an arc an
 * earlier release ran): their bytes kept, then the revision committed (`commitRevisionNow`). Revision 1 of a log with
 * no `dispatch` fact schedules a DAG (`scheduling: 'dag'`, M2); revision 1 of a log an earlier release dispatched in
 * (a 1.0.0-dev.3 arc's baseline) leaves it out, so that arc stays legacy (src/core/upgrade.ts). A start whose files
 * change a later revision commits the payload its evaluation built (src/preflight/checks.ts `settlePlan`).
 */
export function recordPlan(journal: Journal, runDir: AbsPath, files: InputFiles, changes: readonly PlanChange[], routing: RoutingBase): PlanAppliedFact {
  const base = journal.view.planApplied()?.rev ?? 0;
  const payload: RevisionPayload = {
    v: SCHEMA_VERSION, source: { type: 'start' }, base, rev: planRev(base + 1), manifest: keepRevisionFiles(runDir, files), changes,
    dispositions: [], divergences: [], publication: null, routingProvenance: routingProvenanceOf(routing, files.plan),
  };
  return commitRevisionNow(journal, runDir, payload, { type: 'arc' });
}

// ---------------------------------------------------------------------------------------------------
// In force

export type InForce = Readonly<{ rev: PlanRev; plan: PlanM1; manifest: PlanManifest; fact: PlanAppliedFact }>;

/**
 * The plan in force per the log, parsed from its kept bytes, or null before the first `plan-applied`. The
 * executor's contexts cache it per revision (src/executor.ts `contexts`); every other caller reads it once.
 */
export function planInForce(runDir: AbsPath, view: JournalView): InForce | null {
  const fact = view.planApplied();
  if (fact === null) return null;
  const bytes = keptInput(runDir, fact.planSha256, PLAN_INPUT);
  if (bytes === null) throw new Error(`the plan in force (rev ${fact.rev}) is ${fact.planSha256}, but ${inputPath(runDir, fact.planSha256, PLAN_INPUT)} does not exist`);
  const plan = parsePlan(JSON.parse(bytes.toString('utf8')));
  return { rev: fact.rev, plan, manifest: { planSha256: fact.planSha256, specs: fact.specs }, fact };
}

/** The plan in force, which every executor context has once its start recorded one. */
export function requirePlanInForce(runDir: AbsPath, view: JournalView): InForce {
  const inForce = planInForce(runDir, view);
  if (inForce === null) throw new Error(`the log of arc ${view.arc} records no plan in force; a start records it before anything runs`);
  return inForce;
}

/** The ruling sidecars, obligations and vision in force besides plan and specs, parsed from their kept bytes. */
export type RevisionInForce = Readonly<{
  /** The ledger's bytes: kept, or (a dev.5 revision, no payload) the live file. */
  ledger: Readonly<{ sha256: Sha256Hex; bytes: Buffer }>;
  /** Ascending by id. */
  sidecars: ReadonlyMap<RulingId, Readonly<{ sha256: Sha256Hex; bytes: Buffer; sidecar: RulingSidecar }>>;
  obligations: Readonly<{ sha256: Sha256Hex; bytes: Buffer; value: Obligations }> | null;
  vision: Readonly<{ sha256: Sha256Hex; bytes: Buffer; value: Vision }> | null;
  /** The whole revision manifest in force (a dev.5 one: the live ledger's hash, no sidecars, no obligations or vision). */
  manifest: RevisionManifest;
}>;

function kept(runDir: AbsPath, sha: Sha256Hex, ext: string): Buffer {
  const bytes = keptInput(runDir, sha, ext);
  if (bytes === null) throw new Error(`the revision in force names ${ext} ${sha}, but ${inputPath(runDir, sha, ext)} does not exist`);
  return bytes;
}
const json = (bytes: Buffer): unknown => JSON.parse(bytes.toString('utf8'));

/**
 * The inputs in force beyond plan and specs: the latest `plan-applied`'s payload manifest's. A revision a dev.5
 * executor wrote has none: the ledger is read live beside `planFile` (the upgrade warning), nothing else is in force.
 */
export function revisionInForce(runDir: AbsPath, inForce: InForce, planFile: AbsPath): RevisionInForce {
  const { fact } = inForce;
  if (fact.payloadSha256 === undefined) {
    const bytes = rulingsFromLiveFile(ledgerPath(planFile, inForce.plan));
    const ledgerSha256 = bytesSha256(bytes);
    return {
      ledger: { sha256: ledgerSha256, bytes }, sidecars: new Map(), obligations: null, vision: null,
      manifest: { ...inForce.manifest, rulings: { ledgerSha256, sidecars: {} }, obligations: null, vision: null },
    };
  }
  const { manifest } = keptPayload(runDir, fact.payloadSha256);
  const sidecars = new Map(Object.entries(manifest.rulings.sidecars).map(([id, sha]) => {
    const bytes = kept(runDir, sha, RULING_INPUT);
    return [id as RulingId, { sha256: sha, bytes, sidecar: parseRulingSidecar(json(bytes)) }] as const;
  }).sort(([a], [b]) => rulingNumber(a) - rulingNumber(b)));
  const parsed = <T>(sha: Sha256Hex | null, ext: string, parse: (v: unknown) => T): Readonly<{ sha256: Sha256Hex; bytes: Buffer; value: T }> | null => {
    if (sha === null) return null;
    const bytes = kept(runDir, sha, ext);
    return { sha256: sha, bytes, value: parse(json(bytes)) };
  };
  return {
    ledger: { sha256: manifest.rulings.ledgerSha256, bytes: kept(runDir, manifest.rulings.ledgerSha256, RULINGS_INPUT) },
    sidecars,
    obligations: parsed(manifest.obligations, OBLIGATIONS_INPUT, parseObligations),
    vision: parsed(manifest.vision, VISION_INPUT, parseVision),
    manifest,
  };
}

/**
 * The revision in force as files, built from kept bytes alone: what a revision made in memory starts from (a bundle
 * adds its ops, a `rule` its sidecar, a `reverse` restores a preimage). A unit's spec is the one an unchanged file
 * would hold: its pending revision, else its recorded spec, else the manifest's. Paths name the arc's files.
 */
export function inForceFiles(runDir: AbsPath, view: JournalView, inForce: InForce, revision: RevisionInForce, planFile: AbsPath): InputFiles {
  const plan = inForce.plan;
  const ledger = ledgerPath(planFile, plan);
  const specs = new Map(plan.units.map((u) => {
    const s = view.unit(u.id);
    const sha = s.pendingRevision?.sha256 ?? s.spec?.sha256 ?? inForce.manifest.specs[u.id];
    if (sha === undefined) throw new Error(`unit ${u.id} is in the plan in force without a spec in its manifest`);
    return [u.id, { path: specFilePath(planFile, u), bytes: specBytesOf(runDir, sha, specFilePath(planFile, u)).bytes }] as const;
  }));
  const beside = (path: string, bytes: Buffer): InputFile => ({ path: absPath(join(dirname(planFile), path)), bytes });
  const planBytes = keptInput(runDir, inForce.manifest.planSha256, PLAN_INPUT);
  if (planBytes === null) throw new Error(`the plan in force (rev ${inForce.rev}) is not kept`);
  return {
    planFile, plan, planBytes, specs,
    ledger: { path: ledger, bytes: revision.ledger.bytes },
    sidecars: new Map([...revision.sidecars].map(([id, s]) => [id, { path: sidecarPath(ledger, id), bytes: s.bytes }] as const)),
    obligations: revision.obligations === null || plan.holistic?.obligations === undefined ? null : beside(plan.holistic.obligations, revision.obligations.bytes),
    vision: revision.vision === null || plan.holistic === undefined ? null : beside(plan.holistic.vision, revision.vision.bytes),
  };
}

/** The hash of `unit`'s spec in force: its recorded spec once dispatched, else the manifest's. */
export function specShaInForce(view: JournalView, unit: UnitId): Sha256Hex {
  const recorded = view.unit(unit).spec;
  if (recorded !== null) return recorded.sha256;
  const fact = view.planApplied();
  if (fact === null) throw new Error(`the log of arc ${view.arc} records no plan in force; a start records it before anything runs`);
  const sha = fact.specs[unit];
  if (sha === undefined) throw new Error(`unit ${unit} is not in the plan in force`);
  return sha;
}

/**
 * The spec whose bytes hash to `sha`: kept in the run dir, or (an arc started before specs were kept) the
 * live file at `livePath`, with the upgrade warning.
 */
export function specBytesOf(runDir: AbsPath, sha: Sha256Hex, livePath: AbsPath): Readonly<{ bytes: Buffer; sha256: Sha256Hex }> {
  const kept = keptInput(runDir, sha, SPEC_INPUT);
  if (kept !== null) return { bytes: kept, sha256: sha };
  const bytes = specBytesFromLiveFile(livePath, sha);
  const actual = keepInput(runDir, bytes, SPEC_INPUT);
  return { bytes, sha256: actual };
}

export type LoadedSpec = Readonly<{ path: AbsPath; spec: SpecM1; sha256: Sha256Hex }>;

/** Parses spec bytes of `unit` read for `path`; a spec of another unit is a bug here (the apply checks it). */
export function parseUnitSpec(bytes: Buffer, path: AbsPath, unit: UnitId): SpecM1 {
  const spec = parseSpec(bytes, path);
  if (spec.unit !== unit) throw new Error(`${path} is the spec of ${spec.unit}, not of ${unit}`);
  return spec;
}
