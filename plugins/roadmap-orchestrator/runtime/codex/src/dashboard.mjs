import { createServer } from 'node:http'

export const DASHBOARD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Roadmap Codex</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#131b2f;--line:#29334d;--text:#e9eefc;--muted:#9aa8c7;--ok:#63d69f;--bad:#ff7b86;--run:#72a7ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
main{max-width:1200px;margin:auto;padding:24px}.top{display:flex;gap:16px;justify-content:space-between;align-items:end;flex-wrap:wrap}
h1{font:600 24px system-ui;margin:0}.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(5,minmax(100px,1fr));gap:10px;margin:18px 0}
.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}.num{font-size:22px;margin-top:5px}
.layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:14px}.panel{overflow:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:9px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted)}
.status-started{color:var(--run)}.status-completed{color:var(--ok)}.status-failed{color:var(--bad)}#logs{white-space:pre-wrap;line-height:1.5;max-height:65vh}.pill{padding:4px 8px;border:1px solid var(--line);border-radius:999px}
@media(max-width:800px){.cards{grid-template-columns:repeat(2,1fr)}.layout{grid-template-columns:1fr}}
</style></head><body><main><div class="top"><div><h1>Roadmap Codex</h1><div id="run" class="muted">waiting for run</div></div><div><span class="pill" id="connection">connecting</span> <span class="pill" id="phase">phase: —</span></div></div>
<div class="cards"><div class="card">Active<div class="num" id="active">0</div></div><div class="card">Completed<div class="num" id="completed">0</div></div><div class="card">Failed<div class="num" id="failed">0</div></div><div class="card">Replayed<div class="num" id="replayed">0</div></div><div class="card">Tokens<div class="num" id="tokens">0</div></div></div>
<div class="layout"><section class="panel"><table><thead><tr><th>#</th><th>Call</th><th>Phase</th><th>Model / effort</th><th>Status</th><th>Usage</th></tr></thead><tbody id="calls"></tbody></table></section><section class="panel"><strong>Workflow log</strong><div id="logs" class="muted"></div></section></div>
</main><script>
const calls=new Map();let logs=[];const $=id=>document.getElementById(id);const esc=s=>String(s??'');
function draw(){const rows=[...calls.values()].sort((a,b)=>a.ordinal-b.ordinal);$('calls').replaceChildren(...rows.map(c=>{const tr=document.createElement('tr');[c.ordinal,c.label,c.phase||'',(c.model||'')+(c.effort?' / '+c.effort:''),c.status+(c.replayed?' (replayed)':''),c.usage?((c.usage.input_tokens||0)+' in · '+(c.usage.output_tokens||0)+' out'):''].forEach((v,i)=>{const td=document.createElement('td');td.textContent=esc(v);if(i===4)td.className='status-'+c.status;tr.append(td)});return tr}));
const counts={started:0,completed:0,failed:0};for(const c of rows)counts[c.status]=(counts[c.status]||0)+1;$('active').textContent=counts.started;$('completed').textContent=counts.completed;$('failed').textContent=counts.failed;$('replayed').textContent=rows.filter(c=>c.replayed).length;$('tokens').textContent=rows.reduce((n,c)=>n+(c.usage?.input_tokens||0)+(c.usage?.output_tokens||0),0).toLocaleString();$('logs').textContent=logs.slice(-200).join('\\n')}
function accept(e){if(e.type==='run.started')$('run').textContent='run '+e.runId+' · '+e.authMode+' · '+e.profile;if(e.type==='phase')$('phase').textContent='phase: '+e.phase;if(e.type==='log')logs.push(e.message);if(e.type==='call.started')calls.set(e.ordinal,{...e,status:'started'});if(e.type==='call.completed'){const old=calls.get(e.ordinal)||e;calls.set(e.ordinal,{...old,...e,status:'completed'})}if(e.type==='call.failed'){const old=calls.get(e.ordinal)||e;calls.set(e.ordinal,{...old,...e,status:'failed'})}if(e.type==='run.completed')logs.push('run completed');draw()}
fetch('/snapshot').then(r=>r.json()).then(s=>s.events.forEach(accept));const source=new EventSource('/events');source.onopen=()=>{$('connection').textContent='live';$('connection').className='pill status-completed'};source.onerror=()=>{$('connection').textContent='disconnected';$('connection').className='pill status-failed'};source.onmessage=e=>accept(JSON.parse(e.data));
</script></body></html>`

const publicEvent = (event) => {
  const fields = {
    'run.started': ['runId', 'authMode', 'profile'],
    phase: ['phase'], log: ['message'],
    'call.started': ['ordinal', 'label', 'phase', 'model', 'effort'],
    'call.completed': ['ordinal', 'label', 'phase', 'model', 'effort', 'replayed', 'usage'],
    'call.failed': ['ordinal', 'label', 'phase', 'model', 'effort', 'message'],
    'run.completed': ['runId'],
  }[event.type] ?? []
  return Object.fromEntries([['type', event.type], ...fields.filter((key) => event[key] !== undefined)
    .map((key) => [key, event[key]])])
}

export async function startDashboard({ host = '0.0.0.0', port = 8787, maxEvents = 2000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('dashboard port must be 0..65535')
  const events = []
  const clients = new Set()
  const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(DASHBOARD_PAGE); return }
    if (req.url === '/snapshot') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ events })); return }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return
    }
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
    res.writeHead(404).end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  const boundPort = server.address().port
  const record = (raw) => {
    const event = publicEvent(raw)
    events.push(event); if (events.length > maxEvents) events.shift()
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const client of clients) client.write(line)
  }
  let closePromise = null
  const close = () => closePromise ??= new Promise((resolve) => {
    for (const client of clients) client.end()
    if (!server.listening) { resolve(); return }
    server.close(resolve)
  })
  return { host, port: boundPort, record, close }
}
