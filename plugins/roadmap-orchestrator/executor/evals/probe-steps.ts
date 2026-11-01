// A mixed probe builds with fakes and delegates the judgment, including its one repair, to the real CLI.
import type { Step } from '../test/helpers/scenario.ts';
import { ACTING_ARGV } from '../test/fixtures/walk-common.ts';

export function realJudgeSteps(unit: string): readonly Step[] {
  return [
    { as: 'claude', unit, expect: { argv: ACTING_ARGV, argvLacks: ['--mcp-config', '--resume'] }, acts: [{ type: 'real' }] },
    { as: 'claude', unit, expect: { argv: ACTING_ARGV.map((arg) => arg === '--session-id' ? '--resume' : arg), argvLacks: ['--mcp-config', '--session-id'], stdinContains: ['Your answer was refused:'] }, acts: [{ type: 'real' }] },
  ];
}
