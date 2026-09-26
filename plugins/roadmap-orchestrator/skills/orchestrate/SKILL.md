---
name: orchestrate
description: Drives the roadmap-orchestrator 1.0 executor, which converges a repo on a documented target state unattended; the M1 build runs one serial unit through plan-check, build, lanes, gate and candidate merge.
---

# Roadmap Orchestrator 1.0, M1

You are the architect. The executor, a detached Node process, owns every backend invocation, lane, git
operation, lock and evidence directory, and logs each side effect write-ahead. Your surface is the CLI below
and the files it points to. The reasons are in `RATIONALE-1.0.md`.

## What M1 covers

One unit, serially: plan-check, build, salvage, lanes, gate, candidate merge, fast-forward of the integration
branch, snapshot to `refs/roadmap/<arc>`. Phase 0 lands later: obligations and the holistic layer in
M3, plan authoring in the M4 skill text. In M1 you write `plan.json` and each unit's `spec.json` by hand, following the
"Input contract" and "`spec.json` M1 subset" sections of `executor/SCHEMAS.md`. For a worked plan, run the
M1 fixture's `executor/evals/m1/setup.ts <dir>` and read `<dir>/input/`.

## What you never do

- Run a backend, a lane or a teardown yourself. The executor launches `codex exec` and `claude -p`.
- Run `git` inside the executor's worktrees (under the plan's `worktreeRoot`), or commit to its branches.
- Delete or move a ref the executor owns: the integration branch, unit branches, `refs/roadmap-run/<arc>/*`,
  `refs/roadmap/<arc>`.
- Edit anything in the run dir, or the in-tree `.roadmap/`, by hand. Commands are the only write path.
- Acknowledge a needs-user item you have not read in full.
- Retry a usage-limited backend on a timer, or reroute around it (see below).

## The CLI

`executor/bin/roadmap`, from the plugin root. Run commands find the arc through the host lock; add
`--repo <path> --arc <arc>` to reach a run with no live owner.

| Command | Effect |
|---|---|
| `start --repo <path> --plan <plan.json> [--profile default\|claude-only]` | Launch, or recover from disk. Without `--profile`, `.roadmap/config.json` chooses, else `default` |
| `status` | Agent-facing JSON snapshot of the run |
| `watch` | JSON line stream: `needs-user`, `ack`, `owner` events. Run it under Monitor with a timeout |
| `pause <unit>` / `pause --all` | Kill, tear down, keep commits; the unit holds at its stage |
| `resume` / `resume <unit>` / `resume --backend claude\|codex` | Clear pauses and holds; `--backend` clears a usage-limit park after a passing smoke |
| `stop` | Park everything, tear down, release the host lock |
| `ack <needs-user-id> [--choice <option-id>]` | Answer a needs-user item |
| `sweep [--resource <name>]` | Run the recorded teardown for undispositioned residues |
| `--version` | Print the executor version |

The other commands only queue a file and print its id. Queued is not applied: check
`commands/receipts/<id>.{accepted,applied,rejected}.json`.

## The run dir

`$(git rev-parse --path-format=absolute --git-common-dir)/roadmap-runtime/<arc>/`. Read, never write:

- `needs-user/<id>.json`: `summary`, `reason`, `subject`, `recommendation`, `options[{id, label}]`, `evidence[]`
  (paths). Read the evidence before you answer. `<id>.ack.json` appears once acknowledged.
- `heartbeat.json`: every 10 s; stale after 5 minutes means the executor is dead or wedged.
- `inv/<seq>-<ordinal>/`: one directory per invocation, with `stdout`, `stderr`, `exit.json`, `result.json`.

## Reading `status`

One JSON object. Start with `run`: `state` is `running`, `held` (a pause, a held unit or a parked backend),
`parked` (a blocking needs-user waits on you), `complete`, `refused` or `no-owner`; `owner` is
`{state: alive|dead|none, generation, pid}`; `heartbeatAt` is the executor's last heartbeat. Then:

- `needsUser`: the unacknowledged items, `{id, reason, blocking}`, ascending id. The summary, recommendation,
  options and evidence are in `needs-user/<id>.json`.
- `units`: `{unit, stage, status, attempts, chargeableFailures, risk, seat}` per plan unit; `seat` is the
  `{role, tier}` the current stage dispatches on, or null.
- `commands`: `pending` (`{id, type}`, no terminal receipt yet) and the last 10 terminal `receipts`.
- `spend`: `byRole` token totals per role and routing revision; `byModel` derives the models from those
  seats at render time, the only place `status` names a model.
- `host.containment`: the containment `mode` and its stated `guarantee`.
- `parkedBackends`: backends parked on a usage limit or capacity error until `resume --backend`.
- `rejection`: the latest refused start's rows, or null.

An undispositioned residue blocks every future `start` (the `undispositioned-residue` rejection) until
swept or dispositioned.

## When `start` refuses

Exit **75**: another live process holds this host. Wait, or find that arc with `status`. Exit **78**: a
startup row refused. The reason is in `status`; fix the input or dispose the blocker, then start again.

- `legacy-roadmap-dir`: 0.x files in the in-tree `.roadmap/`; move them out, 1.0 never converts.
- `worktree-root-unusable`, `plan-invalid`, `spec-lane-unrunnable`, `unsupported-routing`: fix the plan or spec.
- `backend-smoke`: fix that backend's auth or sandbox.
- `undispositioned-residue`: run `sweep`, or answer its needs-user.
- `previous-arc-unreconciled`, `recovery-holder-dead`, `owner-mismatch`, `log-corrupt`,
  `containment-mode-changed`: host-level; read `status` and any needs-user, never clear host files by hand.

## Usage limits

A usage-limit error parks that backend for the whole arc and raises one needs-user. Nothing retries on its
own. Once the limit has reset, run `resume --backend <name>`. It re-runs that backend's smoke and rejects the
command if the smoke fails. Don't switch profiles to route around a limit.
