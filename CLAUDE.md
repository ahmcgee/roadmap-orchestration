# roadmap-orchestration

This repo is the **source** of the `roadmap-orchestrator` plugin, not a consumer of it. Prohibitions written
inside the skill address agents running an arc with it; they do not bind you here.

## 1.0 rebuild (branch `v1`)

- The executor lives at `plugins/roadmap-orchestrator/executor/`: TypeScript run directly by Node 24 type
  stripping. `tsc --noEmit` only, no build step, no runtime dependencies. Explicit `.ts` import specifiers,
  erasable syntax only (no enums, namespaces or parameter properties).
- The binding design brief is `DESIGN-1.0.md`. The M1 plan's frozen schemas and contracts live in
  `executor/SCHEMAS.md`.
- The 0.x design record (`DESIGN.md`, `PROMPT.md`, `RATIONALE.md`, `reference.md`) lives only in git history at tag `v0.20.0` and does not bind. 0.20.0 remains
  on `main` and tag `v0.20.0`.

## Eval ladder

A change is not done until the ladder passes, in order (from `executor/`):

1. `npm run typecheck`
2. `npm test` (`node --test test/*.test.ts`)
3. `node evals/probe.ts`: real CLIs, pennies
4. The paid fixture (`evals/m1/`): once per merged batch, never per worktree agent

Tests are a hard line: never skip, weaken or drop one. The integrated tier uses real processes and real git.
If a test cannot pass, stop and say so. `contain.cgroup-real` is reported NOT RUN on this host (cgroup v2 is
read-only here) and is never counted as a pass.

The one test seam in production code is `crashPoint(label)` in `src/core/crash.ts`. Backends are faked by
fake-backend scripts behind PATH shims. Add no other test hooks to production code.

## Standing rules

- Illegal states unrepresentable: branded ids, discriminated unions, closed enums.
- Fail loud on anything that should not happen; no speculative guards.
- One canonical way to do a thing.
- Hard cutover: a 0.x `.roadmap/` layout is refused at startup, never converted.
- Actors are roles, never models, in every state file and record. Model ids appear only in routing
  configuration, which is revisioned; records carry `{role, routingRev}`.
- Sonnet 5 is never a supported model.
- No spend cap. A usage-limit error parks that backend arc-wide and waits for a manual `resume --backend`.
