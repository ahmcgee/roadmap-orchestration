// The rules registry (R3): what the previous arc published as the `json roadmap-rules` block of `.roadmap/invariants.md`
// (src/docs/invariants.ts renders and parses it), and the diff a new pin makes against it:
//   - a registry rule missing from the corpus moves to `retired` (with the registry's text hash);
//   - a retired id that reappears is refused (`rule-retired-reappears`);
//   - an id new to the registry at or below its `highWater` is refused (`rule-reused`): ids are never reused;
//   - a known active id whose text hash changed is a rewording (R5), allowed;
//   - `highWater` is the larger of the registry's and the highest pinned number.
// No registry (a first corpus arc) is the empty one.
import { type RuleId, ruleSeq } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import { gitRun } from '../git/git.ts';
import { INVARIANTS_DOC, parseRulesRegistryBlock } from '../docs/invariants.ts';
import type { CorpusProblem } from '../phase0/types.ts';
import type { CorpusPin, PinnedRule, RuleRef, RulesRegistry } from './types.ts';

export const EMPTY_REGISTRY: RulesRegistry = { highWater: 0, active: [], retired: [] };

/** The registry a pin publishes: its active rules, its retired ones and its high-water. */
export function registryOf(pin: CorpusPin): RulesRegistry {
  return { highWater: pin.highWater, active: pin.rules.map((r) => ({ id: r.id, textSha256: r.textSha256 })), retired: pin.retired };
}

/** The registry published at `rev` of the product repo; null when it has no `invariants.md` or no registry block. */
export function registryAt(repo: AbsPath, rev: string): RulesRegistry | null {
  const r = gitRun(repo, ['cat-file', 'blob', `${rev}:${INVARIANTS_DOC}`], { okCodes: [0, 128] });
  return r.code === 0 ? parseRulesRegistryBlock(r.stdout) : null;
}

export type RegistryDiff = Readonly<{ problems: readonly CorpusProblem[]; retired: readonly RuleRef[]; highWater: number }>;

/** The pinned rules (ascending by number) against the baseline registry. */
export function diffRegistry(rules: readonly PinnedRule[], registry: RulesRegistry): RegistryDiff {
  const retired = new Map<RuleId, RuleRef>(registry.retired.map((r) => [r.id, r]));
  const active = new Set(registry.active.map((r) => r.id));
  const pinned = new Set(rules.map((r) => r.id));
  const problems: CorpusProblem[] = [];
  for (const r of rules) {
    if (retired.has(r.id)) problems.push({ type: 'rule-retired-reappears', id: r.id });
    else if (!active.has(r.id) && ruleSeq(r.id) <= registry.highWater) problems.push({ type: 'rule-reused', id: r.id });
  }
  for (const r of registry.active) if (!pinned.has(r.id)) retired.set(r.id, r);
  return {
    problems,
    retired: [...retired.values()].sort((a, b) => ruleSeq(a.id) - ruleSeq(b.id)),
    highWater: Math.max(registry.highWater, ...rules.map((r) => ruleSeq(r.id))),
  };
}
