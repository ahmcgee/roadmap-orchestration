// Effort's completion histogram: what finished in each slice of the selected window.
// Bars are buttons; each opens its slice as the window. The buckets table below is its table view.
import { useState } from 'react';
import { elapsed, money } from './shared.tsx';
import type { EffortTotals, EffortView } from '../../src/console/effort-protocol.ts';
export type EffortMetric = EffortView['filters']['metric'];
type Series = {key: string; label: string; value: (v: EffortTotals) => number | null};
/** The plain names of every figure Effort shows, with the method note a reader can open. */
export const series: Record<EffortMetric, Series[]> = {
  work: [
    {key: 'agent', label: 'Agent work', value: v => v.agentMs},
    {key: 'command', label: 'Commands and checks', value: v => v.commandMs},
  ],
  waiting: [
    {key: 'held', label: 'On hold', value: v => v.heldMs},
    {key: 'queued', label: 'Waiting its turn', value: v => v.queuedMs},
    {key: 'mixed', label: 'Mixed reasons', value: v => v.unallocatedMs},
  ],
  spend: [{key: 'spend', label: 'Spend', value: v => v.spend.costUsd}],
};
export const waitingHelp = 'On hold: stopped by a pause, failing baseline checks or a decision. Waiting its turn: waiting for dependencies, a milestone, CPU or the integration slot. Mixed reasons: one wait had reasons of both kinds, so it is not split. Each wait counts once.';
const format = (metric: EffortMetric, n: number) => metric === 'spend' ? money(n) : elapsed(n);
/** One figure in words: a missing value is "Not recorded" only when something of that kind went unmeasured; otherwise none fell in the window. */
export function figure(metric: EffortMetric, s: Series, v: EffortTotals) {
  const n = s.value(v);
  if (n !== null) return format(metric, n);
  return (metric === 'work' ? v.coverage.execution.unmeasured : metric === 'spend' ? v.spend.unavailable : 0) > 0 ? 'Not recorded' : 'None in this window';
}
export function EffortChart({h, metric, open, time}: {h: EffortView; metric: EffortMetric; open: (from: string, to: string) => void; time: (at: string) => string}) {
  const [active, setActive] = useState<number | null>(null);
  const from = Date.parse(h.histogram.from), width = h.histogram.widthMs, slots = Math.max(1, Math.min(64, Math.ceil((Date.parse(h.histogram.to) - from) / width)));
  const filled = new Map(h.buckets.map(b => [Math.round((Date.parse(b.from) - from) / width), b]));
  const parts = series[metric], sums = [...filled.values()].map(b => parts.reduce((n, s) => n + (s.value(b) ?? 0), 0)), max = Math.max(0, ...sums);
  if (!max) return <p className="effort-chart-empty">{metric === 'work' ? 'No timed work' : metric === 'waiting' ? 'No measured waiting' : 'No recorded spend'} finished in this window.</p>;
  const slot = (n: number) => ({from: new Date(from + n * width).toISOString(), to: new Date(Math.min(Date.parse(h.histogram.to), from + (n + 1) * width)).toISOString()});
  const describe = (b: EffortTotals) => parts.map(s => `${s.label} ${figure(metric, s, b)}`).join(', ');
  const shown = active === null ? null : filled.get(active) ?? null;
  return <figure className="effort-chart" aria-label={`${parts.map(s => s.label).join(' and ')} finished over time`}>
    <div className="effort-chart-legend">{parts.length > 1 && parts.map(s => <span key={s.key}><i className={`swatch series-${s.key}`} aria-hidden="true"/>{s.label}</span>)}</div>
    <div className="effort-chart-plot">
      <div className="effort-chart-axis" aria-hidden="true"><span>{format(metric, max)}</span><span>{format(metric, max / 2)}</span><span>0</span></div>
      <div className="effort-chart-bars" onMouseLeave={() => setActive(null)}>
        {Array.from({length: slots}, (_, n) => {
          const b = filled.get(n), range = slot(n);
          const total = b ? parts.reduce((t, s) => t + (s.value(b) ?? 0), 0) : 0;
          // Nothing of this kind finished here, or none of it was measured: no bar, never a zero-height mark.
          if (!b || !total) return <span key={n} className="effort-bar effort-bar-empty" aria-hidden="true"/>;
          return <button key={n} type="button" className="effort-bar" aria-label={`${time(range.from)} to ${time(range.to)}: ${describe(b)}. Show this window.`}
            onMouseEnter={() => setActive(n)} onFocus={() => setActive(n)} onBlur={() => setActive(null)} onClick={() => open(range.from, range.to)}>
            <span className="effort-bar-stack" style={{height: `${total / max * 100}%`}}>{parts.map(s => (s.value(b) ?? 0) > 0 && <span key={s.key} className={`series-${s.key}`} style={{flexGrow: s.value(b)!}}/>)}</span>
          </button>;
        })}
        {shown && active !== null && <div className="effort-chart-tip" role="presentation" style={{left: `clamp(110px, ${(active + .5) / slots * 100}%, calc(100% - 110px))`}}>
          <strong>{time(slot(active).from)} to {time(slot(active).to)}</strong>
          {parts.map(s => <span key={s.key}>{parts.length > 1 && <i className={`swatch series-${s.key}`} aria-hidden="true"/>}{s.label} <b>{figure(metric, s, shown)}</b></span>)}
          <small>Select to show this window</small>
        </div>}
      </div>
    </div>
    <div className="effort-chart-time" aria-hidden="true"><span>{time(h.histogram.from)}</span><span>{time(h.histogram.to)}</span></div>
  </figure>;
}
