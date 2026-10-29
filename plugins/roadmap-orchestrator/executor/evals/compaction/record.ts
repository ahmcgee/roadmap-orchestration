import type { Action, Key } from './spec.ts';
export type Decision = Readonly<{
  id: string; action: Action; items: string; ids: readonly string[]; replacement: string;
  givesUp: string; why: string; approved: string; applied: string | null; blocked: string | null;
}>;
const ACTIONS = ['retire', 'merge', 'tighten', 'fold', 'resolve'];
export const itemIds = (text: string): readonly string[] => [...new Set(text.match(/\b[TICB]-[1-9]\d*\b/g) ?? [])];
export const nothing = (text: string): boolean => /^(?:nothing|none)(?:[.!]|$|\s*[(—–:;])/i.test(text.replace(/[*`]/g, '').trim());

/** Strict record grammar, with multiline field values and optional Phase-0 markers. */
export function parseRecord(text: string): readonly Decision[] {
  const headings = [...text.matchAll(/^## K-(\d+) (\w+)[ \t]*$/gm)];
  if (headings.length === 0 || (text.match(/^## K-/gm) ?? []).length !== headings.length) throw new Error('record: expected K-n action headings');
  if (text.slice(0, headings[0]!.index).trim().replace(/^# [^\n]+\n?/, '').trim() !== '') throw new Error('record: unexpected preamble');
  return headings.map((h, i) => {
    if (Number(h[1]) !== i + 1 || !ACTIONS.includes(h[2]!)) throw new Error('record: K-n must ascend from 1, with a known action');
    const body = text.slice(h.index! + h[0].length, headings[i + 1]?.index ?? text.length).trim();
    const fields = [...body.matchAll(/^(Items|Replacement|Gives up|Why|Approved|Applied|Blocked):[ \t]*(.*)$/gm)];
    const values = new Map(fields.map((f, j) => [f[1]!, body.slice(f.index! + f[1]!.length + 1, fields[j + 1]?.index ?? body.length).trim()]));
    if (values.size !== fields.length || !body.startsWith('Items:')) throw new Error('record: repeated field or text outside fields');
    for (const name of ['Items', 'Replacement', 'Gives up', 'Why', 'Approved']) if (!values.get(name)) throw new Error(`record: missing ${name}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.get('Approved')!)) throw new Error('record: Approved must be YYYY-MM-DD');
    if (values.has('Applied') && values.has('Blocked')) throw new Error('record: both Applied and Blocked');
    const ids = itemIds(values.get('Items')!);
    if (ids.length === 0) throw new Error('record: Items needs estate ids');
    return { id: `K-${h[1]}`, action: h[2] as Action, items: values.get('Items')!, ids, replacement: values.get('Replacement')!, givesUp: values.get('Gives up')!, why: values.get('Why')!, approved: values.get('Approved')!, applied: values.get('Applied') ?? null, blocked: values.get('Blocked') ?? null };
  });
}
export function goldenRecord(key: Key, texts: Readonly<Record<string, string>>): string {
  return key.plants.filter((p) => p.approved).map((p, i) => [
    `## K-${i + 1} ${p.actions[0]}`, `Items: ${p.ids.map((id) => `${id}: ${texts[id]}`).join('; ')}`,
    `Replacement: ${p.replacement === null ? 'none' : `${p.replacement.id}: "${p.replacement.text}"`}`,
    `Gives up: ${p.givesUp}`, `Why: ${p.name}.`, 'Approved: 2026-10-01',
  ].join('\n')).join('\n\n') + '\n';
}
