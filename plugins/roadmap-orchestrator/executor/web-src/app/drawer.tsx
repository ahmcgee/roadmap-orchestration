import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { Clock, elapsed, glyph, info, link, money, pluralise, route, SignalMark, Time } from './shared.tsx';
import type { Envelope } from './types.ts';

export function Drawer({ title, close, children, className = '' }: { title: string; close: () => void; children?: ReactNode; className?: string }) {
  const panel = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() => { try { return Math.max(360, Math.min(960, Number(localStorage.getItem('roadmap.drawer-width')) || 520)); } catch { return 520; } });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('[aria-label="Close details"]')?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); previous?.focus({ preventScroll: true }); };
  }, []);
  function resize(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => { const next = Math.max(360, Math.min(innerWidth - 80, innerWidth - event.clientX)); setWidth(next); try { localStorage.setItem('roadmap.drawer-width', String(next)); } catch { /* Storage can be disabled. */ } };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true });
  }
  return <aside ref={panel} role="dialog" aria-modal="false" aria-labelledby="detail-title" className={`drawer ${className}`} style={{ width }}>
    <div className="drawer-resize" role="separator" aria-label="Resize details" aria-orientation="vertical" tabIndex={0} onPointerDown={resize} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { const next = Math.max(360, Math.min(960, width + (e.key === 'ArrowLeft' ? 40 : -40))); setWidth(next); try { localStorage.setItem('roadmap.drawer-width', String(next)); } catch {} } }}/>
    <header className="drawer-head"><h2 id="detail-title">{title}</h2><Button variant="ghost" size="icon" onClick={close} aria-label="Close details"><X size={18}/></Button></header>
    <div className="drawer-body">{children}</div>
  </aside>;
}
function Intent({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="intent"><h3>Intent</h3><div className={expanded ? '' : 'intent-collapsed'}>{text.split(/(`[^`]+`|(?:[\w@.*{}-]+\/)+[^\s,;]+|\b[\w*-]+\.(?:[cm]?[jt]sx?|json|md|css|html|ya?ml)\b|\b(?:contract|spec):[\w:#./-]+)/g).map((part, i) => i % 2 ? <code key={i}>{part.replace(/^`|`$/g, '')}</code> : part)}</div>{text.length > 180 && <Button variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less intent' : 'Show full intent'}</Button>}</section>;
}
export function UnitDetail({ e, id, close }: { e: Envelope; id: string; close: () => void; stale?: boolean }) {
  const now=useContext(Clock);
  const [housekeeping,setHousekeeping] = useState(false);
  const m = e.data.console, u = m.presentation.units.find(v => v.id === id);
  const gate = e.data.display.status.milestones.find(v => `milestone:${v.id}` === id);
  if (gate) return <Drawer title={`Milestone ${gate.id}`} close={close}><p>{gate.passed ? 'Gate passed' : 'Gate not passed'} {gate.state}</p><p>{e.data.plan?.milestones?.find(v => v.id === gate.id)?.text}</p></Drawer>;
  if (!u) return <Drawer title="Unit unavailable" close={close}><p>This unit is absent from the applied plan.</p></Drawer>;
  const activities = m.activities.filter(a => a.unit === id), signal = m.graph.units.find(v => v.id === id)!.status;
  const feeds = e.data.plan?.milestones?.filter(g => g.units.includes(id as never)) ?? [];
  const waits = e.data.display.status.edges.filter(edge => edge.type === 'milestone' && edge.unit === id);
  return <Drawer title={u.title} close={close}>
    <div className="unit-meta"><span>{id}</span><span><SignalMark state={signal}/>{u.state}</span><span>{u.stage}</span></div>
    <dl className="unit-gates"><div><dt>Feeds</dt><dd>{feeds.map(g => g.id).join(', ') || 'No milestone'}</dd></div><div><dt>Waits on</dt><dd>{waits.map(g => g.type === 'milestone' ? g.milestone : '').join(', ') || 'No milestone gates'}</dd></div></dl>
    <div className="unit-facts"><span>{u.rounds} {u.rounds===1?'round':'rounds'}</span><span>{pluralise(u.attempts,'stage attempt')}</span><span>{money(u.spend)} recorded</span><span>{elapsed(u.startedAt&&!u.endedAt&&!m.presentation.run.endedAt?now-Date.parse(u.startedAt):u.elapsedMs)}</span></div>
    {u.reasons.length > 0 && <p className="notice">{u.reasons.join('; ')}{u.waitSince&&<small>Waiting {elapsed(now-Date.parse(u.waitSince))}</small>}</p>}
    {u.lineage && <p>Re-entry from <a href={link(e.arc, route().tab, 'units', u.lineage.reenters)}>{u.lineage.reenters}</a></p>}
    <section><h3>Journey</h3><label className="housekeeping-toggle"><input type="checkbox" checked={housekeeping} onChange={ev=>setHousekeeping(ev.target.checked)}/> Show housekeeping steps</label><div className="journey-pipeline">{u.journey.filter(step=>housekeeping||!step.housekeeping).map(step => {const state=!step.endedAt?'active':/fail|fault/i.test(step.outcome)?'failed':/changes|hold|park/i.test(step.outcome)?'held':'passed';return <a key={step.id} className="journey-block" data-state={state} href={step.activities[0] ? link(e.arc, route().tab, 'invocations', step.activities[0]) : `#step-${step.id}`} onClick={ev => { if (!step.activities.length) { ev.preventDefault(); const details=ev.currentTarget.closest('section')?.querySelector('details');if(details)details.open=true;requestAnimationFrame(()=>document.getElementById(`step-${step.id}`)?.scrollIntoView({block:'nearest'})); } }} title={`${step.label}, attempt ${step.attempt}: ${step.outcome}`}><span>{step.label}</span><small>{step.attempt} {glyph[state]}</small></a>;})}</div>{!u.journey.length && <p className="muted">No stage attempts recorded yet.</p>}
      <details className="journey-details"><summary>Stage outcomes and findings</summary>{u.journey.filter(step=>housekeeping||!step.housekeeping).map(step => <div id={`step-${step.id}`} key={step.id}><small>Round {step.round}</small><strong>{step.label} attempt {step.attempt}</strong><p>{step.outcome}</p>{step.findingTitles.map((t,i) => <p key={i}>{t}</p>)}{step.notes.map((t,i) => <p key={i}>{t}</p>)}</div>)}</details></section>
    {m.attention.filter(r=>r.subject.type==='unit'&&r.subject.unit===id).map(r=><section key={r.id}><h3>{r.summary}</h3><p>{r.recommendation}</p><a href={link(e.arc,'attention')}>View request and evidence</a></section>)}
    <Intent key={u.id} text={u.intent || u.summary}/>
    <section><h3>Invocations</h3><div className="invocation-list">{activities.map(a => { const ai = info(e, a); return <a key={a.id} className="invocation-row" href={link(e.arc, route().tab, 'invocations', a.routeId)} aria-label={`${ai.label} attempt ${ai.attempt}: ${a.kind === 'agentic' ? 'agent history' : 'check log'}`}><SignalMark state={a.status}/><div><strong>{ai.label}</strong><small>{a.kind === 'agentic' ? 'Agent history' : 'Check log'} {a.model}</small></div><span>Attempt {ai.attempt}<small>{elapsed(a.elapsedMs??(a.status==='active'?Math.max(0,now-Date.parse(a.startedAt)):null))} {money(ai.spend)}</small></span></a>; })}</div>{!activities.length && <p>No invocations recorded.</p>}</section>
    <section><h3>Acceptance</h3><ul>{u.acceptance.map((text,i) => <li key={i}>{text}</li>)}</ul></section>
    {!!u.waiting.length && <section><h3>Recorded waiting</h3>{u.waiting.map((w,i) => <div className="journey-wait" key={i}><strong>{w.stage}</strong> <Time at={w.at}/>{w.reasons.map(v=><p key={v.reason}>{v.reason}: {elapsed(v.ms)}</p>)}</div>)}</section>}
    <section><h3>Checks</h3>{e.data.display.status.units.find(v => v.unit === id)?.certification?.lanes.map((l,i) => <p key={i}>{l.id}: {l.verdict || l.state}</p>)}</section>
  </Drawer>;
}
export function BackToUnit({ e, unit }: { e: Envelope; unit: string }) { return <Button variant="ghost" asChild><a href={link(e.arc, route().tab, 'units', unit)}><ArrowLeft size={14}/>Back to unit {unit}</a></Button>; }
