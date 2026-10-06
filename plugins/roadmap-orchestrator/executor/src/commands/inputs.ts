// `roadmap inputs export --repo <repo> --arc <arc> --out <dir>` (M4a rev 3, I1, F17): a host act, read-only, no lock.
// Writes the arc's complete current input view from the run dir's kept inputs (`inForceFiles`, src/input/inforce.ts:
// the plan in force, every unit's spec at its current rev including the executor's and plan-check's post-plan
// patches, the rulings ledger and its sidecars, the obligations, the vision, and a corpus arc's pin, Phase-0 record and
// issue capture) into `--out`, which must not exist, plus `export.json {planRev, specRevs}`. The recovery it serves:
// export, edit, `apply --expect-rev <planRev>` (never copying a historical manifest by hand).
//
// Layout: a file beside the plan (start.json's plan file) keeps its path relative to the plan's directory; a file in
// the product repo (a corpus arc's vision record) goes under `repo/` at its repo path. The corpus guide is not exported:
// it is the one committed at the plan's baseline, which no apply edits.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { canonicalJson } from '../core/json.ts';
import { readJson } from '../core/fsx.ts';
import type { ArcId, PlanRev, SpecRev, UnitId } from '../core/ids.ts';
import { readJournal } from '../core/log.ts';
import { runStart } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { START_FILE } from '../executor.ts';
import { CliError, runDir } from '../input/cli.ts';
import { type InputFile, inForceFiles, parseUnitSpec, planInForce, revisionInForce } from '../input/inforce.ts';
import { gitCommonDir } from '../preflight/checks.ts';

export const EXPORT_FILE = 'export.json';
/** Where a product-repo file goes in the export. */
export const EXPORT_REPO_DIR = 'repo';
export type InputsExportArgs = Readonly<{ repo: AbsPath; arc: ArcId; out: AbsPath }>;
/** What `export.json` records: the plan revision the export is of and each unit's spec revision. */
export type InputsExport = Readonly<{ planRev: PlanRev; specRevs: Readonly<Record<UnitId, SpecRev>> }>;

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
  for (const s of files.sidecars.values()) write(s);
  for (const f of [files.obligations, files.vision]) if (f !== null) write(f);
  if (files.corpus !== null) {
    write(files.corpus.pin);
    write(files.corpus.phase0);
    if (files.corpus.capture !== null) write(files.corpus.capture);
  }
  const out: InputsExport = { planRev: inForce.rev, specRevs };
  writeFileSync(join(args.out, EXPORT_FILE), `${canonicalJson(out)}\n`, { flag: 'wx' });
  return out;
}
