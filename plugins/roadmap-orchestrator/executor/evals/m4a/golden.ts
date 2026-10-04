// The golden Phase-0 outputs the scripted root agent (fake-root.ts) replays: what a faithful root agent's Phase 0
// would produce over the synthetic corpus, written so that every postcondition of the answer key holds (check.ts
// `defects`). Fake runs only: the paid run's root agent writes its own.
//
// The curated corpus is the raw one (files/product/docs/corpus/) under a list of exact edits per arc, each `find`
// occurring exactly once in its file (fail loud otherwise), so the golden corpus can never drift from the raw one:
//   arc 1  rules blocks T-1..T-14; the overview's and the tide-windows page's restatements of the tide-table claim
//          go (ADR 0002 keeps its own, D1); the busy-week override goes (V-2, a corpus divergence, D3); the PortLink
//          paragraph gives way to ADR 0004's nightly export (fact-currency, D5); the 24-hour cutoff stays as the
//          working assumption of question P-1 (D4); confirmation by text is a future obligation (D2), calm untestable
//          (D6), the nightly backup prod-only (D7).
//   arc 2  the owner answered P-1 (48 hours): T-9 retired, T-15 states 48 hours; amendment arc-1/M-1 applied as T-16
//          (a cancellation is confirmed by text). The between-arc commit carries exactly these corpus edits.
//   arc 3  (story only, refused at K) the harbour master's day view, T-17.
//
// Units: arc 1 `guard` (I-1, T-7) and `confirm` (I-2, T-11); arc 2 `cutoff` (I-4, T-15) and `notice` (I-5, T-16);
// arc 3 `dayview` (I-6, T-17). I-3 (T-5, the tide table) is must-hold from the start. Their fake builds are
// files/units/<unit>/; the journeys every witness lane runs are files/golden/journeys/, committed with the bootstrap.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FILES = fileURLToPath(new URL('./files/', import.meta.url));
export const CORPUS_ROOT = 'docs/corpus';
export const VISION_DOC = '0005_Vision.md';

/** Every file under `dir`, by its path relative to `dir`, ascending. */
export function filesOf(dir: string): Readonly<Record<string, string>> {
  const out: [string, string][] = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    out.push([relative(dir, abs), readFileSync(abs, 'utf8')]);
  }
  return Object.fromEntries(out.sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The raw corpus, by path under the corpus root. */
export const rawCorpus = (): Readonly<Record<string, string>> => filesOf(join(FILES, 'product', CORPUS_ROOT));

export type Edit = Readonly<{ file: string; find: string; replace: string }>;

const rules = (...lines: readonly string[]): string => ['```rules', ...lines, '```'].join('\n');

/** Applies `edits` in order to `files` (paths under the corpus root); each `find` must occur exactly once. */
export function applyEdits(files: Readonly<Record<string, string>>, edits: readonly Edit[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = { ...files };
  for (const e of edits) {
    const text = out[e.file];
    if (text === undefined) throw new Error(`golden edit: no corpus file ${e.file}`);
    const at = text.indexOf(e.find);
    if (at < 0 || text.indexOf(e.find, at + 1) >= 0) throw new Error(`golden edit: ${JSON.stringify(e.find.slice(0, 60))} occurs ${at < 0 ? 'nowhere' : 'more than once'} in ${e.file}`);
    out[e.file] = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
  }
  return out;
}

export const ARC1_EDITS: readonly Edit[] = [
  {
    file: '0010_Overview.md',
    find: "Tide windows are worked out from the harbour's own printed tide table; Tidewater never asks a live tide service.\n\n",
    replace: 'How the windows are worked out is in `0020_Berths/tide-windows.md`.\n\n',
  },
  {
    file: '0010_Overview.md',
    find: 'booking for a window the table does not have is refused.\n',
    replace: `booking for a window the table does not have is refused.\n\n${rules('T-1: Skippers book berths themselves with the tidewater command; the harbour office does not take bookings by phone.')}\n`,
  },
  {
    file: '0010_Overview.md',
    find: 'Nothing flashes, nothing shouts.\n',
    replace: `Nothing flashes, nothing shouts.\n\n${rules('T-2: Tidewater is calm to use: every message says plainly what happened and what to do next.')}\n`,
  },
  {
    file: '0020_Berths.md',
    find: 'some of the older hulls do not take that\nwell.\n',
    replace: `some of the older hulls do not take that\nwell.\n\n${rules(
      'T-3: The inner basin has six berths, B1 to B6, each with a maximum draught.',
      'T-4: A vessel is not put in a berth whose maximum draught is less than its own draught.',
    )}\n`,
  },
  {
    file: '0020_Berths/tide-windows.md',
    find: 'Every tide window the system offers is derived from the local tide table in data/tides.json and from nothing else:\nno external feed is consulted, ever.\n',
    replace: `${rules(
      "T-5: Tide windows come only from the harbour's tide table in data/tides.json, never from a live tide service.",
      'T-6: A tide window opens 90 minutes before high water and closes 90 minutes after it.',
    )}\n`,
  },
  {
    file: '0030_Bookings.md',
    find: 'so they can pick another\nberth or another window.\n',
    replace: `so they can pick another\nberth or another window.\n\n${rules(
      'T-7: A berth is never booked to two vessels for the same tide window.',
      'T-8: A booking names one vessel, one berth, one date and one tide window.',
    )}\n`,
  },
  {
    file: '0030_Bookings.md',
    find: 'In a\nbusy week the harbour master may override a clash and double-book a berth, telling the later skipper to raft up\nalongside. This has always been done by the office and Tidewater should allow it.\n',
    replace: 'Even then a\nberth takes one boat per window: the office finds the later skipper another berth or another window (vision,\n"What we will not give up").\n',
  },
  {
    file: '0030_Bookings.md',
    find: 'A cancelled booking frees its berth at once: the next skipper to ask for that berth and window gets it.\n',
    replace: `A cancelled booking frees its berth at once: the next skipper to ask for that berth and window gets it.\n\n${rules(
      'T-9: A skipper may cancel a booking until 24 hours before its tide window opens. (working assumption, P-1)',
      'T-10: A cancelled booking frees its berth at once.',
    )}\n`,
  },
  {
    file: '0040_Notifications.md',
    find: 'with the booking id.\n\nSkippers have told us',
    replace: `with the booking id.\n\n${rules('T-11: Every booking is confirmed to the skipper by text message.')}\n\nSkippers have told us`,
  },
  {
    file: '0050_Architecture.md',
    find: 'and keeps the file readable.\n',
    replace: `and keeps the file readable.\n\n${rules('T-12: Bookings are kept in one ledger file that only the tidewater command writes.')}\n`,
  },
  {
    file: '0050_Architecture.md',
    find: "Confirmed bookings leave the system through the PortLink bridge, which relays each one to the regional port\nauthority's SOAP service every hour. The bridge keeps a queue on disk and retries when the authority's service is\ndown, which is often on Sunday nights.\n",
    replace: `The regional port authority collects a CSV export of each day's bookings from its shared folder overnight (ADR\n0004 retired the hourly bridge).\n\n${rules("T-13: The regional port authority collects a nightly CSV export of the day's bookings; nothing is sent to it during the day.")}\n`,
  },
  {
    file: '0060_Operations.md',
    find: 'copies the latest backup to a memory stick that goes home with her.\n',
    replace: `copies the latest backup to a memory stick that goes home with her.\n\n${rules("T-14: The booking ledger is backed up every night to the harbour office's network drive.")}\n`,
  },
];

/** Arc 2's corpus edits, on arc 1's curated corpus: the between-arc commit. */
export const ARC2_EDITS: readonly Edit[] = [
  {
    file: '0030_Bookings.md',
    find: 'A skipper may cancel a booking up to 24 hours before the tide window opens.',
    replace: 'A skipper may cancel a booking up to 48 hours before the tide window opens.',
  },
  {
    file: '0030_Bookings.md',
    find: 'T-9: A skipper may cancel a booking until 24 hours before its tide window opens. (working assumption, P-1)',
    replace: 'T-15: A skipper may cancel a booking until 48 hours before its tide window opens.',
  },
  {
    file: '0040_Notifications.md',
    find: 'in the same style as the booking text.\n',
    replace: `in the same style as the booking text.\n\n${rules('T-16: A cancellation is confirmed to the skipper by text message, as a booking is.')}\n`,
  },
];

/** Arc 3's corpus edit (story only; its start is refused at K). */
export const ARC3_EDITS: readonly Edit[] = [
  {
    file: '0060_Operations.md',
    find: 'phones anyone\n   whose boat looks too deep for the berth they booked.\n',
    replace: `phones anyone\n   whose boat looks too deep for the berth they booked.\n\n${rules("T-17: The harbour master sees the day's tide windows, every berth's booking and the day's cancellations in one view.")}\n`,
  },
];

export type ArcNo = 1 | 2 | 3;

/** The curated corpus of arc `n`, by path under the corpus root. */
export function corpusFor(n: ArcNo): Readonly<Record<string, string>> {
  const one = applyEdits(rawCorpus(), ARC1_EDITS);
  if (n === 1) return one;
  const two = applyEdits(one, ARC2_EDITS);
  return n === 2 ? two : applyEdits(two, ARC3_EDITS);
}

// ---------------------------------------------------------------------------------------------------
// Obligations, census, units

export type LaneSeed = Readonly<{ id: string; journey: string; test: string }>;
export const LANES: readonly LaneSeed[] = [
  { id: 'tides', journey: 'journeys/tides.journey.js', test: 'tide windows come from the harbour tide table' },
  { id: 'berths', journey: 'journeys/berths.journey.js', test: 'a berth is never booked twice for one tide window' },
  { id: 'confirm', journey: 'journeys/confirm.journey.js', test: 'every booking is confirmed by text' },
  { id: 'cutoff', journey: 'journeys/cutoff.journey.js', test: 'a booking cannot be cancelled within 48 hours of its window' },
  { id: 'notice', journey: 'journeys/notice.journey.js', test: 'a cancellation is confirmed by text' },
];

export type ObligationSeed = Readonly<{
  id: string; rule: string; lane: string; statement: string; serves: readonly string[];
  /** The arc whose units deliver it (future there, must-hold after); null: must-hold from the start. */
  deliveredIn: ArcNo | null; deliveredBy: readonly string[];
}>;

export const OBLIGATIONS: readonly ObligationSeed[] = [
  { id: 'I-1', rule: 'T-7', lane: 'berths', statement: 'A second booking of a berth for a tide window it is already booked for is refused, naming the vessel that holds it.', serves: ['V-2', 'V-4'], deliveredIn: 1, deliveredBy: ['guard'] },
  { id: 'I-2', rule: 'T-11', lane: 'confirm', statement: 'Every booking writes one text to the vessel\'s phone naming the berth, date, high water and booking id.', serves: ['V-4'], deliveredIn: 1, deliveredBy: ['confirm'] },
  { id: 'I-3', rule: 'T-5', lane: 'tides', statement: '`windows <date>` prints exactly the tide table\'s high waters for the date, and a date the table lacks is refused.', serves: ['V-4'], deliveredIn: null, deliveredBy: [] },
  { id: 'I-4', rule: 'T-15', lane: 'cutoff', statement: 'A cancellation less than 48 hours before the booking\'s window opens is refused; one earlier goes through.', serves: ['V-5'], deliveredIn: 2, deliveredBy: ['cutoff'] },
  { id: 'I-5', rule: 'T-16', lane: 'notice', statement: 'A cancellation writes one text to the vessel\'s phone naming the booking, berth and date.', serves: ['V-5'], deliveredIn: 2, deliveredBy: ['notice'] },
];

/** Census states of the rules no obligation anchors, per arc (absent from a pin: not in its census). */
export const CENSUS_OTHERS: Readonly<Record<string, 'out-of-slice' | 'untestable' | 'prod-only'>> = {
  'T-1': 'out-of-slice', 'T-2': 'untestable', 'T-3': 'out-of-slice', 'T-4': 'out-of-slice', 'T-6': 'out-of-slice', 'T-8': 'out-of-slice',
  'T-9': 'out-of-slice', 'T-10': 'out-of-slice', 'T-12': 'out-of-slice', 'T-13': 'out-of-slice', 'T-14': 'prod-only', 'T-17': 'out-of-slice',
};

export type UnitSeed = Readonly<{
  id: string; arc: ArcNo; scope: readonly string[]; after: readonly string[]; obligations: readonly string[];
  unitLane: Readonly<{ id: string; file: string }>; acceptance: readonly string[];
}>;

export const UNITS: readonly UnitSeed[] = [
  {
    id: 'guard', arc: 1, scope: ['src/ledger.js', 'test/unit/ledger.test.js'], after: [], obligations: ['I-1'],
    unitLane: { id: 'ledger', file: 'test/unit/ledger.test.js' },
    acceptance: [
      '`book` in src/ledger.js refuses a berth already booked for the same date and high water with a TidewaterError naming the vessel that holds it (T-7); nothing is written for a refused booking.',
      'test/unit/ledger.test.js covers the refusal and passes under the ledger lane.',
    ],
  },
  {
    id: 'confirm', arc: 1, scope: ['src/cli.js', 'src/confirm.js', 'test/unit/confirm.test.js'], after: ['guard'], obligations: ['I-2'],
    unitLane: { id: 'confirm-unit', file: 'test/unit/confirm.test.js' },
    acceptance: [
      'src/confirm.js `sendConfirmation(booking)` appends one line `<phone>\\t<text>` to the outbox (TIDEWATER_OUTBOX, default tidewater-outbox.txt), the text being the "Booking confirmed" template of 0040_Notifications/message-templates.md (T-11).',
      '`book` in src/cli.js sends the confirmation after the booking is written.',
      'test/unit/confirm.test.js covers the message and passes under the confirm-unit lane.',
    ],
  },
  {
    id: 'cutoff', arc: 2, scope: ['src/cli.js', 'src/ledger.js', 'test/unit/ledger.test.js'], after: [], obligations: ['I-4'],
    unitLane: { id: 'ledger', file: 'test/unit/ledger.test.js' },
    acceptance: [
      '`cancel(id, now)` in src/ledger.js refuses a cancellation later than 48 hours before the booking\'s window opens, saying so (T-15).',
      '`cancel` in src/cli.js passes the time, TIDEWATER_NOW (an ISO time) when set, else the clock.',
      'test/unit/ledger.test.js covers both sides of the cutoff and passes under the ledger lane.',
    ],
  },
  {
    id: 'notice', arc: 2, scope: ['src/cli.js', 'src/confirm.js', 'test/unit/confirm.test.js'], after: ['cutoff'], obligations: ['I-5'],
    unitLane: { id: 'confirm-unit', file: 'test/unit/confirm.test.js' },
    acceptance: [
      'src/confirm.js `sendCancellation(booking)` appends the "Booking cancelled" template to the outbox (T-16).',
      '`cancel` in src/cli.js sends it once the cancellation is written.',
      'test/unit/confirm.test.js covers the message and passes under the confirm-unit lane.',
    ],
  },
  {
    id: 'dayview', arc: 3, scope: ['src/cli.js', 'src/dayview.js', 'test/unit/dayview.test.js'], after: [], obligations: [],
    unitLane: { id: 'dayview-unit', file: 'test/unit/dayview.test.js' },
    acceptance: ['`tidewater day <date>` prints the day\'s windows with each berth\'s booking (T-17).'],
  },
];

/** The path → obligations mapping: every scoped path and journey. */
export const MAPPING: readonly Readonly<{ pattern: string; obligations: readonly string[] }>[] = [
  { pattern: 'journeys/berths.journey.js', obligations: ['I-1'] },
  { pattern: 'journeys/confirm.journey.js', obligations: ['I-2'] },
  { pattern: 'journeys/cutoff.journey.js', obligations: ['I-4'] },
  { pattern: 'journeys/notice.journey.js', obligations: ['I-5'] },
  { pattern: 'journeys/tides.journey.js', obligations: ['I-3'] },
  { pattern: 'src/cli.js', obligations: ['I-2', 'I-4', 'I-5'] },
  { pattern: 'src/confirm.js', obligations: ['I-2', 'I-5'] },
  { pattern: 'src/dayview.js', obligations: [] },
  { pattern: 'src/ledger.js', obligations: ['I-1', 'I-4'] },
  { pattern: 'src/tides.js', obligations: ['I-3'] },
  { pattern: 'test/unit/confirm.test.js', obligations: ['I-2', 'I-5'] },
  { pattern: 'test/unit/dayview.test.js', obligations: [] },
  { pattern: 'test/unit/ledger.test.js', obligations: ['I-1', 'I-4'] },
];

/** Each arc's slice: the clauses it advances and why. */
export const SLICES: Readonly<Record<ArcNo, Readonly<{ advances: readonly string[]; why: string }>>> = {
  1: { advances: ['V-2', 'V-4'], why: 'the evening-tide scene first: no berth promised twice (V-2), and a booking a skipper can rely on, confirmed by text (V-4)' },
  2: { advances: ['V-5'], why: 'the owner settled the cancellation cutoff (P-1): cancelling in good time, confirmed like a booking' },
  3: { advances: ['V-6'], why: 'the harbour master\'s morning: the one census candidate left that the vision ranks next' },
};

export const DIRECTION = 'Grow tidewater toward the harbour the vision describes, one scene at a time.';

/** The curation digest and the semantic records of arc 1 (paths under the corpus root). */
export const ARC1_CURATION = [
  { tier: 'structural', what: 'systematised every normative claim into rules blocks T-1..T-14 under the section it belongs to', files: ['0010_Overview.md', '0020_Berths.md', '0020_Berths/tide-windows.md', '0030_Bookings.md', '0040_Notifications.md', '0050_Architecture.md', '0060_Operations.md'], rules: ['T-1', 'T-10', 'T-11', 'T-12', 'T-13', 'T-14', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'T-7', 'T-8', 'T-9'] },
  { tier: 'structural', what: 'collapsed the tide-table claim restated in the overview and the tide-windows page into T-5; ADR 0002 keeps its history', files: ['0010_Overview.md', '0020_Berths/tide-windows.md'], rules: ['T-5'] },
  { tier: 'fact-currency', what: 'replaced the PortLink bridge paragraph, which ADR 0004 retired, with the nightly CSV export', files: ['0050_Architecture.md', '0070_ADRs/0004-retire-portlink-bridge.md'], rules: ['T-13'] },
] as const;

export const ARC1_QUESTION = {
  id: 'P-1', rank: 1,
  text: 'Is the cancellation cutoff 24 hours before the window opens (0030_Bookings.md) or 48 hours (0040_Notifications.md)?',
  files: ['0030_Bookings.md', '0040_Notifications.md'], bears: ['T-9'],
  assumption: '24 hours, as the bookings page says; nothing in arc 1 depends on it (T-9 is out of slice).',
} as const;
