import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Views } from './view-state.ts';
import { HistoryMarkdown } from './markdown.tsx';
import { ChevronLeft, X } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { Clock, elapsed, glyph, info, link, money, pluralise, route, SignalMark, Time } from './shared.tsx';


export function Drawer({ title, close, children, headingLink, className = '' }: { title: string; close: () => void; children?: ReactNode; headingLink?: ReactNode; className?: string }) {
  const panel = useRef<HTMLElement>(null),cache=useContext(Views),routeKey=location.hash;
  const disclosures=useRef({route:'',seen:new WeakSet<HTMLDetailsElement>()});
  useLayoutEffect(()=>{const body=panel.current?.querySelector<HTMLElement>('.drawer-body');if(!body||!cache)return;body.scrollTop=Number(cache.ui.get(`scroll:${routeKey}`)??0);const remember=()=>{cache.ui.delete(`scroll:${routeKey}`);cache.ui.set(`scroll:${routeKey}`,body.scrollTop);const keys=[...cache.ui.keys()].filter(k=>k.startsWith('scroll:'));for(const key of keys.slice(0,-24))cache.ui.delete(key);};body.addEventListener('scroll',remember);return()=>body.removeEventListener('scroll',remember);},[cache,routeKey]);
  useLayoutEffect(()=>{
    const body=panel.current?.querySelector<HTMLElement>('.drawer-body');if(!body||!cache)return;
    const key=`disclosures:${routeKey}`,saved=cache.ui.get(key) as Record<string,boolean>|undefined;
    if(disclosures.current.route!==routeKey)disclosures.current={route:routeKey,seen:new WeakSet<HTMLDetailsElement>()};
    // Restore newly mounted disclosures once. Reapplying on every clock/history
    // render can race the native toggle event and reopen a section after Escape.
    for(const el of body.querySelectorAll('details')){if(disclosures.current.seen.has(el))continue;disclosures.current.seen.add(el);const name=el.querySelector('summary')?.textContent??'';if(saved&&name in saved)el.open=saved[name]!;}
    if(body.querySelector('.unit-meta,.invocation-facts'))body.scrollTop=Number(cache.ui.get(`scroll:${routeKey}`)??0);
    const remember=(ev:Event)=>{const el=ev.target;if(!(el instanceof HTMLDetailsElement))return;cache.ui.set(key,{...(cache.ui.get(key) as object??{}),[el.querySelector('summary')?.textContent??'']:el.open});cache.trimUi();};
    body.addEventListener('toggle',remember,true);return()=>body.removeEventListener('toggle',remember,true);
  },[children,cache,routeKey]);
  const [width, setWidth] = useState(() => { try { return Math.max(360, Math.min(960, Number(localStorage.getItem('roadmap.drawer-width')) || 520)); } catch { return 520; } });
  useEffect(() => {
    const previous=document.activeElement as HTMLElement|null;
    window.dispatchEvent(new Event('roadmap-dismiss-popovers'));
    panel.current?.querySelector<HTMLButtonElement>('[aria-label="Close details"]')?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      const sheet=panel.current;if(!sheet)return;
      if(e.key==='Escape'){
        e.preventDefault();e.stopImmediatePropagation();
        const expanded=[...sheet.querySelectorAll<HTMLElement>('details[open],button[aria-expanded="true"]')].filter(el=>el.getClientRects().length>0).at(-1);
        if(expanded instanceof HTMLDetailsElement){expanded.open=false;expanded.querySelector('summary')?.focus();}
        else if(expanded)expanded.click();
        else close();
      }
      if(e.key==='Tab'){
        const targets=[...sheet.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,[tabindex="0"]')].filter(el=>!el.matches(':disabled')&&el.getClientRects().length>0);
        const index=targets.indexOf(document.activeElement as HTMLElement);
        if(index<0||e.shiftKey&&index===0||!e.shiftKey&&index===targets.length-1){e.preventDefault();targets[e.shiftKey?targets.length-1:0]?.focus();}
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); const target=route().tab==='graph'?document.querySelector<HTMLElement>('.dag-canvas'):(previous?.isConnected?previous:document.querySelector<HTMLElement>('.tabs [aria-current]'));target?.focus({ preventScroll: true }); };
  }, []);
  function resize(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => { const next = Math.max(360, Math.min(innerWidth - 80, innerWidth - event.clientX)); setWidth(next); try { localStorage.setItem('roadmap.drawer-width', String(next)); } catch { /* Storage can be disabled. */ } };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true });
  }
  return <aside ref={panel} role="dialog" aria-modal="false" aria-labelledby="detail-title" className={`drawer ${className}`} style={{ width }}>
    <div className="drawer-resize" role="separator" aria-label="Resize details" aria-orientation="vertical" tabIndex={0} onPointerDown={resize} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { const next = Math.max(360, Math.min(960, width + (e.key === 'ArrowLeft' ? 40 : -40))); setWidth(next); try { localStorage.setItem('roadmap.drawer-width', String(next)); } catch {} } }}/>
    <header className="drawer-head"><div>{headingLink}<h2 id="detail-title">{title}</h2></div><Button variant="ghost" size="icon" onClick={close} aria-label="Close details" title="Close details"><X size={18}/></Button></header>
    <div className="drawer-body">{children}</div>
  </aside>;
}
export function Intent({ text, title }: { text: string; title: string }) {
  const [expanded, setExpanded] = useState(false);
  const heading=/^\s*#{1,6}\s+(.+)\r?\n/.exec(text);
  const display=!expanded&&heading?.[1]?.trim()===title?text.slice(heading[0].length).trimStart():text;
  return <section className="intent"><h3>Intent</h3><div className={expanded?'':'intent-collapsed'}><HistoryMarkdown text={display}/></div>{(text.length>180||heading)&&<Button variant="ghost" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Show less intent':'Show full intent'}</Button>}</section>;
}
export function BackToUnit({ arc, unit, title, systems=[] }: { arc:string; unit:string;title:string;systems?:string[] }) {
  return <div className="invocation-breadcrumb"><Button variant="ghost" asChild><a className="back-to-unit" href={link(arc, route().tab, 'units', unit)}><ChevronLeft size={16}/>Unit {unit}</a></Button><a className="invocation-unit-link" href={link(arc,route().tab,'units',unit)}>{title}</a><span className="invocation-identity">{unit}{systems.length?`  ${systems.join(', ')}`:''}</span></div>;
}
