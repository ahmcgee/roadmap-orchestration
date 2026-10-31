// Export the plan in force and its current spec bytes, with export.json recording revision and base manifest.
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,join,relative,sep } from 'node:path';
import { readJson } from '../core/fsx.ts';
import type { ArcId,PlanRev,SpecRev,UnitId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { readJournal } from '../core/log.ts';
import { type RevisionManifest,applyManifest,runStart } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { START_FILE } from '../executor.ts';
import { CliError,runDir } from '../input/cli.ts';
import { type InputFile,inForceFiles,parseUnitSpec,planInForce,revisionInForce,revisionManifestOf } from '../input/inforce.ts';
import { gitCommonDir } from '../preflight/checks.ts';

export const EXPORT_FILE = 'export.json';
/** Where a product-repo file goes in the export. */
export const EXPORT_REPO_DIR = 'repo';
export type InputsExportArgs = Readonly<{ repo: AbsPath; arc: ArcId; out: AbsPath }>;
/**
 * What `export.json` records: the plan revision the export is of, each unit's spec revision, and the manifest of the
 * exported files, the base an `apply --base` of an edit of them rebases from.
 */
export type InputsExport = Readonly<{ planRev: PlanRev; specRevs: Readonly<Record<UnitId, SpecRev>>; base: RevisionManifest }>;

/** Read an export's revision and manifest before accepting an edit of it. */
export function readExport(dir: AbsPath, rev: number): InputsExport {
  const path = join(dir, EXPORT_FILE);
  if (!existsSync(path)) throw new CliError(`apply --from: no export at ${path}`);
  const value = JSON.parse(readFileSync(path, 'utf8')) as InputsExport;
  if (value.planRev !== rev) throw new CliError(`apply --rev ${rev}: export is of rev ${value.planRev}`);
  return { ...value, base: applyManifest(value.base, `${path}.base`) };
}

export async function exportInputs(args: InputsExportArgs): Promise<InputsExport> {
  if (existsSync(args.out)) throw new CliError(`inputs export: ${args.out} exists; name a directory that does not`);
  const dir = runDir(gitCommonDir(args.repo), args.arc);
  const startPath = join(dir, START_FILE);
  if (!existsSync(startPath)) throw new CliError(`inputs export: arc ${args.arc} has never started (no ${startPath})`);
  const start = runStart(readJson(startPath), startPath);
  const { view } = readJournal(dir, args.arc);
  const inForce = planInForce(dir, view);
  if (inForce === null) throw new CliError(`inputs export: arc ${args.arc} records no plan in force`);
  const files = inForceFiles(dir, view, inForce, revisionInForce(dir, inForce), start.planFile, start.repo);

  const planDir = dirname(start.planFile);
  const target = (path: AbsPath): string => {
    const beside = relative(planDir, path);
    if (beside !== '' && !beside.startsWith(`..${sep}`)) return join(args.out, beside);
    const inRepo = relative(start.repo, path);
    if (inRepo !== '' && !inRepo.startsWith(`..${sep}`)) return join(args.out, EXPORT_REPO_DIR, inRepo);
    throw new Error(`inputs export: ${path} is neither beside the plan (${planDir}) nor in the repo (${start.repo})`);
  };
  const write = (f: InputFile): void => {
    if (f.bytes === null) throw new Error(`inputs export: the input ${f.path} in force has no kept bytes`);
    const to = target(f.path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, f.bytes, { flag: 'wx' });
  };

  mkdirSync(args.out, { recursive: true });
  write({ path: start.planFile, bytes: files.planBytes });
  const specRevs: Record<UnitId, SpecRev> = {};
  for (const [unit, f] of files.specs) {
    write(f);
    specRevs[unit] = parseUnitSpec(f.bytes!, f.path, unit).rev;
  }
  write(files.ledger);
  for (const f of [files.obligations, files.vision]) if (f !== null) write(f);
  if (files.corpus !== null) {
    write(files.corpus.pin);
    write(files.corpus.phase0);
  }
  const base = revisionManifestOf(files);
  if ('missing' in base) throw new Error(`inputs export: the inputs in force are incomplete: ${base.missing.join('; ')}`);
  const out: InputsExport = { planRev: inForce.rev, specRevs, base };
  writeFileSync(join(args.out, EXPORT_FILE), `${canonicalJson(out)}\n`, { flag: 'wx' });
  return out;
}
