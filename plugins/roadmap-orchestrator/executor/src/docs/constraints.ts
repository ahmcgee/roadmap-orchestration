// A deterministic rendering of the plain C-n ledger.
import { repoPath } from '../core/values.ts';
import type { Ruling } from '../spec/rulings.ts';
export type ConstraintsMode = 'living' | 'close-out';
export const CONSTRAINTS_DOC = repoPath('.roadmap/constraints.md');
export function renderConstraints(ledger: readonly Ruling[], mode: ConstraintsMode): string {
  const shown = ledger.filter((r) => mode === 'living' || r.status === 'active');
  const entries = shown.map((r) => `## ${r.id} — ${r.status === 'active' ? r.text : `withdrawn by ${r.by}`}\n\n- state: ${r.status}`);
  return `${['# Constraints', '<!-- Rendered from the plain C-n ledger; edits are overwritten. -->', ...(entries.length ? entries : ['(no rulings)'])].join('\n\n')}\n`;
}
