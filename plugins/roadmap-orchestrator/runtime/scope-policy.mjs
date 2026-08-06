import { createHash } from 'node:crypto'

export const BOUNDED_SCOPE_POLICY = 'bounded-v1'
export const SCOPE_MODES = ['feature', 'surgical', 'mechanical', 'consolidation']

export function scopePolicyOf(plan) {
  return plan?.methodology?.scopePolicy ?? 'legacy'
}
export function scopeModeOf(plan, unit) {
  if (unit?.scopeMode) return unit.scopeMode
  return scopePolicyOf(plan) === BOUNDED_SCOPE_POLICY && unit?.kind === 'code' ? 'feature' : 'legacy'
}

export function validateScopeUnit(plan, unit) {
  const policy = scopePolicyOf(plan)
  if (policy !== 'legacy' && policy !== BOUNDED_SCOPE_POLICY)
    throw new Error(`unsupported methodology.scopePolicy: ${policy}`)
  const mode = scopeModeOf(plan, unit)
  if (mode !== 'legacy' && !SCOPE_MODES.includes(mode))
    throw new Error(`unit ${unit.id}: unsupported scopeMode ${mode}`)
  if (['surgical', 'mechanical', 'consolidation'].includes(mode) &&
      (!Array.isArray(unit.allowedPaths) || unit.allowedPaths.length === 0))
    throw new Error(`unit ${unit.id}: scopeMode ${mode} requires a non-empty allowedPaths array`)
  return mode
}

export const normalizePaths = (paths = []) => [...new Set(paths.filter((p) => typeof p === 'string' && p.length))].sort()
export const pathGrowth = (before, after) => normalizePaths(after).filter((p) => !new Set(normalizePaths(before)).has(p))
export const isSubset = (candidate, allowed) => pathGrowth(allowed, candidate).length === 0

export function authorizedPaths(unit, approvedPlan = {}) {
  const mode = unit.scopeMode ?? 'feature'
  return normalizePaths(mode === 'feature' ? approvedPlan.files : unit.allowedPaths)
}

export function routeReview(review, minConfidence = 0.6) {
  const observations = [...(review.observations ?? [])]
  const blocking = []
  for (const finding of review.blocking ?? []) {
    if ((finding.confidence ?? 1) >= minConfidence) blocking.push(finding)
    else observations.push({ ...finding, routeReason: 'below-minBlockConfidence' })
  }
  return { blocking, observations, preExisting: [...(review.preExisting ?? [])] }
}

export function evidenceIsReproducible(fact) {
  return !!fact && typeof fact === 'object' && !!fact.file && !!fact.claim &&
    (!!fact.probe || (!!fact.anchor && !!fact.observed) || !!fact.contract)
}

export function debtIdentity(fact) {
  const identity = [fact.file, fact.anchor ?? '', fact.probe ?? fact.contract ?? fact.claim].join('\u0000')
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

export function admitDebt(existing = [], facts = [], sha = '') {
  const byKey = new Map(existing.map((fact) => [fact.debtKey ?? debtIdentity(fact), { ...fact }]))
  const observations = []
  for (const fact of facts) {
    if (!evidenceIsReproducible(fact)) { observations.push(fact); continue }
    const debtKey = fact.debtKey ?? debtIdentity(fact)
    const previous = byKey.get(debtKey)
    byKey.set(debtKey, { ...previous, ...fact, debtKey, lastSeenSha: sha || fact.lastSeenSha, resolved: false })
  }
  return { debt: [...byKey.values()], observations }
}
