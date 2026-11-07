import { useEffect, useState } from 'react';
import { AgentDetail } from './history.tsx';
import { Drawer, BackToUnit } from './drawer.tsx';
import { Button } from '../components/ui/button.tsx';
import { get, info } from './shared.tsx';
import type { Envelope } from './types.ts';
type Page = { text: string; after: number; next: number; size: number; identity: string };
export function InvocationDetail(props: { e: Envelope; id: string; close: () => void; stale: boolean }) {
  const activity = props.e.data.console.activities.find(a => a.routeId === props.id);
  return activity?.kind === 'agentic' ? <AgentDetail {...props} activity={activity}/> : <CommandDetail {...props}/>;
}
function CommandDetail({ e, id, close }: { e: Envelope; id: string; close: () => void; stale: boolean }) {
  const activity = e.data.console.activities.find(a => a.routeId === id);
  const [source, setSource] = useState('stdout'), [page, setPage] = useState<Page | null>(null), [error, setError] = useState(''), [result, setResult] = useState<string[] | null>(null);
  const [query,setQuery]=useState('');
  const base = `/arcs/${e.arc}/invocations/${id}`;
  useEffect(() => { const c = new AbortController(); setPage(null); setResult(null); setError(''); get(`${base}/${source === 'result' ? 'result' : `log?source=${source}&after=0`}`, c.signal).then(r => source === 'result' ? setResult(r.data.lines) : setPage(r.data)).catch((err: Error) => { if (!c.signal.aborted) setError(err.message); }); return () => c.abort(); }, [base, source]);
  const load = (after: number) => get(`${base}/log?source=${source}&after=${after}&identity=${page!.identity}`).then(r => setPage(r.data)).catch((err: Error) => setError(err.message));
  return <Drawer title={activity ? info(e, activity).label : `Invocation ${id}`} close={close}>
    {activity && <BackToUnit e={e} unit={activity.unit}/>}
    <div className="log-sources">{['stdout','stderr','runner.log','result'].map(s => <Button key={s} aria-pressed={s === source} onClick={() => setSource(s)}>{s}</Button>)}</div>
    {error && <p role="alert">{error}</p>}{result && <pre className="record">{result.join('\n')}</pre>}
    {page && <section aria-label="Recorded check output"><p className="muted">Text-only recorded output; timestamps and levels are not inferred.</p><p>{activity?.status} <span>Bytes {page.after}–{page.next} of {page.size}</span></p><p className="log-summary"><strong>First output on this page: </strong>{page.text.split("\n")[0]}</p><label className="log-search">Search log lines<input aria-label="Search log lines" value={query} onChange={ev=>setQuery(ev.target.value)}/></label><pre className="record">{query?page.text.split("\n").filter(line=>line.toLowerCase().includes(query.toLowerCase())).join("\n"):page.text}</pre>{page.after > 0 && <Button onClick={() => load(Math.max(0,page.after-65536))}>Show earlier log</Button>}{page.next < page.size && <Button onClick={() => load(page.next)}>Next log page</Button>}</section>}
  </Drawer>;
}
