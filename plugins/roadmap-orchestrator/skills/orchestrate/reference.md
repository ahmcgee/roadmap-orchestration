# Roadmap Orchestrator — Reference

Shapes and rules the scripts depend on. Read once before Phase 0; don't restate any of this to
the user unless asked. Rationale for *why* any of it is this way lives in `RATIONALE.md`.

## `.roadmap/` layout (committed; the plan is a reviewable artifact)

```
.roadmap/
  plan.json            # units, edges, provision, config — written by you at Phase 0
  brief.md             # codebase brief: build/test/lint commands, conventions, module map.
                       #   Interpolated into every per-unit prompt so agents never guess
                       #   the commands. Regenerated per arc.
  contracts/*.md       # frozen interfaces; any diff touching these fires escalation
  contracts/conventions.md # OPTIONAL standing cross-cutting contract (pointed to by
                       #   plan.conventions): shared-utility catalog units must reuse +
                       #   naming/error/pattern conventions units must follow. Threaded by
                       #   the harness into every unit's implement/review/gate.
  constraints.md       # LIVING. Numbered rulings ledger: `C-<nn> — <rule>` + one provenance
                       #   line each. Ids stable forever (never renumbered/reused; supersede
                       #   with a NEW ruling naming the old). Cross-cutting constraints that
                       #   aren't interface contracts (perf budgets, tech choices, compliance,
                       #   non-goals); specs + dismissal criteria cite rulings by id.
  debt.md              # LIVING. Ledger of consciously-deferred technical debt; appended at
                       #   each triage, carries across waves and arcs, read at Phase 0 as
                       #   candidate scope. Distinct from feedback — kept, not consumed.
                       #   FILE MODE ONLY — issue mode uses roadmap:debt issues instead.
  skill-feedback.md    # LIVING, HAND-WRITTEN, and never touched by the scripts. Your and the
                       #   user's observations about the ORCHESTRATOR itself. Belongs to the
                       #   skill's repo, not to this arc. Never mixed into debt.md.
  skill-degradations.md # LIVING, MACHINE-written by persist.mjs (whole file, every run). A
                       #   per-KIND count summary of the degradations that run recorded —
                       #   bounded by the number of kinds, never by the number of rows — plus a
                       #   pointer to the ledger below. Carry it back to the skill's repo
                       #   alongside skill-feedback.md.
  degradations.jsonl   # LIVING, APPEND-ONLY. One JSON line per degradation, appended by
                       #   persist.mjs from the run's return envelope. This is the full record;
                       #   state.json carries none of it.
  escalations.jsonl    # LIVING, APPEND-ONLY. One JSON line per escalation-ladder ruling
                       #   ({unit, stop, tier, boundary, by, gap}), same route. state.json keeps
                       #   only the per-unit stop COUNTS the three-strikes brake reads.
  debt.json            # The wave's debt exactly as the conductor received it, for the returns
                       #   that hand back BEFORE the bank (a halt, an escalation, arc-complete).
                       #   Absent once a boundary has banked — debt.md / roadmap:debt issues are
                       #   the durable ledger.
  specs/<unit>.md      # goal, constraints, contract references, acceptance criteria
                       #   (individually gradeable clauses — the gate grades them one by one),
                       #   plus the Codex-ready sections (SKILL.md Phase 0): Done-when with at
                       #   least one runnable command, Scope + explicit out-of-scope list,
                       #   pre-agreed test seams, preserve-list for refactor-shaped work, and
                       #   the named open decisions (everything else unsettled = escalate)
  architect-log.md     # arc-scoped architect journal: opens with `## Direction` (where the
                       #   codebase is heading + tie-breaking preferences + non-goals), read by
                       #   every judgment surface — plan-check, exit gate, escalation adjudicator.
                       #   Subordinate to specs/contracts; never reaches a Codex brief.
                       #   Then: decisions + rationale, watch-list,
                       #   dismissal criteria. Seeded at Phase 0 (Opus); the conductor's
                       #   tier-3 agent appends a `## Wave N` section each time it runs.
                       #   Read FIRST by both boundary agents — it is the only channel by
                       #   which your steering reaches them.
  state.json           # written by persist.mjs after every run; you write the initial one.
                       #   PRESENT AT TOP LEVEL = an arc is in flight (resume, don't plan over)
  quarantine/<unit>.md # dossiers written by the harness
  feedback/            # accumulated runtime evidence; triaged in batch at boundaries
    explorer/*.md      #   per-wave runtime exploration findings (wave-tail codex role, which
                       #   writes this file ITSELF — see "Who writes .roadmap/")
    health/*.md        #   per-wave code/test/structure/ergonomics health findings (codex role)
    health/*-flake.md  #   the flake band's re-run record (Haiku; its own file, so the health
                       #   role owns wave-<n>.md end to end)
    design/*.md        #   per-wave design-fidelity reconcile vs the cited comps (codex role);
                       #   written only on waves that merged a design-cited unit
    user/*.md          #   FILE MODE: the user drops notes here AT ANY TIME (copying TEMPLATE.md);
                       #   read at the next boundary — never an input to a running wave. ISSUE
                       #   MODE: users file roadmap:bug issues instead; this folder is unused.
    triaged/<wave>/    #   consumed items, moved here at triage; never re-triaged
  archive/<arc>/       # closed-out arcs
```

**Who writes `.roadmap/`.** Not the workflow scripts — `persist.mjs` does, and nothing else.
A workflow script has no filesystem, so every byte it wanted on disk used to go through a model
transcribing a document; that transport was the second-largest model cost in the system, and it
occasionally lost the document anyway. The scripts now **return** everything (state, merged plan,
debt, the debt.md and architect-log sections, both event ledgers) and the root runs

```
node <skill dir>/persist.mjs --run <workflow transcript dir> \
     --script <harness.mjs|conductor.mjs> --args '<the launch envelope>'
```

after every Workflow return **and after every crash**. It replays the run against its own journal
(the platform records every agent result; a nested `workflow()` child shares the parent's journal,
so one directory covers a conductor run and every wave in it), calls no model, and writes the files
with `fs`. It is idempotent: re-running it over the same run replaces the same sections and appends
no duplicate ledger rows. A replay that runs out of journal — a crash — writes the last snapshot the
script logged, marked `partial: {stoppedAt: <label>}`, and exits 2; relaunch with `resumeFromRunId`
and run it again. Exit 0 = complete, 2 = partial, 1 = error (nothing written).

What the scripts still delegate to a model is what a model must actually *do*: author a spec, write a
quarantine dossier or a feedback report, move consumed feedback, and project state into GitHub
issues. Those are agent work, not transport.

**Arc-scoped vs living.** Everything above except `constraints.md`, `debt.md`,
`skill-feedback.md`, `skill-degradations.md`, `degradations.jsonl` and `escalations.jsonl`
(and notes) is arc-scoped and archived at close-out. Contracts retire with their
arc: once merged, the code and its tests are the source of truth. The detection rule is mechanical:
top-level `state.json` present → arc in flight, resume or ask; absent → plan fresh, treating
`archive/` + the living docs as prior knowledge.

## `plan.json`

```jsonc
{
  "repoPath": "/abs/path/to/repo",            // required
  "worktreeRoot": "/abs/path/OUTSIDE/repo",   // required — e.g. /tmp/<repo>-roadmap
  "cutLine": "milestone-2",
  "tracking": "issues",            // "issues" | "files" — resolved at Phase 0 by probing for a
                                   //   usable GitHub remote + gh auth. "files" (the default when
                                   //   absent) is the legacy filesystem behaviour; every gh side-
                                   //   effect below is a no-op and every gh prompt clause is ''.
                                   //   See "GitHub issue tracking" below.
  "repoSlug": "owner/name",        // issue mode: the gh --repo target (never inferred from cwd)
  "milestone": "roadmap: <cutline>", // issue mode: arc milestone title (units file under it)
  "trackingIssue": 42,             // issue mode: the arc tracking (epic) issue number
  "units": [{
    "id": "auth-token-rotation",   // stable kebab slug — prompts and resume key on it; never rename mid-arc
    "title": "...",
    "risk": "high",                // low | med | high — drives plan-check coverage and gate effort
    "kind": "code",                // anything else is yours to handle between waves
    "inScope": true,               // resolved cut line, ancestor-closed
    "issue": 57,                    // issue mode: CACHE of the unit's issue number. Convenience only —
                                   //   sync agents find-or-create by the `roadmap:unit id=<id>` body
                                   //   marker, so correctness never depends on this being present or
                                   //   fresh. The scheduler never reads it (issue numbers are non-
                                   //   deterministic; the scheduler stays on state.json).
    "closes": [61, 62],            // issue mode, optional: EXISTING issue numbers this unit RESOLVES
                                   //   (typically the consolidated roadmap:debt issues a sweep
                                   //   fix-unit folds in, or a roadmap:bug it fixes). On merge, the
                                   //   merge agent closes each with a comment naming the unit, and
                                   //   the wave-tail sweep backstops it. Best-effort projection —
                                   //   ignored in file mode; validated as positive integers.
    "design": ["checkin#opening-chrome"],  // optional in general, REQUIRED where a
                                   //   designAuthority `covers` this unit's surface. Cites the
                                   //   binding comp section(s). Threaded into implement/review/
                                   //   gate, and interrogated by plan-check like a contract:
                                   //   a spec clause contradicting the cited comp is a redirect.
    "existingBranch": "..."        // optional: adopt a pre-written branch — skips plan/implement,
                                   //   runs it through the same verify → review → gate pipeline.
                                   //   MUST NOT be the unit's own `unit/<id>` (hard-refused at
                                   //   plan validation — setup could delete its own source);
                                   //   anchor under a different ref (adopt/<id>) instead.
  }],
  "edges": [{
    "from": "auth-core",           // dependency
    "to": "auth-token-rotation",   // dependent — launches only after `from` is merged
    "type": "semantic",            // semantic | file-overlap (both just order scheduling)
    "mode": "contract",            // contract | contingent — contingent edges end the wave; you replan after
    "contract": "contracts/token-provider.md"
  }],
  "designAuthorities": [{          // optional. Where designs are provided they BIND — a screen
                                   //   with a comp is never built from primitives. See SKILL.md.
    "id": "checkin",               // stable slug — units cite it in `design`
    "source": "…",                 // provenance: design project, export, or design-system package
    "path": "apps/web/src/design/checkin/",  // IN-REPO copy, committed WITH the plan pack so
                                   //   every unit forks with the comp already in its base — a
                                   //   comp the implementer cannot read is one it will reinvent.
                                   //   ADOPTABLE source belongs in the PRODUCT tree, never under
                                   //   .roadmap/: coding agents may not write there (NOROADMAP)
                                   //   and it is archived at close-out, so imports would break.
    "reference": ".roadmap/design/checkin/",  // optional; renders kept for COMPARISON only,
                                   //   never imported — safe to archive with the arc
    "covers": ["/checkin", "#today"]     // surfaces this authority governs — a UI unit touching
                                   //   one of these with no `design` citation is a plan defect
  }],
  "provision": {                   // optional but strongly recommended — a fresh worktree has
    "copy": [".env", ".npmrc"],    //   no deps/env; without it, test gates fail for non-code
    "setup": "npm ci"              //   reasons and produce false quarantines
  },
  "preview": {                     // optional but encouraged — how the *integrated arc* is
    "kind": "server",              //   exercised. server | cli | api. Planned at Phase 0.
                                   //   EVERY command below is run from the preview's own worktree
                                   //   at worktreeRoot/__preview — never the user's checkout.
    "setup": "npm run build",      // optional one-time step at preview setup
    "start": "npm run dev",        // server kind: long-running; the harness daemonizes it
                                   //   (log + pidfile at worktreeRoot/__preview.{log,pid},
                                   //   outside every worktree so a mirror advance never touches them)
    "stop": "",                    // optional; default kills the whole preview process GROUP.
                                   //   A custom stop MUST group-kill too — a single-pid kill
                                   //   strands child listeners and leaves ports held.
    "refresh": "",                 // optional per-advance step after the mirror moves; ""
                                   //   for hot-reloading servers; absent + server kind → stop/start
    "howToAccess": "http://localhost:5173",  // URL or drive-the-surface instructions — shown to
                                   //   the user at dispatch AND to the wave explorer
    "ports": [5173],               // optional; the ports the preview OWNS. The only listeners the
                                   //   one-shot port sweep may kill, interpolated as a literal
                                   //   list. Absent → derived from a :PORT in howToAccess; nothing
                                   //   derivable → the sweep may only kill the pidfile's process
                                   //   group. NEVER inferred by an agent (asked to free "the
                                   //   preview's ports", Haiku swept three guesses and then
                                   //   `ps | grep | kill -9`, killing the workflow itself).
    "healthcheck": ""              // optional; failure marks the preview failed, NEVER gates
  },
  "briefPath": "…",                // optional; defaults to <repoPath>/.roadmap/brief.md
  "conventions": "…",              // optional; path to the standing conventions contract.
                                   //   Present → threaded into every implement/review/gate.
  "prefixUniqueGlobs": ["migrations/*"],  // optional. Repos with numbered artifact sequences:
                                   //   the merge agent extracts each matching filename's leading
                                   //   digit run, pre-merge tip vs merged tree, and REFUSES a
                                   //   merge that INTRODUCES a duplicate (quarantine, never a
                                   //   silent renumber). Duplicates already in the tree are
                                   //   grandfathered — they never refuse. Absent → clause is
                                   //   '' and merge prompts are byte-identical to before. The
                                   //   conventions contract must pre-allocate numbers per unit.
  "scopeAllow": ["docs/evidence/**", "**/*.test.*"],  // optional globs (`**/` = any dirs, `*` =
                                   //   no `/`). Files matching are in every unit's scope by
                                   //   convention: named to the implementer beside the pinned
                                   //   files and NEVER counted as scope-growth, so that signal
                                   //   stays real. Absent → clause is '' and the scope text is
                                   //   byte-identical to before. Excludes from the growth check;
                                   //   does not widen the pinned envelope.
  "config": { }                    // optional overrides — knobs below
}
```

## `state.json` — you write the initial one; the harness owns it afterward

```json
{ "integrationBranch": "roadmap/session-<date>",
  "integrationTip": "<sha to fork from — usually main's HEAD>",
  "consultsUsed": 0, "wave": 0, "units": {},
  "run": { "runId": "<id>", "scriptPath": "<session-persisted script path>" } }
```

Fields the scripts add:

- **`run`** — optional passthrough you record at launch (from the Workflow tool result). On a
  conductor run it identifies the whole multi-wave run, making same-session `resumeFromRunId`
  mechanical and forensics one `cat`.
- **`preview`** — `{ sha, status: "live" | "failed" | "none" }`, the green-tip mirror's position.
  `failed` never affects any unit outcome.
- **`boundary`** — present when the wave-tail boundary phase ran anything:
  `{ explorer, health, flake, design }`. Any job is `null` when it was off or failed; the whole
  block is **omitted** when no job ran or every job failed — its absence is the signal to run the
  explorer/health agents yourself.
- **`owed`** — boundary jobs that were DUE but did not run (skipped on a broken precondition, or
  died): `{job: explorer|health|flake|design, wave, why, count, units?}` per entry (`units` names
  the design-cited units an owed reconcile still must cover; `count` = consecutive boundaries
  owed). Discharged automatically when the job next succeeds; carried with `count+1` otherwise.
  The conductor's tiers may not silently drop one — `count >= 2` forces the Fable tier, which
  alone may waive (`waiveOwed`, justification journaled). A marker whose precondition is later
  REMOVED from the plan (the preview block dropped, the citing unit cut) carries at a frozen
  count rather than clearing — removing a capability is not discharging the debt; the waive is
  the sanctioned exit. Non-empty `owed` on a terminal return
  is yours: discharge it (run the job) or waive it explicitly in the architect log before
  close-out.
- **`sharedReds`** — present when the wave's circuit breaker took over a shared pre-existing red:
  `{spec, units, wave}` per entry. A red claimed by ≥2 units whose diffs all leave it alone is one
  assertion, not N unit defects — it is degraded once (`shared-red`), suppressed in every affected
  unit's fix rounds (they proceed on their remaining failures, and are never quarantined for it),
  and handed to the boundary as a **finding**. Never a debt item: a finding rides the
  promote/escalation path, which the cut line brakes, so the breaker cannot reopen the
  "debt creates a wave" hole.
- **`scopeRulings`** — this wave's exit-gate verdicts on out-of-scope files: `{unit, file, verdict:
  "approve" | "revert"}` per entry. Previously only the *breach* was recorded (`scope-growth`) and
  never the ruling, so two identical breaches in one wave could get opposite answers. Each gate is
  now shown its siblings' rulings as precedent, and the record is here to audit. Wave-scoped —
  it describes this wave's diffs and does not accumulate.
- **`conductor`** — `{ reason, wavesRun, boundaries: [{ wave, tier, escalated }] }`. `reason` is
  `null` in flight and the frozen return reason on return; `tier` is the ladder rung that handled
  each boundary; `escalated` is the reason a tier handed up/out, else `null`. `boundaries` is
  **arc-cumulative** (seeded from the passed state), so a mid-arc relaunch extends the forensics
  rather than erasing them.
- **`spend`** — per-tier agent counts (`fable`/`opus`/`sonnet`/`haiku`) plus `opusPlanChecks`,
  `planChecks` (Fable only), `opusGateRounds`, `gateRounds` (Fable), `codex` (role dispatches
  through the adapter — **not** a Claude tier, so the conductor's Claude budget arithmetic ignores
  it), `codexRuns`/`codexInputTokens`/`codexOutputTokens` (every codex process, build lane
  included), and — on a conductor run — `boundaryTriages` (tier-2) and `boundaryFables` (tier-3). **Arc-cumulative**: it seeds from the
  passed state and accumulates across relaunches, so a single wave's delta is the difference
  between two successive persisted states. This is the session report's "where did frontier
  attention go" table.
- **`debt`** — the imperfections surfaced *this wave only*. `.roadmap/debt.md` is the cross-wave
  accumulator.
- **`escalationStops`** — `{unitId: count}`, arc-cumulative. The only escalation state the run
  itself reads (the three-strikes brake, which must survive a unit re-entering in a later wave).
  The rulings themselves are append-only lines in `.roadmap/escalations.jsonl`.
- **`partial`** — written only by `persist.mjs`, and only when a replay could not reach the run's
  return value: `{stoppedAt: <agent label>}`. The state beside it is the last snapshot the script
  logged, so it is real but not final. Relaunch (`resumeFromRunId`) and persist again.
- **`degradations` / `escalations`** — **NOT state.json fields.** They are events, not state: each
  run collects its own rows in memory, hands them back on the return envelope, and `persist.mjs`
  appends them to `.roadmap/{degradations,escalations}.jsonl`. They used to ride inside `state.json`,
  arc-cumulative — a third of a 170–190 KB document by wave 19, re-transcribed at every write, so
  each row made the next write likelier to fail and each failed write appended another row.
  Degradation shape: `{script, wave, phase, label,
  model, kind, what}` per entry, `kind ∈ schema-retry | no-report | salvage-failed | threw | gh-sync |
  preview-failed | lane-substituted | correctness-debt-banked | scope-growth | tip-regressed |
  quarantine-refused | no-launch-id | plan-conflict | debt-unbanked | shared-red | verify-blocked |
  duplicate-draft | commit-probe-unknown | platform-outage | env-unprobed | env-pids-exhausted |
  env-no-reaper | codex-exec | codex-lifecycle |
  codex-timeout | codex-uncommitted | codex-unavailable | codex-usage-limit | codex-role`.
  Codex-kind entries name the `__codex/<unit>/<step>/` (or `__codex/roles/<label>/`) artifact
  directory to read; `codex-role` is a role that produced no result after its one retry — its
  caller got `null`, and nothing was halted on account of it; `codex-exec`
  (codex exited non-zero) / `codex-lifecycle` (**no exit-code file** — nobody observed the run
  finish, so its exit status is unknown, not bad) / `codex-timeout`, with surviving commits, mean
  the branch was judged on its merits (a dead process is not a dead unit); the five halt kinds
  (`codex-unavailable`, `codex-usage-limit`, `env-pids-exhausted`, `env-no-reaper`,
  `platform-outage`) accompany a wave halt (see `state.halt` below); `env-unprobed` means a host
  fact could not be read at all, so the wave ran unguarded on that axis — an unknown is never
  treated as a breach; `commit-probe-unknown` means an implement report AND its commit probe both
  died, so whether the branch holds work is unknown and the unit parked rather than being
  quarantined for building nothing; `scope-growth` means a diff reached beyond its pinned envelope and the
  gate adjudicated it — re-emitted only when the diff reaches a file it has not already reported,
  so one incident is one row. A **`tip-regressed`** entry accompanies a thrown wave: the checkpointed
  integration tip is not an ancestor of the branch, so nothing was dispatched (see the one-way tip
  reconcile). **`quarantine-refused`** means a verdict asked to quarantine a unit git says already
  landed — it was recorded `merged` instead, and the verdict was reading stale or cached state.
  **`no-launch-id`** means the root omitted `args.launchId`, so the environment probes ran unsalted
  and a resume can serve them from cache. A `verify-blocked` entry accompanies an environment
  quarantine and carries the host's load; a `shared-red` entry names the one spec several units
  failed on and the units it hit; a `duplicate-draft` entry names drafts a boundary filed twice in
  one batch, which are dropped rather than renamed into extra units.

  **Host load is recorded, never gated on.** Every test lane reports `loadavg1` and `cpuCount`
  (`cat /proc/loadavg`, `nproc`) into its verify result, the flake band reports one `loads` sample
  per run, and the `verify-blocked` and `codex-timeout` entries cite them. The wave's own
  concurrency is what produces the load, so waiting on it would be waiting on our own siblings —
  `gateMaxConcurrent` is the actual brake. The numbers exist so a wall-clock verdict is auditable
  after the fact instead of a mystery.
  A `gh-sync` entry means a best-effort issue-projection write failed (issue mode only) — the arc was
  unaffected; the wave-tail sweep reconciles what it can. A `plan-conflict` entry is written by
  `persist.mjs` (`script: 'persist'`): `plan.json` on disk held unit ids the run has never seen, so
  the overwrite was REFUSED and the file left exactly as it was — merge the two plans by hand.
  A `debt-unbanked` entry means the issue-mode banker did not confirm every item; the unconfirmed
  ones stay in `state.debt` and in `.roadmap/debt.json` and are re-banked at the next boundary.
  (File mode has no such entry: its `debt.md` section is data on the return envelope, and a
  deterministic writer cannot half-land one.) A `preview-failed` entry means the mirror never came up — the entry names which of
  the three setup steps failed (worktree / provisioning / bring-up) with the failing command's exit
  code, and the boundary records owed explorer/design markers instead of silently no-opping; the
  user's own checkout is never involved either way. A `lane-substituted` entry means a verify
  reported `pass` with an empty lane ledger, so the green cannot be attributed to any command —
  the exit gate is the one that rules on lane coverage, so this never gates the unit.
  Both ledgers are appended by `persist.mjs`, one JSON line per row, and a per-kind count summary of
  the run is rendered to `.roadmap/skill-degradations.md`; `skill-feedback.md` is hand-written and
  nothing in the orchestrator can reach it. **Arc-cumulative** (unlike `debt`, they are never
  consumed). Every conductor return carries this run's array, empty when the run was clean.

  A **`no-report`** entry means `agent()` resolved to `null` and **the platform does not expose why**
  — the entry names the agent's `label`, and the real error is only in that agent's `agent-*.jsonl`
  transcript. A repeat at the *same label* is a bug in the skill, not the network; a repeated
  `schema-retry` on one label means a `maxLength` cap is wrong.

**Unit statuses**: `pending → running → merge-ready → merged`, or `quarantined` / `blocked`
(dependency quarantined) / `deferred` (beyond cut line). Dependents launch only when every
dependency is `merged`. While `running` a unit also carries a `stage` field
(`setup | plan | implement | polish | gate | merge-queue`) for crash forensics; a terminal status
replaces the whole record — carrying forward `rounds` (`{fix, opusGate, gate}`, the per-unit
round tally that makes runaway revision loops measurable; the paid fixtures assert ceilings on
it) and, on any halt or park, `parked: true` (`status:'pending'` + parked = re-enters by ADOPTION
next wave: its branch commits are its own prior progress, never unexplained has-commits).
`units[id].codexSession = {id, cwd, wave}` is forensics only — session ids are nondeterministic
and never enter a prompt; fix prompts reference the session-id FILE. The wave state also carries
**`codex`**: `{probed, available}`, and — only when the wave halted — **`halt`**:
`{reason, codex?, env?, platform?}`. One record for every wave-level brake; `reason` is the winning
slot (precedence `platform > env > codex`, decided in the harness so nothing downstream duplicates
it) and it IS the conductor's early-return reason, read verbatim by the root:

| `reason` | who set it | how the root clears it |
|---|---|---|
| `codex-unavailable` | the per-wave `codex-probe` found no CLI or no "logged in" line | `codex login` (or `--device-auth` headless), then relaunch |
| `codex-usage-limit` | a codex run reported a usage/rate limit | wait out the limit window, then relaunch |
| `env-pids-exhausted` | the host preflight: under 20% of the pid cgroup free | free the pids (usually: recreate the container), then relaunch |
| `env-no-reaper` | the host preflight counted ≥ 1000 zombie processes — orphans are not being reaped | recreate the container with a reaping PID 1 (compose `init: true`); if the box is genuinely healthy, set `config.envPreflight: 'off'` |
| `platform-outage` | a REQUIRED agent result never arrived, even after its salvage retry | wait out the outage / usage-limit window, then relaunch |

Every halt is a **resumable pause, never a failure**: nothing is quarantined, in-flight units park
with their commits intact, the full state rides home on the return envelope, and no slot carries
forward — the next wave re-establishes each from its own probes. A free `log` snapshot is emitted at
every status change **and** every stage transition, so a run that dies before returning still has a
recent state for `persist.mjs` to land as `partial`.

In **issue mode** `state.units[id].issue` caches the unit's issue number (convenience only; see
`plan.units[].issue`). The degradation ledger gains the `gh-sync` kind (below).

## GitHub issue tracking

**Mode.** `plan.tracking` is resolved once at Phase 0: `issues` when the repo has a usable GitHub
remote + `gh` auth, else `files`. **`files` is the legacy behaviour, byte-for-byte** — every `gh`
clause the scripts add is `''`, so file-mode prompts are identical to before and the offline paid
fixtures exercise exactly this path. Everything below applies to **issue mode only**.

**Projection, never source of truth.** The scheduler runs on `state.json`/`plan.json` in-memory —
it cannot call `gh` (no network in the sandbox), and issue numbers are non-deterministic (they would
break `resumeFromRunId`). Issues are a Haiku-written *projection*, the same relationship the
green-tip mirror has: **observability, never a gate.** Every `gh` write is best-effort — a failure
records a `gh-sync` degradation and continues; no unit or wave outcome ever depends on it.

**Idempotent by marker, not by number.** Every unit issue body opens with a machine marker
`<!-- roadmap:unit id=<unit-id> -->`, and every debt issue with `<!-- roadmap:debt arc=<arc>
wave=<N> unit=<id>|ledger -->` (the **arc key** — `plan.trackingIssue`, else `plan.milestone` — is
load-bearing: without it a `wave=3 ledger` search matched a *previous* arc's wave 3 and silently
skipped creation). Sync agents **find-or-create** by that marker, so a stale or absent `unit.issue`
cache is harmless and a resumed/re-run wave never double-creates.

**A search hit is a CANDIDATE, never a match.** `--search '"<marker>" in:body'` is GitHub full-text
search: it *tokenizes* the marker, so `id=raise-verbs` matched an unrelated open agenda issue and a
Phase-0 bootstrap "reused" three live issues — overwriting bodies, swapping `status:merged` for
`status:pending`, re-milestoning them. The exactness test therefore lives in the **shell string the
script composes**, not in model compliance: every site emits one canonical search whose `jq`
predicate requires the candidate body's **first line** to equal the marker comment exactly, printing
`<number> <OPEN|CLOSED>` for the single exact match and *nothing at all* otherwise. No exact match
means ABSENT, and absent means create. Two standing bars ride with it: **never edit the labels,
milestone, title or body of a CLOSED issue**, and **never remove a `status:merged` label**.

**Labels** (all skill-managed, prefixed so teardown is a prefix sweep and default repo labels never
collide):

| Group | Values |
|---|---|
| kind | `roadmap:unit` · `roadmap:debt` · `roadmap:bug` · `roadmap:arc` (the tracking issue) |
| status | `status:pending` · `running` · `merge-ready` · `blocked` · `quarantined` · `backlog` · `proposed` · `deferred` |
| facets | `wave:N` · `risk:low\|med\|high` · `severity:minor\|major` (bug: `blocker\|major\|minor`) · `debt:correctness\|test\|structure\|ergonomics` |

**Kinds and their states:**

- **`roadmap:unit`** — one per unit; body = the `<!-- marker -->` + the spec (issue-canonical: the
  issue is where the spec is authored, snapshotted to `.roadmap/specs/<id>.md` at Phase 0/dispatch —
  the building agents read the snapshot, never a live fetch). Open through `pending → running →
  merge-ready → blocked/quarantined`; **closed-completed** = merged; **closed-not-planned** =
  deferred/declined. Quarantine is a *state* of this issue (`status:quarantined`, stays open, dossier
  posted as a comment), never a separate issue. Grouped under `plan.milestone`.
- **`roadmap:debt`** — durable; replaces `debt.md`. Open = unresolved; closed-completed = fixed (a
  comment links the fixing unit). Read at the next Phase 0 as candidate scope. `severity` + `debt:`
  facets; no origin facet.
- **`roadmap:bug`** — a user-reported defect, filed via the `roadmap-bug` issue template (auto-labels
  the kind). **Dual-consumed**: the boundary census lists it during a live arc, *and* Phase 0 reads
  open `roadmap:bug` issues as candidate scope for a fresh arc — so a bug filed between sessions is
  picked up. Adjudicated like a proposal (adopt / split / fold / defer / decline-with-reason, see
  below). Open = new/untriaged or `status:deferred`; **closed-completed** = fixed (a comment links the
  fixing unit); **closed-not-planned** = dismissed/declined. Users reference a unit with `#<n>` in the
  body. `severity` facet (`blocker|major|minor`).
- **backlog / proposals** — beyond-cut-line units are thin `roadmap:unit` + `status:backlog` issues
  (title + one-line intent, no full spec). The `roadmap-unit` template lets a **user** propose units
  (`status:proposed`); Phase 0 adjudicates proposals and `roadmap:bug` issues as roadmap *input* with
  the **same disposition set and parent-issue resolution**:
  - **adopt (1:1)** → promote the source issue *in place*: flip `status:proposed`/untriaged →
    `status:pending`, write the spec as the body (first line the `<!-- roadmap:unit id=<id> -->`
    marker), attach the milestone + `wave`/`risk` labels. No duplicate issue (idempotent by marker).
  - **split (1:N)** → create N child `roadmap:unit`/`status:pending` issues (fresh ids/markers), then
    **close the parent** with a comment linking the children (a `roadmap:bug` parent closes-completed
    once the children land; a proposal parent closes not-planned as "split into #…").
  - **fold** → no new issue; merge the ask into an existing unit's spec. **defer** → leave the source
    open (`status:deferred`/`status:backlog`). **decline** → close not-planned with a reason.
- **`roadmap:arc`** — one tracking (epic) issue, the human dashboard (retires `ROADMAP-STATUS.md`):
  plan summary, DAG, a live unit **task list**, the session report. Open during the arc, closed at
  close-out. The wave-tail sweep rewrites only the `<!-- roadmap:status -->…<!-- /roadmap:status -->`
  region as a GitHub task list (`- [x]`/`- [ ]` per unit, checked when the unit's issue is closed),
  so GitHub renders a native progress rollup and each item links to its unit issue.

**Sync folds into already-spawned agents — no dedicated per-unit sync agents** (the 1000-agent cap
is real; flooding it shortens arc lifetime):

| Update | Carried by | Cadence |
|---|---|---|
| `status:running` | the unit's **setup** agent (best-effort clause, after its sha assertion) | live, per unit |
| `status:merged` + close-completed | the **merge** agent (clean-merge + suite-pass path) | live, common case |
| `status:quarantined` + dossier comment | the **quarantine dossier-writer** (fires on every quarantine path) | live, per unit |
| reconcile the wave's **changed** unit issues + refresh the tracking-issue task list | one **issue-sync sweep** (Haiku) at the harness wave-tail | 1 agent / wave |
| debt issues, feedback close/comment, new unit/fix-unit issues | the conductor's boundary projectors (`bank-debt` → debt issues, `move-feedback` → feedback closes, `issue-new` → new-unit issues) | boundary |
| labels/milestone/arc-issue/unit-issue creation, template PR | main loop + one-time Haiku (Phase 0) | once |
| close issues + milestone + arc issue, open the integration PR | close-out sequence | session end |

The wave-tail **sweep** is the reconciliation backstop: the folded clauses are best-effort, so the
sweep re-derives `status:*` from the final map (catching a missed running/merged flip, `blocked`,
transient `merge-ready`) and is the one agent that records `gh-sync` degradations for unit sync. It is
a single Haiku call per wave, present in **both** dispatch paths (it lives in the harness), and a
no-op in file mode.

**Rate-limit envelope.** Per-unit label reconciliation is scoped to the wave's **status-delta**, not
the cumulative unit set — re-editing every unit every wave is an O(all-units) burst of redundant `gh`
mutations that grows each wave and, on a large arc, risks GitHub's secondary (abuse) rate limit. The
delta still backstops the wave's own folded clauses; the tracking-issue task list lists all units in a
single edit. Everything `gh` is best-effort: a rate-limit error records a `gh-sync` degradation and the
next sweep reconciles — it never gates a unit or wave. The one remaining burst is the **Phase-0 bulk
issue creation** (one `gh issue create` per in-scope unit); it is one-time, best-effort, and tolerates
backoff. `gh` volume is therefore bounded by *new + changed* units per wave, never the arc total.

**Bootstrap (one-time).** Labels + milestone + the arc/unit issues are created immediately via `gh`
API at Phase 0. The **issue templates** (`.github/ISSUE_TEMPLATE/roadmap-bug.yml`,
`roadmap-unit.yml`, `config.yml`) must live on the repo's **default branch** to be active, so if
absent they are added (reference copies live in this skill's `templates/`) on a branch and opened as a
small **PR at Phase 0**; planning continues in parallel (the templates are only needed by the first
wave boundary). The user merges it — one-time
faff. This user-merged PR predates the arc and is consistent with "main untouched until you confirm"
(invariant 5): main moves only because the user merges.

**Bug census (issue mode).** The conductor's census lists open `roadmap:bug` issues
(`gh issue list --label roadmap:bug --state open`) instead of `feedback/user/*.md`; triage
closes/comments them instead of moving files to `triaged/`. `roadmap:bug` is **dual-consumed**: the
census reads it at every wave boundary of a live arc, and Phase 0 reads open `roadmap:bug` issues as
candidate scope for a fresh arc (see the kind row below) — so a bug filed between sessions is not lost.

**Session end.** Issue mode opens one **integration PR** (integration branch → default branch, body
`Closes #<unit-issue>` for each merged unit) — the user's merge is the invariant-5 confirmation. File
mode keeps the local fast-forward-on-confirmation.

**Dropped in issue mode:** `debt.md` and `feedback/user/` (issues are canonical). Internal
explorer/health/design findings stay files (ephemeral working evidence); `constraints.md` stays
(living); the skill-defect record (`skill-feedback.md`, `skill-degradations.md`,
`degradations.jsonl`) stays in files — it is about the *orchestrator*, must leave the product repo,
and is therefore **never** a product-repo issue.

## `harness.mjs` — the per-unit pipeline (one wave)

Every ready unit runs: worktree setup → Opus implementation plan (brief-authoring: written for an
implementer that cannot ask questions) → codex spec-critique (read-only, cross-model, best-effort)
→ **plan-check** → **one background `codex exec` build** (the unit's whole implement→test→fix
inner loop, driven by a Haiku steering agent) → mechanical verify/fix loop (bounded; fixes ride
`codex exec resume`) → **exit gate** → serial merge onto the integration branch with the full
suite as the gate. Then, at the wave tail, the **boundary phase**.

**Codex is THE implementer — there is no Claude implementation lane.** The steering agent writes
`brief.txt` + a strict-mode `--output-schema`, launches codex in the background (`setsid` +
pidfile, the preview-process idiom), polls sleep-free, kills at `codexTimeoutMin`, verifies the
work ON DISK (exit-code marker, commit count, porcelain, the brief's own `DONE` marker), reads
back only an allowlist (final message head, session id, one usage line, an error grep, git truth
— never a transcript), and emits the same S.impl-shaped report the pipeline always consumed.
**S.impl is the seam**: verify, gates, consults, merge and every trigger work unchanged, and
nothing downstream learns who wrote the code. Artifacts live under `<worktreeRoot>/__codex/<unit>/
<step>/` — outside the repo, so the NOROADMAP write-bar and merge fence are structurally
unreachable; degradations name the directory to read. There is **no adversarial review stage**:
the build already ran its own test-fix loop, and the exit gates carry the hunting clauses with
authority. Failure policy: exit≠0/timeout with commits ⇒ judge the branch (a dead process is not
a dead unit); with no commits ⇒ ONE retry — for the build step AND for every fix round — which
first **reaps** the previous pid (TERM, wait, KILL, wait for the exit-code file) and tells codex in
its brief that the earlier attempt is dead and a live sibling is a harness bug to report as
`blocked`; then the commit-probe/quarantine path. A usage/rate limit or a failed per-wave
`codex-probe` ⇒ **hard stop** — new dispatch halts, in-flight units **park**
(`status:'pending', parked:true`, re-entering by adoption next wave), the wave state carries
`halt.codex`, and the conductor early-returns the reason to the root for the human to re-auth or
wait out the window. Never a quarantine, never a substitute implementer.

**The codex ROLE adapter — `run(brief, {model:'codex', …})`.** The build/fix lane is not the only
way to reach Codex. Any call site can dispatch a judgment or drafting ROLE to Codex and get back an
object validated against its own schema, exactly as it would from a Claude agent:

```
const r = await run(brief, { model: 'codex', cwd, sandbox, schema, label, phase,
                             effort?, timeoutMin? })   // -> schema-shaped object, or null
```

`cwd` is **required** — a unit worktree, the integration tree, the mirror or the preview tree; the
operator's checkout **throws**, because a defaulted cwd is how a read-only role edits the repo.
`sandbox` states the role's intent (`read-only` for reviewers/explorers, `workspace-write` for
writers) and `codexSandbox` overrides it exactly as in the build lane, so an instruction not to
write must also live in the brief. `schema` is the caller's own `S.*`: it becomes
`codex exec --output-schema` (strictified for OpenAI strict mode) *and*, nested under `result`, the
courier's own structured output — so the platform validates what comes back rather than the harness
trusting a copy. The adapter appends the brief's `# FINAL MESSAGE` section itself, including a
budget line derived from the schema's own caps; never hand-write those. Mechanically it **is** the
build lane, not a second implementation of it: one Haiku courier under `withCodexSlot`, the
detached `timeout -k` launch, the pidfile, attach-don't-relaunch, the absent-exit-code-means-RUNNING
rule, reap-then-retry. Artifacts: `<worktreeRoot>/__codex/roles/<label>/` (retry: `<label>-retry`).

**Failure contract** — the one thing a caller must handle. A codex role failure is *codex's*, never
the platform's: the adapter never throws for a failed run, never sets `halt.platform`, and never
rides `runReq`'s outage path — `runOr` and `runReq` both **refuse** `model:'codex'` loudly, since
either recovery would be the wrong one (a re-launched `codex exec` with "your report was rejected"
stapled on; a dead OpenAI seat halting the wave as a Claude outage). It reaps and retries **once**
into a fresh dir; if that also yields nothing it appends one `codex-role` degradation and returns
**`null`**. `null` is the whole tagged failure — branch on it with a coded fallback where one is
honest, skip where it is not. A usage limit still sets `halt.codex` (one OpenAI account behind every
run), and a halted wave returns `null` without dispatching. Spend: every role dispatch, retries
included, ticks `spend.codex`.

Callers today: the **spec critique** (`codex-spec-review:<id>`) and the three **boundary roles** —
the wave-tail runtime `explorer`, the `health` assessor and the `design` reconciler, which moved off
Opus in 0.14.0. Each boundary role runs in the tree it judges (explorer and design in the preview
worktree, which is where a shell may reach the running product; health in the integration worktree),
declares `workspace-write` because each writes exactly one file — its own report under
`.roadmap/feedback/<job>/wave-<n>.md` — and carries every other restraint in its brief, since
`codexSandbox` overrides the declared intent anyway. `codexBoundaryTimeoutMin` (45) is their
deadline rather than the 20-minute `codexRoleTimeoutMin`: driving a product end to end is real work,
not a one-artifact errand. On `null`: explorer and design go **owed** exactly as a skipped job does,
and health additionally records a `health-skipped` degradation — without it an empty draft set reads
to the triager as "nothing to consolidate" rather than "nobody looked".

**The process outlives its steerer, safely.** The deadline rides *inside* the launched command
line (`setsid nohup sh -c 'timeout -k 30 <codexTimeoutMin×60> codex exec …'`), so a dead steering
agent can no longer leave a detached codex running unbounded on an OpenAI seat already handed to
the next unit. The steerer's liveness rule is the other half: **an absent `exit-code` file means
RUNNING, never dead** — `exitCode:-1` may only be reported after `kill -0 $(cat codex.pid)` fails,
and elapsed time is never evidence. And the steer prompt is idempotent by construction: if
`<dir>/codex.pid` already exists it attaches instead of launching, so any re-dispatch of the same
prompt (a schema retry, a salvage, a replay) cannot put two codex processes in one worktree.

**Warm lanes are gone** (0.11.0). They existed to amortize one fixed cold start — read the brief,
explore the codebase, rediscover conventions — across a chain of units too small to absorb it
individually. Units are now sized by what can be specified rather than by duration, so a unit
absorbs its own cold start and the chain *is* the unit. What remains is one dispatch path: every
unit runs the same setup → plan → plan-check → codex build → verify → gate → merge pipeline.

- **Plan-check** (before any code exists — the single highest-leverage judgment point in the
  codex design: better judgment up front means less wasted implementation, fewer findings, fewer
  fix rounds). Its charter is the spec as much as the plan — contradictions *within* the spec,
  clauses that contradict a referenced contract or documented codebase reality, stale premises —
  **plus the frontier-only grounds**: overengineering and complexity that does not earn its keep,
  structure that makes the next change harder, missed reuse or a simpler shape, doors quietly
  closed. A **cross-model spec critique** (`codex-spec-review:<id>`, best-effort) runs first —
  a codex ROLE (see the adapter above) asking for `read-only`, which `codexSandbox` overrides, so
  "change nothing" is carried by the brief; a `null` skips the pass. Its questions/risks feed the
  plan-check as adjudication input — cross-model disagreement is signal. Routing: **Fable takes every `med`/`high`-risk
  unit** (plus infeasible plans and `planCheck:'always-fable'`); only low-risk units ride
  **Opus-first** (`approve`/`redirect`/`escalate`; Opus may not quarantine — kill decisions are
  frontier-only). `planCheckRisk` decides which tiers get *any* check.
- **Exit gate** (once the fix loop converges). **Opus-first**: a fresh adversarial Opus (not the
  implementer) grades each acceptance criterion and returns `approve` / `revise` (a mechanical fix
  it specifies itself → free Opus fix → re-verify → re-gate, bounded by `maxGateRounds`) /
  `escalate`, naming the trigger: `stuck`, `hard-tradeoff`, `foundational`, or `oversight`. The
  **Fable** gate (`approve | revise | quarantine`) is reached unconditionally when
  `exitGate: 'always-fable'`, `risk: high`, the diff touches a frozen contract surface, or the
  unit falls in the deterministic `gateAuditRate` sample. Opus non-convergence also falls through
  to Fable.
- **Verify — three outcomes, not two.** Cheapest-first: lint/typecheck the changed files → then
  **exactly the acceptance-check commands the spec names, verbatim, in order**. Every command and
  its exit code comes back in `verify.lanes`, and `pass` is true only if every exit code is 0.
  Substituting a narrower or cheaper lane is the failure this closes (a verifier ran `test:unit`
  where the spec said `test:ci` and left a red seal invisible for a whole unit), so **both exit
  gates check the lane ledger against the spec's list before weighing anything else** — a named
  check missing from `lanes` means UNVERIFIED whatever `pass` says. The script cannot assert
  coverage itself: the commands live in the spec markdown, not in `plan.json`. The full suite runs
  **only at the merge gate**, never in the fix loop. Errors are reported verbatim. The third outcome is **`blocked`** — the
  tooling itself couldn't run (missing dep, broken command, env failure). A blocked verify never
  enters the fix loop; it quarantines immediately with an *environment* dossier. Prevention is the
  `provision` block.
- **Git decides `merged`, in code, before anything else.** At dispatch, before every quarantine,
  and for every `running`/`merge-ready` crash-residue record, a closed-list Haiku courier
  (`merged-probe:<id>`) runs the exact commands the script interpolated and reports their **exit
  codes verbatim**; the script judges. The test is that the unit branch's tip is the **second
  parent of a merge commit** on the integration branch — deliberately *not* a bare
  `merge-base --is-ancestor`, which false-positives on a commit-less branch parked at an old
  integration commit. A unit git already calls merged returns `merged` without dispatching, and
  `quarantine()` **refuses** it (recording a `quarantine-refused` degradation) rather than
  re-opening landed work. The single exception is a merge the integration fix **reverted**: `git
  revert -m 1` leaves the merge commit in history, so that one caller quarantines explicitly.
- **A merge is not merged until git says it is reachable.** After the suite passes, `merge-reach:<id>`
  checks three things by exit code — HEAD is *on* the integration branch, the unit branch is an
  ancestor of it, and the reported head sha is reachable from it — and only then are `status:
  'merged'`, `mergedAt` and the new integration tip written. (The merge prompt itself now has to
  put HEAD on the branch first.) A merge made on a detached HEAD leaves a commit no branch can
  reach; it is quarantined with the three exit codes in its reason, and the branch is left intact
  to re-merge.
- **The wave-start tip reconcile is one-way.** The integration-worktree setup courier reports the
  exit code of `git merge-base --is-ancestor <checkpointed tip> <integration branch>`. The live tip
  is adopted **only** on exit 0 (the branch moved ahead). Anything else means our record and the
  branch have diverged — the harness records a `tip-regressed` degradation and **throws before
  dispatch** rather than forking a wave off a history that orphans the last one.
- **Merge & quarantine.** Serial queue: Haiku checks the unit diff for `.roadmap/` paths (a hit
  refuses the merge, a strip commit restores the paths to the merge base — content preserved in
  branch history — and a `kind:'contract'` debt entry routes adjudication to you: NOROADMAP made
  mechanical) and for `prefixUniqueGlobs` collisions (refused → quarantine, never a silent
  renumber) → `merge --no-ff` → conflicts go to Opus (which aborts
  rather than guessing when semantically unsure) → full suite → on failure, one Opus diagnose/fix
  attempt (checking first whether the failure predates the merge) → else revert the merge,
  quarantine the unit, continue the queue. Quarantined units keep their branch and worktree and
  get a dossier; their dependents are marked `blocked`. **Quarantine reasons route to different
  actions — read them, don't pattern-match:** environment/tooling blocked → fix provisioning or the
  brief, re-run as-is; unsatisfiable spec/contract → respec or amend the contract; everything else
  → redesign as a *new* spec.
- **`contractMismatch`.** An implementer that consciously deviates from a frozen contract surface
  reports it through this structured field (it cannot write `.roadmap/`, so this is its only honest
  channel). A report fires the mid-loop architect consult, **forces the Fable exit gate** with the
  report text in its prompt, and banks a `kind: 'contract'` debt entry — which routes the boundary
  straight back to you, because the amendment is yours alone.
- **`specGap` — the implementer-pulled consult.** A decision the spec does not settle, where
  reasonable engineers would diverge, reported through this structured field. Its presence fires a
  **Fable consult even on an all-green unit** (`confirm` = stands as built; `redirect` = one fix
  round applies the ruling; `quarantine` = the gap invalidates the premise), riding the same
  `maxConsults` budget as the mid-loop rescue. If the budget is spent, the unadjudicated gap
  **forces the Fable exit gate** instead. Evidence for the channel: the mechanical rescue triggers
  fired zero times in 92 units while every real failure was a silent design decision under a spec
  that didn't cover it.
- **Boundary phase** (wave tail, strictly after every merge and mirror advance; gates nothing). In
  parallel: the **runtime explorer** against the live preview (drives it via `preview.howToAccess`;
  ≤10 findings with severity, exact repro, observed vs expected; an empty report is legitimate), the
  **health assessor** against the integration tip, and Haiku full-suite **flake re-runs**
  (`flakeReruns`). The explorer, the health assessor and the design reconciler are **codex roles**
  (0.14.0 — they were Opus through 0.13.x); their results land in the returned state's `boundary`
  block, and each role writes its own `feedback/{explorer,health,design}/wave-<n>.md` rather than
  paying a Haiku transcriber for it (`design/` only on waves that merged a design-cited unit). The
  flake band keeps a Haiku writer — it is a test runner, not a codex role — and gets its own
  `feedback/health/wave-<n>-flake.md`.

**The health assessor is empowered, not advisory.** It judges what no per-unit gate can see: test
health (coverage gaps, brittleness — assertions on implementation detail, over-mocking,
order/timing dependence), structural health (oversized files, misplaced code, architectural
drift), **cross-unit consistency** (units that independently added equivalent helpers or diverged
on the pattern for the same task — the drift the isolate-and-parallel design produces, since
siblings never see each other), and ergonomics. For each finding worth fixing it returns a
**ready-to-dispatch consolidation fix-unit draft** (id, goal, files, acceptance), and at triage
those drafts **default into the next wave** unless cut.

**The debt ledger and the pinned scope envelope.** A unit's scope is computed ONCE before its
first fix round — fresh build: the approved plan's `files`; adopted branch: the diff at entry
— and never recomputed from the live diff (recomputing from the
diff is the closed loop that produced the review spiral: scope→diff→fixes→scope). Verify reports
`diffFiles`; growth beyond the envelope records a loud `scope-growth` degradation and hands the
gates a scope-creep clause to adjudicate (necessary → approve it; creep → a revert directive) —
never a licence to keep fixing. **Banking is the DEFAULT outside the envelope; correctness
inside it blocks at any severity.** Producers of structured `debt` items
`{what, why, severity: minor|major, kind: correctness|test|structure|ergonomics, bankReason}`:
the codex build/fix reports (out-of-scope confessions bank directly — there is no sweep round;
the brief demands in-scope fixing before reporting done), both exit gates (incl. directives past
the `maxBlockingFindings` cap, banked rather than dropped), and the health assessor. Rules
enforced by schema and code, not just prompt:
- `bankReason` is a closed set — `out-of-scope-file | needs-migration-or-ruling |
  pre-existing-untouched` — REQUIRED on gate debt entries.
- **Items are deduped** on `(unit, kind, hash(what))` — the ledger was a pure append with no
  identity, and a resume (which replays a cached implementer report byte-identically) banked the
  same item twice. A reworded finding is a new item; a literal replay is not.
- An item banked against a unit whose work has **already landed** (`merge-ready`/`merged`) is
  stamped **`rebanked: true`** — a ghost of a finding the branch resolved. It stays in the ledger
  (dropping evidence is worse) but the conductor's contract-debt filter ignores it, so a resolved
  ghost can no longer force a `contract-amendment` return.
- **Correctness debt never banks through an approve.** A gate that approves while holding a
  `kind:'correctness'` item is coerced to `revise` (the items become directives) within the
  existing `maxGateRounds`; at the cap the Opus gate escalates to the frontier gate, and the
  frontier gate banks at `severity:'major'` with a loud `correctness-debt-banked` degradation.
- Gates report at most `maxBlockingFindings` directives per revise, in exactly four categories
  (incorrect behaviour; spec/contract/conventions violation, clause quoted; untested or
  tautological criterion; scope creep) — a cap on reporting, never on reading.
The harness collects the wave's items into the returned state's `debt` array; at the boundary they
are promoted into fix units or appended to `debt.md`. Debt is durable where feedback is consumed;
a resolved item is annotated, not deleted.

**The green-tip mirror.** When `plan.preview` exists, the harness gives the preview **its own
worktree** at `worktreeRoot/__preview` (added detached from the primary checkout, then provisioned
exactly like `__integration`), stands the preview up there, and after each suite-green merge has
Haiku advance it (coalescing latest-wins — merges never wait for it) and refresh the preview. The
user watches at `preview.howToAccess` and only ever sees real suite-green states, **with their own
checkout untouched** — they can keep working and switching branches while an arc runs.

The advance is a **closed command list** (`git checkout --detach <sha>`, the bring-up commands, then
`git rev-parse HEAD` for the script to read back), not a goal with a "never stash, reset, or force"
rider: the mirror used to run in the primary checkout, where the harness's own tracked
`.roadmap/state.json` made git refuse the detach, and a Haiku agent told to make it work anyway
deleted 163 untracked `.roadmap/` files. A failed bring-up earns exactly one script-dispatched
retry whose only kill targets are the pidfile's process group and the literal `preview.ports`.
**The preview is observability, never a gate**: setup/refresh/healthcheck failures set
`preview.status: "failed"`, log, and continue.

## `conductor.mjs` — multi-wave dispatch

The **default** dispatch path: a top-level Workflow script that loops the arc's waves in a single
run, so the root wakes once per *run* instead of once per boundary. It dispatches each wave by
calling the harness, then routes the boundary through a tiered triage ladder, returning to the root
only when a decision genuinely needs the frontier architect. A direct per-wave `harness.mjs` launch
remains the fallback/recovery path; every conductor knob is inert there.

```jsonc
Workflow({
  scriptPath: "<conductor.mjs>",
  args: { roadmapDir, launchId, config, harnessPath }
  // roadmapDir  REQUIRED — absolute path of the arc's .roadmap directory. The script's FIRST act
  //             is a Haiku courier that cats plan.json and state.json there and reports each
  //             file's real `cksum`, which the script verifies IN CODE (one courier per file, in
  //             parallel; a mismatch is re-read once — over line ranges if the file is simply too
  //             big for one response — and then the launch throws `pack-unreadable`). The root
  //             used to paste both documents into `args`, which put the whole pack through the
  //             most expensive tier in the system on every launch and every resume.
  // harnessPath REQUIRED — throws without it.
  // launchId    a per-launch nonce, FRESH on every launch and every resume. It salts the pack
  //             read (disk holds the LAST run's plan, so a replayed pack is a stale plan) and is
  //             passed through to each wave, where the harness appends it to its ENVIRONMENT
  //             probes so resumeFromRunId cannot serve a stale disk/git fact from cache. Absent ->
  //             one `no-launch-id` degradation and unsalted probes, never a throw.
})
```

**The nested launch.** The conductor dispatches each wave with `plan` and `state` already in memory
— its plan is mutated wave to wave and deliberately does not round-trip through disk — so a nested
`workflow()` call passes both in `args` and reads no pack. The rule, in one line: **both in memory =>
nested; neither => root, read the pack.** One without the other throws. `harness.mjs` launched
directly (the fallback path) is a root launch and takes the same envelope, minus `harnessPath`.

`config` is threaded to the harness **untouched** (the conductor never sets `boundary:'off'`
itself). A bounded loop (≤ `maxWavesPerRun`) dispatches a wave, takes its returned state, and feeds
it as the next wave's `prior` — so `wave`, the unit map, and arc-cumulative `spend` accumulate for
free.

**The tier ladder** (per boundary, first match wins — the routing order is load-bearing):

| # | Route | When |
|---|---|---|
| — | return `contingent-replan` | a contingent edge crossed (`from` merged, `to` withheld this wave or out of scope) |
| — | return `contract-amendment` | any **non-`rebanked`** `kind:'contract'` debt this wave (a `rebanked` item is a ghost of a finding the branch already resolved — it banks with the rest, it just never escalates) |
| — | return `boundary-degraded` | boundary block absent while the caller left it enabled, and no quarantine to route |
| — | return `root-triage` | `boundaryTriage:'root'` (every boundary returns — escape hatch) |
| **3** | Fable boundary agent | any unresolved **in-scope** quarantine, or `always-fable` + judgment present |
| **2** | Opus boundary triager | any judgment (explorer/health findings, flake flips, non-contract debt, user-feedback files), or `fixUnitAdmit:'triage'` + drafts present, or more than `tier1MaxDrafts` drafts |
| **1** | script (mechanical) | at most `tier1MaxDrafts` health fix-unit **drafts**, or nothing — admitted with no frontier tokens |

Tier 3 also takes the wave when `admissions:'closed'` and a finding is graded `blocker` — see
**Admissions** below.

- **Tier 2 (Opus)** weighs findings, disposes of debt and non-contract feedback, and admits or cuts
  health-assessor drafts (drafts are the default action). It may **not** kill a unit, amend a
  contract, design a contingent dependent, or answer for the user: `quarantine-redesign`/`hard-call`
  hand **down** to tier 3 carrying its assessment as a lead;
  `contract-amendment`/`contingent-replan`/`needs-user` return to the **root**.
  **Debt sweep (low tolerance):** while the plan's own units still have work to run (a next wave will
  happen anyway), tier 2 also promotes the wave's debt into consolidation fix-unit(s) so even minor
  debt is cleaned up next wave rather than accumulating. **Debt never *creates* a wave** — this is the
  convergence brake generalized: once the plan's own units are all terminal, debt is NOT promoted;
  it banks (to `roadmap:debt` issues in issue mode, `debt.md` in file mode) and the arc completes. So
  termination is preserved and outstanding debt is picked up at the next session's Phase 0.

**Admissions (`conductor.admissions`).** Debt is braked; *drafts* were not. Explorer/health/design
drafts are findings, not debt, so the debt brake above never touched them — a healthy assessor
drafts something every wave, and after the plan drains that grows the denominator forever (observed:
7 drafts admitted at wave 18 and 8 at wave 19 after the architect had already logged PLAN DRAINED).
`admissions:'closed'` closes that in **code**: tiers 1 and 2 set `newSkeletons = []`, every draft
the tier admitted and every skeleton it promoted becomes a **debt line** (banked with its origin,
never dropped), and the boundary then finds nothing new and closes the arc. The line is banked into
`state.debt` *and* the wave's pending-debt buffer, because the two terminate differently: a terminal
return hands `state.debt` to the root intact, while a continuation banks the buffer through
`bank-debt` — the receipt-time snapshot is taken before the boundary mints anything, so one channel
alone would lose the line. A continuation overwrites `state.debt` from the buffer, so the pair
never double-banks. The tiers still
*run* — closed admissions never route work away from judgment, only stop judgment minting units.
The single exception is a finding graded **`blocker`**, which routes the wave to tier 3 so the
architect tier rules on it rather than the script auto-admitting it.

**Shared reds.** A `sharedReds` entry in the wave state (one failing spec that broke ≥2 units'
gates and lies in none of their diffs — see the harness's circuit breaker) arrives at triage as a
**finding**, tagged `source:'shared-red'`, never as a debt item: a finding rides the promote path,
which the cut line brakes, whereas admitting it as debt would reopen the "debt creates a wave" hole.

**Duplicate drafts.** A draft filed twice in one batch (same id, or same title once kebabbed) is
**dropped** before ids are assigned, and the drop records a `duplicate-draft` degradation. Only a
`supersedes` respec keeps the id-suffixing path — that one legitimately re-files a topic.
- **Tier 3 (Fable)** handles quarantine respecs and Opus escalations, routing each quarantine by its
  dossier *reason*, and appends the architect journal. It emits **skeletons only** plus a `journal`
  — never code, never a contract amendment. `supersedes` retires the old unit (`inScope:false`) and
  repoints its edges; new ids are kebab-sanitized and collision-suffixed; a respec **never** reuses a
  failed id.
- After a tier runs, every new skeleton becomes `.roadmap/specs/<id>.md` and a pure-code
  merge appends the units and edges. **No spec, no unit**: the spec file's content is composed in
  code from the skeleton and written verbatim by Haiku, and a skeleton whose file is not confirmed
  on disk never reaches the merge — it is degraded (`spec-unwritten`) and banked as debt for the
  next boundary to re-draft, because `specs/<id>.md` is the authority the planner, Codex and both
  exit gates build and grade against. **Arc-completeness is post-hoc**: a tier says so, or the boundary
  produced no new units and no spec revisions. Both paths are then filtered through a satisfiability
  census — if any in-scope unit is still non-terminal *and* dispatchable, the return is `arc-stalled`
  instead, carrying `outstanding`. Units wedged behind an unresolved quarantine can never move, so
  they do not block the close; they ride back in `stuck`.

**Contingent withholding.** The harness's scheduler ignores `edge.mode`, so before every dispatch the
conductor sets aside any contingent `to`-unit whose `from` is not yet merged, via a transient
`inScope:false` **on the dispatched plan copy only** — never on the persisted plan. Independent work
keeps running. **A direct per-wave harness launch inherits this duty** — withhold contingent
dependents yourself or the harness will launch them early.

**Budget guard.** For waves after the first, a pre-dispatch guard refuses to start a wave that could
cross the 1000-call cap: `runLocalCalls + 8 + dispatchable×perUnitCallEstimate + agentBudgetReserve
> 1000` → return `agent-budget`. Exhausting `maxWavesPerRun` returns `max-waves`. Both mean *relaunch
fresh* — a new run resets the per-run counter. `max-waves` is the one terminal return the conductor
cannot see coming: it becomes terminal only after the loop has triaged the wave and cleared its
boundary as a continuation. So the final boundary is restored onto the returned state, marked
`{triaged: true, wave: N}` — the evidence is there to read, but it has already been dispositioned
(findings banked, feedback moved), so do not re-action it.

**Persistence — none of it here.** The conductor writes nothing under `.roadmap/`. Everything a
boundary decides rides home on the return envelope and `persist.mjs` puts it on disk (see "Who
writes `.roadmap/`"): the final `state`, the merged `plan`, `debt` (→ `debt.json`), `debtSections`
(→ the `<!-- wave N -->` sections of `debt.md`, **always stamped**, even "no new entries"),
`journalEntries` (→ the `## Wave N` sections of `architect-log.md`, **tier-3 only**), and both event
ledgers. A **continuation** boundary also logs a snapshot of the consumed state (`boundary` removed,
banked debt cleared) so a crash in a LATER wave still lands what this one decided.

What still runs as an agent call at a boundary, because the bytes have to reach disk mid-run
(`persist.mjs` only replays *after* a run, and the next wave reads these files): **spec expansion**
— a Haiku verbatim write of content this script composes, so there is no model between the
boundary's decision and the file — **spec revision** (Sonnet, the one that stays a judgment: it
edits three sections in place around material it must not touch, such as an architect ruling the
harness appended mid-wave), and **move-feedback** (this wave's evidence + the actioned/dismissed
user notes → `feedback/triaged/N/`). A failed *expansion* withholds its unit; a failed *revision*
degrades (`spec-unrevised`) and the unit dispatches on its previous spec — an amendment is not an
authority.

**Staging on an escalating return.** Spec expansion, `issue-new`, the debt collection and the
journal all happen **before** a tier-2 or tier-3 `contract-amendment` / `contingent-replan` /
`needs-user` return too — an escalating return is a handoff, not an abort (arc-observed: a
`needs-user` return jumped all of them, so the boundary's new-unit skeletons, the wave's debt ledger
and the architect journal existed only in the run's `journal.jsonl`). Such a return hands back
`state` with `boundary` and `debt` left **INTACT** — the root consumes them, and re-banking is
idempotent by marker.
In **issue mode** the boundary also projects to GitHub: `bank-debt` creates/updates `roadmap:debt`
issues (find-or-create by a stable marker) for the wave's un-swept debt *instead of* the `debt.md`
sections, `move-feedback` closes/comments the triaged `roadmap:bug` issues instead of moving files,
and `issue-new` opens a `roadmap:unit` issue for each new fix-unit/respec. All best-effort
(`gh-sync`).
`issue-new` **reports each created issue's number back, and the conductor caches it into
`plan.units[].issue`** — so a mid-arc unit is a first-class citizen: it appears in the arc-issue
task-list rollup and its folded per-unit clauses hit the cached number instead of a marker search.
Without the cache a mid-arc unit is orphaned from the dashboard (the sweep skips unknown-number units).

**Return envelope.** Every return carries:

```jsonc
{ status: 'conductor-return',
  reason,            // arc-complete | arc-stalled | contingent-replan | contract-amendment | needs-user
                     //   | max-waves | agent-budget | boundary-degraded | triage-degraded
                     //   | root-triage
                     //   | <halt>: codex-unavailable | codex-usage-limit | env-pids-exhausted
                     //     | env-no-reaper | platform-outage — state.halt.reason, returned verbatim
  wave, wavesRun,
  state,             // the final state (incl. the `conductor` block) -> .roadmap/state.json
  plan,              // the conductor's merged working plan -> .roadmap/plan.json (refused if the
                     //   file on disk holds unit ids this run never saw)
  spendDelta,        // per-key nonzero delta of state.spend vs the launch state
  spendReport,       // arc-cumulative, split the way 0.14.0 makes decisions about it:
                     //   { claude: {fable, opus, sonnet, haiku, total},
                     //     codex:  {roles, processes, inputTokens, outputTokens} }.
                     //   Claude tiers are the weekly-limited resource; codex is the plentiful
                     //   one work moved onto, and `claude.total` never counts a codex run
  degradations,      // this run's rows (empty when clean) -> degradations.jsonl + skill-degradations.md
  escalations,       // this run's ladder rulings -> escalations.jsonl
  debt,              // the wave ledger as received -> debt.json (empty once a boundary banked it)
  debtSections,      // [{wave, body}] -> the <!-- wave N --> sections of debt.md (file mode only)
  journalEntries,    // [{wave, journal}] -> the ## Wave N sections of architect-log.md (tier 3 only)
  /* + reason-specific brief: */
  // contingent-replan → { edges }
  // contract-amendment → { debt, contracts }
  // needs-user        → { question, context }
  // arc-complete      → { arcSummary, stuck? }
  // max-waves         → state.boundary restored, marked {triaged:true, wave}
  // arc-stalled       → { arcSummary, outstanding, stuck }
  // agent-budget      → { nextWaveUnits, estimate }
  // root-triage       → { pendingFeedback, quarantined }
  // <halt>            → { parked }  // the unit ids that parked; see state.halt above
  // triage-degraded   → { pendingFeedback, quarantined }
}
```

**`agent()` resolves to `null` on a terminal API error — it does not throw.** A bare `.catch()`
therefore does not cover that path, so every `run()` whose result is *dereferenced* must go through
one of two wrappers, and which one is a real decision:

- **`runOr(fallback, …)`** where a coded fallback is an HONEST answer to the question asked (a dead
  census is an empty census; a dead boundary job is a job that did not run).
- **`runReq(…)`** where the caller dereferences the result and no fallback would be honest —
  verify, both exit gates, the plan and plan-check, the merge and its suite gate. Inventing a
  verdict there converts a platform failure into a judgment about a unit. `runReq` salvages once,
  then sets `halt.platform` and throws a tagged `PlatformOutage`, which the scheduler turns into a
  **park** (`status:'pending', parked:true`) and the conductor returns to the root as
  `platform-outage`. The trigger is STRUCTURAL — a required result missing after its salvage —
  because a null carries no error object at all; quota/limit/connection TEXT exists only on the
  throw path, where it is used as a fast path (halt without burning a second agent), never as the
  sole signal.

The one deliberate exception is the **commit probe** after a lost implement report: a dead probe
returns an `unknown` state that parks the unit alone rather than halting the wave — one cheap probe
dying twice is not evidence of an outage, and the branch's commits are safe either way. It used to
read as "no commits" and quarantine a branch that held every milestone (2026-08-25).

A dead **census** degrades to an empty one (the authoritative evidence is the
in-memory state; user-feedback files stay on disk for the next boundary). A dead **triage tier** has
no safe fallback — inventing an empty verdict would silently admit or drop work the root never saw —
so it returns **`triage-degraded`**, and the root triages that boundary by hand exactly as it would
for `boundary-degraded`, then relaunches.

The final wave's boundary output is intentionally left **untriaged** — the conductor never predicts
finality, so arc-completeness is post-hoc and the last wave's evidence is handed to the root as
integration-review material.

**Forensic labels** (for journal reading / `resumeFromRunId` replay): `census:w<N>`, `triage:w<N>`,
`boundary:w<N>`, `spec-expand:<id>`, `spec-revise:<id>`, and the five persistence writers.

## Config knobs (defaults in the harness; override via `plan.config` or the Workflow `config` arg)

| Knob | Default | Meaning |
|---|---|---|
| `maxFixRounds` | 2 | Mechanical verify→codex-fix rounds before the unit must face the gate or rescue |
| `maxGateRounds` | 2 | Architect directive→fix→re-check cycles before quarantine (the last round's fix runs a FRESH codex session — anti-anchoring) |
| `maxConsults` | 3 | Mid-loop rescue consults per wave (fired by code: verify still failing at the round cap, or contract surface touched) |
| `maxBlockingFindings` | 6 | Cap on gate directives per revise round — a cap on REPORTING, never reading; overflow banks as debt. Enforced code-side, never schema maxItems (retry-death) |
| `codexModel` | `'gpt-5.6-sol'` | `-m` for every codex run; `null` falls back to the codex CLI's own config default |
| `codexEffort` | `'high'` | `model_reasoning_effort` for builds — under-provisioned effort is the top documented cause of bad Codex output; `xhigh` for hard arcs |
| `codexFixEffort` | `'medium'` | Effort for resume/fix rounds (narrower work than the build) |
| `codexSandbox` | `'danger-full-access'` | Codex OS sandbox. `workspace-write` is only real where the container permits unprivileged user namespaces — bubblewrap cannot build a sandbox without one, and it then degrades silently to no enforcement (probe-observed: a write outside the worktree succeeded). Full access is a deliberate, measured acceptance of sibling-worktree risk in that case; set back to `'workspace-write'` wherever namespaces work |
| `codexNetwork` | `false` | Adds `-c sandbox_workspace_write.network_access=true` (needed when builds must install packages) |
| `codexTimeoutMin` | `240` | Build deadline before the steering agent kills the process group and assesses what's on disk. Sized for long-horizon units; per-milestone commits are what make a kill survivable |
| `codexFixTimeoutMin` | `20` | Resume-round deadline |
| `codexRoleEffort` | `'medium'` | `model_reasoning_effort` for a codex ROLE run (`run(…, {model:'codex'})`); a caller may override per role |
| `codexRoleTimeoutMin` | `20` | Role deadline. Far below `codexTimeoutMin` on purpose: a role that has not finished in 20 minutes is stuck, not thinking, and its caller has a fallback either way |
| `codexBoundaryTimeoutMin` | `45` | Deadline for the three wave-tail BOUNDARY roles (explorer, health, design). Longer than `codexRoleTimeoutMin` because they drive a product end to end or read a whole integrated tree; still far below `codexTimeoutMin` |
| `codexSteerModel` | `'haiku'` | Steering-agent tier; `'sonnet'` if Haiku proves unable to drive launch/poll/kill/verify (probe P2) |
| `codexMaxConcurrent` | `4` | Counting semaphore on concurrent codex processes (one OpenAI account behind them all). Timing-only — resume-safe |
| `envPreflight` | `'on'` | Host-health preflight before dispatch, beside the codex probe: pid-cgroup headroom (`/sys/fs/cgroup/pids.{current,max}`, halts under 20% free) and whether orphans are being reaped (`ps -eo stat= \| grep -c '^Z' \|\| true`, halts at ≥ 1000 zombies). PID 1's comm is reported in the halt detail but **never judged** — the devcontainer `sh` supervisor reaps fine and an init-name allowlist halts a healthy box. An unreadable fact degrades `env-unprobed` and halts nothing. `'off'` is the documented escape, and the only way past the check |
| `gateMaxConcurrent` | `4` | Counting semaphore on concurrent **test lanes**: the polish-loop verify, every gate re-verify, and the integrated suite at merge. Unit dispatch stays unbounded — their test lanes do not, or the wave saturates the box and then judges wall-clock budgets against the load it created. Timing-only — resume-safe |
| `codexProfile` | `null` | `-p <profile>` (`$CODEX_HOME/<name>.config.toml`) when set |
| `fableEffort` | `'high'` | Effort for the frontier Fable judgment calls that adjudicate hard decisions — the plan-check and the mid-loop architect consult. Fable 5's `high` default; these fire only on the hard calls, so they run there rather than on the floor |
| `gateEffort` | `'high'` | Effort on forced Fable exit-gate calls (the frontier gate) |
| `implementEffort` | `'medium'` | Opus reasoning effort for the code-authoring pipeline (plan/replan/implement, the post-impl debt-fix sweep, + every fix loop). Opus 5 holds coding quality at `medium` at a fraction of the tokens (its `low`/`medium` punch well above prior models'); raise per-arc via `plan.config` if a workload proves effort-sensitive |
| `opusEffort` | `'medium'` | Effort for every other Opus call — the adversarial review, the Opus-first plan-check and exit gate, and merge-conflict/integration fixes (the boundary assessors moved to Codex in 0.14.0). Opus 5 review accuracy holds at lower effort; the paid-fixture `gate-bad` signal is the tripwire if a downgrade ever costs gate teeth |
| `planCheckRisk` | `['low','med','high']` | Which risk tiers get *any* pre-implementation plan-check. Which tier *pays* is set by `planCheck` |
| `planCheck` | `'opus-first'` | `'opus-first'` \| `'always-fable'` (guaranteed Fable on every checked unit). `risk:high` and `feasible:false` always take Fable regardless |
| `exitGate` | `'opus-first'` | `'opus-first'` \| `'always-fable'` (guaranteed Fable gate on every unit) |
| `gateAuditRate` | `0.10` | Fraction of Opus-approved units that still take a Fable audit gate (anti-rubber-stamp). Deterministic per unit id (resume-safe); `0` disables |
| `auditEffort` | `'high'` | Effort for audit-*only* Fable gates (the 10% anti-rubber-stamp sample). Defaults to full effort; these already read diff-stat-first, so dial down (e.g. `'medium'`) to keep the sample cheaper than a forced full gate |
| `previewRefresh` | `'merge'` | Green-tip mirror cadence: `'merge'` \| `'wave'` \| `'off'`. Inert without a `plan.preview` block |
| `boundary` | `'on'` | The wave-tail boundary phase. `'off'` only for a relaunch you know is final |
| `healthCheck` | `'each-wave'` | The health-assessor half of the boundary phase: `'each-wave'` \| `'off'` |
| `flakeReruns` | `3` | Full-suite re-runs hunting intermittents; `0` disables |

### Conductor knobs (under `plan.config.conductor` / `config.conductor` — `config` wins; inert on a direct harness launch)

| Knob | Default | Meaning |
|---|---|---|
| `maxWavesPerRun` | `3` | Wave-loop bound; exhaustion → `max-waves` |
| `boundaryTriage` | `'opus-first'` | `'opus-first'` full ladder · `'always-fable'` skip the Opus tier · `'root'` every boundary returns |
| `agentBudgetReserve` | `200` | Headroom below the 1000-call cap |
| `perUnitCallEstimate` | `15` | Pre-wave budget estimate per dispatchable unit |
| `fixUnitAdmit` | `'auto'` | `'auto'` tier-1 mechanical admit of health drafts · `'triage'` force ≥Opus veto when drafts are present |
| `admissions` | `'open'` | `'open'` normal · `'closed'` tiers 1 and 2 admit **no** new units — drafts and promotions become debt lines in `state.debt`. Enforced in code, not prompt. Flip it once the plan is DRAINED |
| `tier1MaxDrafts` | `3` | Above this many drafts, tier 1 hands the wave to tier 2 so the cut line is actually applied instead of a batch being admitted mechanically |
| `fableEffort` | `'high'` | Effort for the Fable boundary agent (the respec/escalation arbiter) — Fable 5's `high` default |

**Spend direction when tuning:** extra frontier budget goes to the **planning side** (spec detail,
plan-checks, Phase-0 interrogation), never to more mid-flight touchpoints — gate non-convergence is
evidence of an under-specified plan, and the fix is a better plan. Frontier *saved* at the Opus-first
gate is simply saved: per-unit quality is held by the Opus gate, systemic quality by the between-wave
health check.

## Model tiers — the economic contract

| Tier | Does | Never does |
|---|---|---|
| codex (CLI) | ALL implementation: unit builds, fix rounds and adjudicated resumes (via `exec resume`), plus any ROLE dispatched through the adapter (today: the read-only cross-model spec critique). Runs its own implement→test→fix loop inside the brief's pinned scope | Judgment: it never reviews, gates, plans the roadmap, or adjudicates its own escalations |
| `fable` | Plan pack, plan-checks for med/high-risk units (taste/overengineering charter) + escalations, escalated + audit-sample exit gates, rescue + spec-gap consults (Codex's escalation channel), wave replans, feedback/debt triage, the conductor's tier-3 boundary agent, integration review | Code, fixes, bulk text |
| `opus` | Unit plans (brief-authoring), Opus-first plan-check (low-risk singles) + exit gate, conflict resolution, the conductor's tier-2 boundary triager | Implementation (Codex's); the wave-tail explorer/health/design roles (Codex's since 0.14.0) |
| `sonnet` | Roadmap normalization, dossier compression, feedback-batch compression, the conductor's spec **revisions** | Spec expansion (composed in code, written by Haiku since 0.14.0) |
| `haiku` | Codex steering (launch/poll/kill/disk-verify/report), git mechanics, running suites (incl. flake re-runs), the launch pack read, mirror advance / preview refresh, writing dossiers / findings, the conductor's census, feedback archiving and gh projections | Judgment |

**Root-only, never delegated down the ladder**: the Phase-0 plan pack, contingent replans, contract
amendments, needs-user calls, and the session integration review.

## Platform rules the scripts respect (keep respecting them if you modify them)

- `model:` explicit on **every** `agent()` call — omitted, agents inherit the main-loop model
  (frontier) silently. Same for any agent you spawn yourself; never a bare typed agent.
- `schema:` on every call — handoffs are validated structures; the scripts never parse prose.
- No `Date.now()` / `Math.random()` / filesystem in a workflow script. Prompts are deterministic per
  unit id + sha, so `resumeFromRunId` replays completed calls free. **Environment probes are the
  exception and must be salted**: a probe reports what the disk and git look like *now*, so replaying
  one from cache is a lie (arc-observed: a resume replayed a pre-rebuild `cd: No such file` and a
  pre-merge `state:'ready'`). Anything that must vary per launch cannot be generated in-script — it
  arrives as `args.launchId`, which the root regenerates on every launch and every resume and which
  the harness appends to its environment probes: provisioning, integration setup, the unit-setup
  rebuild path, the merged/reachability/commit git probes, the per-wave codex probe, the host
  preflight, and the preview couriers (worktree create, every mirror advance) — a replayed
  `git worktree add` after a container rebuild would skip the create and leave no preview at all. Work-product calls never carry it; that is what keeps a resume cheap.
- The built-in `isolation: 'worktree'` is fresh-per-agent-call — units share a hand-rolled worktree at
  `worktreeRoot/<unit-id>` instead; `worktreeRoot/__integration` is the merge checkout and
  `worktreeRoot/__preview` the green-tip preview mirror. Keep `worktreeRoot` outside the repo.
- **Worktrees contain only committed state.** Gitignored and uncommitted files do not materialize in
  them. Three consequences: plan artifacts are read from the *primary* checkout by absolute path
  (deliberate — don't "fix" it); gitignored files the build/tests need must be in `provision.copy`; and
  a dirty working tree at dispatch means recon saw code the units can't.
- **`args` may arrive JSON-stringified** — both scripts parse defensively. Not doing so is vicious:
  destructured fields become `undefined`, prompts say `cd undefined`, and agents improvise in their cwd.
- **Mechanical agents improvise around bad paths.** Given an unusable location and a loose prompt, Haiku
  will operate on whatever repo it's standing in and report plausible success. The harness counters with
  fail-loud location preambles *and* code-side sha assertions. Keep both.
- **Schema-retry resends payloads verbatim.** On a structured-output validation failure the platform
  re-sends the *same* oversized payload until the unit dies. This is why free-text fields are
  length-capped and implementers are told to commit *before* emitting their report.
- **One `workflow()` nesting level, and the conductor spends it.** `harness.mjs` must stay leaf-only
  forever — a `workflow()` call inside a child script throws.
- Workflows take no mid-run input; ~16 agents run concurrently; the merge queue is serial by design —
  wall clock, not tokens, is the throughput limit.

### Known platform issues (worth filing upstream at github.com/anthropics/claude-code)

- **Adopt-rejection after host death.** If the Claude Code process dies while a workflow is running, the
  platform's same-session resume/adopt path can refuse to re-attach. Treat it as a crash and follow the
  recovery ladder (SKILL.md) — the setup guards make a fresh relaunch behave like a resume.
- **The crash notification recommends `resumeFromRunId` across sessions.** It cannot work there: the
  journal is same-session only. Obey the ladder, not the notification.
