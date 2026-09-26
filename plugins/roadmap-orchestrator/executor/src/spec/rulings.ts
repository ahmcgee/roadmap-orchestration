// The C-nn ledger (plan `rulings`, relative to the plan dir; DESIGN-1.0.md §2.6): one ruling per line,
// `C-<n> — <rule>`, rule text only (provenance lives in the in-tree constraints.md, not here, because a
// judgment needs the rule and not who ruled it: arc-1 feedback item 13). A superseded or withdrawn ruling
// folds to one line, `C-<n> — withdrawn by C-<m>`, naming a ruling of the same ledger. Blank lines and `#`
// headings are skipped; anything else is refused, and so is an id listed twice (M1 has no supersede
// mechanism beyond the fold).
import { readFileSync } from 'node:fs';
import { type RulingId, rulingId } from '../core/ids.ts';
import { SchemaError } from '../core/validate.ts';

export type Ruling =
  | Readonly<{ id: RulingId; status: 'active'; text: string }>
  | Readonly<{ id: RulingId; status: 'withdrawn'; by: RulingId }>;

const RULING_LINE = /^(C-[0-9]+) — (.+)$/;
const WITHDRAWN = /^withdrawn by (C-[0-9]+)$/;

/** Parses ledger text; `file` only names the ledger in errors. */
export function parseRulings(text: string, file: string): readonly Ruling[] {
  const out = text.split('\n').flatMap((line, i): Ruling[] => {
    if (line.trim() === '' || line.startsWith('#')) return [];
    const m = RULING_LINE.exec(line);
    if (m === null) throw new SchemaError(`${file}:${i + 1}`, 'a ruling line "C-<n> — <rule>"', line);
    const id = rulingId(m[1], `${file}:${i + 1}`);
    const w = WITHDRAWN.exec(m[2]!);
    return [w === null ? { id, status: 'active', text: m[2]! } : { id, status: 'withdrawn', by: rulingId(w[1], `${file}:${i + 1}`) }];
  });
  const ids = out.map((r) => r.id);
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated !== undefined) throw new SchemaError(file, 'each ruling id once (M1 has no supersede beyond the withdrawn fold)', repeated);
  for (const r of out) {
    if (r.status === 'withdrawn' && !ids.includes(r.by)) throw new SchemaError(file, `a withdrawing ruling in the ledger (${r.id})`, r.by);
  }
  return out;
}

export function loadRulings(file: string): readonly Ruling[] {
  return parseRulings(readFileSync(file, 'utf8'), file);
}
