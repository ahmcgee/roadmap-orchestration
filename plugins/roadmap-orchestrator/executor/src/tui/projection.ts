import { safe } from './text.ts';

export type ProjectionRow = { kind: 'heading' | 'field' | 'text'; text: string };
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const labels: Record<string, string> = {
  acceptance: 'Acceptance criteria', after: 'Depends on', argv: 'Command', cwd: 'Working directory', rev: 'Revision',
  direction: 'Intent', scope: 'Allowed paths', lanes: 'Checks', cites: 'References', clauses: 'Clauses',
  deliveredBy: 'Delivering units', serves: 'Supports vision clauses', advances: 'Advances vision clauses',
  expectedExit: 'Expected exit code', exitCode: 'Exit code', evidenceGlobs: 'Evidence files', env: 'Environment',
  failLoudIfUndelivered: 'Required for completion', integrationBranch: 'Integration branch', baseline: 'Baseline commit',
  architectureDoc: 'Architecture document', worktreeRoot: 'Worktree directory', spec: 'Specification',
  proofJudgment: 'Proof review', structured_output: 'Report', value: 'Report', input_tokens: 'Input tokens',
  output_tokens: 'Output tokens', cache_read_input_tokens: 'Cached input tokens', duration_ms: 'Duration (ms)',
  duration_api_ms: 'API duration (ms)', total_cost_usd: 'Cost (USD)', session_id: 'Session',
  file_path: 'File', old_string: 'Replace', new_string: 'With', is_error: 'Error',
  modelUsage: 'Model usage', resultAvailable: 'Result recorded', v: 'Format version', sha256: 'Content hash',
};
export const label = (key: string): string => Object.hasOwn(labels, key) ? labels[key]! : key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (s) => s.toUpperCase());
const primary = ['decision', 'verdict', 'outcome', 'explanation', 'processOutcome', 'model', 'backend', 'adapter', 'requestedModel', 'summary', 'report', 'direction', 'purpose', 'goal', 'title', 'text', 'clause', 'reason', 'reasons', 'message', 'detail', 'notes', 'acceptance', 'units', 'milestones', 'obligations', 'clauses', 'scope', 'after', 'deliveredBy', 'serves', 'witnesses', 'lanes', 'facts', 'decisions', 'cites', 'contracts', 'rulings', 'architectureDoc', 'suite'];
const metadata = new Set(['schema', 'v', 'rev', 'arc', 'unit', 'id', 'session', 'session_id', 'uuid', 'op', 'inv', 'sha256', 'baseline', 'worktreeRoot', 'routingRev']);
const atom = (value: unknown): boolean => value === null || typeof value !== 'object';
const scalar = (value: unknown): string => value === null ? 'Not recorded' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : safe(String(value));
const empty = (value: unknown): boolean => value === null || value === '' || (Array.isArray(value) && value.length === 0) || (value !== null && typeof value === 'object' && !Object.keys(value).length);

/** A deterministic display projection, never a schema conversion or a change to the recorded values. */
export function project(value: unknown): ProjectionRow[] {
  const out: ProjectionRow[] = [];
  const add = (kind: ProjectionRow['kind'], text: string, depth: number): void => {
    for (const part of safe(text).split('\n')) out.push({ kind, text: '  '.repeat(Math.min(depth, 8)) + part });
  };
  const fields = (obj: Record<string, unknown>, depth: number): void => {
    const keys = Object.keys(obj);
    const priority = (key: string): number => { const i = primary.indexOf(key); return i < 0 ? primary.length : i; };
    const ordered = keys.filter((key) => !metadata.has(key)).sort((a, b) => priority(a) - priority(b));
    const vacant = ordered.filter((key) => obj[key] !== null && typeof obj[key] === 'object' && !Object.keys(obj[key] as object).length);
    for (const key of ordered.filter((key) => !vacant.includes(key))) visit(obj[key], label(key), depth, key);
    if (vacant.length) add('field', `None recorded: ${vacant.map(label).join(', ')}`, depth);
    const extra = keys.filter((key) => metadata.has(key));
    if (extra.length && depth === 0) add('heading', 'Record details', depth);
    for (const key of extra) visit(obj[key], label(key), depth, key);
  };
  const visit = (current: unknown, name: string, depth: number, key = ''): void => {
    if (depth > 16) { add('text', `${name}: deeply nested data (r: raw)`, depth); return; }
    if (atom(current)) { add('field', name ? `${name}: ${scalar(current)}` : scalar(current), depth); return; }
    if (Array.isArray(current)) {
      if (!current.length) { add('field', `${name}: None`, depth); return; }
      if (key === 'argv' && current.every((v) => typeof v === 'string')) {
        // Preserve argument boundaries for display; this command is never executed.
        add('field', `${name}: ${current.map((arg) => /[\s'"\\]/.test(arg as string) ? `'${(arg as string).replace(/'/g, "'\\''")}'` : arg).join(' ')}`, depth); return;
      }
      if (current.every(atom) && current.map(scalar).join(', ').length < 100 && !current.some((v) => String(v).includes('\n'))) {
        add('field', `${name ? name + ': ' : ''}${current.map(scalar).join(', ')}`, depth); return;
      }
      add('heading', `${name || 'Items'} (${current.length})`, depth);
      current.forEach((item, i) => {
        if (atom(item)) { add('text', `- ${scalar(item)}`, depth + 1); return; }
        if (Array.isArray(item)) { visit(item, `Item ${i + 1}`, depth + 1); return; }
        const obj = record(item);
        const identityKey = ['id', 'name', 'unit', 'path'].find((k) => typeof obj[k] === 'string');
        const proseKey = ['clause', 'text', 'summary', 'claim', 'description'].find((k) => typeof obj[k] === 'string');
        const status = typeof obj['state'] === 'string' ? obj['state'] : '';
        const required = obj['failLoudIfUndelivered'] === true;
        const flags = [status, required ? 'required for completion' : ''].filter(Boolean);
        add('text', `- ${identityKey ? scalar(obj[identityKey]) : `Item ${i + 1}`}${flags.length ? ' (' + flags.join(', ') + ')' : ''}${proseKey ? ': ' + scalar(obj[proseKey]) : ''}`, depth + 1);
        fields(Object.fromEntries(Object.entries(obj).filter(([k]) => k !== identityKey && k !== proseKey && !(status && k === 'state') && !(required && k === 'failLoudIfUndelivered'))), depth + 2);
      });
      return;
    }
    const obj = record(current);
    if (!Object.keys(obj).length) { add('field', `${name}: None`, depth); return; }
    if (name) add('heading', name, depth);
    fields(obj, depth + Number(Boolean(name)));
  };
  visit(value, '', 0);
  return out;
}

/** Prose stays prose. JSON documents receive the same projection as structured stream reports. */
export function document(body: string): ProjectionRow[] {
  try { return project(JSON.parse(body)); } catch { return safe(body).split('\n').map((text) => ({ kind: 'text', text })); }
}
export function decodeReport(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
/** Compact activity/selection text prioritises human content rather than the last JSON property. */
export function summary(value: unknown): string {
  value = decodeReport(value);
  if (atom(value)) return scalar(value).replace(/\s+/g, ' ');
  if (Array.isArray(value)) return `${value.length} items`;
  const obj = record(value);
  const parts: string[] = [];
  for (const key of ['decision', 'verdict', 'summary', 'direction', 'goal', 'title', 'clause', 'text', 'message', 'reason', 'detail', 'reasons']) {
    const v = obj[key];
    if (empty(v) || v === undefined) continue;
    if (typeof v === 'string') parts.push(`${['decision', 'verdict'].includes(key) ? label(key) + ': ' : ''}${v}`);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) parts.push(v.join('; '));
    if (parts.length === 2) break;
  }
  if (!parts.length) for (const key of ['acceptance', 'units', 'milestones', 'obligations', 'clauses', 'witnesses', 'lanes']) {
    if (Array.isArray(obj[key])) parts.push(`${obj[key].length} ${label(key).toLowerCase()}`);
  }
  if (!parts.length) return project(obj).filter((r) => r.kind !== 'heading').slice(0, 2).map((r) => r.text.trim()).join(' · ');
  return safe(parts.join(' · ')).replace(/\s+/g, ' ');
}
