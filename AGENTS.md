# Working on roadmap-orchestration

This repository is the source of two skills, not a consumer running an arc. Runtime prohibitions
inside either skill do not prohibit deliberate source changes here. Preserve unrelated local files.

The Codex-native skill lives at `plugins/roadmap-orchestrator/skills/roadmap-orchestrate/` and is
discoverable via `.agents/skills/roadmap-orchestrate`. Its protocol helpers are also used by the
Claude driver's `persist.mjs`. Keep both handoff directions covered by real-Git tests.

For shared helper/native changes, run the native tests and the Claude parse and unit checks.
Changes to Claude workflow/persistence code also require the existing three-tier fixture ladder
documented in `plugins/roadmap-orchestrator/skills/orchestrate/evals/README.md`. If the Claude dynamic
Workflow runtime is unavailable, report the unrun paid fixtures explicitly; mocks do not replace
that evidence. Never invoke a simulated Workflow as if it were the real platform.
