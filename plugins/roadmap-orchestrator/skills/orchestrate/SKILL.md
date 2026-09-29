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

## Branches and refs

You create one branch before `start`. The executor creates every other ref.

- `integrationBranch`: the short name of an existing local branch. Use `integration`, not
  `refs/heads/integration` or `origin/main`. Cut it from the branch the arc builds on and leave it checked out
  in no worktree, because only the executor moves it. Don't name it `roadmap` or put it under `roadmap/<arc>`,
  where the unit branches go. `start` refuses a missing integration branch, and a branch at `roadmap` or
  `roadmap/<arc>`, as `plan-invalid` (78).
- `baseline`: a full 40-hex SHA from `git rev-parse`, never a branch name, and an ancestor of the
  integration tip.
- `arc` and unit ids are lowercase slugs: `[a-z0-9]` with inner `-`, 64 characters at most, no `/`.
- The executor creates the unit branch `roadmap/<arc>/<unit>` at the integration tip on the unit's first
  build. It also creates `refs/roadmap-run/<arc>/*` and `refs/roadmap/<arc>`. Don't create any of them.
  The only exception is a re-entry branch (see "Parked units").

```sh
git -C <repo> branch integration main   # once, before the first start
git -C <repo> rev-parse main            # baseline
```

```json
{ "schema": "roadmap/plan-m1", "arc": "page-ids", "integrationBranch": "integration",
  "baseline": "<40-hex from rev-parse>", "worktreeRoot": "/abs/worktree-root", ... }
```

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
| `resume` / `resume <unit>` / `resume --backend claude\|codex` | Clear pauses and holds; a held build continues its interrupted session in the worktree as left; `resume <unit>` also re-opens a unit parked at plan-check or gate once you have applied a revision of its spec, or one parked `routing-changed` once its implementer seat's routing is restored (below); `--backend` clears a usage-limit park after a passing smoke |
| `apply [--expect-rev <n>] [--dry-run]` | Put your edits to `plan.json` and specs in force (below). `--dry-run` prints the verdict and queues nothing |
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

Seats name a model class, never a model: `efficient`, `frontier` or `summit`. Both profiles seat them the same way:
efficient builds low and med, frontier builds high and judges every tier, summit takes escalations. They
differ in the efficient class: GPT-5.6 Luna (Codex) under `default`, Claude Sonnet 5.5 under `claude-only`. `.roadmap/config.json` (committed, set once per repo):

```json
{ "routing": {
    "profile": "claude-only",
    "seats": { "gate": { "high": "summit" } },
    "classes": { "efficient": { "backend": "codex", "model": "gpt-5.6-sol", "effort": "high" } } } }
```

Every key is optional. `seats` overrides the profile's class per seat. `classes` rebinds a class to a
`{backend, model, effort}` triple, and it is the only place you name a model. A Claude effort is
`low|medium|high|xhigh|max` (the built-in `frontier` and `summit` run at `high`, `claude-only`'s `efficient` at `medium`); a Codex effort `low|medium|high`. `plan.json`'s `routing` names
classes per seat the same way and cannot rebind a class. `.roadmap/config.json` is read at `start`; the
plan's `routing` changes with `roadmap apply`. A judgment seat may change mid-unit. A change that moves the implementer seat of a unit whose build has started parks that unit
(`routing-changed`); the needs-user names the seat (below).

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
- `plan`: the plan in force, `{rev, planSha256}` (null before the first start).
- `units`: `{unit, stage, status, attempts, chargeableFailures, risk, seat}` per unit of the plan in force; `seat` is the
  `{role, tier}` the current stage dispatches on (`tier` may be `escalation` for a judgment), or null. `status`
  is `held-after:<ids>` while units the unit runs `after` hold it.
- `routing`: the latest start's routing under the current config and the plan in force: `profile`, `rev`, the class per
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

- **Parked at plan-check or gate** (an escalation or refusal at the escalation seat, a redirect or revise round past
  its bound, a malformed or failed judgment): edit the unit's spec to the next rev, `roadmap apply`, then
  `roadmap resume <unit>`. The unit
  re-enters at plan-check on the new revision as a new attempt and keeps its branch, worktree and implementer
  session: its next build resumes that session, told the spec was amended. The resume acknowledges the park's
  needs-user. The plan-check redirect bound (two redirects) counts again from your edit; the other counters
  carry on.
- **Parked `routing-changed`** (a routing change moved the implementer seat after its build started): restore
  the routing of the seat the item names (`build.<tier>`) or re-enter the unit under a new id. Once the seat
  resolves to the binding the unit was dispatched on, `roadmap resume <unit>` re-pins it under the routing in
  force and re-enters it at the stage it parked at; no spec edit. Other seats may keep their new classes. The
  resume acknowledges the park's needs-user; while the seat is still moved it is rejected.
- **Parked anywhere else** (a lost build, a residue, a red candidate, a red base, a failed salvage): `resume`
  does not re-open it. Re-enter the work: add a unit with a new id to `plan.json` (its fixed spec, the same
  scope), create its branch at the tip of the parked unit's branch (`git branch roadmap/<arc>/<new id>
  roadmap/<arc>/<old id>`), acknowledge the old item, then `roadmap apply` the revised plan.

## Changing the plan: edit, then `roadmap apply`

The executor runs the plan in force, not the files: edit `plan.json` or a `spec.json` in place, then run
`roadmap apply`. It hashes the plan file the arc started with (`start.json`; `apply` takes no `--plan`) and
every spec, and queues the change; the executor applies it at the next stage boundary, or at once when no stage
is running, and kills nothing. The receipt says applied (`plan rev <n> in force`) or rejected with every reason;
nothing of a rejected apply is in force. `status` shows the plan in force (`plan.rev`). An edit you never apply is
ignored, also after a crash restart; a `start` applies changed files by the same rules and refuses what they refuse
(`plan-change-refused`). Use `--dry-run` first, and `--expect-rev <n>` to refuse the apply if the plan moved.
`--dry-run` always exits 0: read `kind` (`rejected` with `reasons`, `unchanged` with `rev`, or `accepted` with
`rev`, `nextRev`, `changes`, `smoke`).

- **Add a unit** at the end (or among units not yet started); a unit id is never reused. **Remove** only a unit
  that never started. Units that have started keep their order at the front.
- **A unit not yet dispatched**: change anything.
- **A dispatched unit**: its `scope`, `risk`, `resources` and spec path are fixed, and it may not gain an `after`.
  Its spec: keep the schema and every item id (strike or defer, never delete or reuse), leave `scope` and
  `resources` alone, and set `rev` to its recorded rev plus one. An active unit (not held) re-enters plan-check
  on the revision at its next stage boundary before plan-check, lanes, gate or a fresh or fix build round (not a
  continue), keeping its branch and session; a unit parked at plan-check or gate waits for
  `roadmap resume <unit>`. A lane's `evidenceGlobs` and `evidenceExcludes` may change at the current rev (refused
  while a revision is pending): the next lanes attempt reads them, the approval stands. A merged, approved or
  publishing unit's spec is fixed.
- **Routing**: a newly needed backend is smoked first. A seat change that moves the implementer of a unit whose
  build started parks that unit `routing-changed` (above).
- **Resources**: add any time; change or remove one only while nothing holds it and no residue names it.
  **Suite lanes**: not while a unit is past a candidate attempt.
- `arc`, `integrationBranch`, `baseline` and `worktreeRoot` never change.

## Writing lanes

The executor grades a lane by its exit code and keeps what the lane leaves as evidence for the gate and the
fix round. Two rules for every lane script:

- Declare `evidenceGlobs` for anything a script writes as its own evidence (logs, reports, dumps). Undeclared
  ignored output is captured only when the lane fails, capped, and the checkout is deleted after the series.
  The gate's ledger shows each lane's uncaptured ignored writes as `not-declared`.
- Assert a required failure inside the script (or state it by `expectedExit`), and before any non-zero exit
  print the failing step and the reason on stderr. The fix round starts from stderr.

The failing-lane capture never takes build output (`node_modules/`, `dist/`, `target/` and the like) or key
material (`*.key`, `*.pem`, `id_rsa*`, `.env`, kubeconfigs and the like). Add the lane's own
`evidenceExcludes` for anything else that must never leave the checkout.

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
- `plan-change-refused`: the files differ from the plan in force in a way `apply` refuses; undo that edit.
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
