// The Markdown rendering of a spec: non-normative, and the one text the verifier, gate and fixer read
// (§2.7). It is a pure function of the spec value, so every reader of one rev sees identical bytes.
//
// Items keep their authored order (the patch appends). Sets whose order carries no meaning (scope,
// resources, a lane's env names, resources and evidence globs, the cites) are sorted. Struck and deferred items are
// always shown with their state: ids are never reused, and a reader must see what was withdrawn.
// `buildLanesOnly` is the implementer's view: resource-bearing lanes and lanes of a later cadence are left out entirely.
// M3 (A13): the obligations a unit declares and what a repair unit repairs follow, each only when the spec has it.
// M4a rev 3: a spec's witness items follow its facts, and a spec lane's `inputs` its evidence, each only when present, so
// a spec without them renders as before. Scope growth (2026-10-15): what the unit removes or renames follows its scope, only
// when declared. dev.17 (design pass): the design record a plan-check settled closes the spec, only when it has one.
import { type DesignRecord, designSize } from '../core/design.ts';
import type { ItemState, LaneDef, NoteDef, SpecM1, WitnessItemDef } from '../core/records.ts';
import { buildLanes } from '../resources/reserve.ts';

export type RenderOptions = Readonly<{ buildLanesOnly?: boolean }>;

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
    `- ${code(l.id)} [${l.state}] cadence ${l.cadence}`,
    `  - argv: ${code(JSON.stringify(l.argv))}`,
    `  - cwd: ${code(l.cwd)}`,
    `  - expected exit: ${l.expectedExit}`,
    `  - env: ${env.length === 0 ? '(none)' : env.join(', ')}`,
    `  - resources: ${l.resources.length === 0 ? '(none)' : sorted(l.resources).map(code).join(', ')}`,
    `  - evidence: ${l.evidenceGlobs.length === 0 ? '(none)' : sorted(l.evidenceGlobs).map(code).join(', ')}`,
    ...(l.evidenceExcludes.length === 0 ? [] : [`  - evidence excludes: ${sorted(l.evidenceExcludes).map(code).join(', ')}`]),
    ...(l.systems === undefined ? [] : [`  - systems: ${sorted(l.systems).map(code).join(', ')}`]),
    ...(l.testArgv === undefined ? [] : [`  - test argv: ${code(JSON.stringify(l.testArgv))}`]),
    ...(l.stochastic === undefined ? [] : [`  - stochastic: passes when ${l.stochastic.minPasses} of up to ${l.stochastic.runs} runs pass`]),
  ].join('\n');
}

function witness(w: WitnessItemDef & Readonly<{ state: ItemState }>): string {
  return [
    `- ${code(w.id)} [${w.state}] lane ${code(w.lane)} test ${code(w.testId)} witnesses ${code(w.clause)}${w.obligation === undefined ? '' : ` (the witness of ${w.obligation})`}`,
    `  - skeleton: ${w.skeleton.split('\n').join('\n    ')}`,
  ].join('\n');
}

/** dev.17: the design record, as the build and the gate read it (its pins stay in spec.json; a reader needs the paths). */
function design(d: DesignRecord): string {
  const changes = d.changes.map((c) => `- ${c.system === null ? '(no system)' : code(c.system)}: ${c.paths.map(code).join(', ')} (about ${c.lines} lines)`);
  const proof = (m: DesignRecord['failureModes'][number]): string => {
    if (m.proof.type === 'untested') return `untested: ${m.proof.reason}`;
    const t = m.proof.test;
    return t.type === 'witness' ? `proven by witness item ${code(t.item)}` : `proven by test ${code(t.testId)} of lane ${code(t.lane)}`;
  };
  const modes = d.failureModes.map((m) => bullet(code(m.id), `${m.mode} (${proof(m)}${m.requirements.length === 0 ? '' : `; bears on ${m.requirements.map((r) => r.id).join(', ')}`})`));
  const clauses = d.clauses.map((c) => `- ${code(c.clause)}: ${c.lanes.map(code).join(', ')}`);
  const breaks = [...d.breaks.tests.map((b) => `- test ${code(b.path)}`), ...d.breaks.docs.map((b) => `- doc ${code(b.path)}`)];
  return [
    `## Design\n\nkind ${d.kind}, about ${designSize(d)} changed lines`,
    `### Changes\n\n${changes.join('\n')}`,
    `### Interfaces\n\n${d.interfaces.length === 0 ? '(none)' : d.interfaces.map((i) => `- ${i.type} ${code(i.path)}`).join('\n')}`,
    `### Failure modes\n\n${modes.length === 0 ? '(none)' : modes.join('\n')}`,
    `### Clauses exercised by\n\n${clauses.length === 0 ? '(none)' : clauses.join('\n')}`,
    `### Breaks\n\n${breaks.length === 0 ? '(none)' : breaks.join('\n')}`,
    ...(d.newSystem === undefined ? [] : [`### New system\n\n${code(d.newSystem.name)}: ${d.newSystem.paths.map(code).join(', ')}`]),
  ].join('\n\n');
}

function notes(title: string, items: readonly (NoteDef & Readonly<{ state: ItemState }>)[]): string {
  const body = items.length === 0 ? '(none)' : items.map((n) => bullet(`${code(n.id)} [${n.state}]`, n.text)).join('\n');
  return `## ${title}\n\n${body}`;
}

export function renderSpec(spec: SpecM1, options: RenderOptions = {}): string {
  const lanes = options.buildLanesOnly === true ? buildLanes(spec) : spec.lanes;
  const acceptance = spec.acceptance.map((a) =>
    bullet(`${code(a.id)} [${a.state}]${a.failLoudIfUndelivered ? ' (fail loud if undelivered)' : ''}`, a.clause));
  const cites = [...sorted(spec.cites.contracts).map((c) => `- contract ${code(c)}`), ...sorted(spec.cites.rulings).map((r) => `- ruling ${r}`)];
  const sections = [
    `# Spec for unit ${code(spec.unit)}, rev ${spec.rev}`,
    `## Acceptance\n\n${acceptance.join('\n')}`,
    `## Scope\n\n${sorted(spec.scope).map((s) => `- ${code(s)}`).join('\n')}`,
    ...(spec.removes === undefined ? [] : [`## Removes\n\n${sorted(spec.removes).map((r) => `- ${code(r)}`).join('\n')}`]),
    `## Lanes\n\n${lanes.length === 0 ? '(none)' : lanes.map(lane).join('\n')}`,
    `## Resources\n\n${spec.resources.length === 0 ? '(none)' : sorted(spec.resources).map((r) => `- ${code(r)}`).join('\n')}`,
    notes('Decisions', spec.decisions),
    notes('Facts', spec.facts),
    ...(spec.witnesses === undefined ? [] : [`## Witnesses\n\n${spec.witnesses.map(witness).join('\n')}`]),
    `## Cites\n\n${cites.length === 0 ? '(none)' : cites.join('\n')}`,
    // M3 (A13): shown only when declared, so a spec without them renders as before.
    ...(spec.obligations === undefined ? [] : [`## Obligations\n\n${sorted(spec.obligations).map((o) => `- ${o}`).join('\n')}`]),
    ...(spec.repairs === undefined ? [] : [`## Repairs\n\n${sorted(spec.repairs).map((r) => `- ${r}`).join('\n')}`]),
    ...(spec.design === undefined ? [] : [design(spec.design)]),
  ];
  return `${sections.join('\n\n')}\n`;
}
