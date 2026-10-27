import { documentLines } from './markdown.ts';
import { label } from './projection.ts';
import { ink, line, wrapProse, type Line } from './terminal.ts';
import { safe } from './text.ts';

// Only executor prompt envelopes are structural. Unknown markup and fenced examples remain literal.
const envelopes = new Set(`documents document document_content source rulings reference_index direction
scope_envelope scope_references risk_floor checkouts lane_programs systems test_lanes design_limits
orientation diff large_diff not_inlined changed delta diagnosis escalation executable_checks
how_your_session_ends job milestones obligations previous_findings prior_attempt proofs_of_concept
refused_proposals rejected_scope_growth specs_only stale_links subagents suite_lanes witness_checks
working_unattended browser`.split(/\s+/));
const entities = (text: string): string => text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name]!);

/** A page-local, inert projection: XML envelopes become headings, content uses Markdown/JSON rendering. */
export function promptLines(body: string, columns: number, ascii: boolean): Line[] {
  const out: Line[] = []; let chunk: string[] = []; let fence: string | null = null; let documentName = '';
  const flush = (): void => {
    if (chunk.length) out.push(...documentLines(chunk.join('\n'), columns, ascii));
    chunk = [];
  };
  const heading = (text: string): void => {
    flush();
    if (out.length) out.push([]);
    out.push(...wrapProse(text, columns).map((text) => line(ink(text, 'accent', true))));
  };
  for (const text of safe(body).replace(/\r/g, '').split('\n')) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (fence) {
      chunk.push(text);
      if (new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(text)) fence = null;
      continue;
    }
    if (mark) { fence = mark[1]!; chunk.push(text); continue; }
    const document = /^<document index="(\d+)">$/.exec(text.trim());
    if (document) { flush(); documentName = `Document ${document[1]}`; continue; }
    const inline = /^<([a-z_]+)>(.*?)<\/\1>$/.exec(text.trim());
    if (inline && envelopes.has(inline[1]!)) {
      heading(`${inline[1] === 'source' && documentName ? documentName + (ascii ? ' | ' : ' · ') : ''}${label(inline[1]!)}: ${entities(inline[2]!)}`);
      if (inline[1] === 'source') documentName = '';
      continue;
    }
    const tag = /^<(\/?)([a-z_]+)>$/.exec(text.trim());
    if (tag && envelopes.has(tag[2]!)) {
      flush();
      if (tag[1] && tag[2] === 'document' && documentName) { heading(documentName); documentName = ''; }
      if (!tag[1] && !['documents', 'document_content'].includes(tag[2]!)) heading(label(tag[2]!));
      continue;
    }
    if (text.trim() && documentName) { heading(documentName); documentName = ''; }
    chunk.push(text);
  }
  if (documentName) heading(documentName);
  flush(); return out;
}
