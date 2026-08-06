---
name: roadmap-orchestrate
description: Create or continue checkpointed roadmap implementation arcs with the local @openai/codex-sdk sidecar. Use when Codex should run the roadmap conductor and harness, continue a Claude-created arc without restarting it, resume a Codex journal, switch execution hosts at a persisted boundary, or verify Codex authentication before dispatch.
---

# Orchestrate a roadmap arc with Codex

Use the shared [orchestration skill](../orchestrate/SKILL.md) for Phase 0 planning, approval, contracts, scope methodology, boundary judgment, and session-end duties. Read its [reference](../orchestrate/reference.md) for plan/state formats and recovery rules. This file changes only the execution host.

## Mandatory host contract

You are on the Codex path. Never invoke native `Workflow(...)`, Claude `resumeFromRunId`,
`claude -p`, or any external Claude process. After the shared Phase 0 approval boundary, dispatch
only through `runtime/codex/bin/roadmap-codex.mjs`. The base workflow scripts are inputs to that
sidecar; do not execute their Claude-only invocation examples directly.

Resolve `ROADMAP_CODEX_RUNTIME` as the absolute `runtime/codex` directory in the installed plugin
that contains this skill. Do not assume the target repository is the plugin source checkout.

## Prepare

1. Install the isolated sidecar dependencies with `npm ci --ignore-scripts` in `$ROADMAP_CODEX_RUNTIME`. Claude plugin use does not require this install.
2. Run `node "$ROADMAP_CODEX_RUNTIME/bin/roadmap-codex.mjs" doctor --repo <repo> --require-chatgpt-auth`. This performs no model call and must report ChatGPT-managed authentication before a subscription-backed run.
3. For a new arc, perform the shared skill's Phase 0 exactly, including the user approval boundary. New plans must set `methodology.scopePolicy` to `bounded-v1`; ordinary code units default to `scopeMode: feature`.
4. For an existing arc, read its plan/state and preserve its policy. A missing policy means legacy semantics. Never upgrade it during a wave.

## Dispatch

- Start a fresh sidecar run: `node "$ROADMAP_CODEX_RUNTIME/bin/roadmap-codex.mjs" run --repo <repo> --profile parity --require-chatgpt-auth`.
- Resume a matching Codex deterministic prefix: `node "$ROADMAP_CODEX_RUNTIME/bin/roadmap-codex.mjs" resume --repo <repo> --run-id <id> --require-chatgpt-auth`.
- Continue only from plan/state and Git checkpoints: `node "$ROADMAP_CODEX_RUNTIME/bin/roadmap-codex.mjs" continue --repo <repo> --profile parity --require-chatgpt-auth`.

Use `parity` when quality is the priority and `economy` when conserving allowance. Preserve the workflow-requested effort: planning/implementation normally receive the configured implementation effort, reviews and routine gates the configured gate effort, architect decisions high effort, and mechanical/setup/persist calls low effort. Do not raise every call indiscriminately; change effort only through the plan/config knobs and record the resulting mapping in the journal.

The runner creates a fresh Codex thread for each workflow `agent()` call, writes its journal outside Git worktrees under `<worktreeRoot>/__codex-runtime/<run-id>/`, and writes normal progress to the terminal or `--jsonl` events to stdout. It never imports the test loader.

Browser-visible progress is on by default. The dependency-free dashboard binds `0.0.0.0:8787` and
shows operational events without prompts/results; because other reachable hosts can see that metadata,
use `--dashboard-host 127.0.0.1` when promiscuous binding is unnecessary, or `--no-dashboard` to disable it.

## Switch hosts safely

Establish that the old host is stopped. Prefer a wave boundary or another persisted checkpoint. Launch the new host as a fresh conductor from current `.roadmap/plan.json`, `.roadmap/state.json`, committed unit branches, and worktrees. Never pass a Claude run ID to Codex or a Codex run ID to Claude; their journals are not portable.

If a host died during a wave, inspect state and Git before launch. Let the existing setup/adoption guards recover committed in-flight work. Never delete another host's branch or worktree automatically.

Upgrade a legacy arc only at a wave boundary: stop the host, commit/checkpoint current work, add `methodology.scopePolicy: bounded-v1`, assign scope modes and required allowed paths to every remaining unit, record the decision in the architect log/state, then launch a fresh conductor. Do not resume the old host journal across that plan fingerprint change.

## Finish

Retain the shared root architect duties: inspect boundary evidence and observations, adjudicate contract mismatches, report debt and degradations, verify the integration branch, and hand the result to the user. Describe Codex journal replay as deterministic-prefix replay, not partial turn resumption or Claude workflow parity.
