// A laid-out holistic arc moved onto a corpus target (M4a step D0, R17: a fresh holistic arc targets a corpus), for the
// whole-arc fixtures that run the real supervised `roadmap start` (pm-holistic.ts, cm-holistic.ts). The baseline commit
// adds the sample corpus (test/helpers/corpus.ts) with its guide and `.roadmap/vision.json` (brake-common's VISION,
// confirmed against the vision document); the plan dir gains the pin (`roadmap corpus pin` at that baseline), the issue
// capture of an empty trusted fake forge whose `gh` goes into the arc's bin dir (first on PATH for every CLI child,
// the executor's checkpoints included) and the Phase-0 record. The obligations are anchored by number (I-n at T-n,
// with the pinned text hash), and the census holds every pinned rule: as its obligation, else out of slice. The plan
// drops `architectureDoc` and names the pin, the record and `holistic` without a vision. The pin and the capture run
// through the CLI as children, so a scenario's synchronous `prepare` can call this.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../src/core/json.ts';
import { type CorpusPin, parseCorpusPin } from '../../src/corpus/types.ts';
import { DEFAULT_CORPUS_ROOT, sampleCorpus } from '../helpers/corpus.ts';
import { CAPTURE_FILE, PHASE0_FILE, PIN_FILE, VISION_DOC, writePhase0 } from '../helpers/corpusarc.ts';
import { makeForge } from '../helpers/forge.ts';
import { fixture } from '../helpers/proc.ts';
import { commitAll, tmpDir, writeFiles } from '../helpers/repo.ts';
import { writeGhShim } from '../fakes/shim.ts';
import { VISION } from './brake-common.ts';
import type { ArcDescriptor } from './unit-common.ts';

type Json = Record<string, unknown>;

export type CorpusTargetOptions = Readonly<{
  /** The obligations file as brake-common's `obligationsJson` builds it (docRef anchors, replaced here). */
  obligations: Json;
  advances: readonly string[];
  /** `holistic.audit`. */
  audit?: Json;
  /** Plan fields added verbatim (capacity). */
  planExtra?: Json;
}>;

/** One `roadmap` host act as a child (exec-cli, the arc's bin dir first on PATH); its stdout JSON. */
function act(d: ArcDescriptor, argv: readonly string[]): Json {
  const r = spawnSync(process.execPath, [fixture('exec-cli.ts'), tmpDir('corpus-target-host'), ...argv], {
    env: { ...process.env, PATH: `${d.binDir}:${process.env['PATH'] ?? ''}` }, encoding: 'utf8', timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`roadmap ${argv.join(' ')} exited ${r.status}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout) as Json;
}

/** `obligations` anchored at the pin's rules by number (I-n at T-n), with the census over every pinned rule. */
function anchored(obligations: Json, pin: CorpusPin): Json {
  const list = obligations['obligations'] as readonly Json[];
  const ruleOf = (id: string): string => `T-${id.slice('I-'.length)}`;
  const byRule = new Map<string, string>();
  const anchoredList = list.map(({ docRef: _d, ...o }): Json => {
    const id = String(o['id']);
    const rule = pin.rules.find((r) => r.id === ruleOf(id));
    if (rule === undefined) throw new Error(`the sample corpus pins no ${ruleOf(id)} for ${id}`);
    byRule.set(rule.id, id);
    return { ...o, rule: { id: rule.id, textSha256: rule.textSha256 } };
  });
  const census = pin.rules.map((r) => ({ rule: r.id, state: byRule.has(r.id) ? { type: 'obligation', id: byRule.get(r.id) } : { type: 'out-of-slice' } }));
  return { ...obligations, obligations: anchoredList, census };
}

/** Moves the laid-out arc `d` onto a corpus target (see the header); returns the new baseline commit. */
export function corpusTarget(d: ArcDescriptor, opts: CorpusTargetOptions): string {
  const planDir = join(d.planPath, '..');
  const corpus = sampleCorpus();
  const visionText = corpus.files[`${DEFAULT_CORPUS_ROOT}/${VISION_DOC}`]!;
  const vision = { ...VISION, confirmation: { ref: `corpus:${VISION_DOC}#sha256:${sha256Hex(visionText)}`, at: '2026-10-03T00:00:00.000Z' } };
  writeFiles(d.repo, { ...corpus.files, '.roadmap/vision.json': `${JSON.stringify(vision, null, 2)}\n` });
  const baseline = commitAll(d.repo, 'the corpus');

  const forge = makeForge();
  writeGhShim(d.binDir, forge.storePath);
  act(d, ['corpus', 'pin', '--repo', d.repo, '--commit', baseline, '--baseline', baseline, '--out', join(planDir, PIN_FILE)]);
  const pin = parseCorpusPin(JSON.parse(readFileSync(join(planDir, PIN_FILE), 'utf8')));
  const captured = act(d, ['issues', '--repo', d.repo, '--out', join(planDir, CAPTURE_FILE)]);

  writeFileSync(join(planDir, 'obligations.json'), JSON.stringify(anchored(opts.obligations, pin)));
  writePhase0(planDir, {
    issueCapture: { file: CAPTURE_FILE, sha256: captured['sha256'] }, intake: [], slice: { advances: [...opts.advances], why: 'the first slice' },
  });
  const { architectureDoc: _a, ...plan } = JSON.parse(readFileSync(d.planPath, 'utf8')) as Json;
  writeFileSync(d.planPath, JSON.stringify({
    ...plan, ...opts.planExtra, baseline, corpus: PIN_FILE, phase0: PHASE0_FILE,
    holistic: { advances: [...opts.advances], obligations: 'obligations.json', ...(opts.audit === undefined ? {} : { audit: opts.audit }) },
  }));
  return baseline;
}
