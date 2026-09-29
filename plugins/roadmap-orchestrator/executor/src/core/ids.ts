// Branded identifiers. Each id has one constructor that checks its textual form and throws
// InvalidIdError otherwise, so an unchecked string can never reach a place that wants an id. The forms
// are recorded in SCHEMAS.md ("Ids").
import { type Brand, SchemaError } from './validate.ts';

export class InvalidIdError extends SchemaError {
  readonly idKind: string;
  constructor(idKind: string, path: string, form: string, value: unknown) {
    super(path, `${idKind} (${form})`, value);
    this.name = 'InvalidIdError';
    this.idKind = idKind;
  }
}

type IdReader<T> = (value: unknown, path?: string) => T;

function textual<B extends string>(kind: B, pattern: RegExp, form: string): IdReader<Brand<string, B>> {
  return (value, path = kind) => {
    if (typeof value !== 'string' || !pattern.test(value)) throw new InvalidIdError(kind, path, form, value);
    return value as Brand<string, B>;
  };
}

// Slugs are safe as git ref components and file names: lowercase, digits, inner hyphens.
const SLUG = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?';
const SLUG_FORM = 'lowercase letters, digits and inner hyphens, 1-64 chars';
const POS = '[1-9][0-9]{0,14}'; // ≤ 15 digits stays a safe integer
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ArcId = Brand<string, 'ArcId'>;
export const arcId: IdReader<ArcId> = textual('ArcId', new RegExp(`^${SLUG}$`), SLUG_FORM);

export type UnitId = Brand<string, 'UnitId'>;
export const unitId: IdReader<UnitId> = textual('UnitId', new RegExp(`^${SLUG}$`), SLUG_FORM);

export type ResourceName = Brand<string, 'ResourceName'>;
export const resourceName: IdReader<ResourceName> = textual('ResourceName', new RegExp(`^${SLUG}$`), SLUG_FORM);
/** The built-in serial resource. Never declared by a plan; always reserved last. */
export const INTEGRATION_SLOT = resourceName('integration-slot');

export type LaneId = Brand<string, 'LaneId'>;
export const laneId: IdReader<LaneId> = textual('LaneId', /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'a letter then letters, digits, _ . -, 1-64 chars');

/** Acceptance clauses, decisions and facts in a spec. */
export type ClauseId = Brand<string, 'ClauseId'>;
export const clauseId: IdReader<ClauseId> = textual('ClauseId', /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'a letter then letters, digits, _ . -, 1-64 chars');

export type RulingId = Brand<string, 'RulingId'>;
export const rulingId: IdReader<RulingId> = textual('RulingId', /^C-[0-9]+$/, 'C-<digits>');

export type Sha = Brand<string, 'Sha'>;
export const sha: IdReader<Sha> = textual('Sha', /^[0-9a-f]{40}$/, '40 lowercase hex');

/** Content hash of bytes (files, log lines, manifests). */
export type Sha256Hex = Brand<string, 'Sha256Hex'>;
export const sha256: IdReader<Sha256Hex> = textual('Sha256Hex', /^[0-9a-f]{64}$/, '64 lowercase hex');

export type RoutingRev = Brand<string, 'RoutingRev'>;
export const routingRev: IdReader<RoutingRev> = textual('RoutingRev', /^[0-9a-f]{16}$/, '16 lowercase hex');

/** One seat's resolved triple, hashed: records compare seats across routing revisions without a model id. */
export type SeatRev = Brand<string, 'SeatRev'>;
export const seatRev: IdReader<SeatRev> = textual('SeatRev', /^[0-9a-f]{16}$/, '16 lowercase hex');

export type CommandId = Brand<string, 'CommandId'>;
export const commandId: IdReader<CommandId> = textual('CommandId', /^cmd-[0-9a-f]{16}$/, 'cmd-<16 lowercase hex>');

export type JudgmentSessionId = Brand<string, 'JudgmentSessionId'>;
export const judgmentSessionId: IdReader<JudgmentSessionId> = textual('JudgmentSessionId', UUID, 'lowercase uuid');

export type ImplementerSessionId = Brand<string, 'ImplementerSessionId'>;
export const implementerSessionId: IdReader<ImplementerSessionId> = textual('ImplementerSessionId', UUID, 'lowercase uuid');

/** Groups the ops that must not overlap (≤1 open intent per key). Printable, no whitespace. */
export type OpKey = Brand<string, 'OpKey'>;
export const opKey: IdReader<OpKey> = textual('OpKey', /^[A-Za-z0-9._:/#@+=-]{1,256}$/, 'printable ASCII without whitespace, 1-256 chars');

export type SpecRev = Brand<number, 'SpecRev'>;
export function specRev(value: unknown, path = 'SpecRev'): SpecRev {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidIdError('SpecRev', path, 'an integer >= 1', value);
  }
  return value as SpecRev;
}

/** The plan in force's revision: 1 for the first plan an arc ran, one more per applied change (`plan-applied`). */
export type PlanRev = Brand<number, 'PlanRev'>;
export function planRev(value: unknown, path = 'PlanRev'): PlanRev {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidIdError('PlanRev', path, 'an integer >= 1', value);
  }
  return value as PlanRev;
}

// OpId = `<arc>/<seq>`: seq is the event-log seq of the op's first intent, so op ids are unique per arc
// and allocated by the journal with no separate counter.
export type OpId = Brand<string, 'OpId'>;
const OP = new RegExp(`^(${SLUG})/(${POS})$`);
export const opIdOf: IdReader<OpId> = textual('OpId', OP, '<arc>/<seq>');

export function opId(arc: ArcId, seq: number): OpId {
  return opIdOf(`${arc}/${seq}`);
}

export function parseOpId(op: OpId): { readonly arc: ArcId; readonly seq: number } {
  const m = OP.exec(op);
  if (m === null) throw new InvalidIdError('OpId', 'OpId', '<arc>/<seq>', op);
  return { arc: m[1] as ArcId, seq: Number(m[2]) };
}

// InvocationId = `<op>#<ordinal>`: ordinal 1 is the op's first intent, each retry intent increments it.
export type InvocationId = Brand<string, 'InvocationId'>;
const INV = new RegExp(`^(${SLUG}/${POS})#(${POS})$`);
export const invocationIdOf: IdReader<InvocationId> = textual('InvocationId', INV, '<arc>/<seq>#<ordinal>');

export function invocationId(op: OpId, ordinal: number): InvocationId {
  return invocationIdOf(`${op}#${ordinal}`);
}

export function parseInvocationId(inv: InvocationId): { readonly op: OpId; readonly ordinal: number } {
  const m = INV.exec(inv);
  if (m === null) throw new InvalidIdError('InvocationId', 'InvocationId', '<arc>/<seq>#<ordinal>', inv);
  return { op: m[1] as OpId, ordinal: Number(m[2]) };
}

/** The invocation's directory name under `<runDir>/inv/`: `<seq>-<ordinal>` (the arc is the run dir's). */
export function invocationDirName(inv: InvocationId): string {
  const { op, ordinal } = parseInvocationId(inv);
  return `${parseOpId(op).seq}-${ordinal}`;
}

// NeedsUserId forms: `nu-<seq>` (raised by the needsuser.raise op with that seq), `sup-<generation>-<n>`
// (supervisor crash limit, written without a journal), `host-<slug>` (host-level refusals such as a
// corrupt log, written before the journal is usable).
export type NeedsUserId = Brand<string, 'NeedsUserId'>;
export const needsUserId: IdReader<NeedsUserId> = textual(
  'NeedsUserId',
  new RegExp(`^(?:nu-${POS}|sup-${POS}-${POS}|host-${SLUG})$`),
  'nu-<seq> | sup-<generation>-<n> | host-<slug>',
);

export function needsUserIdForOp(op: OpId): NeedsUserId {
  return needsUserId(`nu-${parseOpId(op).seq}`);
}

export function supervisorNeedsUserId(generation: number, n: number): NeedsUserId {
  return needsUserId(`sup-${generation}-${n}`);
}

export function hostNeedsUserId(slug: string): NeedsUserId {
  return needsUserId(`host-${slug}`);
}
