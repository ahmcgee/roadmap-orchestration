# Roadmap Orchestrator 1.0: reference

The CLI, the files, `status`, the brief and every refusal, for the agent running the `orchestrate` skill.
`SKILL.md` says what to do and when; this file says what each command takes and what each answer means. Paths
starting `executor/` are under the plugin root.

## Conventions

- `roadmap` is `executor/bin/roadmap`. Output is one line of canonical JSON unless noted.
- Exit codes: 0 done; 64 bad arguments or a CLI error (message on stderr); 70 `start`'s supervisor died or did not
  report ready; 75 another live process holds this host; 78 refused (the rows are in the output, or in `status`).
- Notation in this file and SCHEMAS.md: `kind{a, b}` is the object `{"type": "kind", "a": …, "b": …}` (rows use
  `kind` instead of `type`); `a | b` is a closed choice; `x?` is optional.
- Ids: arc and unit ids are lowercase slugs (`[a-z0-9]` with inner `-`, at most 64); `T-n` rule, `V-n` vision
  clause, `I-n` obligation, `C-n` ruling, `D-n` divergence, `F-n` finding, `B-n` debt, `M-n` amendment (cited
  `<arc>/M-n` across arcs), `P-n` Phase-0 question, `issue-<number>`; needs-user ids are `nu-<seq>`, `sup-<g>-<n>`
  or `host-<slug>`.

## CLI

### Run commands

Each finds the run through the host lock (the one live arc on this host). Add `--repo <path> --arc <arc>` to any
of them to reach a run with no live owner, e.g. `roadmap status --repo <path> --arc <arc>`. Except `start`,
`status`, `watch` and `apply --dry-run`, they only queue a file and print `{command, arc, type}`. Queued is not
done: the executor writes `commands/receipts/<id>.accepted.json`, then exactly one of `.applied.json` or
`.rejected.json` (with every reason).

- `roadmap start --repo <path> --plan <plan.json> [--profile default|claude-only] [--wait <ms>]`: launch, or recover
  from disk. Without `--profile`, `.roadmap/config.json` chooses, else `default`. Prints `{"kind":"ready",…}` (exit 0)
  once the executor passed every startup row; the run goes on. The backend smoke runs after `ready`: a smoke refusal
  shows in `status.rejection` and the run ends `refused`. Exit 78 with the rows, 75 host busy, 70 `failed` or
  `timeout` (read `status` and the supervisor logs in the host dir before starting again). Waits 240 s by default.
- `roadmap status`: the run as one JSON object ("status" below).
- `roadmap watch [--actionable]`: one JSON line per event until killed; `--actionable` prints only what you act on.
  Wait on `roadmap watch --actionable` under Monitor with a timeout ("watch" below).
- `roadmap stop`: park everything, tear down, release the host lock.
- `roadmap pause (<unit> | --all)`: kill and tear down; commits and worktree stay as left; the unit holds at its stage.
- `roadmap resume [<unit> | --backend claude|codex]`: no argument clears pauses and holds (a held build continues
  its session). `<unit>` re-opens a unit parked at plan-check or gate after a spec revision was applied, or one
  parked `routing-changed` once its seat is restored. `--backend` clears a usage-limit park after a passing smoke.
- `roadmap ack <needs-user-id> [--choice <option-id>]`: answer an item; `--choice` names one of its `options`.
- `roadmap sweep [--resource <name>]`: run the recorded teardown of undispositioned residues.
- `roadmap apply [--expect-rev <n>] [--dry-run] [--ruling <file>]`: put the edited plan, specs and other revisioned
  inputs in force at the next stage boundary. Each `--ruling` (repeatable) is a ruling sidecar validated as `rule`
  validates it and landed with the edits as one revision. `--dry-run` always exits 0 and prints `kind`:
  `rejected{reasons}`, `unchanged{rev}` or `accepted{rev, nextRev, changes, smoke}`; it queues nothing.
- `roadmap resolve-edge <edge> --evidence <text>`: a contingent edge's condition is met, on your evidence.
- `roadmap run-only (<unit>... | --clear)`: limit admission to these units, or lift the limit.
- `roadmap rule <record.json>`: land a ruling (a `roadmap/ruling-m3` sidecar); published through a docs
  publication, then written to the live ledger.
- `roadmap reverse <D-n>`: a compensating revision restoring what divergence D-n's act changed; rejected when a later
  revision changed it again (use `apply`).
- `roadmap steer <unit> --brief <file> --budget <min> [--class efficient|frontier|summit] [--resume]`: one uncharged
  implementer round for a parked or `preparing` unit, then salvage, lanes and gate. It parks again unless green and
  `--resume`. `--class` seats that class at the unit's build tier.
- `roadmap merge-in <unit>`: merge the integration tip into a unit's branch (clean merges only); it re-enters at lanes.
- `roadmap audit [--lens <lenses>]`: request an audit (holistic arcs; lenses comma-separated, within the arc's set:
  `invariants`, `drift`, `vacuity`, `vision`).
- `roadmap close-admissions`: latch `draining`; checkpoint admissions become requests to you; an `apply` adding a
  unit reopens.
- `roadmap gc --repo <path> [--keep <K>] [--dry-run]`: not queued. Under the host lock, prunes sealed arcs (raw
  evidence; run dirs beyond K, which the ref restores). Prints its report, or `{refused}` with exit 75 or 78.
- `roadmap --version`

### Host acts

Not queued, no host lock, no run needed. Run them any time, a running arc included.

- `roadmap phase0 check --repo <path> --plan <plan.json>`: read-only, the rows a fresh `start` runs on its inputs:
  the `.roadmap/` layout, `plan-invalid`, routing, lanes, `holistic-needs-corpus`, and every corpus, Phase-0,
  vision, issue-policy, chain and `tree-uncommitted` row (not the host, residue or smoke rows). Prints `{rows, sliceCandidates}`; exit 0 with no rows, else 78.
  `sliceCandidates`: the active world clauses whose census rules are not all held on the baseline.
- `roadmap phase0 check --repo <path> --from-ref <arc>`: the same over every input the arc's `refs/roadmap/<arc>`
  recorded, never the live files; only the corpus, census, obligation, debt, question, amendment, intake and vision
  rows (no forge, chain or tree rows).
- `roadmap corpus pin --repo <path> --commit <ref> --baseline <sha> --out <file>`: reads the guide and the rules
  registry committed at `--baseline` (the plan's baseline) and the corpus source at `--commit`, writes the pin to
  `--out` and prints `{pin, sha256}`; refused `corpus-invalid` (78). A pin made against any other baseline is drift
  at `start`.
- `roadmap issues --repo <path> [--out <file>]`: the canonical capture of open `roadmap:bug` and `roadmap:feedback`
  issues (stdout, or `--out` then `{out, sha256}`); refused `issue-policy-untrusted` (78); a forge failure exits 64.
- `roadmap brief --repo <path> [--json]`: the brief since the last committed ack (Markdown, or `{briefId, payload}`
  with `--json`). Exits 64 while no arc of the repo has published a snapshot.
- `roadmap brief --repo <path> --ack <briefId>`: acknowledge that brief: prints `{acked, commands}` (one queued `ack`
  per item it covers), or `{stale: {expected, actual}}` (78, nothing written) when the brief changed.
- `roadmap pr --repo <path> --arc <arc>`: push the completed arc's branch (a leased fast-forward, never `main`) and
  open or update its PR. Prints `{number, url, base, created, retargeted, needsRebase}`. Idempotent. Exits 64 for an arc
  whose ref holds no completion, or whose PR was closed unmerged.
- `roadmap chain status --repo <path>`: `{arcs: [{arc, previousArc, acked, pr}], k, unackedStarts, nextStart}`, oldest
  first. Exits 64 before any snapshot. `nextStart` answers whether a start chained on the head would pass `start`'s own
  chain rows that need no plan: `{allowed: true, reason: within-k, k, unacked}` or `{allowed: false, reason}` with reason
  `limit{k, unacked}`, `k-unset` or `previous-incomplete{arc}` (`unacked` counts that start). Read it; never compute K
  yourself. `k` is `chain.k` committed at the head arc's baseline, never the live file.
- `roadmap witness-check --lane-file <file>`: the implementer's command, named in its build prompt. Runs one
  required witness lane in the current worktree with fresh reporter output and checks every required test id: prints
  `{passed: true}` (exit 0) or `{missing, failed, malformed}` (78).
- `roadmap resume-arc --repo <path>`: when this repo's arc holds the host and its owner is dead, relaunches the
  supervisor as `start` would (prints its line and exit code). Otherwise `{resumed: false, reason}` (exit 0), reason
  `no-claim`, `other-repo`, `alive`, `complete`, `refused` or `already-resumed`. "Recovery" has the boot hook.
- `roadmap inputs export --repo <path> --arc <arc> --out <dir>`: read-only; writes the arc's current inputs into a
  new directory and prints `export.json` `{planRev, specRevs}` ("Recovery").

## Files

**Arc inputs** (yours, a directory per arc outside the product tree; every `PlanPath` is relative to the plan):
`plan.json`, `specs/<unit>.json`, the rulings ledger, `obligations.json` (with its census), and for a corpus arc
the pin (`corpus pin --out`), the Phase-0 record and the issue capture (`issues --out`). The executor keeps each by
hash at `start` and `apply`; editing them later changes nothing until `apply`. Beside the arcs' directories, the
operator log `skill-feedback.md` ("The operator log").

**In-tree `.roadmap/`** holds exactly: `contracts/`, `constraints.md`, `invariants.md` (with the `json roadmap-rules`
registry), `debt.md` (with the `json roadmap-debt` block), all rendered by the executor; and `config.json`,
`vision.json`, `corpus.md`, yours, committed. Anything else is a 0.x layout (`legacy-roadmap-dir`).

**`.roadmap/config.json`**: `{routing?: {profile?, seats?, classes?}, chain?: {k}}`; unknown keys refused; read at
`start`. `routing.seats` overrides the class of a seat; `routing.classes` rebinds a class to `{backend, model,
effort}` and is the only place a model is named (ids in `executor/src/routing/models.ts`).

**Run dir** `$(git rev-parse --path-format=absolute --git-common-dir)/roadmap-runtime/<arc>/`. Read, never write:

- `needs-user/<id>.json`: `summary, reason, subject, recommendation, options[{id, label}], evidence[]`;
  `<id>.ack.json` once acknowledged.
- `commands/incoming/<id>.json`, `commands/receipts/<id>.{accepted,applied,rejected}.json`.
- `heartbeat.json`: every 10 s; older than 5 minutes means the executor is dead or wedged.
- `inv/<seq>-<ordinal>/`: one invocation: `stdout`, `stderr`, `exit.json`, `result.json`.
- `status.rejection.json`: the last refused start's rows.
- `corpus/<pinSha8>/`: the pinned corpus, read-only, as judges read it.

**Repo-wide** under the git common dir: `roadmap/acks/` (the brief ack log, write-once) and `roadmap/corpus/`
(the CLI's clone of a `checkout` corpus). **Host dir** `/var/tmp/roadmap/`: the host lock, supervisor logs,
residues.

## The corpus guide

`.roadmap/corpus.md`: prose for the agent that curates the corpus (where it lives, how to reach it, the
standards), plus exactly one fenced block with the info string `json roadmap-corpus`:

```json roadmap-corpus
{ "schema": "roadmap/corpus-guide-m4",
  "source": { "kind": "same-repo", "root": "docs/corpus" },
  "include": ["**/*.md"],
  "vision": "vision.md" }
```

`source` is one of `same-repo{root}`, `other-repo{path (absolute), root}` or `checkout{remote, root}`; `include`
patterns and `vision` are relative to `root`. A rules block, in any included `.md` file but the vision document:

````markdown
```rules
T-12: A berth booking never overlaps another booking of the same berth.
T-13: A cancelled booking frees its berth at once.
```
````

## Recovery

- **Inputs.** `roadmap inputs export --repo <path> --arc <arc> --out <dir>` writes the inputs in force from the run
  dir's kept copies: the plan, every spec at its current rev (machine and plan-check patches included), the rulings
  ledger and sidecars, the obligations, and for a corpus arc the pin, the Phase-0 record and the issue capture. A file
  beside the plan keeps its path relative to the plan's directory; a file in the product repo (the vision record)
  goes under `repo/` at its repo path. The corpus guide is not exported (it is the baseline's). Edit the export in
  place of your inputs, then `roadmap apply --expect-rev <n>` with `n` = `export.json`'s `planRev`.
- **Boot hook.** A devcontainer restarts with no executor. `roadmap resume-arc --repo <path>` relaunches a dead
  owner's supervisor and does nothing otherwise, so it is safe at every boot:
  `"postStartCommand": "<plugin root>/executor/bin/roadmap resume-arc --repo <product repo>"` in
  `.devcontainer/devcontainer.json` (the owner's file: ask before adding it).

## The operator log

`<repo>/../roadmap-inputs/skill-feedback.md`, outside the product repo, append-only: one entry per intervention
(SKILL.md "Supervising the executor"). The heading names the entry's number (consecutive from 1), the time, the arc
and the one lever from the closed list; four bullets follow, each on one line and none empty.

```operator-log
## OP-1 2026-10-06T14:05:00Z arc=cancel-texts lever=pause
- symptom: unit notice sat in lane notice-unit for 41 minutes against a lanes median of 3, printing the same retry line.
- evidence: status units[notice].running.lane {id: notice-unit, set: spec, inv: cancel-texts/412#1}; no event after seq 1530.
- outcome: paused and resumed notice; the next attempt reused the passed lanes and notice-unit passed in 2 minutes.
- executor change: a lane repeating one output line far past its median could be killed and rerun by the executor.
```

## status

One object. `run{state, owner{state, generation, pid}, heartbeatAt}`; `state` is `running`, `draining`
(admissions closed), `held` (a pause, an interrupted stage or a parked backend), `parked` (a blocking needs-user
waits on you), `blocked` (work remains and nothing can move), `complete`, `refused` or `no-owner`.

- `needsUser[{id, reason, blocking}]`: unacknowledged items, host-level `sup-*` and `host-*` included.
- `plan{rev, planSha256}`; `routing{profile, rev, seats, sources, bindings}` (classes, never models).
- `units[]`: `unit, stage, status, attempts, chargeableFailures, risk, seat{role, tier}, state, waitingFor, holds,
  priority{priority, origin, waitStartSeq, bypassMerges, promoted}, park, lineage, supersededBy, buildTier, running,
  failures`. `state` is `running`, `preparing`, `ready`, `waiting`, `awaiting-admission`, `held`, `blocked`,
  `parked`, `merged`, `cut` or `superseded`. `waitingFor{deps, edges, resources, envBlocked, admission, drainFor}`;
  `admission` holds `known-defect{id, fixUnit}` while a known defect holds the unit at prepare. `running{stage,
  attempt, elapsed (ms), deadline, resources, lane}`, `lane{id, set: spec|suite|journey|mutant, inv, startedAt}` the
  lane run open now. `failures[{stage, attempt, lane, class: red|flaky|repeat, hostSuspected}]`: `hostSuspected`
  `{signatures, busy}` names the host failure signatures the output matched and whether the host was busy, or null.
  `park{class: retryable|operator, kind, targets, outstanding, nextProbeAt, escalateAt}`: a retryable park recovers
  by itself once its probes pass.
- `edges[]` (`after{unit, on, effective, met}`, `contingent{unit, edge, condition, resolved}`), `runOnly`.
- `commands{pending[{id, type}], receipts}` (the last 10 terminal receipts).
- `spend{byRole, byModel{models, unresolvedRevs}, byJob, bySmoke}`: token totals; `byModel` is the only place
  `status` names a model.
- `host{containment, resources, pools, queue, probes, backends, log{bytes, events, foldMs, compactionDue}}`,
  `parkedBackends`, `rejection`.
- `timings[{stage, count, p50Ms, maxMs}]`: completed attempts per stage.
- Holistic arcs (`holistic: true`): `target` (cut line, next milestone, critical path, obligation counts),
  `nowTrue`, `notYetTrue` (with `blockingUnits` and `reason`: `supervision`, `host`, `waiting-dep`, `code`,
  `spec`), `waived`, `deferred`, `vision` (clauses, questions, `advances`, `coverage`), `divergences`,
  `decisionsSince`, `convergence{k, counter, since, open}`, `findings{active, metrics}`, `audit`, `owed`,
  `completion{planRev, head, active, sealed, notSealed, unmet}`, `holds` (arc-wide admission holds: `baseline`,
  `pack-review`, `issue-policy-untrusted`), `amendments[{id, source, rules, proposal, why}]`.
- Corpus arcs also (null otherwise): `packReview{state: none|running|due|held|clear, reviews[{job, planRev, key,
  outcome, blocking, notes, needsUser, superseded}]}`, `corpus{pinSha256, source{kind, commit, root}, files,
  rules{active, retired, highWater}, phase0Sha256}`, `census{rules[{rule, state, held}], counts, heldPct}`,
  `debt{banked, ledger}`, `issues{lastCapture, intake}`, `chain{arcs, k, unackedStarts, nextStart, position}` (the
  next start after this arc). `status` reads the repo config the arc's revision recorded (routing) and the one committed
  at its baseline (K), never the live `.roadmap/config.json`.
- Every arc: `knownDefects[{id, match, fixUnit, fixMerged, holds}]` (the units each holds at prepare now);
  `checkpointWaits[{job, waitingFor, line}]`, a checkpoint rejected `busy` waiting for "<unit> <stage> boundary".
- Corpus arcs (empty otherwise): `admits[{seq, job, index, unit, class: repair|oversight|opportunity, clauses,
  followUp}]`; `opportunities[{id, clauses, units, followUps, spentUsd, overrun[{job, index}]}]`; `drift[{unit, job,
  class, merged, findings[{id, severity, clauses, claim}]}]`, per merged unit admitted as repair or oversight, the
  findings on its merge whose clauses lie wholly outside the slice and the opportunities' clauses.

## The brief

`roadmap brief --repo <path> --json` prints `{briefId, payload}`. The payload (`roadmap/brief-m4`) holds no clock; `briefId` is
the first 16 hex of its sha256, so any change (forge state included) is a new id.

- `coverage[{arc, snapshotCommit, highWater}]`: how far each chained arc's ref is covered; the next brief starts
  there.
- `items[{arc, id}]`: the open non-blocking `divergence-digest` and `convergence-bound` items an ack acknowledges.
- `chain{position, k, unackedStarts, nextStart}`, as `chain status` has them; the Markdown's `next start:` line.
- `arcs[]`, per chained arc: `slice{advances, why}` (the arc's Phase-0 slice in force, null without a record; you pick it,
  the owner sees it here afterwards), `divergences`, `digests`, `decisions`, `curation`, `corpusDivergences`,
  `debt{banked, dispositioned}`, `intake` (`job` null for Phase 0), `questions`, `amendments`, `packReviewNotes`,
  `census{held, obligationRules, outOfSlice, untestable, prodOnly}` (`% held` = held / obligationRules), `timings`
  (the attempts completed since the last ack), `pr` (`pr{number, url, state, base, needsRebase}`, `none` or
  `unavailable{reason}`); corpus arcs also `admits` (classified since the last ack), `opportunities` and the
  non-zero `drift` lines, and an amendment a converted admit made names that admit.

The brief reads only the verified snapshot refs: an arc joins it with its first snapshot (its first fast-forward
or docs publication), and anything not yet published to the ref is not in it.

## watch

`{"event":"needs-user", id, blocking, reason, subject, summary}` for every raised item, blocking or not;
`{"event":"ack", id, command, choice}`; `{"event":"superseded", id}` for an item a later pack review superseded;
`{"event":"owner", state, generation, pid}`; `{"event":"units", run,
units: {<unit>: <state>}}` with compact states (`running:build#3`, `waiting:deps=u1`, `parked:retryable`,
`awaiting-admission:known-defect`, `merged`). Plain `watch` streams every change. `watch --actionable` prints only
the wakes: a `needs-user` line for an item not seen before and not already acknowledged or superseded, the `units` line of `run`
reaching `complete`, `refused` or `no-owner` (once each) or newly `held`, `blocked` or `draining`, and
`{"event":"stall","quietMin":30}` after 30 minutes with no change. Owner, ack, superseded and routine `units` lines are
dropped. `status.needsUser` lists open items only: a superseded one shows under `packReview` alone. A
fresh `--actionable` process starts with nothing seen: it prints the open items and a terminal or constrained run
again.

## Refusals

`start` (exit 78; rows in its output and `status.rejection`) and `phase0 check` share the rows below; exit 75 is
`host-busy`.

| Row | Means | Fix |
|---|---|---|
| `legacy-roadmap-dir` | `.roadmap/` holds files outside the 1.0 set | move them out; 1.0 never converts |
| `worktree-root-unusable` | `worktreeRoot` on tmpfs or not writable | another `worktreeRoot` |
| `plan-invalid{problem}` | schema, unknown spec path, integration branch missing or in `roadmap/<arc>/`, baseline not an ancestor, unknown resource or cite, a Phase-0 entry naming something absent | fix the input the problem names |
| `spec-lane-unrunnable` | a lane, probe or teardown command cannot run here | fix the spec or the host |
| `unsupported-routing` | a seat's class binds an unsupported triple | fix the routing layer it names |
| `plan-change-refused{reasons}` | the files differ from the plan in force in a way `apply` refuses | undo that edit |
| `backend-smoke` | a backend's smoke failed | fix that backend's auth or sandbox |
| `undispositioned-residue` | a residue from earlier work | `roadmap sweep`, or answer its needs-user |
| `previous-arc-unreconciled`, `recovery-holder-dead`, `owner-mismatch`, `log-corrupt`, `containment-mode-changed` | host-level | read `status` and the needs-user; never clear host files by hand |
| `holistic-needs-corpus` | a fresh holistic plan names `architectureDoc` | make it a corpus arc |
| `vision-unconfirmed{ref, expected, actual}` | `.roadmap/vision.json` unconfirmed, or its `corpus:` hash differs from the pinned vision document (`actual` null: no such pinned file) | run the `vision` skill; commit; re-pin |
| `corpus-invalid{problems}` | `pin-drift`, `rule-reused{id}`, `rule-retired-reappears{id}`, `rules-in-vision`, `guide-missing`, `source-unreadable{detail}`, `source-remote-mismatch`, `scope-overlaps-corpus{unit}`, `contract-overlaps-corpus{path}` | re-pin after any corpus change; a new meaning takes a new id; no rules block in the vision document; scopes and contracts stay off corpus files |
| `phase0-invalid{problems}` | `census-incomplete{rules}`, `census-dangling{rules}`, `obligation-rule-unresolved{obligation}`, `debt-undispositioned{id}`, `debt-kept-twice-unasked{id}`, `amendment-undispositioned{id}`, `intake-missing{issue}`, `intake-unknown{issue}`, `intake-duplicate{issue}`, `capture-missing`, `capture-foreign{expected, actual}`, `question-reused{id}`, `spec-census-mismatch{unit, item, rule, state}` (a spec declares an obligation whose rule's census is not that obligation, or an acceptance clause or witness item names an `out-of-slice` rule; checked on every revision, so `apply` refuses it too) | complete the Phase-0 record or obligations; re-capture issues for this repo; align the spec with the census |
| `chain-invalid{problem}` | `limit{k, unacked}`, `baseline{previous-head-mismatch \| merge-commit \| parent-mismatch \| paths{paths}}`, `previous-incomplete{arc}`, `k-unset` | `limit`: stop (`k-limit`); `baseline`: one non-merge commit on the previous completed head, touching only `.roadmap/` inputs and corpus paths; `k-unset`: bootstrap K. `chain status` `nextStart` answers `limit`, `k-unset` and `previous-incomplete` before you compose the plan |
| `issue-policy-untrusted{visibility, policy}` | anyone can open issues | the owner restricts issue creation to collaborators or disables issues |
| `tree-uncommitted{paths}` | `.roadmap/{vision.json, corpus.md, config.json}` differ from `HEAD` | commit them |

**`apply` rejections** (in the receipt or `--dry-run`): every row above that applies to the edit, plus
`target-kind-changed` (an `architecture-doc` arc never becomes a corpus arc, nor the reverse), `chain-immutable`
(`chain` is fixed at the first revision), and for known defects `known-defect-fix-unit` (the fixer is absent, its
lineage merged or cut, or the apply cuts a fixer an entry still names), `known-defect-lane` (no spec in force declares
the lane) and `known-defect-cycle` (the `after` edges plus the holds form a cycle, named). A re-entry whose scope
leaves its lineage's envelope is refused unless its spec cites an active ruling for it naming exactly the added
patterns. Priority, known-defect and plan-check-shape edits drain nothing.

## Needs-user reasons

Blocking unless noted. Read the item file before acting.

- Unit parks (`escalation`, `refusal`, `chargeable-bound`, `malformed`, `process-fault`, `salvage-failed`,
  `empty-diff`, `build-lost`, `candidate-red`, `base-red`, `lane-blocked`, `occupancy-unlabelled`, `residue`,
  `routing-changed`, `respec-second`, `steered`, `reconcile-park`, `foreign-ref-move`, `recovery-required`): SKILL.md
  "Handling parks".
- `usage-limit`: `resume --backend <name>` once the limit resets.
- Host-level (`supervisor-crash-limit`, `log-corrupt`, `owner-mismatch`, `recovery-holder-dead`,
  `previous-arc-unreconciled`): SKILL.md "Handling parks"; never edit host files. `supervisor-crash-limit` is an
  executor defect: report it and stop the session, never patch the plugin.
- Non-blocking: `park-escalated`, `env-blocked` (a retryable park probing for long), `bundle-request` (`--choice
  apply|reject`; one the executor cannot apply: `--choice acknowledge|decline`; still unanswered when only the
  close-out is left, the executor declines it, a corpus arc's with an amendment `source: request`, and a later ack is
  rejected), `convergence-bound`, `convergence-identity`, `audit-owed`, `divergence-digest` (the brief ack
  acknowledges the digest and convergence-bound items).
- At the close-out of a corpus arc, every open P2 or P3 finding that names no obligation is banked as
  `finding-deferred` debt and ruled deferred (`by: code{close-out}`): the next Phase 0 dispositions it. A finding over
  an obligation never banks.
- Holistic, blocking: `obligation-baseline` (a must-hold obligation not held at the baseline: fix the obligation
  or the plan), `finding-p1-escalated`, `new-finding-draining`, `not-reproduced`, `owner-request` (an owner-only act:
  ask the owner).
- Corpus arcs, blocking: `pack-review` (fix the pack with `apply`, or ack), `issue-policy-untrusted` (raised at a
  checkpoint capture: admission and the checkpoint wait; the owner fixes the policy, then ack; the next capture
  checks again).

## Schemas

`executor/SCHEMAS.md`, by section:

- "Input contract": `plan.json`, `ToolCommand`, the rulings ledger.
- "`spec.json` M1 subset and `SpecPatch`": unit specs.
- "Plan in force": what `apply` accepts per edit.
- "Routing types": seats, classes, routing layers.
- "M2: scheduling, resources, parks": `after`, contingent edges, pools.
- "M3: the holistic layer": `holistic`, obligations, witnesses, the vision record, ruling sidecars, lenses, the
  checkpoint.
- "M4a: corpus, debt, forge, brief, chaining": the corpus guide, the pin, rules registry, obligations with census,
  the Phase-0 record, the issue capture, debt, the brief and the ack log.
- "M4a rev 3: the run-10 batch": `knownDefects`, `priority`, `planCheck`, spec `witnesses` and lane `inputs`, arc
  lane `testPaths`, admit classes and conversions, the witness lane file.
