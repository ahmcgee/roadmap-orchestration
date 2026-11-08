import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { pluralise, Time } from './shared.tsx';
import type { Envelope } from './types.ts';

export function Holistic({e}:{e:Envelope}) {
  const h=e.data.console.presentation.holistic,latest=h.audits.at(-1);
  return <section aria-label="Holistic review"><h3>Holistic review</h3>{h.enabled?<>
    <p>Holistic audit: {h.audit?.running?'Running':latest?latest.outcome==='completed'?'Completed':latest.outcome:'No audit recorded'}. {pluralise(h.activeFindings.length,'active finding')}.</p>
    <Table aria-label="Holistic audits"><thead><TableRow><TableHead>Recorded at</TableHead><TableHead>Audit job</TableHead><TableHead>Outcome</TableHead><TableHead>Coverage and findings</TableHead></TableRow></thead><tbody>{h.audits.map((audit,i)=><TableRow key={i}><td><Time at={audit.at}/></td><td>{audit.job}</td><td>{audit.outcome}</td><td>Holistic audit {audit.outcome}: {pluralise(audit.findings.length,'finding')}<ul>{audit.covered.map((c,j)=><li key={j}>{c.lens}: {c.from} to {c.to}</li>)}</ul></td></TableRow>)}</tbody></Table>
    <h3>Active findings</h3><Table aria-label="Active findings"><thead><TableRow><TableHead>ID</TableHead><TableHead>Claim</TableHead><TableHead>State</TableHead></TableRow></thead><tbody>{h.activeFindings.map(f=><TableRow key={f.id}><td>{f.id}</td><td>{f.claim}</td><td>{f.state}</td></TableRow>)}</tbody></Table>
    <p>{pluralise(h.checkpoint.length,'root decision')} recorded. Checkpoint job detail is not included in this console yet.</p>
    {h.checkpoint.length>0&&<Table aria-label="Root decisions"><thead><TableRow><TableHead>Decision</TableHead><TableHead>Kind</TableHead><TableHead>Ruled by</TableHead></TableRow></thead><tbody>{h.checkpoint.map(d=><TableRow key={d.seq}><td>{d.oneLine}</td><td>{d.kind}</td><td>{d.ruledBy.type}{'role' in d.ruledBy?` ${d.ruledBy.role}`:''}</td></TableRow>)}</tbody></Table>}
  </>:<p>No holistic layer is enabled for this arc.</p>}</section>;
}
