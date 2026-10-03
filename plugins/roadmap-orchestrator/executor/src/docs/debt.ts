// The in-tree `.roadmap/debt.md` (DESIGN-1.0.md §2.9; M4a step A4): the debt ledger, rendered by code. Pure and
// byte-stable. The human part lists each item; the machine part is one fenced block, info string `json roadmap-debt`,
// holding the ledger as canonical JSON on one line: what the next arc's Phase 0 reads from its baseline tree.
import { canonicalJson } from '../core/json.ts';
import { repoPath } from '../core/values.ts';
import { DEBT_FENCE, type DebtItem, type DebtLedger, parseDebtLedger } from '../debt/types.ts';

/** Where the rendering lives in the product tree (the docs publication writes it). */
export const DEBT_DOC = repoPath('.roadmap/debt.md');

function historyLine(h: DebtItem['history'][number]): string {
  const d = h.disposition;
  const text = d.type === 'keep' ? `keep (${JSON.stringify(d.reason)})` : d.type === 'promote' ? `promote to ${d.unit}` : `resolve by ${d.ruling}`;
  return `${h.arc}: ${text}`;
}

function entry(i: DebtItem): string {
  const lines = [`state: ${i.state}`, `reason: ${i.bankReason}`, `origin: ${i.originArc}`, `unit: ${i.unit ?? '(none)'}`, ...i.history.map(historyLine)];
  return `## ${i.id} — ${i.what.split('\n').join(' ')}\n\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** `debt.md` for a ledger. */
export function renderDebt(ledger: DebtLedger): string {
  return [
    '# Debt',
    "<!-- Rendered by the roadmap executor from the debt ledger; edits are overwritten. The JSON block at the end is what the next arc's Phase 0 dispositions. -->",
    ...(ledger.items.length === 0 ? ['(no debt)'] : ledger.items.map(entry)),
    `## Ledger\n\n\`\`\`${DEBT_FENCE}\n${canonicalJson(ledger)}\n\`\`\``,
  ].join('\n\n') + '\n';
}

/** The ledger of a `debt.md`, or null when it has no block. More than one block, or one that does not parse, is refused. */
export function parseDebtBlock(text: string): DebtLedger | null {
  const blocks = [...text.matchAll(new RegExp(`^\`\`\`${DEBT_FENCE}\\n(.*)\\n\`\`\`$`, 'gm'))];
  if (blocks.length > 1) throw new Error(`debt.md: ${blocks.length} ${DEBT_FENCE} blocks (exactly one is published)`);
  if (blocks.length === 0) return null;
  return parseDebtLedger(JSON.parse(blocks[0]![1]!));
}
