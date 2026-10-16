// Apply rebases (arc feedback 2026-10-16, item 3; DESIGN-1.0.md §2.3): the owner's input files are an edit of a recorded
// base, and an apply or a start puts in force a three-way merge of each input file, never the files as they are. The
// executor never writes into the owner's files: after `start` the event log and the run dir's kept inputs are the only
// truth, and `roadmap inputs export` is the one way to get the files in force.
//
//   base    the files the owner's edit started from: an export's (`export.json` `base`, passed as `apply --base`), else
//           the owner's files of the latest revision applied from them (`ownerBase`: a start's, or an `apply`'s, as
//           its command hashed them). Every byte of it is kept content-addressed in the run dir.
//   ours    the owner's files as they are now (the bytes the command's manifest hashes).
//   theirs  the files in force (`inForceFiles`): every executor act since the base included (machine and plan-check
//           spec patches, checkpoint bundles, flow proposals, rulings, steer classes, scope growth).
//
// Per file: ours unchanged since the base takes theirs; theirs unchanged takes ours; both changed merges structurally
// (`merge3`): objects per key, arrays of objects with an `id` (or `name`) per element, so plan units, spec items, lanes,
// obligations and vision clauses merge one by one. A spec's `rev` rebases: the merged spec takes the arc's rev plus the
// owner's step from the base (`rev + 1` stays the next rev on top of an executor patch). The ledger merges by line
// (rulings are append-only: the owner's added and removed lines replayed on the arc's), sidecars per file. Only a
// true conflict refuses, one reason per JSON path both sides changed differently, and so does an owner spec older
// than its base (the files predate the base: applying them would revert an executor act). The classifier then judges
// the merged files like any proposal.
import { dirname, join } from 'node:path';
import type { ArcId, RulingId, Sha256Hex, UnitId } from '../core/ids.ts';
import { compareIds } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { RevisionManifest } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { readCommand } from '../commands/queue.ts';
import { CORPUS_GUIDE_PATH } from '../corpus/guide.ts';
import {
  CORPUS_GUIDE_INPUT, CORPUS_INPUT, type InputFile, type InputFiles, ISSUES_INPUT, OBLIGATIONS_INPUT, PHASE0_INPUT, PLAN_INPUT, RULING_INPUT, RULINGS_INPUT,
  SPEC_INPUT, VISION_INPUT, keepInput, keptInput, keptPayload, ledgerPath, phase0RecordOf, revisionManifestOf, sidecarPath, specFilePath,
} from './inforce.ts';
import { type PlanM1, parsePlan, visionFile } from './plan.ts';

type Json = null | boolean | number | string | readonly Json[] | Readonly<{ [k: string]: Json }>;
/** A JSON value, or absent (a key or element one side does not have). */
type Value = Json | undefined;

const same = (a: Value, b: Value): boolean => (a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b));
const isObject = (v: Value): v is Readonly<{ [k: string]: Json }> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** An element's identity in an array that merges per element: its `id`, else its `name`. */
const keyOf = (v: Json): string | null => (isObject(v) ? (typeof v['id'] === 'string' ? v['id'] : typeof v['name'] === 'string' ? v['name'] : null) : null);
/** An array whose elements all have distinct keys (empty included): it merges per element. */
function keyed(v: Value): ReadonlyMap<string, Json> | null {
  if (!Array.isArray(v)) return null;
  const out = new Map<string, Json>();
  for (const e of v as readonly Json[]) {
    const k = keyOf(e);
    if (k === null || out.has(k)) return null;
    out.set(k, e);
  }
  return out;
}
const segment = (path: string, key: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

/** Whether `order` lists the keys both it and `base` hold in `base`'s order. */
function keepsOrder(order: readonly string[], base: readonly string[]): boolean {
  const inBase = new Set(base);
  const shared = order.filter((k) => inBase.has(k));
  const inOrder = new Set(shared);
  return canonicalJson(shared) === canonicalJson(base.filter((k) => inOrder.has(k)));
}

/**
 * The three-way merge of one JSON value: a side unchanged since `base` takes the other; both changed alike is that change;
 * otherwise objects merge per key and keyed arrays per element (`keyed`), and anything else is a conflict, its JSON path
 * pushed to `conflicts` (the result is then meaningless). Absent (`undefined`) is a value: a removal merges like an edit.
 */
export function merge3(base: Value, ours: Value, theirs: Value, path: string, conflicts: string[]): Value {
  if (same(ours, base)) return theirs;
  if (same(theirs, base)) return ours;
  if (same(ours, theirs)) return ours;
  if (isObject(ours) && isObject(theirs) && (base === undefined || isObject(base))) {
    const b: Readonly<{ [k: string]: Json }> = base ?? {};
    const out: { [k: string]: Json } = {};
    for (const k of [...new Set([...Object.keys(theirs), ...Object.keys(ours)])]) {
      const v = merge3(b[k], ours[k], theirs[k], segment(path, k), conflicts);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  const o = keyed(ours);
  const t = keyed(theirs);
  const b = base === undefined ? new Map<string, Json>() : keyed(base);
  if (o !== null && t !== null && b !== null) {
    const [bk, ok, tk] = [[...b.keys()], [...o.keys()], [...t.keys()]];
    // Order: the side that reordered the base's elements keeps its order; the other side's new elements follow it.
    let order: readonly string[];
    if (keepsOrder(ok, bk)) order = [...tk, ...ok.filter((k) => !t.has(k))];
    else if (keepsOrder(tk, bk)) order = [...ok, ...tk.filter((k) => !o.has(k))];
    else {
      conflicts.push(`${path} (both reordered)`);
      return theirs;
    }
    const out: Json[] = [];
    for (const k of order) {
      const v = merge3(b.get(k), o.get(k), t.get(k), `${path}[${k}]`, conflicts);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  conflicts.push(path);
  return theirs;
}

// ---------------------------------------------------------------------------------------------------
// Files

/** One file's three sides, as bytes (null: no such file on that side). */
type Sides = Readonly<{ base: Buffer | null; ours: Buffer | null; theirs: Buffer | null }>;
const sameBytes = (a: Buffer | null, b: Buffer | null): boolean => (a === null || b === null ? a === b : a.equals(b));

/** A JSON file's merge; `shape` merges the parsed values (default `merge3`). Bytes of a side kept when the merge is that side. */
function mergeJson(
  file: string, s: Sides, conflicts: string[], shape: (b: Value, o: Value, t: Value, out: string[]) => Value = (b, o, t, out) => merge3(b, o, t, '$', out),
): Buffer | null {
  if (sameBytes(s.ours, s.base)) return s.theirs;
  if (sameBytes(s.theirs, s.base)) return s.ours;
  if (sameBytes(s.ours, s.theirs)) return s.ours;
  const parse = (b: Buffer | null): Value | 'unparsable' => {
    if (b === null) return undefined;
    try {
      return JSON.parse(b.toString('utf8')) as Json;
    } catch (error) {
      if (error instanceof SyntaxError) return 'unparsable';
      throw error;
    }
  };
  const [b, o, t] = [parse(s.base), parse(s.ours), parse(s.theirs)];
  if (b === 'unparsable' || o === 'unparsable' || t === 'unparsable') {
    conflicts.push(`${file}: both you and the arc changed it since the base, and it does not parse as JSON on every side`);
    return s.theirs;
  }
  const out: string[] = [];
  const v = shape(b, o, t, out);
  conflicts.push(...out.map((p) => `conflict: ${file} at ${p}: you and the arc both changed it since the base`));
  if (out.length > 0 || v === undefined) return out.length > 0 ? s.theirs : null;
  if (same(v, o)) return s.ours;
  if (same(v, t)) return s.theirs;
  return Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');
}

/**
 * A spec's merge: its `rev` rebases (the arc's rev plus the owner's step from the base), everything else merges per
 * `merge3`. An owner spec older than the base is refused: the files predate the base.
 */
function mergeSpec(file: string, unit: UnitId, s: Sides, conflicts: string[]): Buffer | null {
  return mergeJson(file, s, conflicts, (b, o, t, out) => {
    const rev = (v: Value): number | null => (isObject(v) && typeof v['rev'] === 'number' ? v['rev'] : null);
    const [br, or, tr] = [rev(b), rev(o), rev(t)];
    if (br === null || or === null || tr === null) return merge3(b, o, t, '$', out);
    if (or < br) {
      conflicts.push(`unit ${unit}: its spec ${file} is at rev ${or}, older than the base's rev ${br}: your files predate the base, and applying them would revert `
        + 'what the arc did since; `roadmap inputs export` the arc and edit the export');
      return t;
    }
    const strip = (v: Readonly<{ [k: string]: Json }>): Readonly<{ [k: string]: Json }> => Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'rev'));
    const merged = merge3(strip(b as Readonly<{ [k: string]: Json }>), strip(o as Readonly<{ [k: string]: Json }>), strip(t as Readonly<{ [k: string]: Json }>), '$', out);
    return isObject(merged) ? { ...merged, rev: tr + (or - br) } : merged;
  });
}

/** The ledger's merge by line: the owner's added and removed ruling lines (against the base) replayed on the arc's ledger. */
function mergeLedger(s: Sides): Buffer | null {
  if (sameBytes(s.ours, s.base)) return s.theirs;
  if (sameBytes(s.theirs, s.base) || s.theirs === null || s.ours === null) return s.ours;
  const lines = (b: Buffer | null): readonly string[] => (b === null ? [] : b.toString('utf8').split('\n').filter((l) => l.trim() !== ''));
  const [base, ours, theirs] = [lines(s.base), lines(s.ours), lines(s.theirs)];
  const removed = new Set(base.filter((l) => !ours.includes(l)));
  const added = ours.filter((l) => !base.includes(l) && !theirs.includes(l));
  if (removed.size === 0 && added.length === 0) return s.theirs;
  return Buffer.from([...theirs.filter((l) => !removed.has(l)), ...added].map((l) => `${l}\n`).join(''), 'utf8');
}

/** An optional input file: its merged bytes at `path` (where the merged plan names it), null when no side has one. */
function optionalFile(path: AbsPath | null, s: Sides, conflicts: string[]): InputFile | null {
  if (path === null) return null;
  return { path, bytes: mergeJson(path, s, conflicts) };
}
const bytesOf = (f: InputFile | null | undefined): Buffer | null => f?.bytes ?? null;

/**
 * The owner's files rebased onto the files in force: each input file's three-way merge, or every conflict. The merged
 * files are at the owner's paths (the plan file's directory), as an apply reads them.
 */
export function rebaseInputs(base: InputFiles, ours: InputFiles, theirs: InputFiles): Readonly<{ next: InputFiles }> | Readonly<{ reasons: readonly string[] }> {
  const conflicts: string[] = [];
  const planBytes = mergeJson(ours.planFile, { base: base.planBytes, ours: ours.planBytes, theirs: theirs.planBytes }, conflicts);
  if (conflicts.length > 0 || planBytes === null) return { reasons: conflicts };
  let plan: PlanM1;
  try {
    plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
    return { reasons: [`the plan merged from yours and the arc's does not load: ${error.message}`] };
  }
  const specs = new Map(plan.units.map((u) => {
    const path = specFilePath(ours.planFile, u);
    const bytes = mergeSpec(path, u.id, { base: bytesOf(base.specs.get(u.id)), ours: bytesOf(ours.specs.get(u.id)), theirs: bytesOf(theirs.specs.get(u.id)) }, conflicts);
    return [u.id, { path, bytes }] as const;
  }));
  const ledger = ledgerPath(ours.planFile, plan);
  const ledgerBytes = mergeLedger({ base: base.ledger.bytes, ours: ours.ledger.bytes, theirs: theirs.ledger.bytes });
  const sidecars = new Map<RulingId, Readonly<{ path: AbsPath; bytes: Buffer }>>();
  for (const id of [...new Set([...base.sidecars.keys(), ...ours.sidecars.keys(), ...theirs.sidecars.keys()])].sort(compareIds)) {
    const path = sidecarPath(ledger, id);
    const bytes = mergeJson(path, { base: bytesOf(base.sidecars.get(id)), ours: bytesOf(ours.sidecars.get(id)), theirs: bytesOf(theirs.sidecars.get(id)) }, conflicts);
    if (bytes !== null) sidecars.set(id, { path, bytes });
  }
  const beside = (p: string | undefined): AbsPath | null => (p === undefined ? null : absPath(join(dirname(ours.planFile), p)));
  const vision = visionFile(plan);
  const sides = (pick: (f: InputFiles) => InputFile | null | undefined): Sides => ({ base: bytesOf(pick(base)), ours: bytesOf(pick(ours)), theirs: bytesOf(pick(theirs)) });
  let corpus: InputFiles['corpus'] = null;
  if (plan.target === 'corpus') {
    if (ours.corpus === null) throw new Error('a merged corpus plan whose owner plan is not a corpus plan (a target change is refused by the classifier, which never sees this)');
    const phase0 = optionalFile(beside(plan.phase0), sides((f) => f.corpus?.phase0), conflicts)!;
    const record = phase0RecordOf(phase0.bytes);
    corpus = {
      pin: optionalFile(beside(plan.corpus), sides((f) => f.corpus?.pin), conflicts)!,
      guide: { path: absPath(join(ours.repo, CORPUS_GUIDE_PATH)), bytes: ours.corpus.guide.bytes },
      phase0,
      capture: record === null ? null : optionalFile(beside(record.issueCapture.file), sides((f) => f.corpus?.capture), conflicts),
    };
  }
  if (conflicts.length > 0) return { reasons: conflicts };
  return {
    next: {
      repo: ours.repo, planFile: ours.planFile, plan, planBytes, specs, ledger: { path: ledger, bytes: ledgerBytes }, sidecars,
      obligations: optionalFile(beside(plan.holistic?.obligations), sides((f) => f.obligations), conflicts),
      vision: vision === null ? null : optionalFile(absPath(join(vision.base === 'plan' ? dirname(ours.planFile) : ours.repo, vision.path)), sides((f) => f.vision), conflicts),
      corpus,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The base

/** The files a manifest names, from the run dir's kept bytes, at the owner's paths; or which bytes are not kept. */
export function baseFiles(runDir: AbsPath, base: RevisionManifest, planFile: AbsPath, repo: AbsPath): Readonly<{ files: InputFiles }> | Readonly<{ reasons: readonly string[] }> {
  const missing: string[] = [];
  const kept = (sha: Sha256Hex, ext: string, what: string): Buffer | null => {
    const bytes = keptInput(runDir, sha, ext);
    if (bytes === null) missing.push(`the base's ${what} ${sha} is not kept in the run dir: \`roadmap inputs export\` the arc, edit the export, and apply with --base`);
    return bytes;
  };
  const planBytes = kept(base.planSha256, PLAN_INPUT, 'plan');
  if (planBytes === null) return { reasons: missing };
  const plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  const specs = new Map(plan.units.map((u) => {
    const sha = base.specs[u.id];
    return [u.id, { path: specFilePath(planFile, u), bytes: sha === undefined ? null : kept(sha, SPEC_INPUT, `spec of ${u.id}`) }] as const;
  }));
  const ledger = ledgerPath(planFile, plan);
  const sidecars = new Map<RulingId, Readonly<{ path: AbsPath; bytes: Buffer }>>();
  for (const [id, sha] of Object.entries(base.rulings.sidecars) as [RulingId, Sha256Hex][]) {
    const bytes = kept(sha, RULING_INPUT, `ruling sidecar ${id}`);
    if (bytes !== null) sidecars.set(id, { path: sidecarPath(ledger, id), bytes });
  }
  const beside = (p: string | undefined): AbsPath => absPath(join(dirname(planFile), p ?? ''));
  const file = (sha: Sha256Hex | null | undefined, ext: string, what: string, path: AbsPath): InputFile | null =>
    (sha === null || sha === undefined ? null : { path, bytes: kept(sha, ext, what) });
  const ledgerBytes = kept(base.rulings.ledgerSha256, RULINGS_INPUT, 'rulings ledger');
  const at = visionFile(plan);
  let corpus: InputFiles['corpus'] = null;
  if (plan.target === 'corpus') {
    const phase0 = file(base.phase0, PHASE0_INPUT, 'Phase-0 record', beside(plan.phase0));
    const record = phase0RecordOf(phase0?.bytes ?? null);
    const pin = file(base.corpus, CORPUS_INPUT, 'corpus pin', beside(plan.corpus));
    const guide = file(base.corpusGuide, CORPUS_GUIDE_INPUT, 'corpus guide', absPath(join(repo, CORPUS_GUIDE_PATH)));
    if (pin !== null && guide !== null && phase0 !== null) {
      corpus = { pin, guide, phase0, capture: record === null ? null : file(base.phase0Issues, ISSUES_INPUT, 'issue capture', beside(record.issueCapture.file)) };
    }
  }
  const files: InputFiles = {
    repo, planFile, plan, planBytes, specs, ledger: { path: ledger, bytes: ledgerBytes }, sidecars,
    obligations: file(base.obligations, OBLIGATIONS_INPUT, 'obligations', beside(plan.holistic?.obligations)),
    vision: at === null ? null : file(base.vision, VISION_INPUT, 'vision', absPath(join(at.base === 'plan' ? dirname(planFile) : repo, at.path))),
    corpus,
  };
  return missing.length > 0 ? { reasons: missing } : { files };
}

/**
 * The default base (an apply without `--base`, a start): the owner's files of the latest revision applied from them,
 * a start's or an `apply` command's. Its payload's `owner` names them when they differ from what it put in force (a
 * rebased or ruled revision); absent, its manifest is the owner's.
 */
export function ownerBase(runDir: AbsPath, view: JournalView, arc: ArcId): RevisionManifest {
  const commits = view.opsOf('revision.commit').filter((c) => view.doneOf(c.op) !== null).sort((a, b) => b.expect.rev - a.expect.rev);
  for (const c of commits) {
    const source = c.expect.source;
    const owners = source.type === 'start' || (source.type === 'command' && readCommand(runDir, source.command, arc).file.body.type === 'apply');
    if (!owners) continue;
    const payload = keptPayload(runDir, c.expect.payloadSha256);
    return payload.owner ?? payload.manifest;
  }
  throw new Error(`arc ${arc} has no revision from the owner's files (its first start records one)`);
}

/** The `owner` field a revision payload records: the owner's files, only when they differ from what it puts in force. */
export const ownerField = (owner: RevisionManifest, manifest: RevisionManifest): Readonly<{ owner?: RevisionManifest }> =>
  (canonicalJson(owner) === canonicalJson(manifest) ? {} : { owner });

/** Keeps the owner's files' bytes (the base of their next apply), each content-addressed; the manifest must name them all. */
export function keepOwnerFiles(runDir: AbsPath, files: InputFiles): void {
  const keep = (f: InputFile | null | undefined, ext: string): void => {
    if (f !== null && f !== undefined && f.bytes !== null) keepInput(runDir, f.bytes, ext);
  };
  keepInput(runDir, files.planBytes, PLAN_INPUT);
  for (const s of files.specs.values()) keep(s, SPEC_INPUT);
  keep(files.ledger, RULINGS_INPUT);
  for (const s of files.sidecars.values()) keepInput(runDir, s.bytes, RULING_INPUT);
  keep(files.obligations, OBLIGATIONS_INPUT);
  keep(files.vision, VISION_INPUT);
  if (files.corpus !== null) {
    keep(files.corpus.pin, CORPUS_INPUT);
    keep(files.corpus.guide, CORPUS_GUIDE_INPUT);
    keep(files.corpus.phase0, PHASE0_INPUT);
    keep(files.corpus.capture, ISSUES_INPUT);
  }
}

/**
 * At a rebased commit: the owner's files kept (`keepOwnerFiles`) and the payload's `owner` field (`ownerField`) against the
 * manifest it commits.
 */
export function keepOwner(runDir: AbsPath, owner: InputFiles, committed: RevisionManifest): Readonly<{ owner?: RevisionManifest }> {
  const manifest = revisionManifestOf(owner);
  if ('missing' in manifest) throw new Error(`the owner's files of a rebased commit are incomplete (the proposal refuses that first): ${manifest.missing.join('; ')}`);
  keepOwnerFiles(runDir, owner);
  return ownerField(manifest, committed);
}

