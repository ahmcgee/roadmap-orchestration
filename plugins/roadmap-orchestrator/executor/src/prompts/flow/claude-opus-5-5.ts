// flow × claude-opus-5-5 (M4b): PLACEHOLDER placed by step 0a so the closed role union has a module at its final path and
// its built-in seat resolves. It carries the frozen schema and the input fields; its render throws (not-yet), so nothing
// runs it before step B1 replaces it in place with the flow prompt (and lands the job that spawns it).
import { notYet } from '../../core/notyet.ts';
import type { PromptModule } from '../inputs.ts';
import { FLOW_SCHEMA } from '../schemas.ts';

const system = `You read an arc's flow: where its units' lead time goes, which station is the constraint, and what one change would most likely shorten lead time without moving any measurement. You change nothing. Nobody will answer a question: your whole output is the one structured report.`;

export const PROMPT: PromptModule<'flow'> = {
  system,
  schema: FLOW_SCHEMA,
  fields: ['triggers', 'chart', 'stations', 'constraint', 'accounting', 'levers', 'givens', 'window', 'verdicts', 'rejections', 'advances'],
  render: () => notYet('the flow prompt', 'B1'),
};
