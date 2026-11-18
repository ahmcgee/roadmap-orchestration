import { link, loadError, pluralise, route, SignalMark, Time } from './shared.tsx';
import { useView } from './view-state.ts';
import type { DetailRef, EndgameEntry, EndgameEpisodeView, EndgameRef, EndgameView, ShellPhase } from '../../src/console/view-protocol.ts';

// dev.83: the Endgame view. The arc's last stretch, where the architect finishes by hand what findings raised: what must
// hold before it closes, what is left, what was fixed and landed, and what the architect was handed. Read only.
const short = (sha: string) => sha.slice(0, 10);
const kindWords: Record<EndgameEntry['kind'], string> = {finding: 'Finding', obligation: 'Obligation', unit: 'Unit', 'polish-refused': 'Polish proposal'};
const outcomeWords: Record<string, string> = {landed: 'Landed', refused: 'Refused', red: 'Red, nothing moved', 'no-verdict': 'No verdict', reviewed: 'Reviewed', ran: 'Ran'};
const requestWords: Record<string, string> = {land: 'Landing', review: 'Review', run: 'Lane run'};

export const stepWords = (p: ShellPhase): string => p.kind === 'body' ? 'Body' : p.kind === 'closed-out' ? 'Closed out'
  : p.step === 'settling' ? 'Endgame: settling' : p.step === 'open' ? 'Endgame: open' : 'Endgame: closing';

/** What the phase is waiting on, in words: in the body what holds the endgame off, in the endgame what is left. The
 * header's title and accessible label, and the Endgame view; the header itself shows `phaseBrief`. */
export function phaseDetail(p: ShellPhase): string {
  if (p.kind === 'body') {
    const parts = [p.planned ? `${pluralise(p.planned, 'planned unit')} open` : '', p.milestones ? `${pluralise(p.milestones, 'milestone')} awaiting ${p.milestones === 1 ? 'its' : 'their'} checkpoint` : ''].filter(Boolean);
    return parts.length ? `Endgame waits for ${parts.join(' and ')}` : 'Every planned unit is settled';
  }
  if (p.kind === 'closed-out') return p.episodes ? `Closed out after ${pluralise(p.episodes, 'endgame episode')}` : 'Closed out';
  if (p.step === 'settling') return 'Running work finishes, then the final walks and audit';
  return p.required ? `${pluralise(p.required, 'required entry', 'required entries')} left` : p.step === 'closing' ? 'Review, audit and witnesses before close-out' : 'Fixes waiting to land';
}

/** The header's phase, compact and complete: the station's name and a short phrase that never needs an ellipsis, so the
 * phase track never takes width from the progress strip. Null once closed out. */
export function phaseBrief(p: ShellPhase): {step: string; brief: string | null} {
  if (p.kind === 'body') {
    const parts = [p.planned ? pluralise(p.planned, 'unit') : '', p.milestones ? pluralise(p.milestones, 'milestone') : ''].filter(Boolean);
    return {step: 'Body', brief: parts.length ? `${parts.join(', ')} to go` : 'all settled'};
  }
  if (p.kind === 'closed-out') return {step: 'Closed out', brief: null};
  const left = p.required ? `${p.required} required left` : p.step === 'open' ? 'fixes to land' : null;
  return {step: 'Endgame', brief: left ? `${p.step} · ${left}` : p.step};
}

/** The header's phase track: Body, Endgame, Closed out, with the current one marked and named; the full sentence is its
 * title and accessible label. */
export function PhaseTrack({arc, phase}: {arc: string; phase: ShellPhase}) {
  const at = phase.kind === 'body' ? 0 : phase.kind === 'endgame' ? 1 : 2;
  const steps = ['Body', 'Endgame', 'Closed out'];
  const {step, brief} = phaseBrief(phase);
  const track = <span className="phase-steps" aria-hidden="true">{steps.map((s, i) => <span key={s} className="phase-step" data-at={i === at ? 'current' : i < at ? 'past' : 'next'}/>)}</span>;
  const words = <span className="phase-words"><strong>{step}</strong>{brief !== null && <span>{brief}</span>}</span>;
  const label = `Arc phase: ${stepWords(phase)}. ${phaseDetail(phase)}.`;
  return phase.episodes > 0
    ? <a className="phase-track" href={link(arc, 'endgame')} aria-label={`${label} Open the endgame`} aria-current={route().tab === 'endgame' ? 'page' : undefined} title={label}>{track}{words}</a>
    : <span className="phase-track" role="img" aria-label={label} title={label}>{track}{words}</span>;
}

function RefLink({arc, r}: {arc: string; r: EndgameRef | {id: string; detail: DetailRef | null}}) {
  if (r.detail === null) return <code>{r.id}</code>;
  return <a href={link(arc, 'endgame', r.detail.type === 'unit' ? 'units' : 'events', r.detail.id)}><code>{r.id}</code></a>;
}

function Worklist({arc, rows}: {arc: string; rows: EndgameEntry[]}) {
  const open = rows.filter(r => !r.closed), closed = rows.filter(r => r.closed);
  const group = (label: string, list: EndgameEntry[]) => list.length > 0 && <>
    <tr className="group-row"><th colSpan={4} scope="colgroup">{label} ({list.length})</th></tr>
    {list.map(r => <tr key={`${r.closed}:${r.id}`} className={r.closed ? 'endgame-closed' : undefined}>
      <td><RefLink arc={arc} r={r}/></td>
      <td>{kindWords[r.kind]}{r.severity && <span className="cell-line">{r.severity}</span>}</td>
      <td>{r.text || <span className="muted">No text recorded</span>}</td>
      <td>{r.fixes.length ? r.fixes.map(f => <span key={f.command} className="cell-line"><SignalMark state={f.landed ? 'passed' : 'pending'}/> <code>{short(f.commit)}</code> {f.landed ? 'landed' : 'on the endgame branch'}</span>) : <span className="muted">{r.closed ? '' : 'Not fixed yet'}</span>}</td>
    </tr>)}
  </>;
  if (!rows.length) return <p>The worklist is empty.</p>;
  return <div className="table-wrap"><table aria-label="Endgame worklist"><thead><tr>{['Entry', 'What', 'Detail', 'Fix'].map(t => <th key={t}>{t}</th>)}</tr></thead>
    <tbody>{group('Required', open.filter(r => r.required))}{group('Optional', open.filter(r => !r.required))}{group('Closed by a fix', closed)}</tbody></table></div>;
}

function Episode({arc, ep}: {arc: string; ep: EndgameEpisodeView}) {
  return <>
    <h3>Fix log</h3>
    {!ep.fixes.length ? <p className="muted">No fix recorded.</p> : <ol className="endgame-fixes">{ep.fixes.map(f => <li key={f.command}>
      <div><SignalMark state={f.landed ? 'passed' : 'pending'}/> <code>{short(f.commit)}</code> <span className="muted">{f.landed ? 'Landed' : 'Not landed yet'}</span>{f.at && <> <Time at={f.at}/></>}</div>
      <p>{f.note}</p>
      <small>Closes {f.closes.map((c, i) => <span key={c.id}>{i > 0 && ', '}<RefLink arc={arc} r={c}/></span>)}</small>
    </li>)}</ol>}
    <h3>Landings</h3>
    {!ep.landings.length ? <p className="muted">Nothing landed yet.</p> : <div className="table-wrap"><table aria-label="Endgame landings"><thead><tr>{['Job', 'Integration head', 'Lanes run', 'When'].map(t => <th key={t}>{t}</th>)}</tr></thead>
      <tbody>{ep.landings.map(l => <tr key={l.job}><td>{l.job}</td><td><code>{short(l.old)}</code> to <code>{short(l.head)}</code></td><td>{l.lanes.length ? l.lanes.join(', ') : <span className="muted">None recorded</span>}</td><td>{l.at ? <Time at={l.at}/> : 'Not recorded'}</td></tr>)}</tbody></table></div>}
    <h3>Reviews</h3>
    {!ep.reviews.length ? <p className="muted">No review yet.</p> : ep.reviews.map(r => <div key={r.job} className="endgame-review">
      <p><strong>{r.job}</strong> over <code>{short(r.from)}</code> to <code>{short(r.to)}</code>{r.at && <> <Time at={r.at}/></>}: {r.findings.length ? pluralise(r.findings.length, 'finding') : 'no findings'}</p>
      {r.findings.length > 0 && <ul>{r.findings.map(f => <li key={f.id}><RefLink arc={arc} r={f}/> {f.severity && <span className="muted">{f.severity}</span>} {f.claim}</li>)}</ul>}
    </div>)}
    {ep.jobs.length > 0 && <details className="endgame-jobs"><summary>Jobs ({ep.jobs.length})</summary><div className="table-wrap"><table aria-label="Endgame jobs"><thead><tr>{['Job', 'Kind', 'Outcome', 'Detail'].map(t => <th key={t}>{t}</th>)}</tr></thead>
      <tbody>{ep.jobs.map(j => <tr key={j.job}><td>{j.job}</td><td>{requestWords[j.request] ?? j.request}{j.command === null && <span className="cell-line">By the closing step</span>}</td><td>{j.outcome ? outcomeWords[j.outcome] ?? j.outcome : 'Running'}</td><td>{j.detail ?? ''}</td></tr>)}</tbody></table></div></details>}
    {ep.released.length > 0 && <p>Sent back into the pipeline with <code>resume</code>: {ep.released.map((r, i) => <span key={r.id}>{i > 0 && ', '}<RefLink arc={arc} r={r}/></span>)}</p>}
    <h3>Handover</h3>
    {ep.opened === null ? <p className="muted">This episode never opened: its required worklist was empty, so nothing was handed over.</p> : <>
      {ep.opened.sizeGuard && <div className="notice owner-notice" role="note">More required entries than are sensible to finish by hand. {ep.opened.advisory}</div>}
      {ep.opened.handover.text === null ? <p className="muted">The handover file is no longer retained, or changed since it was written.</p>
        : <><pre className="endgame-handover">{ep.opened.handover.text}</pre>{ep.opened.handover.truncated && <p className="muted">The handover is longer than shown here; read the file for the rest.</p>}</>}
    </>}
  </>;
}

const stateWords: Record<EndgameEpisodeView['state'], string> = {open: 'Open', reversed: 'Reversed: a planned unit returned the arc to the body', complete: 'Complete: the arc closed out'};

export function Endgame({arc}: {arc: string}) {
  const view = useView('endgame'), v = view.data as EndgameView | null;
  if (!v) return <section className="panel"><header className="panel-head"><div><h2>Endgame</h2></div></header><p>{view.error ? loadError(view.error) : 'Loading…'}</p></section>;
  const ep = v.current;
  return <section className="panel endgame">
    <header className="panel-head"><div><h2>Endgame</h2>
      <p className="muted">{ep === null ? phaseDetail(v.phase) : <>Episode {ep.episode}. {stateWords[ep.state]}. {phaseDetail(v.phase)}.</>}</p>
      {v.branch && <p className="muted">Branch <code>{v.branch}</code>{v.tip && <> at <code>{short(v.tip)}</code>, {v.tip === ep?.opened?.base ? 'no commits yet' : v.landed ? 'landed on the integration branch' : 'not landed yet'}</>}{ep?.opened && <>, from <code>{short(ep.opened.base)}</code></>}</p>}
    </div></header>
    {ep === null && <p>No endgame episode has started. The endgame begins by itself once every planned unit is settled and every milestone had its checkpoint.</p>}
    {v.exit && <><h3>Before the arc closes</h3><ul className="endgame-exit" aria-label="Exit conditions">{v.exit.map(c => <li key={c.key} data-met={c.met}><SignalMark state={c.met ? 'passed' : 'pending'}/><span>{c.label}</span><span className="muted">{c.met ? 'Met' : 'Not yet'}</span></li>)}</ul></>}
    {ep !== null && ep.state === 'open' && <><h3>Worklist</h3><Worklist arc={arc} rows={v.worklist}/></>}
    {v.audited && <p className="muted">Audited range <code>{short(v.audited.from)}</code> to <code>{short(v.audited.to)}</code>{ep?.opened && v.tip ? <>; endgame range <code>{short(ep.opened.base)}</code> to <code>{short(v.tip)}</code></> : null}.</p>}
    {ep !== null && <Episode arc={arc} ep={ep}/>}
    {v.history.length > 0 && <><h3>Earlier episodes</h3>{v.history.map(h => <details key={h.episode} className="endgame-history"><summary>Episode {h.episode}: {stateWords[h.state]}{h.leftAt && <> <Time at={h.leftAt}/></>}. {pluralise(h.fixes.length, 'fix', 'fixes')}, {pluralise(h.landings.length, 'landing')}.</summary><Episode arc={arc} ep={h}/></details>)}</>}
  </section>;
}
