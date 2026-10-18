// walkthrough × claude-opus-5-5: PLACEHOLDER (dev.13 step 0), replaced by agent C with the module written against the
// Opus 5.5 guide (plan §6). It exists so the PROMPTS table compiles; the role is in force only under a plan with
// milestones, and nothing runs it until the walk job lands. Its render interpolates every input as JSON, nothing more.
import { canonicalJson, type JsonValue } from '../../core/json.ts';
import { type PromptModule, ROLE_INPUTS } from '../inputs.ts';
import { WALKTHROUGH_SCHEMA } from '../schemas.ts';

export const PROMPT: PromptModule<'walkthrough'> = {
  system: 'PLACEHOLDER walkthrough system prompt (dev.13 step 0; agent C replaces this module).',
  render: (inputs) => ROLE_INPUTS.walkthrough.map((k) => `<${k}>\n${canonicalJson(inputs[k] as unknown as JsonValue)}\n</${k}>`).join('\n'),
  schema: WALKTHROUGH_SCHEMA,
  fields: ROLE_INPUTS.walkthrough,
};
