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
  from disk. Without `--profile`, `.roadmap/config.json` chooses, else `default`. On an arc with a plan in force the
  plan file is your edit: its files are rebased onto the files in force and the startup rows check the result, the
  ledger in force included (2026-10-21; 1.0.0-dev.16). Prints `{"kind":"ready",…}` (exit 0)
  once the executor passed every startup row; the run goes on. The backend smoke runs after `ready`: a smoke refusal
  shows in `status.rejection` and the run ends `refused`. Exit 78 with the rows, 75 host busy, 70 `failed` or
  `timeout` (read `status` and the supervisor logs in the host dir before starting again). Waits 240 s by default.
- `roadmap status`: the run as one JSON object ("status" below).
- `roadmap watch [--actionable [--heartbeat-min <n>] [--from <seq>]]`: one JSON line per event until killed, each with
  its `seq`; `--actionable` prints only the wakes, and `--from` replays the wakes since that seq. Wait on one
  `roadmap watch --actionable` per arc, started in the background into a file that a Monitor tails, and started again
  with `--from` the last line's seq (SKILL.md "Running an arc"; "watch" below).
- `roadmap stop`: park everything, tear down, release the host lock.
- `roadmap pause (<unit> | --all)`: kill and tear down; commits and worktree stay as left; the unit holds at its stage.
- `roadmap resume [<unit> | --backend claude|codex]`: no argument clears pauses and holds (a held build continues
  its session). `<unit>` re-opens a unit parked at plan-check or gate after a spec revision was applied, or one
  parked `routing-changed` once its seat is restored. `--backend` clears a usage-limit park after a passing smoke.
- `roadmap ack <needs-user-id> [--choice <option-id>]`: answer an item; `--choice` names one of its `options`.
- `roadmap sweep [--resource <name>]`: run the recorded teardown of undispositioned residues.
- `roadmap apply [--base <file>] [--dry-run] [--ruling <file>] [--vision-edit]`: put the edited plan, specs and other
  revisioned inputs in force at the next stage boundary, rebased onto the plan in force (merged per file from the
  edit's base: the files you last applied, or with `--base` an `inputs export`'s `export.json`; a value you and the
  executor both changed is a `conflict` naming the file and JSON path). Each `--ruling` (repeatable) is a ruling sidecar
  validated as `rule` validates it and landed with the edits as one revision; an id `"C-?"` takes the ledger's next C-n.
  `--vision-edit` declares a vision edit: without it an apply whose rebased vision differs from the vision in force
  (you changed the vision file) is refused `vision-leak` (a next-arc draft belongs in `_next/`). In a corpus arc a vision
  edit is published onto the integration branch by the apply's docs publication: `.roadmap/vision.json`, and with a
  `same-repo` re-pin the changed vision document, as committed on the owner's checkout (commit them there, never on the
  integration branch, and never move the integration branch by hand). `--dry-run` always
  exits 0 and prints `kind`: `rejected{reasons}`, `unchanged{rev}` or `accepted{rev, nextRev, changes, smoke,
  advisories, numbered}`; it queues nothing.
  `advisories` (also `advisory:` lines in the applied receipt) are `scope-references-outside{unit, removed, referrers}`:
  files outside a unit's scope that still name what its spec `removes`; `derived-unregenerated{outputs, units}`: a
  `derived` entry with no `regenerate` whose outputs those units take in; and `milestone-unit-before-design{milestone,
  unit, design}`: a milestone unit that does not run after its milestone's design unit. They never refuse. A revision
  that changes the plan or the vision cancels a checkpoint deciding on the earlier one (rejected `stale`); its trigger
  is decided again on your revision.
- `roadmap resolve-edge <edge> --evidence <text>`: a contingent edge's condition is met, on your evidence.
- `roadmap run-only (<unit>... | --clear)`: limit admission to these units, or lift the limit.
- `roadmap rule <record.json>`: land a ruling (a `roadmap/ruling-m3` sidecar; id `"C-?"` takes the ledger's next C-n,
  named in the receipt) through a docs publication. Your ledger file is never written: `inputs export` shows the ledger
  in force.
- `roadmap reverse <D-n>`: a compensating revision restoring what divergence D-n's act changed; rejected when a later
  revision changed it again (use `apply`).
- `roadmap steer <unit> --brief <file> --budget <min> [--class efficient|frontier|summit] [--resume]`: one uncharged
  implementer round for a parked or `preparing` unit, then salvage, lanes and gate. It parks again unless green and
  `--resume`. `--class` seats that class at the unit's build tier.
- `roadmap merge-in <unit>`: merge the integration tip into a unit's branch (clean merges only); it re-enters at lanes.
- `roadmap scope accept|reject <unit> --reason <text> [--repo <path> --arc <arc>]`: queued (scope the unit). Your decision on
  the scope growth a unit's plan-check proposed, or the path salvage reverted on its last two rounds (its `scope-growth`
  item). `accept` lands it as one ruled revision (a new
  ruling naming the patterns, the unit's plan and spec scope widened, in force only) and the unit re-opens at
  plan-check on it; a revision the classifier refuses is rejected with every reason, and the unit stays held. `reject`
  keeps the scope: the plan-check runs again, told what you rejected, and decides within the scope. Acknowledges the
  item. Rejected for a unit not held for a proposal.
- `roadmap audit [--lens <lenses>]`: request an audit (holistic arcs; lenses comma-separated, within the arc's set:
  `invariants`, `drift`, `vacuity`, `vision`). An audit reviews each lens's whole outstanding range: one too large
  for a single lens call is reviewed in chunks by publication within that audit, so no range needs a smaller audit.
- `roadmap close-admissions`: latch `draining`; checkpoint admissions become requests to you; an `apply` adding a
  unit reopens.
- `roadmap demo up|down|hold|release`: the owner's act on the demo (milestone arcs; queued, no scope). `hold` freezes
  promotion, so the demo keeps its version and data; `release` resumes it and promotes the latest settled milestone at
  once when it is newer; `down` stops the instance (its checkout and ports are kept); `up` starts it again, and retries a
  version whose bring-up failed. Rejected: `hold` while held, `release` while not held, `down` while down. Acts apply
  through the arc's executor: with no live executor they wait in the queue for its next start.
- `roadmap gc --repo <path> [--keep <K>] [--dry-run]`: not queued. Under the host lock, prunes sealed arcs (raw
  evidence; run dirs beyond K, which the ref restores). Prints its report, or `{refused}` with exit 75 or 78.
- `roadmap --version`

### Host acts

Not queued, no host lock, no run needed. Run them any time, a running arc included.

- `roadmap phase0 check --repo <path> --plan <plan.json>`: read-only, the rows a fresh `start` runs on its inputs:
  the `.roadmap/` layout, `plan-invalid`, routing, lanes, `holistic-needs-corpus`, `milestones-need-holistic`,
  `walk-tools-missing`, and every corpus, Phase-0,
  vision, issue-policy, chain and `tree-uncommitted` row (not the host, residue or smoke rows). Prints `{rows, sliceCandidates, advisories}`; exit 0 with no rows, else 78.
  `advisories` never refuse: `scope-references-outside{unit, removed, referrers}`, the files outside a unit's scope that
  still name something its spec `removes` (searched at the integration tip, or the baseline before it exists), and
  `derived-unregenerated{outputs, units}`, a `derived` entry declaring no `regenerate` that a live unit takes in, and
  `milestone-unit-before-design{milestone, unit, design}`, a live milestone unit that does not run after (transitively)
  its milestone's design unit.
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
- `roadmap pr --repo <path> --arc <arc> [--supersede-previous]`: push the completed arc's branch (a leased fast-forward,
  never `main`) and open or update its PR. Prints `{number, url, base, created, retargeted, needsRebase, supersedes}`.
  Idempotent; a reopened arc's new completion fast-forwards the same PR. `--supersede-previous`: this arc carries
  fixes the previous arc's still-open PR needed, so its PR supersedes that one: it targets the previous PR's base, its
  body opens with `Supersedes <url>`, and the previous PR is closed with a comment naming it (`supersedes` is that
  URL; later runs keep it, with or without the flag). Exits 64 for an arc whose ref holds no completion, whose PR was
  closed unmerged, or for `--supersede-previous` with no previous arc, a merged previous PR or none open.
- `roadmap chain status --repo <path>`: `{arcs: [{arc, previousArc, acked, pr}], k, unackedStarts, nextStart}`, oldest
  first. Exits 64 before any snapshot. `nextStart` answers whether a start chained on the head would pass `start`'s own
  chain rows that need no plan: `{allowed: true, reason: within-k, k, unacked}` or `{allowed: false, reason}` with reason
  `limit{k, unacked}`, `k-unset` or `previous-incomplete{arc}` (`unacked` counts that start). Read it; never compute K
  yourself. `k` is `chain.k` committed at the head arc's baseline, never the live file. `answers` lists the owner's
  recorded answers not yet applied, as `status.answers`.
- `roadmap answer <P-n> --repo <path> --text <text> [--arc <arc>]`: record the owner's answer to `P-n` at once, live
  arc or not. `P-n` must be open in the Phase-0 record in force of the newest arc that has one (or of `--arc`).
  Prints `{recorded: {schema, question, k, answer, at, arc}}`; the same text as the answer in force prints
  `{unchanged}` and writes nothing; another text supersedes it as the next `k`. Refused (78): `no-phase0-record{arc}`,
  `question-unknown{question, arc}`, `question-not-open{question, arc}`. The answer log is
  `$(git rev-parse --git-common-dir)/roadmap/answers/<P-n>.<k>.json`, write-once.
- `roadmap witness-check --lane-file <file>`: the implementer's command, named in its build prompt. Runs one
  required witness lane in the current worktree with fresh reporter output and checks every required test id: prints
  `{passed: true}` (exit 0) or `{missing, failed, malformed}` (78).
- `roadmap resume-arc --repo <path>`: when this repo's arc holds the host and its owner is dead, relaunches the
  supervisor as `start` would (prints its line and exit code). Otherwise `{resumed: false, reason}` (exit 0), reason
  `no-claim`, `other-repo`, `alive`, `refused` or `already-resumed`. A claim on a `complete` arc is a reopening start
  that died, and is relaunched. "Recovery" has the boot hook.
- `roadmap inputs export --repo <path> --arc <arc> --out <dir>`: read-only; writes the arc's current inputs into a
  new directory and prints `export.json` `{planRev, specRevs, base}` ("Recovery").
- `roadmap flow accept|reject <proposal> --reason <text> [--repo <path> --arc <arc>]`: queued (scope none). Your
  decision on flow proposal `flow-<n>.0` with a one-line reason; acknowledges its `flow-proposal` or `flow-host` item.
  Idempotent by proposal; refused (78) for a proposal no run made, one code's checks dropped (the reason is printed), or
  one already decided the other way. A reject remembers its `(station, lever, target)`: no run proposes it again.
- `roadmap flow request --reason <text> [--repo <path> --arc <arc>]`: queued (scope none). A flow run once the judgment track
  is free; it bypasses the 120-minute cooldown once per cooldown window (`status.flow.next.bypass`).
- `roadmap flow given --repo <path> --lever <lever> --note <text>`: a host act, not queued. Declares that `<lever>`
  (`concurrency`, `resource-pool`, `suite-lane`, `sequence`, `build-class`, `host`) cannot be tuned on this host;
  write-once in `$(git rev-parse --git-common-dir)/roadmap/givens.json` under this host's fingerprint (`stale`, and not
  enforced, on another host). Prints `{given: {id: G-n, lever, note, fingerprint, at}}`; the same lever and note print
  the entry already there.

## Files

**Arc inputs** (yours, a directory per arc outside the product tree; every `PlanPath` is relative to the plan):
`plan.json`, `specs/<unit>.json`, the rulings ledger, `obligations.json` (with its census), and for a corpus arc
the pin (`corpus pin --out`), the Phase-0 record and the issue capture (`issues --out`). The executor keeps each by
hash at `start` and `apply`; editing them later changes nothing until `apply`. Beside the arcs' directories, the
operator log `skill-feedback.md` ("The operator log") and the next-arc staging dir `_next/`: `vision.md` (the owner's
working draft of the next vision) and `notes.md` (work for later, deferred rulings, ideas). The executor never reads
`_next/`; the Chaining step reads it and hands it to the next arc's directory.

**In-tree `.roadmap/`** holds exactly: `contracts/`, `constraints.md`, `invariants.md` (with the `json roadmap-rules`
registry), `debt.md` (with the `json roadmap-debt` block), all rendered by the executor; and `config.json`,
`vision.json`, `corpus.md`, yours, committed. Anything else is a 0.x layout (`legacy-roadmap-dir`).

**`.roadmap/config.json`**: `{routing?: {profile?, seats?, classes?}, chain?: {k}, flow?: {givens: [{lever, note}]},
walkthrough?: {mcp: {<name>: {command, args?, env?}}}, systemsMap?: {systems: {<name>: {paths, tests?, dependsOn?}},
shared?: [{paths, dependents}], contracts?: {<path>: [<system>]}, docs?: [<glob>]}}`; unknown keys refused; read at
`start`. `systemsMap` names every system a lane lists (`docs` is the docs class, never a system name); every revision
records the map the executor read, so an edit reaches the arc at the next `apply` after a restart. `walkthrough.mcp` names
the MCP servers a walkthrough session gets (and only those), with `{evidence}` and `{viewport}` substituted in `args` and
`env`; absent, no browser drive, so a `browser` journey is refused `walk-tools-missing`. `flow.givens` are the owner's repo givens, never yours to add. `routing.seats` overrides the class of a seat; `routing.classes` rebinds a class to `{backend, model,
effort}` and is the only place a model is named (ids in `executor/src/routing/models.ts`). A rebind applies at every seat
that names the class, judgment seats included: a Codex triple there is refused `unsupported-routing{codex-judgment}`, so
move those judgment seats to another class in `routing.seats` first. Built-in seats, both profiles: `efficient`
builds at every risk and runs the lenses and flow; `frontier` plan-checks and gates at every risk and runs the pack review;
`summit` holds both escalation seats and the checkpoint. A Claude build consults the frontier model as its advisor (`--advisor`) at its
own decision points; that spend shows under `frontier` in `spend.byClass`. A class binds a build
model and a judgment model (always Claude): `efficient` judges on Claude under both profiles, even where it builds on Codex.
`economy` is judgment-only: no build seat may name it, in `routing.seats`, a plan, `route` or `steer --class`. The one
built-in seat on it is the `scaffold` role's (1.0.0-dev.17, `scaffold.low|med|high`: the writer of a new system's skeleton a
plan-check decides; in force only in arcs started on dev.17 or later); reach economy elsewhere through
`routing.seats`, a plan or `route`. Plan-check acts (a shell and web search in its own checkouts) at every seat.

**`walkthrough.mcp`** names the stdio MCP servers a walk session gets, exactly these (`--strict-mcp-config`); the
environment provides them, the executor ships no browser. Code substitutes `{evidence}` (the session's evidence dir) and
`{viewport}` (`1280x800`) in `args` and `env` values. Without it a milestone with a `browser` journey is refused
`walk-tools-missing{mcp-unconfigured}`; `phase0 check` and `start` start each server and do the MCP handshake
(`mcp-unconnected{server, detail}` when it fails). The expected server is Playwright MCP:

```json
{"walkthrough": {"mcp": {"playwright": {"command": "playwright-mcp", "args": ["--headless", "--isolated",
  "--browser", "chromium", "--output-dir", "{evidence}", "--viewport-size", "{viewport}"]}}}}
```

It defaults to the Chrome channel, so pass `--browser chromium` where only Playwright's Chromium is installed (`npx
playwright install chromium`). It refuses `file:` URLs, so the bring-up serves pages over HTTP. A screenshot without a
`filename` lands in `--output-dir`; a relative `filename` resolves against the session's cwd (the checkout), so a named
one is absolute (checked on 0.0.83). Install it in the project's devcontainer, pinned (`@playwright/mcp`).

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
  goes under `repo/` at its repo path. The corpus guide is not exported (it is the baseline's). `export.json`'s `base`
  is the manifest of the exported files. The executor never writes your input files, so this is the one way to get the
  files in force: sync the export over your inputs, edit, then `roadmap apply --base <dir>/export.json`; the apply
  rebases your edit onto whatever the executor did since the export.
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
  failures, gate`. `gate{attempt, decision, findings[{severity: blocking|note|pre-existing, path, text, contractRef}],
  unreviewed[{path, reason}]}` is the unit's latest gate answer, or null before one: a `pre-existing` finding is a real
  defect already at the base (never blocking); `unreviewed` is what the gate says it did not review (null on an answer
  from dev.11: unknown), recorded and never enforced. A gate whose diff is too large for its attachment (files left out for
  size) sits at least at the high seat whatever the unit's risk (`seat` shows it once the gate has started), and its answer
  carries a cluster map that code checks covers every changed path exactly once; a file in a cluster counts as reviewed. `state` is `running`, `preparing`, `ready`, `waiting`, `awaiting-admission`, `held`, `blocked`,
  `parked`, `merged`, `cut` or `superseded`. `waitingFor{deps, edges, resources, envBlocked, admission, drainFor}`;
  `admission` holds `known-defect{id, fixUnit}` while a known defect holds the unit at prepare. `running{stage,
  attempt, elapsed (ms), deadline, resources, lane}`, `lane{id, set: spec|suite|journey|mutant, inv, startedAt}` the
  lane run open now. `failures[{ref, stage, attempt, lane, class: red|flaky|repeat, hostSuspected}]`: `hostSuspected`
  `{signatures, busy}` names the host failure signatures the output matched and whether the host was busy, or null;
  `ref` (`<unit>/lanes#<attempt>/<lane>`) is how a re-entry's `fixes` cites it (a park or another failure outcome is
  cited as `<unit>/<stage>#<attempt>`).
  `park{class: retryable|operator, kind, targets, outstanding, nextProbeAt, escalateAt}`: a retryable park recovers
  by itself once its probes pass.
- `edges[]` (`after{unit, on, effective, met}`, `contingent{unit, edge, condition, resolved}`), `runOnly`.
- `commands{pending[{id, type}], receipts}` (the last 10 terminal receipts).
- `spend{byRole, byModel{models, unresolvedRevs}, byClass{classes, unresolvedRevs}, byJob, bySmoke}`: token totals and
  list-price cost. A Claude call's totals include its subagents'; `byClass` splits spend by class (`efficient`, `frontier`,
  `summit`, `economy`): each seat's own share on its class, subagent spend on the subagent model's class. `byModel` counts each seat's own share and is the only place `status` names a model.
- `host{containment, resources, pools, queue, probes, backends, log{bytes, events, foldMs, compactionDue}}`,
  `parkedBackends`, `rejection`.
- `timings[{stage, count, p50Ms, maxMs}]`: completed attempts per stage.
- `answers[{question, k, answer, at, arc, line}]`: the owner's recorded answers no Phase-0 record applies yet (the
  newest arc carrying the question does not mark it `answered` with that text; a live arc's revision in force counts
  at once). Apply each now.
- Holistic arcs (`holistic: true`): `target` (cut line, next milestone, critical path, obligation counts),
  `nowTrue`, `notYetTrue` (with `blockingUnits`, `reason`: `supervision`, `host`, `waiting-dep`, `code`,
  `witness` (its lane has not run on the head yet; an audit, checkpoint or close-out runs every lane), `spec`; and
  `lastObserved{treeSha, verdict, evidence}|null` for a `not-covered` one: its newest observation on an earlier tree
  of the head's history, context only), `waived`, `deferred`, `vision` (clauses, questions, `advances`, `coverage`), `divergences`,
  `decisionsSince` (rulings, bundles, patches, re-entries, cuts, steers, divergences, reversals, and `checkpoint-skipped`:
  an audit that found nothing new, so no checkpoint ran), `convergence{k, counter, since, open}`, `findings{active, metrics}`, `audit`, `owed`,
  `completion{planRev, head, active, sealed, notSealed, unmet}`, `holds` (arc-wide admission holds: `baseline`,
  `pack-review`, `issue-policy-untrusted`), `amendments[{id, source, rules, proposal, why}]`.
- Corpus arcs also (null otherwise): `packReview{state: none|running|due|held|clear, reviews[{job, planRev, key,
  outcome, blocking, notes, needsUser, superseded}]}`, `corpus{pinSha256, source{kind, commit, root}, files,
  rules{active, retired, highWater}, phase0Sha256}`, `census{rules[{rule, state, held}], counts, heldPct, lastHeld}` (`held`/`heldPct` on the head alone,
  so they drop after a merge until the next all-lanes run; `lastHeld` also counts rules held at their last observation),
  `debt{banked, ledger}`, `issues{lastCapture, intake}`, `chain{arcs, k, unackedStarts, nextStart, position}` (the
  next start after this arc). `status` reads the repo config the arc's revision recorded (routing) and the one committed
  at its baseline (K), never the live `.roadmap/config.json`.
- Every arc: `flow` (null before a start): `{state: off-dev7}` for an arc an older release started, else `{state: on,
  constraint, chart, accounting, window, verdicts, pending, givens, rulerChanged, pressure, next}`:
  - `constraint{station, internal, component}`: code's constraint over the last 10 merges, null before the first.
    `station` is `stage:<s>`, `slot:integration` (then `component` is its largest service part: `suite:<lane>`,
    `arc-lanes`, `candidate-rest`, `ff`, `snapshot`), `wait:finding` (`internal`, no lever targets it) or `host:cpu`
    (`internal`: those merges' mean cpu pressure, their launches' own cpu wait, is at or above the threshold; only load
    decreases or `host` advice there).
  - `chart{centre, ucl, mrBar, seed, recent[{unit, leadMin, zone}], inFlight[{unit, ageMin, zone}]}`: the XmR chart on
    log lead minutes, frozen for the arc; zones `green | yellow | red`; null until seeded (5 merges, or 5 points of
    earlier arcs on an equal host).
  - `accounting{tAdvances, tOther, tUnits, wip, oeUsdPerHour}`: diagnostic only, never a goal.
  - `window{proposal, lever, target, metric, openedAt, samples}`: the one change being judged, or null. `verdicts[{proposal,
    lever, target, verdict: improved | worse | no-effect | inconclusive}]`.
  - `pending[{proposal, line, phase: undecided | pending-proof | pending-apply}]`; `givens[]` (`host{id, lever, note,
    state: enforced | stale}` or `repo{lever, note}`); `rulerChanged[{command, rev, seq, at, paths, needsUser}]`.
  - `pressure{threshold, available}`: the saturation of cpu wait (0.5: a launch, a merge window or the host that waited
    for a cpu half its time or more) and whether the host reports it (Linux schedstat).
  - `next{running, due, cooldownUntil, bypass}`: the flow run in progress, the triggers due now (`host-pressure`: a unit
    held for host pressure since the last run), the cooldown's end and whether a request may still bypass it.
- Milestone arcs: `demo` (null before the first promotion): `{milestone, sha, held, up, since{milestones, tweaks, fixes},
  roughEdges, where, serving, failed}`. `where` is `{type: url, url, ports}` (the first serve entry's address and every
  stable port) or `{type: path, path}` (`<worktreeRoot>/demo/current/bin` for a product with nothing long-lived), null until
  the host's instance runs this arc's version. `serving` is the SHA running now (null while down or starting); `failed`
  `{sha, log}` the latest version that did not come up since the promotion (the old one kept serving; its walkthrough P1
  is in `findings`). `since` is against the promotion before; `roughEdges` the open walkthrough P2s.
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
- `answers[{schema, question, k, answer, at, arc}]`: the recorded answers not yet applied, as `status.answers`; the
  Markdown opens with them ("Owner answers to apply now").
- `arcs[]`, per chained arc: `slice{advances, why}` (the arc's Phase-0 slice in force, null without a record; you pick it,
  the owner sees it here afterwards), `divergences`, `digests`, `decisions`, `curation`, `corpusDivergences`,
  `debt{banked, dispositioned}`, `intake` (`job` null for Phase 0), `questions`, `amendments`, `packReviewNotes`,
  `census{held, obligationRules, outOfSlice, untestable, prodOnly}` (`% held` = held / obligationRules), `timings`
  (the attempts completed since the last ack), `pr` (`pr{number, url, state, base, needsRebase}`, `none` or
  `unavailable{reason}`); corpus arcs also `admits` (classified since the last ack), `opportunities` and the
  non-zero `drift` lines, and an amendment a converted admit made names that admit.
- `arcs[].flow` (null with the loop off), rendered lines: `constraint` (at the ref, null before a merge; `host:cpu`
  names the window's mean cpu pressure and the threshold), `accounting`
  (T/I/OE, diagnostic), and in the delta `verdicts`, `rulerChanges` (command revisions after the first admission that
  touched a ruler path), `hostAdvice` (`flow-host` proposals), and `dropped` (a lever the previous arc applied, with no
  worse verdict, that this arc's plan no longer carries). The Markdown's Flow section.

- `arcs[].demo` (null before the arc's first promotion): `{milestone, sha, held, up, since, roughEdges}` at the ref, the
  Markdown's Demo section. Where it runs is in `status.demo.where` only.

The brief reads only the verified snapshot refs: an arc joins it with its first snapshot (its first fast-forward
or docs publication), and anything not yet published to the ref is not in it.

## watch

`{"event":"needs-user", id, blocking, reason, subject, summary}` for every raised item, blocking or not;
`{"event":"ack", id, command, choice}`; `{"event":"superseded", id}` for an item a later pack review superseded;
`{"event":"answer", question, k, answer, at}` for each recorded owner answer no Phase-0 record applies yet (once per
`question` and `k`); `{"event":"owner", state, generation, pid}`; `{"event":"units", run,
units: {<unit>: <state>}}` with compact states (`running:build#3`, `waiting:deps=u1`, `parked:retryable`,
`awaiting-admission:known-defect`, `merged`). Plain `watch` streams every change. `watch --actionable` prints only
the wakes, the key transitions: a `needs-user` line for an item not seen before and not already acknowledged or
superseded; an `answer` line not seen before; the `units` line in which a unit is newly `merged` or newly parked (`parked:*`), in which `run` is newly
`held`, `blocked` or `draining`, or in which `run` reaches `complete`, `refused` or `no-owner` (once each). Plus a fixed
heartbeat, `{"event":"heartbeat","everyMin":<n>,"seq":<s>}`, every n minutes from the watch's start whatever happened
(`--heartbeat-min <n>`, a positive integer, default 30; only with `--actionable`). Owner, ack, superseded and every
other `units` line are dropped. `status.needsUser` lists open items only: a superseded one shows under `packReview`
alone. Every line carries `seq`, the event log's high-water when it was seen. A fresh `--actionable` process starts
with nothing seen: it prints the open items and a terminal or constrained run again, and takes its first view of the
units as the baseline (no unit wake for what already merged or parked). With `--from <seq>` (only with
`--actionable`) it starts from the log as it stood at that seq instead: a unit merged or parked since then wakes at
once, and an item raised by then counts as seen; a standing terminal or constrained run, an open `sup-*` or `host-*`
item and an unapplied answer are printed again. A seq past the log's end is refused.

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
| `plan-change-refused{reasons}` | the files differ from the plan in force in a way `apply` refuses, or in a way that needs a docs publication (rulings, obligations, a corpus arc's vision record), which only an `apply` runs; also (a fresh start, or any revision touching the unit) a lane's `evidenceGlobs` entry covering its unit's scope (named with lane and entry) | undo that edit; start on the plan in force, then `apply` it (`--vision-edit` for the vision); narrow the entry to the lane's outputs |
| `backend-smoke` | a backend's smoke failed | fix that backend's auth or sandbox |
| `undispositioned-residue` | a residue from earlier work | `roadmap sweep`, or answer its needs-user |
| `previous-arc-unreconciled`, `recovery-holder-dead`, `owner-mismatch`, `log-corrupt`, `containment-mode-changed` | host-level | read `status` and the needs-user; never clear host files by hand |
| `holistic-needs-corpus` | a fresh holistic plan names `architectureDoc` | make it a corpus arc |
| `milestones-need-holistic` | the plan has `milestones` but no `holistic` (also an `apply` adding them) | milestones need the holistic layer: make it a holistic (corpus) arc, or drop the milestones |
| `walk-tools-missing{milestone, problem}` | `program{step, argv0}`: a bring-up command's program is not installed (`step` `setup[i]`, `serve.<name>`, `seed[i]`); `mcp-unconfigured`: a `browser` journey and no `walkthrough.mcp`; `mcp-unconnected{server, detail}`: the server did not start or connect | install it in the project's devcontainer; configure and commit `walkthrough.mcp` (SKILL.md "Bootstrap", walk tools) |
| `vision-unconfirmed{ref, expected, actual}` | `.roadmap/vision.json` unconfirmed, or its `corpus:` hash differs from the pinned vision document (`actual` null: no such pinned file) | run the `vision` skill; commit; re-pin |
| `corpus-invalid{problems}` | `pin-drift`, `rule-reused{id}`, `rule-retired-reappears{id}`, `rules-in-vision`, `guide-missing`, `source-unreadable{detail}`, `source-remote-mismatch`, `scope-overlaps-corpus{unit}`, `contract-overlaps-corpus{path}` | re-pin after any corpus change; a new meaning takes a new id; no rules block in the vision document; scopes and contracts stay off corpus files |
| `phase0-invalid{problems}` | `census-incomplete{rules}`, `census-dangling{rules}`, `obligation-rule-unresolved{obligation}`, `debt-undispositioned{id}`, `debt-kept-twice-unasked{id}`, `amendment-undispositioned{id}`, `intake-missing{issue}`, `intake-unknown{issue}`, `intake-duplicate{issue}`, `capture-missing`, `capture-foreign{expected, actual}`, `question-reused{id}`, `answer-unapplied{question}` (a fresh start: a recorded owner answer the record does not mark
`answered` with its text), `spec-census-mismatch{unit, item, rule, state}` (a spec declares an obligation whose rule's census is not that obligation, or an acceptance clause or witness item names an `out-of-slice` rule; checked on every revision, so `apply` refuses it too) | complete the Phase-0 record or obligations (an answer: `answered{answer, at}` with its text, rules to match); re-capture issues for this repo; align the spec with the census |
| `chain-invalid{problem}` | `limit{k, unacked}`, `baseline{previous-head-mismatch \| merge-commit \| parent-mismatch \| paths{paths}}`, `previous-incomplete{arc}`, `k-unset` | `limit`: stop (`k-limit`); `baseline`: one non-merge commit on the previous completed head, touching only `.roadmap/` inputs and corpus paths; `k-unset`: bootstrap K. `chain status` `nextStart` answers `limit`, `k-unset` and `previous-incomplete` before you compose the plan |
| `issue-policy-untrusted{visibility, policy}` | anyone can open issues | the owner restricts issue creation to collaborators or disables issues |
| `tree-uncommitted{paths}` | `.roadmap/{vision.json, corpus.md, config.json}` differ from `HEAD` | commit them |
| `arc-superseded{by}` | a start of an arc with a plan in force (a reopen) after arc `by` started on its head | put the fixes in arc `by` as priority units; at its completion, `pr --supersede-previous` for arc `by` |
| `vision-leak{inForce, committed, draft}` (`apply` only) | the vision file differs from the vision in force and the apply declares no vision edit | move the draft to `draft` (`<inputs>/_next/vision.md`) and restore `.roadmap/vision.json` and the vision document to the vision in force (commit, re-pin); `--vision-edit` only for a vision change the owner ordered for this arc |

**`apply` rejections** (in the receipt or `--dry-run`): every row above that applies to the edit, plus
`target-kind-changed` (an `architecture-doc` arc never becomes a corpus arc, nor the reverse), `chain-immutable`
(`chain` is fixed at the first revision), and for known defects `known-defect-fix-unit` (the fixer is absent, its
lineage merged or cut, or the apply cuts a fixer an entry still names), `known-defect-lane` (no spec in force declares
the lane) and `known-defect-cycle` (the `after` edges plus the holds form a cycle, named). A re-entry whose scope
leaves its lineage's envelope is refused unless its spec cites an active ruling for it naming exactly the added
patterns. Milestones change only by `apply` (`milestones`, draining nothing), refused when the apply removes a
milestone a walk started on, edits one whose walk is running, changes a walked milestone's `units` or `design`, adds a
milestone (or changes its units) whose units have all merged, or leaves a cut unit in a milestone's `units` (this last
on every revision, a checkpoint's cut included). A re-entry the apply adds is refused without `fixes` (once its lineage recorded a failure) or with one that names no failure of its lineage (the
refusal lists the lineage's failures); a re-entry that changes nothing the cited failure ran under is accepted. Priority, known-defect, plan-check-shape and milestones edits drain nothing.

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
- `scope-growth` (the unit is held at plan-check, or at lanes): its plan-check proposes scope growth code verified
  (each pattern matches a file, lies outside the scope, and could land), or salvage reverted the same path on its last
  two build rounds. `scope accept` or `scope reject` (SKILL.md "Scope growth").
- `context-exceeded` (the unit is parked at plan-check, build or gate, uncharged): the call's prompt or context outgrew
  its model's window; the item names the role, the call and the prompt's size. Shrink the stage's inputs or route the
  seat to a larger window, then `resume`, which makes a new call (SKILL.md "Handling parks"). Not a backend problem: nothing is parked arc-wide.
- `executor-fault`, non-blocking (1.0.0-dev.17): the executor threw inside a unit's task (the unit is parked at the stage
  it was in, uncharged) or an arc job (audit, walk, checkpoint, baseline: the job ended faulted) while it held only that
  unit's or job's own state; the arc went on. The item carries the stack (SKILL.md "Handling parks").
- `plan-defect` (the unit is parked at lanes, uncharged): its missing witness is a plan defect code diagnosed (the
  witness file outside its lane, or absent and outside the unit's scope). Fix the plan by `apply`, then `resume`
  (SKILL.md "Handling parks"). At plan-check (1.0.0-dev.17): its design was refused twice for a plan defect (a test no lane
  runs before the unit merges, an integration unit without a spanning test, a design too big for one unit, a split code
  refused); at scaffold: its skeleton was refused twice (paths outside the new system, a missing entry point, a load
  test that does not run). The item names every reason; fix by `apply`, then `resume` (SKILL.md "The design pass").
- Flow, non-blocking (SKILL.md "The flow loop"): `flow-proposal` and `flow-host` (`flow accept` or `flow reject`; the
  item's evidence is the run's inputs file), `flow-worse` (revert by `apply` to the `preimage` of the proposal's
  `flow-verdict` fact in the run dir's `events.jsonl`, then `ack`), `ruler-changed` (confirm or revert, then `ack`),
  `flow-invalid` (`ack`).
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
- "M4a rev 3: the run-10 batch": `knownDefects`, `priority`, `planCheck` (removed in dev.17), spec `witnesses` and lane `inputs`, arc
  lane `testPaths`, admit classes and conversions, the witness lane file.
- "Plan defects (2026-10-16)": witness `files`, required `testPaths`, the `plan-defect` row (2026-10-21: milestone references over the budget) and park, plan `derived`
  and the dispatch record's `derived`, the lanes `scope-growth` hold; a derived entry's `regenerate` and its check
  ("Regenerate checks").
- "M4b: the flow loop": stations, the series and chart, levers and their plan paths, the ruler paths, proposals,
  proofs, verdicts, givens and the flow facts.
- "dev.13: milestone walkthroughs and design units": `milestones` (design, references, bring-up, journeys),
  `limits.walkRounds`, polish units, the `experience` vision clause, the walk facts and findings, the walkthrough MCP
  config, the Phase-0 rows and advisories, the demo.
