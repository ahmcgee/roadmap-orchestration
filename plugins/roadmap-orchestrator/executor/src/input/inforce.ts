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
// M3 (G1, A2, A3, A14; step A2): the revisioned set is the plan, the specs, the rulings ledger with its sidecars
// (`<ledger>.d/C-<n>.json` beside the ledger file), the obligations and the vision (`plan.holistic`). A revision's
// manifest hashes them all (`RevisionManifest`) and keeps their bytes (`inputs/<sha>.rulings.md`, `.ruling.json`,
// `.obligations.json`, `.vision.json`). Its evaluated payload is kept as `inputs/<sha>.revision.json` and named by a
// `revision.commit` intent (`beginRevision`) before any docs `ff`; `plan-applied` is appended from it exactly, then
// its divergences (`appendRevision`). The inputs in force beyond plan and specs are the latest `plan-applied`'s
// payload manifest's (`revisionInForce`).
//
// M4a (step C1): a corpus arc's revision adds four inputs (`RevisionInputs.corpus*`, `phase0*`): the pin and the
// Phase-0 record beside the plan, the issue capture the record names (beside the plan), and the corpus guide committed
// at the plan's baseline (LR-A1-1), kept as `inputs/<sha>.corpus.json`, `.phase0.json`, `.issues.json` and
// `.corpus-guide.md`; its vision record is `<repo>/.roadmap/vision.json` (R1). The corpus files the pin names are kept as
// `inputs/<sha>.corpus-file` from the source the pin re-derived from (`keepCorpusFiles`, src/phase0/rows.ts).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import {
  type IntentOf, type Parent, type PlanAppliedFact, type PlanChange, REVISION_FENCE_KEY, type RevisionPayload, parseRevisionPayload,
} from '../core/events.ts';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import { type OpId, type PlanRev, type RulingId, type Sha256Hex, type UnitId, opKey, planRev, rulingId } from '../core/ids.ts';
import { CORPUS_GUIDE_PATH } from '../corpus/guide.ts';
import type { SourceFile } from '../corpus/source.ts';
import { type CorpusPin, parseCorpusPin } from '../corpus/types.ts';
import { type IssueCapture, parseIssueCapture } from '../forge/types.ts';
import { gitRun } from '../git/git.ts';
import { type Phase0Record, parsePhase0Record } from '../phase0/types.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { PlanManifest, RevisionManifest, SpecM1 } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { type Obligations, type RulingSidecar, type Vision, parseObligations, parseRulingSidecar, parseVision } from '../holistic/types.ts';
import { type RepoConfig, type ResolvedRouting, planStack, resolveRouting } from '../routing/layers.ts';
import type { ProfileName, RoutingLayer, RoutingProvenance } from '../routing/types.ts';
import { bytesSha256, parseSpec } from '../spec/spec.ts';
import { type PlanM1, type PlanUnit, parsePlan, visionFile } from './plan.ts';

export const PLAN_INPUT = 'plan.json';
export const SPEC_INPUT = 'spec.json';
export const RULINGS_INPUT = 'rulings.md';
export const RULING_INPUT = 'ruling.json';
export const OBLIGATIONS_INPUT = 'obligations.json';
export const VISION_INPUT = 'vision.json';
export const REVISION_INPUT = 'revision.json';
/** M4a: a corpus arc's pin, guide bytes, corpus files, Phase-0 record and issue capture (H5, H8). */
export const CORPUS_INPUT = 'corpus.json';
export const CORPUS_GUIDE_INPUT = 'corpus-guide.md';
export const CORPUS_FILE_INPUT = 'corpus-file';
export const PHASE0_INPUT = 'phase0.json';
export const ISSUES_INPUT = 'issues.json';
/** M4a (K8): a pack review's `PackReviewInputs`, kept before its spawn and named by its `pack-review-started`. */
export const PACK_REVIEW_INPUT = 'pack-review.json';
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
 * M4a: a corpus arc's inputs beyond M3's. `pin` and `phase0` are the files `plan.corpus` and `plan.phase0` name (beside
 * the plan); `capture` the issue capture the Phase-0 record names (beside the plan; null when the record does not load);
 * `guide` the corpus guide committed at the plan's baseline (its path names it as `<repo>/.roadmap/corpus.md`).
 */
export type CorpusInputFiles = Readonly<{ pin: InputFile; guide: InputFile; phase0: InputFile; capture: InputFile | null }>;

/**
 * plan.json, the spec.json of each of its units, and (M3) the rulings ledger with its sidecars, the obligations and
 * the vision: what an apply or a start would put in force. A revision built in memory (a rule, a bundle, a reverse)
 * has the same shape, its paths naming where the files are. M4a: the product repo (a corpus arc's vision record and
 * guide live there) and a corpus arc's inputs.
 */
export type InputFiles = Readonly<{
  repo: AbsPath;
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
  /** M4a: a corpus arc's pin, guide, Phase-0 record and capture; null for an `architecture-doc` arc. */
  corpus: CorpusInputFiles | null;
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

/**
 * The vision file (`visionFile`): beside the plan for an `architecture-doc` arc, `<repo>/.roadmap/vision.json` for a
 * corpus arc (R1); null when the arc has none.
 */
function visionInput(plan: PlanM1, repo: AbsPath, read: (path: AbsPath) => InputFile, planFile: AbsPath): InputFile | null {
  const at = visionFile(plan);
  if (at === null) return null;
  return read(absPath(join(at.base === 'plan' ? dirname(planFile) : repo, at.path)));
}

/** The corpus guide committed at `rev` of the product repo (LR-A1-1: a corpus arc's is at its baseline); bytes null when none. */
export function guideFileAt(repo: AbsPath, rev: string): InputFile {
  const r = gitRun(repo, ['cat-file', 'blob', `${rev}:${CORPUS_GUIDE_PATH}`], { okCodes: [0, 128] });
  return { path: absPath(join(repo, CORPUS_GUIDE_PATH)), bytes: r.code === 0 ? Buffer.from(r.stdout, 'utf8') : null };
}

/** The Phase-0 record's bytes parsed, or null when they are absent or do not load (the rows report why). */
export function phase0RecordOf(bytes: Buffer | null): Phase0Record | null {
  if (bytes === null) return null;
  try {
    return parsePhase0Record(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof SchemaError || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Reads the plan (parsed: throws SchemaError or SyntaxError) and the bytes of every input it names. */
export function readInputFiles(planFile: AbsPath, repo: AbsPath): InputFiles {
  const planBytes = readFileSync(planFile);
  const plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  const specs = new Map(plan.units.map((u) => [u.id, inputFile(specFilePath(planFile, u))] as const));
  const ledger = ledgerPath(planFile, plan);
  const beside = (path: string): InputFile => inputFile(absPath(join(dirname(planFile), path)));
  let corpus: CorpusInputFiles | null = null;
  if (plan.target === 'corpus') {
    const phase0 = beside(plan.phase0);
    const record = phase0RecordOf(phase0.bytes);
    corpus = { pin: beside(plan.corpus), guide: guideFileAt(repo, plan.baseline), phase0, capture: record === null ? null : beside(record.issueCapture.file) };
  }
  return {
    repo, planFile, plan, planBytes, specs, ledger: inputFile(ledger), sidecars: readSidecars(ledger),
    obligations: plan.holistic?.obligations === undefined ? null : beside(plan.holistic.obligations),
    vision: visionInput(plan, repo, inputFile, planFile),
    corpus,
  };
}

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
  const c = files.corpus;
  let corpus: Pick<RevisionManifest, 'corpus' | 'corpusGuide' | 'phase0' | 'phase0Issues'> = {};
  if (c !== null) {
    const pin = optional('corpus pin', c.pin);
    const guide = c.guide.bytes === null ? null : bytesSha256(c.guide.bytes);
    if (guide === null) missing.push(`the corpus guide ${CORPUS_GUIDE_PATH} is not committed at the plan's baseline ${files.plan.baseline}`);
    const phase0 = optional('Phase-0 record', c.phase0);
    if (c.capture === null && c.phase0.bytes !== null) missing.push(`the Phase-0 record ${c.phase0.path} does not load, so its issue capture is unknown`);
    const capture = optional('issue capture', c.capture);
    if (pin !== null && guide !== null && phase0 !== null && capture !== null) corpus = { corpus: pin, corpusGuide: guide, phase0, phase0Issues: capture };
  }
  if (missing.length > 0 || ledger === null) return { missing };
  return {
    planSha256: bytesSha256(files.planBytes), specs,
    rulings: { ledgerSha256: bytesSha256(ledger), sidecars: Object.fromEntries([...files.sidecars].map(([id, x]) => [id, bytesSha256(x.bytes)])) },
    obligations, vision, ...corpus,
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

/**
 * Keeps every input's bytes (all must exist) and returns the revision manifest. A corpus arc's corpus files are kept
 * beforehand from the source its pin re-derived from (`keepCorpusFiles`); every one the pin names must be kept.
 */
export function keepRevisionFiles(runDir: AbsPath, files: InputFiles): RevisionManifest {
  const bytes = (f: InputFile | null): Buffer => {
    if (f === null || f.bytes === null) throw new Error(`keepRevisionFiles: ${f?.path ?? 'an issue capture'} does not exist`);
    return f.bytes;
  };
  const c = files.corpus;
  let corpus: Pick<RevisionManifest, 'corpus' | 'corpusGuide' | 'phase0' | 'phase0Issues'> = {};
  if (c !== null) {
    const pin = parseCorpusPin(JSON.parse(bytes(c.pin).toString('utf8')));
    const unkept = pin.files.filter((f) => keptInput(runDir, f.sha256, CORPUS_FILE_INPUT) === null);
    if (unkept.length > 0) throw new Error(`keepRevisionFiles: the corpus files ${unkept.map((f) => f.path).join(', ')} of the pin are not kept (keepCorpusFiles first)`);
    corpus = {
      corpus: keepInput(runDir, bytes(c.pin), CORPUS_INPUT), corpusGuide: keepInput(runDir, bytes(c.guide), CORPUS_GUIDE_INPUT),
      phase0: keepInput(runDir, bytes(c.phase0), PHASE0_INPUT), phase0Issues: keepInput(runDir, bytes(c.capture), ISSUES_INPUT),
    };
  }
  return {
    ...keepInputFiles(runDir, files),
    rulings: {
      ledgerSha256: keepInput(runDir, bytes(files.ledger), RULINGS_INPUT),
      sidecars: Object.fromEntries([...files.sidecars].map(([id, x]) => [id, keepInput(runDir, x.bytes, RULING_INPUT)])),
    },
    obligations: files.obligations === null ? null : keepInput(runDir, bytes(files.obligations), OBLIGATIONS_INPUT),
    vision: files.vision === null ? null : keepInput(runDir, bytes(files.vision), VISION_INPUT),
    ...corpus,
  };
}

/** Keeps the corpus files a re-derived pin read from its source (`inputs/<sha>.corpus-file`), each hashing as pinned. */
export function keepCorpusFiles(runDir: AbsPath, files: readonly SourceFile[]): void {
  for (const f of files) {
    const sha = keepInput(runDir, Buffer.from(f.text, 'utf8'), CORPUS_FILE_INPUT);
    if (sha !== f.sha256) throw new Error(`keepCorpusFiles: ${f.path} hashes to ${sha}, its source says ${f.sha256}`);
  }
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

/** The kept payload of plan rev `rev`, by its applied `revision.commit` (a revision this release wrote always has one). */
export function payloadAtRev(view: JournalView, runDir: AbsPath, rev: number): RevisionPayload {
  const commit = view.opsOf('revision.commit').find((c) => c.expect.rev === rev && view.doneOf(c.op) !== null);
  if (commit === undefined) throw new Error(`plan rev ${rev} has no applied revision.commit`);
  return keptPayload(runDir, commit.expect.payloadSha256);
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
 * scheduling of an arc's revision 1 (M2).
 */
export function planAppliedOf(payload: RevisionPayload, payloadSha256: Sha256Hex, publication: Publication | null): PlanAppliedFact {
  const m = payload.manifest;
  return {
    kind: 'plan-applied', rev: payload.rev, command: payload.source.type === 'command' ? payload.source.command : null,
    planSha256: m.planSha256, specs: m.specs, changes: payload.changes, ...(payload.rev === 1 ? { scheduling: 'dag' as const } : {}),
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
    fact = planAppliedOf(payload, commit.expect.payloadSha256, publication);
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
 * Puts `files` in force as the next plan revision of source `start` (an arc's first start): their bytes kept, then the
 * revision committed (`commitRevisionNow`). Revision 1 schedules a DAG (`scheduling: 'dag'`, M2). A start whose files
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
  /** The ledger's kept bytes. */
  ledger: Readonly<{ sha256: Sha256Hex; bytes: Buffer }>;
  /** Ascending by id. */
  sidecars: ReadonlyMap<RulingId, Readonly<{ sha256: Sha256Hex; bytes: Buffer; sidecar: RulingSidecar }>>;
  obligations: Readonly<{ sha256: Sha256Hex; bytes: Buffer; value: Obligations }> | null;
  vision: Readonly<{ sha256: Sha256Hex; bytes: Buffer; value: Vision }> | null;
  /** M4a: a corpus arc's pin, guide bytes, Phase-0 record and issue capture in force; null for an `architecture-doc` arc. */
  corpus: CorpusInForce | null;
  /** The whole revision manifest in force. */
  manifest: RevisionManifest;
}>;

type Kept<T> = Readonly<{ sha256: Sha256Hex; bytes: Buffer; value: T }>;
export type CorpusInForce = Readonly<{
  pin: Kept<CorpusPin>;
  guide: Readonly<{ sha256: Sha256Hex; bytes: Buffer }>;
  phase0: Kept<Phase0Record>;
  capture: Kept<IssueCapture>;
}>;

function kept(runDir: AbsPath, sha: Sha256Hex, ext: string): Buffer {
  const bytes = keptInput(runDir, sha, ext);
  if (bytes === null) throw new Error(`the revision in force names ${ext} ${sha}, but ${inputPath(runDir, sha, ext)} does not exist`);
  return bytes;
}
const json = (bytes: Buffer): unknown => JSON.parse(bytes.toString('utf8'));

/** The inputs in force beyond plan and specs: the latest `plan-applied`'s payload manifest's. */
export function revisionInForce(runDir: AbsPath, inForce: InForce): RevisionInForce {
  const { manifest } = keptPayload(runDir, inForce.fact.payloadSha256);
  const sidecars = new Map(Object.entries(manifest.rulings.sidecars).map(([id, sha]) => {
    const bytes = kept(runDir, sha, RULING_INPUT);
    return [id as RulingId, { sha256: sha, bytes, sidecar: parseRulingSidecar(json(bytes)) }] as const;
  }).sort(([a], [b]) => rulingNumber(a) - rulingNumber(b)));
  const parsed = <T>(sha: Sha256Hex | null, ext: string, parse: (v: unknown) => T): Readonly<{ sha256: Sha256Hex; bytes: Buffer; value: T }> | null => {
    if (sha === null) return null;
    const bytes = kept(runDir, sha, ext);
    return { sha256: sha, bytes, value: parse(json(bytes)) };
  };
  const { corpus: pinSha, corpusGuide, phase0, phase0Issues } = manifest;
  return {
    ledger: { sha256: manifest.rulings.ledgerSha256, bytes: kept(runDir, manifest.rulings.ledgerSha256, RULINGS_INPUT) },
    sidecars,
    obligations: parsed(manifest.obligations, OBLIGATIONS_INPUT, parseObligations),
    vision: parsed(manifest.vision, VISION_INPUT, parseVision),
    corpus: pinSha === undefined || corpusGuide === undefined || phase0 === undefined || phase0Issues === undefined ? null : {
      pin: parsed(pinSha, CORPUS_INPUT, parseCorpusPin)!,
      guide: { sha256: corpusGuide, bytes: kept(runDir, corpusGuide, CORPUS_GUIDE_INPUT) },
      phase0: parsed(phase0, PHASE0_INPUT, parsePhase0Record)!,
      capture: parsed(phase0Issues, ISSUES_INPUT, parseIssueCapture)!,
    },
    manifest,
  };
}

/**
 * The revision in force as files, built from kept bytes alone: what a revision made in memory starts from (a bundle
 * adds its ops, a `rule` its sidecar, a `reverse` restores a preimage). A unit's spec is the one an unchanged file
 * would hold: its pending revision, else its recorded spec, else the manifest's. Paths name the arc's files.
 */
export function inForceFiles(runDir: AbsPath, view: JournalView, inForce: InForce, revision: RevisionInForce, planFile: AbsPath, repo: AbsPath): InputFiles {
  const plan = inForce.plan;
  const ledger = ledgerPath(planFile, plan);
  const specs = new Map(plan.units.map((u) => {
    const s = view.unit(u.id);
    const sha = s.pendingRevision?.sha256 ?? s.spec?.sha256 ?? inForce.manifest.specs[u.id];
    if (sha === undefined) throw new Error(`unit ${u.id} is in the plan in force without a spec in its manifest`);
    return [u.id, { path: specFilePath(planFile, u), bytes: specBytesOf(runDir, sha) }] as const;
  }));
  const beside = (path: string, bytes: Buffer): InputFile => ({ path: absPath(join(dirname(planFile), path)), bytes });
  const planBytes = keptInput(runDir, inForce.manifest.planSha256, PLAN_INPUT);
  if (planBytes === null) throw new Error(`the plan in force (rev ${inForce.rev}) is not kept`);
  const c = revision.corpus;
  if ((c === null) !== (plan.target !== 'corpus')) throw new Error(`the revision in force (rev ${inForce.rev}) ${c === null ? 'keeps no' : 'keeps'} corpus inputs for a ${plan.target} plan`);
  return {
    repo, planFile, plan, planBytes, specs,
    ledger: { path: ledger, bytes: revision.ledger.bytes },
    sidecars: new Map([...revision.sidecars].map(([id, s]) => [id, { path: sidecarPath(ledger, id), bytes: s.bytes }] as const)),
    obligations: revision.obligations === null || plan.holistic?.obligations === undefined ? null : beside(plan.holistic.obligations, revision.obligations.bytes),
    vision: revision.vision === null ? null : visionInput(plan, repo, (path) => ({ path, bytes: revision.vision!.bytes }), planFile),
    corpus: c === null || plan.target !== 'corpus' ? null : {
      pin: beside(plan.corpus, c.pin.bytes), guide: { path: absPath(join(repo, CORPUS_GUIDE_PATH)), bytes: c.guide.bytes },
      phase0: beside(plan.phase0, c.phase0.bytes), capture: beside(c.phase0.value.issueCapture.file, c.capture.bytes),
    },
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

/** The kept spec whose bytes hash to `sha`. */
export function specBytesOf(runDir: AbsPath, sha: Sha256Hex): Buffer {
  return kept(runDir, sha, SPEC_INPUT);
}

export type LoadedSpec = Readonly<{ path: AbsPath; spec: SpecM1; sha256: Sha256Hex }>;

/** Parses spec bytes of `unit` read for `path`; a spec of another unit is a bug here (the apply checks it). */
export function parseUnitSpec(bytes: Buffer, path: AbsPath, unit: UnitId): SpecM1 {
  const spec = parseSpec(bytes, path);
  if (spec.unit !== unit) throw new Error(`${path} is the spec of ${spec.unit}, not of ${unit}`);
  return spec;
}
