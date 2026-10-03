// A corpus arc over unit-common's repo (M4a step C2): the unit u1 that adds `mul`, driven by the unit driver with fake
// backends, in an arc whose target is a pinned corpus. The baseline commit adds the sample corpus (test/helpers/
// corpus.ts) under `docs/corpus` with its guide and `.roadmap/vision.json` (confirmed against the vision doc); the plan
// dir holds the pin (`roadmap corpus pin` at the baseline), an issue capture of an empty forge, the Phase-0 record and
// rule-anchored obligations: I-1 at T-1, must-hold, witnessed by a jsonl lane that passes `t1` on every tree, so a
// candidate is green. Everything a child needs is the `ArcDescriptor`; `contextFor` records revision 1 with the corpus
// files kept (stage-common `recordFirstPlan`).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureIssues } from '../../src/commands/issues.ts';
import { corpusPin } from '../../src/commands/corpus.ts';
import { sha } from '../../src/core/ids.ts';
import { sha256Hex } from '../../src/core/json.ts';
import { absPath } from '../../src/core/values.ts';
import type { CorpusPin } from '../../src/corpus/types.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { CAPTURE_FILE, PHASE0_FILE, PIN_FILE, VISION_DOC, visionRecord, withForge, writePhase0 } from '../helpers/corpusarc.ts';
import { DEFAULT_CORPUS_ROOT, sampleCorpus } from '../helpers/corpus.ts';
import { makeForge } from '../helpers/forge.ts';
import { type FileSet, commitAll, writeFiles } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import { witnessLaneArgv, writeWitnessControl } from '../helpers/witness.ts';
import { editPlan, planDirOf } from './route-common.ts';
import { type ArcDescriptor, setupArc } from './unit-common.ts';

export type CorpusUnitArc = Readonly<{ d: ArcDescriptor; planDir: string; pin: CorpusPin; pinSha256: string; baseline: string }>;

export const VISION_PATH = `${DEFAULT_CORPUS_ROOT}/${VISION_DOC}`;

export type CorpusUnitOptions = Readonly<{
  /** Extra files of the baseline commit (a published `.roadmap/debt.md`). */
  baseline?: FileSet;
  /** Fields over the minimal Phase-0 record (its debt dispositions). */
  phase0?: Readonly<Record<string, unknown>>;
}>;

/** The corpus arc over u1 with `steps` scripted; nothing recorded yet (`contextFor` records revision 1). */
export async function setupCorpusArc(steps: readonly Step[], opts: CorpusUnitOptions = {}): Promise<CorpusUnitArc> {
  const d = setupArc({ steps });
  const planDir = planDirOf(d);
  const corpus = sampleCorpus();
  writeFiles(d.repo, { ...corpus.files, '.roadmap/vision.json': `${JSON.stringify(visionRecord(corpus.files[VISION_PATH]!), null, 2)}\n`, ...opts.baseline });
  const baseline = commitAll(d.repo, 'the corpus');

  const pinned = await corpusPin({ repo: absPath(d.repo), commit: baseline, baseline: sha(baseline), out: absPath(join(planDir, PIN_FILE)) });
  assert.equal(pinned.kind, 'pinned', JSON.stringify(pinned));
  if (pinned.kind !== 'pinned') throw new Error('unreachable');
  const captured = await withForge(makeForge(), () => captureIssues({ repo: absPath(d.repo), out: absPath(join(planDir, CAPTURE_FILE)) }));
  assert.equal(captured.kind, 'captured');
  if (captured.kind !== 'captured') throw new Error('unreachable');

  const control = join(planDir, 'witness-control.json');
  writeWitnessControl(control, { trees: { '*': { outcomes: { t1: 'pass' } } } });
  const journey = {
    id: 'journey', argv: witnessLaneArgv('jsonl', planDir, control), cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast',
    resources: [], evidenceGlobs: [], reporter: 'jsonl',
  };
  const laneRev = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [journey], obligations: [], mapping: { paths: [] } }).lanes[0]!);
  const t1 = pinned.pin.rules.find((r) => r.id === 'T-1');
  assert.ok(t1 !== undefined);
  const witness = { lane: 'journey', testIds: ['t1'] };
  writeFileSync(join(planDir, 'obligations.json'), JSON.stringify({
    schema: 'roadmap/obligations-m3', cutLine: 'mul ships', lanes: [journey],
    obligations: [{
      id: 'I-1', rev: 1, statement: 'A berth is never double-booked.', rule: { id: 'T-1', textSha256: t1.textSha256 }, serves: ['V-1'], witness,
      proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev, witness }, deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' },
    }],
    mapping: { paths: [] },
    census: pinned.pin.rules.map((r) => ({ rule: r.id, state: r.id === 'T-1' ? { type: 'obligation', id: 'I-1' } : { type: 'out-of-slice' } })),
  }));
  writePhase0(planDir, { issueCapture: { file: CAPTURE_FILE, sha256: captured.sha256 }, intake: [], ...opts.phase0 });
  editPlan(d, (p) => {
    delete p['architectureDoc'];
    p['baseline'] = baseline;
    p['corpus'] = PIN_FILE;
    p['phase0'] = PHASE0_FILE;
    p['holistic'] = { advances: ['V-1'], obligations: 'obligations.json' };
  });
  return { d, planDir, pin: pinned.pin, pinSha256: sha256Hex(readFileSync(join(planDir, PIN_FILE))), baseline };
}
