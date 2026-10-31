// File-level compare-and-swap. Untouched files take the bytes in force; edited files must still match their exported base.
import { dirname,join } from 'node:path';
import type { Sha256Hex,UnitId } from '../core/ids.ts';
import type { RevisionManifest } from '../core/records.ts';
import { type AbsPath,absPath } from '../core/values.ts';
import { CORPUS_GUIDE_PATH } from '../corpus/guide.ts';
import {
CORPUS_GUIDE_INPUT,CORPUS_INPUT,type InputFile,type InputFiles,OBLIGATIONS_INPUT,PHASE0_INPUT,PLAN_INPUT,
RULINGS_INPUT,
SPEC_INPUT,VISION_INPUT,
keptInput,
ledgerPath,
specFilePath
} from './inforce.ts';
import { parsePlan,visionFile } from './plan.ts';

export function baseFiles(runDir: AbsPath, base: RevisionManifest, planFile: AbsPath, repo: AbsPath): Readonly<{ files: InputFiles }> | Readonly<{ reasons: readonly string[] }> {
  const missing: string[] = [];
  const kept = (sha: Sha256Hex, ext: string, what: string): Buffer | null => {
    const bytes = keptInput(runDir, sha, ext);
    if (bytes === null) missing.push(`the base's ${what} ${sha} is not kept in the run dir: \`roadmap inputs export\` the arc, edit the export, and apply with --from <dir> --rev N --reason "<line>"`);
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
  const beside = (p: string | undefined): AbsPath => absPath(join(dirname(planFile), p ?? ''));
  const file = (sha: Sha256Hex | null | undefined, ext: string, what: string, path: AbsPath): InputFile | null =>
    (sha === null || sha === undefined ? null : { path, bytes: kept(sha, ext, what) });
  const ledgerBytes = kept(base.rulings.ledgerSha256, RULINGS_INPUT, 'rulings ledger');
  const at = visionFile(plan);
  let corpus: InputFiles['corpus'] = null;
  if (plan.target === 'corpus') {
    const phase0 = file(base.phase0, PHASE0_INPUT, 'Phase-0 record', beside(plan.phase0));
    const pin = file(base.corpus, CORPUS_INPUT, 'corpus pin', beside(plan.corpus));
    const guide = file(base.corpusGuide, CORPUS_GUIDE_INPUT, 'corpus guide', absPath(join(repo, CORPUS_GUIDE_PATH)));
    if (pin !== null && guide !== null && phase0 !== null) corpus = { pin, guide, phase0 };
  }
  const files: InputFiles = {
    repo, planFile, plan, planBytes, specs, ledger: { path: ledger, bytes: ledgerBytes }, 
    obligations: file(base.obligations, OBLIGATIONS_INPUT, 'obligations', beside(plan.holistic?.obligations)),
    vision: at === null ? null : file(base.vision, VISION_INPUT, 'vision', absPath(join(at.base === 'plan' ? dirname(planFile) : repo, at.path))),
    corpus,
  };
  return missing.length > 0 ? { reasons: missing } : { files };
}


const bytesOf = (f: InputFile | null | undefined): Buffer | null => f?.bytes ?? null;
const sameBytes = (a: Buffer | null, b: Buffer | null): boolean => a === null || b === null ? a === b : a.equals(b);
export function compareAndSwap(base: InputFiles, edited: InputFiles, current: InputFiles): { next: InputFiles } | { reasons: readonly string[] } {
  const reasons: string[] = [];
  const choose = (label: string, before: Buffer | null, ours: Buffer | null, now: Buffer | null): Buffer | null => {
    if (sameBytes(before, ours)) return now;
    if (!sameBytes(before, now)) reasons.push(`stale: ${label} changed in force since the exported revision; export again and reapply the edit`);
    return ours;
  };
  const planBytes = choose(edited.planFile, base.planBytes, edited.planBytes, current.planBytes)!;
  const plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  const selected = new Map<UnitId, Buffer | null>();
  for (const id of new Set([...base.specs.keys(), ...edited.specs.keys(), ...current.specs.keys()])) {
    const b = bytesOf(base.specs.get(id));
    const e = bytesOf(edited.specs.get(id));
    const c = bytesOf(current.specs.get(id));
    const path = edited.specs.get(id)?.path ?? base.specs.get(id)?.path ?? current.specs.get(id)!.path;
    let bytes = choose(path, b, e, c);
    if (!sameBytes(b, e) && bytes !== null && c !== null) {
      const raw = JSON.parse(bytes.toString('utf8')) as {rev: number};
      raw.rev = (JSON.parse(c.toString('utf8')) as {rev: number}).rev + 1;
      bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
    }
    selected.set(id, bytes);
  }
  const specs = new Map(plan.units.map((u) => [u.id, {path: specFilePath(edited.planFile, u), bytes: selected.get(u.id) ?? null}] as const));
  const file = (b: InputFile | null, e: InputFile | null, c: InputFile | null): InputFile | null => {
    const bytes = choose(e?.path ?? b?.path ?? c?.path ?? 'removed input', bytesOf(b), bytesOf(e), bytesOf(c));
    const at = e ?? c;
    return at === null ? null : { path: at.path, bytes };
  };
  const ledger = file(base.ledger, edited.ledger, current.ledger)!;
  const obligations = file(base.obligations, edited.obligations, current.obligations);
  const vision = file(base.vision, edited.vision, current.vision);
  const corpus = plan.target !== 'corpus' ? null : {
    pin: file(base.corpus?.pin ?? null, edited.corpus?.pin ?? null, current.corpus?.pin ?? null)!,
    guide: file(base.corpus?.guide ?? null, edited.corpus?.guide ?? null, current.corpus?.guide ?? null)!,
    phase0: file(base.corpus?.phase0 ?? null, edited.corpus?.phase0 ?? null, current.corpus?.phase0 ?? null)!,
  };
  if (reasons.length > 0) return { reasons };
  return { next: { ...edited, plan, planBytes, specs, ledger, obligations, vision, corpus } };
}
