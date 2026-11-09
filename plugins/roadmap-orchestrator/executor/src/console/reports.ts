// Selected-detail enrichment. The legacy snapshot adapter explicitly calls the sweep below;
// independent view projections never depend on retained agent results.
import { join } from 'node:path';
import { invocationDir } from '../pipeline/invoke.ts';
import { invocationIdOf, parseInvocationId } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { record } from '../tui/projection.ts';
import { readEvidence } from './evidence.ts';

type Terminal = Extract<import('../core/events.ts').Event, {type: 'done'; kind: 'proc.spawn'}>;
const parsedReports = new Map<string, {report: Record<string, unknown> | null; bytes: number}>();
let retainedBytes = 0;
function readReport(e: Envelope, inv: import('../tui/types.ts').Invocation | undefined, terminal: Terminal | undefined): Record<string, unknown> | null {
  if (!inv) throw new ConsoleError('not-found', 'invocation is not recorded in this arc');
  if (inv.execution !== 'agent') return null;
  const id = inv.id;
  if (terminal?.type !== 'done' || terminal.kind !== 'proc.spawn' || terminal.outcome.kind !== 'result') return null;
  let bytes: Buffer;
  try { bytes = readEvidence(e.data.display.run.runDir, join(invocationDir(e.data.display.run.runDir, invocationIdOf(id)), 'result.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (sha256Hex(bytes) !== terminal.outcome.resultSha256) throw new ConsoleError('invalid', 'retained agent report does not match its recorded digest');
  // Evidence is checked on every use, including cache hits. Pruning and changed bytes stay observable.
  const key = terminal.outcome.resultSha256, cached = parsedReports.get(key);
  if (cached) { parsedReports.delete(key); parsedReports.set(key, cached); return cached.report; }
  const result = record(JSON.parse(bytes.toString('utf8'))), outcome = record(result['outcome']);
  const report = result['type'] === 'backend' && outcome['kind'] === 'success' ? record(outcome['value']) : null;
  if (bytes.length <= 2 * 1024 * 1024) {
    freeze(report); parsedReports.set(key, {report, bytes: bytes.length}); retainedBytes += bytes.length;
    while (retainedBytes > 2 * 1024 * 1024 || parsedReports.size > 16) {
      const first = parsedReports.keys().next().value!; retainedBytes -= parsedReports.get(first)!.bytes; parsedReports.delete(first);
    }
  }
  return report;
}
function freeze(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push(child);
      Object.freeze(item);
    }
  }
}
export function retainedReport(e: Envelope, id: string): Record<string, unknown> | null {
  const {op} = parseInvocationId(invocationIdOf(id));
  const terminal = e.data.events.find((ev): ev is Terminal => ev.type === 'done' && ev.kind === 'proc.spawn' && ev.op === op);
  return readReport(e, e.data.display.invocations.find(i => i.id === id), terminal);
}
export function enrichReports(e: Envelope, invocations: readonly import('../tui/types.ts').Invocation[] = e.data.display.invocations) {
  const reports = new Map<string, Record<string, unknown>>();
  const terminals = new Map(e.data.events.flatMap(ev => ev.type === 'done' && ev.kind === 'proc.spawn' ? [[String(ev.op), ev] as const] : []));
  for (const inv of invocations) if (inv.execution === 'agent') {
    const report = readReport(e, inv, terminals.get(parseInvocationId(invocationIdOf(inv.id)).op)); if (report) reports.set(inv.id, report);
  }
  return reports;
}
