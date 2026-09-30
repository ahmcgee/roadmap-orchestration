// The in-tree `.roadmap/invariants.md` (DESIGN-1.0.md §2.8, §2.9; M3 step A1): the obligations in force, rendered
// by code. Pure and byte-stable.
//
// The human part lists each obligation with its state, activation, statement, doc ref, clauses served, witness,
// delivering units, split family and contracts. The machine part (R2) is one fenced block, info string
// `json roadmap-obligations`, holding the published obligations file as canonical JSON on one line: what the next
// arc's Phase 0 reads from its baseline tree and diffs by I-nn (src/holistic/rederive.ts). Published means
// effective: a latched future obligation is published `must-hold`.
import type { ObligationId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { repoPath } from '../core/values.ts';
import { type ObligationDef, type Obligations, parseObligations } from '../holistic/types.ts';

export const OBLIGATIONS_BLOCK_INFO = 'json roadmap-obligations';

/** Where the rendering lives in the product tree (the docs publication writes it, A2, A8). */
export const INVARIANTS_DOC = repoPath('.roadmap/invariants.md');

const code = (v: string): string => `\`${v}\``;
const list = (items: readonly string[]): string => (items.length === 0 ? '(none)' : items.join(', '));

/** The obligations as published: every latched future obligation is must-hold from its latch on. */
export function publishedObligations(o: Obligations, latched: readonly ObligationId[]): Obligations {
  for (const id of latched) if (!o.obligations.some((x) => x.id === id)) throw new Error(`invariants: latched ${id} is not an obligation in force`);
  return { ...o, obligations: o.obligations.map((x) => (latched.includes(x.id) ? { ...x, activation: 'must-hold' as const } : x)) };
}

function stateText(o: ObligationDef): string {
  const s = o.state;
  switch (s.type) {
    case 'active':
      return 'active';
    case 'split':
      return `split into ${s.children.join(', ')}`;
    case 'waived':
    case 'deferred':
    case 'retired':
      return `${s.type} by ${s.ruling}`;
  }
}

function entry(o: ObligationDef): string {
  const lines = [
    `state: ${stateText(o)}`,
    `activation: ${o.activation}`,
    `rev: ${o.rev}`,
    `doc ref: ${code(o.docRef.path)} ${code(o.docRef.anchor)}: ${JSON.stringify(o.docRef.quotedText)}`,
    `serves: ${list(o.serves)}`,
    `witness: ${o.witness === null ? '(none: a split parent is witnessed through its children)' : `lane ${code(o.witness.lane)}, tests ${o.witness.testIds.map((t) => JSON.stringify(t)).join(', ')}`}`,
    ...(o.deliveredBy.length === 0 ? [] : [`delivered by: ${o.deliveredBy.join(', ')}`]),
    ...(o.parent === undefined ? [] : [`split from: ${o.parent}`]),
    `contracts: ${list(o.contracts.map(code))}`,
  ];
  return `## ${o.id} — ${o.statement.split('\n').join(' ')}\n\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** `invariants.md` for the obligations in force and the latched ones (published must-hold). */
export function renderInvariants(o: Obligations, latched: readonly ObligationId[]): string {
  const published = publishedObligations(o, latched);
  return [
    '# Invariants',
    '<!-- Rendered by the roadmap executor from the obligations in force; edits are overwritten. The JSON block at the end is what the next arc re-derives against. -->',
    `Cut line: ${published.cutLine}`,
    ...(published.obligations.length === 0 ? ['(no obligations)'] : published.obligations.map(entry)),
    `## Published obligations\n\n\`\`\`${OBLIGATIONS_BLOCK_INFO}\n${canonicalJson(published)}\n\`\`\``,
  ].join('\n\n') + '\n';
}

/**
 * The published obligations of an `invariants.md` (R2), or null when it has no block (a first arc, or a file from
 * before M3). More than one block, or a block that does not parse, is refused.
 */
export function parseInvariantsBlock(text: string): Obligations | null {
  const blocks = [...text.matchAll(new RegExp(`^\`\`\`${OBLIGATIONS_BLOCK_INFO}\\n(.*)\\n\`\`\`$`, 'gm'))];
  if (blocks.length > 1) throw new Error(`invariants.md: ${blocks.length} ${OBLIGATIONS_BLOCK_INFO} blocks (exactly one is published)`);
  if (blocks.length === 0) return null;
  return parseObligations(JSON.parse(blocks[0]![1]!));
}
