// The ledgerly server: the web dashboard and the HTTP API (/api/v1, server/api.js) on one port, over the ledger in the
// data directory. Run it from the project root:
//
//   LEDGERLY_PORT=4600 LEDGERLY_DATA=.ledgerly LEDGERLY_API_TOKEN=<token> node server/main.js
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { dataDir, openLedger } from '../src/ledger.js';
import * as budgetEdit from '../web/pages/budget-edit.js';
import * as budget from '../web/pages/budget.js';
import * as budgets from '../web/pages/budgets.js';
import * as entries from '../web/pages/entries.js';
import * as entryNew from '../web/pages/entry-new.js';
import * as entry from '../web/pages/entry.js';
import * as notFound from '../web/pages/not-found.js';
import * as overview from '../web/pages/overview.js';
import * as statementPrint from '../web/pages/statement-print.js';
import * as statement from '../web/pages/statement.js';
import * as statements from '../web/pages/statements.js';
import { api } from './api.js';

const port = Number(process.env.LEDGERLY_PORT ?? 4600);
const dir = dataDir(undefined);
const { config, warnings } = loadConfig();
for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

const TEAM = '([a-z][a-z0-9-]*)';
const MONTH = '(\\d{4}-\\d{2})';
const redirect = (status, to) => (ctx) => ({ status, location: to(ctx) });

/** Method, path pattern (anchored), handler. The first match wins. */
const ROUTES = [
  ['GET', '/', overview.get],
  ['GET', '/entries', entries.get],
  ['GET', '/entries/new', entryNew.get],
  ['POST', '/entries', entryNew.post],
  ['GET', '/entries/(e-\\d{4})', entry.get],
  ['GET', '/budgets', budgets.get],
  ['GET', `/budgets/${TEAM}`, budget.get],
  ['GET', `/budgets/${TEAM}/edit`, budgetEdit.get],
  ['POST', `/budgets/${TEAM}/limit`, budgetEdit.post],
  ['GET', '/statements', statements.get],
  ['GET', `/statements/${MONTH}`, statement.get],
  ['GET', `/statements/${MONTH}/print`, statementPrint.get],
{{routes}}
].map(([method, path, handler]) => ({ method, pattern: new RegExp(`^${path}$`), handler }));

const STATIC = {
  '/static/tokens.css': 'design/tokens.css',
  '/static/app.css': 'web/static/app.css',
  '/static/print.css': 'web/static/print.css',
  '/static/favicon.svg': 'web/static/favicon.svg',
  '/favicon.ico': 'web/static/favicon.svg',
};
const TYPES = { '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on('error', reject);
  });
}

function send(res, out) {
  if (out.location !== undefined) {
    res.writeHead(out.status, { location: out.location });
    res.end();
    return;
  }
  res.writeHead(out.status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(out.html);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
    return;
  }
  if (path.startsWith('/api/')) {
    await api(req, res, url, { config, dir });
    return;
  }
  if (req.method === 'GET' && Object.hasOwn(STATIC, path)) {
    const file = STATIC[path];
    res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-cache' });
    res.end(readFileSync(join(process.cwd(), file)));
    return;
  }
  const ctx = { config, dir, ledger: openLedger(dir), path, query: url.searchParams, params: [], form: {} };
  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (m === null || route.method !== req.method) continue;
    if (req.method === 'POST') ctx.form = await readForm(req);
    send(res, route.handler({ ...ctx, params: m.slice(1) }));
    return;
  }
  send(res, notFound.get(ctx));
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    process.stderr.write(`${e.stack}\n`);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ledgerly hit an internal error; the server log has the details.\n');
  });
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`ledgerly is serving http://127.0.0.1:${port} from ${dir}\n`);
});
