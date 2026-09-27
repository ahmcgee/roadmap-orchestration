// The Markdown rendering of a spec: non-normative, and the one text the verifier, gate and fixer read
// (§2.7). It is a pure function of the spec value, so every reader of one rev sees identical bytes.
//
// Items keep their authored order (the patch appends). Sets whose order carries no meaning (scope,
// resources, a lane's env names, resources and evidence globs, the cites) are sorted. Struck and deferred items are
// always shown with their state: ids are never reused, and a reader must see what was withdrawn.
// `fastLanesOnly` is the implementer's view: estate lanes are left out entirely, without even a mention.
import type { ItemState, LaneDef, NoteDef, SpecM1 } from '../core/records.ts';
import { fastLanes } from '../resources/reserve.ts';

export type RenderOptions = Readonly<{ fastLanesOnly?: boolean }>;

const sorted = (values: readonly string[]): string[] => [...values].sort();
const code = (value: string): string => `\`${value}\``;

/** A list item whose text may span lines: continuation lines are indented under the bullet. */
function bullet(head: string, text: string): string {
  return `- ${head}: ${text.split('\n').join('\n  ')}`;
}

function lane(l: LaneDef & Readonly<{ state: ItemState }>): string {
  const env = [
    ...Object.entries(l.env.set).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => `${name}=${JSON.stringify(value)}`),
    ...sorted(l.env.pass).map((name) => `${name} (from the host)`),
  ];
  return [
    `- ${code(l.id)} [${l.state}] tier ${l.tier}`,
    `  - argv: ${code(JSON.stringify(l.argv))}`,
    `  - cwd: ${code(l.cwd)}`,
    `  - expected exit: ${l.expectedExit}`,
    `  - env: ${env.length === 0 ? '(none)' : env.join(', ')}`,
    `  - resources: ${l.resources.length === 0 ? '(none)' : sorted(l.resources).map(code).join(', ')}`,
    `  - evidence: ${l.evidenceGlobs.length === 0 ? '(none)' : sorted(l.evidenceGlobs).map(code).join(', ')}`,
    ...(l.evidenceExcludes.length === 0 ? [] : [`  - evidence excludes: ${sorted(l.evidenceExcludes).map(code).join(', ')}`]),
  ].join('\n');
}

function notes(title: string, items: readonly (NoteDef & Readonly<{ state: ItemState }>)[]): string {
  const body = items.length === 0 ? '(none)' : items.map((n) => bullet(`${code(n.id)} [${n.state}]`, n.text)).join('\n');
  return `## ${title}\n\n${body}`;
}

export function renderSpec(spec: SpecM1, options: RenderOptions = {}): string {
  const lanes = options.fastLanesOnly === true ? fastLanes(spec) : spec.lanes;
  const acceptance = spec.acceptance.map((a) =>
    bullet(`${code(a.id)} [${a.state}]${a.failLoudIfUndelivered ? ' (fail loud if undelivered)' : ''}`, a.clause));
  const cites = [...sorted(spec.cites.contracts).map((c) => `- contract ${code(c)}`), ...sorted(spec.cites.rulings).map((r) => `- ruling ${r}`)];
  const sections = [
    `# Spec for unit ${code(spec.unit)}, rev ${spec.rev}`,
    `## Acceptance\n\n${acceptance.join('\n')}`,
    `## Scope\n\n${sorted(spec.scope).map((s) => `- ${code(s)}`).join('\n')}`,
    `## Lanes\n\n${lanes.length === 0 ? '(none)' : lanes.map(lane).join('\n')}`,
    `## Resources\n\n${spec.resources.length === 0 ? '(none)' : sorted(spec.resources).map((r) => `- ${code(r)}`).join('\n')}`,
    notes('Decisions', spec.decisions),
    notes('Facts', spec.facts),
    `## Cites\n\n${cites.length === 0 ? '(none)' : cites.join('\n')}`,
  ];
  return `${sections.join('\n\n')}\n`;
}
