import type { JournalView } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { DEBT_DOC, parseDebtBlock } from '../docs/debt.ts';
import { gitRun } from '../git/git.ts';
import type { InForce, RevisionInForce } from '../input/inforce.ts';
import { arcDebtLedger } from '../pipeline/publish.ts';
import { pretty, type Entry } from './types.ts';

/** Current debt and its published document are distinct, both tied to the observed snapshot. */
export function debtEntries(runDir: AbsPath, view: JournalView, repo: AbsPath | null, force: InForce, revision: RevisionInForce): Entry[] {
  const commit = view.integrationHead() ?? force.plan.baseline;
  const published = repo === null ? null : gitRun(repo, ['cat-file', 'blob', `${commit}:${DEBT_DOC}`], { okCodes: [0, 128] });
  const text = published?.code === 0 ? published.stdout : null;
  const ledger = repo !== null && revision.corpus !== null ? arcDebtLedger({ runDir, repo, journal: { view } })
    : text === null ? null : parseDebtBlock(text);
  const provenance = revision.corpus !== null
    ? `baseline ${force.plan.baseline} · revision ${force.rev} · phase0 sha256 ${revision.corpus.phase0.sha256} · journal seq ${view.highWater()}`
    : `commit ${commit}`;
  const doc: Entry = { id: DEBT_DOC, kind: 'document', label: 'Debt document (published)', state: text === null ? 'unavailable' : 'active',
    description: 'The debt document at the captured integration commit. Current debt may include items not yet published.',
    body: text ?? `# Published debt document\n\nNot present at commit ${commit}.`, provenance: `commit ${commit}`, links: [] };
  if (ledger === null) return [{ id: 'debt', kind: 'debt-ledger', label: repo === null ? 'Debt (unavailable)' : 'Debt (not recorded)', state: 'unavailable',
    description: repo === null ? 'The repository is unavailable.' : 'No structured debt ledger is recorded for this snapshot.',
    body: repo === null ? '# Debt\n\nRepository unavailable; debt could not be read.' : '# Debt\n\nNot recorded for this run.\n\n' + (text === null ? 'No debt document exists at the captured integration commit.' : 'The published document has no structured debt ledger. See Related documents for its text.'), provenance, links: [] }, doc];
  const open = ledger.items.filter((i) => i.state === 'open').length;
  return [{ id: 'debt', kind: 'debt-ledger', label: `Debt (${open} open)`, state: 'active',
    description: ledger.items.length ? `${open} open; ${ledger.items.length - open} promoted or resolved. Current debt includes recorded dispositions and banked items.` : 'No debt recorded in the current ledger.',
    body: pretty({ summary: ledger.items.length ? `${open} open debt items; ${ledger.items.length} retained in total.` : 'No debt recorded.', ...ledger }), provenance, links: [] },
    ...ledger.items.map((item): Entry => ({ id: item.id, kind: 'debt-item', label: `Debt ${item.id}: ${item.what}`, state: item.state,
      description: item.what, body: pretty(item), provenance, links: [] })), doc];
}
