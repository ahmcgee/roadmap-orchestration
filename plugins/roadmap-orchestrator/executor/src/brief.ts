// The brief (M4a, OR-Q18, H6, H16, R10; DESIGN §2): everything since the last committed ack, across every arc of the
// chain, as one canonical payload (`roadmap/brief-m4`) hashed whole into its `briefId`, and the Markdown rendered from
// that payload alone. `roadmap brief` (src/commands/brief.ts) prints it and acks it.
//
// Read only, from the verified snapshot refs alone (src/chain.ts `readArcRef`; the chain's head and the PRs are
// src/commands/chain.ts's): what an arc has not published to its ref is not in the brief yet.
//
// - **Since** (H6): the last committed ack (the latest `at`; ties by id) carries a coverage vector `[{arc,
//   snapshotCommit, highWater}]`. An arc's delta is its ref's events after that high-water; an arc absent from the vector
//   starts at seq 0. Nothing else defines a delta. The new vector is, per chained arc, its ref's commit and high-water.
// - **Per arc** (`BriefArc`), from its delta: the divergences and digests; the decisions (`status`'s `decisionsAfter`,
//   read from the ref); the Phase-0 record when a revision in the delta changed it (its curation digest, corpus
//   divergences, questions with their working assumptions, debt dispositions and intake); the debt banked; the
//   checkpoints' intake outcomes; the amendments (`<arc>/M-n`); the pack reviews' notes; the stage timings of the
//   attempts completed in the delta (`status`'s `stageTimings`). Not a delta: the census at the ref (a corpus arc's;
//   `held` = its obligation-state rules whose obligation holds on the arc's integration head, `status`'s rule over the
//   ref's witness records) and the arc's PR now (non-fatal `unavailable`).
// - **Items** (R10): the open (unacknowledged at the ref), non-blocking `divergence-digest` and `convergence-bound`
//   items of every live arc (a run dir in this repo and no done completion in its ref) that no committed ack lists
//   (its `ack` is enqueued, applied or not): what an ack of the brief acknowledges. Blocking items are never acked by a
//   brief.
// - **Chain**: the head's position (1-based), K (`config.chain.k`) and the unacked starts.
// The payload holds no clock; forge state, census figures and timings are in it, so a change of any changes the id.
import { existsSync } from 'node:fs';
import { type ArcRef, committedAcks, completedHeadOf, unackedStarts } from './chain.ts';
import { type ChainLink, chainHead, chainTo, linkOf, prsOf } from './commands/chain.ts';
import { type ArcId, type BriefId, type Sha, amendmentRefOf, briefId, invocationDirName } from './core/ids.ts';
import { canonicalJson, sha256Hex } from './core/json.ts';
import { type CommandBody, needsUserRecord } from './core/records.ts';
import { parseRevisionPayload } from './core/events.ts';
import type { AbsPath } from './core/values.ts';
import { gitCommonDir, gitRun, revParse } from './git/git.ts';
import { observationOf, observationStore } from './holistic/observe.ts';
import { parseObligations } from './holistic/types.ts';
import { OBLIGATIONS_INPUT, PHASE0_INPUT, REVISION_INPUT, RULING_INPUT } from './input/inforce.ts';
import { CliError, runDir } from './input/cli.ts';
import { NEEDS_USER_DIR } from './needsuser.ts';
import { type AckItem, BRIEF_SCHEMA, type BriefArc, type BriefPayload, type BriefPr, type CoverageEntry, parseBriefPayload, parsePhase0Record } from './phase0/types.ts';
import { readRepoConfig } from './preflight/checks.ts';
import { type Decision, censusCounts, decisionsAfter, heldPct, obligationLeaves, stageTimings } from './status.ts';

/** The brief's reasons an ack acknowledges (R10): non-blocking, rendered for a live arc. */
export const ACKED_REASONS = ['divergence-digest', 'convergence-bound'] as const;

export type Brief = Readonly<{ briefId: BriefId; payload: BriefPayload; chainHead: ArcId }>;

/** `briefId` (H16): the first 16 hex of sha256 over the payload's canonical bytes. */
export const briefIdOf = (payload: BriefPayload): BriefId => briefId(sha256Hex(canonicalJson(payload)).slice(0, 16));

/** A blob of the ref's tree, or null when it holds none at `path`. */
function refBlob(repo: AbsPath, ref: ArcRef, path: string): string | null {
  const r = gitRun(repo, ['cat-file', 'blob', `${ref.commit}:${path}`], { okCodes: [0, 128] });
  return r.code === 0 ? r.stdout : null;
}

const factsAfter = (ref: ArcRef, from: number) => ref.events.flatMap((e) => (e.type === 'fact' && e.seq > from ? [e.fact] : []));

/** A decision as one line of the brief. */
function decisionLine(d: Decision): string {
  const by = d.ruledBy;
  const who = by.type === 'architect' ? (by.command === null ? 'architect' : `architect ${by.command}`) : by.type === 'checkpoint' ? by.job : by.type === 'judgment' ? by.role : 'executor';
  return `${d.kind} ${d.id}: ${d.oneLine} (${who})`;
}

/** The Phase-0 record in force at `seq` (the latest revision at or before it), by its sha; undefined without one. */
function phase0At(ref: ArcRef, seq: number): string | undefined {
  let sha: string | undefined;
  for (const e of ref.events) {
    if (e.seq > seq) break;
    if (e.type !== 'fact' || e.fact.kind !== 'plan-applied' || e.fact.payloadSha256 === undefined) continue;
    sha = parseRevisionPayload(JSON.parse(ref.input(e.fact.payloadSha256, REVISION_INPUT).toString('utf8'))).manifest.phase0;
  }
  return sha;
}

/** A corpus arc's census counts at its ref; null outside one. */
function censusAt(repo: AbsPath, ref: ArcRef): BriefArc['census'] {
  const sha = ref.manifest.obligations;
  if (ref.plan.target !== 'corpus' || sha === null) return null;
  const obligations = parseObligations(JSON.parse(ref.input(sha, OBLIGATIONS_INPUT).toString('utf8')));
  if (obligations.census === undefined) return null;
  const head: Sha = ref.view.integrationHead() ?? ref.plan.baseline;
  const tree = revParse(repo, `${head}^{tree}`);
  const store = observationStore(ref.view.holistic().witnessed.filter((w) => w.treeSha === tree).flatMap((w) => {
    const o = observationOf(w, refBlob(repo, ref, `witness/${invocationDirName(w.inv)}.json`));
    return o === null ? [] : [o];
  }));
  const leaf = obligationLeaves(ref.view, obligations, store, tree);
  const defs = new Map(obligations.obligations.map((o) => [o.id, o]));
  return censusCounts(obligations.census, (id) => {
    const o = defs.get(id);
    if (o === undefined) throw new Error(`${ref.arc}: the census names ${id}, which its obligations do not hold`);
    return leaf(o).verdict === 'held';
  });
}

function briefArc(repo: AbsPath, ref: ArcRef, from: number, pr: BriefPr): BriefArc {
  const facts = factsAfter(ref, from);
  const now = ref.manifest.phase0;
  const record = now !== undefined && now !== phase0At(ref, from) ? parsePhase0Record(JSON.parse(ref.input(now, PHASE0_INPUT).toString('utf8'))) : null;
  const decisions = decisionsAfter(ref.view, ref.events, from, {
    payload: (sha) => parseRevisionPayload(JSON.parse(ref.input(sha, REVISION_INPUT).toString('utf8'))),
    ruling: (sha) => ref.input(sha, RULING_INPUT),
    command: (): CommandBody | null => null,
  });
  const inForce = now === undefined ? null : parsePhase0Record(JSON.parse(ref.input(now, PHASE0_INPUT).toString('utf8')));
  return {
    arc: ref.arc,
    slice: inForce === null ? null : inForce.slice,
    divergences: facts.flatMap((f) => (f.kind === 'divergence' ? [{ id: f.id, type: f.type, what: f.what }] : [])),
    digests: facts.flatMap((f) => (f.kind === 'divergence-digest' ? [{ needsUser: f.needsUser, ids: f.ids }] : [])),
    decisions: decisions.map(decisionLine),
    curation: record?.curation ?? [],
    corpusDivergences: record?.corpusDivergences ?? [],
    debt: {
      banked: facts.flatMap((f) => (f.kind === 'debt-banked' ? [{ id: f.id, what: f.what }] : [])),
      dispositioned: record?.debt ?? [],
    },
    intake: [
      ...(record?.intake ?? []).map((x) => ({ issue: x.issue, job: null, outcome: x.outcome })),
      ...facts.flatMap((f) => (f.kind === 'issue-intake' ? [{ issue: f.issue, job: f.job, outcome: f.outcome }] : [])),
    ],
    questions: (record?.questions ?? []).map((q) => ({ id: q.id, rank: q.rank, text: q.text, assumption: q.assumption, state: q.state })),
    amendments: facts.flatMap((f) => (f.kind === 'corpus-amendment' ? [{ id: amendmentRefOf(ref.arc, f.id), rules: f.rules, proposal: f.proposal }] : [])),
    packReviewNotes: facts.flatMap((f) => (f.kind === 'pack-review-ended'
      ? f.findings.flatMap((x) => (x.severity === 'note' ? [{ job: f.job, index: x.index, claim: x.claim }] : [])) : [])),
    census: censusAt(repo, ref),
    timings: stageTimings(ref.events, from),
    pr,
  };
}

/** Whether an ack of `ref`'s items can be applied: its run dir is in this repo and its ref holds no done completion. */
const live = (repo: AbsPath, ref: ArcRef): boolean => existsSync(runDir(gitCommonDir(repo), ref.arc)) && completedHeadOf(ref)?.done !== true;

/** The arc's open, non-blocking digest and convergence-bound items (R10), by the records its ref keeps. */
function itemsOf(repo: AbsPath, ref: ArcRef): readonly AckItem[] {
  return ref.view.needsUser().filter((n) => n.ack === null && !n.blocking).flatMap((n) => {
    const bytes = refBlob(repo, ref, `${NEEDS_USER_DIR}/${n.id}.json`);
    if (bytes === null) throw new Error(`${ref.arc}: its ref keeps no record of the raised item ${n.id}`);
    const reason = needsUserRecord(JSON.parse(bytes), `${ref.arc}:${n.id}`).reason;
    return (ACKED_REASONS as readonly string[]).includes(reason) ? [{ arc: ref.arc, id: n.id }] : [];
  });
}

const itemKey = (i: AckItem): string => `${i.arc}\u0000${i.id}`;
const byKey = <T>(key: (x: T) => string) => (a: T, b: T): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** The brief of the repo's chain now (see the header). */
export function computeBrief(repo: AbsPath): Brief {
  const head = chainHead(repo);
  if (head === null) throw new CliError(`brief: no arc of ${repo} has published a snapshot (refs/roadmap/*)`);
  const chain = chainTo(repo, head);
  const acks = committedAcks(repo);
  const last = [...acks].sort(byKey((a) => `${a.at} ${a.briefId}`)).at(-1);
  const from = new Map((last?.coverage ?? []).map((c) => [c.arc, c.highWater]));
  // An item a committed ack already enqueued an `ack` for is acked, whether or not its executor has applied it yet.
  const enqueued = new Set(acks.flatMap((a) => a.items.map(itemKey)));
  const links: readonly ChainLink[] = chain.map(linkOf);
  const prs = prsOf(repo, links);
  const arcs = [...chain].sort(byKey((r) => r.arc));
  const payload: BriefPayload = {
    schema: BRIEF_SCHEMA,
    coverage: arcs.map((r): CoverageEntry => ({ arc: r.arc, snapshotCommit: r.commit, highWater: r.highWater })),
    items: arcs.filter((r) => live(repo, r)).flatMap((r) => itemsOf(repo, r)).filter((i) => !enqueued.has(itemKey(i))).sort(byKey(itemKey)),
    chain: { position: chain.length, k: readRepoConfig(repo)?.chain?.k ?? null, unackedStarts: unackedStarts(chain.map((r) => r.arc), acks) },
    arcs: arcs.map((r) => briefArc(repo, r, from.get(r.arc) ?? 0, prs.get(r.arc)!)),
  };
  // The payload is what its reader accepts (the frozen schema): a bug here fails loud, never a malformed brief.
  parseBriefPayload(JSON.parse(canonicalJson(payload)));
  return { briefId: briefIdOf(payload), payload, chainHead: head.arc };
}

// ---------------------------------------------------------------------------------------------------
// The Markdown, from the payload alone (H16)

const list = (lines: readonly string[]): string => (lines.length === 0 ? '' : `${lines.map((l) => `- ${l}`).join('\n')}\n`);
const section = (title: string, lines: readonly string[]): string => (lines.length === 0 ? '' : `\n#### ${title}\n\n${list(lines)}`);

function prLine(pr: BriefPr): string {
  switch (pr.type) {
    case 'pr':
      return `PR #${pr.number} (${pr.state}, base ${pr.base}${pr.needsRebase ? ', NEEDS REBASE: its base was squash-merged' : ''}): ${pr.url}`;
    case 'none':
      return 'no PR yet';
    case 'unavailable':
      return `PR unavailable: ${pr.reason}`;
  }
}

function arcMarkdown(a: BriefArc): string {
  const c = a.census;
  const pct = c === null ? null : heldPct(c);
  return `\n### ${a.arc}\n\n${list([
    prLine(a.pr),
    ...(a.slice === null ? [] : [`slice: advances ${a.slice.advances.join(', ')}: ${a.slice.why}`]),
    ...(c === null ? [] : [`census: ${pct === null ? 'no obligation rules' : `${pct}% held`} (${c.held}/${c.obligationRules} obligation rules held; ${c.outOfSlice} out of slice, ${c.untestable} untestable, ${c.prodOnly} prod-only)`]),
  ])}${[
    section('Divergences', a.divergences.map((d) => `${d.id} ${d.type}: ${d.what}`)),
    section('Digests', a.digests.map((g) => `${g.needsUser}: ${g.ids.join(', ')}`)),
    section('Decisions', a.decisions),
    section('Curation', a.curation.map((x) => `${x.tier}: ${x.what} (${x.files.join(', ')}${x.rules.length === 0 ? '' : `; ${x.rules.join(', ')}`})`)),
    section('Corpus divergences', a.corpusDivergences.map((x) => `${x.what} (cites ${x.cites.join(', ')}; preimage ${x.preimage.files.map((f) => f.path).join(', ')})`)),
    section('Questions (working assumptions)', [...a.questions].sort((x, y) => x.rank - y.rank).map((q) => `#${q.rank} ${q.id} ${q.state.type === 'open' ? 'open' : `answered: ${q.state.answer}`}: ${q.text} — assuming: ${q.assumption}`)),
    section('Debt banked', a.debt.banked.map((d) => `${d.id}: ${d.what}`)),
    section('Debt dispositioned', a.debt.dispositioned.map((d) => `${d.id}: ${canonicalJson(d.disposition).trim()}`)),
    section('Issue intake', a.intake.map((x) => `${x.issue} (${x.job ?? 'Phase 0'}): ${canonicalJson(x.outcome).trim()}`)),
    section('Amendments', a.amendments.map((x) => `${x.id}${x.rules.length === 0 ? '' : ` (${x.rules.join(', ')})`}: ${x.proposal}`)),
    section('Pack review notes', a.packReviewNotes.map((n) => `${n.job}#${n.index}: ${n.claim}`)),
    section('Timings', a.timings.map((t) => `${t.stage}: ${t.count} completed, p50 ${Math.round(t.p50Ms / 1000)} s, max ${Math.round(t.maxMs / 1000)} s`)),
  ].join('')}`;
}

/** The brief's Markdown, rendered from `payload` alone. */
export function renderBrief(id: BriefId, payload: BriefPayload): string {
  const ch = payload.chain;
  return `# Roadmap brief ${id}\n\n${list([
    `chain: position ${ch.position}, K ${ch.k ?? 'unset'}, unacked starts: ${ch.unackedStarts.length === 0 ? 'none' : ch.unackedStarts.join(', ')}`,
    `covers: ${payload.coverage.map((c) => `${c.arc} to seq ${c.highWater}`).join(', ')}`,
    `an ack acknowledges: ${payload.items.length === 0 ? 'nothing open' : payload.items.map((i) => `${i.arc}/${i.id}`).join(', ')}`,
    `ack: roadmap brief --repo <repo> --ack ${id}`,
  ])}${payload.arcs.map(arcMarkdown).join('')}`;
}
