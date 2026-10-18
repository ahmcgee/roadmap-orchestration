// The HTTP API, /api/v1 (design/api.md): JSON in and out, a bearer token, RFC 9457 problem details for every error,
// cursor pagination and idempotency keys for creates.
import { addEntries, openLedger, save } from '../src/ledger.js';
import { plainAmount } from '../src/money.js';
import { isMonth } from '../src/month.js';
import { checkEntry } from '../src/validate.js';

const PROBLEMS = 'https://ledgerly.dev/problems';
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const ENTRY_FIELDS = ['team', 'month', 'vendor', 'amount', 'note'];
const LIST_PARAMS = ['team', 'month', 'limit', 'page_token'];

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

/** An RFC 9457 problem: `type` names it (design/api.md, "Problem types"), `detail` says how to fix it. */
function problem(res, status, type, title, detail, instance, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(`${JSON.stringify({ type: `${PROBLEMS}/${type}`, title, status, detail, instance, ...extra }, null, 2)}\n`);
}

const view = (e) => ({ id: e.id, team: e.team, month: e.month, vendor: e.vendor, amount: plainAmount(e.amount), note: e.note });

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve({ ok: true, value: JSON.parse(body) });
      } catch {
        resolve({ ok: false });
      }
    });
    req.on('error', reject);
  });
}

const cursor = {
  encode: (offset) => Buffer.from(`o:${offset}`).toString('base64url'),
  decode: (token) => {
    const m = /^o:(\d+)$/.exec(Buffer.from(token, 'base64url').toString('utf8'));
    return m === null ? null : Number(m[1]);
  },
};

function listEntries(res, url, { config, dir }) {
  const q = url.searchParams;
  const team = q.get('team');
  const month = q.get('month');
  const limit = q.has('limit') ? Number(q.get('limit')) : DEFAULT_LIMIT;
  const offset = q.has('page_token') ? cursor.decode(q.get('page_token')) : 0;
  // A parameter the list does not know is refused with the others, never ignored (design/api.md, "Errors").
  const invalid = [...new Set(q.keys())].filter((k) => !LIST_PARAMS.includes(k))
    .map((k) => ({ name: k, reason: `${k} is not a list parameter; send only team, month, limit and page_token.` }));
  if (team !== null && !config.teams.some((t) => t.id === team)) invalid.push({ name: 'team', reason: `team must be one of ${config.teams.map((t) => t.id).join(', ')}` });
  if (month !== null && !isMonth(month)) invalid.push({ name: 'month', reason: 'month must look like 2026-09' });
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) invalid.push({ name: 'limit', reason: `limit must be a whole number from 1 to ${MAX_LIMIT}` });
  if (offset === null) invalid.push({ name: 'page_token', reason: 'page_token must be a next_page_token from an earlier page, passed back unchanged' });
  if (invalid.length > 0) {
    return problem(res, 400, 'invalid-query', 'The query is not valid', 'Fix the parameters listed in invalid_params and send the request again.', url.pathname, { invalid_params: invalid });
  }
  const all = openLedger(dir).entries.filter((e) => (team === null || e.team === team) && (month === null || e.month === month));
  const page = all.slice(offset, offset + limit);
  const next = offset + limit < all.length ? cursor.encode(offset + limit) : null;
  return json(res, 200, { entries: page.map(view), next_page_token: next });
}

async function createEntry(req, res, url, { config, dir }) {
  const body = await readJson(req);
  if (!body.ok || typeof body.value !== 'object' || body.value === null || Array.isArray(body.value)) {
    return problem(res, 400, 'malformed-body', 'The body is not a JSON object', 'Send a JSON object with team, month, vendor, amount and an optional note.', url.pathname);
  }
  const key = req.headers['idempotency-key'] ?? null;
  const ledger = openLedger(dir);
  const fingerprint = JSON.stringify(body.value);
  if (key !== null && Object.hasOwn(ledger.idempotency, key)) {
    const seen = ledger.idempotency[key];
    if (seen.fingerprint !== fingerprint) {
      return problem(res, 409, 'idempotency-conflict', 'The idempotency key was used for a different request', `Idempotency-Key ${key} already created ${seen.id} from a different body; use a new key for a new entry.`, url.pathname);
    }
    return json(res, 201, view(ledger.entries.find((e) => e.id === seen.id)), { location: `/api/v1/entries/${seen.id}` });
  }
  // A field the API does not know is refused with the others, never dropped (design/api.md, "Errors").
  const unknown = Object.keys(body.value).filter((k) => !ENTRY_FIELDS.includes(k))
    .map((k) => ({ field: k, message: `${k} is not an entry field; send only team, month, vendor, amount and note.` }));
  // Amounts are decimal strings, never JSON numbers (design/api.md, "Style"): a number amount is refused, not read.
  const mistyped = body.value.amount === undefined || typeof body.value.amount === 'string' ? []
    : [{ field: 'amount', message: 'Amount must be a decimal string, like "120.50", not a JSON number.' }];
  const valid = checkEntry(body.value, config);
  const refused = [...mistyped, ...unknown];
  const checked = refused.length === 0 ? valid
    : { ok: false, errors: [...(valid.ok ? [] : valid.errors.filter((e) => !mistyped.some((m) => m.field === e.field))), ...refused] };
  if (!checked.ok) {
{{validation-response}}
  }
  const [entry] = addEntries(dir, [checked.entry]);
  if (key !== null) {
    const after = openLedger(dir);
    after.idempotency[key] = { id: entry.id, fingerprint };
    save(dir, after);
  }
  return json(res, 201, view(entry), { location: `/api/v1/entries/${entry.id}` });
}

/** Answers an /api/ request. */
export async function api(req, res, url, ctx) {
  const path = url.pathname;
  const token = process.env.LEDGERLY_API_TOKEN;
  if (token === undefined || token === '') {
    return problem(res, 503, 'api-disabled', 'The API is not enabled', 'Start the server with LEDGERLY_API_TOKEN set to the token clients will send.', path);
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    return problem(res, 401, 'unauthorized', 'Missing or wrong API token', 'Send the header Authorization: Bearer <token>, with the token the server was started with (LEDGERLY_API_TOKEN).', path);
  }
  if (path === '/api/v1/teams' && req.method === 'GET') {
    return json(res, 200, { teams: ctx.config.teams.map((t) => ({ id: t.id, name: t.name, budget: plainAmount(t.budget), alert_at: t.alertAt })) });
  }
  if (path === '/api/v1/entries' && req.method === 'GET') return listEntries(res, url, ctx);
  if (path === '/api/v1/entries' && req.method === 'POST') return createEntry(req, res, url, ctx);
  const one = /^\/api\/v1\/entries\/(e-\d{4})$/.exec(path);
  if (one !== null && req.method === 'GET') {
    const found = openLedger(ctx.dir).entries.find((e) => e.id === one[1]);
    if (found === undefined) return problem(res, 404, 'not-found', 'No such entry', `There is no entry ${one[1]}; list entries with GET /api/v1/entries.`, path);
    return json(res, 200, view(found));
  }
  return problem(res, 404, 'not-found', 'No such endpoint', `${req.method} ${path} is not part of the API; the endpoints are listed in design/api.md.`, path);
}
