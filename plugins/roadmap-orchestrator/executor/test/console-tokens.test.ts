import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The console's colour tokens, read from the stylesheet itself: every text pair meets 4.5:1; control boundaries, solid
// marks and the diff's + and − markers meet 3:1 (WCAG 2 relative luminance). Hairlines are decorative and not checked.
const css = readFileSync(new URL('../web-src/styles.css', import.meta.url), 'utf8');
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`); assert.ok(start >= 0, selector);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
}
const light = block(':root'), themes = { light, dark: { ...light, ...block(':root[data-theme="dark"]') } };
const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const grounds = ['paper', 'surface', 'raised', 'sunken'];
const states = ['passed', 'active', 'held', 'failed', 'pending'];
const pairs: [string, string, number][] = [
  ...['ink', 'ink-2', 'ink-3'].flatMap((fg) => grounds.map((bg): [string, string, number] => [fg, bg, 4.5])),
  ['surface', 'ink', 4.5],
  ...states.flatMap((s): [string, string, number][] => [...['paper', 'surface', 'sunken'].map((bg): [string, string, number] => [`sig-${s}`, bg, 4.5]), ['ink', `tint-${s}`, 4.5], [`sig-${s}`, `tint-${s}`, 4.5]]),
  ['ink-2', 'tint-passed', 4.5], ['ink-2', 'tint-held', 4.5], ['ink-3', 'tint-pending', 4.5],
  ['ink', 'diff-add', 4.5], ['ink', 'diff-remove', 4.5], ['ink-2', 'diff-add', 4.5], ['ink-2', 'diff-remove', 4.5],
  ['sig-passed', 'diff-add', 3], ['sig-failed', 'diff-remove', 3],
  ...['band-selected', 'hover', 'hover-paper'].flatMap((bg): [string, string, number][] => [['ink', bg, 4.5], ['ink-2', bg, 4.5]]),
  ['ink', 'selection', 4.5],
  ['rule-strong', 'surface', 3], ['rule-strong', 'paper', 3], ['rule-strong', 'raised', 3], ['line', 'track', 3],
  ['series-agent', 'paper', 3], ['series-command', 'paper', 3], ['fill-passed', 'paper', 3],
];

for (const [theme, tokens] of Object.entries(themes)) test(`${theme} tokens meet their contrast thresholds`, () => {
  const short = pairs.filter(([fg, bg, need]) => { assert.ok(tokens[fg] && tokens[bg], `${fg} on ${bg} defined`); return ratio(tokens[fg]!, tokens[bg]!) < need; })
    .map(([fg, bg, need]) => `${fg} on ${bg}: ${ratio(tokens[fg]!, tokens[bg]!).toFixed(2)} < ${need}`);
  assert.deepEqual(short, []);
});
