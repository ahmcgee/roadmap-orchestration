import { PROMPT as gate, system } from '../gate/claude-opus-5-5.ts';
import { documentsXml } from '../inputs.ts';
import type { PromptModule } from '../inputs.ts';
import { methodModules } from '../method/index.ts';
import { GATE_SCHEMA } from '../schemas.ts';
export const PROMPT: PromptModule<'verifier'> = {
  system, schema: GATE_SCHEMA, fields: ['mode', 'brief'],
  render: (i) => i.mode === 'gate' ? `<mode>gate</mode>\n${gate.render(i.brief)}` : `<mode>${i.mode}</mode>\n${documentsXml([{source: 'spec', content: i.brief.spec.markdown}, ...i.brief.contracts.map((c) => ({source: c.path, content: c.text}))])}\n<intent>${i.brief.intent}</intent>\n<non_goals>${JSON.stringify(i.brief.nonGoals)}</non_goals>\n<systems>${JSON.stringify(i.brief.systems)}</systems>\n<history>${JSON.stringify(i.brief.history)}</history>\n<standing>${JSON.stringify(i.brief.standing)}</standing>\n${methodModules('verifier', i.brief.method)}\nReturn findings, reasons and premises; standing responses and rulings are empty outside gate mode.`,
};
