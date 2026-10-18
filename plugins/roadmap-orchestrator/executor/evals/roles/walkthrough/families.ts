// The walkthrough eval's 13 defect families (plan §7, "Slots and families"). Each slot of a trial's product gets its
// family's plant or its clean twin, a sanctioned near-miss the design reference allows, so a false positive is
// measurable. A family says where it may go (its positions), what it writes there (hook contributions to the base
// product, product.ts) and how a finding is localised to it and how its journey is known to have been exercised (the
// answer key's slot, grade.ts).
//
// Positions: W1 takes a browser journey's last step (the form or link that ends J-1, J-2 or J-3); W2 to W7 take a page,
// one slot per page (slots.ts); W8 a CLI command; W13 a quickstart command; W9 to W12 are fixed.
//
// The families below are each family's dev form. A cell may carry a family in another form (fixture.ts `WalkCell.forms`:
// its own plant, twin, positions, contributions and locus, of the same id and expected class); the holdout set's are.

import type { Edit, NewFile } from './product.ts';

export const FAMILY_IDS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12', 'W13'] as const;
export type FamilyId = (typeof FAMILY_IDS)[number];

/**
 * The class a caught plant must reach, by the owner's rule (2026-10-18): `breaks` when fixing it later would force rework
 * of what is built on it (a journey that cannot be completed, a wrong interface contract, a declared floor violated),
 * `deviates` for the rest (wording, visuals within the tokens, layout, docs that disagree with a correct contract, log
 * and CI output text).
 */
export type Expected = 'breaks' | 'deviates';
export type SlotState = 'plant' | 'twin';

/** The dashboard's pages with slots (overview and not-found carry none), each its module and its journey. */
export const PAGES = ['entries', 'entry-new', 'entry', 'budgets', 'budget', 'budget-edit', 'statements', 'statement', 'statement-print'] as const;
export type PageId = (typeof PAGES)[number];
export const BROWSER_JOURNEYS = ['J-1', 'J-2', 'J-3'] as const;
export type BrowserJourney = (typeof BROWSER_JOURNEYS)[number];

type PageInfo = Readonly<{ journey: BrowserJourney; route: string; primary: boolean; form: boolean }>;
/** `route`: a regex source matching the page's own path (and no deeper one). */
export const PAGE_INFO: Readonly<Record<PageId, PageInfo>> = {
  entries: { journey: 'J-1', route: '/entries(?![/\\w-])', primary: true, form: false },
  'entry-new': { journey: 'J-1', route: '/entries/new', primary: true, form: true },
  entry: { journey: 'J-1', route: '/entries/e-\\d+', primary: true, form: false },
  budgets: { journey: 'J-2', route: '/budgets(?![/\\w-])', primary: false, form: false },
  budget: { journey: 'J-2', route: '/budgets/[a-z][a-z0-9-]*(?![/\\w-])', primary: true, form: false },
  'budget-edit': { journey: 'J-2', route: '/budgets/[a-z][a-z0-9-]*/edit', primary: true, form: true },
  statements: { journey: 'J-3', route: '/statements(?![/\\w-])', primary: true, form: false },
  statement: { journey: 'J-3', route: '/statements/\\d{4}-\\d{2}(?![/\\w-])', primary: true, form: false },
  'statement-print': { journey: 'J-3', route: '/statements/\\d{4}-\\d{2}/print(?![\\w-])', primary: false, form: false },
};
export const pageFile = (p: PageId): string => `web/pages/${p}.js`;
/** A concrete address of a page in a seeded product (team `platform`, entry e-0001, the seed's `month`). */
export function pagePath(p: PageId, month: string): string {
  const paths: Record<PageId, string> = {
    entries: '/entries', 'entry-new': '/entries/new', entry: '/entries/e-0001', budgets: '/budgets', budget: '/budgets/platform', 'budget-edit': '/budgets/platform/edit',
    statements: '/statements', statement: `/statements/${month}`, 'statement-print': `/statements/${month}/print`,
  };
  return paths[p];
}
/** The pages a family on a page may take: every dashboard page but the print view (W2's twin holds that). */
export const STYLED_PAGES: readonly PageId[] = PAGES.filter((p) => p !== 'statement-print');

/** W1's flows: the page whose last step it breaks, and the path that step goes to. */
export const FLOW_PAGE: Readonly<Record<BrowserJourney, PageId>> = { 'J-1': 'entry-new', 'J-2': 'budget-edit', 'J-3': 'statement' };
const FLOW_TARGET: Readonly<Record<BrowserJourney, string>> = { 'J-1': '/entries/record', 'J-2': '/budgets/[a-z][a-z0-9-]*/limits', 'J-3': '/statements/\\d{4}-\\d{2}/printable' };

export type CliCommand = 'import' | 'report' | 'config';
/** The shell journey each CLI command is walked in. */
export const COMMAND_JOURNEY: Readonly<Record<CliCommand, string>> = { import: 'J-4', report: 'J-5', config: 'J-7' };

export type Position =
  | Readonly<{ kind: 'page'; page: PageId }>
  | Readonly<{ kind: 'flow'; journey: BrowserJourney }>
  | Readonly<{ kind: 'command'; command: CliCommand }>
  | Readonly<{ kind: 'quickstart'; command: 'init' | 'import' | 'report' }>
  | Readonly<{ kind: 'fixed' }>;

/**
 * What a slot writes into the base product (product.ts): a text for one of its hooks (`css` contributions are appended,
 * the rest set), an edit of a file as the hooks resolved it, its `find` occurring exactly once (product.ts `Edit`), or a
 * file the base product does not hold (product.ts `NewFile`).
 */
export type Contribution = Readonly<{ file: string; hook: string; text: string }> | Edit | NewFile;

/**
 * What grading knows of a slot. `journeys`: where a finding on it is reported; `files`: paths that localise a finding to
 * it; `markers` and `exercise`: regex sources (case-insensitive), the first matched in a finding's claim and cause, the
 * second in the session's tool traffic outside Read, Grep and Glob (a page visited, a command run).
 */
export type SlotLocus = Readonly<{ journeys: readonly string[]; files: readonly string[]; markers: readonly string[]; exercise: readonly string[] }>;

export type Family = Readonly<{
  id: FamilyId;
  expected: Expected;
  plant: string;
  twin: string;
  /** Where the family may go in a trial (the twin's position, when it differs, is `twinAt`). */
  positions: readonly Position[];
  /** A twin that always sits in one place, whatever the plant's position would be (W2: the print view). */
  twinAt: Position | null;
  apply: (state: SlotState, at: Position) => readonly Contribution[];
  locus: (state: SlotState, at: Position) => SlotLocus;
}>;

/** Each family's words, a regex source: the markers a finding on it matches. */
export const KEYWORDS: Readonly<Record<FamilyId, string>> = {
  W1: '404|not found|dead[- ]end|broken (link|form|submit)|nowhere|lost',
  W2: 'stylesheet|unstyled|\\bcss\\b|no styl|styling|raw html|browser default',
  W3: 'token|off-palette|palette|padding|gutter|spacing|lavender|purple|violet|card colou?r|highlight',
  W4: 'console|uncaught|typeerror|exception|javascript error|script error',
  W5: 'contrast|legib|faint|hard to read|low-contrast|4\\.5:1|1\\.4\\.3|caption',
  W6: 'focus|outline|keyboard',
  W7: 'invalid input|vague|error message|which field|error copy|error text',
  W8: 'stdout|stderr|exit code|exit status|exits 0|exit 0|streams?',
  W9: '\\b200\\b|problem|9457|error body|status code|\\b422\\b',
  W10: 'unknown key|ignored|silent|warn|typo|misspel',
  W11: 'stack trace|no arguments|without arguments|no args|typo|did you mean|unknown command|usage|silently|nearest',
  W12: 'exit 1|which step|failing (test|step|file)|rerun|re-run|reproduce|names? the',
  W13: 'readme|quickstart|--data-dir|--period|as written|documented',
};

const page = (at: Position): PageId => {
  if (at.kind !== 'page') throw new Error(`a page family at a ${at.kind} position`);
  return at.page;
};

/** A family that sits on one page: its locus is the page's journey, module, route and the family's words. */
export function pageLocus(id: FamilyId, p: PageId, extra: readonly string[] = [], files: readonly string[] = []): SlotLocus {
  const info = PAGE_INFO[p];
  return { journeys: [info.journey], files: [pageFile(p), ...files], markers: [info.route, KEYWORDS[id], ...extra], exercise: [info.route] };
}

export const css = (text: string): Contribution => ({ file: 'web/static/app.css', hook: 'css', text });

const W1: Family = {
  id: 'W1', expected: 'breaks',
  plant: "a journey's last step goes to a path nothing serves: a 404 dead end",
  twin: 'the same step goes to an old path that redirects to the real page',
  positions: BROWSER_JOURNEYS.map((journey) => ({ kind: 'flow', journey })), twinAt: null,
  apply: (state, at) => {
    if (at.kind !== 'flow') throw new Error('W1 off a flow');
    const step: Contribution = at.journey === 'J-1' ? { file: pageFile('entry-new'), hook: 'action', text: '/entries/record' }
      : at.journey === 'J-2' ? { file: pageFile('budget-edit'), hook: 'action', text: '/budgets/${team.id}/limits' }
      : { file: pageFile('statement'), hook: 'print-link', text: '/statements/${month}/printable' };
    if (state === 'plant') return [step];
    const route = at.journey === 'J-1' ? "  ['POST', '/entries/record', redirect(307, () => '/entries')],"
      : at.journey === 'J-2' ? "  ['POST', `/budgets/${TEAM}/limits`, redirect(307, ({ params }) => `/budgets/${params[0]}/limit`)],"
      : "  ['GET', `/statements/${MONTH}/printable`, redirect(302, ({ params }) => `/statements/${params[0]}/print`)],";
    return [step, { file: 'server/main.js', hook: 'routes', text: route }];
  },
  locus: (_state, at) => {
    if (at.kind !== 'flow') throw new Error('W1 off a flow');
    const p = FLOW_PAGE[at.journey];
    return { journeys: [at.journey], files: [pageFile(p), 'server/main.js'], markers: [PAGE_INFO[p].route, FLOW_TARGET[at.journey], KEYWORDS.W1], exercise: [PAGE_INFO[p].route] };
  },
};

const W2: Family = {
  id: 'W2', expected: 'deviates',
  plant: "one page's component stylesheet link 404s, so the page renders unstyled",
  twin: 'the print view, intentionally plain per the reference ("Print views")',
  positions: STYLED_PAGES.map((p) => ({ kind: 'page', page: p })), twinAt: { kind: 'page', page: 'statement-print' },
  apply: (state, at) => (state === 'plant' ? [{ file: pageFile(page(at)), hook: 'layout', text: ", stylesheet: '/static/ledgerly.css'" }] : []),
  locus: (state, at) => pageLocus('W2', page(at), state === 'plant' ? ['ledgerly\\.css'] : ['print\\.css'], state === 'plant' ? ['web/layout.js'] : ['web/static/print.css']),
};

const W3: Family = {
  id: 'W3', expected: 'deviates',
  plant: "one page's card uses an off-token colour (#F1E9FB) and a 13 px gutter",
  twin: "one page's card uses the documented highlight variant (--ll-highlight, --space-4)",
  positions: STYLED_PAGES.map((p) => ({ kind: 'page', page: p })), twinAt: null,
  apply: (state, at) => (state === 'plant'
    ? [{ file: pageFile(page(at)), hook: 'card', text: ' card-tinted' }, css('.card-tinted { background: #F1E9FB; border-color: #E2D3F5; padding: 13px; }')]
    : [{ file: pageFile(page(at)), hook: 'card', text: ' card--highlight' }]),
  locus: (state, at) => pageLocus('W3', page(at), [state === 'plant' ? 'card-tinted|#?f1e9fb|13 ?px' : 'card--highlight']),
};

const W4: Family = {
  id: 'W4', expected: 'deviates',
  plant: 'an uncaught TypeError on load (a listener on an element the page lacks); the page still works',
  twin: 'one console.info line naming the view, which the reference allows',
  positions: STYLED_PAGES.map((p) => ({ kind: 'page', page: p })), twinAt: null,
  apply: (state, at) => [{
    file: pageFile(page(at)), hook: 'script',
    text: state === 'plant'
      ? "    <script>document.getElementById('month-filter').addEventListener('change', (event) => event.target.form.submit());</script>"
      : `    <script>console.info('ledgerly: ${page(at)} view');</script>`,
  }],
  locus: (_state, at) => pageLocus('W4', page(at), ['month-filter|console\\.info']),
};

const W5: Family = {
  id: 'W5', expected: 'breaks',
  plant: "one page's lead paragraph is set in #848E89 on the paper ground: 3.1:1, under the 4.5:1 floor",
  twin: 'a muted caption (--ll-ink-muted) at 4.6:1, the reference\'s use of that token',
  positions: STYLED_PAGES.map((p) => ({ kind: 'page', page: p })), twinAt: null,
  apply: (state, at) => (state === 'plant'
    ? [{ file: pageFile(page(at)), hook: 'lead', text: ' lead-soft' }, css('.lead-soft { color: #848E89; }')]
    : [{ file: pageFile(page(at)), hook: 'after-lead', text: '    <p class="caption">Amounts include tax where the vendor charged it.</p>' }]),
  locus: (state, at) => pageLocus('W5', page(at), [state === 'plant' ? 'lead-soft|#?848e89|lead paragraph' : 'amounts include tax|ink-muted']),
};

const W6: Family = {
  id: 'W6', expected: 'breaks',
  plant: "one page's primary button has outline: none and no other focus indicator",
  twin: "one page's primary button draws its focus ring as a box-shadow (outline: none plus a ring), as the reference allows",
  positions: STYLED_PAGES.filter((p) => PAGE_INFO[p].primary).map((p) => ({ kind: 'page', page: p })), twinAt: null,
  apply: (state, at) => (state === 'plant'
    ? [{ file: pageFile(page(at)), hook: 'primary', text: ' button-flat' }, css('.button-flat:focus, .button-flat:focus-visible { outline: none; }')]
    : [{ file: pageFile(page(at)), hook: 'primary', text: ' button-ring' }, css('.button-ring:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--ll-paper), 0 0 0 5px var(--ll-focus); }')]),
  locus: (state, at) => pageLocus('W6', page(at), [state === 'plant' ? 'button-flat' : 'button-ring|box-shadow']),
};

const W7: Family = {
  id: 'W7', expected: 'deviates',
  plant: 'a refused form says only "Invalid input", naming no field and no fix',
  twin: 'a refused form names each field and how to fix it',
  positions: STYLED_PAGES.filter((p) => PAGE_INFO[p].form).map((p) => ({ kind: 'page', page: p })), twinAt: null,
  apply: (state, at) => [{ file: pageFile(page(at)), hook: 'shown-errors', text: state === 'plant' ? "errors.length > 0 ? [{ field: null, message: 'Invalid input' }] : []" : 'errors' }],
  locus: (_state, at) => pageLocus('W7', page(at), [], ['web/forms.js', 'src/validate.js']),
};

const W8: Family = {
  id: 'W8', expected: 'breaks',
  plant: "a command's input errors go to stdout and it exits 0",
  twin: "a command prints progress lines on stderr and exits 0 on success",
  positions: [{ kind: 'command', command: 'import' }, { kind: 'command', command: 'report' }], twinAt: null,
  apply: (state, at) => {
    if (at.kind !== 'command') throw new Error('W8 off a command');
    const file = `src/commands/${at.command}.js`;
    if (at.command === 'config') throw new Error('W8 in its dev form takes import or report');
    if (state === 'plant') return [{ file, hook: 'input-error', text: '    io.out(`ledgerly: ${e.message}`);\n    return 0;' }];
    return at.command === 'import'
      ? [{ file, hook: 'progress-start', text: '    io.err(`Reading ${path}`);' }, { file, hook: 'progress-checked', text: '    io.err(`Checked ${rows.length} rows`);' }]
      : [{ file, hook: 'progress-start', text: '    io.err(`Reading the ledger in ${dir}`);' }, { file, hook: 'progress-checked', text: '    io.err(`${view.entries.length} entries for ${team.id} in ${month}`);' }];
  },
  locus: (_state, at) => {
    if (at.kind !== 'command') throw new Error('W8 off a command');
    return {
      journeys: [COMMAND_JOURNEY[at.command]], files: [`src/commands/${at.command}.js`],
      markers: [`\\b${at.command}\\b`, KEYWORDS.W8], exercise: [`ledgerly(?:\\.js)?\\s+${at.command}\\b`],
    };
  },
};

const W9: Family = {
  id: 'W9', expected: 'breaks',
  plant: 'a refused POST /api/v1/entries answers 200 with an {error} body',
  twin: 'a refused POST answers 422 with an RFC 9457 problem carrying the invalid_params extension member',
  positions: [{ kind: 'fixed' }], twinAt: null,
  apply: (state) => [{
    file: 'server/api.js', hook: 'validation-response',
    text: state === 'plant'
      ? "    return json(res, 200, { error: checked.errors.map((e) => e.message).join(' ') });"
      : "    return problem(res, 422, 'invalid-entry', 'The entry is not valid', 'Fix the fields listed in invalid_params and send the request again.', url.pathname, {\n      invalid_params: checked.errors.map((e) => ({ name: e.field, reason: e.message })),\n    });",
  }],
  locus: () => ({ journeys: ['J-6'], files: ['server/api.js'], markers: ['/api/v1', KEYWORDS.W9], exercise: ['/api/v1'] }),
};

const W10: Family = {
  id: 'W10', expected: 'breaks',
  plant: 'an unknown key in ledgerly.conf is silently ignored',
  twin: 'an unknown key is ignored with a warning naming the file, line, key and the nearest known key',
  positions: [{ kind: 'fixed' }], twinAt: null,
  apply: (state) => [{
    file: 'src/config.js', hook: 'unknown-key',
    text: state === 'plant'
      ? '      return;'
      : "      const near = closest(key, known);\n      warnings.push(`${file}:${line}: unknown key \"${key}\"${team === null ? '' : ` in [team.${team.id}]`}, ignored${near === null ? '' : `; did you mean \"${near}\"?`}`);\n      return;",
  }],
  locus: () => ({ journeys: ['J-7'], files: ['src/config.js', 'ledgerly.conf'], markers: ['ledgerly\\.conf|config check', KEYWORDS.W10], exercise: ['config\\s+check', 'ledgerly\\.conf'] }),
};

const W11: Family = {
  id: 'W11', expected: 'breaks',
  plant: 'no arguments prints a stack trace; a mistyped command silently runs the nearest one',
  twin: 'no arguments prints the usage, examples first; a mistyped command suggests the nearest one without running it',
  positions: [{ kind: 'fixed' }], twinAt: null,
  apply: (state) => [{
    file: 'bin/ledgerly.js', hook: 'dispatch',
    text: state === 'plant'
      ? '  const name = COMMANDS[argv[0]] === undefined ? closest(argv[0], Object.keys(COMMANDS)) : argv[0];\n  return COMMANDS[name].run(argv.slice(1), io);'
      : [
        '  if (argv.length === 0) {',
        '    io.err(USAGE);',
        '    return 2;',
        '  }',
        '  const command = COMMANDS[argv[0]];',
        '  if (command === undefined) {',
        '    const near = closest(argv[0], Object.keys(COMMANDS));',
        '    throw new UsageError(`unknown command "${argv[0]}"; ${near === null ? \'run\' : `did you mean "${near}"? Run`} "ledgerly --help" for every command.`);',
        '  }',
        '  return command.run(argv.slice(1), io);',
      ].join('\n'),
  }],
  locus: () => ({ journeys: ['J-4', 'J-5', 'J-7', 'J-9'], files: ['bin/ledgerly.js', 'src/closest.js'], markers: [KEYWORDS.W11], exercise: ['bin/ledgerly\\.js'] }),
};

const W12: Family = {
  id: 'W12', expected: 'deviates',
  plant: 'a failing step reports only "exit 1"',
  twin: 'a failing step names the step, the failing test file, its output and how to rerun it locally',
  positions: [{ kind: 'fixed' }], twinAt: null,
  apply: (state) => [{
    file: 'ci/run.js', hook: 'failure-report',
    text: state === 'plant'
      ? '  process.stdout.write(`exit ${result.status}\\n`);'
      : [
        '  process.stdout.write(`  ${step.name.padEnd(10)} FAILED  ${seconds(ms)} (exit ${result.status})\\n\\n`);',
        '  const lines = [`Step "${step.name}" failed (${file}:${step.runLine}): ${step.run}`];',
        "  if (argv.includes('--test')) {",
        "    const failing = testFilesOf(argv).map((f) => ({ f, r: spawnSync(argv[0], ['--test', f], { encoding: 'utf8' }) })).filter((x) => x.r.status !== 0);",
        "    lines.push(`${failing.length} test ${failing.length === 1 ? 'file' : 'files'} failed:`);",
        '    for (const { f, r } of failing) lines.push(`  ${f}`, tail(`${r.stdout}${r.stderr}`, 12), `  rerun it locally: node --test ${f}`);',
        '  } else {',
        '    lines.push(tail(`${result.stdout}${result.stderr}`, 12), `Rerun it locally: ${step.run}`);',
        '  }',
        "  process.stdout.write(`${lines.join('\\n')}\\n`);",
      ].join('\n'),
  }],
  locus: () => ({ journeys: ['J-8'], files: ['ci/run.js', 'ci/pipeline.yml'], markers: ['ci/run|pipeline', KEYWORDS.W12], exercise: ['ci/run\\.js'] }),
};

const W13: Family = {
  id: 'W13', expected: 'deviates',
  plant: 'the README is stale against a correct cli.md: a quickstart command uses a renamed flag and fails as written',
  twin: 'the command runs as written, with an optional flag documented beside it',
  positions: [{ kind: 'quickstart', command: 'init' }, { kind: 'quickstart', command: 'report' }], twinAt: null,
  apply: (state, at) => {
    if (at.kind !== 'quickstart') throw new Error('W13 off the quickstart');
    if (at.command === 'import') throw new Error('W13 in its dev form takes init or report');
    if (at.command === 'init') {
      return [{
        file: 'README.md', hook: 'qs-init',
        text: state === 'plant' ? '   node bin/ledgerly.js init --data-dir .ledgerly' : '   node bin/ledgerly.js init --data .ledgerly   # add --force to start again from an empty ledger',
      }];
    }
    return [{
      file: 'README.md', hook: 'qs-report',
      text: state === 'plant'
        ? '   node bin/ledgerly.js report --team {{team}} --period {{month}} --data .ledgerly'
        : '   node bin/ledgerly.js report --team {{team}} --month {{month}} --data .ledgerly   # add --json for output a script can read',
    }];
  },
  locus: (state, at) => {
    if (at.kind !== 'quickstart') throw new Error('W13 off the quickstart');
    const extra = state === 'plant' ? (at.command === 'init' ? '--data-dir' : '--period') : (at.command === 'init' ? '--force' : '--json');
    return { journeys: ['J-9'], files: ['README.md'], markers: [KEYWORDS.W13, extra], exercise: ['ledgerly(?:\\.js)?\\s+(?:init|import|report)\\b'] };
  },
};

export type FamilyTable = Readonly<Record<FamilyId, Family>>;
export const FAMILIES: FamilyTable = { W1, W2, W3, W4, W5, W6, W7, W8, W9, W10, W11, W12, W13 };
