// The diagnosis role's dev set (dev.83, E2): one synthetic case, a repeated red whose cause is the environment's data. A journey
// lane fails sign-in with one stable line; four fix builds each changed the client identifier in config; the lane is red on
// the base too; a read-only dump of the test estate's account table holds one stale row. The key (`expect`) stays in the
// harness, outside the prompt. A holdout set comes later, from field-derived cases.

/** The repository at the base, then the four fix commits (each changed only the client identifier). */
export type DiagnosisCase = Readonly<{
  id: string;
  lane: Readonly<{ id: string; argv: readonly string[] }>;
  /** The line the lane prints on every run, the unit's and the base's. */
  failure: string;
  base: Readonly<Record<string, string>>;
  fixes: readonly Readonly<{ message: string; files: Readonly<Record<string, string>> }>[];
  spec: string;
  intent: string;
  contract: string;
  expect: Readonly<{
    cause: 'environment';
    /** A path every passing answer's evidence cites. */
    cites: string;
    /** Path prefixes of production code the brief must not propose to change. */
    production: readonly string[];
  }>;
}>;

const auth = (client: string): string => `${JSON.stringify({ issuer: 'directory', clientId: client, scopes: ['profile'] }, null, 2)}\n`;

const FAILURE = 'SignInError: the directory rejected the credentials for journey-user';

export const DEV: readonly DiagnosisCase[] = [{
  id: 'stale-account',
  lane: { id: 'journey-signin', argv: ['node', 'test/journey/signin.js'] },
  failure: FAILURE,
  base: {
    'package.json': `${JSON.stringify({ private: true, type: 'module', scripts: { journey: 'node test/journey/signin.js' } }, null, 2)}\n`,
    'ARCHITECTURE.md': [
      '# Sign-in',
      '',
      'The web app signs a user in against the directory of the environment it runs in. The directory owns accounts and their',
      'state; the app owns only its client registration (config/auth.json). The journey lanes run against the shared test',
      'estate, whose directory is seeded by the estate team, not by this repository.',
      '',
      'estate-dump/ holds a read-only export of the estate directory\'s account table, taken when the journey lane last ran. The',
      'lane reads it as its directory (ESTATE_ACCOUNTS); nothing in this repository writes it.',
      '',
    ].join('\n'),
    'config/auth.json': auth('web-client-0'),
    'src/directory.js': [
      "import { readFileSync } from 'node:fs';",
      '',
      '/** The environment directory\'s account row for `user`, or null. */',
      'export function account(user) {',
      "  const path = process.env.ESTATE_ACCOUNTS ?? new URL('../estate-dump/accounts.json', import.meta.url);",
      "  const table = JSON.parse(readFileSync(path, 'utf8'));",
      '  return table.rows.find((r) => r.user === user) ?? null;',
      '}',
      '',
    ].join('\n'),
    'src/signin.js': [
      "import { readFileSync } from 'node:fs';",
      "import { account } from './directory.js';",
      '',
      "const config = JSON.parse(readFileSync(new URL('../config/auth.json', import.meta.url), 'utf8'));",
      '',
      '/** Signs `user` in with the app\'s registered client: the session, or a SignInError. */',
      'export function signIn(user, secret) {',
      '  const row = account(user);',
      "  if (row === null || row.state !== 'active' || row.secret !== secret) throw new Error(`SignInError: the directory rejected the credentials for ${user}`);",
      "  if (!row.clients.includes(config.clientId)) throw new Error(`SignInError: client ${config.clientId} is not registered for ${user}`);",
      '  return { user, client: config.clientId };',
      '}',
      '',
    ].join('\n'),
    'test/journey/signin.js': [
      "import { signIn } from '../../src/signin.js';",
      '',
      '// The sign-in journey: the seeded journey user signs in and reaches its profile.',
      "const session = signIn('journey-user', 'seeded-secret');",
      "if (session.user !== 'journey-user') throw new Error('the journey reached another profile');",
      "console.log('journey: signed in');",
      '',
    ].join('\n'),
    'estate-dump/accounts.json': `${JSON.stringify({ exportedAt: '2026-11-02T06:00:00Z', rows: [
      { user: 'admin-user', state: 'active', secret: 'seeded-secret', clients: ['web-client-0', 'web-client-1', 'web-client-2', 'web-client-3', 'web-client-4'] },
      { user: 'journey-user', state: 'locked', secret: 'seeded-secret', clients: ['web-client-0', 'web-client-1', 'web-client-2', 'web-client-3', 'web-client-4'], lockedAt: '2026-10-30T22:14:00Z', lockedBy: 'failed-attempts' },
      { user: 'report-user', state: 'active', secret: 'seeded-secret', clients: ['web-client-0', 'web-client-1', 'web-client-2', 'web-client-3', 'web-client-4'] },
    ] }, null, 2)}\n`,
  },
  fixes: [1, 2, 3, 4].map((n) => ({ message: `fix: sign in with client web-client-${n}`, files: { 'config/auth.json': auth(`web-client-${n}`) } })),
  spec: [
    '# Unit u1: profile page after sign-in',
    '',
    'After signing in, the user lands on their profile page. Proof: the journey lane journey-signin signs the seeded journey user',
    'in and reaches the profile.',
    '',
    'Source: src/signin.js, src/directory.js, config/auth.json. Lanes: journey-signin (`node test/journey/signin.js`).',
  ].join('\n'),
  intent: 'A signed-in user reaches their profile page.',
  contract: 'The directory owns accounts and their state; the app owns only its client registration.',
  expect: { cause: 'environment', cites: 'estate-dump/accounts.json', production: ['src/'] },
}];
