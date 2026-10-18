// The M5 fixture's contrast oracle (check.ts `plant-repaired`): the WCAG 2 contrast ratio of a selector's text colour
// against its background, computed from stylesheet text, never rendered. Enough CSS for what a design unit writes: the
// top-level rules of each sheet (an `@media`, `@supports` or other at-rule block is skipped: the light, default scheme
// is what the plant broke), custom properties declared on `:root` or `html` (later declarations win) and `var()` with
// fallbacks, and the colour forms hex (3, 4, 6, 8 digits), `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`, `oklab()`
// and a few keywords. A colour with alpha is composed over the background. Anything else is `unknown`, named, so the
// lead can adjudicate instead of the oracle guessing.

export type Rgb = Readonly<{ r: number; g: number; b: number }>;
type Rgba = Readonly<{ r: number; g: number; b: number; a: number }>;
export type Rule = Readonly<{ selectors: readonly string[]; decls: ReadonlyMap<string, string> }>;

const KEYWORDS: Readonly<Record<string, Rgba>> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

/** The top-level style rules of a sheet, in order; at-rule blocks and comments are dropped. */
export function parseRules(css: string): readonly Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    // The matching close brace, counting nested blocks (an at-rule's body holds rules).
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
    }
    const body = text.slice(open + 1, j - 1);
    i = j;
    // A statement at-rule (`@import ...;`) before this block belongs to no rule.
    const head = prelude.slice(prelude.lastIndexOf(';') + 1).trim();
    if (head.startsWith('@')) continue;
    const decls = new Map<string, string>();
    for (const d of body.split(';')) {
      const colon = d.indexOf(':');
      if (colon < 0) continue;
      decls.set(d.slice(0, colon).trim().toLowerCase(), d.slice(colon + 1).replace(/!important\s*$/i, '').trim());
    }
    rules.push({ selectors: head.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter((s) => s !== ''), decls });
  }
  return rules;
}

/** Custom properties declared on `:root` or `html`, later ones winning. */
export function customProperties(rules: readonly Rule[]): ReadonlyMap<string, string> {
  const props = new Map<string, string>();
  for (const r of rules) {
    if (!r.selectors.some((s) => s === ':root' || s === 'html')) continue;
    for (const [k, v] of r.decls) if (k.startsWith('--')) props.set(k, v);
  }
  return props;
}

/** `value` with every `var(--x[, fallback])` replaced, or the first unresolved name. */
export function resolveVars(value: string, props: ReadonlyMap<string, string>, depth = 0): Readonly<{ value: string }> | Readonly<{ unresolved: string }> {
  if (depth > 16) return { unresolved: `a var() cycle in ${value}` };
  const at = value.indexOf('var(');
  if (at < 0) return { value };
  let depthP = 1;
  let j = at + 4;
  for (; j < value.length && depthP > 0; j++) {
    if (value[j] === '(') depthP++;
    else if (value[j] === ')') depthP--;
  }
  const inner = value.slice(at + 4, j - 1);
  const comma = inner.indexOf(',');
  const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
  const found = props.get(name) ?? (comma < 0 ? undefined : inner.slice(comma + 1).trim());
  if (found === undefined) return { unresolved: name };
  const sub = resolveVars(found, props, depth + 1);
  if ('unresolved' in sub) return sub;
  return resolveVars(`${value.slice(0, at)}${sub.value}${value.slice(j)}`, props, depth + 1);
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** A number or percentage: `pct` scales a percentage (100% = pct). */
function num(s: string, pct: number): number {
  const t = s.trim();
  return t.endsWith('%') ? (Number(t.slice(0, -1)) / 100) * pct : Number(t);
}

function hue(s: string): number {
  const t = s.trim();
  if (t.endsWith('deg')) return Number(t.slice(0, -3));
  if (t.endsWith('turn')) return Number(t.slice(0, -4)) * 360;
  if (t.endsWith('rad')) return (Number(t.slice(0, -3)) * 180) / Math.PI;
  return Number(t);
}

/** The arguments of a colour function, comma or space separated, with the alpha after a `/`. */
function args(inner: string): Readonly<{ parts: readonly string[]; alpha: string | null }> {
  const [main, alpha] = inner.split('/');
  const parts = main!.includes(',') ? main!.split(',').map((x) => x.trim()) : main!.trim().split(/\s+/);
  if (alpha !== undefined) return { parts, alpha: alpha.trim() };
  return parts.length === 4 ? { parts: parts.slice(0, 3), alpha: parts[3]! } : { parts, alpha: null };
}

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLab to sRGB 0..255 (Björn Ottosson's matrices), clipped to the gamut. */
function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const to = (x: number): number => clamp(gam(x), 0, 1) * 255;
  return {
    r: to(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: to(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: to(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255;
  return { r: f(0), g: f(8), b: f(4) };
}

/** A resolved colour value, or null when it is not a form this oracle reads. */
export function parseColor(raw: string): Rgba | null {
  const v = raw.trim().toLowerCase();
  if (v in KEYWORDS) return KEYWORDS[v]!;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex !== undefined) {
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const at = (i: number): number => parseInt(full.slice(i, i + 2), 16);
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?|oklch|oklab)\((.*)\)$/.exec(v);
  if (fn === null) return null;
  const { parts, alpha } = args(fn[2]!);
  if (parts.length !== 3) return null;
  const a = alpha === null ? 1 : num(alpha, 1);
  let rgb: Rgb;
  switch (fn[1]) {
    case 'rgb':
    case 'rgba':
      rgb = { r: num(parts[0]!, 255), g: num(parts[1]!, 255), b: num(parts[2]!, 255) };
      break;
    case 'hsl':
    case 'hsla':
      rgb = hslToRgb(hue(parts[0]!), num(parts[1]!.endsWith('%') ? parts[1]! : `${parts[1]}%`, 1), num(parts[2]!.endsWith('%') ? parts[2]! : `${parts[2]}%`, 1));
      break;
    case 'oklch': {
      const L = num(parts[0]!, 1);
      const C = num(parts[1]!, 0.4);
      const h = (hue(parts[2]!) * Math.PI) / 180;
      rgb = oklabToRgb(L, C * Math.cos(h), C * Math.sin(h));
      break;
    }
    default:
      rgb = oklabToRgb(num(parts[0]!, 1), num(parts[1]!, 0.4), num(parts[2]!, 0.4));
  }
  if ([rgb.r, rgb.g, rgb.b, a].some((x) => !Number.isFinite(x))) return null;
  return { r: clamp(rgb.r, 0, 255), g: clamp(rgb.g, 0, 255), b: clamp(rgb.b, 0, 255), a: clamp(a, 0, 1) };
}

const over = (fg: Rgba, bg: Rgb): Rgb => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) });
const luminance = (c: Rgb): number => 0.2126 * lin(c.r / 255) + 0.7152 * lin(c.g / 255) + 0.0722 * lin(c.b / 255);

/** The WCAG 2 contrast ratio of two opaque colours, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour a declaration sets: `background` reads its colour only when it is the whole value (no image, no layers). */
function declColor(rule: Rule, prop: 'color' | 'background'): string | undefined {
  if (prop === 'color') return rule.decls.get('color');
  return rule.decls.get('background-color') ?? rule.decls.get('background');
}

export type PairResult =
  | Readonly<{ kind: 'ratio'; ratio: number; color: string; background: string; from: string }>
  | Readonly<{ kind: 'unknown'; detail: string }>
  | Readonly<{ kind: 'absent' }>;

/**
 * The contrast of `selector`'s text over its background in `css`: the last rule naming the selector exactly (one of its
 * comma-separated selectors) that sets `color` gives the text colour; the background is the last such rule's own
 * background colour, else `body`'s, else `html`'s, else white. A text colour with alpha is composed over that background.
 */
export function selectorContrast(css: string, selector: string): PairResult {
  const rules = parseRules(css);
  const props = customProperties(rules);
  const named = (s: string) => rules.filter((r) => r.selectors.includes(s));
  const last = <T>(rs: readonly Rule[], pick: (r: Rule) => T | undefined): T | undefined => rs.map(pick).filter((x) => x !== undefined).at(-1);
  if (named(selector).length === 0) return { kind: 'absent' };
  const color = last(named(selector), (r) => declColor(r, 'color'));
  if (color === undefined) return { kind: 'unknown', detail: `no rule for ${selector} sets a color` };
  const bgRaw = last(named(selector), (r) => declColor(r, 'background')) ?? last(named('body'), (r) => declColor(r, 'background')) ?? last(named('html'), (r) => declColor(r, 'background')) ?? 'white';
  const resolve = (v: string): Readonly<{ value: Rgba }> | Readonly<{ unknown: string }> => {
    const r = resolveVars(v, props);
    if ('unresolved' in r) return { unknown: `${v}: ${r.unresolved} is not declared on :root` };
    const c = parseColor(r.value);
    return c === null ? { unknown: `${v} resolves to ${r.value}, a form this oracle does not read` } : { value: c };
  };
  const fg = resolve(color);
  const bg = resolve(bgRaw);
  if ('unknown' in fg) return { kind: 'unknown', detail: `text ${fg.unknown}` };
  if ('unknown' in bg) return { kind: 'unknown', detail: `background ${bg.unknown}` };
  const base = over(bg.value, { r: 255, g: 255, b: 255 });
  return { kind: 'ratio', ratio: contrastRatio(over(fg.value, base), base), color, background: bgRaw, from: selector };
}
