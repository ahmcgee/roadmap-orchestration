/* Roadmap console: classic scripts, React.createElement, no build or runtime downloads. */
(() => {
  'use strict';
  const R = window.React;
  const D = window.AtlasDesignSystem_ee04f2;
  const h = R.createElement;
  const { useState, useEffect, useRef } = R;
  const protocol = document.querySelector('meta[name="roadmap-protocol"]').content;
  const api = `/api/${protocol}`;
  const money = (n) => `$${n.toFixed(2)}`;
  const elapsed = (ms) => ms == null ? 'unrecorded' : ms < 1000 ? `${ms} ms` : D.formatElapsed(ms);
  const words = (value) => typeof value === 'string' ? value : JSON.stringify(value);
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    return parts[0] === 'runs' ? { arc: parts[1], tab: parts[2] || 'overview', unit: parts[3] === 'units' ? parts[4] : null, inv: parts[3] === 'invocations' ? parts[4] : null } : { arc: null, tab: 'overview', unit: null, inv: null };
  }
  const link = (arc, tab = 'overview', kind, id) => `#/runs/${encodeURIComponent(arc)}/${tab}${kind ? `/${kind}/${encodeURIComponent(id)}` : ''}`;
  async function get(path, signal) {
    const response = await fetch(`${api}${path}`, { signal, cache: 'no-store' });
    let value;
    try { value = await response.json(); } catch { throw new Error('Malformed console response'); }
    if (!response.ok) { const error = new Error(value.error?.message || `Console response ${response.status}`); error.code = value.error?.code; throw error; }
    if (value.protocol !== protocol) { const error = new Error('Reload required: executor version changed'); error.code = 'protocol'; throw error; }
    return value;
  }
  function Panel({ title, subtitle, children, extra }) {
    return h('section', { className: 'panel' }, h('div', { className: 'panelhead' }, h('div', null, h('h2', null, title), subtitle && h('p', { className: 'muted' }, subtitle)), extra), children);
  }
  const effortTotal = (row) => ['agent', 'deterministic', 'held', 'queued'].reduce((n, k) => n + (row?.[k] || 0), 0);
  function Effort({ row }) {
    const total = effortTotal(row);
    return total > 0 ? h('div', { className: 'recorded-effort' }, h('p', null, `${elapsed(total)} recorded`), h(D.BreakdownBar, { row }))
      : h('p', { className: 'empty-effort' }, 'No recorded effort yet.');
  }
  function Notice({ hold }) {
    const [recommendation, ...rest] = (hold.detail || '').split(' After reviewing');
    return h('div', { className: 'owner-notice' }, h(D.HoldNotice, { hold: { ...hold, detail: undefined } }),
      recommendation && h('p', null, h('strong', null, 'Recommendation: '), recommendation),
      rest.length > 0 && h('p', null, `After reviewing${rest.join(' After reviewing')}`));
  }
  function Attention({ model, arc, tab }) {
    const rows = model.attention;
    return h(Panel, { title: 'Attention', subtitle: 'Open questions, holds and recorded evidence' },
      h('div', { className: 'tablewrap' }, h(D.DataTable, { caption: 'Owner attention', rows, empty: 'No open owner requests.', columns: [
        { key: 'blocking', label: 'Impact', render: (row) => row.blocking ? 'Blocking' : 'Nonblocking' },
        { key: 'summary', label: 'Request' },
        { key: 'subject', label: 'Affected', render: (row) => row.subject.type === 'unit' ? h('a', { href: link(arc, tab, 'units', row.subject.unit) }, row.subject.unit) : words(row.subject) },
        { key: 'reason', label: 'Reason' },
      ] })),
      rows.map((r) => h('article', { key: r.id, id: `attention-${r.id}`, className: 'detailsection' },
        h(Notice, { hold: { reason: r.blocking ? 'query' : 'manual', label: r.blocking ? 'Owner decision needed' : 'Owner notice', question: r.summary, detail: r.recommendation } }),
        r.options.length > 0 && h('p', null, `Recorded options: ${r.options.map((o) => `${o.id}: ${o.label}`).join(' · ')}`),
        h('div', { className: 'evidence' }, r.evidence.map((e, i) => h('p', { key: i, className: 'mono' }, r.evidenceLinks?.[i] ? h('a', { href: link(arc, tab, 'invocations', r.evidenceLinks[i]) }, e) : e))))),
      model.holds.length > 0 && h('div', { className: 'detailsection' }, h('h3', null, 'Current holds'), model.holds.map((v, i) => h('pre', { key: i }, words(v)))));
  }
  function Overview({ e, selected, setSelected, open }) {
    const m = e.data.console, s = e.data.display.status, summary = e.data.summary;
    const focus = m.graph.units.find((u) => u.id === selected) || m.graph.units.find((u) => u.status === 'active') || m.graph.units[0];
    const withdrawn = s.units.filter((u) => ['cut', 'superseded'].includes(u.state)).length;
    const total = summary.progress.total - withdrawn;
    return h(R.Fragment, null,
      h('div', { className: 'metrics' },
        h(D.MetricTile, { label: 'Progress', value: `${summary.progress.merged} / ${total}`, caption: `${withdrawn} withdrawn · applied plan ${s.plan?.rev ?? 'unrecorded'}` }),
        h(D.MetricTile, { label: 'Recorded spend', value: money(summary.spend.costUsd), caption: summary.spend.unavailableCalls ? `${summary.spend.unavailableCalls} calls with unavailable usage` : 'From recorded usage' }),
        h(D.MetricTile, { label: 'Open items', value: m.attention.length, caption: `${m.attention.filter((r) => r.blocking).length} blocking owner requests` }),
        h(D.MetricTile, { label: 'CPU tokens occupied', value: m.tokenOccupancy, caption: 'Current recorded reservation occupancy' })),
      h(Panel, { title: 'Applied work', subtitle: 'Units and explicit milestone gates · select a node to explore', extra: h('span', { className: 'eyebrow' }, s.run.state) },
        focus && h('div', { className: 'selection' }, h('strong', null, focus.label), h('span', { className: 'muted' }, focus.meta), h('button', { onClick: () => open(focus.id), 'aria-label': `Open ${focus.label} details` }, 'Details ↗')),
        h('div', { className: 'graph' }, h(D.UnitGraph, { ...m.graph, selectedId: focus?.id, onSelect: setSelected, onOpen: open, height: 400 })),
        h('div', { className: 'unit-list' }, m.graph.units.map((u) => h('a', { key: u.id, href: link(e.arc, 'overview', 'units', u.id) }, h('strong', null, u.label), h('span', null, u.meta))))),
      h('div', { className: 'columns' }, h(Panel, { title: 'Recorded effort', subtitle: m.time.caption },
        h(Effort, { row: m.time.total }), h('p', { className: 'backlog' }, `${elapsed(m.time.unallocated)} unallocated waiting · ${m.time.unmeasuredReservations} unmeasured reservations`)),
      h(Panel, { title: 'Milestone gates', subtitle: 'Passing member units alone does not pass a gate.' },
        s.milestones.length ? s.milestones.map((gate) => h('p', { key: gate.id }, h('a', { href: link(e.arc, 'overview', 'units', `milestone:${gate.id}`) }, gate.id), ` · ${gate.state} · ${gate.passed ? 'gate passed' : 'gate not passed'}`)) : h('p', { className: 'muted' }, 'No milestone gates in this plan.'))));
  }
  function Resources({ e, open }) {
    const m = e.data.console;
    return h(R.Fragment, null,
      h(Panel, { title: 'Time', subtitle: m.time.caption }, effortTotal(m.time.total) === 0 ? h(Effort, { row: m.time.total }) : h(D.TimeBreakdown, { rows: m.time.rows, title: 'Recorded effort by subject', caption: m.time.caption, onSelect: (id) => e.data.display.status.units.some((u) => u.unit === id) && open(id) }),
        h('p', { className: 'backlog' }, `Unallocated waiting: ${elapsed(m.time.unallocated)}. Unmeasured reservations: ${m.time.unmeasuredReservations}. Reason totals overlap and are not added.`),
        h('details', null, h('summary', null, 'Waiting reason totals'), h('pre', null, Object.entries(m.time.byReasonMs).map(([reason, ms]) => `${reason}: ${elapsed(ms)}`).join('\n') || 'No recorded waiting.'))),
      h(Panel, { title: 'Resources', subtitle: `${m.resources.unknownQueueStarts} current queue entries have an unknown start.` },
        m.resources.resources.length ? h(D.ResourceSchedule, { ...m.resources, end: Math.max(m.resources.now, 1), tickEvery: Math.max(1, Math.ceil(m.resources.now / 6)), title: 'Recorded resource bookings', timeFormat: (n) => elapsed(n * 1000), onSelect: open }) : h('p', { className: 'muted' }, 'No named-resource or integration-slot bookings have been recorded.'),
        h('div', { className: 'tablewrap' }, h(D.DataTable, { caption: 'Resource bookings', rows: m.resources.bookings, columns: [{ key: 'resource', label: 'Resource' }, { key: 'label', label: 'Subject' }, { key: 'state', label: 'State' }, { key: 'from', label: 'From', render: (row) => elapsed(row.from * 1000) }, { key: 'to', label: 'To', render: (row) => row.to === undefined ? 'open' : elapsed(row.to * 1000) }] }))),
      h(Panel, { title: 'CPU evidence', subtitle: 'Measured run time / measured wall time, compared with the recorded reservation. Demand is shown separately.' },
        h('div', { className: 'tablewrap' }, h(D.DataTable, { caption: 'Recorded CPU evidence', rows: m.cpu, empty: 'No measured CPU or reservations are recorded.', columns: [
          { key: 'unit', label: 'Subject' }, { key: 'reserved', label: 'Reserved tokens', render: (row) => row.reserved ?? 'unrecorded' },
          { key: 'average', label: 'Measured cores', render: (row) => row.average == null ? 'unmeasured' : h('div', { role: 'img', 'aria-label': `Measured average ${row.average.toFixed(2)} cores; reserved ${row.reserved ?? 'unrecorded'} tokens` }, h('span', { className: 'mono' }, row.average.toFixed(2)), h('div', { 'aria-hidden': 'true' }, h(D.BudgetMeter, { budget: row.reserved || 0, avg: row.average, showText: false }))) },
          { key: 'demand', label: 'Demand basis', render: (row) => `${row.demand ?? 'unrecorded'} · ${row.basis}` },
        ] })), h('p', { className: 'backlog' }, 'Continuous CPU utilization, peaks and test-case counts are not recorded.')));
  }
  function Dialog({ title, close, children }) {
    const ref = useRef(null);
    useEffect(() => {
      const previous = document.activeElement;
      const panel = ref.current;
      panel.querySelector('button')?.focus();
      const key = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key !== 'Tab') return;
        const elements = [...panel.querySelectorAll('button, a[href], input, select, summary, [tabindex="0"]')].filter((el) => !el.disabled && el.getClientRects().length);
        if (!elements.length) { event.preventDefault(); return; }
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      panel.addEventListener('keydown', key);
      return () => { panel.removeEventListener('keydown', key); previous?.focus(); };
    }, []);
    return h('div', { className: 'detail', onClick: (ev) => ev.target === ev.currentTarget && close() }, h('section', { ref, className: 'detailpanel', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'detail-title' },
      h('div', { className: 'detailhead' }, h('div', null, h('div', { className: 'eyebrow' }, 'Roadmap · recorded detail'), h('h2', { id: 'detail-title' }, title)), h('button', { onClick: close, 'aria-label': 'Close details' }, 'Close ✕')), children));
  }
  function UnitDetail({ e, id, close, stale }) {
    const [detail, setDetail] = useState(null), [error, setError] = useState('');
    useEffect(() => {
      setDetail(null); setError('');
      if (id.startsWith('milestone:')) return;
      const c = new AbortController();
      get(`/runs/${e.arc}/units/${encodeURIComponent(id)}?epoch=${e.epoch}&minHighWater=${e.highWater}`, c.signal).then((d) => setDetail(d.data)).catch((err) => { if (!c.signal.aborted) setError(err.message); });
      return () => c.abort();
    }, [id, e.revision, e.epoch]);
    const m = e.data.console, unit = e.data.display.status.units.find((u) => u.unit === id);
    const gate = e.data.display.status.milestones.find((v) => `milestone:${v.id}` === id);
    const activities = m.activities.filter((a) => a.unit === id);
    const groups = [...new Set(activities.map((a) => `${a.stage} · attempt ${a.attempt}`))];
    const row = m.time.rows.find((r) => r.id === id);
    const onOpenHistory = a => { location.hash = link(e.arc, 'overview', 'invocations', a.routeId).slice(1); };
    return h(Dialog, { title: gate ? `Milestone ${gate.id}` : `Unit ${id}`, close },
      error && h('p', { role: 'alert', className: 'notice' }, error),
      gate ? h(R.Fragment, null, h('p', null, `Executor milestone gate: ${gate.state} · ${gate.passed ? 'passed' : 'not passed'}`), h('pre', { className: 'record' }, JSON.stringify(gate, null, 2)),
        (e.data.plan?.milestones.find((v) => v.id === gate.id)?.units || []).map((u) => h('p', { key: u }, h('a', { href: link(e.arc, 'overview', 'units', u) }, u)))) : unit ? h(R.Fragment, null,
        h('p', { className: 'kv' }, h('strong', null, unit.state), `Stage ${unit.stage} · ${unit.attempts} recorded attempts`),
        h(Effort, { row }),
        unit.waitingFor && h(Notice, { hold: { reason: 'manual', label: 'Current admission or reservation reasons', detail: JSON.stringify(unit.waitingFor) } }),
        m.attention.filter((r) => r.subject.type !== 'unit' || r.subject.unit === id).map((r) => h(Notice, { key: r.id, hold: { reason: 'query', label: r.blocking ? 'Blocking owner request' : 'Owner notice', question: r.summary, detail: r.recommendation } })),
        h('section', { className: 'detailsection' }, h('h3', null, 'Activity by stage and attempt'), groups.length ? groups.map((group) => h('div', { key: group }, h('h3', null, group), stale ? activities.filter((a) => `${a.stage} · attempt ${a.attempt}` === group).map((a, i, all) => h(D.ActivityRow, { key: a.id, activity: a, onOpenHistory, now: Date.parse(e.checkedAt), last: i === all.length - 1 })) : h(D.ActivityTimeline, { onOpenHistory, activities: activities.filter((a) => `${a.stage} · attempt ${a.attempt}` === group) }))) : h('p', { className: 'muted' }, 'No recorded invocations for this unit.'),
          activities.map((a) => h('p', { key: a.id }, h('a', { href: link(e.arc, 'overview', 'invocations', a.routeId) }, `${a.stage} attempt ${a.attempt}: logs and result`)))),
        h('section', { className: 'detailsection' }, h('h3', null, 'Lane certification'), unit.certification ? h(R.Fragment, null, h('p', null, `${unit.certification.used} used · ${unit.certification.left} left of ${unit.certification.allowance}`), unit.certification.lanes.map((l, i) => h('p', { key: i }, `${l.set} / ${l.id}: ${l.state}${l.verdict ? ` (${l.verdict})` : ''}`))) : h('p', { className: 'muted' }, 'No current certification series.')),
        h('section', { className: 'detailsection' }, h('h3', null, 'Readable records'), detail ? h('pre', { className: 'record' }, detail.lines.join('\n')) : h('p', null, 'Reading unit records…'),
          detail?.records.map((r) => h('details', { key: r.id }, h('summary', null, r.label), h('pre', { className: 'record' }, r.body))))) : h('p', null, 'This unit is absent from the applied plan.'));
  }
  function HistoryField({ event, field, base, identity }) {
    const [pages, setPages] = useState([]), [cursor, setCursor] = useState(0), [size, setSize] = useState(null), [error, setError] = useState('');
    const load = () => get(`${base}/history-field?identity=${encodeURIComponent(identity)}&ref=${encodeURIComponent(event.refs?.[field] || event.id)}&field=${field}&after=${cursor}`)
      .then(r => { setPages([r.data.text]); setCursor(r.data.next); setSize(r.data.size); setError(''); }).catch(err => setError(err.message));
    return h('details', { className: 'history-expansion', onToggle: ev => { if (ev.currentTarget.open && size === null) load(); } },
      h('summary', null, `Expand full ${field} (preview truncated)`),
      error && h('p', { role: 'alert' }, error), pages.map((text, i) => h('pre', { key: i }, text)),
      size !== null && h('p', { className: 'muted' }, `Characters ${Math.max(0, cursor - pages.join('').length)}–${cursor} of ${size}`),
      size !== null && cursor < size && h('button', { onClick: load }, `Next ${field} page`));
  }
  function AgentEvent({ event, activity, base, identity }) {
    const display = { ...event, at: /^\d{4}-\d{2}-\d{2}T/.test(event.at || '') ? event.at.slice(11, 19) : event.at, title: [event.parent ? `Subagent of ${event.parent}` : '', event.title].filter(Boolean).join(' · ') };
    // The supplied tool renderer collapses every output, including failures. Render failed output openly.
    if (event.status === 'failed') display.output = undefined;
    return h('article', { className: 'history-event', 'data-event-id': event.id, title: event.at },
      h(D.AgentHistory, { activity: { ...activity, status: 'pending' }, events: [display] }),
      event.status === 'failed' && event.output != null && h('div', { className: 'failed-output' }, h('strong', null, 'Output · error'), h('pre', null, event.output)),
      (event.truncated || []).map(field => h(HistoryField, { key: `${event.id}:${field}:${identity}`, event, field, base, identity })));
  }
  function AgentDetail({ e, id, activity, close, stale }) {
    const base = `/runs/${e.arc}/invocations/${id}`;
    const [history, setHistory] = useState(null), [error, setError] = useState(''), [brief, setBrief] = useState(null), [result, setResult] = useState(null);
    const [following, setFollowing] = useState(true), [earlier, setEarlier] = useState(false);
    const scroll = useRef(null), follow = useRef(true);
    useEffect(() => {
      const c = new AbortController(); setHistory(null); setBrief(null); setError(''); setResult(null); setEarlier(false);
      get(`${base}/prompt?after=0`, c.signal).then(r => setBrief(r.data)).catch(err => { if (!c.signal.aborted) setError(err.message); });
      get(`${base}/history`, c.signal).catch(err => { if (!c.signal.aborted) setError(err.message); });
      const stream = new EventSource(`${api}/runs/${e.arc}/events?invocation=${id}`);
      stream.addEventListener('history', ev => {
        const next = JSON.parse(ev.data);
        setHistory(old => {
          if (!old || next.reset || old.identity !== next.identity) return { ...next, events: next.events.slice(-50) };
          if (!follow.current) return { ...old, state: next.state, endedAt: next.endedAt, unseen: (old.unseen || 0) + next.events.length };
          const events = new Map(old.events.map(event => [event.id, event]));
          for (const event of next.events) events.set(event.id, event);
          const kept = [...events.values()].slice(-200);
          return { ...old, ...next, before: kept[0]?.id === '0:0' ? null : kept[0]?.id, events: kept };
        }); setError('');
      });
      stream.addEventListener('history-error', ev => { if (ev.data) setError(JSON.parse(ev.data).message); });
      return () => { c.abort(); stream.close(); };
    }, [base]);
    useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [history]);
    const back = () => { location.hash = link(e.arc, 'overview', 'units', activity.unit).slice(1); };
    const more = () => {
      follow.current = false; setFollowing(false);
      get(`${base}/history?before=${history.before}&identity=${encodeURIComponent(history.identity)}`).then(r => {
        setEarlier(true); setHistory(old => ({ ...old, before: r.data.before, events: [...new Map([...r.data.events, ...old.events].map(event => [event.id, event])).values()].slice(0, 200) }));
      }).catch(err => setError(err.message));
    };
    const latest = () => get(`${base}/history`).then(r => { setEarlier(false); follow.current = true; setFollowing(true); setHistory(r.data); }).catch(err => setError(err.message));
    const completed = history?.endedAt != null || ['success', 'pass', 'fail', 'fault', 'lost'].includes(history?.state);
    const live = history?.state === 'running' && !completed && !stale;
    const model = [...(history?.events || [])].reverse().find(event => event.model)?.model || activity.model;
    const usage = [...(history?.events || [])].reverse().find(event => event.tokens != null)?.tokens;
    return h(Dialog, { title: `Agent history · ${activity.stage}`, close },
      h('button', { onClick: back }, `‹ Back to unit ${activity.unit}`),
      h('div', { className: 'history-meta' }, h('strong', null, live ? 'Running' : completed ? 'Finished' : history?.state || 'Connecting'),
        h('span', null, model || 'Model unrecorded'), usage != null && h('span', null, `${usage} recorded tokens`)),
      h('details', { className: 'history-brief' }, h('summary', null, 'Brief · recorded seat prompt'),
        brief ? h(R.Fragment, null, h('pre', null, brief.lines.join('\n')), brief.end < brief.size && h('button', { onClick: () => get(`${base}/prompt?after=${brief.end}`).then(r => setBrief(r.data)).catch(err => setError(err.message)) }, `Next brief page (${brief.end} of ${brief.size} bytes)`)) : h('p', null, 'Reading retained brief…')),
      error && h('p', { role: 'alert' }, error),
      h('div', { className: 'history-controls' }, history?.before != null && h('button', { onClick: more }, 'Show earlier'), h('button', { onClick: latest }, following ? 'Following live tail' : `Follow live tail${history?.unseen ? ` (${history.unseen} updates)` : ''}`), earlier && h('span', null, 'Earlier history · latest 200 events retained in view')),
      h('div', { className: 'history-scroll', ref: scroll, tabIndex: 0, 'aria-label': 'Agent transcript', onScroll: ev => { follow.current = ev.currentTarget.scrollHeight - ev.currentTarget.scrollTop - ev.currentTarget.clientHeight < 48; setFollowing(follow.current); } },
        history?.events.map(event => h(AgentEvent, { key: `${history.identity}:${event.id}`, event, activity, base, identity: history.identity })),
        history && !history.events.length && h('p', null, 'Waiting for complete transcript records…'),
        live && h('p', { className: 'history-live', role: 'status' }, 'Agent is working', h('span', { className: 'atlas-settle-caret', 'aria-hidden': true }))),
      h('p', { className: 'history-links' }, h('a', { href: `${api}${base}/result`, onClick: ev => { ev.preventDefault(); get(`${base}/result`).then(r => setResult(r.data.lines.join('\n'))).catch(err => setError(err.message)); } }, 'Final verdict / report'), ' · ',
        h('a', { href: `${api}${base}/log?source=stdout&after=0` }, 'Raw transcript (64 KiB pages)')),
      result && h('pre', { className: 'record' }, result));
  }
  function InvocationDetail(props) {
    const activity = props.e.data.console.activities.find(a => a.routeId === props.id);
    return activity?.kind === 'agentic' ? h(AgentDetail, { ...props, activity }) : h(CommandDetail, props);
  }
  function CommandDetail({ e, id, close, stale }) {
    const activity = e.data.console.activities.find((a) => a.routeId === id);
    const [source, setSource] = useState('stdout'), [page, setPage] = useState(null), [error, setError] = useState('');
    const [result, setResult] = useState(null);
    useEffect(() => {
      const c = new AbortController(); setPage(null); setError(''); setResult(null);
      if (source === 'result') get(`/runs/${e.arc}/invocations/${id}/result`, c.signal).then((r) => setResult(r.data)).catch((err) => { if (!c.signal.aborted) setError(err.message); });
      else get(`/runs/${e.arc}/invocations/${id}/log?source=${source}&after=0`, c.signal).then((r) => setPage(r.data)).catch((err) => { if (!c.signal.aborted) setError(err.message); });
      return () => c.abort();
    }, [id, source]);
    const more = () => get(`/runs/${e.arc}/invocations/${id}/log?source=${source}&after=${page.next}&identity=${page.identity}`).then((r) => setPage(r.data)).catch((err) => setError(err.message));
    const phase = activity && { id: activity.id, name: activity.name, status: activity.status === 'held' ? 'pending' : activity.status,
      ...(activity.elapsedMs == null ? {} : { elapsedMs: activity.elapsedMs }), summary: `${source} · ${page ? `bytes ${page.after}–${page.next} of ${page.size}` : 'recorded output'}`, lines: (page?.text || '').split('\n').map((text) => ({ level: 'info', text })) };
    return h(Dialog, { title: activity ? activity.name : `Invocation ${id}`, close },
      h('div', { className: 'runbar' }, ['stdout', 'stderr', 'runner.log', 'result'].map((s) => h('button', { key: s, onClick: () => setSource(s), 'aria-pressed': source === s }, s))),
      error && h('p', { role: 'alert', className: 'notice' }, error),
      result && h('pre', { className: 'record' }, result.lines.join('\n')),
      page && activity && h(D.StepLog, { activity: { ...activity, status: stale && activity.status === 'active' ? 'pending' : activity.status, kind: 'deterministic' }, log: { summary: 'Text-only recorded output; timestamps and levels are not inferred.', phases: [phase] } }),
      page && page.next < page.size && h('button', { onClick: more }, 'Next log page'));
  }
  function App() {
    const [where, setWhere] = useState(route), [runs, setRuns] = useState([]), [selectedArc, setArc] = useState(null);
    const [e, setEnvelope] = useState(null), [error, setError] = useState(''), [checkedAt, setCheckedAt] = useState(null);
    const [selected, setSelected] = useState(null), [now, setNow] = useState(Date.now());
    const current = useRef(null);
    useEffect(() => { const f = () => setWhere(route()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
    useEffect(() => {
      const c = new AbortController();
      const poll = () => get('/runs', c.signal).then((r) => { setRuns(r.runs); setArc(where.arc || r.selected); }).catch((err) => { if (!c.signal.aborted) setError(err.code === 'protocol' ? 'Reload required: executor version changed' : err.message); });
      poll(); const timer = setInterval(poll, 2000); return () => { c.abort(); clearInterval(timer); };
    }, [where.arc]);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
    useEffect(() => {
      current.current = null; setEnvelope(null); setCheckedAt(null); setError('');
      if (!selectedArc) return;
      const c = new AbortController(); let fetching = false, again = false;
      async function capture(reset = false) {
        if (fetching) { again = true; return; } fetching = true;
        try {
          const previous = reset ? null : current.current;
          const query = previous ? `?epoch=${previous.epoch}&revision=${previous.revision}&minHighWater=${previous.highWater}` : '';
          const next = await get(`/runs/${selectedArc}/snapshot${query}`, c.signal);
          if (!next.data?.console || next.arc !== selectedArc || !next.instance || !next.epoch || !Number.isSafeInteger(next.highWater) || !Number.isFinite(Date.parse(next.checkedAt))) throw new Error('Malformed observation payload');
          if (previous && (next.epoch !== previous.epoch || next.highWater < previous.highWater || next.revision < previous.revision)) throw new Error('Observation conflict: reconnect to reset');
          current.current = next; setEnvelope(next); setCheckedAt(next.checkedAt); setError('');
        } catch (err) {
          if (c.signal.aborted) return;
          if (err.code === 'reset' || err.code === 'conflict') { fetching = false; setError('Observation reset; verifying a new journal prefix'); return capture(true); }
          setError(err.code === 'protocol' ? 'Reload required: executor version changed' : err.message);
        } finally { fetching = false; if (again) { again = false; void capture(); } }
      }
      capture();
      const stream = new EventSource(`${api}/runs/${selectedArc}/events`);
      stream.addEventListener('revision', () => capture());
      stream.addEventListener('reset', () => { setError('Observation reset; verifying a new journal prefix'); capture(true); });
      stream.addEventListener('heartbeat', (event) => { try { const notice = JSON.parse(event.data); if (current.current && notice.epoch === current.current.epoch && Number.isFinite(Date.parse(notice.checkedAt))) { current.current = { ...current.current, checkedAt: notice.checkedAt }; setCheckedAt(notice.checkedAt); } } catch { setError('Malformed verification heartbeat'); } });
      stream.addEventListener('error', (event) => { if (event.data) { try { setError(JSON.parse(event.data).message); } catch { setError('Console observation error'); } } });
      const retry = setInterval(() => { if (!current.current || Date.now() - Date.parse(current.current.checkedAt) > 5000) capture(); }, 3000);
      return () => { c.abort(); stream.close(); clearInterval(retry); };
    }, [selectedArc]);
    const stale = !checkedAt || now - Date.parse(checkedAt) > 5000 || Boolean(error);
    const arc = selectedArc, tab = ['overview', 'resources', 'attention'].includes(where.tab) ? where.tab : 'overview';
    const open = (id) => { location.hash = link(arc, tab, 'units', id).slice(1); };
    const close = () => { location.hash = link(arc, tab).slice(1); };
    const header = h('header', { className: 'topline' }, h('div', { className: 'identity' }, h('h1', null, 'Roadmap'), h('span', { className: 'eyebrow' }, 'Run console')),
      h('div', { className: 'connection', role: 'status', 'aria-live': 'polite' }, h(D.StatusIndicator, { status: stale ? 'down' : 'operational', label: stale ? 'Disconnected/stale' : 'Connected' }),
        h('a', { href: location.origin }, location.origin), h('span', { className: 'mono' }, `Run ${arc || 'none'}`), h('span', null, `Observed ${e?.observedAt || 'not yet'}`), h('span', null, `Verified ${checkedAt || 'not yet'}`)));
    return h(R.Fragment, null, h('a', { className: 'skip', href: '#content', onClick: (ev) => { ev.preventDefault(); document.getElementById('content').focus(); } }, 'Skip to content'), h('div', { className: 'shell', 'data-stale': stale }, header,
      h('div', { className: 'runbar' }, h('label', null, 'Run ', h('select', { 'aria-label': 'Run', value: arc || '', onChange: (ev) => { location.hash = link(ev.target.value).slice(1); } }, runs.length ? runs.map((r) => h('option', { key: r.arc, value: r.arc }, r.arc)) : h('option', { value: '' }, 'No retained runs'))),
        h('a', { href: '#/' }, where.arc ? 'Follow current run' : 'Following current run'),
        h('nav', { className: 'nav', 'aria-label': 'Roadmap views' }, [['overview', 'Overview'], ['resources', 'Time & resources'], ['attention', 'Attention']].map(([key, text]) => h('a', { key, href: arc ? link(arc, key) : '#/', 'aria-current': key === tab ? 'page' : undefined }, text)))),
      error && h('p', { role: 'alert', className: 'notice' }, error),
      h('main', { id: 'content', tabIndex: -1 }, e ? tab === 'resources' ? h(Resources, { e, open }) : tab === 'attention' ? h(Attention, { model: e.data.console, arc, tab }) : h(Overview, { e, selected, setSelected, open }) : h('p', { className: 'empty' }, arc ? 'Waiting for a verified observation…' : 'No retained runs in this repository.')),
      e && where.unit && h(UnitDetail, { e, id: where.unit, close, stale }),
      e && where.inv && h(InvocationDetail, { e, id: where.inv, close, stale })));
  }
  class ErrorBoundary extends R.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    render() { return this.state.error ? h('main', { className: 'shell' }, h('h1', null, 'Roadmap'), h('p', { role: 'alert' }, `Console rendering failed: ${this.state.error.message}`)) : this.props.children; }
  }
  window.ReactDOM.createRoot(document.getElementById('root')).render(h(ErrorBoundary, null, h(App)));
})();
