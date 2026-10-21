# roadmap-orchestration

This repo is the **source** of the `roadmap-orchestrator` plugin, not a consumer of it. Prohibitions written
inside the skill address agents running an arc with it; they do not bind you here.

## 1.0 (prerelease, on `main`)

- The executor lives at `plugins/roadmap-orchestrator/executor/`: TypeScript run directly by Node 24 type
  stripping. `tsc --noEmit` only, no build step, no runtime dependencies. Explicit `.ts` import specifiers,
  erasable syntax only (no enums, namespaces or parameter properties).
- The binding design brief is `DESIGN-1.0.md`. The M1 plan's frozen schemas and contracts live in
  `executor/SCHEMAS.md`.
- The 0.x design record (`DESIGN.md`, `PROMPT.md`, `RATIONALE.md`, `reference.md`) lives only in git history at tag `v0.20.0` and does not bind.

## Eval ladder

A change is not done until the ladder passes, in order (from `executor/`):

1. `npm run typecheck`
2. `npm test` (`node --test --test-concurrency=8 test/*.test.ts`: eight files at a time, each about one runnable
   process wide on average; then `test/serial/*.test.ts` alone, one file at a time: the files that fan out across the host (the
   crash matrices, sized by `FANOUT` in `test/helpers/fanout.ts`, and the pool, probe and resource crash files), the
   tests needing a calm host (the upgrade test, the m4a fake sessions), the real-browser tests (`walk-browser`, which
   needs the devcontainer's Playwright MCP and Chromium, and `evals-m5-reflow`, the m5 check's reflow oracle on that Chromium) and `pressure`, which saturates the host on purpose). Both tiers keep runnable load within the host's cpus: a saturated host fails timing-bound tests, so a
   file that runs eight or more cells of real processes at once goes in the serial tier, never the parallel one.
3. `node evals/probe.ts`: real CLIs, pennies
3.5. Role evals (`evals/roles/`, `node evals/roles/run.ts <gate|walkthrough|polishJudge> --set dev --n 3`, with `--cap`):
   paid, path-triggered (`node
   evals/roles/triggers.ts <base>` names the roles a batch's changes trigger; none triggered, the rung is skipped), once per
   merged batch, never per worktree agent. The holdout set (untracked `evals/roles/holdout/`, `--set holdout --compare
   <dev summary.json>`) runs only at acceptance.
4. The paid fixture (`evals/m1/`; `evals/m5/`, the UI end to end, when milestones, walks, design units or the demo
   changed): once per merged batch, never per worktree agent

Tests are a hard line: never skip, weaken or drop one. The integrated tier uses real processes and real git.
If a test cannot pass, stop and say so. `contain.cgroup-real` is reported NOT RUN on this host (cgroup v2 is
read-only here) and is never counted as a pass.

The one test seam in production code is `crashPoint(label)` in `src/core/crash.ts`. Backends are faked by
fake-backend scripts behind PATH shims. Add no other test hooks to production code.

## Standing rules

- Illegal states unrepresentable: branded ids, discriminated unions, closed enums.
- Fail loud on anything that should not happen; no speculative guards.
- One canonical way to do a thing.
- An executor update adopts an arc started on the previous release: record changes are additive with
  read-time defaults and a logged warning, and the previous release's runtime state is never refused. The
  defaulting code is temporary scaffolding, deleted once no arc started on the older release is in flight.
  `SCHEMA_VERSION` bumps only for a change that cannot be defaulted, and then both versions are read.
  `test/serial/upgrade.test.ts` guards it (`PREVIOUS_RELEASE`). Exception: arcs started before 1.0.0-dev.1
  (a95355e) are not adopted; they are adapted by hand.
- Hard cutover applies to 0.x layouts only: a 0.x `.roadmap/` layout is refused at startup, never converted.
- Actors are roles, never models, in every state file and record. Model ids appear only in routing
  configuration, which is revisioned; records carry `{role, routingRev}`.
- Every PR bumps the version, in lockstep, in `plugins/roadmap-orchestrator/.claude-plugin/plugin.json`,
  `plugins/roadmap-orchestrator/executor/package.json` and both `version` fields of `.claude-plugin/marketplace.json`.
  Claude Code picks up a plugin update only when the version changes; a stale marketplace entry hides it.
- No spend cap. A usage-limit error parks that backend arc-wide and waits for a manual `resume --backend`.
