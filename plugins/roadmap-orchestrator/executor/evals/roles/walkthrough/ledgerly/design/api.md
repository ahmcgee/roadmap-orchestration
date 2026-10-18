# ledgerly HTTP API

`/api/v1` on the dashboard's port. JSON in, JSON out.

## Style

- Resources are plural nouns (`/entries`, `/teams`); ids are the ledger's (`e-0042`). Field names are `snake_case`.
- Standard methods only: `GET /entries` lists, `GET /entries/<id>` reads, `POST /entries` creates. Entries are never
  changed or deleted through the API.
- Amounts are decimal strings with two places (`"1200.00"`), never floats. Months are `"YYYY-MM"`.
- Lists are paginated with an opaque cursor: `limit` (1 to 100, default 20) and `page_token`; the response carries
  `next_page_token`, null on the last page. Filters: `team`, `month`.
- Creates take an optional `Idempotency-Key` header. The same key with the same body returns the first response again
  (201, the same entry); the same key with a different body is a 409.
- Versioning: the path carries the major version. Fields may be added within v1; nothing is removed or renamed.

## Auth

Every request sends `Authorization: Bearer <token>`, the token the server was started with (`LEDGERLY_API_TOKEN`).

## Errors: RFC 9457 problem details

Every error, and only an error, answers with a 4xx or 5xx status and `content-type: application/problem+json`:
`type`, `title`, `status`, `detail` (what to do about it, for a person) and `instance` (the request path). Clients
switch on `type`, never on `detail`. Machine-readable specifics go in extension members: a validation problem lists each
bad field or parameter in `invalid_params`, `[{ "name", "reason" }]`, all of them in one response. Nothing sent is
ignored: an entry body carrying a field the API does not know (anything but `team`, `month`, `vendor`, `amount` and
`note`) is refused as `invalid-entry`, each unknown field named in `invalid_params` beside any wrong ones.

| `type` (under `https://ledgerly.dev/problems/`) | Status | When |
|---|---|---|
| `unauthorized` | 401 | the token is missing or wrong |
| `api-disabled` | 503 | the server was started without `LEDGERLY_API_TOKEN` |
| `malformed-body` | 400 | the body is not a JSON object |
| `invalid-entry` | 422 | an entry's fields are wrong or unknown; `invalid_params` names each |
| `invalid-query` | 400 | a list's parameters are wrong; `invalid_params` names each |
| `idempotency-conflict` | 409 | an `Idempotency-Key` reused with a different body |
| `not-found` | 404 | no such entry or endpoint |

## Endpoints

- `GET /api/v1/teams`: `{ "teams": [{ "id", "name", "budget", "alert_at" }] }`.
- `GET /api/v1/entries?team=&month=&limit=&page_token=`: `{ "entries": [Entry], "next_page_token": string | null }`.
- `GET /api/v1/entries/<id>`: an Entry.
- `POST /api/v1/entries`, body `{ "team", "month", "vendor", "amount", "note"? }`: 201 with the Entry and a `location`.

Entry: `{ "id", "team", "month", "vendor", "amount", "note" }`.

## Example sessions

Record an entry, then list it back (the first-success path: two requests):

```http
POST /api/v1/entries
Authorization: Bearer dev
Idempotency-Key: 6f1c2a
Content-Type: application/json

{ "team": "platform", "month": "2026-09", "vendor": "Hetzner", "amount": "312.40", "note": "build runners" }

HTTP/1.1 201 Created
Location: /api/v1/entries/e-0031
Content-Type: application/json

{ "id": "e-0031", "team": "platform", "month": "2026-09", "vendor": "Hetzner", "amount": "312.40", "note": "build runners" }
```

```http
GET /api/v1/entries?team=platform&month=2026-09&limit=2
Authorization: Bearer dev

HTTP/1.1 200 OK
Content-Type: application/json

{ "entries": [ { "id": "e-0003", ... }, { "id": "e-0007", ... } ], "next_page_token": "bzoy" }
```

A refused entry:

```http
POST /api/v1/entries
Authorization: Bearer dev
Content-Type: application/json

{ "team": "platform", "month": "Sept", "vendor": "Hetzner", "amount": "12,50" }

HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://ledgerly.dev/problems/invalid-entry",
  "title": "The entry is not valid",
  "status": 422,
  "detail": "Fix the fields listed in invalid_params and send the request again.",
  "instance": "/api/v1/entries",
  "invalid_params": [
    { "name": "month", "reason": "Month must look like 2026-09: the year, a dash, then the two-digit month." },
    { "name": "amount", "reason": "Amount must be a number above zero, like 120 or 120.50, without a currency sign." }
  ]
}
```

A missing token:

```http
GET /api/v1/entries

HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json

{ "type": "https://ledgerly.dev/problems/unauthorized", "title": "Missing or wrong API token", "status": 401,
  "detail": "Send the header Authorization: Bearer <token>, ...", "instance": "/api/v1/entries" }
```
