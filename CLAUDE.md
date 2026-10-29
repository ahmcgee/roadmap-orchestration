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

A change is not done until the rungs it triggers pass, in order (from `executor/`). Run a rung because it can
catch a regression in what changed, not for ceremony:

- Docs only (README, `docs/`, this file, comments): no rungs.
- Executor code, tests or tooling that leave agent behaviour unchanged (refactors, perf, TUI, state/records,
  scheduler mechanics, test helpers): rungs 1–2. Rung 3 only if backend CLI invocation or parsing changed.
- Agent behaviour changes: everything an agent is given or asked to do, i.e. skill text, seat prompts, role
  inputs or output schemas, routing, or the arc flow a fixture exercises. These run rungs 1–3 plus the paid
  rungs the change triggers (3.5 by path trigger; 4 only when the fixture exercises the changed behaviour).

Paid rungs are pre-authorised when triggered and skipped when not; the PR says which rungs ran, which were
skipped and why. While iterating, run the affected test files directly; the full `npm test` runs once on the
finished batch.

The rungs:

1. `npm run typecheck`
2. `npm test` (`node --test --test-concurrency=8 test/*.test.ts`: eight files at a time, each about one runnable
   process wide on average; then `test/serial/*.test.ts` alone, one file at a time: the files that fan out across the host (the
   crash matrices, sized by `FANOUT` in `test/helpers/fanout.ts`, and the pool, probe and resource crash files), the
   tests needing a calm host (the upgrade test, the m4a fake sessions), the real-browser tests (`walk-browser`, which
   needs the devcontainer's Playwright MCP and Chromium, and `evals-m5-reflow`, the m5 check's reflow oracle on that Chromium) and `pressure`, which saturates the host on purpose). Both tiers keep runnable load within the host's cpus: a saturated host fails timing-bound tests, so a
   file that runs eight or more cells of real processes at once goes in the serial tier, never the parallel one.
3. `node evals/probe.ts`: real CLIs, pennies
3.5. Role evals (`evals/roles/`, `node evals/roles/run.ts <gate|walkthrough|polishJudge|scaffold> --set dev --n 3`, with `--cap`):
   paid, path-triggered (`node
   evals/roles/triggers.ts <base>` names the roles a batch's changes trigger; none triggered, the rung is skipped), once per
   merged batch, never per worktree agent. The holdout set (untracked `evals/roles/holdout/`, `--set holdout --compare
   <dev summary.json>`) runs only at acceptance.
   Estate compaction (`node evals/compaction/run.ts --set dev --n 3 --stage both --cap <usd>`) also runs at this rung
   when `skills/estate-compaction/` or orchestrate's Phase 0 compaction text changes; the path trigger conservatively
   treats any orchestrate skill edit as triggering it. Its holdout is untracked and runs only at acceptance.
4. The paid fixture (`evals/m1/`; `evals/m5/`, the UI end to end, when milestones, walks, design units or the demo
   changed): once per merged batch, never per worktree agent

Tests are a hard line: never skip, weaken or drop one. The integrated tier uses real processes and real git.
If a test cannot pass, stop and say so. `contain.cgroup-real` is reported NOT RUN on this host (cgroup v2 is
read-only here) and is never counted as a pass.

The one test seam in production code is `crashPoint(label)` in `src/core/crash.ts`. Backends are faked by
fake-backend scripts behind PATH shims. Add no other test hooks to production code.

## Standing rules

- Claude-only routing is the first-class system. Design, probe and evaluate every feature for Claude backends first.
  Codex backend support stays, but keep it simple: a working, unpolished path is enough, and Codex never drives
  the design or adds complexity to the Claude path.
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
- Every PR that changes the plugin (anything under `plugins/`) bumps the version, in lockstep, in `plugins/roadmap-orchestrator/.claude-plugin/plugin.json`,
  `plugins/roadmap-orchestrator/executor/package.json` and both `version` fields of `.claude-plugin/marketplace.json`.
  Claude Code picks up a plugin update only when the version changes; a stale marketplace entry hides it. A PR
  touching only repo docs (README, `docs/`, this file) bumps nothing.
- Every PR that changes how an arc runs (a stage, decision, loop, role, command or what the owner or architect
  does) updates the process documentation in the same PR: the README's "How an arc runs" section, the simplified
  diagram `docs/flow.svg` and the detailed BPMN diagram `docs/flow-bpmn.svg`. Both diagrams keep a white
  background, with no dark theme.
- No spend cap. A usage-limit error parks that backend arc-wide and waits for a manual `resume --backend`.
