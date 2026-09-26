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
branch, snapshot to `refs/roadmap/<arc>`. Phase 0 lands in M3 and M4. In M1 you write `plan.json` and each
unit's `spec.json` by hand, following the "Input contract" and "`spec.json` M1 subset" sections of
`executor/SCHEMAS.md`. For a worked plan, run the M1 fixture's `executor/evals/m1/setup.ts <dir>` and read `<dir>/input/`.

## What judgments read

- **Cites.** Each `spec.json` carries `cites: {contracts, rulings}`: the plan contracts and C-nn rulings the
  unit's prompts embed in full. Cite what the unit's clauses rest on. Every other contract and ruling reaches
  the prompt as one index line that a judge reads on demand. A plan-check redirect may add cites; nothing
  removes them.
- **Rulings ledger.** The plan's `rulings` file holds rule text only, one `C-nn — <rule>` per line.
  Provenance ("ruled by", "architect") goes in the in-tree `constraints.md`, never here. To supersede or
  withdraw a ruling, replace its line with `C-nn — withdrawn by C-mm`.
- **Architecture digest.** A plan may name `architectureDigest`: an owner-approved digest of the architecture
  doc (a section index plus the normative sentences, each with its line anchor). Judgments embed the digest and
  read the full doc from their checkout on demand. Get the owner's approval before you name one.

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
| `start --repo <path> --plan <plan.json> [--profile default\|claude-only] [--wait <ms>]` | Launch, or recover from disk. Without `--profile`, `.roadmap/config.json` chooses, else `default`. Waits up to 240 s (or `--wait`) for readiness |
| `status` | Agent-facing JSON snapshot of the run |
| `watch` | JSON line stream: `needs-user`, `ack`, `owner` events. Run it under Monitor with a timeout |
| `pause <unit>` / `pause --all` | Kill, tear down, keep commits and the worktree as left; the unit holds at its stage |
| `resume` / `resume <unit>` / `resume --backend claude\|codex` | Clear pauses and holds; a held build continues its interrupted session in the worktree as left; `resume <unit>` also re-opens a unit parked at plan-check or gate once you have edited its spec (below); `--backend` clears a usage-limit park after a passing smoke |
| `stop` | Park everything, tear down, release the host lock |
| `ack <needs-user-id> [--choice <option-id>]` | Answer a needs-user item |
| `sweep [--resource <name>]` | Run the recorded teardown for undispositioned residues |
| `--version` | Print the executor version |

`start` prints one JSON line and returns while the run goes on: `{"kind":"ready",...}` (exit 0) once the
executor is alive and reconciling. The backend smoke runs after recovery, so a smoke refusal after `ready`
shows in `status` (`rejection`) and the run exits `refused`. The run's end is in `status`. Exit 70 with
`{"kind":"failed",...}` or `{"kind":"timeout",...}` means the supervisor died or did not report ready in time;
read `status` and the supervisor's logs in the host dir before starting again.

The other commands only queue a file and print its id. Queued is not applied: check
`commands/receipts/<id>.{accepted,applied,rejected}.json`.

## Routing

A seat is `role.tier`: `build.low|med|high`, and `planCheck` and `gate` each with `low|med|high|escalation`.
The unit's risk picks the tier. A refusal or escalation at a judgment stage, or a risk trigger, moves that
judgment to its role's `escalation` seat in a fresh session; escalating again there parks the unit with a
needs-user for you.

Seats name a model class, never a model: `efficient`, `frontier` or `summit`. `default`: efficient builds
low and med, frontier builds high and judges every tier, summit takes escalations. `claude-only`: frontier
builds every tier, judgment as in `default`. `.roadmap/config.json` (committed, set once per repo):

```json
{ "routing": {
    "profile": "claude-only",
    "seats": { "gate": { "high": "summit" } },
    "classes": { "efficient": { "backend": "codex", "model": "gpt-5.6-sol", "effort": "high" } } } }
```

Every key is optional. `seats` overrides the profile's class per seat. `classes` rebinds a class to a
`{backend, model, effort}` triple, and it is the only place you name a model. `plan.json`'s `routing` names
classes per seat the same way and cannot rebind a class. Routing is read at `start`. A judgment seat may
change mid-unit. A change that moves the implementer seat of a unit whose build has started parks that unit
(`routing-changed`); the needs-user names the seat.

## The run dir

`$(git rev-parse --path-format=absolute --git-common-dir)/roadmap-runtime/<arc>/`. Read, never write:

- `needs-user/<id>.json`: `summary`, `reason`, `subject`, `recommendation`, `options[{id, label}]`, `evidence[]`
  (paths). `<id>.ack.json` appears once acknowledged.
- `heartbeat.json`: every 10 s; stale after 5 minutes means the executor is dead or wedged.
- `inv/<seq>-<ordinal>/`: one directory per invocation, with `stdout`, `stderr`, `exit.json`, `result.json`.

## Reading `status`

One JSON object. Start with `run`: `state` is `running` (a stage is in flight, or the next unit may start),
`held` (nothing can start: the next unit is paused, held by an interrupted stage or a parked backend, or waits on
`after`),
`parked` (a blocking needs-user waits on you), `complete`, `refused` or `no-owner`; `owner` is
`{state: alive|dead|none, generation, pid}`; `heartbeatAt` is the executor's last heartbeat. Then:

- `needsUser`: the unacknowledged items, `{id, reason, blocking}`, ascending id, including the host-level
  `sup-*` and `host-*` items. The summary, recommendation, options and evidence are in `needs-user/<id>.json`.
  `run.state` is `parked` only when an item holds the whole arc; a parked unit with later units running
  shows `running`.
- `units`: `{unit, stage, status, attempts, chargeableFailures, risk, seat}` per plan unit; `seat` is the
  `{role, tier}` the current stage dispatches on (`tier` may be `escalation` for a judgment), or null. `status`
  is `held-after:<ids>` while units the unit runs `after` hold it.
- `routing`: the latest start's routing under the current config and plan: `profile`, `rev`, the class per
  seat (`seats`), the layer that chose each (`sources`), and where each class is bound (`bindings`:
  `builtin|repo-config`). No model ids.
- `commands`: `pending` (`{id, type}`, no terminal receipt yet) and the last 10 terminal `receipts`.
- `spend`: `byRole` token totals per role and routing revision; `byModel` derives the models from those
  seats at render time, the only place `status` names a model.
- `host.containment`: the containment `mode` and its stated `guarantee`.
- `parkedBackends`: backends parked on a usage limit or capacity error until `resume --backend`.
- `rejection`: the latest refused start's rows, or null.

An undispositioned residue blocks every future `start` (the `undispositioned-residue` rejection) until
swept or dispositioned.

## Ordering units: pause and `after`

M1 runs the plan's units one at a time, in plan order. A paused unit is never dispatched, and the arc waits at
it: every unit after it waits too until you `resume` it. Pausing a later unit is a gate you can hold; it is not
a way to skip one.

A parked unit does not hold the units after it: the next one runs while its needs-user is open. When a unit
must not start until another is done, give it `after: [<unit id>, ...]` in `plan.json` (units earlier in plan
order only). It is held, and the arc waits at it, until each named unit is merged or parked with its needs-user
acknowledged. Use `after` rather than pausing everything behind a unit you expect to park.

## Parked units: re-open or re-enter

Read the item's `evidence` first: the deciding call's `result.json` (a judgment's reasons and patch), its
`stdout`, the spec file, and for a lanes or candidate park the lane evidence. The `recommendation` says which of
these applies:

- **Parked at plan-check or gate** (an escalation or refusal at the high seat, a redirect or revise round past
  its bound, a malformed or failed judgment): edit the unit's spec, then `roadmap resume <unit>`. The unit
  re-enters at plan-check on the new revision as a new attempt and keeps its branch, worktree and implementer
  session: its next build resumes that session, told the spec was amended. The resume acknowledges the park's
  needs-user. The plan-check redirect bound (two redirects) counts again from your edit; the other counters
  carry on.
- **Parked anywhere else** (a lost build, a residue, a red candidate, a red base, a failed salvage): `resume`
  does not re-open it. Re-enter the work: add a unit with a new id to `plan.json` (its fixed spec, the same
  scope), create its branch `roadmap/<arc>/<new id>` at the tip of the parked unit's branch, acknowledge the
  old item, then `stop` and `start` with the revised plan.

Spec edits follow one rule: edit `spec.json` in place only while its unit is parked at plan-check or gate (or
before its first dispatch). Keep the schema and every item id; strike or defer an item instead of deleting it,
never reuse an id, and leave `scope` and `resources` alone. Set `rev` to the rev the file had when the unit
parked, plus one. `resume` is rejected, with the reason, for an unchanged file, a changed file at the same rev,
or any other rev.

## Shared resources: an owner lease

An occupancy probe that only looks at the resource (are clusters running? is the port bound?) cannot tell a
free resource from one a person or another tool is using between its runs, and the resource's teardown would
destroy that user's work. Give every shared resource an owner marker the probe honours: whoever uses the
resource outside the executor writes a lease file, `/var/tmp/roadmap-resources/<name>.lease` (holder and
purpose inside), and removes it when done. The plan's probe checks the lease first and exits 11 (occupied, not
this unit's) while it exists, before any occupancy check. The executor then parks the unit on
`occupancy-unlabelled` instead of tearing the resource down. The lease is a convention between your probe and
the resource's other users; the executor never writes or reads it.

## When `start` refuses

Exit **75**: another live process holds this host. Wait, or find that arc with `status`. Exit **78**: a
startup row refused. The reason is in `status`; fix the input or dispose the blocker, then start again.

- `legacy-roadmap-dir`: 0.x files in the in-tree `.roadmap/`; move them out, 1.0 never converts.
- `worktree-root-unusable`, `plan-invalid`, `spec-lane-unrunnable`, `unsupported-routing`: fix the plan or spec.
- `backend-smoke`: fix that backend's auth or sandbox.
- `undispositioned-residue`: run `sweep`, or answer its needs-user.
- `previous-arc-unreconciled`, `recovery-holder-dead`, `owner-mismatch`, `log-corrupt`,
  `containment-mode-changed`: host-level; read `status` and any needs-user, never clear host files by hand.

## When the executor keeps crashing

Three executor crashes within an hour stop the supervisor. It raises `sup-<generation>-<n>` (reason
`supervisor-crash-limit`) with the crashed executors' stderr logs as evidence, releases the host and exits;
a `start` still waiting for readiness exits 70. Read the logs and fix the cause. Then run
`roadmap ack sup-<generation>-<n> --repo <path> --arc <arc>` and `roadmap start`. That start runs control-only: it applies your ack and any
other commands before recovery, and dispatches only once nothing blocking remains.

## Usage limits

A usage-limit error parks that backend for the whole arc and raises one needs-user. Nothing retries on its
own. Once the limit has reset, run `resume --backend <name>`. It re-runs that backend's smoke and rejects the
command if the smoke fails. Don't switch profiles to route around a limit.
