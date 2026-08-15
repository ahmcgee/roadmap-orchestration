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
  skill-feedback.md    # LIVING. Defects in the ORCHESTRATOR itself (not the product): every
                       #   degradation the scripts recorded. Written at every persist point so
                       #   it survives a run that dies. Never archived — it belongs to the
                       #   skill's repo, not to this arc. Never mixed into debt.md.
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
  state.json           # harness-owned after wave 1; you write the initial one.
                       #   PRESENT AT TOP LEVEL = an arc is in flight (resume, don't plan over)
  quarantine/<unit>.md # dossiers written by the harness
  feedback/            # accumulated runtime evidence; triaged in batch at boundaries
    explorer/*.md      #   per-wave runtime exploration findings (harness-run Opus, wave-tail)
    health/*.md        #   per-wave code/test/structure/ergonomics health findings (Opus)
    design/*.md        #   per-wave design-fidelity reconcile vs the cited comps (Opus);
                       #   written only on waves that merged a design-cited unit
    user/*.md          #   FILE MODE: the user drops notes here AT ANY TIME (copying TEMPLATE.md);
                       #   read at the next boundary — never an input to a running wave. ISSUE
                       #   MODE: users file roadmap:bug issues instead; this folder is unused.
    triaged/<wave>/    #   consumed items, moved here at triage; never re-triaged
  archive/<arc>/       # closed-out arcs
```

**Arc-scoped vs living.** Everything above except `constraints.md`, `debt.md` and
`skill-feedback.md` (and notes) is arc-scoped and archived at close-out. Contracts retire with their
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
    "setup": "npm run build",      // optional one-time step at wave setup
    "start": "npm run dev",        // server kind: long-running; the harness daemonizes it
                                   //   (log + pidfile at worktreeRoot/__preview.{log,pid},
                                   //   outside the repo so they never dirty the checkout)
    "stop": "",                    // optional; default kills the whole preview process GROUP.
                                   //   A custom stop MUST group-kill too — a single-pid kill
                                   //   strands child listeners and leaves ports held.
    "refresh": "",                 // optional per-advance step after the mirror moves; ""
                                   //   for hot-reloading servers; absent + server kind → stop/start
    "howToAccess": "http://localhost:5173",  // URL or drive-the-surface instructions — shown to
                                   //   the user at dispatch AND to the wave explorer
    "healthcheck": ""              // optional; failure marks the preview failed, NEVER gates
  },
  "briefPath": "…",                // optional; defaults to <repoPath>/.roadmap/brief.md
  "conventions": "…",              // optional; path to the standing conventions contract.
                                   //   Present → threaded into every implement/review/gate.
  "prefixUniqueGlobs": ["migrations/*"],  // optional. Repos with numbered artifact sequences:
                                   //   the merge agent extracts each matching filename's leading
                                   //   digit run and REFUSES a merge introducing a duplicate
                                   //   (quarantine, never a silent renumber). Absent → clause is
                                   //   '' and merge prompts are byte-identical to before. The
                                   //   conventions contract must pre-allocate numbers per unit.
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
- **`conductor`** — `{ reason, wavesRun, boundaries: [{ wave, tier, escalated }] }`. `reason` is
  `null` in flight and the frozen return reason on return; `tier` is the ladder rung that handled
  each boundary; `escalated` is the reason a tier handed up/out, else `null`. `boundaries` is
  **arc-cumulative** (seeded from the passed state), so a mid-arc relaunch extends the forensics
  rather than erasing them.
- **`spend`** — per-tier agent counts (`fable`/`opus`/`sonnet`/`haiku`) plus `opusPlanChecks`,
  `planChecks` (Fable only), `opusGateRounds`, `gateRounds` (Fable), and — on a conductor run —
  `boundaryTriages` (tier-2) and `boundaryFables` (tier-3). **Arc-cumulative**: it seeds from the
  passed state and accumulates across relaunches, so a single wave's delta is the difference
  between two successive checkpoints. This is the session report's "where did frontier attention
  go" table.
- **`debt`** — the imperfections surfaced *this wave only*. `.roadmap/debt.md` is the cross-wave
  accumulator.
- **`degradations`** — the ORCHESTRATOR misbehaving, not the product: `{script, wave, phase, label,
  model, kind, what}` per entry, `kind ∈ schema-retry | no-report | salvage-failed | threw | gh-sync |
  write-failed | preview-failed | correctness-debt-banked | scope-growth | codex-exec |
  codex-timeout | codex-uncommitted | codex-unavailable | codex-usage-limit | codex-spec-review`.
  Codex-kind entries name the `__codex/<unit>/<step>/` artifact directory to read; `codex-exec`/
  `codex-timeout` with surviving commits mean the branch was judged on its merits (a dead process
  is not a dead unit); `codex-unavailable`/`codex-usage-limit` accompany a wave halt (see
  `state.codex` below); `scope-growth` means a diff reached beyond its pinned envelope and the
  gate adjudicated it.
  A `gh-sync` entry means a best-effort issue-projection write failed (issue mode only) — the arc was
  unaffected; the wave-tail sweep reconciles what it can. A `write-failed` entry means a state/plan
  checkpoint write did not confirm — the on-disk copy may trail the run until the next successful
  write heals it (large payloads are written in staged `<<<PART k/n>>>` chunks to stay under the
  per-response output cap). A `preview-failed` entry means the mirror never came up — the entry
  carries the porcelain diagnosis and exact operator guidance (carried-modification vs real local
  edits), and the boundary records owed explorer/design markers instead of silently no-opping.
  **Arc-cumulative** (unlike `debt`, it is never consumed) and rendered to
  `.roadmap/skill-feedback.md` at every persist point, so it survives a run that dies. Every
  conductor return carries the array, empty when the run was clean.

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
it) and, on a codex halt, `parked: true` (`status:'pending'` + parked = re-enters by ADOPTION
next wave: its branch commits are its own prior progress, never unexplained has-commits).
`units[id].codexSession = {id, cwd, wave}` is forensics only — session ids are nondeterministic
and never enter a prompt; fix prompts reference the session-id FILE. The wave state also carries
**`codex`**: `{probed, available, halt?}` — `halt ∈ codex-unavailable | codex-usage-limit` is the
conductor's early-return signal (re-auth / wait out the limit window, then relaunch; everything
resumes cleanly). Checkpoints land at every status change **and** every stage transition,
coalesced latest-wins — the file can trail the newest event by one write.

In **issue mode** `state.units[id].issue` caches the unit's issue number (convenience only; see
`plan.units[].issue`). `degradations` gains the `gh-sync` kind (below).

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
`<!-- roadmap:unit id=<unit-id> -->`. Sync agents **find-or-create** by that marker
(`gh issue list --search '"roadmap:unit id=<id>"' --state all`), so a stale or absent `unit.issue`
cache is harmless and a resumed/re-run wave never double-creates. Same discipline as the harness's
wave-N section markers.

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
| debt issues, feedback close/comment, new unit/fix-unit issues | the conductor's boundary writers (`bank-debt` → debt issues, `move-feedback` → feedback closes, `persist-plan` → new-unit issues) | boundary |
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
(living); `skill-feedback.md` stays a file — it is about the *orchestrator*, must leave the product
repo, and is therefore **never** a product-repo issue.

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
a dead unit); with no commits ⇒ ONE fresh retry, then the commit-probe/quarantine path; a
usage/rate limit or a failed per-wave `codex-probe` ⇒ **hard stop** — new dispatch halts,
in-flight units **park** (`status:'pending', parked:true`, re-entering by adoption next wave),
the wave state carries `codex.halt`, and the conductor early-returns it to the root
(`codex-unavailable` / `codex-usage-limit`) for the human to re-auth or wait out the window.
Never a quarantine, never a substitute implementer.

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
  closed. A **cross-model spec critique** (`codex-spec-review:<id>`, read-only codex, best-effort)
  runs first; its questions/risks feed the plan-check as adjudication input — cross-model
  disagreement is signal. Routing: **Fable takes every `med`/`high`-risk
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
- **Verify — three outcomes, not two.** Cheapest-first: lint/typecheck the changed files →
  unit-scoped tests + the spec's acceptance checks. The full suite runs **only at the merge gate**,
  never in the fix loop. Errors are reported verbatim. The third outcome is **`blocked`** — the
  tooling itself couldn't run (missing dep, broken command, env failure). A blocked verify never
  enters the fix loop; it quarantines immediately with an *environment* dossier. Prevention is the
  `provision` block.
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
  parallel: the **Opus runtime explorer** against the live preview (drives it via
  `preview.howToAccess`; ≤10 findings with severity, exact repro, observed vs expected; an empty
  report is legitimate), the **Opus health assessor** against the integration tip, and Haiku
  full-suite **flake re-runs** (`flakeReruns`). Results land in the returned state's `boundary`
  block and, via Haiku verbatim-writers, in `feedback/{explorer,health,design}/wave-<n>.md`
  (`design/` only on waves that merged a design-cited unit).

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

**The green-tip mirror.** When `plan.preview` exists, the harness detaches the *primary checkout*
at the integration tip and, after each suite-green merge, has Haiku advance it (coalescing
latest-wins — merges never wait for it) and refresh the preview there. The user watches from their
own repo and only ever sees real suite-green states. The `main` ref never moves (detached HEAD) and
the merge queue stays in `__integration`, so user git activity can at worst stale the mirror (one
detach-checkout heals it), never derail the queue. **The preview is observability, never a gate**:
setup/refresh/healthcheck failures set `preview.status: "failed"`, log, and continue.

## `conductor.mjs` — multi-wave dispatch

The **default** dispatch path: a top-level Workflow script that loops the arc's waves in a single
run, so the root wakes once per *run* instead of once per boundary. It dispatches each wave by
calling the harness, then routes the boundary through a tiered triage ladder, returning to the root
only when a decision genuinely needs the frontier architect. A direct per-wave `harness.mjs` launch
remains the fallback/recovery path; every conductor knob is inert there.

```jsonc
Workflow({
  scriptPath: "<conductor.mjs>",
  args: { plan, state, config, harnessPath }   // harnessPath REQUIRED — throws without it
})
```

`config` is threaded to the harness **untouched** (the conductor never sets `boundary:'off'`
itself). A bounded loop (≤ `maxWavesPerRun`) dispatches a wave, takes its returned state, and feeds
it as the next wave's `prior` — so `wave`, the unit map, and arc-cumulative `spend` accumulate for
free.

**The tier ladder** (per boundary, first match wins — the routing order is load-bearing):

| # | Route | When |
|---|---|---|
| — | return `contingent-replan` | a contingent edge crossed (`from` merged, `to` withheld this wave or out of scope) |
| — | return `contract-amendment` | any `kind:'contract'` debt this wave |
| — | return `boundary-degraded` | boundary block absent while the caller left it enabled, and no quarantine to route |
| — | return `root-triage` | `boundaryTriage:'root'` (every boundary returns — escape hatch) |
| **3** | Fable boundary agent | any unresolved **in-scope** quarantine, or `always-fable` + judgment present |
| **2** | Opus boundary triager | any judgment (explorer/health findings, flake flips, non-contract debt, user-feedback files), or `fixUnitAdmit:'triage'` + drafts present |
| **1** | script (mechanical) | only health fix-unit **drafts**, or nothing — admitted with no frontier tokens |

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
- **Tier 3 (Fable)** handles quarantine respecs and Opus escalations, routing each quarantine by its
  dossier *reason*, and appends the architect journal. It emits **skeletons only** plus a `journal`
  — never code, never a contract amendment. `supersedes` retires the old unit (`inScope:false`) and
  repoints its edges; new ids are kebab-sanitized and collision-suffixed; a respec **never** reuses a
  failed id.
- After a tier runs, **Sonnet** renders every new skeleton to `.roadmap/specs/<id>.md` and a pure-code
  merge appends the units and edges. **Arc-completeness is post-hoc**: a tier says so, or the boundary
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

**Persistence.** At a **continuation** boundary the conductor runs five Haiku verbatim-writers, all
awaited before the next dispatch and idempotent by wave-N markers: `persist-plan` (the merged
`plan.json`) → `bank-debt` (a `<!-- wave N -->` section in `debt.md`, **always stamped**, even "no new
entries") → `log-append` (a `## Wave N` section in `architect-log.md`, **tier-3 only**) →
`move-feedback` (this wave's evidence + actioned/dismissed user notes → `feedback/triaged/N/`) →
`persist-state` (the **consumed** state: `boundary` removed, `debt` cleared). An **early return**
persists only `state.json`, with `boundary` and `debt` left **INTACT** — the root consumes them.
In **issue mode** these writers also project to GitHub: `bank-debt` creates/updates `roadmap:debt`
issues (find-or-create by a stable marker) for the wave's un-swept debt instead of writing `debt.md`,
`move-feedback` closes/comments the triaged `roadmap:bug` issues instead of moving files, and
`issue-new` opens a `roadmap:unit` issue for each new fix-unit/respec. All best-effort (`gh-sync`).
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
  wave, wavesRun,
  state,             // final persisted state (incl. the `conductor` block)
  plan,              // the conductor's merged working plan
  spendDelta,        // per-key nonzero delta of state.spend vs the launch state
  /* + reason-specific brief: */
  // contingent-replan → { edges }
  // contract-amendment → { debt, contracts }
  // needs-user        → { question, context }
  // arc-complete      → { arcSummary, stuck? }
  // max-waves         → state.boundary restored, marked {triaged:true, wave}
  // arc-stalled       → { arcSummary, outstanding, stuck }
  // agent-budget      → { nextWaveUnits, estimate }
  // root-triage       → { pendingFeedback, quarantined }
  // triage-degraded   → { pendingFeedback, quarantined }
}
```

**`agent()` resolves to `null` on a terminal API error — it does not throw.** A bare `.catch()`
therefore does not cover that path, so every `run()` whose result is *dereferenced* must go through
`runOr(fallback, …)`. A dead **census** degrades to an empty one (the authoritative evidence is the
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
| `codexSteerModel` | `'haiku'` | Steering-agent tier; `'sonnet'` if Haiku proves unable to drive launch/poll/kill/verify (probe P2) |
| `codexMaxConcurrent` | `4` | Counting semaphore on concurrent codex processes (one OpenAI account behind them all). Timing-only — resume-safe |
| `codexProfile` | `null` | `-p <profile>` (`$CODEX_HOME/<name>.config.toml`) when set |
| `fableEffort` | `'high'` | Effort for the frontier Fable judgment calls that adjudicate hard decisions — the plan-check and the mid-loop architect consult. Fable 5's `high` default; these fire only on the hard calls, so they run there rather than on the floor |
| `gateEffort` | `'high'` | Effort on forced Fable exit-gate calls (the frontier gate) |
| `implementEffort` | `'medium'` | Opus reasoning effort for the code-authoring pipeline (plan/replan/implement, the post-impl debt-fix sweep, + every fix loop). Opus 5 holds coding quality at `medium` at a fraction of the tokens (its `low`/`medium` punch well above prior models'); raise per-arc via `plan.config` if a workload proves effort-sensitive |
| `opusEffort` | `'medium'` | Effort for every other Opus call — boundary assessors (explorer/health/design), the adversarial review, the Opus-first plan-check and exit gate, and merge-conflict/integration fixes. Opus 5 review accuracy holds at lower effort; the paid-fixture `gate-bad` signal is the tripwire if a downgrade ever costs gate teeth |
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
| `fableEffort` | `'high'` | Effort for the Fable boundary agent (the respec/escalation arbiter) — Fable 5's `high` default |

**Spend direction when tuning:** extra frontier budget goes to the **planning side** (spec detail,
plan-checks, Phase-0 interrogation), never to more mid-flight touchpoints — gate non-convergence is
evidence of an under-specified plan, and the fix is a better plan. Frontier *saved* at the Opus-first
gate is simply saved: per-unit quality is held by the Opus gate, systemic quality by the between-wave
health check.

## Model tiers — the economic contract

| Tier | Does | Never does |
|---|---|---|
| codex (CLI) | ALL implementation: unit builds, fix rounds and adjudicated resumes (via `exec resume`), plus the read-only cross-model spec critique. Runs its own implement→test→fix loop inside the brief's pinned scope | Judgment: it never reviews, gates, plans the roadmap, or adjudicates its own escalations |
| `fable` | Plan pack, plan-checks for med/high-risk units (taste/overengineering charter) + escalations, escalated + audit-sample exit gates, rescue + spec-gap consults (Codex's escalation channel), wave replans, feedback/debt triage, the conductor's tier-3 boundary agent, integration review | Code, fixes, bulk text |
| `opus` | Unit plans (brief-authoring), Opus-first plan-check (low-risk singles) + exit gate, conflict resolution, the wave-tail runtime explorer + health assessor (incl. drafting consolidation fix-units), the conductor's tier-2 boundary triager | Implementation (Codex's) |
| `sonnet` | Roadmap normalization, dossier compression, feedback-batch compression, the conductor's skeleton→spec expansion | — |
| `haiku` | Codex steering (launch/poll/kill/disk-verify/report), git mechanics, running suites (incl. flake re-runs), state checkpoints, mirror advance / preview refresh, verbatim writing of dossiers / findings / the debt ledger, the conductor's census + persistence writers | Judgment |

**Root-only, never delegated down the ladder**: the Phase-0 plan pack, contingent replans, contract
amendments, needs-user calls, and the session integration review.

## Platform rules the scripts respect (keep respecting them if you modify them)

- `model:` explicit on **every** `agent()` call — omitted, agents inherit the main-loop model
  (frontier) silently. Same for any agent you spawn yourself; never a bare typed agent.
- `schema:` on every call — handoffs are validated structures; the scripts never parse prose.
- No `Date.now()` / `Math.random()` / filesystem in a workflow script. Prompts are deterministic per
  unit id + sha, so `resumeFromRunId` replays completed calls free.
- The built-in `isolation: 'worktree'` is fresh-per-agent-call — units share a hand-rolled worktree at
  `worktreeRoot/<unit-id>` instead; `worktreeRoot/__integration` is the merge checkout. Keep
  `worktreeRoot` outside the repo.
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
