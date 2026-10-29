import { goldenRecord } from './record.ts';

// Answer material lives in the harness only. No plant labels or owner policy enter stage/.
export type SetName = 'dev' | 'holdout';
export type Action = 'retire' | 'merge' | 'tighten' | 'fold' | 'resolve';
export type Plant = Readonly<{
  name: string; ids: readonly string[]; actions: readonly Action[]; approved: boolean;
  // Only these ids give up a substantive demand: a split tautology or already
  // completed/duplicate work must not inherit another item's loss.
  givesUp: string; lossIds: readonly string[]; trivia: boolean; replacement: Readonly<{ id: string; text: string }> | null;
}>;
export type Key = Readonly<{
  set: SetName; domain: string; goldenRecord: string; plants: readonly Plant[];
  traps: Readonly<{ lossy: readonly string[]; lostProperty: string; loadBearing: string; disposition: string; advanced: string }>;
  ownerAnswers: readonly string[];
}>;
export type EstateSpec = Readonly<{
  key: Key; rules: Readonly<Record<string, string>>; rulings: Readonly<Record<string, string>>;
  debt: readonly string[]; world: string; context: string;
}>;

export function setName(s: string): SetName {
  if (s !== 'dev' && s !== 'holdout') throw new Error(`unknown compaction set ${s}`);
  return s;
}

/** Holdout uses disjoint rule/ruling locations, as well as a different product domain. */
export function estateId(set: SetName, id: string): string {
  if (set === 'dev') return id;
  const n = Number(id.slice(2));
  if (id.startsWith('T-') && n <= 52) return `T-${(n - 1 + 11) % 52 + 1}`;
  if (id.startsWith('T-') && n >= 59 && n <= 80) return `T-${(n - 59 + 7) % 22 + 59}`;
  if (id.startsWith('C-') && n <= 29) return `C-${(n - 1 + 6) % 29 + 1}`;
  return id;
}

export function estateSpec(set: SetName): EstateSpec {
  const dev = set === 'dev';
  const domain = dev ? 'Quaybook' : 'Seedbank';
  const entity = dev ? 'berth booking' : 'seed accession';
  const oldModule = dev ? 'PortLink SOAP bridge' : 'film-label microprinter';
  const world = dev ? 'A skipper reserves a free berth, changes plans and gets an accurate departure slip.'
    : 'A curator accepts a seed accession, tracks its cold storage and dispatches an accurate loan slip.';
  // Each filler has a separate observable outcome: field × command, rather than eighty cosmetic variants.
  const commands = dev ? ['reserve', 'cancel', 'arrive', 'depart', 'list', 'export', 'inspect', 'search']
    : ['accept', 'freeze', 'thaw', 'dispatch', 'list', 'export', 'inspect', 'search'];
  const properties = [
    'rejects a missing record id with exit 2', 'rejects an unknown record id without writing storage',
    'prints the record id on successful completion', 'refuses a record belonging to another operator',
    'preserves the creation timestamp', 'records the operator in the audit trail',
    'sorts multiple matching records by creation time', 'returns exit 0 for an empty result',
    'validates dates before changing storage', 'leaves the previous file intact when a write fails',
  ];
  const rules: Record<string, string> = Object.fromEntries(Array.from({ length: 80 }, (_, i) =>
    [`T-${i + 1}`, `The ${commands[i % 8]} command ${properties[Math.floor(i / 8)]}.`]));
  const changes = {
    'T-3': `A ${entity} identifier is unique across the register.`,
    'T-14': `No two entries in the register have the same ${entity} identifier.`,
    'T-8': `The ${oldModule} retries failed deliveries every ten minutes.`,
    'T-27': 'The export command refuses invalid dates.',
    'T-41': 'Every command refuses invalid dates before reading or writing records.',
    'T-33': `Dispatch is allowed until ${dev ? '72 hours before the tide' : 'seven days before the loan'} (working assumption P-1).`,
    'T-72': `Dispatch is allowed until ${dev ? '48 hours before the tide' : 'three days before the loan'}.`,
    'T-49': `In order to ensure that the operator can rely on the output when things go wrong, every failed command, without exception, prints its diagnostic to stderr rather than to stdout.`,
    'T-62': 'Internal local variable names use lower camel case.',
    'T-63': 'The command must be implemented in executable program instructions.',
    'T-70': dev ? 'The welcome banner ends with a period.' : 'The help footer ends with a full stop.',
    'T-20': dev ? 'One vessel per berth per window.' : 'One accession per sealed storage vial.',
    'T-21': `A ${dev ? 'departure' : 'loan'} slip names the recipient and the scheduled return date.`,
    'T-36': 'The JSON export includes cancelled records.',
    'T-37': 'The CSV export includes cancelled records.',
    'T-52': 'Comment text is grammatical English.',
  };
  Object.assign(rules, changes);
  const rulings: Record<string, string> = Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
    [`C-${i + 1}`, `For ${commands[i % 8]}, ${['an expired session is refused before mutation', 'a locked register is refused with exit 3', 'a missing audit directory is created with mode 0700', 'the command stores UTC timestamps', 'the command redacts operator credentials from diagnostics'][Math.floor(i / 8)]}.`]));
  Object.assign(rulings, {
    'C-4': `The ${domain} archive is append-only; corrections add a new revision.`,
    'C-12': 'A request token is accepted once; retries return the stored response.',
    'C-17': 'Retries with the same request token return the stored response without another mutation.',
    'C-23': `The first release demo uses the ${dev ? 'blue harbour' : 'green seed'} slide template.`,
    'C-30': 'Retire the old walkthrough obligation I-54.',
    'C-31': 'Waive I-55 until the office has a reliable network connection.',
    'C-32': 'Defer I-56 until the archive migration.',
    'C-34': `${rules['T-20']} This is the register integrity boundary (I-20); F-1 and F-2 reproduced its failure.`,
    'C-38': 'Temporary trace output is permitted for this arc only.',
    'C-39': 'The obsolete trace format is superseded by C-40.',
    'C-40': 'Trace output redacts operator credentials.',
  });
  const debt = Array.from({ length: 15 }, (_, i) => `Add an index for ${commands[i % 8]} ${i < 8 ? 'record lookup' : 'audit lookup'} to avoid scanning the register on every call.`);
  debt[1] = `Remove the retry queue in the ${oldModule}.`;
  debt[5] = `Index ${commands[0]} record lookup; B-1 already tracks the same index.`;
  debt[10] = 'Align the success message punctuation with the help footer.';
  const plant = (name: string, ids: string[], actions: Action[], givesUp: string, replacement: Plant['replacement'] = null, trivia = false, approved = true, lossIds = givesUp === 'nothing' ? [] : ids): Plant =>
    ({ name, ids, actions, givesUp, lossIds, replacement, trivia, approved });
  const plants = [
    plant('identifier restatements', ['T-3', 'T-14'], ['merge'], 'nothing', { id: 'T-3', text: rules['T-3']! }),
    plant('subsumed date check', ['T-27'], ['retire', 'merge'], 'nothing'),
    plant('removed module', ['T-8'], ['retire'], `Ten-minute retries in the removed ${oldModule}.`, null, false, true, []),
    plant('answered assumption', ['T-33'], ['retire', 'tighten'], 'The superseded dispatch cutoff assumption P-1.', null, false, true, []),
    plant('wordy diagnostic rule', ['T-49'], ['tighten'], 'nothing', { id: 'T-49', text: 'Every failed command prints its diagnostic to stderr, never stdout.' }),
    plant('cosmetic variable names', ['T-62', 'T-63'], ['retire'], 'The lower camel case requirement for internal local variable names and the demand that the command execute program instructions.', null, true, true, ['T-62']),
    plant('banner punctuation', ['T-70'], ['retire'], 'The requirement for a period on the banner or footer.', null, true, false),
    plant('comment witness detail', ['I-52'], ['retire'], 'A separate test demanding grammatical English in one internal comment.', null, true),
    plant('archive standing truth', ['C-4'], ['fold'], 'nothing', { id: 'T-?', text: rulings['C-4']! }),
    // Of the five actions, these lasting overlapping truths permit either one
    // standing replacement ruling or one corpus rule. Other plants retain their
    // kind-specific actions (debt resolves, trivia retires, verbose text tightens).
    plant('request token overlap', ['C-12', 'C-17'], ['merge', 'fold'], 'nothing', { id: 'C-?', text: 'A request token is accepted once; retries return the stored response without another mutation.' }),
    plant('demo slide choice', ['C-23'], ['retire'], 'The first demo slide template requirement.', null, true),
    plant('obsolete queue debt', ['B-2'], ['resolve'], `Cleanup of the removed ${oldModule} retry queue.`, null, false, true, []),
    plant('duplicate index debt', ['B-6'], ['resolve'], 'nothing'),
    plant('punctuation debt', ['B-11'], ['resolve'], 'Success message punctuation stays inconsistent with the help footer.', null, true),
  ];
  const sentence = (text: string): string => `${text.replace(/\.+$/, '')}.`;
  const ownerAnswers = plants.map((p) => `${p.ids.join(', ')} (${p.name}): ${p.approved ? `approve ${p.actions.join(' or ')}; ${sentence(p.replacement === null ? 'no replacement needed' : `replacement: ${p.replacement.text}`)} Accept loss: ${sentence(p.givesUp)}` : 'keep it; reject retirement.'}`);
  ownerAnswers.push(`Keep ${rules['T-20']} It is safety critical. Preserve both JSON and CSV cancellation inclusion. Do not merge the waiver C-31. Flag any change to the slip rule T-21: it serves the current V-1 slice. For any other decision, reject it. Answer each numbered decision explicitly, terse: "1: approve", "2: reject". If you rewrite wording, say the exact wording and approve it explicitly on playback.`);
  const result: EstateSpec = { key: { set, domain, goldenRecord: '', plants, traps: { lossy: ['T-36', 'T-37'], lostProperty: 'CSV exports include cancelled records', loadBearing: 'T-20', disposition: 'C-31', advanced: 'T-21' }, ownerAnswers }, rules, rulings, debt, world,
    context: `${domain} is a Node CLI maintaining a local register. The ${oldModule} and all its code were removed in the previous arc. Owner answered P-1: use ${dev ? '48 hours' : 'three days'}; T-72 records that answer. T-33 is the remaining old assumption. T-27 is covered by T-41. The archive and token policies remain standing truths. T-20 is cited by recent findings F-1/F-2 and C-34, witnessed as must-hold I-20. T-21 serves V-1, which the next slice advances.` };
  const mapped = JSON.parse(JSON.stringify(result).replace(/\b[TICB]-[1-9]\d*\b/g, (id) => estateId(set, id))) as EstateSpec;
  const texts = { ...mapped.rules, ...mapped.rulings, 'I-52': 'One internal comment is grammatical English.', ...Object.fromEntries(mapped.debt.map((what, i) => [`B-${i + 1}`, what])) };
  return { ...mapped, key: { ...mapped.key, goldenRecord: goldenRecord(mapped.key, texts) } };
}
