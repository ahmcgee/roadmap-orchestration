// The scripted root agent of fake M4a runs (`driver --fake <script>`): it stands in for the headless `claude -p` session,
// one process per turn, speaking the same stream-json the driver reads (an init event, a Bash `tool_use` and its
// `tool_result` per command, the final text, a `result`), and keeps its state in `fake/root-state.json`. It follows
// the orchestrate skill's protocol (skills/orchestrate/SKILL.md) and replays the golden Phase-0 outputs (golden.ts)
// through the staged plugin's real CLI (stage-cli.ts, a host dir of the fixture's own):
//
//   turn 1     the issue policy (`roadmap issues`), then the bootstrap questions (K, the first slice)
//   answers    the bootstrap commit on `roadmap-work` (K, the curated corpus, the journeys), arc 1's Phase 0, start
//   wake-ups   `pack-review` (blocking): fix guard's spec, `apply` (a new key: the superseding review); `issue-policy-
//              untrusted`: clear arc 2's run-only and ask the owner to restrict issue creation, then ack on the answer;
//              `run: complete`: `roadmap pr`, the brief (never acked: the owner has acknowledged none), `chain status`,
//              then per script:
//     story          after arc 1, ask the vision-silent cutoff question (P-1); on the answer, the between-arc commit
//                    and arc 2 (run-only cutoff before its start, so notice's admission is the item's to hold); after
//                    arc 2, chain status shows K reached: the fixture still composes arc 3 and shows `phase0 check` and
//                    `start` refuse it `chain-invalid{limit}`, then stops `k-limit`
//     vision-silent  after arc 1, a draft of arc 2 whose `phase0 check` reports no slice candidate: stops `vision-silent`
//
// Every command's failure is loud (the process exits non-zero; the driver records the session failed).
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { amendmentsOf, readArcRef } from '../../src/chain.ts';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { parseDebtBlock } from '../../src/docs/debt.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { type ArcNo, ARC1_CURATION, ARC1_QUESTION, CENSUS_OTHERS, CORPUS_ROOT, DIRECTION, FILES, LANES, MAPPING, OBLIGATIONS, SLICES, UNITS, corpusFor } from './golden.ts';
import { MAIN, layout } from './layout.ts';
import { CHECKPOINT_AMENDMENT } from './scenario.ts';

export const FAKE_SCRIPTS = ['story', 'vision-silent'] as const;
export type FakeScript = (typeof FAKE_SCRIPTS)[number];
export const fakeScript = (v: string): FakeScript => {
  const s = FAKE_SCRIPTS.find((x) => x === v);
  if (s === undefined) throw new Error(`unknown fake script ${JSON.stringify(v)}; one of ${FAKE_SCRIPTS.join(', ')}`);
  return s;
};

const STAGE_CLI = fileURLToPath(new URL('./stage-cli.ts', import.meta.url));
export const ROOT_STATE = 'root-state.json';
export const fakeHostDir = (dir: string): string => join(layout(dir).fake, 'host');
export const arcShims = (dir: string, n: number): string => join(layout(dir).fake, `arc-${n}`, 'bin');

/** The fixture's arc n, unique to its directory (invocation ids key workloads host-wide, as evals/m1/layout.ts). */
export const fakeArc = (dir: string, n: number): string => `m4a-${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12)}-${n}`;

type ArcState = { n: ArcNo; arc: string; inputs: string; baseline: string };
type State = {
  session: string;
  script: FakeScript;
  phase: 'new' | 'bootstrap-asked' | 'running' | 'cutoff-asked' | 'policy-asked' | 'stopped';
  arcs: ArcState[];
  policyItem: string | null;
  packFixed: boolean;
};

// ---------------------------------------------------------------------------------------------------
// stream-json out

type Sink = (event: unknown) => void;
const stdout: Sink = (event) => void process.stdout.write(`${JSON.stringify(event)}\n`);

class Turn {
  readonly session: string;
  readonly dir: string;
  private readonly emit: Sink;
  private n = 0;
  constructor(session: string, dir: string, emit: Sink) {
    this.session = session;
    this.dir = dir;
    this.emit = emit;
    emit({ type: 'system', subtype: 'init', session_id: session });
  }

  /** Runs one command as the agent's Bash tool would, echoing it and its output; `ok` lists the exit codes expected. */
  run(display: string, file: string, args: readonly string[], opts: Readonly<{ cwd?: string; env?: NodeJS.ProcessEnv; ok?: readonly number[] }> = {}): string {
    const id = `toolu_fake_${++this.n}`;
    this.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: display } }] } });
    const r = spawnSync(file, args, { cwd: opts.cwd ?? layout(this.dir).product, env: opts.env ?? process.env, encoding: 'utf8', timeout: 300_000 });
    if (r.error !== undefined) throw r.error;
    const output = `${r.stdout}${r.stderr}`;
    this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
    if (!(opts.ok ?? [0]).includes(r.status ?? -1)) throw new Error(`${display} exited ${r.status}: ${output}`);
    return r.stdout;
  }

  roadmap(args: readonly string[], env?: NodeJS.ProcessEnv, ok?: readonly number[]): string {
    const l = layout(this.dir);
    return this.run(`roadmap ${args.join(' ')}`, process.execPath, [STAGE_CLI, l.plugin, fakeHostDir(this.dir), ...args], { ...(env === undefined ? {} : { env }), ...(ok === undefined ? {} : { ok }) });
  }

  git(...args: string[]): string {
    return this.run(`git ${args.join(' ')}`, 'git', args).trim();
  }

  end(text: string): void {
    this.emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    this.emit({ type: 'result', subtype: 'success', result: text, session_id: this.session });
  }
}

// ---------------------------------------------------------------------------------------------------
// Phase 0 (the golden outputs)

const PASS_PATH = { set: {}, pass: ['PATH'] };
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const writeFile = (path: string, text: string): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

function arcLane(id: string, journey: string) {
  return { id, argv: ['node', '--test', journey], cwd: '.', env: PASS_PATH, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], reporter: 'node-test' };
}

type Pin = Readonly<{ rules: readonly Readonly<{ id: string; textSha256: string }>[] }>;

/** The obligations file of arc n over its pin: the obligations in force (delivered earlier: must-hold), and the census. */
function obligationsOf(n: ArcNo, pin: Pin) {
  const inForce = OBLIGATIONS.filter((o) => o.deliveredIn === null || o.deliveredIn <= n);
  const lanes = LANES.filter((x) => inForce.some((o) => o.lane === x.id)).map((x) => arcLane(x.id, x.journey));
  const revs = new Map(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes, obligations: [], mapping: { paths: [] } }).lanes.map((x) => [x.id as string, laneRevOf(x)]));
  const ref = (id: string) => {
    const r = pin.rules.find((x) => x.id === id);
    if (r === undefined) throw new Error(`arc ${n}'s pin holds no ${id}`);
    return { id, textSha256: r.textSha256 };
  };
  const ids = new Set(inForce.map((o) => o.id));
  return {
    schema: 'roadmap/obligations-m3',
    cutLine: SLICES[n].why,
    lanes,
    obligations: inForce.map((o) => {
      const witness = { lane: o.lane, testIds: [LANES.find((x) => x.id === o.lane)!.test] };
      const future = o.deliveredIn === n;
      return {
        id: o.id, rev: 1, statement: o.statement, rule: ref(o.rule), serves: o.serves, witness,
        proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: revs.get(o.lane), witness },
        deliveredBy: future ? [...o.deliveredBy] : [], activation: future ? 'future' : 'must-hold', contracts: [], state: { type: 'active' },
      };
    }),
    mapping: { paths: MAPPING.map((m) => ({ pattern: m.pattern, obligations: m.obligations.filter((x) => ids.has(x)) })).filter((m) => m.obligations.length > 0) },
    census: pin.rules.map((r) => {
      const o = inForce.find((x) => x.rule === r.id);
      return { rule: r.id, state: o !== undefined ? { type: 'obligation', id: o.id } : { type: CENSUS_OTHERS[r.id] ?? 'out-of-slice' } };
    }),
  };
}

function specOf(u: (typeof UNITS)[number]) {
  return {
    schema: 'roadmap/spec-m1', unit: u.id, rev: 1, scope: u.scope, resources: [], decisions: [],
    lanes: [{ id: u.unitLane.id, argv: ['node', '--test', u.unitLane.file], cwd: '.', env: PASS_PATH, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], state: 'active' }],
    acceptance: u.acceptance.map((clause, i) => ({ id: `A${i + 1}`, clause, failLoudIfUndelivered: true, state: 'active' })),
    facts: [], cites: { contracts: [], rulings: ['C-1'] }, ...(u.obligations.length === 0 ? {} : { obligations: [...u.obligations] }),
  };
}

type Ctx = Readonly<{ t: Turn; dir: string; state: State }>;

/** Reads arc n-1's amendments and the baseline's open debt; dispositions per the golden story. */
function dispositions(c: Ctx, n: ArcNo, previous: ArcState | undefined, baseline: string) {
  if (previous === undefined) return { debt: [], amendments: [] };
  const l = layout(c.dir);
  const ref = readArcRef(absPath(l.product), arcId(previous.arc));
  if (ref === null) throw new Error(`no ref for ${previous.arc}`);
  const amendments = amendmentsOf(ref).map((a) => {
    const fromCheckpoint = n === 2 && a.fact.source.type === 'checkpoint' && a.fact.proposal === CHECKPOINT_AMENDMENT.proposal;
    return { id: a.id, disposition: fromCheckpoint ? { type: 'applied', rules: ['T-16'] } : { type: 'deferred', reason: 'the high-water heights wait for the visiting-yacht scene (V-7)' } };
  });
  const debtMd = c.t.git('show', `${baseline}:.roadmap/debt.md`);
  const ledger = parseDebtBlock(debtMd);
  if (ledger === null) throw new Error('the baseline has no debt block');
  const debt = ledger.items.filter((i) => i.state === 'open').map((i) => ({
    id: i.id,
    disposition: n === 2 && i.bankReason === 'finding-deferred' ? { type: 'promote', unit: 'notice' } : { type: 'keep', reason: 'cosmetic; the harbour has no other name in use yet' },
  }));
  return { debt, amendments };
}

/** Composes arc n's inputs (pin, capture, obligations, specs, ledger, Phase-0 record, plan), its branch, and checks it. */
function composeArc(c: Ctx, n: ArcNo, baseline: string, opts: Readonly<{ answer?: string; previous?: ArcState & { head: string }; draft?: 'vision-silent' }> = {}): ArcState {
  const l = layout(c.dir);
  const arc = fakeArc(c.dir, n);
  const inputs = join(l.inputs, arc);
  mkdirSync(inputs, { recursive: true });
  const pinOut = JSON.parse(c.t.roadmap(['corpus', 'pin', '--repo', l.product, '--commit', baseline, '--baseline', baseline, '--out', join(inputs, 'corpus.json')])) as { pin: Pin };
  const captured = JSON.parse(c.t.roadmap(['issues', '--repo', l.product, '--out', join(inputs, 'issues.json')])) as { sha256: string };
  const capture = JSON.parse(readFileSync(join(inputs, 'issues.json'), 'utf8')) as { issues: readonly { id: string }[] };
  const units = UNITS.filter((u) => (opts.draft === undefined ? u.arc === n : u.id === 'dayview'));
  const obligationsN: ArcNo = opts.draft === undefined ? n : 1;
  const obligations = obligationsOf(obligationsN, pinOut.pin);
  if (opts.draft !== undefined) {
    // The draft carries arc 1's obligations as delivered: everything must-hold, no new obligation.
    for (const o of obligations.obligations) Object.assign(o, { activation: 'must-hold', deliveredBy: [] });
  }
  writeFile(join(inputs, 'obligations.json'), json(obligations));
  for (const u of units) writeFile(join(inputs, `${u.id}.json`), json(specOf(u)));
  writeFile(join(inputs, 'rulings.md'), '# Rulings\n\nC-1 — Product code lives in src/, unit tests in test/unit/, journeys in journeys/.\n');

  let preimage: unknown = null;
  if (n === 1) {
    const seed = c.t.git('rev-parse', MAIN);
    const raw = JSON.parse(c.t.roadmap(['corpus', 'pin', '--repo', l.product, '--commit', seed, '--baseline', seed, '--out', join(inputs, 'preimage.corpus.json')])) as { sha256: string; pin: { files: readonly { path: string; sha256: string }[] } };
    preimage = { pinSha256: raw.sha256, files: raw.pin.files.filter((f) => f.path === '0030_Bookings.md') };
  }
  const { debt, amendments } = dispositions(c, n, opts.previous, baseline);
  const question = n === 1 ? { ...ARC1_QUESTION, state: { type: 'open' } } : { ...ARC1_QUESTION, state: { type: 'answered', answer: opts.answer ?? '(none)', at: '2026-10-03T12:00:00.000Z' } };
  const intake = capture.issues.map((i) => ({
    issue: i.id,
    outcome: n === 1 && i.id === 'issue-1' ? { type: 'acted', on: { type: 'units', ids: ['guard'] } } : { type: 'none', reason: n === 1 ? 'out of this slice: the windows view is not in it' : 'handled in arc 1 (see its intake)' },
  }));
  const slice = opts.draft === 'vision-silent' ? { advances: ['V-4'], why: 'a draft: nothing left to advance' } : SLICES[n];
  writeFile(join(inputs, 'phase0.json'), json({
    schema: 'roadmap/phase0-m4',
    curation: n === 1 ? ARC1_CURATION : [{ tier: 'structural', what: n === 2 ? 'applied arc-1/M-1 as T-16; T-15 replaces T-9 per the owner\'s answer to P-1' : 'added the harbour master\'s day view as T-17', files: n === 2 ? ['0030_Bookings.md', '0040_Notifications.md'] : ['0060_Operations.md'], rules: n === 2 ? ['T-15', 'T-16'] : ['T-17'] }],
    corpusDivergences: n === 1 ? [{ tier: 'semantic', what: 'removed the busy-week override that let the harbour master double-book a berth: V-2 says never', preimage, cites: ['V-2'], rules: ['T-7'] }] : [],
    questions: opts.draft === 'vision-silent' ? [{ ...ARC1_QUESTION, state: { type: 'open' } }] : [question],
    debt, amendments,
    issueCapture: { file: 'issues.json', sha256: captured.sha256 },
    intake, slice,
  }));
  writeFile(join(inputs, 'plan.json'), json({
    schema: 'roadmap/plan-m1', arc, integrationBranch: `arc/${arc}`, baseline, worktreeRoot: l.worktrees,
    contracts: [], rulings: 'rulings.md', corpus: 'corpus.json', phase0: 'phase0.json', direction: DIRECTION,
    suite: { lanes: [{ id: 'suite', argv: ['npm', 'test'], cwd: '.', env: { set: { npm_config_update_notifier: 'false' }, pass: ['PATH', 'HOME'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [] }] },
    resources: [],
    // Arc 2 audits every publication: cutoff's audit is the one whose checkpoint capture meets the flipped policy.
    holistic: { advances: slice.advances, obligations: 'obligations.json', audit: { every: n === 2 ? 1 : 2, lenses: ['vision'] } },
    limits: { convergenceK: 3 },
    units: units.map((u) => ({ id: u.id, spec: `${u.id}.json`, risk: 'low', scope: u.scope, resources: [], after: u.after.filter((a) => units.some((x) => x.id === a)) })),
    ...(opts.previous === undefined ? {} : { chain: { previousArc: opts.previous.arc, previousHead: opts.previous.head } }),
  }));
  c.t.git('branch', `arc/${arc}`, baseline);
  return { n, arc, inputs, baseline };
}

const planOf = (a: ArcState): string => join(a.inputs, 'plan.json');

/** `phase0 check --plan`: its rows and slice candidates. */
function phase0Check(c: Ctx, a: ArcState, ok: readonly number[] = [0]) {
  return JSON.parse(c.t.roadmap(['phase0', 'check', '--repo', layout(c.dir).product, '--plan', planOf(a)], undefined, ok)) as { rows: readonly { kind: string; problem?: unknown }[]; sliceCandidates: readonly string[] };
}

function start(c: Ctx, a: ArcState, ok: readonly number[] = [0]): string {
  const env = { ...process.env, PATH: `${arcShims(c.dir, a.n)}:${process.env['PATH'] ?? ''}` };
  return c.t.roadmap(['start', '--repo', layout(c.dir).product, '--plan', planOf(a), '--profile', 'default'], env, ok);
}

/** Writes arc n's curated corpus over the working tree's (paths under the corpus root). */
function writeCorpus(c: Ctx, n: ArcNo): void {
  const l = layout(c.dir);
  rmSync(join(l.product, CORPUS_ROOT), { recursive: true, force: true });
  for (const [p, text] of Object.entries(corpusFor(n))) writeFile(join(l.product, CORPUS_ROOT, p), text);
}

/** The single between-arc commit on `head` (OR-L7): the next arc's corpus edits; returns the baseline. */
function betweenArc(c: Ctx, next: ArcNo, head: string): string {
  c.t.git('switch', '--quiet', '-c', `work/${fakeArc(c.dir, next)}`, head);
  writeCorpus(c, next);
  c.t.git('add', '--all');
  c.t.git('commit', '--quiet', '--allow-empty', '-m', `between arcs: the corpus for arc ${next}`);
  return c.t.git('rev-parse', 'HEAD');
}

const completedHead = (c: Ctx, a: ArcState): string => {
  const s = JSON.parse(c.t.roadmap(['status', '--repo', layout(c.dir).product, '--arc', a.arc])) as { completion: { head: string | null; active: boolean } };
  if (s.completion.head === null || !s.completion.active) throw new Error(`${a.arc} has no active completion: ${JSON.stringify(s.completion)}`);
  return s.completion.head;
};

// ---------------------------------------------------------------------------------------------------
// Turns

const RUNNING = (a: ArcState) => `Arc ${a.arc} is running. No Monitor here: ending the turn; resume me on the next roadmap watch event.`;

/** The bootstrap commit (K, the curated corpus, the journeys) and arc 1's Phase 0, checked green; not started. */
function bootstrapArc1(c: Ctx, k: string): ArcState {
  const l = layout(c.dir);
  c.t.git('switch', '--quiet', '-c', 'roadmap-work', MAIN);
  writeFile(join(l.product, '.roadmap', 'config.json'), json({ chain: { k: Number(k) } }));
  writeCorpus(c, 1);
  cpSync(join(FILES, 'golden', 'journeys'), join(l.product, 'journeys'), { recursive: true });
  c.t.git('add', '--all');
  c.t.git('commit', '--quiet', '-m', 'bootstrap: K, the curated corpus (rules T-1..T-14) and the journeys');
  const a = composeArc(c, 1, c.t.git('rev-parse', 'HEAD'));
  phase0Check(c, a);
  return a;
}

/**
 * Tests: the bootstrap and arc 1's inputs in a fresh fixture (staged plugin and fake shims in place), as the story's
 * second turn writes them, without starting; returns arc 1's plan file. Its commands' events go to `sink`.
 */
export function prepareArc1(dir: string, sink: Sink = () => {}): string {
  const state: State = { session: 'prepare', script: 'story', phase: 'bootstrap-asked', arcs: [], policyItem: null, packFixed: false };
  return planOf(bootstrapArc1({ t: new Turn(state.session, dir, sink), dir, state }, '1'));
}

function bootstrap(c: Ctx, answer: string): string {
  const k = /K\s*=\s*(\d+)/.exec(answer)?.[1];
  if (k === undefined) throw new Error(`the owner's answer names no K: ${answer}`);
  const a = bootstrapArc1(c, k);
  c.state.arcs.push(a);
  start(c, a);
  c.state.phase = 'running';
  return RUNNING(a);
}

type WatchLine = Readonly<{ event: string; id?: string; reason?: string; run?: string }>;
const watchLines = (prompt: string): readonly WatchLine[] =>
  prompt.split('\n').filter((x) => x.trim().startsWith('{')).map((x) => JSON.parse(x) as WatchLine);

function onWake(c: Ctx, prompt: string): string {
  const lines = watchLines(prompt);
  const current = c.state.arcs.at(-1)!;
  const l = layout(c.dir);
  for (const w of lines) {
    if (w.event === 'needs-user' && w.reason === 'pack-review' && !c.state.packFixed) {
      // The finding is right: guard's spec gains the clause, and the changed pack is reviewed again.
      const path = join(current.inputs, 'guard.json');
      const spec = JSON.parse(readFileSync(path, 'utf8')) as { rev: number; acceptance: { id: string; clause: string; failLoudIfUndelivered: boolean; state: string }[] };
      spec.rev += 1;
      spec.acceptance.push({ id: `A${spec.acceptance.length + 1}`, clause: 'A refused booking writes nothing: the ledger file is unchanged.', failLoudIfUndelivered: true, state: 'active' });
      writeFile(path, json(spec));
      c.t.roadmap(['apply', '--repo', l.product, '--arc', current.arc]);
      c.state.packFixed = true;
      return `The pack review's blocking finding on guard was right: guard's spec now says a refused booking writes nothing (rev 2), applied; the changed pack is reviewed again. ${RUNNING(current)}`;
    }
    if (w.event === 'needs-user' && w.reason === 'issue-policy-untrusted') {
      // The arc-wide hold, as status shows it while the item is open; then notice may run as far as admission goes.
      const holds = (JSON.parse(c.t.roadmap(['status', '--repo', l.product, '--arc', current.arc])) as { holds: readonly string[] }).holds;
      if (!holds.includes('issue-policy-untrusted')) throw new Error(`the open issue-policy-untrusted item holds nothing: holds ${JSON.stringify(holds)}`);
      c.t.roadmap(['run-only', '--clear', '--repo', l.product, '--arc', current.arc]);
      c.state.policyItem = w.id ?? null;
      c.state.phase = 'policy-asked';
      return [
        'The forge now lets anyone open issues on this public repo (PUBLIC + ALL): the checkpoint will not read issues until that is fixed, and admission is held meanwhile.',
        '',
        '1. Please restrict issue creation to collaborators (or disable issues), then tell me. Working assumption: the arc stays held until you do.',
      ].join('\n');
    }
    if (w.event === 'units' && w.run === 'complete') return arcComplete(c, current);
  }
  return `Nothing for me in this wake-up. ${RUNNING(current)}`;
}

function arcComplete(c: Ctx, a: ArcState): string {
  const l = layout(c.dir);
  c.t.roadmap(['pr', '--repo', l.product, '--arc', a.arc]);
  c.t.roadmap(['brief', '--repo', l.product]);
  const chain = JSON.parse(c.t.roadmap(['chain', 'status', '--repo', l.product])) as { k: number | null; unackedStarts: readonly string[] };
  const head = completedHead(c, a);
  if (c.state.script === 'vision-silent') {
    const baseline = betweenArc(c, 2, head);
    const draft = composeArc(c, 2, baseline, { previous: { ...a, head }, draft: 'vision-silent' });
    const report = phase0Check(c, draft, [0, 78]);
    if (report.sliceCandidates.length > 0) throw new Error(`vision-silent script: phase0 check offers ${report.sliceCandidates.join(', ')}`);
    c.state.phase = 'stopped';
    return `Arc ${a.arc} completed; its PR is open against main. phase0 check offers no slice candidate: every world clause of the vision is served and held.\nPlease merge the PR into main with a merge commit.\nROADMAP-SESSION: stopped vision-silent`;
  }
  if (a.n === 1) {
    c.state.phase = 'cutoff-asked';
    return [
      `Arc ${a.arc} completed and its PR is open against main. I chain the next arc (V-5, when plans change) unless you say otherwise.`,
      '',
      `1. ${ARC1_QUESTION.text} Working assumption: ${ARC1_QUESTION.assumption}`,
    ].join('\n');
  }
  if (chain.k === null || chain.unackedStarts.length < chain.k) throw new Error(`story: after arc 2 the chain should be at K: ${JSON.stringify(chain)}`);
  // K is reached. The fixture shows the executor's own refusal too: arc 3's inputs, refused at check and at start.
  const baseline = betweenArc(c, 3, head);
  const three = composeArc(c, 3, baseline, { previous: { ...a, head }, answer: 'see P-1' });
  const report = phase0Check(c, three, [78]);
  if (report.rows.length !== 1 || report.rows[0]?.kind !== 'chain-invalid') throw new Error(`story: arc 3's phase0 check should refuse only chain-invalid: ${JSON.stringify(report.rows)}`);
  start(c, three, [78]);
  c.state.phase = 'stopped';
  return `Arc ${a.arc} completed; its PR is stacked on arc ${c.state.arcs[0]!.arc}'s. ${chain.unackedStarts.length} start(s) are unacknowledged and K is ${chain.k}: I stop here.\nPlease merge the stacked PRs in order, the first into main, each with a merge commit.\nROADMAP-SESSION: stopped k-limit`;
}

function arc2(c: Ctx, answer: string): string {
  if (!/48/.test(answer)) throw new Error(`story: the owner's answer to P-1 should be 48 hours: ${answer}`);
  const one = c.state.arcs[0]!;
  const head = completedHead(c, one);
  const l = layout(c.dir);
  const baseline = betweenArc(c, 2, head);
  const a = composeArc(c, 2, baseline, { answer: answer.replace(/^\s*1\.\s*/, '').trim(), previous: { ...one, head } });
  c.state.arcs.push(a);
  phase0Check(c, a);
  // notice waits behind cutoff (run-only), so its admission comes after the first checkpoint's capture.
  mkdirSync(join(l.product, '.git', 'roadmap-runtime', a.arc), { recursive: true });
  c.t.roadmap(['run-only', 'cutoff', '--repo', l.product, '--arc', a.arc]);
  start(c, a);
  c.state.phase = 'running';
  return `P-1 answered (48 hours): T-15 replaces T-9 in the between-arc commit, and arc-1/M-1 is applied as T-16. Arc 2 advances V-5. ${RUNNING(a)}`;
}

function turn(c: Ctx, prompt: string): string {
  const l = layout(c.dir);
  switch (c.state.phase) {
    case 'new':
      c.t.roadmap(['issues', '--repo', l.product]);
      c.state.phase = 'bootstrap-asked';
      return [
        'The issue policy is trusted. The corpus guide and the confirmed vision are committed already; two things before the first arc:',
        '',
        '1. How many arcs may I run past your last acknowledged brief before I stop and wait (K)? Working assumption: 1.',
        `2. Do you accept ${SLICES[1].advances.join(' and ')} as the first slice (${SLICES[1].why})? Working assumption: yes.`,
      ].join('\n');
    case 'bootstrap-asked':
      return bootstrap(c, prompt);
    case 'running':
      return onWake(c, prompt);
    case 'cutoff-asked':
      return arc2(c, prompt);
    case 'policy-asked': {
      const a = c.state.arcs.at(-1)!;
      if (c.state.policyItem === null) throw new Error('no policy item to ack');
      c.t.roadmap(['ack', c.state.policyItem, '--repo', l.product, '--arc', a.arc]);
      c.state.policyItem = null;
      c.state.phase = 'running';
      return `The owner restricted issue creation; acked the item, so the checkpoint captures issues again. ${RUNNING(a)}`;
    }
    case 'stopped':
      throw new Error('the session has stopped');
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  const dir = flag('--fixture');
  const script = flag('--script');
  const sep = argv.indexOf('--');
  if (dir === undefined || script === undefined || sep < 0) throw new Error('usage: fake-root.ts --fixture <dir> --script <script> [--resume <session>] -- <prompt>');
  const prompt = argv.slice(sep + 1).join(' ');
  const statePath = join(layout(dir).fake, ROOT_STATE);
  const resume = flag('--resume');
  let state: State;
  if (resume === undefined) {
    if (existsSync(statePath)) throw new Error(`${statePath} exists: a fresh session in a used fixture`);
    state = { session: randomUUID(), script: fakeScript(script), phase: 'new', arcs: [], policyItem: null, packFixed: false };
  } else {
    state = JSON.parse(readFileSync(statePath, 'utf8')) as State;
    if (state.session !== resume) throw new Error(`resume ${resume}, but the session is ${state.session}`);
  }
  const t = new Turn(state.session, dir, stdout);
  const text = turn({ t, dir, state }, prompt);
  writeFileSync(statePath, json(state));
  t.end(text);
}
