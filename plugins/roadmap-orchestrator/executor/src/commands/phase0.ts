// `roadmap phase0 check --repo <path> (--plan <file> | --from-ref <arc>)` (M4a, OR-Q16, K20): read-only, no host lock,
// deterministic. Exit 0 with no rows, else 78; JSON rows plus `sliceCandidates` (src/holistic/vision.ts, R15).
//
//   --plan      the files as a fresh start reads them: `runChecks`' pure rows (the `.roadmap/` layout, plan-invalid, the
//               revisioned inputs, routing, lanes), `holistic-needs-corpus` (H4: a holistic plan targets a corpus), then
//               the shared Phase-0 rows (src/phase0/rows.ts) in full: the closure rows 1-6, the forge, the chain as a
//               fresh start's and the tree.
//   --from-ref  every input by the digests the arc's verified `refs/roadmap/<arc>` recorded (the plan in force at its
//               high-water and its revision's manifest: pin, guide, Phase-0 record, issue capture, obligations, vision,
//               ledger), never the live files; the closure rows 1-6 only (re-derivation reads the source at the pin's
//               commit and the registry at the plan's baseline).
import { dirname } from 'node:path';
import { ArcRefError, readArcRef } from '../chain.ts';
import type { VisionClauseId } from '../core/ids.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { CliError, runDir, type Phase0Source } from '../input/cli.ts';
import {
  CORPUS_GUIDE_INPUT, CORPUS_INPUT, ISSUES_INPUT, OBLIGATIONS_INPUT, PHASE0_INPUT, RULINGS_INPUT, SPEC_INPUT, VISION_INPUT, readInputFiles,
} from '../input/inforce.ts';
import { holisticNeedsCorpus, FRESH_START, FROM_REF, type Phase0Input, phase0InputOf, phase0Rows, visionAndObligations } from '../phase0/rows.ts';
import { gitCommonDir, legacyRoadmapDir, loadPlan, planInvalidCheck, readRepoConfig, revisionInputRows, routingCheck, specLaneCheck } from '../preflight/checks.ts';
import type { StartupContext, StartupRejection } from '../preflight/startup.ts';
import { selectProfile } from '../routing/layers.ts';
import { parseRulings } from '../spec/rulings.ts';
import { sliceCandidates } from '../holistic/vision.ts';

export type Phase0CheckArgs = Readonly<{ repo: AbsPath; source: Phase0Source }>;
/** The rows found (empty: green) and the active world clauses whose census rules are not all held on the baseline (R15). */
export type Phase0CheckReport = Readonly<{ rows: readonly StartupRejection[]; sliceCandidates: readonly VisionClauseId[] }>;

export async function phase0Check(args: Phase0CheckArgs): Promise<Phase0CheckReport> {
  const { rows, input } = args.source.type === 'plan' ? await fromPlan(args.repo, absPath(args.source.plan)) : fromRef(args.repo, args.source);
  if (input === null) return { rows, sliceCandidates: [] };
  const { vision, obligations } = visionAndObligations(input);
  return { rows, sliceCandidates: vision === null ? [] : sliceCandidates(vision, obligations) };
}

type Checked = Readonly<{ rows: readonly StartupRejection[]; input: Phase0Input | null }>;

async function fromPlan(repo: AbsPath, planFile: AbsPath): Promise<Checked> {
  const plan = loadPlan(planFile);
  if ('kind' in plan) return { rows: [...legacyRoadmapDir(repo), plan], input: null };
  const files = readInputFiles(planFile, repo);
  const config = readRepoConfig(repo);
  let context: StartupContext;
  try {
    context = {
      repo, planFile, plan, specOf: (u) => files.specs.get(u.id)?.bytes ?? null, profile: selectProfile(null, config),
      // No host file is read here (the residue row is a start's): the plan's directory stands in for the host dir.
      runDir: runDir(gitCommonDir(repo), plan.arc), hostDir: absPath(dirname(planFile)),
    };
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return { rows: [{ kind: 'plan-invalid', problem: { type: 'schema', field: error.field, detail: error.message } }], input: null };
  }
  const input = [...legacyRoadmapDir(repo), ...(await planInvalidCheck.check(context)), ...revisionInputRows(files)];
  if (input.length > 0) return { rows: input, input: null };
  const p0 = phase0InputOf(files, config);
  return {
    rows: [
      ...holisticNeedsCorpus(plan), ...(await routingCheck.check(context)), ...(await specLaneCheck(process.env).check(context)),
      ...phase0Rows(p0, FRESH_START).rows,
    ],
    input: p0,
  };
}

function fromRef(repo: AbsPath, source: Extract<Phase0Source, { type: 'ref' }>): Checked {
  let ref: ReturnType<typeof readArcRef>;
  try {
    ref = readArcRef(repo, source.arc);
  } catch (error) {
    if (error instanceof ArcRefError) throw new CliError(`phase0 check: ${error.message}`);
    throw error;
  }
  if (ref === null) throw new CliError(`phase0 check: no refs/roadmap/${source.arc}; arc ${source.arc} has published no snapshot`);
  const m = ref.manifest;
  const kept = (sha: string | null | undefined, ext: string): Buffer | null => (sha === null || sha === undefined ? null : ref.input(sha as never, ext));
  const input: Phase0Input = {
    repo, plan: ref.plan, config: null, where: `refs/roadmap/${ref.arc} at ${ref.commit}`,
    pin: kept(m.corpus, CORPUS_INPUT), guide: kept(m.corpusGuide, CORPUS_GUIDE_INPUT), phase0: kept(m.phase0, PHASE0_INPUT),
    capture: kept(m.phase0Issues, ISSUES_INPUT), obligations: kept(m.obligations, OBLIGATIONS_INPUT), vision: kept(m.vision, VISION_INPUT),
    specs: new Map(ref.plan.units.map((u) => [u.id, kept(m.specs[u.id], SPEC_INPUT)])),
    ledger: parseRulings(ref.input(m.rulings.ledgerSha256, RULINGS_INPUT).toString('utf8'), `refs/roadmap/${ref.arc} (the rulings ledger)`),
  };
  return { rows: phase0Rows(input, FROM_REF).rows, input };
}
