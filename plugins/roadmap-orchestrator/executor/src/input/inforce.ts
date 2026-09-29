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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { PlanAppliedFact, PlanChange } from '../core/events.ts';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import { type CommandId, type PlanRev, type Sha256Hex, type UnitId, planRev } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import type { PlanManifest, SpecM1 } from '../core/records.ts';
import { specBytesFromLiveFile } from '../core/upgrade.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { bytesSha256, parseSpec } from '../spec/spec.ts';
import { type PlanM1, type PlanUnit, parsePlan } from './plan.ts';

export const PLAN_INPUT = 'plan.json';
export const SPEC_INPUT = 'spec.json';

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

/** plan.json and the spec.json of each of its units, read from disk: what an apply or a start would put in force. */
export type InputFiles = Readonly<{
  plan: PlanM1;
  planBytes: Buffer;
  /** Per unit of `plan`: the spec file's path and bytes, or null when the file does not exist. */
  specs: ReadonlyMap<UnitId, Readonly<{ path: AbsPath; bytes: Buffer | null }>>;
}>;

export const specFilePath = (planFile: AbsPath, unit: PlanUnit): AbsPath => absPath(join(dirname(planFile), unit.spec));

/** Reads the plan (parsed: throws SchemaError or SyntaxError) and the bytes of every unit's spec file. */
export function readInputFiles(planFile: AbsPath): InputFiles {
  const planBytes = readFileSync(planFile);
  const plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  const specs = new Map(plan.units.map((u) => {
    const path = specFilePath(planFile, u);
    return [u.id, { path, bytes: existsSync(path) ? readFileSync(path) : null }] as const;
  }));
  return { plan, planBytes, specs };
}

/** The manifest of the files, or the units whose spec file is missing. */
export function manifestOf(files: InputFiles): PlanManifest | Readonly<{ missing: readonly UnitId[] }> {
  const specs: Record<UnitId, Sha256Hex> = {};
  const missing: UnitId[] = [];
  for (const [unit, s] of files.specs) {
    if (s.bytes === null) missing.push(unit);
    else specs[unit] = bytesSha256(s.bytes);
  }
  return missing.length > 0 ? { missing } : { planSha256: bytesSha256(files.planBytes), specs };
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
 * Puts `files` in force as the next plan revision: their bytes kept, then the `plan-applied` fact (the
 * postcondition, last). `command`: the apply, or null for a start.
 */
export function recordPlan(journal: Journal, runDir: AbsPath, files: InputFiles, command: CommandId | null, changes: readonly PlanChange[]): PlanAppliedFact {
  const manifest = keepInputFiles(runDir, files);
  crashPoint('plan.apply.after-inputs');
  const fact: PlanAppliedFact = { kind: 'plan-applied', rev: planRev((journal.view.planApplied()?.rev ?? 0) + 1), command, ...manifest, changes };
  journal.fact(fact);
  return fact;
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
