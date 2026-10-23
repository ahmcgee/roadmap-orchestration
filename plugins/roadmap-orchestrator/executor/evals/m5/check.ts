// The M5 paid fixture, step 3: `node evals/m5/check.ts <dir>` grades a finished session (setup → driver) from
// report.json, the transcript, the product's arc ref and run dir (its full events.jsonl with the plan and specs in force,
// read by log.ts, and the walk evidence) and the product's git trees. Agent-facing output: one JSON line `{pass,
// criteria[{name, pass, detail}]}`. Exits 1 when any criterion fails. The browser and dependent milestones are found by shape (shape.ts), never by id.
//
// The arc under test is the first arc (in start order) whose first plan in force has the M5 shape; with none shaped, the
// first arc with a plan (so milestones-planned names its problems). Every arc criterion grades that arc alone: a later arc
// the session went on to start (the root agent may open a next arc once this one completes) is no part of the grade.
//
//   isolation          the staged plugin has no executor/evals or executor/test; the launch env has no denied key, its
//                      GH_CONFIG_DIR and XDG_CONFIG_HOME are the fixture's and still empty, its GIT_CONFIG_GLOBAL the
//                      fixture's gitconfig; `command -v gh` was the staged fake; the transcript's tool traffic names
//                      neither the answer key nor `evals/m5` nor this repository (re-scanned)
//   session-stopped    the driver stopped the arc once the evidence was complete (`evidence-complete`, log.ts), or the
//                      session ended with the skill's session-end line, reason `vision-silent` or `k-limit` (any other
//                      end, a usage-limit `session-failed` among them, fails with its reason); the arc under test was the
//                      first arc started, and any later arc started only after it completed (the corpus is one arc's
//                      worth, but a later arc in progress at the stop is the session's business, not the grade's)
//   milestones-settled the driver's stop rule (log.ts `evidenceComplete`) holds over the run dir's log and plan in force:
//                      every milestone passed, the demo promoted after the last pass and on the latest round's walked SHA,
//                      no walk, compare or walk-originated unit pending, every polish unit judged or cut. Completion is
//                      m1's to grade: M5 stops the arc before its audit tail
//   milestones-planned the arc's first plan in force has the M5 shape (shape.ts `planShape`): a browser milestone whose
//                      units all run after its design unit, and a dependent milestone at least one of whose units
//                      descends (through `after`) from a unit of another, upstream, milestone (those are its held units)
//   design-first       the browser milestone's design unit published before any of the milestone's units was first
//                      dispatched, and every `references` dir of the milestone is in the tree it published
//   node-held          `milestone-passed` names the upstream milestone, and no held unit of the dependent milestone was
//                      first dispatched before it (its units that descend from no upstream unit are not held)
//   walk-screenshots   at least one walk of the browser milestone ended `reported`, and each such walk's evidence dir
//                      (`<runDir>/evidence/jobs/<walk-n>/`) holds a PNG file (by its signature, anywhere below it)
//   plant-caught       the plant (layout.ts PLANT) never shipped through a miss: a finding of any judge whose claim or cause
//                      speaks of the overflow (PLANT_WORDS) of the planted book (PLANT_ANCHOR) reached `resolved` from `fixed-on-branch` of a unit whose
//                      publication came first, or the plant was gone at the first browser walk's SHA (`/` rendered at 320
//                      CSS px in Chromium, reflow.ts, no wider than the viewport), crediting any finding that named it
//                      (run 5: the vision lens, its fix folded into an undispatched unit's spec); it fails only
//                      when the plant was live at that walk and no resolved finding names it
//   repair-loop        the walk → repair → re-walk loop on any milestone: a walkthrough finding reached `resolved` from
//                      `fixed-on-branch` of a unit whose publication came first, and a walk of its milestone started after
//                      that passed it: wrote the milestone's `milestone-passed`, or (a non-blocking finding: the milestone
//                      passed before the repair) ended `reported` with no finding (the plant's loop is the case plant-caught names)
//   plant-repaired     at the arc's latest integrated head (the verified ref's latest published `integration.ff`; the
//                      arc is stopped, not completed), `/` rendered at 320 CSS px lays out no wider than the viewport,
//                      and the planted book (its title and URL) is still in the page; a book gone fails, for the lead
//                      to adjudicate by hand
//   polish-bounded     no milestone was walked more rounds than the plan in force's `walkRounds`; no round's walk failed more
//                      than WALK_ATTEMPTS times nor a unit compared more than COMPARE_ATTEMPTS (the brakes); every polish unit
//                      of that plan not cut outside its compare has exactly one `tweak-judged`, and a published one was
//                      judged `keep` before it published
//   demo-serving       (needs agent G's demo) a `demo-promoted` was recorded; the driver's end-of-run `status.demo` names
//                      the latest promotion's milestone and SHA, its `where` is an http(s) URL that answered below 500, and
//                      every `status.demo` the driver saw named that same URL
//   skill-vendored     the frontend-design skill's files are byte-identical at the latest integrated head and the seed
//   no-model-ids       no model id in the run dir (launch inputs and captured backend output aside) or the ref (M4a's)
//   host-released      every arc the driver found holding the host at the end was stopped and cleared; none holds it now
//   profile            the arc's first `plan-applied` resolved under the report's profile
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type ArcRef, arcsWithRefs, completedHeadOf, readArcRef } from '../../src/chain.ts';
import { arcId, type JobId } from '../../src/core/ids.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import { git, gitCommonDir } from '../../src/git/git.ts';
import { jobEvidenceRoot } from '../../src/git/snapshot.ts';
import { readClaim } from '../../src/host/lock.ts';
import { runDir } from '../../src/input/cli.ts';
import { walkRoundsOf } from '../../src/input/plan.ts';
import { POLISH_DROPPED } from '../../src/input/classify.ts';
import { COMPARE_ATTEMPTS } from '../../src/walk/compare.ts';
import { WALK_ATTEMPTS } from '../../src/walk/milestones.ts';
import { DENIED, UNSTAGED } from '../m4a/driver.ts';
import { hostReleasedVerdict, modelIdHits, profileVerdict } from '../m4a/check.ts';
import { scanTranscript } from '../m4a/transcript.ts';
import { type DemoFinal, type DemoSeen, type Report, arcsStarted, demoUrl, needles } from './driver.ts';
import { DESIGN_SKILL, type Layout, PLANT, layout } from './layout.ts';
import { type ArcLog, type FindingLog, type M5Log, evidenceComplete, readArcLog, repairsOf } from './log.ts';
import { type Reflow, reflowAt } from './reflow.ts';
import { SEED_FILE } from './setup.ts';
import { type PlanShape, planShape } from './shape.ts';

export type Criterion = Readonly<{ name: string; pass: boolean; detail: string }>;
export type CheckResult = Readonly<{ pass: boolean; criteria: readonly Criterion[] }>;
export type Verdict = Readonly<{ pass: boolean; detail: string }>;
const verdict = (problems: readonly string[], ok: string): Verdict => ({ pass: problems.length === 0, detail: problems.length === 0 ? ok : problems.join('; ') });

type Shaped = Extract<PlanShape, { kind: 'ok' }>;
const needShape = (shape: PlanShape): Shaped => {
  if (shape.kind !== 'ok') throw new Error(`the first plan is off the M5 shape: ${shape.problems.join('; ')}`);
  return shape;
};

// ---------------------------------------------------------------------------------------------------
// Criteria over the log (pure: check.ts's tests build their inputs in place)

export function milestonesPlannedVerdict(shape: PlanShape): Verdict {
  if (shape.kind === 'off') return { pass: false, detail: shape.problems.join('; ') };
  return { pass: true, detail: `browser ${shape.browser.id} (design ${JSON.stringify(shape.browser.design)}, units ${shape.browser.units.join(', ')}); upstream ${shape.upstream.id}, dependent ${shape.dependent.id} (units ${shape.dependent.units.join(', ')}; held ${shape.held.join(', ')})` };
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
  const { upstream, dependent, held } = needShape(shape);
  const pass = log.passed.find((p) => p.milestone === upstream.id);
  if (pass === undefined) return { pass: false, detail: `no milestone-passed{${upstream.id}}` };
  const early = held.flatMap((u) => {
    const d = log.firstDispatch.get(u);
    return d !== undefined && d < pass.seq ? [`${u} dispatched at seq ${d}`] : [];
  });
  return verdict(early.map((x) => `${x}, before milestone-passed{${upstream.id}} at seq ${pass.seq}`), `${upstream.id} passed at seq ${pass.seq} (${pass.job}); ${dependent.id}'s held units ${held.join(', ')} dispatched after it`);
}

/** `pngs(job)`: the PNG files under the walk's evidence dir. */
export function walkScreenshotsVerdict(shape: PlanShape, log: M5Log, pngs: (job: string) => readonly string[]): Verdict {
  const { browser } = needShape(shape);
  const reported = log.walks.filter((w) => w.milestone === browser.id && w.outcome === 'reported');
  if (reported.length === 0) return { pass: false, detail: `no walk of ${browser.id} ended reported (${log.walks.map((w) => `${w.job} ${w.outcome}`).join(', ') || 'no walks'})` };
  const counts = reported.map((w) => ({ job: w.job, n: pngs(w.job).length }));
  return verdict(counts.filter((c) => c.n === 0).map((c) => `${c.job}'s evidence holds no PNG`), counts.map((c) => `${c.job}: ${c.n} PNG`).join(', '));
}

/** The words a walkthrough finding on the plant uses (claim or cause): the sideways scroll, its cause, the 320 px floor. */
export const PLANT_WORDS = /overflow|horizontal(ly)? scroll|scrolls? (sideways|horizontally)|sideways scroll|reflow|wider than|cut off|clipped|\burl\b|\blink\b.*\b(wrap|break)|unbroken|(wrap|break)s? .*\b(url|link|address)\b|\b320 ?(css )?px\b/i;
/** What ties an overflow finding to the plant rather than another overflow (run 5's F-34 was the search heading's). */
export const PLANT_ANCHOR = /\bb1\b|condition|book-meta|le guin|left hand of darkness|oakstreet\.example|bookplate|seeded book/i;
const namesPlant = (f: FindingLog): boolean => PLANT_WORDS.test(`${f.claim} ${f.cause ?? ''}`) && PLANT_ANCHOR.test(`${f.claim} ${f.cause ?? ''}`);

/**
 * Whoever catches the plant, the flow succeeds when it never ships: a finding of any judge (a lens, a gate, a walk) that
 * names the overflow resolved by a unit's publication passes, and so does a plant gone before the first walk with no
 * finding naming it (prevented by a design or build unit). Only a plant still live at the first browser walk that no
 * resolved finding names fails: the walk was the last line. `reflow(sha)`: the shelf's page at PLANT.viewport px at a SHA.
 */
export async function plantCaughtVerdict(shape: PlanShape, log: M5Log, reflow: (sha: string) => Promise<Reflow>): Promise<Verdict> {
  const { browser } = needShape(shape);
  const candidates = log.findings.filter(namesPlant);
  const problems: string[] = [];
  for (const f of candidates) {
    const r = repairOf(f, log);
    if (r.kind === 'resolved') return { pass: true, detail: `${f.id} (${f.lens}: ${f.claim}) resolved at seq ${r.seq} by ${r.unit}'s publication at seq ${r.pub}` };
    problems.push(r.detail);
  }
  const first = log.walks.filter((w) => w.milestone === browser.id).sort((a, b) => a.seq - b.seq)[0];
  if (first === undefined) return { pass: false, detail: `${browser.id} was never walked and no resolved finding names the overflow${problems.length > 0 ? ` (${problems.join('; ')})` : ''}` };
  const at = await reflow(first.sha);
  if (at.kind === 'unknown') return { pass: false, detail: `the plant at ${first.job}'s SHA ${first.sha}: ${at.detail}` };
  if (at.scrollWidth <= at.viewport) return { pass: true, detail: `prevented upstream: / lays out ${at.scrollWidth} px wide at ${at.viewport} px at ${first.job}'s SHA ${first.sha}${candidates.length > 0 ? `; named by ${candidates.map((f) => `${f.id} (${f.lens}, ${f.transitions.at(-1)?.to.state ?? 'open'})`).join(', ')}` : ', with no finding naming it'}` };
  return { pass: false, detail: `the plant was live at ${first.job} (/ ${at.scrollWidth} px wide at ${at.viewport} px) and no resolved finding names it${problems.length > 0 ? `: ${problems.join('; ')}` : ''} (walkthrough findings: ${log.findings.filter((f) => f.lens === 'walkthrough').map((f) => `${f.id}: ${f.claim}`).join(' | ') || 'none'})` };
}

type Repair = Readonly<{ kind: 'resolved'; seq: number; unit: string; pub: number }> | Readonly<{ kind: 'not'; detail: string }>;

/** Whether finding `f` reached `resolved` after `fixed-on-branch` of a unit whose publication came first. */
function repairOf(f: FindingLog, log: M5Log): Repair {
  const resolved = f.transitions.findLast((t) => t.to.state === 'resolved');
  const fixed = f.transitions.filter((t) => resolved === undefined || t.seq < resolved.seq).findLast((t) => t.to.state === 'fixed-on-branch');
  const unit = fixed !== undefined && fixed.to.state === 'fixed-on-branch' ? fixed.to.unit : null;
  const pub = unit === null ? undefined : log.publications.find((p) => p.unit === unit && (resolved === undefined || p.seq < resolved.seq));
  if (resolved !== undefined && pub !== undefined) return { kind: 'resolved', seq: resolved.seq, unit: unit!, pub: pub.seq };
  return { kind: 'not', detail: `${f.id} (${f.claim}) is ${f.transitions.at(-1)?.to.state ?? 'open'}${unit === null ? '' : ` (fixed on ${unit}'s branch, ${pub === undefined ? 'unpublished' : 'published'})`}` };
}

/**
 * The walk → repair → re-walk loop on any milestone: a walkthrough finding resolved by a published unit (`repairOf`), and a
 * walk of its milestone started after that resolution whose job wrote the milestone's `milestone-passed`.
 */
export function repairLoopVerdict(log: M5Log): Verdict {
  const problems: string[] = [];
  for (const f of log.findings.filter((x) => x.lens === 'walkthrough' && x.milestone !== null)) {
    const r = repairOf(f, log);
    if (r.kind === 'not') {
      problems.push(r.detail);
      continue;
    }
    const passedBefore = log.passed.some((p) => p.milestone === f.milestone && p.seq < r.seq);
    const passes = (w: M5Log['walks'][number]): boolean => log.passed.some((p) => p.milestone === f.milestone && p.job === w.job)
      || (passedBefore && w.outcome === 'reported' && w.findings.length === 0);
    const rewalk = log.walks.find((w) => w.milestone === f.milestone && w.seq > r.seq && passes(w));
    if (rewalk !== undefined) {
      const how = log.passed.some((p) => p.job === rewalk.job) ? 'passed the milestone' : 'reported no finding (the milestone had passed before the repair)';
      return { pass: true, detail: `${f.milestone}: ${f.id} (${f.claim}) resolved at seq ${r.seq} by ${r.unit}'s publication at seq ${r.pub}; ${rewalk.job} (round ${rewalk.round}) re-walked it and ${how}` };
    }
    problems.push(`${f.id} on ${f.milestone} resolved at seq ${r.seq} by ${r.unit}, and no later walk of ${f.milestone} passed it`);
  }
  return { pass: false, detail: problems.length === 0 ? 'no walkthrough finding on a milestone' : problems.join('; ') };
}

export function plantRepairedVerdict(head: string, at: Reflow): Verdict {
  if (at.kind === 'unknown') return { pass: false, detail: `/ at ${head}: ${at.detail}` };
  const gone = [PLANT.title, PLANT.url].filter((s) => !at.html.includes(s));
  if (gone.length > 0) return { pass: false, detail: `the planted book ${PLANT.book} is no longer on / at ${head} (missing ${gone.map((g) => JSON.stringify(g)).join(', ')}): adjudicate by hand` };
  return { pass: at.scrollWidth <= at.viewport, detail: `/ at ${head} lays out ${at.scrollWidth} px wide at ${at.viewport} px, ${PLANT.book} listed` };
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

export function demoServingVerdict(log: M5Log, seen: readonly DemoSeen[], final: DemoFinal | null): Verdict {
  const last = log.demos.at(-1);
  if (last === undefined) return { pass: false, detail: 'no demo-promoted in the log' };
  if (final === null || final.demo === null || typeof final.demo !== 'object') return { pass: false, detail: `the driver's end-of-run status has no demo (${JSON.stringify(final)}): agent G's status.demo` };
  const d = final.demo as { milestone?: unknown; sha?: unknown; where?: unknown };
  const problems: string[] = [];
  if (d.milestone !== last.milestone || d.sha !== last.sha) problems.push(`status.demo is ${d.milestone}@${d.sha}, the latest promotion ${last.milestone}@${last.sha}`);
  const url = demoUrl(d);
  if (url === null || !/^https?:\/\//.test(url)) problems.push(`status.demo.where ${JSON.stringify(d.where)} is no URL`);
  else if (final.probe === null || final.probe.status === null || final.probe.status >= 500) problems.push(`${url} did not serve: ${JSON.stringify(final.probe)}`);
  const urls = [...new Set(seen.map((s) => demoUrl(s.demo)).filter((w) => w !== null))];
  if (urls.length > 1) problems.push(`the demo moved: ${urls.join(' → ')}`);
  return verdict(problems, `${log.demos.length} promotion(s), the latest ${last.milestone}@${last.sha}; ${url} answered ${final.probe?.status}`);
}

// ---------------------------------------------------------------------------------------------------
// Criteria that read the fixture

/** `arc`: the arc under test (null when no arc has a plan); `arcs`: every arc with a journal, in start order. */
type Run = Readonly<{ l: Layout; report: Report; product: AbsPath; arc: string | null; arcs: readonly string[]; ref: ArcRef | null; runDir: AbsPath | null; arcLog: () => ArcLog | null; shape: PlanShape }>;

const needRef = (run: Run): ArcRef => {
  if (run.ref === null) throw new Error('the product has no arc ref');
  return run.ref;
};
const needArcLog = (run: Run): ArcLog => {
  const a = run.arcLog();
  if (a === null) throw new Error('the product has no run dir with a plan in force');
  return a;
};
const needLog = (run: Run): M5Log => needArcLog(run).log;
/** The arc's latest integrated head as its verified ref has it (the latest published `integration.ff`). */
const headOf = (ref: ArcRef): string => {
  const h = ref.view.integrationHead();
  if (h === null) throw new Error(`${ref.arc} has published nothing`);
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

export function sessionStoppedVerdict(report: Pick<Report, 'endedBy' | 'stopReason' | 'failure'>, arc: string | null, arcs: readonly string[], completed: boolean): Verdict {
  const ended = `the session ended ${report.endedBy} (${report.stopReason ?? report.failure})`;
  const problems: string[] = [];
  if (report.endedBy !== 'evidence-complete' && (report.endedBy !== 'stopped' || !['vision-silent', 'k-limit'].includes(report.stopReason ?? ''))) problems.push(ended);
  if (arc === null) return verdict([...problems, 'no arc under test'], ended);
  const at = arcs.indexOf(arc);
  if (at > 0) problems.push(`${arcs.slice(0, at).join(', ')} started before the arc under test ${arc}`);
  const later = arcs.slice(at + 1);
  if (later.length > 0 && !completed) problems.push(`${later.join(', ')} started after ${arc}, which never completed`);
  return verdict(problems, `${ended}; ${arc} under test${later.length === 0 ? '' : `, then ${later.join(', ')} (not graded)`}`);
}

const sessionStopped = (run: Run): Verdict => sessionStoppedVerdict(run.report, run.arc, run.arcs, run.ref !== null && completedHeadOf(run.ref) !== null);

/** The driver's stop rule (log.ts `evidenceComplete`) at the end of the run: m1 grades completion, M5 grades the milestones. */
function milestonesSettled(run: Run): Verdict {
  const a = needArcLog(run);
  const e = evidenceComplete(a.log, a.plan, repairsOf(a));
  return { pass: e.complete, detail: e.detail };
}

const missingRefs = (product: AbsPath) => (commit: string, dirs: readonly string[]): readonly string[] =>
  dirs.filter((d) => git(product, ['ls-tree', '-d', '--name-only', commit, '--', d.replace(/\/$/, '')]).trim() === '');

function polishBounded(run: Run): Verdict {
  const plan = needArcLog(run).plan;
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

type Grade = readonly [string, (run: Run) => Verdict | Promise<Verdict>];

export const CRITERIA: readonly Grade[] = [
  ['isolation', isolation],
  ['session-stopped', sessionStopped],
  ['milestones-settled', milestonesSettled],
  ['milestones-planned', (run) => milestonesPlannedVerdict(run.shape)],
  ['design-first', (run) => designFirstVerdict(run.shape, needLog(run), missingRefs(run.product))],
  ['node-held', (run) => nodeHeldVerdict(run.shape, needLog(run))],
  ['walk-screenshots', (run) => walkScreenshotsVerdict(run.shape, needLog(run), (job) => filesUnder(jobEvidenceRoot(run.runDir!, job as JobId)).filter(isPng))],
  ['plant-caught', (run) => plantCaughtVerdict(run.shape, needLog(run), (sha) => reflowAt(run.product, sha))],
  ['repair-loop', (run) => repairLoopVerdict(needLog(run))],
  ['plant-repaired', async (run) => plantRepairedVerdict(headOf(needRef(run)), await reflowAt(run.product, headOf(needRef(run))))],
  ['polish-bounded', polishBounded],
  ['demo-serving', (run) => demoServingVerdict(needLog(run), run.report.demo.seen, run.report.demo.final)],
  ['skill-vendored', skillVendored],
  ['no-model-ids', (run) => modelIdHits(run.product, run.ref === null ? [] : [run.ref])],
  ['host-released', (run) => hostReleasedVerdict(run.report.released, readClaim(absPath(run.report.hostDir)), run.product)],
  ['profile', profile],
];

export async function check(dir: string): Promise<CheckResult> {
  const l = layout(dir);
  if (!existsSync(l.report)) throw new Error(`${l.report} is missing: run evals/m5/driver.ts first`);
  const report = JSON.parse(readFileSync(l.report, 'utf8')) as Report;
  const product = absPath(l.product);
  const started = arcsStarted(l);
  const planned = started.flatMap((a) => (a.plan === null ? [] : [{ arc: a.arc, shape: planShape(a.plan) }]));
  const underTest = planned.find((a) => a.shape.kind === 'ok') ?? planned[0];
  const arc = underTest === undefined ? null : arcId(underTest.arc);
  const ref = arc === null || !arcsWithRefs(product).includes(arc) ? null : readArcRef(product, arc);
  const dir_ = arc === null ? null : runDir(gitCommonDir(product), arc);
  // Read on first use, so a run dir that does not read fails the criteria that need it, naming why.
  let read: ArcLog | null | undefined;
  const arcLog = (): ArcLog | null => {
    if (read === undefined) read = dir_ === null ? null : readArcLog(dir_, arc!);
    return read;
  };
  const shape: PlanShape = underTest === undefined ? { kind: 'off', problems: ['the arc has no plan in force'] } : underTest.shape;
  const run: Run = { l, report, product, arc, arcs: started.map((a) => a.arc), ref, runDir: dir_, arcLog, shape };
  const criteria: Criterion[] = [];
  for (const [name, grade] of CRITERIA) {
    try {
      criteria.push({ name, ...(await grade(run)) });
    } catch (error) {
      criteria.push({ name, pass: false, detail: `threw: ${(error as Error).message}` });
    }
  }
  return { pass: criteria.every((c) => c.pass), criteria };
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m5/check.ts <dir>');
  const result = await check(resolve(dir));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}
