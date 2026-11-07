// Console presentation only: the shared decoder's terminal projection stays byte-for-byte intact.
import { decodeTranscript, type TranscriptEvent } from '../tui/transcript.ts';
import { record } from '../tui/projection.ts';

const hiddenSystem = new Set(['thinking_tokens', 'background_tasks_changed', 'task_progress']);
const human = (value: unknown) => String(value ?? 'event').replaceAll('_', ' ').replaceAll('.', ' · ');
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => {
    const p = record(part);
    if (p['type'] === 'text') return String(p['text'] ?? '');
    if (p['type'] === 'image') return '[Image attached]';
    if (p['type'] === 'tool_reference') return `Tool available: ${String(p['tool_name'] ?? '')}`;
    return `[${human(p['type'])}]`;
  }).join('\n');
  return JSON.stringify(value, null, 2) ?? '';
}
export function consoleTranscript(line: string): TranscriptEvent[] {
  const events = decodeTranscript(line);
  let value: unknown; try { value = JSON.parse(line); } catch { return events; }
  const e = record(value), message = record(e['message']);
  if (e['type'] === 'tool_progress') return []; // Heartbeats duplicate the open tool and live indicator.
  if (e['type'] === 'system') {
    const subtype = String(e['subtype']);
    if (hiddenSystem.has(subtype)) return [];
    if (subtype === 'permission_denied') return [{ type: 'error', title: `Permission denied · ${String(e['tool_name'] ?? 'tool')}`,
      text: String(e['decision_reason'] ?? e['message'] ?? 'Tool permission denied'), status: 'failed', legacy: [] }];
    if (['task_started', 'task_notification', 'task_updated'].includes(subtype)) {
      const patch = record(e['patch']);
      const status = e['status'] ?? patch['status'];
      return [{ type: 'handoff', title: `Task ${status ?? (subtype === 'task_started' ? 'started' : 'updated')} · ${String(e['task_id'] ?? '')}`,
        text: contentText(e['description'] ?? e['summary'] ?? '').split('\n')[0]!.slice(0, 180), ...(status === 'failed' || status === 'killed' ? { status: 'failed' as const } : {}), legacy: [] }];
    }
  }
  const content = message['content'] ?? e['content'];
  if (Array.isArray(content)) return events.flatMap((event, i) => {
    const part = record(content[i]);
    if ((part['type'] === 'server_tool_use' && part['name'] === 'advisor') || part['type'] === 'advisor_tool_result') return []; // Encrypted advisor housekeeping; no readable agent action.
    if (part['type'] === 'thinking' && !String(part['thinking'] ?? '').trim()) return []; // Signature-only thinking has no readable text.
    if (part['type'] === 'tool_use') return [{ ...event, input: JSON.stringify(part['input'], null, 2), inputFormat: 'json' as const }];
    if (part['type'] === 'tool_result') return [{ ...event, output: contentText(part['content']) }];
    return [event];
  });
  if (e['type'] === 'result' && !e['is_error']) {
    const report = e['structured_output'] ?? e['result'];
    return events.map(event => ({ ...event, title: 'Agent finished', text: typeof report === 'object' && report !== null ? JSON.stringify(report, null, 2) : typeof report === 'string' ? report : '', report: typeof report === 'object' && report !== null }));
  }
  return events;
}

export type SeatBrief = { mode: string | null; documents: { source: string; content: string }[]; instructions: string };
/** Match documentsXml in prompts/inputs.ts, rather than interpreting arbitrary document Markdown as XML. */
export function parseSeatBrief(prompt: string): SeatBrief {
  let mode: string | null = null;
  const documents: SeatBrief['documents'] = [];
  let instructions = prompt;
  instructions = instructions.replace(/<documents>\n([\s\S]*?)\n<\/documents>/g, (all, body: string) => {
    const pattern = /<document index="\d+">\n<source>([^\n]*)<\/source>\n<document_content>\n([\s\S]*?)\n<\/document_content>\n<\/document>/g;
    let end = 0;
    const parsed: SeatBrief['documents'] = [];
    for (const match of body.matchAll(pattern)) {
      if (body.slice(end, match.index).trim()) return all;
      parsed.push({ source: match[1]!, content: match[2]! }); end = match.index + match[0].length;
    }
    if (body.slice(end).trim()) return all;
    documents.push(...parsed); return '';
  });
  instructions = instructions.replace(/^<mode>([^<\n]+)<\/mode>\s*/m, (_all, value: string) => { mode = value; return ''; });
  return { mode, documents, instructions: instructions.trim() };
}
