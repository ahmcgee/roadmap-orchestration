// The in-tree `.roadmap/constraints.md` (DESIGN-1.0.md §2.6, §2.9; M3 step A1): the C-nn ledger with provenance,
// rendered by code from the ledger and sidecars in force. Pure and byte-stable: the same records give the same
// bytes, whatever order the sidecars arrive in.
//
// Every ruling appears in ledger order. A ruling with a sidecar shows its provenance (kind, who ruled, trigger,
// scope, lifetime, supersession, doc refs, contracts, obligations, cites, evidence); one from before M3 has none
// and shows its rule only. A ruling's state is the ledger's: active, partly superseded (a later sidecar supersedes
// a part of it), or withdrawn by a later ruling (superseded when that ruling's sidecar names it).
//
// Retirement (A8, §2.9 "Growth across arcs"): the close-out rendering leaves out arc-lifetime rulings and every
// ruling the ledger has withdrawn; the living rendering keeps them all. The ref keeps them either way.
import type { RulingId } from '../core/ids.ts';
import type { RulingSidecar } from '../holistic/types.ts';
import type { Ruling } from '../spec/rulings.ts';

export type ConstraintsMode = 'living' | 'close-out';

const code = (v: string): string => `\`${v}\``;
/** A bullet whose text may span lines: continuation lines are indented under it. */
const bullet = (indent: string, text: string): string => `${indent}- ${text.split('\n').join(`\n${indent}  `)}`;

function stateLine(r: Ruling, sidecars: readonly RulingSidecar[]): string {
  if (r.status === 'withdrawn') {
    const by = sidecars.find((s) => s.id === r.by);
    return `${by?.supersedes.some((t) => t.id === r.id && t.part === null) === true ? 'superseded' : 'withdrawn'} by ${r.by}`;
  }
  const parts = sidecars.flatMap((s) => s.supersedes.filter((t) => t.id === r.id && t.part !== null).map((t) => `${s.id} (${t.part})`));
  return parts.length === 0 ? 'active' : `active, partly superseded by ${parts.join(', ')}`;
}

function provenance(s: RulingSidecar): readonly string[] {
  const list = (items: readonly string[]): string => (items.length === 0 ? '(none)' : items.join(', '));
  return [
    `kind: ${s.kind}`,
    `ruled by: ${s.ruledBy.type === 'architect' ? 'the architect' : `the checkpoint, ${s.ruledBy.job}`}`,
    `trigger: ${s.trigger}`,
    `applies to: ${s.appliesTo.type === 'arc' ? 'the arc' : `units ${s.appliesTo.units.join(', ')}`}`,
    `lifetime: ${s.lifetime}`,
    ...(s.condition === null ? [] : [`condition: ${s.condition}`]),
    ...(s.supersedes.length === 0 ? [] : [`supersedes: ${s.supersedes.map((t) => (t.part === null ? t.id : `${t.id} (part: ${t.part})`)).join(', ')}`]),
    `doc refs:\n${s.docRefs.map((d) => bullet('', `${code(d.path)} ${code(d.anchor)} (${d.relation}): ${JSON.stringify(d.quotedText)}`)).join('\n')}`,
    `contracts: ${list(s.contractRefs.map(code))}${s.contractOps.length === 0 ? '' : ` (edits ${[...new Set(s.contractOps.map((o) => o.path))].sort().map(code).join(', ')})`}`,
    `obligations: ${list(s.obligations.map((id) => {
      const d = s.obligationDispositions.find((x) => x.id === id);
      return d === undefined ? id : `${id} (${d.disposition})`;
    }))}`,
    `cites: ${list(s.cites)}`,
    ...(s.evidence.length === 0 ? [] : [`evidence:\n${s.evidence.map((e) => bullet('', e)).join('\n')}`]),
  ];
}

/** `constraints.md` from the ledger and sidecars in force; `close-out` retires arc-lifetime and withdrawn rulings. */
export function renderConstraints(ledger: readonly Ruling[], sidecars: readonly RulingSidecar[], mode: ConstraintsMode): string {
  const byId = new Map<RulingId, RulingSidecar>(sidecars.map((s) => [s.id, s]));
  for (const s of sidecars) if (!ledger.some((r) => r.id === s.id)) throw new Error(`constraints: sidecar ${s.id} names no ruling of the ledger`);
  const shown = ledger.filter((r) => mode === 'living' || (r.status === 'active' && byId.get(r.id)?.lifetime !== 'arc'));
  const entries = shown.map((r) => {
    const s = byId.get(r.id);
    const title = r.status === 'active' ? r.text : (s?.statement ?? `withdrawn by ${r.by}`);
    const lines = [`state: ${stateLine(r, sidecars)}`, ...(s === undefined ? ['provenance: none recorded (a ruling from before sidecars)'] : provenance(s))];
    return `## ${r.id} — ${title}\n\n${lines.map((l) => bullet('', l)).join('\n')}`;
  });
  const head = '# Constraints\n\n<!-- Rendered by the roadmap executor from the C-nn ledger and its sidecars; edits are overwritten. -->';
  return `${[head, ...(entries.length === 0 ? ['(no rulings)'] : entries)].join('\n\n')}\n`;
}
