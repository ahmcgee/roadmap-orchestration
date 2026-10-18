// The M5 paid fixture, step 3: `node evals/m5/check.ts <dir>` grades a finished session (setup → driver) from
// report.json, the transcript, the product's arc ref and run dir (its full events.jsonl and the walk evidence) and the
// product's git trees. Agent-facing output: one JSON line `{pass, criteria[{name, pass, detail}]}`. Exits 1 when any
// criterion fails. The browser and dependent milestones are found by shape (shape.ts), never by id.
//
//   isolation          the staged plugin has no executor/evals or executor/test; the launch env has no denied key, its
//                      GH_CONFIG_DIR and XDG_CONFIG_HOME are the fixture's and still empty, its GIT_CONFIG_GLOBAL the
//                      fixture's gitconfig; `command -v gh` was the staged fake; the transcript's tool traffic names
//                      neither the answer key nor `evals/m5` nor this repository (re-scanned)
//   session-stopped    the session ended with the skill's session-end line, reason `vision-silent` or `k-limit`, after
//                      exactly one arc (the corpus is one arc's worth: the owner takes both world scenes in the slice)
//   arc-complete       the arc's verified ref holds an active completion
//   milestones-planned the arc's first plan in force has the M5 shape (shape.ts `planShape`): a browser milestone whose
//                      units all run after its design unit, and a dependent milestone at least one of whose units
//                      descends (through `after`) from one of the browser milestone's units (those are its held units)
//   design-first       the browser milestone's design unit published before any of the milestone's units was first
//                      dispatched, and every `references` dir of the milestone is in the tree it published
//   node-held          `milestone-passed` names the browser milestone, and no held unit of the dependent milestone was
//                      first dispatched before it (its units that descend from no browser-milestone unit are not held)
//   walk-screenshots   at least one walk of the browser milestone ended `reported`, and each such walk's evidence dir
//                      (`<runDir>/evidence/jobs/<walk-n>/`) holds a PNG file (by its signature, anywhere below it)
//   plant-caught       the plant (layout.ts PLANT) still failed at the first browser walk's SHA (else it was repaired
//                      upstream and the walk had nothing to catch), and a walkthrough finding on the browser milestone
//                      whose claim or cause speaks of contrast or faint text reached `resolved` from `fixed-on-branch` of
//                      a unit whose publication came first
//   plant-repaired     at the arc's completed head, `.book-meta`'s text over its background computes at 4.5:1 or more
//                      across the stylesheets under `public/` (css.ts); a selector gone from them fails, for the lead to
//                      adjudicate by hand
//   polish-bounded     no milestone was walked more rounds than the final plan's `walkRounds`; no round's walk failed more
//                      than WALK_ATTEMPTS times nor a unit compared more than COMPARE_ATTEMPTS (the brakes); every polish unit
//                      of the final plan not cut outside its compare has exactly one `tweak-judged`, and a published one was
//                      judged `keep` before it published
//   demo-serving       (needs agent G's demo) a `demo-promoted` was recorded; the driver's end-of-run `status.demo` names
//                      the latest promotion's milestone and SHA, its `where` is an http(s) URL that answered below 500, and
//                      every `status.demo` the driver saw named that same URL
//   skill-vendored     the frontend-design skill's files are byte-identical at the completed head and the seed
//   no-model-ids       no model id in the run dir (launch inputs and captured backend output aside) or the ref (M4a's)
//   host-released      every arc the driver found holding the host at the end was stopped and cleared; none holds it now
//   profile            the arc's first `plan-applied` resolved under the report's profile
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type ArcRef, arcsWithRefs, completedHeadOf, readArcRef } from '../../src/chain.ts';
import type { Event, Fact, IntentOf, TweakDecision, TweakReason, WalkOutcome } from '../../src/core/events.ts';
import { arcId, type JobId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import { git, gitCommonDir } from '../../src/git/git.ts';
import { jobEvidenceRoot } from '../../src/git/snapshot.ts';
import type { FindingTo } from '../../src/holistic/types.ts';
import { readClaim } from '../../src/host/lock.ts';
import { runDir } from '../../src/input/cli.ts';
import { type PlanM1, walkRoundsOf } from '../../src/input/plan.ts';
import { POLISH_DROPPED } from '../../src/input/classify.ts';
import { COMPARE_ATTEMPTS } from '../../src/walk/compare.ts';
import { WALK_ATTEMPTS } from '../../src/walk/milestones.ts';
import { DENIED, UNSTAGED } from '../m4a/driver.ts';
import { hostReleasedVerdict, modelIdHits, profileVerdict } from '../m4a/check.ts';
import { scanTranscript } from '../m4a/transcript.ts';
import { type PairResult, selectorContrast } from './css.ts';
import { type DemoFinal, type DemoSeen, type Report, firstPlan, needles } from './driver.ts';
import { DESIGN_SKILL, type Layout, PLANT, layout } from './layout.ts';
import { SEED_FILE } from './setup.ts';
import { type PlanShape, planShape } from './shape.ts';

export type Criterion = Readonly<{ name: string; pass: boolean; detail: string }>;
export type CheckResult = Readonly<{ pass: boolean; criteria: readonly Criterion[] }>;
export type Verdict = Readonly<{ pass: boolean; detail: string }>;
const verdict = (problems: readonly string[], ok: string): Verdict => ({ pass: problems.length === 0, detail: problems.length === 0 ? ok : problems.join('; ') });

// ---------------------------------------------------------------------------------------------------
// The log as the criteria read it

/** `interrupted`: an abandoned walk a pause, a stop or a backend park cut short (no try of its round's brake; absent: false). */
export type Walk = Readonly<{ job: string; milestone: string; round: number; sha: string; seq: number; outcome: WalkOutcome | null; interrupted?: boolean }>;
/** A polish unit's compare job (agent D): `abandoned` without a judgment, `interrupted` when a pause, stop or park cut it short. */
export type CompareLog = Readonly<{ job: string; unit: string; seq: number; abandoned: boolean; interrupted: boolean }>;
export type FindingLog = Readonly<{ id: string; seq: number; lens: string; milestone: string | null; claim: string; cause: string | null; transitions: readonly Readonly<{ seq: number; to: FindingTo }>[] }>;
export type M5Log = Readonly<{
  /** Each unit's first `dispatch` fact. */
  firstDispatch: ReadonlyMap<string, number>;
  /** Unit publications (a published `integration.ff` with a stage parent): the seq of the done, the commit published. */
  publications: readonly Readonly<{ seq: number; unit: string; commit: string }>[];
  walks: readonly Walk[];
  passed: readonly Readonly<{ seq: number; milestone: string; job: string }>[];
  findings: readonly FindingLog[];
  tweaks: readonly Readonly<{ seq: number; unit: string; decision: TweakDecision; reason: TweakReason }>[];
  /** Agent D: the compare jobs (`compare-started`, closed by `compare-abandoned` or the unit's `tweak-judged`). */
  compares: readonly CompareLog[];
  demos: readonly Readonly<{ seq: number; milestone: string; sha: string }>[];
}>;

export function logOf(events: readonly Event[]): M5Log {
  const firstDispatch = new Map<string, number>();
  const ffs = new Map<string, IntentOf<'integration.ff'>>();
  const publications: { seq: number; unit: string; commit: string }[] = [];
  const walks = new Map<string, { job: string; milestone: string; round: number; sha: string; seq: number; outcome: WalkOutcome | null; interrupted?: boolean }>();
  const compares = new Map<string, { job: string; unit: string; seq: number; abandoned: boolean; interrupted: boolean }>();
  const passed: M5Log['passed'][number][] = [];
  const findings = new Map<string, { id: string; seq: number; lens: string; milestone: string | null; claim: string; cause: string | null; transitions: { seq: number; to: FindingTo }[] }>();
  const tweaks: M5Log['tweaks'][number][] = [];
  const demos: M5Log['demos'][number][] = [];
  for (const e of events) {
    if (e.type === 'intent' && e.kind === 'integration.ff') ffs.set(e.op, e);
    if (e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'published') {
      const i = ffs.get(e.op);
      if (i === undefined) throw new Error(`integration.ff ${e.op} done without an intent`);
      if (i.expect.subject === undefined && i.parent.type === 'stage') publications.push({ seq: e.seq, unit: i.parent.unit, commit: i.expect.new });
    }
    if (e.type !== 'fact') continue;
    const f: Fact = e.fact;
    switch (f.kind) {
      case 'dispatch':
        if (!firstDispatch.has(f.record.unit)) firstDispatch.set(f.record.unit, e.seq);
        break;
      case 'walk-started':
        walks.set(f.job, { job: f.job, milestone: f.milestone, round: f.round, sha: f.sha, seq: e.seq, outcome: null });
        break;
      case 'walk-ended': {
        const w = walks.get(f.job);
        if (w === undefined) throw new Error(`walk-ended ${f.job} without its walk-started`);
        w.outcome = f.outcome;
        if (f.interrupted === true) w.interrupted = true;
        break;
      }
      case 'compare-started':
        compares.set(f.job, { job: f.job, unit: f.unit, seq: e.seq, abandoned: false, interrupted: false });
        break;
      case 'compare-abandoned': {
        const c = compares.get(f.job);
        if (c === undefined) throw new Error(`compare-abandoned ${f.job} without its compare-started`);
        c.abandoned = true;
        c.interrupted = f.interrupted === true;
        break;
      }
      case 'milestone-passed':
        passed.push({ seq: e.seq, milestone: f.milestone, job: f.job });
        break;
      case 'finding-opened':
        findings.set(f.id, { id: f.id, seq: e.seq, lens: f.lens, milestone: f.milestone ?? null, claim: f.claim, cause: f.cause ?? null, transitions: [] });
        break;
      case 'finding-transition': {
        const x = findings.get(f.id);
        if (x === undefined) throw new Error(`finding-transition ${f.id} without its finding-opened`);
        x.transitions.push({ seq: e.seq, to: f.to });
        break;
      }
      case 'tweak-judged':
        tweaks.push({ seq: e.seq, unit: f.unit, decision: f.decision, reason: f.reason });
        break;
      case 'demo-promoted':
        demos.push({ seq: e.seq, milestone: f.milestone, sha: f.sha });
        break;
      default:
        break;
    }
  }
  return { firstDispatch, publications, walks: [...walks.values()], passed, findings: [...findings.values()], tweaks, compares: [...compares.values()], demos };
}

type Shaped = Extract<PlanShape, { kind: 'ok' }>;
const needShape = (shape: PlanShape): Shaped => {
  if (shape.kind !== 'ok') throw new Error(`the first plan is off the M5 shape: ${shape.problems.join('; ')}`);
  return shape;
};

// ---------------------------------------------------------------------------------------------------
// Criteria over the log (pure: check.ts's tests build their inputs in place)

export function milestonesPlannedVerdict(shape: PlanShape): Verdict {
  if (shape.kind === 'off') return { pass: false, detail: shape.problems.join('; ') };
  return { pass: true, detail: `browser ${shape.browser.id} (design ${JSON.stringify(shape.browser.design)}, units ${shape.browser.units.join(', ')}); dependent ${shape.dependent.id} (units ${shape.dependent.units.join(', ')}; held ${shape.held.join(', ')})` };
}

/** `missingRefs(commit, dirs)`: the dirs absent from the commit's tree. */
export function designFirstVerdict(shape: PlanShape, log: M5Log, missingRefs: (commit: string, dirs: readonly string[]) => readonly string[]): Verdict {
  const { browser } = needShape(shape);
  if (!('unit' in browser.design)) return { pass: false, detail: `${browser.id}'s design is supplied` };
  const design = browser.design.unit;
  const pub = log.publications.find((p) => p.unit === design);
  if (pub === undefined) return { pass: false, detail: `the design unit ${design} never published` };
  const problems: string[] = [];
  for (const u of browser.units) {
    const d = log.firstDispatch.get(u);
    if (d !== undefined && d < pub.seq) problems.push(`${u} was dispatched at seq ${d}, before ${design} published at seq ${pub.seq}`);
  }
  const missing = missingRefs(pub.commit, browser.references);
  if (missing.length > 0) problems.push(`${design}'s publication ${pub.commit} has no ${missing.join(', ')}`);
  return verdict(problems, `${design} published at seq ${pub.seq} with ${browser.references.join(', ')}; ${browser.units.join(', ')} dispatched after it`);
}

export function nodeHeldVerdict(shape: PlanShape, log: M5Log): Verdict {
  const { browser, dependent, held } = needShape(shape);
  const pass = log.passed.find((p) => p.milestone === browser.id);
  if (pass === undefined) return { pass: false, detail: `no milestone-passed{${browser.id}}` };
  const early = held.flatMap((u) => {
    const d = log.firstDispatch.get(u);
    return d !== undefined && d < pass.seq ? [`${u} dispatched at seq ${d}`] : [];
  });
  return verdict(early.map((x) => `${x}, before milestone-passed{${browser.id}} at seq ${pass.seq}`), `${browser.id} passed at seq ${pass.seq} (${pass.job}); ${dependent.id}'s held units ${held.join(', ')} dispatched after it`);
}

/** `pngs(job)`: the PNG files under the walk's evidence dir. */
export function walkScreenshotsVerdict(shape: PlanShape, log: M5Log, pngs: (job: string) => readonly string[]): Verdict {
  const { browser } = needShape(shape);
  const reported = log.walks.filter((w) => w.milestone === browser.id && w.outcome === 'reported');
  if (reported.length === 0) return { pass: false, detail: `no walk of ${browser.id} ended reported (${log.walks.map((w) => `${w.job} ${w.outcome}`).join(', ') || 'no walks'})` };
  const counts = reported.map((w) => ({ job: w.job, n: pngs(w.job).length }));
  return verdict(counts.filter((c) => c.n === 0).map((c) => `${c.job}'s evidence holds no PNG`), counts.map((c) => `${c.job}: ${c.n} PNG`).join(', '));
}

/** The words a walkthrough finding on the plant uses (claim or cause). */
export const PLANT_WORDS = /contrast|faint|low[- ]?visibility|hard to read|illegible|legib/i;

/** `contrastAt(sha)`: the plant pair at a SHA (css.ts over the stylesheets under `public/`). */
export function plantCaughtVerdict(shape: PlanShape, log: M5Log, contrastAt: (sha: string) => PairResult): Verdict {
  const { browser } = needShape(shape);
  const first = log.walks.filter((w) => w.milestone === browser.id).sort((a, b) => a.seq - b.seq)[0];
  if (first === undefined) return { pass: false, detail: `${browser.id} was never walked` };
  const at = contrastAt(first.sha);
  if (at.kind === 'ratio' && at.ratio >= PLANT.floor) return { pass: false, detail: `the plant was repaired upstream: ${PLANT.selector} computes ${at.ratio.toFixed(2)}:1 at ${first.job}'s SHA ${first.sha}, so the walk had nothing to catch` };
  const candidates = log.findings.filter((f) => f.lens === 'walkthrough' && f.milestone === browser.id && PLANT_WORDS.test(`${f.claim} ${f.cause ?? ''}`));
  if (candidates.length === 0) return { pass: false, detail: `no walkthrough finding on ${browser.id} speaks of contrast (${log.findings.filter((f) => f.lens === 'walkthrough').map((f) => `${f.id}: ${f.claim}`).join(' | ') || 'no walkthrough findings'})` };
  const problems: string[] = [];
  for (const f of candidates) {
    const resolved = f.transitions.findLast((t) => t.to.state === 'resolved');
    const fixed = f.transitions.filter((t) => resolved === undefined || t.seq < resolved.seq).findLast((t) => t.to.state === 'fixed-on-branch');
    const unit = fixed !== undefined && fixed.to.state === 'fixed-on-branch' ? fixed.to.unit : null;
    const pub = unit === null ? undefined : log.publications.find((p) => p.unit === unit && (resolved === undefined || p.seq < resolved.seq));
    if (resolved !== undefined && pub !== undefined) return { pass: true, detail: `${f.id} (${f.claim}) resolved at seq ${resolved.seq} by ${unit}'s publication at seq ${pub.seq}` };
    problems.push(`${f.id} (${f.claim}) is ${f.transitions.at(-1)?.to.state ?? 'open'}${unit === null ? '' : ` (fixed on ${unit}'s branch, ${pub === undefined ? 'unpublished' : 'published'})`}`);
  }
  return { pass: false, detail: problems.join('; ') };
}

export function plantRepairedVerdict(head: string, at: PairResult): Verdict {
  switch (at.kind) {
    case 'absent':
      return { pass: false, detail: `${PLANT.selector} is gone from the stylesheets under public/ at ${head}: adjudicate by hand` };
    case 'unknown':
      return { pass: false, detail: `${PLANT.selector} at ${head}: ${at.detail}` };
    case 'ratio':
      return { pass: at.ratio >= PLANT.floor, detail: `${PLANT.selector} at ${head}: ${at.color} over ${at.background} computes ${at.ratio.toFixed(2)}:1 (floor ${PLANT.floor}:1)` };
  }
}

/** `polishUnits`: the final plan's polish-origin units; `walkRounds`: its bound. */
export function polishBoundedVerdict(log: M5Log, polishUnits: readonly string[], walkRounds: number): Verdict {
  const problems: string[] = [];
  const rounds = new Map<string, number>();
  for (const w of log.walks) rounds.set(w.milestone, Math.max(rounds.get(w.milestone) ?? 0, w.round));
  for (const [m, r] of rounds) if (r > walkRounds) problems.push(`${m} was walked in round ${r}, past walkRounds ${walkRounds}`);
  // The abandonment brakes (agent D): a round's failed walks, and a unit's compares, at most WALK_ATTEMPTS / COMPARE_ATTEMPTS.
  const tries = new Map<string, number>();
  for (const w of log.walks) if (w.outcome === 'abandoned' && w.interrupted !== true) tries.set(`${w.milestone} round ${w.round}`, (tries.get(`${w.milestone} round ${w.round}`) ?? 0) + 1);
  for (const [k, n] of tries) if (n > WALK_ATTEMPTS) problems.push(`${k} was abandoned ${n} times, past the brake of ${WALK_ATTEMPTS}`);
  for (const u of new Set(log.compares.map((c) => c.unit))) {
    const n = log.compares.filter((c) => c.unit === u && !c.interrupted).length;
    if (n > COMPARE_ATTEMPTS) problems.push(`polish unit ${u} was compared ${n} times, past the brake of ${COMPARE_ATTEMPTS}`);
  }
  for (const u of polishUnits) {
    const judged = log.tweaks.filter((t) => t.unit === u);
    if (judged.length !== 1) {
      problems.push(`polish unit ${u} has ${judged.length} tweak-judged facts`);
      continue;
    }
    const pub = log.publications.find((p) => p.unit === u);
    if (pub !== undefined && (judged[0]!.decision !== 'keep' || judged[0]!.seq > pub.seq)) problems.push(`polish unit ${u} published at seq ${pub.seq} after a ${judged[0]!.decision} at seq ${judged[0]!.seq}`);
  }
  const shown = [...rounds].map(([m, r]) => `${m} ${r} round(s)`).join(', ') || 'no walks';
  return verdict(problems, `${shown} within ${walkRounds}; ${polishUnits.length} polish unit(s), each judged once (${log.tweaks.map((t) => `${t.unit} ${t.decision}`).join(', ') || 'none'})`);
}

const whereOf = (demo: unknown): unknown => (demo as { where?: unknown } | null)?.where;

export function demoServingVerdict(log: M5Log, seen: readonly DemoSeen[], final: DemoFinal | null): Verdict {
  const last = log.demos.at(-1);
  if (last === undefined) return { pass: false, detail: 'no demo-promoted in the log' };
  if (final === null || final.demo === null || typeof final.demo !== 'object') return { pass: false, detail: `the driver's end-of-run status has no demo (${JSON.stringify(final)}): agent G's status.demo` };
  const d = final.demo as { milestone?: unknown; sha?: unknown; where?: unknown };
  const problems: string[] = [];
  if (d.milestone !== last.milestone || d.sha !== last.sha) problems.push(`status.demo is ${d.milestone}@${d.sha}, the latest promotion ${last.milestone}@${last.sha}`);
  if (typeof d.where !== 'string' || !/^https?:\/\//.test(d.where)) problems.push(`status.demo.where ${JSON.stringify(d.where)} is no URL`);
  else if (final.probe === null || final.probe.status === null || final.probe.status >= 500) problems.push(`${d.where} did not serve: ${JSON.stringify(final.probe)}`);
  const urls = [...new Set(seen.map((s) => whereOf(s.demo)).filter((w) => w !== undefined && w !== null))];
  if (urls.length > 1) problems.push(`the demo moved: ${urls.map((u) => JSON.stringify(u)).join(' → ')}`);
  return verdict(problems, `${log.demos.length} promotion(s), the latest ${last.milestone}@${last.sha}; ${String(d.where)} answered ${final.probe?.status}`);
}

// ---------------------------------------------------------------------------------------------------
// Criteria that read the fixture

type Run = Readonly<{ l: Layout; report: Report; product: AbsPath; ref: ArcRef | null; runDir: AbsPath | null; log: M5Log | null; shape: PlanShape }>;

const needRef = (run: Run): ArcRef => {
  if (run.ref === null) throw new Error('the product has no arc ref');
  return run.ref;
};
const needLog = (run: Run): M5Log => {
  if (run.log === null) throw new Error('the product has no run dir');
  return run.log;
};
const headOf = (ref: ArcRef): string => {
  const h = completedHeadOf(ref)?.head;
  if (h === undefined) throw new Error(`${ref.arc} has no completed head`);
  return h;
};

function filesUnder(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function isPng(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(8);
    return readSync(fd, head, 0, 8, 0) === 8 && head.equals(PNG_SIGNATURE);
  } finally {
    closeSync(fd);
  }
}

/** The plant pair over the stylesheets under `public/` at `sha`, in path order. */
export function plantAt(product: AbsPath, sha: string): PairResult {
  const sheets = git(product, ['ls-tree', '-r', '--name-only', sha, '--', 'public/']).split('\n').filter((p) => p.endsWith('.css'));
  if (sheets.length === 0) return { kind: 'absent' };
  return selectorContrast(sheets.map((p) => git(product, ['show', `${sha}:${p}`])).join('\n'), PLANT.selector);
}

function isolation(run: Run): Verdict {
  const { l, report } = run;
  const problems: string[] = [];
  for (const u of UNSTAGED.slice(0, 2)) if (existsSync(join(l.plugin, u))) problems.push(`the staged plugin holds ${u}`);
  for (const k of report.launch.envKeys) if (DENIED.some((r) => r.test(k))) problems.push(`the launch env carried ${k}`);
  for (const [name, dir, want] of [['GH_CONFIG_DIR', report.launch.ghConfigDir, l.ghConfig], ['XDG_CONFIG_HOME', report.launch.xdgConfigHome, l.xdgConfig]] as const) {
    if (dir !== want) problems.push(`${name} was ${dir}`);
    else if (readdirSync(dir).length > 0) problems.push(`${name} (${dir}) is not empty: ${readdirSync(dir).join(', ')}`);
  }
  if (report.launch.gitConfigGlobal !== l.gitConfig) problems.push(`GIT_CONFIG_GLOBAL was ${report.launch.gitConfigGlobal}`);
  if (report.launch.gh !== join(l.forgeBin, 'gh')) problems.push(`command -v gh was ${report.launch.gh}`);
  problems.push(...scanTranscript(l.transcript, needles()).map((h) => `transcript: ${h}`));
  return verdict(problems, `${report.launch.envKeys.length} env keys, gh ${report.launch.gh}, transcript clean`);
}

function sessionStopped(run: Run): Verdict {
  const problems: string[] = [];
  if (run.report.endedBy !== 'stopped' || !['vision-silent', 'k-limit'].includes(run.report.stopReason ?? '')) problems.push(`the session ended ${run.report.endedBy} (${run.report.stopReason ?? run.report.failure})`);
  const arcs = arcsWithRefs(run.product);
  if (arcs.length !== 1) problems.push(`${arcs.length} arcs have refs: ${arcs.join(', ')}`);
  return verdict(problems, `stopped ${run.report.stopReason} after one arc`);
}

function arcComplete(run: Run): Verdict {
  const ref = needRef(run);
  const c = completedHeadOf(ref);
  const h = ref.view.holistic().completion;
  return { pass: c !== null && h !== null && h.active, detail: c === null ? `${ref.arc} holds no arc-completed after its last revision` : `${ref.arc} completed at ${c.head} (active ${h?.active ?? false})` };
}

const missingRefs = (product: AbsPath) => (commit: string, dirs: readonly string[]): readonly string[] =>
  dirs.filter((d) => git(product, ['ls-tree', '-d', '--name-only', commit, '--', d.replace(/\/$/, '')]).trim() === '');

function polishBounded(run: Run): Verdict {
  const plan: PlanM1 = needRef(run).plan;
  // A polish unit the checkpoint (or an owner) cut before its compare is never judged; a dropped tweak's cut is the compare's.
  return polishBoundedVerdict(needLog(run), plan.units.filter((u) => u.origin === 'polish' && (u.cut === undefined || u.cut.reason === POLISH_DROPPED)).map((u) => u.id), walkRoundsOf(plan));
}

function skillVendored(run: Run): Verdict {
  const head = headOf(needRef(run));
  const seed = (JSON.parse(readFileSync(join(run.l.dir, SEED_FILE), 'utf8')) as { main: string }).main;
  const blob = (commit: string, f: string): string => git(run.product, ['rev-parse', `${commit}:${DESIGN_SKILL.dir}/${f}`]).trim();
  const changed = DESIGN_SKILL.files.filter((f) => blob(seed, f) !== blob(head, f));
  return verdict(changed.map((f) => `${DESIGN_SKILL.dir}/${f} differs from the seed at ${head}`), `${DESIGN_SKILL.files.join(', ')} unchanged at ${head}`);
}

function profile(run: Run): Verdict {
  const ref = needRef(run);
  const first = ref.events.find((e) => e.type === 'fact' && e.fact.kind === 'plan-applied');
  const found = first !== undefined && first.type === 'fact' && first.fact.kind === 'plan-applied' ? first.fact.routingProvenance.profile : null;
  return profileVerdict(run.report.profile, [{ arc: ref.arc, profile: found }]);
}

type Grade = readonly [string, (run: Run) => Verdict];

export const CRITERIA: readonly Grade[] = [
  ['isolation', isolation],
  ['session-stopped', sessionStopped],
  ['arc-complete', arcComplete],
  ['milestones-planned', (run) => milestonesPlannedVerdict(run.shape)],
  ['design-first', (run) => designFirstVerdict(run.shape, needLog(run), missingRefs(run.product))],
  ['node-held', (run) => nodeHeldVerdict(run.shape, needLog(run))],
  ['walk-screenshots', (run) => walkScreenshotsVerdict(run.shape, needLog(run), (job) => filesUnder(jobEvidenceRoot(run.runDir!, job as JobId)).filter(isPng))],
  ['plant-caught', (run) => plantCaughtVerdict(run.shape, needLog(run), (sha) => plantAt(run.product, sha))],
  ['plant-repaired', (run) => plantRepairedVerdict(headOf(needRef(run)), plantAt(run.product, headOf(needRef(run))))],
  ['polish-bounded', polishBounded],
  ['demo-serving', (run) => demoServingVerdict(needLog(run), run.report.demo.seen, run.report.demo.final)],
  ['skill-vendored', skillVendored],
  ['no-model-ids', (run) => modelIdHits(run.product, run.ref === null ? [] : [run.ref])],
  ['host-released', (run) => hostReleasedVerdict(run.report.released, readClaim(absPath(run.report.hostDir)), run.product)],
  ['profile', profile],
];

export function check(dir: string): CheckResult {
  const l = layout(dir);
  if (!existsSync(l.report)) throw new Error(`${l.report} is missing: run evals/m5/driver.ts first`);
  const report = JSON.parse(readFileSync(l.report, 'utf8')) as Report;
  const product = absPath(l.product);
  const arc = arcsWithRefs(product)[0];
  const ref = arc === undefined ? null : readArcRef(product, arc);
  const dir_ = arc === undefined ? null : runDir(gitCommonDir(product), arc);
  const log = dir_ === null || !existsSync(join(dir_, 'events.jsonl')) ? null : logOf(readJournal(dir_, arcId(arc!)).events);
  const first = firstPlan(l);
  const shape: PlanShape = first === null ? { kind: 'off', problems: ['the arc has no plan in force'] } : planShape(first.plan);
  const run: Run = { l, report, product, ref, runDir: dir_, log, shape };
  const criteria = CRITERIA.map(([name, grade]): Criterion => {
    try {
      return { name, ...grade(run) };
    } catch (error) {
      return { name, pass: false, detail: `threw: ${(error as Error).message}` };
    }
  });
  return { pass: criteria.every((c) => c.pass), criteria };
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m5/check.ts <dir>');
  const result = check(resolve(dir));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}
