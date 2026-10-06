// M4a step C1: the corpus arc's revisions and starts. The classifier's corpus and Phase-0 edit classes, the target kind
// and the chain fixed, the shared Phase-0 rows on every apply (re-derivation, census, rules resolved, the vision
// confirmed, the tree), and a start's rows (`runChecks`): the vision, the tree, the issue policy, the kept corpus inputs.
// Real repos, real pins (`roadmap corpus pin`), real issue captures against the fake forge.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type ApplyVerdict, evaluateApply, evaluateRevision } from '../src/commands/apply.ts';
import { corpusPin } from '../src/commands/corpus.ts';
import { phase0Check } from '../src/commands/phase0.ts';
import { commandId, jobId, sha, visionClauseId } from '../src/core/ids.ts';
import { canonicalJson, sha256Hex } from '../src/core/json.ts';
import { EVENTS_FILE, type OpenJournal, openJournal } from '../src/core/log.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { claimHost, releaseHost } from '../src/host/lock.ts';
import { registryOf } from '../src/corpus/registry.ts';
import { parseCorpusPin } from '../src/corpus/types.ts';
import { INVARIANTS_DOC, parseRulesRegistryBlock } from '../src/docs/invariants.ts';
import { classify, changesScope } from '../src/input/classify.ts';
import { CORPUS_FILE_INPUT, keptInput, planInForce, readInputFiles, recordPlan, revisionInForce } from '../src/input/inforce.ts';
import { type StartChecks, type StartInput, runChecks } from '../src/preflight/checks.ts';
import type { StartupRejection } from '../src/preflight/startup.ts';
import { UNTRUSTED_POLICY } from './helpers/forge.ts';
import {
  type CorpusArc, PIN_FILE, corpusArc, editJsonFile, editPhase0, editPlan, filesOf, inForce, newHostDir, readJsonFile, runDirOfArc, visionRecord, withForge,
} from './helpers/corpusarc.ts';
import { commitAll, makeRepo, revParse, tmpDir, writeFiles } from './helpers/repo.ts';

const T = { timeout: 120_000 };
type Json = Record<string, unknown>;
const BASE = { profile: 'default', config: null } as const;
const VISION_PATH = 'docs/corpus/0005_Vision.md';

// ---------------------------------------------------------------------------------------------------
// Helpers

/** A green corpus arc in force as revision 1; the journal open. */
async function arcInForce(): Promise<Readonly<{ a: CorpusArc; j: OpenJournal }>> {
  const a = await corpusArc();
  return { a, j: inForce(a) };
}

const baselineOf = (a: CorpusArc): string => String(readJsonFile(a.planPath)['baseline']);

/** Edits a committed corpus file of the main checkout and commits it; returns the commit. */
function commitCorpus(a: CorpusArc, file: string, edit: (text: string) => string): string {
  const path = join(a.repo, 'docs/corpus', file);
  writeFileSync(path, edit(readFileSync(path, 'utf8')));
  return commitAll(a.repo, `edit ${file}`);
}

/** Re-pins at `commit` against the plan's baseline (guide and registry stay there, LR-A1-1); returns the pin's sha256. */
async function repin(a: CorpusArc, commit: string): Promise<string> {
  const out = await corpusPin({ repo: a.repo, commit, baseline: sha(baselineOf(a)), out: absPath(join(a.planDir, PIN_FILE)) });
  assert.equal(out.kind, 'pinned', JSON.stringify(out));
  return sha256Hex(readFileSync(join(a.planDir, PIN_FILE)));
}

function apply(a: CorpusArc, j: OpenJournal): Promise<ApplyVerdict> {
  return evaluateApply({
    runDir: runDirOfArc(a), view: j.view, hostDir: newHostDir(), repo: a.repo, planFile: a.planPath, routingBase: BASE,
    laneEnv: process.env, manifest: null, expectRev: null, rulings: [],
  });
}

function accepted(v: ApplyVerdict): Extract<ApplyVerdict, { kind: 'accepted' }> {
  assert.equal(v.kind, 'accepted', JSON.stringify(v));
  return v as Extract<ApplyVerdict, { kind: 'accepted' }>;
}
function rejected(v: ApplyVerdict): readonly string[] {
  assert.equal(v.kind, 'rejected', JSON.stringify(v));
  return (v as Extract<ApplyVerdict, { kind: 'rejected' }>).reasons;
}

/** The plan in force's pinned rule text hash of `rule`, from the pin file in the plan dir. */
const pinnedHash = (a: CorpusArc, rule: string): string =>
  ((readJsonFile(join(a.planDir, PIN_FILE))['rules'] as Json[]).find((r) => r['id'] === rule)!['textSha256']) as string;

function startInput(repo: AbsPath, planFile: AbsPath, hostDir: AbsPath): StartInput {
  return {
    repo, planFile, profile: null, hostDir, env: process.env, respawn: null,
    claim: (ctx) => claimHost(ctx.hostDir, { arc: ctx.plan.arc, runDir: ctx.runDir, repo: ctx.repo, supervisor: selfIdentity() }, async () => assert.fail('no previous arc')),
  };
}

/** `runChecks` with the arc's forge on PATH; the claim released and the journal closed after. */
async function start(a: CorpusArc, planFile: AbsPath = a.planPath, after: (c: Extract<StartChecks, { kind: 'passed' }>) => void = () => undefined): Promise<StartChecks> {
  const hostDir = newHostDir();
  const out = await withForge(a.forge, () => runChecks(startInput(a.repo, planFile, hostDir)));
  if (out.kind === 'passed') {
    try {
      after(out);
    } finally {
      out.journal.close();
      releaseHost(hostDir, out.claim);
    }
  } else {
    out.journal?.close();
    if (out.claim !== null) releaseHost(hostDir, out.claim);
  }
  return out;
}

function refusedRows(out: StartChecks): readonly StartupRejection[] {
  assert.equal(out.kind, 'refused', JSON.stringify(out.kind === 'passed' ? 'passed' : out));
  return (out as Extract<StartChecks, { kind: 'refused' }>).rejections;
}

// ---------------------------------------------------------------------------------------------------

describe('re-pin (the corpus edit class)', () => {
  it('classify.corpus-repin-reword: a rewording of T-2 (same id) re-pins as {corpus}, an arc-wide change', T, async () => {
    const { a, j } = await arcInForce();
    try {
      const commit = commitCorpus(a, '0020_Berths.md', (t) => t.replace('A booking names one berth and one tide window.', 'A booking names exactly one berth and one tide window.'));
      const pinSha = await repin(a, commit);
      const guideSha = sha256Hex(readFileSync(join(a.repo, '.roadmap/corpus.md')));
      const v = accepted(await apply(a, j));
      const pin = readJsonFile(join(a.planDir, PIN_FILE));
      assert.equal(pin['guideSha256'], guideSha);
      assert.deepEqual(v.evaluated.draft.changes, [{ type: 'corpus', pinSha256: pinSha, guideSha256: guideSha }]);
      assert.deepEqual(v.corpusFiles.map((f) => f.path).sort(), (pin['files'] as Json[]).map((f) => f['path']).sort());
      const cur = planInForce(runDirOfArc(a), j.view)!.plan;
      assert.deepEqual(changesScope(v.evaluated.draft.changes, cur, filesOf(a).plan), { type: 'arc' });
    } finally {
      j.close();
    }
  });

  it('apply.repin-renders-registry: a re-pin\'s docs publication renders invariants.md with the new pin\'s rules registry (M4a C2, R3)', T, async () => {
    const { a, j } = await arcInForce();
    try {
      const commit = commitCorpus(a, '0020_Berths.md', (t) => t.replace('A booking names one berth and one tide window.', 'A booking names exactly one berth and one tide window.'));
      await repin(a, commit);
      const v = accepted(await apply(a, j));
      const renders = new Map(v.evaluated.renders.map((r) => [r.path as string, r.bytes.toString('utf8')]));
      assert.deepEqual([...renders.keys()], [INVARIANTS_DOC]);
      const pin = parseCorpusPin(readJsonFile(join(a.planDir, PIN_FILE)));
      assert.deepEqual(parseRulesRegistryBlock(renders.get(INVARIANTS_DOC)!), registryOf(pin));
      assert.ok(v.evaluated.draft.publication !== null, 'a re-pin publishes');
    } finally {
      j.close();
    }
  });

  it('classify.corpus-repin-rule-unresolved: rewording T-1 refuses until I-1\'s rule hash is refreshed (an edit, R5)', T, async () => {
    const { a, j } = await arcInForce();
    try {
      const commit = commitCorpus(a, '0010_Overview.md', (t) => t.replace('A berth is never double-booked.', 'A berth is never booked twice for one tide.'));
      const pinSha = await repin(a, commit);
      const reasons = rejected(await apply(a, j));
      assert.ok(reasons.includes(canonicalJson({ kind: 'phase0-invalid', problems: [{ type: 'obligation-rule-unresolved', obligation: 'I-1' }] })), JSON.stringify(reasons));
      editJsonFile(join(a.planDir, 'obligations.json'), (o) => ({
        ...o, obligations: (o['obligations'] as Json[]).map((ob) => (ob['id'] === 'I-1' ? { ...ob, rule: { id: 'T-1', textSha256: pinnedHash(a, 'T-1') } } : ob)),
      }));
      const v = accepted(await apply(a, j));
      const changes = v.evaluated.draft.changes;
      assert.ok(changes.some((c) => c.type === 'obligation' && c.id === 'I-1' && c.edit === 'edited'), JSON.stringify(changes));
      assert.ok(changes.some((c) => c.type === 'corpus' && c.pinSha256 === pinSha), JSON.stringify(changes));
      assert.equal(v.evaluated.draft.dispositions.length, 0, 'no weakening, no ruling');
    } finally {
      j.close();
    }
  });

  it('classify.corpus-repin-census-incomplete: a new rule T-4 with no census entry is refused', T, async () => {
    const { a, j } = await arcInForce();
    try {
      const commit = commitCorpus(a, '0020_Berths.md', (t) => t.replace('T-3: A cancelled booking frees its berth at once.', 'T-3: A cancelled booking frees its berth at once.\nT-4: A tide window is two hours long.'));
      await repin(a, commit);
      const reasons = rejected(await apply(a, j));
      assert.ok(reasons.includes(canonicalJson({ kind: 'phase0-invalid', problems: [{ type: 'census-incomplete', rules: ['T-4'] }] })), JSON.stringify(reasons));
    } finally {
      j.close();
    }
  });

  /**
   * The skill's immediate-apply path for an owner's answer (paid M4a run 5): P-1 bears in-slice T-1 (anchoring must-hold
   * I-1) and is answered mid-arc with a change of meaning. One apply carries the corpus commit's re-pin (T-1 retired for
   * T-4), the record (P-1 answered), the census and I-1 re-anchored; `ruled` lands C-2 naming I-1 amended first (as
   * `roadmap rule` does, in force before the apply).
   */
  async function ownerAnswer(ruled: boolean): Promise<ApplyVerdict> {
    const a = await corpusArc();
    editPhase0(a, (r) => ({
      ...r, questions: [{ id: 'P-1', rank: 1, text: 'Is a double booking ever allowed?', files: ['docs/corpus/0010_Overview.md'], bears: ['T-1'], assumption: 'never', state: { type: 'open' } }],
    }));
    if (ruled) {
      const ledger = join(a.planDir, 'rulings.md');
      writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}C-2 — The owner answered P-1: I-1 follows T-4.\n`);
      mkdirSync(`${ledger}.d`, { recursive: true });
      writeFileSync(join(`${ledger}.d`, 'C-2.json'), JSON.stringify({
        schema: 'roadmap/ruling-m3', id: 'C-2', statement: 'The owner answered P-1: I-1 follows T-4.', kind: 'disposition', ruledBy: { type: 'architect' }, trigger: 'owner answer',
        supersedes: [], condition: null, docRefs: [{ path: 'docs/corpus/0010_Overview.md', anchor: 'Scope', quotedText: 'berth', relation: 'consistent' }], contractRefs: [], contractOps: [], obligations: ['I-1'], obligationDispositions: [{ id: 'I-1', disposition: 'amended' }],
        cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
        consistency: { verdict: 'consistent', judgedRevs: { head: 'b'.repeat(40), ledgerSha256: 'a'.repeat(64), obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } },
      }));
    }
    const j = inForce(a);
    try {
      const commit = commitCorpus(a, '0010_Overview.md', (t) => t.replace('T-1: A berth is never double-booked.', 'T-4: A berth is never booked twice for one tide window.'));
      await repin(a, commit);
      assert.deepEqual(parseCorpusPin(readJsonFile(join(a.planDir, PIN_FILE))).rules.map((r) => r.id), ['T-2', 'T-3', 'T-4']);
      editPhase0(a, (r) => ({
        ...r, questions: (r['questions'] as Json[]).map((q) => ({ ...q, state: { type: 'answered', answer: 'Never, per tide window.', at: '2026-10-04T05:00:00.000Z' } })),
      }));
      editJsonFile(join(a.planDir, 'obligations.json'), (o) => ({
        ...o,
        obligations: (o['obligations'] as Json[]).map((ob) => ({
          ...ob, rev: 2, statement: 'A berth is never booked twice for one tide window.', rule: { id: 'T-4', textSha256: pinnedHash(a, 'T-4') },
          proofJudgment: { ...(ob['proofJudgment'] as Json), obligationRev: 2 },
        })),
        census: (o['census'] as Json[]).map((e) => (e['rule'] === 'T-1' ? { ...e, rule: 'T-4' } : e)).sort((x, y) => Number(String(x['rule']).slice(2)) - Number(String(y['rule']).slice(2))),
      }));
      return await apply(a, j);
    } finally {
      j.close();
    }
  }

  it('apply.owner-answer-unruled: an answer re-anchoring in-slice I-1 without a ruling naming it amended is refused', T, async () => {
    const reasons = rejected(await ownerAnswer(false));
    assert.ok(reasons.some((r) => r.includes('I-1 is weakened') && r.includes('amended')), JSON.stringify(reasons));
  });

  it('apply.owner-answer-mid-arc: with C-2 in force, one apply re-pins, answers P-1 and amends I-1 (corpus + phase0 + obligation)', T, async () => {
    const v = accepted(await ownerAnswer(true));
    const types = v.evaluated.draft.changes.map((c) => c.type).sort();
    assert.ok(['corpus', 'phase0', 'obligation'].every((t) => types.includes(t as never)), JSON.stringify(v.evaluated.draft.changes));
    assert.deepEqual([...new Set(v.evaluated.draft.dispositions.map((d) => `${d.obligation} ${d.disposition} ${d.ruling}`))], ['I-1 amended C-2']);
  });

  it('classify.corpus-repin-not-by-start: a start may not re-pin (architect apply only)', T, async () => {
    const { a, j } = await arcInForce();
    try {
      const commit = commitCorpus(a, '0020_Berths.md', (t) => t.replace('A booking names one berth and one tide window.', 'A booking names one berth.'));
      await repin(a, commit);
      const v = evaluateRevision({ runDir: runDirOfArc(a), view: j.view, hostDir: newHostDir(), planFile: a.planPath, routingBase: BASE }, filesOf(a), { type: 'start' });
      assert.equal(v.kind, 'rejected');
      if (v.kind !== 'rejected') return;
      assert.ok(v.reasons.some((r) => r.includes('the corpus pin changes only through an architect `apply`, not a start')), JSON.stringify(v.reasons));
    } finally {
      j.close();
    }
  });
});

describe('Phase-0 record edits and the census', () => {
  it('classify.phase0-edit: a record edit is exactly {phase0}, touching no unit; a new promote while draining is refused', T, async () => {
    const { a, j } = await arcInForce();
    try {
      editPhase0(a, (r) => ({ ...r, curation: [{ tier: 'structural', what: 'merged two restatements', files: ['0010_Overview.md'], rules: ['T-1'] }] }));
      const v = accepted(await apply(a, j));
      const record = sha256Hex(readFileSync(join(a.planDir, 'phase0.json')));
      const capture = sha256Hex(readFileSync(join(a.planDir, 'issues.json')));
      assert.deepEqual(v.evaluated.draft.changes, [{ type: 'phase0', sha256: record, issuesSha256: capture }]);
      const cur = planInForce(runDirOfArc(a), j.view)!.plan;
      assert.deepEqual(changesScope(v.evaluated.draft.changes, cur, filesOf(a).plan), { type: 'none' });

      j.fact({ kind: 'admissions-closed', command: commandId('cmd-0123456789abcdef') });
      editPhase0(a, (r) => ({ ...r, debt: [{ id: 'B-1', disposition: { type: 'promote', unit: 'u1' } }] }));
      const runDir = runDirOfArc(a);
      const now = planInForce(runDir, j.view)!;
      const verdict = classify({
        runDir, view: j.view, inForce: now, revision: revisionInForce(runDir, now), next: filesOf(a), residues: [], routing: BASE, proposer: { type: 'apply' },
      });
      assert.equal(verdict.kind, 'rejected');
      if (verdict.kind !== 'rejected') return;
      assert.ok(verdict.reasons.some((r) => r.includes('draining') && r.includes('B-1')), JSON.stringify(verdict.reasons));
    } finally {
      j.close();
    }
  });

  it('classify.census-dangling and classify.census-change: an entry for an unpinned rule is refused; a state change is accepted', T, async () => {
    const { a, j } = await arcInForce();
    try {
      const census = (entries: readonly Json[]): void => editJsonFile(join(a.planDir, 'obligations.json'), (o) => ({ ...o, census: entries }));
      const base = readJsonFile(join(a.planDir, 'obligations.json'))['census'] as Json[];
      census([...base, { rule: 'T-9', state: { type: 'out-of-slice' } }]);
      const reasons = rejected(await apply(a, j));
      assert.ok(reasons.includes(canonicalJson({ kind: 'phase0-invalid', problems: [{ type: 'census-dangling', rules: ['T-9'] }] })), JSON.stringify(reasons));
      census(base.map((e) => (e['rule'] === 'T-2' ? { rule: 'T-2', state: { type: 'untestable' } } : e)));
      accepted(await apply(a, j));
    } finally {
      j.close();
    }
  });
});

describe('the specs against the census at every revision (run 10, C)', () => {
  it('classify.spec-census-every-revision: an apply or a bundle whose spec cites an out-of-slice rule is refused by the classifier with the row; the bundle is told how to fix it', T, async () => {
    const { a, j } = await arcInForce();
    try {
      editJsonFile(join(a.planDir, 'u1.json'), (s) => ({
        ...s, rev: 2, acceptance: [...(s['acceptance'] as Json[]), { id: 'A2', clause: 'A booking names its berth (T-2).', failLoudIfUndelivered: false, state: 'active' }],
      }));
      const row = canonicalJson({ kind: 'phase0-invalid', problems: [{ type: 'spec-census-mismatch', unit: 'u1', item: 'A2', rule: 'T-2', state: 'out-of-slice' }] });
      assert.deepEqual(rejected(await apply(a, j)), [row], 'the apply: the classifier\'s row alone, naming unit, item and rule');
      const ctx = { runDir: runDirOfArc(a), view: j.view, hostDir: newHostDir(), planFile: a.planPath, routingBase: BASE };
      const bundle = evaluateRevision(ctx, filesOf(a), { type: 'bundle', job: jobId('ckpt', 1), cites: [visionClauseId('V-1')], evidence: ['e'], admits: [] });
      assert.equal(bundle.kind, 'rejected');
      if (bundle.kind !== 'rejected') return;
      assert.deepEqual(bundle.reasons, [
        `${row}: unit u1's acceptance clause A2 names T-2, which is out of slice: to work on T-2, admit it as a target of an opportunity whose obligation split anchors a child at T-2 (the census moves), or drop the T-2 citation from A2`,
      ]);
      editJsonFile(join(a.planDir, 'u1.json'), (s) => ({ ...s, acceptance: (s['acceptance'] as Json[]).map((x) => (x['id'] === 'A2' ? { ...x, clause: 'A booking names its berth.' } : x)) }));
      accepted(await apply(a, j));
    } finally {
      j.close();
    }
  });
});

describe('fixed fields', () => {
  it('apply.target-kind-fixed: a corpus arc stays a corpus arc', T, async () => {
    const { a, j } = await arcInForce();
    try {
      writeFileSync(join(a.planDir, 'vision.json'), JSON.stringify(visionRecord(null)));
      editPlan(a, (p) => {
        const { corpus: _c, phase0: _p, ...rest } = p;
        return { ...rest, architectureDoc: 'README.md', holistic: { vision: 'vision.json', advances: ['V-1'], obligations: 'obligations.json' } };
      });
      const reasons = rejected(await apply(a, j));
      assert.ok(reasons.some((r) => r.startsWith('target-kind-changed')), JSON.stringify(reasons));
    } finally {
      j.close();
    }
  });

  it('apply.chain-immutable: plan.chain may not appear after revision 1', T, async () => {
    const { a, j } = await arcInForce();
    try {
      editPlan(a, (p) => ({ ...p, chain: { previousArc: 'arc-0', previousHead: baselineOf(a) } }));
      const reasons = rejected(await apply(a, j));
      assert.ok(reasons.some((r) => r.startsWith('chain-immutable')), JSON.stringify(reasons));
    } finally {
      j.close();
    }
  });
});

describe('the vision confirmed against the pin', () => {
  it('vision.unconfirmed-start: no confirmation, or another sha, refuses the start; a confirmed arc starts and keeps its corpus inputs', T, async () => {
    const none = await corpusArc({ files: { '.roadmap/vision.json': JSON.stringify(visionRecord(null)) } });
    assert.deepEqual(refusedRows(await start(none)), [{ kind: 'vision-unconfirmed', ref: null, expected: null, actual: null }]);

    const other = await corpusArc({ files: { '.roadmap/vision.json': JSON.stringify(visionRecord('# Another vision\n')) } });
    const actual = (readJsonFile(join(other.planDir, PIN_FILE))['vision'] as Json)['sha256'];
    assert.equal(actual, sha256Hex(readFileSync(join(other.repo, VISION_PATH))));
    const ref = `corpus:0005_Vision.md#sha256:${sha256Hex('# Another vision\n')}`;
    assert.deepEqual(refusedRows(await start(other)), [{ kind: 'vision-unconfirmed', ref, expected: sha256Hex('# Another vision\n'), actual }]);

    const green = await corpusArc();
    const out = await start(green, green.planPath, (passed) => {
      const runDir = passed.context.runDir;
      const now = planInForce(runDir, passed.journal.view);
      assert.ok(now !== null);
      const revision = revisionInForce(runDir, now);
      assert.ok(revision.corpus !== null, 'the corpus inputs are in force');
      for (const f of revision.corpus.pin.value.files) assert.ok(keptInput(runDir, f.sha256, CORPUS_FILE_INPUT) !== null, `${f.path} kept`);
    });
    assert.equal(out.kind, 'passed', JSON.stringify(out.kind === 'refused' ? out.rejections : 'passed'));
  });

  it('vision.unconfirmed-apply: a vision revision whose confirmation does not match the pin is rejected', T, async () => {
    const { a, j } = await arcInForce();
    try {
      const v2 = visionRecord('# Not the vision\n');
      const clauses = [...(v2['clauses'] as Json[]), { id: 'V-3', kind: 'good', text: 'Quiet nights.', rank: null, state: 'active' }];
      writeFiles(a.repo, { '.roadmap/vision.json': JSON.stringify({ ...v2, rev: 2, clauses }) });
      commitAll(a.repo, 'vision rev 2');
      const reasons = rejected(await apply(a, j));
      const pinned = (readJsonFile(join(a.planDir, PIN_FILE))['vision'] as Json)['sha256'];
      const row = { kind: 'vision-unconfirmed', ref: `corpus:0005_Vision.md#sha256:${sha256Hex('# Not the vision\n')}`, expected: sha256Hex('# Not the vision\n'), actual: pinned };
      assert.ok(reasons.includes(canonicalJson(row)), JSON.stringify(reasons));
    } finally {
      j.close();
    }
  });
});

describe('the tree and the forge at start', () => {
  it('phase0.tree-uncommitted-start-and-apply: an uncommitted .roadmap input refuses a start (corpus and doc arcs) and an apply', T, async () => {
    const a = await corpusArc();
    writeFileSync(join(a.repo, '.roadmap/config.json'), `${JSON.stringify({ chain: { k: 2 } })}\n`);
    assert.deepEqual(refusedRows(await start(a)), [{ kind: 'tree-uncommitted', paths: ['.roadmap/config.json'] }]);

    // A plain (non-holistic) architecture-doc arc: an uncommitted new vision.json.
    const repo = absPath(makeRepo(tmpDir('c1-doc'), { files: { 'README.md': 'hello\n', 'ARCHITECTURE.md': 'arch\n' } }));
    const planDir = tmpDir('c1-doc-plan');
    const lane = { id: 'suite', argv: ['node', '-e', '0'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [] };
    writeFileSync(join(planDir, 'u1.json'), JSON.stringify({
      schema: 'roadmap/spec-m1', unit: 'u1', rev: 1, lanes: [{ ...lane, id: 'unit', state: 'active' }],
      acceptance: [{ id: 'A1', clause: 'It works.', failLoudIfUndelivered: true, state: 'active' }],
      scope: ['src/**'], resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] },
    }));
    writeFileSync(join(planDir, 'rulings.md'), '# Rulings\n\nC-1 — Helpers live in src/.\n');
    const planFile = absPath(join(planDir, 'plan.json'));
    writeFileSync(planFile, JSON.stringify({
      schema: 'roadmap/plan-m1', arc: 'doc-1', integrationBranch: 'main', baseline: revParse(repo, 'HEAD'), worktreeRoot: tmpDir('c1-doc-wt'), contracts: [],
      rulings: 'rulings.md', architectureDoc: 'ARCHITECTURE.md', direction: 'd', suite: { lanes: [lane] }, resources: [],
      units: [{ id: 'u1', spec: 'u1.json', risk: 'low', scope: ['src/**'], resources: [] }],
    }));
    writeFiles(repo, { '.roadmap/vision.json': '{}\n' });
    const doc = await start({ ...a, repo }, planFile);
    assert.deepEqual(refusedRows(doc), [{ kind: 'tree-uncommitted', paths: ['.roadmap/vision.json'] }]);

    // An apply over an arc in force.
    const { a: b, j } = await arcInForce();
    try {
      editPhase0(b, (r) => ({ ...r, curation: [{ tier: 'fact-currency', what: 'dropped a stale paragraph', files: ['0010_Overview.md'], rules: [] }] }));
      writeFileSync(join(b.repo, '.roadmap/config.json'), `${JSON.stringify({ chain: { k: 3 } })}\n`);
      const reasons = rejected(await apply(b, j));
      assert.ok(reasons.includes(canonicalJson({ kind: 'tree-uncommitted', paths: ['.roadmap/config.json'] })), JSON.stringify(reasons));
    } finally {
      j.close();
    }
  });

  it('phase0.issue-policy-untrusted-start: PUBLIC + ALL refuses the start', T, async () => {
    const a = await corpusArc();
    a.forge.setPolicy(UNTRUSTED_POLICY);
    assert.deepEqual(refusedRows(await start(a)), [{ kind: 'issue-policy-untrusted', visibility: 'PUBLIC', policy: 'ALL' }]);
  });
});

describe('holistic arcs target a corpus (H4)', () => {
  it('start.holistic-needs-corpus: phase0 check and start refuse a fresh holistic architecture-doc plan; an adopted arc with a plan in force starts', T, async () => {
    const a = await corpusArc();
    writeFileSync(join(a.planDir, 'vision.json'), JSON.stringify(visionRecord(null)));
    editPlan(a, (p) => {
      const { corpus: _c, phase0: _p, ...rest } = p;
      return { ...rest, arc: 'adopted-1', architectureDoc: 'README.md', holistic: { vision: 'vision.json', advances: ['V-1'] } };
    });
    const report = await withForge(a.forge, () => phase0Check({ repo: a.repo, source: { type: 'plan', plan: a.planPath } }));
    assert.ok(report.rows.some((r) => r.kind === 'holistic-needs-corpus'), JSON.stringify(report.rows));
    // `start` of the fresh arc refuses it too (runChecks), recording nothing.
    const adopted = { ...a, arc: 'adopted-1' } as CorpusArc;
    assert.deepEqual(refusedRows(await start(adopted)), [{ kind: 'holistic-needs-corpus' }]);
    assert.equal(existsSync(join(runDirOfArc(adopted), EVENTS_FILE)), false, 'a refused fresh start records no plan');

    // An adopted arc: the same plan in force as revision 1 (as dev.6 left it); its next start is accepted.
    const runDir = runDirOfArc(adopted);
    mkdirSync(runDir, { recursive: true });
    const j = openJournal(runDir, adopted.arc);
    try {
      recordPlan(j, runDir, readInputFiles(a.planPath, a.repo), [], BASE);
    } finally {
      j.close();
    }
    const out = await start(adopted);
    assert.equal(out.kind, 'passed', JSON.stringify(out.kind === 'refused' ? out.rejections : 'passed'));
  });
});
