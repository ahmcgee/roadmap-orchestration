import { createHash } from 'node:crypto'

export const PROMPT_PROFILE_VERSION = 'codex-bounded-v1'
export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

const familyOf = (label = '') => {
  if (/^(plan|replan|chain-plan|opus-plan-check|plan-check|spec-expand)/.test(label)) return 'planning'
  if (/(^|-)fix:|^fix:|^debt-fix:|^gap-fix:|^integration-fix:/.test(label)) return 'fix'
  if (/^review:|gate/.test(label)) return 'review'
  if (/^impl:|^chain-impl:/.test(label)) return 'implementation'
  return 'mechanical'
}

const contracts = {
  planning: 'Return the smallest sufficient expected file set. Map each step to an acceptance criterion; distinguish required edits from optional improvements. Surface contradictions or genuine expansion needs explicitly.',
  implementation: 'Stay inside the unit scope mode. Fix only imperfections introduced by this unit or strictly necessary for its acceptance criteria. Stop when the criteria pass and the diff introduces no regression.',
  fix: 'This is a bounded correction turn. Address only supplied failing checks, accepted blocking findings, or architect directives. Do not fix additional issues you discover. Report any required new path as scope expansion.',
  review: 'Route evidence into blocking, observations, or preExisting. A substantive hunk is acceptable only when it traces to an acceptance criterion or explicit directive. Discovery is useful, but every item consumes triage capacity.',
  mechanical: 'Perform exactly the requested operation over the named paths. Do not refactor, clean up, or broaden the task. Stop immediately when the requested evidence or operation is complete.',
}

export function adaptPrompt(basePrompt, { label, scopePolicy = 'legacy', scopeMode = 'legacy' } = {}) {
  const family = familyOf(label)
  const roleContract = scopePolicy === 'bounded-v1'
    ? `${contracts[family]}\nDo not opportunistically refactor, rename, reformat, modernize, reorganize, harden, ` +
      `update dependencies or documentation, strengthen unrelated tests, or repair adjacent defects.`
    : `Preserve the base workflow prompt's legacy scope semantics for this ${family} call. Do not infer bounded-v1 ` +
      `rules from the Codex host; methodology is selected only by the persisted plan.`
  const contract = `\n\n<codex-execution-contract version="${PROMPT_PROFILE_VERSION}" role="${family}" scope-policy="${scopePolicy}" scope-mode="${scopeMode}">\n${roleContract}\n</codex-execution-contract>`
  return {
    prompt: `${basePrompt}${contract}`,
    family,
    basePromptHash: digest(basePrompt),
    adaptedPromptHash: digest(`${basePrompt}${contract}`),
    promptProfileVersion: PROMPT_PROFILE_VERSION,
  }
}
