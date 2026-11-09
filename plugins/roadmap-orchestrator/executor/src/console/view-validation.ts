// Runtime boundary for the first UI DTO routes. Does not require a full observation or journal.
import { CONSOLE_PROTOCOL, ConsoleError, type Envelope } from '../observation/protocol.ts';
import { CONSOLE_UI_SCHEMA, type GraphView, type ShellView } from './view-protocol.ts';

type Check = (v: unknown) => boolean;
const str: Check = v => typeof v === 'string';
const bool: Check = v => typeof v === 'boolean';
const nat: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const num: Check = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const date: Check = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullable = (check: Check): Check => v => v === null || check(v);
const array = (check: Check): Check => v => Array.isArray(v) && v.every(check);
function object(fields: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const record = v as Record<string, unknown>;
    return Object.keys(record).every(k => Object.hasOwn(fields, k) || Object.hasOwn(optional, k))
      && Object.entries(fields).every(([k, check]) => Object.hasOwn(record, k) && check(record[k]))
      && Object.entries(optional).every(([k, check]) => !Object.hasOwn(record, k) || check(record[k]));
  };
}
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const dictionary = (check: Check): Check => v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(check);
const scope = object({basis: oneOf('current', 'recorded-arc'), from: nullable(date), to: nullable(date)});
const base = {uiSchema: oneOf(CONSOLE_UI_SCHEMA), viewVersion: (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v), scope};
const detail = object({type: oneOf('unit', 'invocation', 'request', 'event', 'resource'), id: str});
const preview = object({text: str, truncated: bool, detail});
const shell = object({...base,
  identity: object({arc: str}), lifecycle: object({state: str, startedAt: nullable(date), endedAt: nullable(date)}),
  progress: object({total: nat, countsByState: dictionary(nat), merged: nat, withdrawn: nat}),
  spend: object({costUsd: num, estimatedCalls: nat, unavailableCalls: nat}),
  attention: object({total: nat, blocking: nat, informational: nat}), availableRange: object({from: nullable(date), to: nullable(date)}),
});
const edge: Check = v => [
  object({kind: oneOf('after'), source: str, target: str, on: str, met: bool}),
  object({kind: oneOf('milestone'), source: str, target: str, passed: bool}),
  object({kind: oneOf('feeds'), source: str, target: str}),
  object({kind: oneOf('contingent'), target: str, edge: str, condition: preview, resolved: bool}),
].some(check => check(v));
const graph = object({...base,
  units: array(object({id: str, title: str, titleTruncated: bool, signal: oneOf('passed', 'active', 'held', 'pending', 'failed', 'withdrawn'), state: str, stage: str, systems: array(str), lineageRef: nullable(str)})),
  milestones: array(object({id: str, state: str, passed: bool, memberIds: array(str)}, {name: str})),
  edges: array(edge), focus: object({activeIds: array(str), firstUncleared: nullable(str)}),
});
export function validateViewEnvelope<K extends 'shell' | 'graph'>(raw: unknown, kind: K, expected: {instance: string; repoId: string; arc: string}): Envelope<K extends 'shell' ? ShellView : GraphView> {
  const e = raw as Envelope<unknown> | null;
  if (!e || e.protocol !== CONSOLE_PROTOCOL) throw new ConsoleError('protocol', 'console protocol/version mismatch; reload required');
  if (e.instance !== expected.instance || e.repoId !== expected.repoId || e.arc !== expected.arc) throw new ConsoleError('conflict', 'console identity mismatch');
  if (!str(e.epoch) || !nat(e.highWater) || !nat(e.revision) || e.revision < 1 || !date(e.observedAt) || !date(e.checkedAt)
    || !(kind === 'shell' ? shell : graph)(e.data)) throw new ConsoleError('protocol', 'malformed console view or UI schema mismatch; reload required');
  if (kind === 'shell' && (e.data as ShellView).identity.arc !== e.arc) throw new ConsoleError('conflict', 'console shell identity mismatch');
  return e as Envelope<K extends 'shell' ? ShellView : GraphView>;
}
