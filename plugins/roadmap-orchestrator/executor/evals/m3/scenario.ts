// Fake-backed M3 runs (`driver --fake <story>`): the story plays the plan's eleven steps against the fake backends.
// Unit calls are M1 scenario steps by role (evals/m1/scenario.ts), translated for the profile and keyed by unit
// (test/helpers/scenario.ts `Step.unit`); lens and checkpoint calls are 0b's scripted judgments
// (test/helpers/holistic.ts), keyed by job and lens (`lens: <kind>` in the lens prompt). The backend smoke of the
// one start is prepended, unkeyed. Stories are code, not JSON files: the checkpoint's admit op carries the repair
// spec's text (evals/m3/setup.ts `repairSpecText`) and every judgment is validated by the frozen readers here.
//
//   story   the plan's story, plus the literal partial bundle (A18, G19): after the stale rejection (ckpt-1, held at
//           the fake barrier `ckpt-1.hold` until the driver's `apply` is applied), ckpt-2 answers the repair admit
//           followed by an invalid op (`twoOpBundleSecondInvalid`): rejected invalid, nothing applied; its one
//           re-evaluation (ckpt-3) admits the repair alone. Then audit-2 (drift: the vision lens) and ckpt-4 no-op,
//           audit-3 (final: both lenses of L) and ckpt-5 no-op.
import type { JsonValue } from '../../src/core/json.ts';
import type { ProfileName } from '../../src/routing/types.ts';
import { INVALID_OP, checkpointAnswer, checkpointStep, lensStep, twoOpBundleSecondInvalid } from '../../test/helpers/holistic.ts';
import type { Step } from '../../test/helpers/scenario.ts';
import { type M1Step, fakeSteps } from '../m1/scenario.ts';
import { FAKE_CKPT_HOLD } from './layout.ts';
import { REPAIR_UNIT, repairSpecText } from './setup.ts';

/** How long a fake barrier waits for the driver (the driver's fake run timeout is shorter). */
const HOLD_MS = 20 * 60_000;

const planCheck = (reason: string): M1Step => ({
  role: 'planCheck',
  answer: { decision: 'approve', reasons: [reason], patch: null, risk: 'med', notes: '', premises: [], visionConflict: [] },
});
const build = (message: string, files: Readonly<Record<string, string>>): M1Step => ({ role: 'build', round: 'fresh', acts: [{ type: 'commit', message, files }] });
const gate = (reason: string): M1Step => ({ role: 'gate', answer: { decision: 'approve', findings: [], directives: [], reasons: [reason], premises: [] } });

const unitTest = (imports: string, body: string): string => `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n${imports}\n\n${body}`;

const PARSE = `/** The entries of a ledger file (.roadmap/contracts/ledger.md, ledger file). */
export function parseLedger(text) {
  const entries = [];
  text.split('\\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const fields = line.split(',');
    const amount = Number(fields[1]);
    if (fields.length !== 3 || !/^\\d{4}-\\d{2}-\\d{2}$/.test(fields[0]) || fields[1].trim() === '' || !Number.isFinite(amount)) {
      throw new Error(\`ledger line \${i + 1} is malformed: \${JSON.stringify(line)}\`);
    }
    entries.push({ date: fields[0], amount, memo: fields[2] });
  });
  return entries;
}
`;

const REPORT = `import { formatAmount } from './format.js';

/** The month's balance line (.roadmap/contracts/ledger.md, commands). */
export function reconcile(entries, month) {
  const sum = entries.filter((e) => e.date.startsWith(\`\${month}-\`)).reduce((total, e) => total + e.amount, 0);
  return \`\${month} balance \${formatAmount(sum)}\`;
}
`;

const CLI = `// ledger: node src/cli.js <command> [args...] (.roadmap/contracts/ledger.md, commands).
import { readFileSync } from 'node:fs';
import { formatAmount } from './format.js';
import { parseLedger } from './parse.js';
import { reconcile } from './report.js';

const COMMANDS = {
  format: ([amount]) => {
    process.stdout.write(\`\${formatAmount(Number(amount))}\\n\`);
    return 0;
  },
  reconcile: ([month, file]) => {
    process.stdout.write(\`\${reconcile(parseLedger(readFileSync(file, 'utf8')), month)}\\n\`);
    return 0;
  },
};

const [name, ...args] = process.argv.slice(2);
const command = Object.hasOwn(COMMANDS, name ?? '') ? COMMANDS[name] : undefined;
if (command === undefined) {
  process.stderr.write(\`ledger: unknown command \${JSON.stringify(name ?? '')}\\n\`);
  process.exitCode = 2;
} else {
  process.exitCode = command(args);
}
`;

const TIDY_FORMAT = `/** Renders a money amount with exactly two decimals (.roadmap/contracts/ledger.md, money). */
export function formatAmount(amount) {
  return (Math.round(amount * 100) / 100).toFixed(2);
}
`;

const FIXED_FORMAT = `/** Renders a money amount with exactly two decimals, on its decimal digits as written (I-2). */
export function formatAmount(amount) {
  const [digits, exponent = '0'] = String(amount).split('e');
  return (Math.round(Number(\`\${digits}e\${Number(exponent) + 2}\`)) / 100).toFixed(2);
}
`;

/** The unit calls of the story, by unit, in each unit's own order. */
export const UNIT_STORY: Readonly<Record<string, readonly M1Step[]>> = {
  parse: [
    planCheck('The spec is consistent with the ledger contract (ledger file) and C-1, C-2.'),
    build('parse: parseLedger', {
      'src/parse.js': PARSE,
      'test/unit/parse.test.js': unitTest("import { parseLedger } from '../../src/parse.js';", "test('parseLedger reads entries and skips blank lines (A1)', () => {\n  assert.deepEqual(parseLedger('2026-09-01,10.50,refund\\n\\n'), [{ date: '2026-09-01', amount: 10.5, memo: 'refund' }]);\n});\n\ntest('a malformed line names its line number (A2)', () => {\n  assert.throws(() => parseLedger('2026-09-01,10.50,a\\nnope'), /line 2/);\n});\n"),
    }),
    gate('A1, A2 and A3 hold.'),
  ],
  tidy: [
    planCheck('The spec states the new body of formatAmount exactly; C-3 holds.'),
    build('tidy: simplify formatAmount', { 'src/format.js': TIDY_FORMAT }),
    gate('A1 and A2 hold: formatAmount is the stated expression and the format lane passes.'),
  ],
  report: [
    planCheck('The spec is consistent with the ledger contract (commands) and C-1 to C-3.'),
    build('report: reconcile a month', {
      'src/report.js': REPORT,
      'src/cli.js': CLI,
      'test/unit/report.test.js': unitTest("import { reconcile } from '../../src/report.js';", "test('reconcile sums the month (A1)', () => {\n  const entries = [{ date: '2026-09-01', amount: 10.5, memo: 'a' }, { date: '2026-10-01', amount: 1, memo: 'b' }];\n  assert.equal(reconcile(entries, '2026-09'), '2026-09 balance 10.50');\n});\n"),
    }),
    gate('A1, A2 and A3 hold; unknown commands still exit 2.'),
  ],
  [REPAIR_UNIT.id]: [
    planCheck('The repair restores I-2 within the unit\'s scope.'),
    build('fix-rounding: round on the decimal digits', {
      'src/format.js': FIXED_FORMAT,
      'test/unit/format.test.js': unitTest("import { formatAmount } from '../../src/format.js';", "test('formatAmount renders two decimals', () => {\n  assert.equal(formatAmount(12.5), '12.50');\n  assert.equal(formatAmount(3), '3.00');\n  assert.equal(formatAmount(0.1 + 0.2), '0.30');\n});\n\ntest('formatAmount rounds on the digits as written (A1)', () => {\n  assert.equal(formatAmount(1.005), '1.01');\n  assert.equal(formatAmount(2.675), '2.68');\n});\n"),
    }),
    gate('A1 and A2 hold.'),
  ],
};

/** The checkpoint's repair admit: origin repair, citing V-2, evidence naming the witness P1 (F-1, the first finding). */
const ADMIT_REPAIR: JsonValue = {
  op: 'admit', unit: { ...REPAIR_UNIT, scope: [...REPAIR_UNIT.scope], after: [...REPAIR_UNIT.after] }, spec: repairSpecText(),
  cites: ['V-2'], evidence: ['F-1: I-2 not held on the integration head since tidy replaced the rounding by Math.round(amount * 100) / 100'],
};
const REPAIR_BUNDLE = checkpointAnswer({ decision: 'bundle', ops: [ADMIT_REPAIR] });
const NO_OP = checkpointAnswer({ decision: 'no-op' });

const JOB_STEPS: readonly Step[] = [
  lensStep('audit-1', 'vision'),
  lensStep('audit-1', 'invariants'),
  checkpointStep('ckpt-1', REPAIR_BUNDLE, [{ type: 'barrier', name: FAKE_CKPT_HOLD, timeoutMs: HOLD_MS }]),
  checkpointStep('ckpt-2', twoOpBundleSecondInvalid(ADMIT_REPAIR, INVALID_OP)),
  checkpointStep('ckpt-3', REPAIR_BUNDLE),
  lensStep('audit-2', 'vision'),
  checkpointStep('ckpt-4', NO_OP),
  lensStep('audit-3', 'invariants'),
  lensStep('audit-3', 'vision'),
  checkpointStep('ckpt-5', NO_OP),
];

export const STORIES = ['story'] as const;
export type StoryName = (typeof STORIES)[number];

export function storyName(value: string): StoryName {
  const found = STORIES.find((s) => s === value);
  if (found === undefined) throw new Error(`unknown M3 story ${JSON.stringify(value)}; one of ${STORIES.join(', ')}`);
  return found;
}

/** The fake backend steps that play `story` under `profile`. */
export function storySteps(_story: StoryName, profile: ProfileName): readonly Step[] {
  const smoke = fakeSteps({ steps: [] }, profile);
  const units = Object.entries(UNIT_STORY).flatMap(([unit, steps]) => fakeSteps({ steps }, profile).slice(smoke.length).map((s): Step => ({ ...s, unit })));
  return [...smoke, ...units, ...JOB_STEPS];
}
