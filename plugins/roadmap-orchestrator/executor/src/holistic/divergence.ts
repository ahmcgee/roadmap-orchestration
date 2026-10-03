// Divergences (M3 step B6; DESIGN-1.0.md §2.8; plan "Checkpoint and bundles", A10, OR-V.6, H11, H12, H13): the record
// of every checkpoint act that departs from the target document, an approved obligation or the plan, and of every
// reading of the vision the checkpoint took where the vision is silent. Code computes them; the model never writes one.
//
//   ops              one per op that departs (`opDivergences`): an admit, re-entry, cut, route or limits change departs
//                    from the plan (`plan-departed`, preimage: the plan rev); a spec patch from the unit's spec
//                    (`plan-departed`, preimage: its spec rev); a split or disposition from the obligation's approved
//                    rev (`obligation-departed`, preimage: the obligations' bytes); a landing ruling's contract ops from
//                    the contract text (`contract-departed`) and its `deviates` doc refs from the target document
//                    (`target-departed`), preimage: the ledger and the contracts' blobs. A split that drops parent text
//                    also records `split-dropped` (the apply core's, src/commands/apply.ts). Requests depart from
//                    nothing (they apply nothing).
//   interpretations  one each (`interpretationDivergences`, H12), on a no-op too: `interpretation`, compensation none.
//
// Each carries its preimage (the revisions of exactly the artifacts the act touched, before it) and a compensation
// hint; never an executable inverse (H13): `roadmap reverse <D-n>` builds a fresh compensating revision from the
// preimage at request time (src/commands/reverse.ts). An applied bundle's divergences ride in its revision payload and
// are appended after its `plan-applied` (src/input/inforce.ts `appendRevision`); a no-op's are appended after its
// `bundle-decided{no-op}`, keyed `(job, index)`, so a rewrite after a crash is idempotent (`appendDivergences`).
//
// The digest (H11): one non-blocking `divergence-digest` item binds an explicit id list, every divergence not covered by
// an acknowledged digest and not bound by an open one; it is raised when none is open. Its acknowledgement covers exactly
// those ids; later divergences raise the next digest (`raiseDigest`). The item is raised first and its fact second: a
// crash between them leaves a raised digest item no fact names, whose ids its summary lists; the next call writes its fact.
import type { DivergenceId, JobId, NeedsUserId, Sha, Sha256Hex, UnitId } from '../core/ids.ts';
import { divergenceId } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import type { HolisticFold } from '../core/state.ts';
import type { AbsPath, RepoPath } from '../core/values.ts';
import { raiseNeedsUser, readNeedsUser } from '../needsuser.ts';
import type { BundleOp, CheckpointOutput } from '../prompts/schemas.ts';
import { type DivergenceDraft, type Preimage, type RevisionVector, type RulingSidecar, rulingRefSource } from './types.ts';

/** What a bundle's ops are measured against: the captured vector and the revisions in force when it activates. */
export type DivergenceBase = Readonly<{
  job: JobId;
  /** The plan rev in force at activation (the one the bundle's revision is based on). */
  planRev: number;
  /** Each unit's spec rev in force at activation. */
  specRevs: Readonly<Record<UnitId, number>>;
  obligationsSha256: Sha256Hex | null;
  /** Each obligation's rev in force at activation. */
  obligationRevs: ReadonlyMap<string, number>;
  ledgerSha256: Sha256Hex | null;
  /** A contract's blob at the head the checkpoint read, or null when absent there. */
  blobAt: (path: RepoPath) => Sha | null;
}>;

const planPreimage = (b: DivergenceBase): Preimage => ({ planRev: b.planRev, specs: {}, obligationsSha256: null, ledgerSha256: null, contracts: [] });

/** Restores the recorded revision of what the act touched (`roadmap reverse`); `after` says what refuses it. */
const restore = (what: string, after = ''): DivergenceDraft['compensation'] => ({
  hint: `\`roadmap reverse\` of this divergence restores ${what}${after}; or edit the files in force and \`roadmap apply\``, kind: 'restore-revision',
});

/** A ruling's effect is superseded, never reversed: the ledger and contract text change only by a ruling (A2 choice 8). */
const supersede = (id: string): DivergenceDraft['compensation'] => ({
  hint: `supersede ${id} with \`roadmap rule\` (its contract ops restore the text); \`roadmap reverse\` refuses a ledger or contract preimage`, kind: 'restore-revision',
});

/** The divergence of one op, or none (a request applies nothing; a ruling that departs from nothing records nothing here). */
function ofOp(b: DivergenceBase, op: BundleOp, rulings: ReadonlyMap<string, RulingSidecar>): readonly DivergenceDraft[] {
  const common = { job: b.job, cites: [...op.cites].sort(), evidence: op.evidence };
  const plan = (what: string): DivergenceDraft => ({
    ...common, type: 'plan-departed', from: `plan rev ${b.planRev}`, what, preimage: planPreimage(b), compensation: restore(`plan rev ${b.planRev}`),
  });
  switch (op.op) {
    case 'admit':
      return [plan(`admits ${op.unit.id} (origin ${op.unit.origin}, risk ${op.unit.risk}, scope ${op.unit.scope.join(', ')}${op.unit.after.length === 0 ? '' : `, after ${op.unit.after.join(', ')}`})`)];
    case 'reenter':
      return [plan(`${op.unit} re-enters ${op.reenters}${op.enterAt === null ? '' : ` at ${op.enterAt}`}${op.reset === null ? '' : `, its chargeable failures reset under ${op.reset}`}`)];
    case 'cut':
      return [plan(`cuts ${op.unit}: ${op.reason}`)];
    case 'route':
      return [plan(`routes ${op.unit}: ${op.seats.map((s) => `${s.role}.${s.tier} = ${s.class}`).join(', ')}`)];
    case 'limits':
      return [plan(`sets ${op.unit === null ? 'the arc\'s' : `${op.unit}'s`} limits ${op.limits.map((l) => `${l.field} = ${l.value}`).join(', ')}`)];
    case 'patch-spec': {
      const rev = b.specRevs[op.unit];
      if (rev === undefined) throw new Error(`patch-spec of ${op.unit}, which has no spec in force (validation refuses it)`);
      return [{
        ...common, type: 'plan-departed', from: `spec of ${op.unit} rev ${rev}`, what: `patches ${op.unit}'s spec: ${op.patch.map((p) => (p.op === 'cite' ? 'cite' : `${p.op} ${p.op === 'add' || p.op === 'replace' ? p.item.id : p.id}`)).join(', ')}`,
        preimage: { ...planPreimage(b), specs: { [op.unit]: rev } }, compensation: restore(`${op.unit}'s spec rev ${rev}`, ' (refused once the unit re-opened on the patch and published)'),
      }];
    }
    case 'obligation-split':
    case 'obligation-dispose': {
      const rev = b.obligationRevs.get(op.obligation);
      const what = op.op === 'obligation-split'
        ? `splits ${op.obligation} into ${op.children.map((c) => c.id).join(', ')}`
        : `${op.disposition === 'amended' ? 'authorizes an amendment of' : op.disposition === 'waived' ? 'waives' : op.disposition === 'deferred' ? 'defers' : 'retires'} ${op.obligation} under ${op.ruling}`;
      return [{
        ...common, type: 'obligation-departed', from: `${op.obligation} rev ${rev ?? '?'}`, what,
        preimage: { ...planPreimage(b), obligationsSha256: b.obligationsSha256 }, compensation: restore(`the obligations before ${op.obligation}'s ${op.op === 'obligation-split' ? 'split' : 'disposition'}`),
      }];
    }
    case 'rule': {
      const s = rulings.get(op.ruling);
      if (s === undefined) throw new Error(`rule ${op.ruling}, which the bundle's rulings do not hold (validation refuses it)`);
      const pre = (paths: readonly RepoPath[]): Preimage => ({
        ...planPreimage(b), ledgerSha256: b.ledgerSha256,
        contracts: [...new Set(paths)].sort().flatMap((path) => {
          const blob = b.blobAt(path);
          return blob === null ? [] : [{ path, blob }];
        }),
      });
      // A rule ref is never `deviates` (K19), so only the doc arm departs here.
      const deviations = s.docRefs.map(rulingRefSource).flatMap((d) => (d.kind === 'doc' && d.relation === 'deviates' ? [d] : [])).map((d): DivergenceDraft => ({
        ...common, type: 'target-departed', from: `${d.path}${d.anchor}`, what: `${s.id} deviates from ${JSON.stringify(d.quotedText)}: ${s.statement}`,
        preimage: pre([d.path]), compensation: supersede(s.id),
      }));
      const edits = [...new Set(s.contractOps.map((o) => o.path))].sort().map((path): DivergenceDraft => ({
        ...common, type: 'contract-departed', from: `${path}${s.contractOps.find((o) => o.path === path)!.anchor}`,
        what: `${s.id} edits ${path}: ${s.contractOps.filter((o) => o.path === path).map((o) => `${JSON.stringify(o.oldText)} → ${JSON.stringify(o.newText)}`).join('; ')}`,
        preimage: pre([path]), compensation: supersede(s.id),
      }));
      return [...deviations, ...edits];
    }
    case 'invalidate-approval':
    case 'request':
      return [];
  }
}

/** The divergences a bundle's ops record, in op order (a landing ruling's under its `rule` op). */
export function opDivergences(b: DivergenceBase, ops: readonly BundleOp[], rulings: readonly RulingSidecar[]): readonly DivergenceDraft[] {
  const byId = new Map(rulings.map((s) => [s.id as string, s]));
  return ops.flatMap((op) => ofOp(b, op, byId));
}

/**
 * H12: one `interpretation` divergence per reading of the vision, on a bundle and a no-op alike. Its evidence is what
 * the decision rests on (the findings and observations it cites, else its reasons).
 */
export function interpretationDivergences(job: JobId, vector: RevisionVector, output: CheckpointOutput): readonly DivergenceDraft[] {
  const cited = [...output.cites.findings, ...output.cites.observations.map((k) => `observation ${k.treeSha}/${k.lane}/${k.laneRev}/${k.envId}`)];
  const evidence = cited.length > 0 ? cited : output.reasons;
  return output.interpretations.map((i): DivergenceDraft => ({
    job, type: 'interpretation', from: `the vision (${[...i.clauses].sort().join(', ')})`, what: `${i.situation} Read as: ${i.reading}`,
    cites: [...i.clauses].sort(), evidence,
    preimage: { planRev: vector.plan, specs: {}, obligationsSha256: null, ledgerSha256: null, contracts: [] },
    compensation: { hint: 'a reading where the vision is silent; an architect vision edit (`roadmap apply`) settles it otherwise', kind: 'none' },
  }));
}

/** Appends each of `drafts` not yet recorded, keyed `(job, index)` within its job (H12: a rewrite after a crash is idempotent). */
export function appendDivergences(journal: Journal, drafts: readonly DivergenceDraft[]): void {
  const index = new Map<JobId, number>();
  for (const d of drafts) {
    const i = index.get(d.job) ?? 0;
    index.set(d.job, i + 1);
    if (journal.view.holistic().divergences.some((x) => x.job === d.job && x.index === i)) continue;
    journal.fact({ kind: 'divergence', id: journal.view.nextDivergenceId(), index: i, ...d });
  }
}

// ---------------------------------------------------------------------------------------------------
// The digest (H11)

/** The ids an acknowledged digest covers. */
function covered(view: JournalView): ReadonlySet<DivergenceId> {
  return new Set(view.holistic().digests.filter((d) => view.ackOf(d.needsUser) !== null).flatMap((d) => d.ids));
}

/** Every divergence not covered by an acknowledged digest, ascending (`status.divergences`, the checkpoint's input). */
export function uncoveredDivergences(view: JournalView): HolisticFold['divergences'] {
  const done = covered(view);
  return view.holistic().divergences.filter((d) => !done.has(d.id));
}

/** A raised digest item no `divergence-digest` fact names (a crash between the two), or null. */
function unrecordedDigest(view: JournalView, runDir: AbsPath): NeedsUserId | null {
  const named = new Set(view.holistic().digests.map((d) => d.needsUser));
  const raised = view.opsOf('needsuser.raise').filter((i) => view.doneOf(i.op) !== null && !named.has(i.expect.id));
  return raised.find((i) => readNeedsUser(runDir, i.expect.id)?.reason === 'divergence-digest')?.expect.id ?? null;
}

const DIGEST_IDS = /\bD-[1-9][0-9]*\b/g;

/**
 * Raises the next digest when none is open and some divergence is neither covered nor bound (H11): the item, then its
 * `divergence-digest` fact binding exactly the ids it lists. Returns the item raised (or recorded after a crash), or null.
 */
export function raiseDigest(ctx: Readonly<{ journal: Journal; runDir: AbsPath }>): NeedsUserId | null {
  const view = ctx.journal.view;
  const pending = unrecordedDigest(view, ctx.runDir);
  if (pending !== null) {
    const summary = readNeedsUser(ctx.runDir, pending)!.summary.split('\n')[0]!;
    const ids = [...new Set(summary.match(DIGEST_IDS) ?? [])].map((d) => divergenceId(d, 'digest summary')).sort();
    ctx.journal.fact({ kind: 'divergence-digest', needsUser: pending, ids });
    return pending;
  }
  const fold = view.holistic();
  if (fold.digests.some((d) => view.ackOf(d.needsUser) === null)) return null;
  const bound = new Set(fold.digests.flatMap((d) => d.ids));
  const unbound = fold.divergences.filter((d) => !bound.has(d.id));
  if (unbound.length === 0) return null;
  const ids = unbound.map((d) => d.id).sort();
  const needsUser = raiseNeedsUser(ctx.journal, ctx.runDir, {
    blocking: false,
    subject: { type: 'arc' },
    reason: 'divergence-digest',
    summary: `The checkpoint departed from the target, an obligation or the plan, or read the vision where it is silent: ${ids.join(', ')}.\n${unbound.map((d) => `${d.id} (${d.type}, ${d.job}, cites ${d.cites.join(', ')}): ${d.what} [from ${d.from}]`).join('\n')}`,
    recommendation: 'Review each divergence (`roadmap status` lists them). To undo one that restores a revision, run `roadmap reverse <D-n>`; a product effect is repaired by a unit. Acknowledge this item to cover exactly these ids; later divergences raise the next digest.',
    options: [],
    evidence: [],
  }, { type: 'arc' });
  ctx.journal.fact({ kind: 'divergence-digest', needsUser, ids });
  return needsUser;
}

