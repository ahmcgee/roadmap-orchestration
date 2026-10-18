// The polish-judge eval's four families (plan §7, "Polish judge cells"): spacing, hierarchy, CLI help ordering and error
// copy, each on one journey of the walkthrough eval's `ledgerly` product. A family is a starting state, its `before`
// (edits to the clean product: something a walk proposes polish for), and its three cells (cells.ts) are after-states of
// the same step: a `better` one the design reference's own direction favours, a `worse` one that regresses it, and a
// `neutral` one, cosmetic churn that changes nothing a person gains from. Every after-state also edits the reference
// (`design/`), as a polish unit does: the compare drops a tweak whose diff leaves the reference untouched without asking.
//
// An edit is a literal replacement in one file of the product as the generator resolves it (walkthrough/product.ts):
// its `find` must occur exactly once when it is applied, so a drift in the base product fails loud here.
import type { FileMap } from '../walkthrough/product.ts';

export const POLISH_FAMILY_IDS = ['spacing', 'hierarchy', 'cli-help', 'error-copy'] as const;
export type PolishFamilyId = (typeof POLISH_FAMILY_IDS)[number];

/** What a cell's after-state is to its before: the right decision is `keep` for `better` only. */
export const VARIANTS = ['better', 'worse', 'neutral'] as const;
export type Variant = (typeof VARIANTS)[number];
export const expectedDecision = (v: Variant): 'keep' | 'drop' => (v === 'better' ? 'keep' : 'drop');

export type Edit = Readonly<{ file: string; find: string; replace: string }>;

export type PolishFamily = Readonly<{
  id: PolishFamilyId;
  /** The journey the proposal cites (fixture.ts's milestone: J-1 record an entry, J-2 change a limit, J-4 import, J-5 report). */
  journey: string;
  /** What the walk saw, its evidence note (the proposal cites it). */
  observed: string;
  /** The starting state: edits to the clean product. */
  before: readonly Edit[];
}>;

/** Applies `edits` in order; each `find` occurs exactly once in its file at that point. */
export function applyEdits(files: FileMap, edits: readonly Edit[]): FileMap {
  const out = new Map(files);
  for (const e of edits) {
    const text = out.get(e.file);
    if (text === undefined) throw new Error(`an edit of ${e.file}, which the product does not hold`);
    const at = text.indexOf(e.find);
    if (at < 0 || text.indexOf(e.find, at + 1) >= 0) throw new Error(`${e.file}: ${at < 0 ? 'no' : 'more than one'} occurrence of ${JSON.stringify(e.find)}`);
    out.set(e.file, text.slice(0, at) + e.replace + text.slice(at + e.find.length));
  }
  return out;
}

const CSS = 'web/static/app.css';
const DESIGN = 'design/DESIGN.md';
const CLI_REF = 'design/cli.md';
const BUDGET = 'web/pages/budget.js';
const BIN = 'bin/ledgerly.js';
const IMPORT = 'src/commands/import.js';

/** The spacing family's starting gap between the record form's fields. */
export const FIELD_RULE = (value: string): string => `.field { margin-bottom: ${value}; }`;
/** The budget page's Change limit link class (the hierarchy family). */
export const CHANGE_LIMIT = (cls: string): string => `class="button ${cls}`;
export const ALPHA_COMMANDS = [
  '  config    Check ledgerly.conf for mistakes',
  '  import    Add the entries of a CSV file to the ledger',
  '  init      Create an empty ledger in a data directory',
  '  report    Show a team\'s spend for a month against its limit',
].join('\n');
export const WORKFLOW_COMMANDS = [
  '  init      Create an empty ledger in a data directory',
  '  import    Add the entries of a CSV file to the ledger',
  '  report    Show a team\'s spend for a month against its limit',
  '  config    Check ledgerly.conf for mistakes',
].join('\n');
export const IMPORT_MESSAGES = '${checked.errors.map((e) => e.message).join(\' \')}';
export const IMPORT_FIELDS = '${checked.errors.map((e) => `${e.field} is not valid.`).join(\' \')}';
export const IMPORT_THROW = (body: string): string => `if (!checked.ok) throw new InputError(${body});`;
const IMPORT_BEFORE = '`${path}:${row.line}: ' + IMPORT_FIELDS + ' Nothing was imported.`';

export const FAMILIES: Readonly<Record<PolishFamilyId, PolishFamily>> = {
  spacing: {
    id: 'spacing', journey: 'J-1',
    observed: 'Record an entry (/entries/new) at 1280x800 and 390x844: the fields sit 4 px apart (.field margin-bottom: var(--space-1)), so each label is as close to the control above it as to its own.\n',
    before: [{ file: CSS, find: FIELD_RULE('var(--space-5)'), replace: FIELD_RULE('var(--space-1)') }],
  },
  hierarchy: {
    id: 'hierarchy', journey: 'J-2',
    observed: 'A team\'s budget page (/budgets/platform): Change limit is drawn as a quiet outline button, the same as Cancel elsewhere; the page has no primary button.\n',
    before: [{ file: BUDGET, find: CHANGE_LIMIT('button-primary'), replace: CHANGE_LIMIT('button-quiet') }],
  },
  'cli-help': {
    id: 'cli-help', journey: 'J-5',
    observed: '`node bin/ledgerly.js --help`: examples, then the commands in alphabetical order (config, import, init, report), then the options.\n',
    before: [{ file: BIN, find: WORKFLOW_COMMANDS, replace: ALPHA_COMMANDS }],
  },
  'error-copy': {
    id: 'error-copy', journey: 'J-4',
    observed: '`node bin/ledgerly.js import bad.csv` with a row whose amount is "€120": stderr "ledgerly: bad.csv:2: amount is not valid. Nothing was imported.", exit 3.\n',
    before: [{ file: IMPORT, find: IMPORT_THROW('`${path}:${row.line}: ' + IMPORT_MESSAGES + ' Nothing was imported.`'), replace: IMPORT_THROW(IMPORT_BEFORE) }],
  },
};

// The after-states' edits (applied to the family's before), shared by the dev cells.
const FIELDS_LINE = '- **Fields**: label above, hint under the label in muted ink, the error under the hint in `--ll-over`, then the control.\n  Inputs keep what was typed after an error.';
const fields = (sentence: string): Edit => ({ file: DESIGN, find: FIELDS_LINE, replace: `${FIELDS_LINE} ${sentence}` });
const BUTTONS_LINE = '`.button-quiet` (ruled outline) for Cancel\n  and Back. Labels are verbs naming the result.';
const ENTRIES_H2 = '<h2>Entries${month === null ? \'\' : ` in ${monthName(month)}`}</h2>';
const ENTRIES_TABLE = '    ${entriesTable(view === null ? [] : view.entries, config.currency, { team: false, empty: `No entries for ${escape(team.name)} this month.` })}';
const LAYOUT_LINE = 'tables scroll inside themselves; the page never scrolls sideways.';
const COPY_EMPTY = '- Empty states invite the next action: "No entries yet. Record the first one, or import a CSV."';
const USAGE_LINE = '- `ledgerly` with no arguments prints the usage to stderr and exits 2. The usage starts with examples, then the\n  commands, then the options.';
const USAGE_SECTIONS_BEFORE = 'Examples:\n  ledgerly init --data .ledgerly\n  ledgerly import samples/2026-09.csv --data .ledgerly\n  ledgerly report --team platform --month 2026-09 --json\n  ledgerly config check\n\n';
const OPTIONS_BLOCK = 'Options:\n  --data <dir>   The data directory (default: $LEDGERLY_DATA, else .ledgerly)\n  --help         Show help for ledgerly, or for a command after its name\n  --version      Print the version\n\n';
const ERROR_VOICE = '`ledgerly: <what is wrong>; <how to fix it>`, on one line, the key fact last when it is a value:';
const GOLDEN_IMPORT = 'ledgerly: samples/2026-09.csv:4: Amount must be a number above zero, like 120 or 120.50, without a currency sign. Nothing was imported.';

export const AFTER: Readonly<Record<PolishFamilyId, Readonly<Record<Variant, Readonly<{ proposal: string; after: readonly Edit[] }>>>>> = {
  spacing: {
    better: {
      proposal: 'On Record an entry the fields sit 4 px apart, so each label is as close to the control above it as to its own and the form reads as one block. '
        + 'Space the fields --space-5 apart, as the form\'s other gaps are, and say so under Fields in design/DESIGN.md.',
      after: [{ file: CSS, find: FIELD_RULE('var(--space-1)'), replace: FIELD_RULE('var(--space-5)') }, fields('Fields stack `--space-5` apart, so each label sits with its own control.')],
    },
    worse: {
      proposal: 'On Record an entry at 390 px the Record entry button sits below the fold. Tighten the gap between the fields so the whole form fits on one screen, '
        + 'and record the gap under Fields in design/DESIGN.md.',
      after: [{ file: CSS, find: FIELD_RULE('var(--space-1)'), replace: FIELD_RULE('2px') }, fields('Fields stack 2 px apart, so the whole form fits above the fold.')],
    },
    neutral: {
      proposal: 'The gap between the fields on Record an entry is a bare --space-1. Derive it from the controls\' own padding (--space-2) so the two stay in proportion '
        + 'if the scale changes, and note it under Fields in design/DESIGN.md.',
      after: [{ file: CSS, find: FIELD_RULE('var(--space-1)'), replace: FIELD_RULE('calc(var(--space-2) / 2)') }, fields('Fields stack half of `--space-2` apart.')],
    },
  },
  hierarchy: {
    better: {
      proposal: 'On a team\'s budget page, Change limit, the page\'s one action, is drawn as a quiet outline button like Cancel, so nothing reads as the primary action '
        + 'and the eye has nowhere to land after the burn bar. Draw it as the page\'s primary button, and name it in design/DESIGN.md\'s Buttons.',
      after: [
        { file: BUDGET, find: CHANGE_LIMIT('button-quiet'), replace: CHANGE_LIMIT('button-primary') },
        { file: DESIGN, find: BUTTONS_LINE, replace: `${BUTTONS_LINE} On a team's budget page the primary action is Change limit.` },
      ],
    },
    worse: {
      proposal: 'Team leads open a team\'s budget page to see what the money went on. Lead with the entries table and move the card, with the burn bar and Change limit, '
        + 'below it, and say so in design/DESIGN.md\'s Layout.',
      after: [
        { file: BUDGET, find: `    </section>\n    ${ENTRIES_H2}\n${ENTRIES_TABLE}`, replace: '    </section>' },
        { file: BUDGET, find: '    <section class="card', replace: `    ${ENTRIES_H2}\n${ENTRIES_TABLE}\n    <section class="card` },
        { file: DESIGN, find: LAYOUT_LINE, replace: `${LAYOUT_LINE} A team's budget page leads with its entries table; the card follows it.` },
      ],
    },
    neutral: {
      proposal: 'On a team\'s budget page the table\'s heading reads "Entries in September 2026". Lead with the month ("September 2026 entries") so the heading scans faster, '
        + 'and note the pattern under Copy in design/DESIGN.md.',
      after: [
        { file: BUDGET, find: ENTRIES_H2, replace: '<h2>${month === null ? \'Entries\' : `${monthName(month)} entries`}</h2>' },
        { file: DESIGN, find: COPY_EMPTY, replace: `${COPY_EMPTY}\n- A section heading leads with its month: "September 2026 entries".` },
      ],
    },
  },
  'cli-help': {
    better: {
      proposal: '`ledgerly --help` lists its commands alphabetically (config, import, init, report), so a newcomer reads config first and init third. '
        + 'List them in the order a new ledger uses them, as design/cli.md\'s command tree does: init, import, report, config; and say so in design/cli.md.',
      after: [
        { file: BIN, find: ALPHA_COMMANDS, replace: WORKFLOW_COMMANDS },
        { file: CLI_REF, find: USAGE_LINE, replace: `${USAGE_LINE}\n- The usage lists the commands in the order a new ledger uses them, as the command tree does: init, import, report, config.` },
      ],
    },
    worse: {
      proposal: '`ledgerly --help` opens with four examples before the reader knows what options there are. Put the options first, then the commands, then the examples, '
        + 'and update design/cli.md to match.',
      after: [
        { file: BIN, find: USAGE_SECTIONS_BEFORE, replace: '' },
        { file: BIN, find: OPTIONS_BLOCK, replace: '' },
        { file: BIN, find: 'Commands:\n', replace: `${OPTIONS_BLOCK}Commands:\n` },
        { file: BIN, find: '\n\nRun "ledgerly <command> --help"', replace: `\n\n${USAGE_SECTIONS_BEFORE.trimEnd()}\n\nRun "ledgerly <command> --help"` },
        { file: CLI_REF, find: 'The usage starts with examples, then the\n  commands, then the options.', replace: 'The usage starts with the options, then the\n  commands, then the examples.' },
      ],
    },
    neutral: {
      proposal: '`ledgerly --help` describes its commands as orders ("Create an empty ledger"). Describe what each command does instead ("Creates an empty ledger"), '
        + 'and note it in design/cli.md.',
      after: [
        {
          file: BIN, find: ALPHA_COMMANDS,
          replace: ALPHA_COMMANDS.replace('Check ledgerly', 'Checks ledgerly').replace('Add the entries', 'Adds the entries').replace('Create an empty', 'Creates an empty').replace('Show a team', 'Shows a team'),
        },
        { file: CLI_REF, find: USAGE_LINE, replace: `${USAGE_LINE}\n- The usage describes each command in the third person: "Creates an empty ledger".` },
      ],
    },
  },
  'error-copy': {
    better: {
      proposal: 'When an import has a bad row, `ledgerly import` says only "bad.csv:2: amount is not valid": it names the field but not what a valid amount looks like, '
        + 'so the reader has to guess. Say what is wrong and how to fix it, as the dashboard\'s form does ("Amount must be a number above zero, like 120 or 120.50, '
        + 'without a currency sign."), and describe import errors in design/cli.md.',
      after: [
        { file: IMPORT, find: IMPORT_FIELDS, replace: IMPORT_MESSAGES },
        { file: CLI_REF, find: ERROR_VOICE, replace: `An import error names the file and the line, then what is wrong with the row and how to fix it, and says that nothing was imported.\n\n${ERROR_VOICE}` },
      ],
    },
    worse: {
      proposal: '`ledgerly import`\'s error for a bad row repeats the file name the reader just typed and states the obvious ("Nothing was imported"). '
        + 'Shorten it to the line ("import failed (line 4)") and update the golden line in design/cli.md.',
      after: [
        { file: IMPORT, find: IMPORT_THROW(IMPORT_BEFORE), replace: IMPORT_THROW('`import failed (line ${row.line})`') },
        { file: CLI_REF, find: GOLDEN_IMPORT, replace: 'ledgerly: import failed (line 4)' },
      ],
    },
    neutral: {
      proposal: '`ledgerly import` writes the position of a bad row as "bad.csv:2:". Spell it out ("bad.csv, line 2:") for people who do not read compiler output, '
        + 'and note it in design/cli.md.',
      after: [
        { file: IMPORT, find: IMPORT_THROW(IMPORT_BEFORE), replace: IMPORT_THROW('`${path}, line ${row.line}: ' + IMPORT_FIELDS + ' Nothing was imported.`') },
        { file: CLI_REF, find: ERROR_VOICE, replace: `An import error spells out the row's position: "samples/2026-09.csv, line 4:".\n\n${ERROR_VOICE}` },
      ],
    },
  },
};
