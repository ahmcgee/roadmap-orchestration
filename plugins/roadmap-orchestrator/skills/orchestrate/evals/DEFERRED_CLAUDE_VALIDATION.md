# Deferred native Claude validation

Run these only after the Claude Code subscription allowance resets. Use native Claude Code and its native
`Workflow(...)`; never use `claude -p` or an Agent SDK wrapper.

1. Native harness fixture

   ```sh
   bash setup-fixture.sh /tmp/roadmap-eval
   ```

   In the same Claude Code session, invoke:

   ```js
   Workflow({scriptPath: "<absolute-skill-dir>/harness.mjs", args: {plan, state, config: {}}})
   ```

   Then run `bash check.sh /tmp/roadmap-eval`. Expected: `ALL CHECKS PASSED`.

2. Native conductor fixture

   ```sh
   bash setup-fixture.sh --conductor /tmp/roadmap-eval-c
   ```

   In Claude Code, invoke once:

   ```js
   Workflow({scriptPath: "<absolute-skill-dir>/conductor.mjs",
             args: {plan, state, config: {}, harnessPath: "<absolute-skill-dir>/harness.mjs"}})
   ```

   Then run `bash check-conductor.sh /tmp/roadmap-eval-c`. Expected: all checks pass and the conductor
   reaches the documented valid terminal/architect-handoff state.

3. Native issue-mode fixture (affected by stable debt markers)

   ```sh
   bash setup-fixture.sh --conductor /tmp/roadmap-eval-issues
   RUN_ISSUE_EVAL=1 bash issue-bootstrap.sh /tmp/roadmap-eval-issues
   ```

   Launch the native conductor exactly as in step 2 using the patched issue-mode plan, then run:

   ```sh
   bash check-conductor.sh /tmp/roadmap-eval-issues
   bash check-arc-issues.sh /tmp/roadmap-eval-issues
   bash issue-teardown.sh /tmp/roadmap-eval-issues
   ```

   Expected: arc checks and issue projection pass, stable debt facts do not duplicate, teardown succeeds.

4. Native Claude scope canary

   ```sh
   bash setup-scope-fixture.sh /tmp/roadmap-claude-scope
   ```

   Launch native `Workflow(...)` directly on `harness.mjs` with that fixture's plan/state, then run
   `bash check-scope-fixture.sh /tmp/roadmap-claude-scope`. Expected: `ALL SCOPE CANARIES PASSED`.

5. Claude plugin packaging/invocation

   ```text
   /plugin marketplace add /absolute/path/to/roadmap-orchestration
   /plugin install roadmap-orchestrator@roadmap-orchestration
   /roadmap-orchestrator:orchestrate --dry-run <fixture roadmap input>
   ```

   Expected: native skill discovery succeeds, Phase 0 produces a `bounded-v1` plan, and dry-run stops at
   the approval boundary without dispatch.

6. Claude → Codex → Claude switching

   Start one native Claude wave, stop at a persisted boundary, record the Claude state/run metadata, and
   launch `roadmap-codex continue --repo <repo> --require-chatgpt-auth`. Stop Codex at the next boundary,
   then launch a fresh native Claude conductor from current plan/state (do not use either host's run ID on
   the other host). Expected: committed unit branches are adopted, neither host's worktrees are deleted,
   and the arc completes without repeating merged units.

Release status until all six pass: **BLOCKED — native Claude paid behavior pending**.
