// The event log (`events.jsonl`) record types, their validators, canonical serialisation and the chain
// hash rule. The journal (append, tail, fold) is step 2 and builds on these. SCHEMAS.md "Event log" is the
// prose twin of this module.
import type { Buffer } from 'node:buffer';
import {
  type ArcId, type CommandId, type InvocationId, type LaneId, type NeedsUserId, type OpId, type OpKey, type ResourceName,
  type RoutingRev, type Sha, type Sha256Hex, type SpecRev, type UnitId, INTEGRATION_SLOT, arcId, commandId,
  invocationIdOf, laneId, needsUserId, opIdOf, opKey, parseOpId, resourceName, routingRev, sha, sha256, specRev, unitId,
} from './ids.ts';
import { canonicalJson, sha256Hex } from './json.ts';
import {
  type ApprovalFingerprint, type BackendOutcomeKind, type CommandVerdict, type ContainmentMode, type DispatchRecord,
  type KillReason, type ResidueRecord, type SpecPatch, type Stage, type TokenUsage, type UsageUnavailableReason, approvalFingerprint,
  containmentMode, dispatchRecord, killReason, specPatch, stage, tokenUsage, usageUnavailableReason,
} from './records.ts';
import {
  type Read, Fields, SchemaError, arrayOf, bool, literal, nat, nullable, object, oneOf, positive, str, tagged, text,
  version,
} from './validate.ts';
import {
  type AbsPath, type GitDate, type IsoTime, type RefName, type RepoPath, type RepoPattern, absPath, gitDate, isoTime,
  refName, repoPath, repoPattern,
} from './values.ts';
import type { SchemaVersion } from './version.ts';
import { type Backend, type Role, backend, role } from '../routing/types.ts';

// ---------------------------------------------------------------------------------------------------
// Op kinds and their payloads

export const OP_KINDS = [
  'worktree.create', 'worktree.remove', 'resource.transition', 'proc.spawn', 'proc.kill', 'evidence.snapshot',
  'salvage.commit', 'mergein.prepare', 'spec.patch', 'candidate.merge', 'integration.ff', 'snapshot.publish',
  'needsuser.raise', 'command.apply',
] as const;
export type OpKind = (typeof OP_KINDS)[number];
export const GIT_OP_KINDS = [
  'worktree.create', 'worktree.remove', 'salvage.commit', 'mergein.prepare', 'candidate.merge', 'integration.ff',
  'snapshot.publish',
] as const satisfies readonly OpKind[];
export type GitOpKind = (typeof GIT_OP_KINDS)[number];

export type Signature = Readonly<{ name: string; email: string; date: GitDate }>;
/**
 * Every input of a commit object the executor creates, so the expected id is reproducible. `gpgsign: false`
 * records the `-c commit.gpgsign=false` the commit is made with. `P` fixes the parent count per kind.
 */
export type CommitInputs<P extends readonly Sha[]> = Readonly<{
  tree: Sha;
  parents: P;
  author: Signature;
  committer: Signature;
  message: string;
  gpgsign: false;
}>;

/** Who holds a reservation: a unit's stage attempt, or a sweep command. */
export type Holder =
  | Readonly<{ type: 'stage'; unit: UnitId; stage: Stage; attempt: number }>
  | Readonly<{ type: 'sweep'; command: CommandId }>;

/**
 * The legal reservation edges: free→reserved, reserved→running, reserved|running→cleaning, cleaning→free,
 * cleaning→cleanup-failed. A `fail` lists one residue per failed resource (exactly the transitioned set).
 */
export type ResourceEdge =
  | Readonly<{ type: 'reserve' }>
  | Readonly<{ type: 'run' }>
  | Readonly<{ type: 'clean'; from: 'reserved' | 'running' }>
  | Readonly<{ type: 'release' }>
  | Readonly<{ type: 'fail'; residues: readonly Readonly<{ resource: ResourceName; teardown: InvocationId }>[] }>;

/** What a spawn runs. Model ids never appear: a backend is named by role and routingRev. */
export type SpawnSubject =
  | Readonly<{ purpose: 'backend'; role: Role; routingRev: RoutingRev; unit: UnitId; attempt: number }>
  | Readonly<{ purpose: 'lane'; unit: UnitId; lane: LaneId; set: 'spec' | 'suite'; at: Sha }>
  | Readonly<{ purpose: 'teardown' | 'probe'; unit: UnitId | null; resource: ResourceName }>
  | Readonly<{
    purpose: 'smoke';
    check: string;
    target: Readonly<{ type: 'backend'; backend: Backend; role: Role; routingRev: RoutingRev }> | Readonly<{ type: 'command' }>;
  }>;

export type WorktreeCheckout =
  | Readonly<{ type: 'branch'; branch: RefName; at: Sha; createBranch: boolean }>
  | Readonly<{ type: 'detached'; at: Sha }>;

/** Recorded inputs and preconditions, per kind. Git kinds record every input of the object they create. */
export type OpExpect = {
  'worktree.create': Readonly<{ path: AbsPath; checkout: WorktreeCheckout }>;
  /** `evidence` is the done evidence.snapshot op whose manifest must be complete before removal. */
  'worktree.remove': Readonly<{ path: AbsPath; evidence: OpId }>;
  /** `resources` in lock order: ascending, `integration-slot` last. */
  'resource.transition': Readonly<{ holder: Holder; resources: readonly ResourceName[]; edge: ResourceEdge }>;
  /** The invocation is `op#ordinal`; launch.json is written after the intent and must hash to `launchSha256`. */
  'proc.spawn': Readonly<{ subject: SpawnSubject; launchSha256: Sha256Hex }>;
  /** `op` scope also kills stray earlier ordinals of the same op. */
  'proc.kill': Readonly<{ inv: InvocationId; scope: 'invocation' | 'op'; reason: KillReason }>;
  'evidence.snapshot': Readonly<{ source: AbsPath; globs: readonly RepoPattern[]; dest: AbsPath }>;
  'salvage.commit': Readonly<{
    worktree: AbsPath;
    branch: RefName;
    old: Sha;
    approvedSetSha256: Sha256Hex;
    rejectedManifestSha256: Sha256Hex;
    commit: CommitInputs<readonly [Sha]>;
  }>;
  'mergein.prepare': Readonly<{
    worktree: AbsPath;
    branch: RefName;
    old: Sha;
    integrationTip: Sha;
    merge:
      | Readonly<{ type: 'clean'; commit: CommitInputs<readonly [Sha, Sha]> }>
      | Readonly<{ type: 'conflicted'; conflicts: readonly RepoPath[] }>;
  }>;
  'spec.patch': Readonly<{ path: AbsPath; oldSha256: Sha256Hex; expectRev: SpecRev; patch: SpecPatch }>;
  'candidate.merge': Readonly<{
    ref: RefName;
    old: Sha | null;
    integrationTip: Sha;
    unitCommit: Sha;
    worktree: AbsPath;
    commit: CommitInputs<readonly [Sha, Sha]>;
  }>;
  'integration.ff': Readonly<{ ref: RefName; old: Sha; new: Sha; fingerprint: ApprovalFingerprint }>;
  'snapshot.publish': Readonly<{
    ref: RefName;
    old: Sha | null;
    highWater: number;
    manifestSha256: Sha256Hex;
    commit: CommitInputs<readonly [] | readonly [Sha]>;
  }>;
  'needsuser.raise': Readonly<{ id: NeedsUserId; path: AbsPath }>;
  'command.apply': Readonly<{ command: CommandId; commandSha256: Sha256Hex }>;
};

/** Expected postconditions beyond what the kind and `expect` already fix; `null` where they fix everything. */
export type OpPost = {
  'worktree.create': null;
  'worktree.remove': null;
  'resource.transition': null;
  'proc.spawn': null;
  'proc.kill': null;
  'evidence.snapshot': Readonly<{ manifest: AbsPath }>;
  'salvage.commit': Readonly<{ new: Sha }>;
  'mergein.prepare': Readonly<{ type: 'clean-merged'; new: Sha }> | Readonly<{ type: 'conflicted' }>;
  'spec.patch': Readonly<{ newSha256: Sha256Hex; newRev: SpecRev }>;
  'candidate.merge': Readonly<{ new: Sha }>;
  'integration.ff': null;
  'snapshot.publish': Readonly<{ new: Sha }>;
  'needsuser.raise': Readonly<{ sha256: Sha256Hex }>;
  'command.apply': null;
};

export type ResultSummary =
  | Readonly<{ type: 'backend'; outcome: BackendOutcomeKind }>
  | Readonly<{ type: 'command'; verdict: CommandVerdict }>;

/** What a done record says happened, per kind. */
export type OpOutcome = {
  'worktree.create': Readonly<{ kind: 'created'; head: Sha }>;
  'worktree.remove': Readonly<{ kind: 'removed' }>;
  'resource.transition': Readonly<{ kind: 'transitioned' }>;
  'proc.spawn':
    | Readonly<{ kind: 'result'; resultSha256: Sha256Hex; summary: ResultSummary }>
    | Readonly<{ kind: 'lost'; treeEffects: boolean }>;
  'proc.kill': Readonly<{ kind: 'quiesced' }>;
  'evidence.snapshot': Readonly<{ kind: 'captured'; manifestSha256: Sha256Hex; files: number }>;
  'salvage.commit': Readonly<{ kind: 'committed' }>;
  'mergein.prepare': Readonly<{ kind: 'clean-merged' }> | Readonly<{ kind: 'conflicted' }> | Readonly<{ kind: 'completed'; head: Sha }>;
  'spec.patch': Readonly<{ kind: 'patched' }>;
  'candidate.merge': Readonly<{ kind: 'merged' }>;
  'integration.ff':
    | Readonly<{ kind: 'published' }>
    | Readonly<{ kind: 'unpublished'; tip: Sha }>
    | Readonly<{ kind: 'recovery-required'; observed: Sha | null }>;
  'snapshot.publish': Readonly<{ kind: 'published' }>;
  'needsuser.raise': Readonly<{ kind: 'raised' }>;
  'command.apply': Readonly<{ kind: 'applied'; receiptSha256: Sha256Hex }> | Readonly<{ kind: 'rejected'; reason: string }>;
};

// ---------------------------------------------------------------------------------------------------
// Records and envelope

export type Parent =
  | Readonly<{ type: 'stage'; unit: UnitId; stage: Stage; attempt: number }>
  | Readonly<{ type: 'command'; command: CommandId }>
  | Readonly<{ type: 'op'; op: OpId }>
  | Readonly<{ type: 'arc' }>;

/** null: closed on the normal path. Otherwise the reconciler disposition that closed it during recovery. */
export type RecoveredBy = null | 'reconciled' | 'redone' | 'adopted';

export type AbortCode = 'precondition' | 'recovery' | 'cancelled';

export type IntentOf<K extends OpKind> = Readonly<{
  type: 'intent';
  op: OpId;
  kind: K;
  key: OpKey;
  parent: Parent;
  ordinal: number;
  /** Absolute; a retry (ordinal > 1) carries its op's original deadline. */
  deadlineAt: IsoTime | null;
  expect: OpExpect[K];
  post: OpPost[K];
}>;
export type IntentRecord = { [K in OpKind]: IntentOf<K> }[OpKind];

export type DoneOf<K extends OpKind> = Readonly<{ type: 'done'; op: OpId; kind: K; outcome: OpOutcome[K]; recoveredBy: RecoveredBy }>;
export type DoneRecord = { [K in OpKind]: DoneOf<K> }[OpKind];

export type AbortRecord = Readonly<{ type: 'abort'; op: OpId; reason: Readonly<{ code: AbortCode; detail: string }> }>;

export type MeterSubject = Readonly<{ unit: UnitId; attempt: number }> | null;
export type Fact =
  | Readonly<{ kind: 'tail-discarded'; offset: number; length: number; sha256: Sha256Hex }>
  | Readonly<{ kind: 'containment-mode'; mode: ContainmentMode }>
  | Readonly<{ kind: 'meter'; inv: InvocationId; role: Role; routingRev: RoutingRev; unit: MeterSubject; usage: TokenUsage }>
  | Readonly<{ kind: 'usage-unavailable'; inv: InvocationId; role: Role; routingRev: RoutingRev; unit: MeterSubject; reason: UsageUnavailableReason }>
  | Readonly<{ kind: 'dispatch'; record: DispatchRecord }>;
export type FactRecord = Readonly<{ type: 'fact'; fact: Fact }>;

export type LogRecord = IntentRecord | DoneRecord | AbortRecord | FactRecord;

/** `prev` is null exactly on seq 1. */
export type Envelope = Readonly<{ v: SchemaVersion; seq: number; prev: Sha256Hex | null; at: IsoTime; arc: ArcId }>;
export type Event = Envelope & LogRecord;

// ---------------------------------------------------------------------------------------------------
// Readers

const shaR: Read<Sha> = (v, p) => sha(v, p);
const sha256R: Read<Sha256Hex> = (v, p) => sha256(v, p);
const absR: Read<AbsPath> = (v, p) => absPath(v, p);
const refR: Read<RefName> = (v, p) => refName(v, p);
const unitR: Read<UnitId> = (v, p) => unitId(v, p);
const opR: Read<OpId> = (v, p) => opIdOf(v, p);
const invR: Read<InvocationId> = (v, p) => invocationIdOf(v, p);
const revR: Read<RoutingRev> = (v, p) => routingRev(v, p);
const resR: Read<ResourceName> = (v, p) => resourceName(v, p);
const cmdR: Read<CommandId> = (v, p) => commandId(v, p);
const specRevR: Read<SpecRev> = (v, p) => specRev(v, p);

const signature: Read<Signature> = object((f) => ({ name: f.get('name', str), email: f.get('email', text), date: f.get('date', (v, p) => gitDate(v, p)) }));

function commitInputs<P extends readonly Sha[]>(parentCount: readonly number[]): Read<CommitInputs<P>> {
  return object((f) => {
    const parents = f.get('parents', arrayOf(shaR));
    if (!parentCount.includes(parents.length)) throw new SchemaError(`${f.path}.parents`, `${parentCount.join(' or ')} parents`, parents);
    return {
      tree: f.get('tree', shaR),
      parents: parents as unknown as P,
      author: f.get('author', signature),
      committer: f.get('committer', signature),
      message: f.get('message', text),
      gpgsign: f.get('gpgsign', literal(false)),
    };
  });
}

function sameList(actual: readonly string[], expected: readonly string[], path: string): void {
  if (actual.length !== expected.length || actual.some((s, i) => s !== expected[i])) {
    throw new SchemaError(path, JSON.stringify(expected), actual);
  }
}

/** Lock order: strictly ascending, except `integration-slot`, which, when present, is last. */
const lockOrder: Read<readonly ResourceName[]> = (value, path) => {
  const list = arrayOf(resR, { nonEmpty: true })(value, path);
  const slot = list.indexOf(INTEGRATION_SLOT);
  if (slot !== -1 && slot !== list.length - 1) throw new SchemaError(path, 'integration-slot last', value);
  const rest = slot === -1 ? list : list.slice(0, -1);
  for (let i = 1; i < rest.length; i++) {
    if (!((rest[i - 1] as string) < (rest[i] as string))) throw new SchemaError(`${path}[${i}]`, 'ascending names, no duplicates', value);
  }
  return list;
};

const holder: Read<Holder> = tagged('type', {
  stage: object((f): Holder => ({ type: f.get('type', literal('stage')), unit: f.get('unit', unitR), stage: f.get('stage', stage), attempt: f.get('attempt', positive) })),
  sweep: object((f): Holder => ({ type: f.get('type', literal('sweep')), command: f.get('command', cmdR) })),
});

const resourceEdge: Read<ResourceEdge> = tagged('type', {
  reserve: object((f): ResourceEdge => ({ type: f.get('type', literal('reserve')) })),
  run: object((f): ResourceEdge => ({ type: f.get('type', literal('run')) })),
  clean: object((f): ResourceEdge => ({ type: f.get('type', literal('clean')), from: f.get('from', oneOf(['reserved', 'running'] as const)) })),
  release: object((f): ResourceEdge => ({ type: f.get('type', literal('release')) })),
  fail: object((f): ResourceEdge => ({
    type: f.get('type', literal('fail')),
    residues: f.get('residues', arrayOf(object((g) => ({ resource: g.get('resource', resR), teardown: g.get('teardown', invR) })), { nonEmpty: true })),
  })),
});

const spawnSubject: Read<SpawnSubject> = tagged('purpose', {
  backend: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('backend')), role: f.get('role', role), routingRev: f.get('routingRev', revR),
    unit: f.get('unit', unitR), attempt: f.get('attempt', positive),
  })),
  lane: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('lane')), unit: f.get('unit', unitR), lane: f.get('lane', (v, p): LaneId => laneId(v, p)),
    set: f.get('set', oneOf(['spec', 'suite'] as const)), at: f.get('at', shaR),
  })),
  teardown: object((f): SpawnSubject => ({ purpose: f.get('purpose', literal('teardown')), unit: f.get('unit', nullable(unitR)), resource: f.get('resource', resR) })),
  probe: object((f): SpawnSubject => ({ purpose: f.get('purpose', literal('probe')), unit: f.get('unit', nullable(unitR)), resource: f.get('resource', resR) })),
  smoke: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('smoke')),
    check: f.get('check', str),
    target: f.get('target', tagged<'backend' | 'command', Extract<SpawnSubject, { purpose: 'smoke' }>['target']>('type', {
      backend: object((g) => ({ type: g.get('type', literal('backend')), backend: g.get('backend', backend), role: g.get('role', role), routingRev: g.get('routingRev', revR) })),
      command: object((g) => ({ type: g.get('type', literal('command')) })),
    })),
  })),
});

const worktreeCheckout: Read<WorktreeCheckout> = tagged('type', {
  branch: object((f): WorktreeCheckout => ({ type: f.get('type', literal('branch')), branch: f.get('branch', refR), at: f.get('at', shaR), createBranch: f.get('createBranch', bool) })),
  detached: object((f): WorktreeCheckout => ({ type: f.get('type', literal('detached')), at: f.get('at', shaR) })),
});

const resultSummary: Read<ResultSummary> = tagged('type', {
  backend: object((f): ResultSummary => ({ type: f.get('type', literal('backend')), outcome: f.get('outcome', oneOf(['success', 'refusal', 'malformed', 'process-fault'] as const)) })),
  command: object((f): ResultSummary => ({ type: f.get('type', literal('command')), verdict: f.get('verdict', oneOf(['pass', 'fail', 'process-fault'] as const)) })),
});

const kindOnly = <K extends string>(kind: K) => object((f) => ({ kind: f.get('kind', literal(kind)) }));
const nothing: Read<null> = literal(null);

type OpSchema<K extends OpKind> = Readonly<{
  expect: Read<OpExpect[K]>;
  post: Read<OpPost[K]>;
  outcome: Read<OpOutcome[K]>;
  /** Cross-field rules between expect and post that the types cannot state. */
  check?: (expect: OpExpect[K], post: OpPost[K], path: string) => void;
}>;

export const OP_SCHEMAS: { readonly [K in OpKind]: OpSchema<K> } = {
  'worktree.create': {
    expect: object((f) => ({ path: f.get('path', absR), checkout: f.get('checkout', worktreeCheckout) })),
    post: nothing,
    outcome: object((f) => ({ kind: f.get('kind', literal('created')), head: f.get('head', shaR) })),
  },
  'worktree.remove': {
    expect: object((f) => ({ path: f.get('path', absR), evidence: f.get('evidence', opR) })),
    post: nothing,
    outcome: kindOnly('removed'),
  },
  'resource.transition': {
    expect: object((f) => ({ holder: f.get('holder', holder), resources: f.get('resources', lockOrder), edge: f.get('edge', resourceEdge) })),
    post: nothing,
    outcome: kindOnly('transitioned'),
    check: (e, _post, path) => {
      if (e.edge.type !== 'fail') return;
      sameList(e.edge.residues.map((r) => r.resource), e.resources, `${path}.expect.edge.residues`);
    },
  },
  'proc.spawn': {
    expect: object((f) => ({ subject: f.get('subject', spawnSubject), launchSha256: f.get('launchSha256', sha256R) })),
    post: nothing,
    outcome: tagged('kind', {
      result: object((f): OpOutcome['proc.spawn'] => ({ kind: f.get('kind', literal('result')), resultSha256: f.get('resultSha256', sha256R), summary: f.get('summary', resultSummary) })),
      lost: object((f): OpOutcome['proc.spawn'] => ({ kind: f.get('kind', literal('lost')), treeEffects: f.get('treeEffects', bool) })),
    }),
  },
  'proc.kill': {
    expect: object((f) => ({ inv: f.get('inv', invR), scope: f.get('scope', oneOf(['invocation', 'op'] as const)), reason: f.get('reason', killReason) })),
    post: nothing,
    outcome: kindOnly('quiesced'),
  },
  'evidence.snapshot': {
    expect: object((f) => ({ source: f.get('source', absR), globs: f.get('globs', arrayOf((v, p) => repoPattern(v, p), { nonEmpty: true })), dest: f.get('dest', absR) })),
    post: object((f) => ({ manifest: f.get('manifest', absR) })),
    outcome: object((f) => ({ kind: f.get('kind', literal('captured')), manifestSha256: f.get('manifestSha256', sha256R), files: f.get('files', nat) })),
  },
  'salvage.commit': {
    expect: object((f) => ({
      worktree: f.get('worktree', absR),
      branch: f.get('branch', refR),
      old: f.get('old', shaR),
      approvedSetSha256: f.get('approvedSetSha256', sha256R),
      rejectedManifestSha256: f.get('rejectedManifestSha256', sha256R),
      commit: f.get('commit', commitInputs<readonly [Sha]>([1])),
    })),
    post: object((f) => ({ new: f.get('new', shaR) })),
    outcome: kindOnly('committed'),
    check: (e, _post, path) => sameList(e.commit.parents, [e.old], `${path}.expect.commit.parents`),
  },
  'mergein.prepare': {
    expect: object((f) => ({
      worktree: f.get('worktree', absR),
      branch: f.get('branch', refR),
      old: f.get('old', shaR),
      integrationTip: f.get('integrationTip', shaR),
      merge: f.get('merge', tagged<'clean' | 'conflicted', OpExpect['mergein.prepare']['merge']>('type', {
        clean: object((g) => ({ type: g.get('type', literal('clean')), commit: g.get('commit', commitInputs<readonly [Sha, Sha]>([2])) })),
        conflicted: object((g) => ({ type: g.get('type', literal('conflicted')), conflicts: g.get('conflicts', arrayOf((v, p) => repoPath(v, p), { nonEmpty: true })) })),
      })),
    })),
    post: tagged('type', {
      'clean-merged': object((f): OpPost['mergein.prepare'] => ({ type: f.get('type', literal('clean-merged')), new: f.get('new', shaR) })),
      conflicted: object((f): OpPost['mergein.prepare'] => ({ type: f.get('type', literal('conflicted')) })),
    }),
    outcome: tagged('kind', {
      'clean-merged': kindOnly('clean-merged'),
      conflicted: kindOnly('conflicted'),
      completed: object((f): OpOutcome['mergein.prepare'] => ({ kind: f.get('kind', literal('completed')), head: f.get('head', shaR) })),
    }),
    check: (e, post, path) => {
      if ((e.merge.type === 'clean') !== (post.type === 'clean-merged')) throw new SchemaError(`${path}.post.type`, `the post matching merge type ${e.merge.type}`, post.type);
      if (e.merge.type === 'clean') sameList(e.merge.commit.parents, [e.old, e.integrationTip], `${path}.expect.merge.commit.parents`);
    },
  },
  'spec.patch': {
    expect: object((f) => ({ path: f.get('path', absR), oldSha256: f.get('oldSha256', sha256R), expectRev: f.get('expectRev', specRevR), patch: f.get('patch', specPatch) })),
    post: object((f) => ({ newSha256: f.get('newSha256', sha256R), newRev: f.get('newRev', specRevR) })),
    outcome: kindOnly('patched'),
    check: (e, post, path) => {
      if (e.patch.expectRev !== e.expectRev) throw new SchemaError(`${path}.expect.patch.expectRev`, String(e.expectRev), e.patch.expectRev);
      if (post.newRev !== e.expectRev + 1) throw new SchemaError(`${path}.post.newRev`, String(e.expectRev + 1), post.newRev);
    },
  },
  'candidate.merge': {
    expect: object((f) => ({
      ref: f.get('ref', refR),
      old: f.get('old', nullable(shaR)),
      integrationTip: f.get('integrationTip', shaR),
      unitCommit: f.get('unitCommit', shaR),
      worktree: f.get('worktree', absR),
      commit: f.get('commit', commitInputs<readonly [Sha, Sha]>([2])),
    })),
    post: object((f) => ({ new: f.get('new', shaR) })),
    outcome: kindOnly('merged'),
    check: (e, _post, path) => {
      if (!/^refs\/roadmap-run\/[^/]+\/candidate\/[^/]+$/.test(e.ref)) throw new SchemaError(`${path}.expect.ref`, 'refs/roadmap-run/<arc>/candidate/<unit>', e.ref);
      sameList(e.commit.parents, [e.integrationTip, e.unitCommit], `${path}.expect.commit.parents`);
    },
  },
  'integration.ff': {
    expect: object((f) => ({ ref: f.get('ref', refR), old: f.get('old', shaR), new: f.get('new', shaR), fingerprint: f.get('fingerprint', approvalFingerprint) })),
    post: nothing,
    outcome: tagged('kind', {
      published: kindOnly('published'),
      unpublished: object((f): OpOutcome['integration.ff'] => ({ kind: f.get('kind', literal('unpublished')), tip: f.get('tip', shaR) })),
      'recovery-required': object((f): OpOutcome['integration.ff'] => ({ kind: f.get('kind', literal('recovery-required')), observed: f.get('observed', nullable(shaR)) })),
    }),
  },
  'snapshot.publish': {
    expect: object((f) => ({
      ref: f.get('ref', refR),
      old: f.get('old', nullable(shaR)),
      highWater: f.get('highWater', positive),
      manifestSha256: f.get('manifestSha256', sha256R),
      commit: f.get('commit', commitInputs<readonly [] | readonly [Sha]>([0, 1])),
    })),
    post: object((f) => ({ new: f.get('new', shaR) })),
    outcome: kindOnly('published'),
    check: (e, _post, path) => {
      if (!/^refs\/roadmap\/[^/]+$/.test(e.ref)) throw new SchemaError(`${path}.expect.ref`, 'refs/roadmap/<arc>', e.ref);
      sameList(e.commit.parents, e.old === null ? [] : [e.old], `${path}.expect.commit.parents`);
    },
  },
  'needsuser.raise': {
    expect: object((f) => ({ id: f.get('id', (v, p): NeedsUserId => needsUserId(v, p)), path: f.get('path', absR) })),
    post: object((f) => ({ sha256: f.get('sha256', sha256R) })),
    outcome: kindOnly('raised'),
  },
  'command.apply': {
    expect: object((f) => ({ command: f.get('command', cmdR), commandSha256: f.get('commandSha256', sha256R) })),
    post: nothing,
    outcome: tagged('kind', {
      applied: object((f): OpOutcome['command.apply'] => ({ kind: f.get('kind', literal('applied')), receiptSha256: f.get('receiptSha256', sha256R) })),
      rejected: object((f): OpOutcome['command.apply'] => ({ kind: f.get('kind', literal('rejected')), reason: f.get('reason', str) })),
    }),
  },
};

const parent: Read<Parent> = tagged('type', {
  stage: object((f): Parent => ({ type: f.get('type', literal('stage')), unit: f.get('unit', unitR), stage: f.get('stage', stage), attempt: f.get('attempt', positive) })),
  command: object((f): Parent => ({ type: f.get('type', literal('command')), command: f.get('command', cmdR) })),
  op: object((f): Parent => ({ type: f.get('type', literal('op')), op: f.get('op', opR) })),
  arc: object((f): Parent => ({ type: f.get('type', literal('arc')) })),
});

const meterSubject: Read<MeterSubject> = nullable(object((f) => ({ unit: f.get('unit', unitR), attempt: f.get('attempt', positive) })));

export const fact: Read<Fact> = tagged('kind', {
  'tail-discarded': object((f): Fact => ({ kind: f.get('kind', literal('tail-discarded')), offset: f.get('offset', nat), length: f.get('length', positive), sha256: f.get('sha256', sha256R) })),
  'containment-mode': object((f): Fact => ({ kind: f.get('kind', literal('containment-mode')), mode: f.get('mode', containmentMode) })),
  meter: object((f): Fact => ({
    kind: f.get('kind', literal('meter')), inv: f.get('inv', invR), role: f.get('role', role), routingRev: f.get('routingRev', revR),
    unit: f.get('unit', meterSubject), usage: f.get('usage', tokenUsage),
  })),
  'usage-unavailable': object((f): Fact => ({
    kind: f.get('kind', literal('usage-unavailable')), inv: f.get('inv', invR), role: f.get('role', role), routingRev: f.get('routingRev', revR),
    unit: f.get('unit', meterSubject), reason: f.get('reason', usageUnavailableReason),
  })),
  dispatch: object((f): Fact => ({ kind: f.get('kind', literal('dispatch')), record: f.get('record', dispatchRecord) })),
});

function intentRecord(f: Fields): IntentRecord {
  const kind = f.get('kind', oneOf(OP_KINDS));
  const schema = OP_SCHEMAS[kind] as OpSchema<OpKind>;
  const out = {
    type: 'intent' as const,
    op: f.get('op', opR),
    kind,
    key: f.get('key', (v, p): OpKey => opKey(v, p)),
    parent: f.get('parent', parent),
    ordinal: f.get('ordinal', positive),
    deadlineAt: f.get('deadlineAt', nullable((v, p): IsoTime => isoTime(v, p))),
    expect: f.get('expect', schema.expect),
    post: f.get('post', schema.post),
  };
  schema.check?.(out.expect, out.post, f.path);
  return out as IntentRecord;
}

function doneRecord(f: Fields): DoneRecord {
  const kind = f.get('kind', oneOf(OP_KINDS));
  return {
    type: 'done',
    op: f.get('op', opR),
    kind,
    outcome: f.get('outcome', (OP_SCHEMAS[kind] as OpSchema<OpKind>).outcome),
    recoveredBy: f.get('recoveredBy', nullable(oneOf(['reconciled', 'redone', 'adopted'] as const))),
  } as DoneRecord;
}

function abortRecord(f: Fields): AbortRecord {
  return {
    type: 'abort',
    op: f.get('op', opR),
    reason: f.get('reason', object((g) => ({ code: g.get('code', oneOf(['precondition', 'recovery', 'cancelled'] as const)), detail: g.get('detail', str) }))),
  };
}

const RECORD_READERS: { readonly [T in LogRecord['type']]: (f: Fields) => LogRecord } = {
  intent: intentRecord,
  done: doneRecord,
  abort: abortRecord,
  fact: (f) => ({ type: 'fact', fact: f.get('fact', fact) }),
};

// ---------------------------------------------------------------------------------------------------
// Lines: canonical JSON + '\n', chained by sha256 of the previous line's exact bytes.

export type ChainEnvelope = Readonly<{ v: SchemaVersion; seq: number; prev: Sha256Hex | null; at: IsoTime }>;
/** One line of the host's residues.jsonl. */
export type ResidueLine = ChainEnvelope & ResidueRecord;

function chainEnvelope(f: Fields): ChainEnvelope {
  const env = { v: f.get('v', version), seq: f.get('seq', positive), prev: f.get('prev', nullable(sha256R)), at: f.get('at', (v, p): IsoTime => isoTime(v, p)) };
  if ((env.seq === 1) !== (env.prev === null)) throw new SchemaError(`${f.path}.prev`, env.seq === 1 ? 'null on seq 1' : 'a sha256 after seq 1', env.prev);
  return env;
}

function jsonLine(line: string, what: string): unknown {
  if (line.includes('\n')) throw new SchemaError(what, 'one line without its terminating newline', line);
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new SchemaError(what, `JSON (${(err as Error).message})`, line);
  }
}

function assertCanonical(parsed: unknown, line: string, what: string): void {
  if (canonicalJson(parsed) !== line) throw new SchemaError(what, 'canonical JSON (sorted keys, no whitespace, known fields only)', line);
}

/** Parses one complete log line, given without its trailing `\n`. Throws on anything but a canonical, valid event. */
export function parseEventLine(line: string): Event {
  const raw = jsonLine(line, 'event');
  const f = new Fields(raw, 'event');
  const env = { ...chainEnvelope(f), arc: f.get('arc', (v, p): ArcId => arcId(v, p)) };
  const type = f.get('type', oneOf(['intent', 'done', 'abort', 'fact'] as const));
  const record = RECORD_READERS[type](f);
  f.end();
  if (record.type === 'intent' || record.type === 'done' || record.type === 'abort') {
    if (parseOpId(record.op).arc !== env.arc) throw new SchemaError('event.op', `an op of arc ${env.arc}`, record.op);
  }
  const event = { ...env, ...record } as Event;
  assertCanonical(event, line, 'event');
  return event;
}

export function serializeEvent(event: Event): string {
  return `${canonicalJson(event)}\n`;
}

/** Parses one complete residues.jsonl line (same chain rules, no `arc` in the envelope). */
export function parseChainLine<T extends object>(line: string, body: Read<T>, what: string): ChainEnvelope & T {
  const raw = jsonLine(line, what);
  const env = chainEnvelope(new Fields(raw, what));
  const { v: _v, seq: _s, prev: _p, at: _a, ...rest } = raw as Record<string, unknown>;
  const out = { ...env, ...body(rest, what) };
  assertCanonical(out, line, what);
  return out;
}

export function serializeChainLine<T extends object>(line: ChainEnvelope & T): string {
  return `${canonicalJson(line)}\n`;
}

/** The `prev` of the next line: sha256 over the previous line's exact bytes, including its `\n`. */
export function prevHash(lineBytes: Buffer): Sha256Hex {
  if (lineBytes.length === 0 || lineBytes[lineBytes.length - 1] !== 0x0a) {
    throw new Error('prevHash: a complete line ends with \\n; refusing to hash a torn line');
  }
  return sha256(sha256Hex(lineBytes));
}
