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
  state.partial.json   # DIAGNOSTIC ONLY: a partial persist.mjs REFUSED to write over state.json.
                       #   Nothing reads it; never relaunch from it (see "Who writes .roadmap/").
                       #   Removed by the next persist that lands a WHOLE state.json
  quarantine/<unit>.md # dossiers written by the harness (codex writes the file; Haiku is the fallback)
  feedback/            # accumulated runtime evidence; triaged in batch at boundaries
    explorer/*.md      #   per-wave runtime exploration findings (wave-tail codex role, which
                       #   writes this file ITSELF — see "Who writes .roadmap/")
    health/*.md        #   per-wave code/test/structure/ergonomics health findings (codex role)
    health/*-flake.md  #   the flake band's re-run record (codex role, which writes this file
                       #   ITSELF; its own file, so the health role owns wave-<n>.md end to end)
    design/*.md        #   per-wave design-fidelity reconcile vs the cited comps (codex role);
                       #   written only on waves that merged a design-cited unit
    user/*.md          #   FILE MODE: the user drops notes here AT ANY TIME (copying TEMPLATE.md);
                       #   read at the next boundary — never an input to a running wave. ISSUE
                       #   MODE: users file roadmap:bug issues instead; this folder is unused.
    triaged/<wave>/    #   consumed items, moved here at triage; never re-triaged
  archive/<arc>/       # closed-out arcs
```

**Who writes `.roadmap/`.** No workflow script writes a byte of *state*: `persist.mjs` writes all of
that, after the run.
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

**A partial never regresses `state.json`.** Two partials are refused outright — parked in
`state.partial.json` beside it, with `state.json` untouched, on a
`PARTIAL-REFUSED stoppedAt=… why=… wrote=state.partial.json` line (still exit 2):

- `why=divergence` — the miss is marked `(out of journal order)`. **That is the REPLAY diverging,
  not the run failing:** the live run did not stop there, so its own returned state is further along
  than any prefix reachable here. (2026-09-02: a wave-1 halt was written over a returned wave-3
  state, and relaunching from that file would have re-forked every unit from the plan-pack tip.)
- `why=newer-on-disk` — `state.json` already holds a better record: a later wave, or the same wave
  written whole (no `partial` marker). A `partial` marker at the same wave is *this* partial, so
  re-persisting a crashed run stays idempotent.

**The cure for either is `--returned`, not a hand edit.** The run's return value is in the task
output; hand it over as a JSON file and the replay is skipped entirely, the value going through the
same writers (state, the plan-conflict check, `debt.json`, the `debt.md` and `architect-log.md`
sections, `skill-degradations.md`, both ledgers) — so nothing the run decided is lost:

```
node <skill dir>/persist.mjs --returned <that value, as a .json file> \
     --args '<the launch envelope>'          # --run / --script not needed; --args still is
```

The value may be a conductor `{status: "conductor-return", state, plan, …}` envelope or a
directly-launched harness's wave state — the same two shapes a completed replay produces. Persist
first, *then* investigate the divergence (a script edited since the journal was written is the usual
cause). Landing a whole `state.json` — by this route or by a replay that now reaches the end — also
**removes the parked `state.partial.json`**, and the `OK` line says `removed=state.partial.json`
when it did: the prefix is stale the moment a real state exists, and a stale one sitting beside a
current state.json is how the wrong file gets relaunched from.

**Journal order is the clock.** A script is a deterministic function of (args, agent results) only
*up to completion order*: the harness merges units through one serial chain in the order their
pipelines reach merge-ready, and each merge moves `integrationTip`, which every later prompt embeds
— so which unit finishes first decides what the rest of the wave is asked. The journal is written in
completion order, so the replay uses it as its clock: a lookup resolves only when the cursor reaches
that prompt's record, every earlier record having been consumed by its own lookup first, and pending
lookups wait. A record nothing asks for (a superseded launch's prompt in a resumed run, an agent
whose transcript carries no prompt) is stepped over once the run is quiescent, so the clock cannot
deadlock; a lookup for a record the cursor already passed is a real divergence and stops the replay
with `partial: {stoppedAt: "<label> (out of journal order)"}` — which is refused rather than written
over `state.json`, because a diverged prefix is behind the state the run itself returned (see the
refusal rules above). A nested `workflow()` child shares the journal and so shares the one cursor.

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

**Write it however your serializer likes.** Both pack documents are read at launch by a Haiku
courier, but the read command rewrites every JSON escape **sequence** to its own marker first
(`\"` → `@q@`, `\\` → `@bs@`, `\n` → `@n@`, `\t` → `@t@`, `\/` → `@sl@`, `\uXXXX` → `@uXXXX@`) and
the script reverses it before checking the file's `cksum` — so every escape, and every raw
non-ASCII glyph, survives transport intact: the courier carries prose with no backslash in it,
the quote of a `\"` pair sits inside its marker, and `\\\"` is two *different* markers. (Plain
text did not survive before 2026-09-04 — the courier had to double-escape each backslash inside
its own JSON report and dropped one level; the 0.15.0 per-backslash `@bs@` sentinel did not
survive 2026-09-14, when a courier doubled it before a quote, and probed unexplained it collapsed
the three identical markers of `\\\"` into one; base64 did not survive its first live run — a
model cannot transcribe 2 KB of high-entropy text. The per-sequence markers were probed on real
Haiku couriers against a 14 KB document carrying every escape form, three of three byte-identical.)
The one constraint left is **size** — see `state.json` below.

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
                                   //   runs it through the same verify → review → gate pipeline;
                                   //   the diff AT ENTRY is the unit's pinned scope, never growth.
                                   //   MUST NOT be the unit's own `unit/<id>` (hard-refused at
                                   //   plan validation — setup could delete its own source);
                                   //   anchor under a different ref (adopt/<id>) instead. A tier-3
                                   //   RESPEC may set it to `unit/<quarantined id>` so the
                                   //   replacement adopts sound work instead of rebuilding it.
    "supersedes": "..."            // set by the conductor on a respec: the quarantined id this
                                   //   unit replaced. Walked as a LINEAGE by the critical-path
                                   //   brake (a lineage quarantined twice returns to the root).
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
    "start": "npm run dev",        // server kind: long-running; the harness daemonizes it as
                                   //   `setsid nohup sh -c 'echo $$ > <pidfile>; <start>' &`.
                                   //   It is SHELL input, so `VAR=value cmd`, `&&` chains and
                                   //   pipelines all work — but a SINGLE QUOTE in it throws at
                                   //   plan load (it would close the wrapper's quote); use double
                                   //   quotes or a package script. Do not prefix it with `nohup`
                                   //   or `setsid` yourself. Log + pidfile at
                                   //   worktreeRoot/__preview.{log,pid}, outside every worktree
                                   //   so a mirror advance never touches them; the pid recorded is
                                   //   that detached shell's own, which is also its process group.
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
    "healthcheck": ""              // optional; failure marks the preview failed, NEVER gates.
                                   //   Retried after start for ~60 s of WALL CLOCK (not a fixed
                                   //   number of tries), so give the check its own timeout —
                                   //   `curl -m 5 -sf …` — or a slow one spends the window by
                                   //   itself. A stack that builds before it listens and needs
                                   //   longer must carry its OWN patient loop here: the window is
                                   //   a floor, not a wait.
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

**Keep it small — it is the only pack document that grows.** One courier copies the whole file at
launch and tops out near 24 K characters once its escapes become markers (about 35 KB of ordinary
state); past that the file is re-read over line ranges, and past about 100 KB the launch simply
cannot be vouched for and throws `pack-unreadable` (2026-09-03: a
145 KB state.json, three quarantine dossiers' worth of prose, could not be relaunched at all). So
**prose lives in files and state carries the path** — that is why a quarantined unit records
`dossierPath` rather than the dossier text, why degradations and escalations are `.jsonl` sidecars
`persist.mjs` appends rather than state fields, and why `debt` is this wave's items only. If you
are hand-editing state and find yourself pasting a paragraph into it, write the paragraph under
`.roadmap/` and reference it by absolute path: every tier that reads it is a model with a
filesystem.

Fields the scripts add:

- **`run`** — optional passthrough you record at launch (from the Workflow tool result). On a
  conductor run it identifies the whole multi-wave run, making same-session `resumeFromRunId`
  mechanical and forensics one `cat`.
- **`preview`** — `{ sha, status: "live" | "failed" | "none" }`, the green-tip mirror's position.
  `failed` never affects any unit outcome.
- **`boundary`** — present when the wave-tail boundary phase ran anything:
  `{ explorer, health, flake, design }`. Any job is `null` when it was off or failed; the whole
  block is **omitted** when no job ran or every job failed — its absence is the signal to run the
  explorer/health agents yourself. Two code-side annotations: `explorer.heldFindings` holds the
  findings the explorer attributed (`blockedBy`) to an in-scope unit that has not landed — they
  are out of `findings`, so no tier triages them until the unit lands, and the explorer's brief
  lists the unlanded units so it can attribute; `flake.unassessed: true` (with `flips` emptied)
  means every re-run exited non-zero — the band measured nothing about intermittence, the job is
  owed, and a `flake-unassessed` degradation says so. The band reports `exits` per run for this.
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
  attention go" table — and, since 0.14.0, its "how much of the run left Claude entirely" table:
  read the four Claude tiers *beside* `codex` + `codexRuns`, because that ratio is the whole point
  of the shift and the only place it is visible. `sonnet` now includes first-pass exit gates on
  low-risk units (see `gateModel`). Two legacy NAMES survive their literal meaning and are kept
  because the paid fixtures' round-ceiling graders and every resume journal key on them:
  `opusGateRounds` counts **first-pass** exit-gate rounds whatever tier `gateModel` sent them to,
  and the per-unit `rounds.opusGate` is the same count per unit. The tier that actually ran is in
  the per-tier counters, never inferred from those two names.
- **`debt`** — the imperfections surfaced *this wave only*. `.roadmap/debt.md` is the cross-wave
  accumulator.
- **`escalationStops`** — `{unitId: count}`, arc-cumulative. The only escalation state the run
  itself reads (the three-strikes brake, which must survive a unit re-entering in a later wave).
  The rulings themselves are append-only lines in `.roadmap/escalations.jsonl`.
- **`partial`** — written only by `persist.mjs`, and only when a replay could not reach the run's
  return value: `{stoppedAt: <agent label>}`. The state beside it is the last snapshot the script
  logged, so it is real but not final. Relaunch (`resumeFromRunId`) and persist again. A partial
  that would regress `state.json` is refused and parked in `state.partial.json` instead — that file
  carries the same marker, and is diagnostic only: nothing reads it, nothing should relaunch
  from it, and the next persist that lands a whole `state.json` deletes it.
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
  env-no-reaper | env-verify-blocked | feedback-unmoved | review-skipped | verify-unrun | dossier-write-fallback | health-skipped |
  flake-unassessed |
  spec-unwritten | spec-unrevised | codex-exec | codex-lifecycle |
  codex-timeout | codex-uncommitted | codex-unavailable | codex-usage-limit | codex-role`.
  Codex-kind entries name the `__codex/<unit>/<step>/` (or `__codex/roles/<label>/`) artifact
  directory to read; `codex-role` is a role that produced no result after its one retry — its
  caller got `null`, and nothing was halted on account of it. Four 0.14.0 kinds are what the
  harness *did about* such a null on the roles that have a coded answer: `review-skipped` (no
  pre-gate digest, so the exit gate reads the raw diff at Opus whatever the risk — less evidence
  buys more Claude, never less scrutiny), `verify-unrun` (the unit is recorded `blocked`, **not**
  quarantined: nothing about it was judged, its commits are intact, and the wave-start loop
  re-opens it next wave), `dossier-write-fallback` (codex did not write the quarantine dossier,
  so the Haiku writer it replaced runs once — a dossier must exist) and `health-skipped` (no
  wave-tail health report, so an empty draft set at this boundary means UNASSESSED rather than
  "nothing to consolidate"). `codex-exec`
  (codex exited non-zero) / `codex-lifecycle` (**no exit-code file** — nobody observed the run
  finish, so its exit status is unknown, not bad) / `codex-timeout`, with surviving commits, mean
  the branch was judged on its merits (a dead process is not a dead unit); the six halt kinds
  (`codex-unavailable`, `codex-usage-limit`, `env-pids-exhausted`, `env-no-reaper`,
  `env-verify-blocked`, `platform-outage`) accompany a wave halt (see `state.halt` below); `env-unprobed` means a host
  fact could not be read at all, so the wave ran unguarded on that axis — an unknown is never
  treated as a breach; `commit-probe-unknown` means an implement report AND its commit probe both
  died, so whether the branch holds work is unknown and the unit parked rather than being
  quarantined for building nothing; `codex-unavailable` is also emitted MID-WAVE by the codex
  backend breaker — the codex counterpart of `platform-outage`: ≥2 consecutive codex runs across
  DIFFERENT units or roles failing with `turn.failed` and the same HTTP status is a provider
  outage, not N unit defects, so dispatch halts and the affected units PARK (`pending` +
  `parked`) instead of being quarantined or blocked;
  `scope-growth` means a diff reached beyond its pinned envelope and the
  gate adjudicated it — re-emitted only when the diff reaches a file it has not already reported,
  so one incident is one row. A **`tip-regressed`** entry accompanies a thrown wave: the recorded
  integration tip (`state.json`'s `integrationTip`) is not an ancestor of the branch, so nothing was dispatched (see the one-way tip
  reconcile). **`quarantine-refused`** means a verdict asked to quarantine a unit git says already
  landed — it was recorded `merged` instead, and the verdict was reading stale or cached state.
  **`no-launch-id`** means the root omitted `args.launchId`, so the environment probes ran unsalted
  and a resume can serve them from cache. A `verify-blocked` entry means a verifier RAN and found the
  tooling broken: the first one for a unit records it `blocked` (commits intact, re-verified next
  wave), a second on a later wave quarantines it, and either way the entry carries the host's load;
  an `env-verify-blocked` entry means two units hit that in ONE wave, which is a host fact and
  halts the wave; a `shared-red` entry names the one spec several units
  failed on and the units it hit; a `duplicate-draft` entry names drafts a boundary filed twice in
  one batch, which are dropped rather than renamed into extra units.

  **Host load is recorded, never gated on.** Every test lane reports `loadavg1` and `cpuCount`
  (`cat /proc/loadavg`, `nproc`) into its verify result, the flake band reports one `loads` sample
  per run, and the `verify-blocked` and `codex-timeout` entries cite them. The wave's own
  concurrency is what produces the load, so waiting on it would be waiting on our own siblings —
  `gateMaxConcurrent` is the actual brake. The numbers exist so a wall-clock verdict is auditable
  after the fact instead of a mystery. The same fact is stated to every tier that writes or
  adjudicates spec text (both plan-checks, both exit gates, the verifier, and the conductor's
  boundary/spec-revise tiers) as the **host bar**: a quiet host, the absence of sibling processes,
  or a wall-clock ceiling may never be an acceptance clause or a precondition for verification —
  the preview dev-stack is always live and lanes overlap by design, so such a clause is
  unsatisfiable by construction and is a spec defect for the adjudicating tier to resolve through
  its verdict. Arc-observed 2026-09-04: an Opus plan-check minted one, and the unit was quarantined
  when the verifier could not satisfy it.
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
(dependency quarantined, or this unit's verification never ran / could not run) / `deferred`
(beyond cut line). A `blocked` unit keeps its commits and is re-opened at the next wave's start
once its blocker is gone; its branch is then ADOPTED, not rebuilt. Dependents launch only when every
dependency is `merged`. While `running` a unit also carries a `stage` field
(`setup | plan | implement | polish | gate | merge-queue`) for crash forensics; a terminal status
replaces the whole record — carrying forward `rounds` (`{fix, opusGate, gate}`, the per-unit
round tally that makes runaway revision loops measurable; the paid fixtures assert ceilings on
it — plus `verifyBlocked`, the one tally that counts across WAVES, since the second blocked verify
for a unit is what quarantines it) and, on any halt or park, `parked: true` (`status:'pending'` + parked = re-enters by ADOPTION
next wave: its branch commits are its own prior progress, never unexplained has-commits).
A `quarantined` record carries `reason` plus **`dossierPath`** — the absolute path of
`.roadmap/quarantine/<id>.md`, never the dossier prose. The file is the record and every reader of
it (the Fable boundary tier, you) has a filesystem; state carrying the text instead is what made a
145 KB `state.json` unlaunchable in 2026-09-03.
`units[id].codexSession = {id, cwd, wave}` is forensics only — session ids are nondeterministic
and never enter a prompt; fix prompts reference the session-id FILE. The wave state also carries
**`codex`**: `{probed, available}`, and — only when the wave halted — **`halt`**:
`{reason, codex?, env?, platform?}`. One record for every wave-level brake; `reason` is the winning
slot (precedence `platform > env > codex`, decided in the harness so nothing downstream duplicates
it) and it IS the conductor's early-return reason, read verbatim by the root:

| `reason` | who set it | how the root clears it |
|---|---|---|
| `codex-unavailable` | the per-wave `codex-probe` failed — no CLI, no "logged in" line, or its bounded `codex exec … "reply pong"` **smoke** exited non-zero (the CLI and the credential can both be fine while the Codex BACKEND is down) — **or** the mid-wave breaker tripped: ≥2 consecutive codex runs on DIFFERENT units/roles failed with `turn.failed` and the same HTTP status | read the degradation's `what`: a CLI/credential failure means `codex login` (or `--device-auth` headless) then relaunch; a smoke or breaker failure is the provider, so no login helps — wait out the outage, then relaunch |
| `codex-usage-limit` | a codex run reported a usage/rate limit | wait out the limit window, then relaunch |
| `env-pids-exhausted` | the host preflight: under 20% of the pid cgroup free | free the pids (usually: recreate the container), then relaunch |
| `env-no-reaper` | the host preflight counted ≥ 1000 zombie processes — orphans are not being reaped | recreate the container with a reaping PID 1 (compose `init: true`); if the box is genuinely healthy, set `config.envPreflight: 'off'` |
| `env-verify-blocked` | two units' verifiers reported `blocked` in one wave — their tooling could not run at all (a black-holed registry, a dead network, a missing global tool) | read the verifiers' failure output in the `verify-blocked` entries, fix the host, then relaunch |
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

Every ready unit runs: worktree setup → **codex implementation plan** (the implementer plans its
own work, read-only, brief-authoring: written for an implementer that cannot ask questions) →
codex spec-critique (read-only, cross-model, best-effort) → **plan-check** (Claude, unchanged) →
**one background `codex exec` build** (the unit's whole implement→test→fix inner loop, driven by a
Haiku steering agent) → **codex verify**/fix loop (bounded; fixes ride `codex exec resume`) →
**codex pre-gate review** (read-only, cross-model, producing the digest the gate eats) → **exit
gate** (Claude) → serial merge onto the integration branch with the full suite as the gate. Then,
at the wave tail, the **boundary phase**.

**The 0.14.0 division of labour, in one line: Claude decides, Codex drafts and executes, Haiku only
couriers.** Every judgment surface that can *reject* work stays Claude — the plan-check, both exit
gates, the escalation ladder, the consults, the merge and its suite gate, and the boundary TRIAGE
that rules on what the wave-tail roles found. What moved onto the role adapter is what a
shell-capable executor does better and cheaper: planning its own work, running the spec's lanes,
reading the diff to produce a review digest, writing the quarantine dossier, and every wave-tail
boundary job — explorer, health, flake and design. The economics behind
it: Claude Code weekly limits are the scarce resource, Opus calls dominate that spend, and codex
quota is plentiful. **Fable's allocation is untouched** — boundaries, consults, the frontier gate
and the high-risk plan-check are exactly where they were.

**Codex is THE implementer — there is no Claude implementation lane.** The steering agent writes
`brief.txt` + a strict-mode `--output-schema`, launches codex in the background (`setsid` +
a self-written pidfile, the preview-process idiom — see *The process outlives its steerer, safely*
below for the exact line and why every character of it is load-bearing), polls sleep-free, kills at `codexTimeoutMin`, verifies the
work ON DISK (exit-code marker, commit count, porcelain, the brief's own `DONE` marker), reads
back only an allowlist (final message head, session id, one usage line, an error grep, git truth
— never a transcript), and emits the same S.impl-shaped report the pipeline always consumed.
**S.impl is the seam**: verify, gates, consults, merge and every trigger work unchanged, and
nothing downstream learns who wrote the code. Artifacts live under `<worktreeRoot>/__codex/<unit>/
<step>/` — outside the repo, so the NOROADMAP write-bar and merge fence are structurally
unreachable; degradations name the directory to read. The Claude adversarial review stage is still gone:
the build already ran its own test-fix loop, and the exit gates carry the hunting clauses with
authority. What 0.14.0 puts back in front of the gate is a **cross-model** read — a codex role, the
other model family, producing a digest the gate adjudicates — which is a different thing from the
stage that was removed: it costs no Claude tokens, it cannot issue a directive, and its output is
consumed as evidence rather than re-derived by the gate. Failure policy: exit≠0/timeout with commits ⇒ judge the branch (a dead process is not
a dead unit); with no commits ⇒ ONE retry — for the build step AND for every fix round — which
first **reaps** the previous pid (TERM, wait, KILL, wait for the exit-code file) and tells codex in
its brief that the earlier attempt is dead and a live sibling is a harness bug to report as
`blocked`; then the commit-probe/quarantine path. A usage/rate limit or a failed per-wave
`codex-probe` (three commands: `--version`, `login status`, and a bounded read-only
`codex exec … "reply pong"` **smoke** whose pass test is its exit code) ⇒ **hard stop** — new
dispatch halts, in-flight units **park**
(`status:'pending', parked:true`, re-entering by adoption next wave), the wave state carries
`halt.codex`, and the conductor early-returns the reason to the root for the human to re-auth or
wait out the window. Never a quarantine, never a substitute implementer. An outage that STARTS
mid-wave is caught by the **codex backend breaker** (the codex counterpart of `platform-outage`):
≥2 consecutive codex results on DIFFERENT units or roles carrying `turn.failed` and the SAME HTTP
status set `halt.codex = 'codex-unavailable'`, and every codex-shaped dead end in the unit pipeline
— a dead plan role, a dead replan, a build that came back with the outage on it — then PARKS
instead of quarantining. Any codex result without the signature clears the run, and two failures
from the same unit are one unit's story: distinctness is by id.

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

Callers today: the **spec critique** (`codex-spec-review:<id>`), the per-unit `plan`/`replan`,
`verify`, pre-gate `codex-review` and `dossier-write` roles, and the four **boundary roles** — the
wave-tail runtime `explorer`, the `health` assessor, the `flake` band and the `design` reconciler,
which moved off Opus (the flake band off Haiku) in 0.14.0. Each boundary role runs in the tree it
judges (explorer and design in the preview worktree, which is where a shell may reach the running
product; health and flake in the integration worktree), declares `workspace-write` because each
writes exactly one file — its own report under `.roadmap/feedback/<job>/wave-<n>.md`, or
`health/wave-<n>-flake.md` for the flake band — and carries every other restraint in its brief,
since `codexSandbox` overrides the declared intent anyway. `codexBoundaryTimeoutMin` (45) is their
deadline rather than the 20-minute `codexRoleTimeoutMin`: driving a product end to end, or running
the full suite N times over, is real work and not a one-artifact errand. On `null`: explorer, flake
and design go **owed** exactly as a skipped job does,
and health additionally records a `health-skipped` degradation — without it an empty draft set reads
to the triager as "nothing to consolidate" rather than "nobody looked".

**The process outlives its steerer, safely.** All three launch sites — the codex build, the
`COMMAND R` resume, and the preview server — share exactly one thing, the **detachment idiom**:

```
setsid nohup sh -c 'echo $$ > <pidfile>; …' &
```

That is the whole of what they have in common, and it is deliberate: what follows the `;` differs
because the two kinds of process want opposite lifetimes.

The two **codex** sites add a deadline and a reaped exit status, so a dead steering agent can no
longer leave a detached codex running unbounded on an OpenAI seat already handed to the next unit:

```
setsid nohup sh -c 'echo $$ > <dir>/codex.pid;
                    timeout -k 30 <timeoutMin×60> codex exec … & CPID=$!;
                    ( … session-id capture …  ) &        # BUILD SITE ONLY
                    trap "kill -TERM $CPID; T=1" TERM;
                    wait $CPID; RC=$?; if [ -n "$T" ]; then wait $CPID; RC=$?; fi;
                    echo $RC > <dir>/exit-code' &
i=0; while [ ! -s <dir>/codex.pid ] && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i+1)); done
```

The trailing loop is the price of the detached shell writing its own pid: the write is now
asynchronous to the launching shell, and the steerer's very next call reads the file (`tail --pid`,
`kill -0`, the re-dispatch guard). The bounded wait (≤ 10 s) keeps the launch command from returning
before the pidfile is non-empty, so an empty file can never be read as a dead pid.

The **preview** has none of that half — no `timeout`, no trap, no `wait`, no `exit-code` file — and
must not: a dev server is *meant* to outlive the wave that started it, so there is no deadline to
enforce and no exit status to collect. Its whole line is
`setsid nohup sh -c 'echo $$ > <preview pidfile>; <plan.preview.start>' > <log> 2>&1 &`, and its
liveness is the pidfile and the healthcheck alone.

The **build site alone** carries the extra background subshell: it polls `events.jsonl` for the
first `"thread_id"` and writes it to `<dir>/session-id` (once, up to 120 tries a second apart). It
is a *subshell* precisely so the capture runs while the main line is already blocked in `wait`, and
it lives at the build site because that is the only launch that starts a new codex session — the
resume site consumes that file (`codex exec resume "$(cat <dir>/session-id)"`) rather than writing
it, and a steering agent never captures it by hand.

**The detached shell writes its OWN pid, as its first act — never `echo $! >` after the `&`.** The
steering agent's Bash shell has job control on, so a backgrounded job is *already* a process-group
leader, `setsid` must FORK, and `$!` names a parent that is dead within a second. Every liveness
fact then hangs off a corpse: 2026-09-02 that cost 3 waves and 14 of 20 units, quarantined on deaths
that never happened, while each "reattempt" launched a second codex into a worktree the first was
still writing. After `setsid`, that `$$` is also the pgid `kill -TERM -- -<pid>` targets. The `trap`
and the conditional second `wait` are what make a genuine reap reach *codex*: `timeout` puts itself
in its own process group, so a group kill stops at the detached shell unless the shell forwards the
signal on. The re-wait is gated on the trap's own flag `T`, **never on `RC > 128`**: only a
trap-interrupted `wait` leaves the child unreaped, so only there does waiting again collect its real
status. A child killed outright — an OOM `SIGKILL`, or `timeout -k` escalating — is already reaped
and returns a true 137, and re-waiting that pid reports whatever the shell remembers of a finished
job instead. `RC > 128` cannot tell the two apart; the flag records which actually happened.

The steerer's liveness rule is the other half: **an absent `exit-code` file means RUNNING, never
dead** — `exitCode:-1` may only be reported after `kill -0 $(cat codex.pid)` fails, and elapsed time
is never evidence. And the steer prompt is idempotent by construction: if `<dir>/codex.pid` already
exists it attaches instead of launching, so any re-dispatch of the same prompt (a schema retry, a
salvage, a replay) cannot put two codex processes in one worktree.

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
- **Pre-gate review** (`codex-review:<id>`, read-only). A codex ROLE — the *other* model family —
  reads the full diff once against the spec, the frozen contracts, the conventions contract and the
  pinned scope, and returns a **digest built for the gate to consume**: `specFindings` (criteria
  the runnable checks pass and the spec's PROSE still forbids — the `gate-bad` class),
  `conventionFindings` (a catalogued shared helper reimplemented inside the diff — the
  `gate-convention` class), `contractTouches`, `scopeNotes`, an `unread` honesty list, and a
  `verdict` (`clean`/`concerns`/`blocking`) + `risk` grade. This is **not** the pre-0.13 adversarial
  review stage (RATIONALE §17): that one graded the same diff the gate re-read with authority and
  only widened it. This one is what makes the gate's diet affordable, and its two scalars are read
  by the *script*, not by a prompt.
- **Exit gate** (once the fix loop converges). **First-pass tier by `gateModel`** — Sonnet for
  low-risk, Opus for med/high: a fresh adversarial Claude (not the implementer, not the reviewer)
  grades each acceptance criterion and returns `approve` / `revise` (a mechanical fix it specifies
  itself → free codex fix → re-verify → re-gate, bounded by `maxGateRounds`, or `maxGateRoundsLarge`
  past `largeDiffFiles`; every later round re-checks its own directives and banks new
  non-correctness observations, and the frontier loop ends in a closing approve/quarantine round
  on the last fix) / `escalate`, naming
  the trigger: `stuck`, `hard-tradeoff`, `foundational`, or `oversight`. **The gate diet:** it
  adjudicates the review digest, the lane ledger, this wave's scope precedent and the contract
  notes; the **raw diff stays in front of med/high-risk units**, and a low-risk gate starts from
  `git diff --stat` plus the full diff of every file the digest names, expanding on the least
  suspicion. Two conditions refuse the diet outright and put **Opus back in front of the raw diff**:
  no digest at all (the reviewer died → a `review-skipped` row), and a digest the reviewer itself
  graded `blocking` or high-risk. That is the anti-rubber-stamp rule, and it is code, not prose —
  **the gate must be able to disagree with the review**, and a gate that cannot see the diff cannot.
  A digest is handed to both gates as *evidence to adjudicate, never a verdict and never coverage*.
  The **Fable** gate (`approve | revise | quarantine`) is reached unconditionally when
  `exitGate: 'always-fable'`, `risk: high`, the diff touches a frozen contract surface, or the
  unit falls in the deterministic `gateAuditRate` sample — **unchanged by 0.14.0**. First-pass
  non-convergence also falls through to Fable.
- **Verify — a codex role, and three outcomes, not two.** One brief serves the polish loop and
  every gate re-verify (they only ever differed in tense), and the verifier reads the
  acceptance-check commands out of the **spec itself** rather than being handed a transcription of
  them. It keeps its `gateMaxConcurrent` slot: a codex lane spends the box's cores exactly as a
  Haiku one did. `LOAD_CMDS` stays inline in the brief rather than becoming a second courier call —
  the number that matters is the load *while* the lanes ran, which only the process that ran them
  can sample. A verify that never *ran* (the role produced nothing after its retry) is **not** a
  verdict: the unit is recorded `blocked` with a `verify-unrun` row and re-enters dispatch next
  wave — deliberately not the env-blocked quarantine below it, because `blocked:true` is a verifier
  that ran and found the tooling broken, while a dead role is a fact about codex.
  Cheapest-first: lint/typecheck the changed files → then
  **exactly the acceptance-check commands the spec names, verbatim, in order**. Every command and
  its exit code comes back in `verify.lanes` with the `expectedExit` its spec clause states (0
  when it states none), and `pass` is true only if every lane's exit code equals its expected one
  — a clause that requires a command to *fail* is satisfied by exactly that failure (2026-09-14: a
  bare "MUST exit 2" lane exited 2 and the unit was quarantined "verification never passed";
  `EXIT_BAR`, carried by every spec-writing and spec-adjudicating tier, says to write such a
  clause as an exit-0 command in the first place).
  Substituting a narrower or cheaper lane is the failure this closes (a verifier ran `test:unit`
  where the spec said `test:ci` and left a red seal invisible for a whole unit), so **both exit
  gates check the lane ledger against the spec's list before weighing anything else** — a named
  check missing from `lanes` means UNVERIFIED whatever `pass` says. The script cannot assert
  coverage itself: the commands live in the spec markdown, not in `plan.json`. The full suite runs
  **only at the merge gate**, never in the fix loop. Errors are reported verbatim. The third outcome is **`blocked`** — the
  tooling itself couldn't run (missing dep, broken command, env failure). A blocked verify never
  enters the fix loop, and it is never a verdict about the unit: the **first** one records the unit
  `blocked` (commits intact, no dossier, re-verified next wave), a **second** on a later wave
  quarantines it with an *environment* dossier, and **two distinct units blocked in one wave** halt
  the wave on `env-verify-blocked` — tooling that cannot run for two units is a host fact (a
  black-holed registry, a dead network, a missing global tool), not two unit defects. Arc-observed
  2026-09-04: `pnpm audit --audit-level high` inside `pnpm verify` hung on a black-holed registry
  POST and the first unit to reach it was quarantined for it. Prevention is the `provision` block.
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
- **A merge is not merged until git says it is reachable.** After the suite passes,
  `merge-reach:<id>` judges **reachability, and nothing else**: the unit branch must be an ancestor
  of the integration branch and the reported head sha must be reachable from it, both by exit code,
  and only then are `status: 'merged'`, `mergedAt` and the new integration tip written. Where HEAD
  points is *reported* in the same probe but decides nothing — it rides along in the quarantine
  reason as evidence. (The merge prompt still has to put HEAD on the branch first: that is how the
  result becomes reachable, not a separate thing to grade afterwards. Demanding attachment *at
  probe time* false-negatived a clean, landed merge in a paid run.) A merge left where no branch
  can reach it is quarantined with both decisive exit codes leading its reason — the
  `quarantine-refused` note truncates that reason at 120 chars, so the evidence goes first — and
  the branch is left intact to re-merge.
- **The wave-start tip reconcile is one-way.** The integration-worktree setup courier reports the
  exit code of `git merge-base --is-ancestor <the state's integrationTip> <integration branch>`. The live tip
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
  report text in its prompt, and banks a debt entry whose *kind is decided in code*: `'contract'`
  — which routes the boundary straight back to you, because the amendment is yours alone — only
  when the verifier reported `contractSurfaceTouched` or the report names a contract file;
  otherwise a **major non-contract** item, because the channel accepts any "the spec says X"
  disagreement and the gate has already adjudicated it (2026-09-14: a missing test assertion
  returned the whole arc for an amendment). The pending report settles once the pre-gate review
  exists, or when the unit's result lands, whichever comes first — never dropped.
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
  **health assessor** against the integration tip, and full-suite **flake re-runs** (`flakeReruns`;
  a null leaves the job `owed`, exactly as before). All four boundary jobs — explorer, health, flake
  and the design reconciler — are **codex roles** (0.14.0; the three investigators were Opus and the
  flake band Haiku through 0.13.x); their results land in the returned state's `boundary` block, and
  each role writes its own `feedback/{explorer,health,design}/wave-<n>.md` rather than paying a Haiku
  transcriber for it (`design/` only on waves that merged a design-cited unit). The flake band's
  record is its own file, `feedback/health/wave-<n>-flake.md`, so two writers never share the health
  report's path.

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

### The courier contract (`courierRun`, and every closed list that isn't one)

A courier is handed a **closed list of exact commands** and returns their **exit codes and verbatim
output**; the *script* judges. Three rules make that hold, and all three are code, not prose:

1. **The working directory is composed into every command.** Each numbered command goes out as

   ```
   cd '<where>' && ( <cmd> )
   ```

   (`cdGuard`, mirrored in both scripts). Because the guard is *in the command*, the courier prompt
   tells the courier not to `cd` or `pwd` first — there is nothing left about its own location to
   prove. A courier that ignores the guard anyway produces a non-zero exit of that numbered command
   — which the stop-at-first-failure rule already handles — instead of a plausible answer from the
   wrong repository. `where` is **required**: an empty or undefined path throws at
   compose time, in `cdGuard` and again in `courierRun`, because an undefined path interpolated into
   a prompt is precisely how an agent ends up improvising in its own cwd. `gitProbe` composes the
   same guard.
2. **Results are positional.** `results[i]` corresponds to `commands[i]`; the courier reports
   `{exitCode, stdout}` and **never echoes the command text back** — the script already has the list
   it sent, and anything that needs to name a command in a degradation detail composes it from that
   list (`courierShape`'s `detail` does exactly this, from the *unwrapped* command, so the guard
   never leaks into an operator-facing message).
3. **Couriers carry no identity check at all** (0.14.0). STRICT's `pwd`/`--show-toplevel` proof —
   still used for the free-form prompts where the script never composes the destination
   (codex steerers, gh projections, spec/dossier writers), though **inside** the command it guards
   since 0.14.0: the Bash tool's working directory does **not** persist between tool calls, so an
   earlier `cd` is worth nothing and "cd first, then prove you are there" was asking for something
   the tool cannot do (`wf_318afa1b-e9d`). What STRICT states now is that every command must be
   self-contained — `cd '<path>' && …` or an absolute path — and that the proof rides in the same
   command as the work. It used to lead every courier prompt too,
   and it was the wrong check for one: `cdGuard` already names and enforces the destination, so a
   courier proving its *own* starting cwd first is pure theatre. `wf_318afa1b-e9d`'s
   `provision:integration` courier took it literally — ran only `pwd`, saw the workflow session's
   own shell cwd, and reported a fabricated "working directory mismatch" without ever running the
   composed command. The courier preamble now says the opposite: don't `cd`, don't run `pwd`, don't
   inspect or verify anything first — every numbered command already carries its own guard.

Why: in the paid conductor fixture `wf_106cdf59-c5f` the `preview-worktree` courier never `cd`'d,
ran the whole list in the orchestrator's own source repo, and `git worktree add --detach <prevWt>
<sha>` failed with "invalid reference" against a repository that had never heard of that sha; a
setup courier in the same run reported that repo's HEAD as a unit branch's tip and the unit was
quarantined. The same transcript shows `/results/0/command: must NOT have more than 300 characters`
— the echoed command overrunning its cap and burning the call's schema retries. Both are the RATIONALE
§19 failure class: a fact the script could compose was left to model compliance.

**Every step that runs a shell command is a courier** (0.14.0). The list, exhaustively:

| step | label | what the script judges |
| --- | --- | --- |
| integration branch + worktree | `integration-worktree` | HEAD sha; `is-ancestor` exit, printed by the shell |
| unit worktree | `setup:<id>` | read-back `rev-parse HEAD` vs the base, `rev-parse --abbrev-ref HEAD` vs `unit/<id>` |
| adopted branch tip | `adopt-tip:<id>` | the sha, pre-captured before setup can recreate the branch — the worktree must **equal** it at the initial fork, and (on re-entry of an adopted unit, whose branch has since grown fix commits) must merely **contain** it, `merge-base --is-ancestor` on the `setup:<id>` list |
| provisioning | `provision:<id>` | every copy + the plan's setup command, exit codes |
| preview worktree | `preview-worktree` | can that tree resolve the tip (`cat-file -t` → `commit`) |
| preview bring-up / mirror | `preview-setup`, `mirror:<sha>` | read-back HEAD vs the target |
| host + codex health | `env-probe:wN`, `codex-probe:wN` | the numbers, the `/logged in/i` test, the smoke's exit code |
| commit probe | `commit-probe:<id>` | `rev-list --count` > 0, or `unknown` |
| `.roadmap/` strip | `strip-roadmap:<id>` | exit codes of a list carrying `-- .roadmap/` on every command |
| git facts | `merged-probe:`, `setup-commits:`, `merge-reach:` | `gitProbe` — every command runs, exit codes only |
| feedback archive (conductor) | `move-feedback:w<N>` | the closing `ls -1` of `triaged/<N>/` vs the list it sent |

What stays **free-form**, and why: the **codex steerers** (they launch and supervise a process and
judge its artifacts), the **merge/resolve/integration-fix** agents (they run a project's test suite
and resolve conflicts semantically), the **`gh` projections** (`issue-running:`, `issue-sync:`, the
conductor's census and triage sweeps — an exact-marker search returns a *candidate*, and deciding it
is a model's job), and the **spec/dossier writers** (they write prose a model authored). Each names
its working directory explicitly in the first sentence so STRICT's identity test has something to
bind to — including `steerCodex`, which composes its own "your cd target is `<worktree>`;
`<artifactDir>` is scratch, not a checkout" line for every step rather than leaving it to one
caller's preamble. Everything a free-form prompt *names* is self-contained too: every composed git
command carries `-C '<path>'`, every composed `gh` carries `cd '<repo>' &&` (gh has no `-C`, and
without `--repo` it reads the repository out of the working directory), and a project suite command
is handed over as `cd '<worktree>' && <command>`.

Why the roster closed: paid conductor fixture `wf_c6971376-1a5`, the run after the guard above
shipped. Two free-form steps survived it, and both went wrong the same way.

* `provision:preview` never `cd`'d, printed `/workspaces/roadmap-orchestration` from
  `git rev-parse --show-toplevel` **without reporting it** as the failure STRICT calls it, and then
  improvised its way to `cd /workspaces/roadmap-orchestration && git worktree add <prevWt>` — no
  `--detach`, no base sha, in the orchestrator's own checkout. That created a `__preview` *branch*
  here and left the path registered as a worktree of two repositories, so both waves'
  `git checkout --detach <tip>` died with "fatal: unable to read tree". Nothing in its brief
  mentioned worktrees; the *goal* ("provision this checkout") is what let it reach for one.
* `setup:consolidate-stats-gcd` dropped the `cd` prefix off the commands that mattered, gathered
  every "proof" that its fork base did not exist (`git branch -a`, `git cat-file -t`, a
  `--oneline | grep` of an 8-character sha against 7-character output) **in this repo**, and forked
  the unit from the fixture's `main` HEAD instead — quarantined as "wrong base (got `c4b03e36…`,
  expected `fb023153…`)". The sha existed; another agent had read it off the integration worktree
  two minutes earlier.

So the *case* a setup takes is chosen in code from `merged-probe`/`setup-commits` exit codes before
any command is composed; the one command that case calls for is composed by the script, with the
"if the worktree is already live, keep it; else add it" branch written as **shell**
(`test -d … && … || …`) so crash re-entry is never a courier's choice; and the base and branch come
back from `git -C '<wt>' rev-parse …`, which the script compares. `already-merged` and `has-commits`
are no longer *states an agent reports* — they are the script's reading of git, and a `has-commits`
unit is quarantined before a single worktree command exists. The preview's idempotency guard changed
with them: `git worktree list --porcelain | grep -qx 'worktree <path>'` cannot tell which repository
a path now belongs to, and a stale record is exactly what suppressed the repair for a second whole
wave. It asks the question the next step actually needs — can this tree resolve the tip? — and
rebuilds when it cannot.

**After a courier fails, the script degrades; it never re-prompts the same agent to make it work.**
The one retry that exists is script-*dispatched*, with a *different* list (the preview sweep), and
only when the detach already succeeded.

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
  //             The read command rewrites every JSON escape sequence to its own marker (`\"` ->
  //             `@q@`, `\\` -> `@bs@`, `\uXXXX` -> `@uXXXX@`, …) and the script puts them back —
  //             so escapes travel safely and no serializer setting is your problem. What still
  //             is: SIZE. See the two documents' own sections below.
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
| — | return `contract-amendment` | any **non-`rebanked`** `kind:'contract'` debt this wave (a `rebanked` item is a ghost of a finding the branch already resolved — it banks with the rest, it just never escalates). The harness banks a `contractMismatch` report as `kind:'contract'` only when it is **corroborated** — the verifier reported the diff touches a frozen surface, or the report names a contract file; otherwise it banks as a *major non-contract* item (the forced frontier gate already adjudicated it), and no reporter may set `kind:'contract'` on a debt item itself |
| — | return `critical-path-stalled` | an in-scope quarantined unit whose **lineage** (itself plus the units it `supersedes`, transitively) already holds a quarantine, while in-scope, non-terminal units still depend on it — the tier-3 respec ran once and produced the same outcome, so another boundary here would only mint side work; `{stalled: [{id, lineage, dependents}]}` |
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
  code from the skeleton and written verbatim by Haiku through a quoted here-doc, then **verified by
  `cksum`** — the courier reports what `cksum < <file>` printed and the *script* compares it with
  `cksumOf` of the bytes it composed, because an `ok:true` from a cheap writer is not evidence. A
  mismatch buys one resample under a deliberately **differing** prompt (so `resumeFromRunId` cannot
  serve the bad sample back); after that the skeleton never reaches the merge — it is degraded
  (`spec-unwritten`) and banked as debt for the next boundary to re-draft, because `specs/<id>.md`
  is the authority the planner, Codex and both exit gates build and grade against. **Arc-completeness is post-hoc**: a tier says so, or the boundary
  produced no new units and no spec revisions. Both paths are then filtered through a satisfiability
  census — if any in-scope unit is still non-terminal *and* dispatchable, the return is `arc-stalled`
  instead, carrying `outstanding`. Units wedged behind an unresolved quarantine can never move, so
  they do not block the close; they ride back in `stuck`.

**Contingent withholding.** The harness's scheduler ignores `edge.mode`, so before every dispatch the
conductor sets aside any contingent `to`-unit whose `from` is not yet merged, via a transient
`inScope:false` **on the dispatched plan copy only** — never on the persisted plan. Independent work
keeps running. **A direct per-wave harness launch inherits this duty** — withhold contingent
dependents yourself or the harness will launch them early.

**Cycle guard.** Before every dispatch the conductor runs `planCycle` over the plan it is about to
hand the harness; on a cycle it returns **`plan-cycle`** with the loop's `edges` and `units` and
dispatches nothing. This is a hard escalation to the root (repoint or remove one edge in
`plan.json`, relaunch), not something the ladder can resolve. It exists because the harness *throws*
on a cyclic plan and that throw, inside the nested `workflow()`, kills the whole conductor run with
no return envelope — a boundary's staged specs, plan, debt and journal survive only in the
platform's journal. The two use the **same** `planCycle` (byte-identical in both scripts,
`shared-consts.test.mjs`): a cycle reaching the harness's throw is a conductor bug, or a plan a root
launched at the harness directly, which is the root's error to fix. `mergePlan` also refuses to wire
an edge into or out of an already-**merged** unit, which is what closed the first observed cycle:
merged work cannot come to depend on new work, and a dependency on merged work is already satisfied.

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
— a Haiku verbatim write of content this script composes, cksum-verified, so no model stands
between the boundary's decision and the file — **spec revision** (Sonnet, the one that stays a
judgment: it edits three sections in place around material it must not touch, such as an architect
ruling the harness appended mid-wave; it reports its post-edit `cksum` for the record, but there is
no expected value to check it against), and **move-feedback** (this wave's evidence + the actioned/dismissed
user notes → `feedback/triaged/N/`, as a **courier** since 0.14.0 — a closed list of self-contained
`test -e … && git mv …` commands the script judges by the closing `ls -1`; the destination basename is
role-qualified (`explorer-wave-N.md`, `health-wave-N.md`, …) because all three renderings are called
`wave-N.md` and a flat move had the last silently overwrite the first. A source that never existed is
an ordinary skip; one that existed and did not land is a `feedback-unmoved` degradation, never an arc
outcome). A failed *expansion* withholds its unit; a failed *revision*
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
                     //   | critical-path-stalled
                     //   | plan-cycle | max-waves | agent-budget | boundary-degraded | triage-degraded
                     //   | root-triage
                     //   | <halt>: codex-unavailable | codex-usage-limit | env-pids-exhausted
                     //     | env-no-reaper | env-verify-blocked | platform-outage
                     //     — state.halt.reason, returned verbatim
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
  // plan-cycle       → { edges, units }  // the loop, for the root to repoint in plan.json
  // contract-amendment → { debt, contracts }
  // critical-path-stalled → { stalled: [{ id, lineage, dependents }] }  // boundary + debt intact
  // needs-user        → { question, context }
  // arc-complete      → { arcSummary, stuck? }
  //   arcSummary = { merged: [id], quarantined: [{id}], blocked: [id], deferred: [id],
  //                  pendingFeedback: [...], wavesRun }   // `blocked` is its own bucket: a unit
  //                  whose verify tooling could not run is neither built nor failed nor cut
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
`boundary:w<N>`, `spec-expand:<id>` (`#rewrite` on a cksum resample), `spec-revise:<id>`, and
`move-feedback:w<N>` — plus, in issue mode only, `issue-new:w<N>` and `bank-debt:w<N>`. 0.14.0
deleted the state/plan/debt/log writers that used to sit beside them, so in file mode
`move-feedback` is the conductor's only remaining Persist-phase agent.

## Config knobs (defaults in the harness; override via `plan.config` or the Workflow `config` arg)

| Knob | Default | Meaning |
|---|---|---|
| `maxFixRounds` | 2 | Mechanical verify→codex-fix rounds before the unit must face the gate or rescue |
| `maxGateRounds` | 2 | Exit-gate directive→fix→re-check cycles (the last round's fix runs a FRESH codex session — anti-anchoring). Every round after the first is a **re-check** of the directives that gate issued: a new observation is a directive only when it is a correctness defect, everything else banks. The frontier loop then ends in a **closing round** (`gate:<id>#close`, approve/quarantine only) that rules on the last fix instead of quarantining work nobody read |
| `maxGateRoundsLarge` | 3 | The directive-round cap when the unit's diff reaches `largeDiffFiles` files (2026-09-14: two flat rounds could not converge on an 81-file adopted branch) |
| `largeDiffFiles` | 40 | Diff-file count (the verifier's `diffFiles`) at which `maxGateRoundsLarge` applies |
| `maxConsults` | 3 | Mid-loop rescue consults per wave (fired by code: verify still failing at the round cap, or contract surface touched) |
| `maxBlockingFindings` | 6 | Cap on gate directives per revise round — a cap on REPORTING, never reading; overflow banks as debt. Enforced code-side, never schema maxItems (retry-death) |
| `codexModel` | `'gpt-5.6-sol'` | `-m` for every codex run; `null` falls back to the codex CLI's own config default |
| `codexEffort` | `'high'` | `model_reasoning_effort` for builds — under-provisioned effort is the top documented cause of bad Codex output; `xhigh` for hard arcs |
| `codexFixEffort` | `'medium'` | Effort for resume/fix rounds (narrower work than the build) |
| `codexSandbox` | `'danger-full-access'` | Codex OS sandbox. `workspace-write` is only real where the container permits unprivileged user namespaces — bubblewrap cannot build a sandbox without one, and it then degrades silently to no enforcement (probe-observed: a write outside the worktree succeeded). Full access is a deliberate, measured acceptance of sibling-worktree risk in that case; set back to `'workspace-write'` wherever namespaces work. **Every codex launch carries this flag**, the Phase-0 smoke must run with it (SKILL.md → Codex preflight), and where it has to be `danger-full-access` the session must run in bypass-permissions mode — Claude Code's auto-mode permission classifier refuses that flag (2026-09-14: `bwrap: setting up uid map: Permission denied`, and not one codex process could launch) |
| `codexNetwork` | `false` | Adds `-c sandbox_workspace_write.network_access=true` (needed when builds must install packages) |
| `codexTimeoutMin` | `240` | Build deadline before the steering agent kills the process group and assesses what's on disk. Sized for long-horizon units; per-milestone commits are what make a kill survivable |
| `codexFixTimeoutMin` | `45` | Resume-round deadline. Also the deadline for `verify`, the one per-unit role that runs test suites, since a lane legitimately spends most of an hour unlike the 20-minute `codexRoleTimeoutMin` readers (the flake band takes `codexBoundaryTimeoutMin` with the rest of the boundary) |
| `codexRoleEffort` | `'medium'` | `model_reasoning_effort` for a codex ROLE run (`run(…, {model:'codex'})`) — since 0.14.0 that is the spec critique, plan/replan, verify, the pre-gate review, the quarantine dossier write and the flake band. One knob for all of them; a caller may override per role, and there is deliberately no separate planning-effort dial until a workload proves one is needed |
| `codexRoleTimeoutMin` | `20` | Role deadline. Far below `codexTimeoutMin` on purpose: a role that has not finished in 20 minutes is stuck, not thinking, and its caller has a fallback either way |
| `codexBoundaryTimeoutMin` | `45` | Deadline for the four wave-tail BOUNDARY roles (explorer, health, flake, design). Longer than `codexRoleTimeoutMin` because they drive a product end to end, read a whole integrated tree, or run the full suite N times over; still far below `codexTimeoutMin` |
| `codexSteerModel` | `'haiku'` | Steering-agent tier; `'sonnet'` if Haiku proves unable to drive launch/poll/kill/verify (probe P2) |
| `codexMaxConcurrent` | `4` | Counting semaphore on concurrent codex processes (one OpenAI account behind them all). Timing-only — resume-safe |
| `envPreflight` | `'on'` | Host-health preflight before dispatch, beside the codex probe: pid-cgroup headroom (`/sys/fs/cgroup/pids.{current,max}`, halts under 20% free) and whether orphans are being reaped (`ps -eo stat= \| grep -c '^Z' \|\| true`, halts at ≥ 1000 zombies). PID 1's comm is reported in the halt detail but **never judged** — the devcontainer `sh` supervisor reaps fine and an init-name allowlist halts a healthy box. An unreadable fact degrades `env-unprobed` and halts nothing. `'off'` is the documented escape, and the only way past the check |
| `gateMaxConcurrent` | `4` | Counting semaphore on concurrent **test lanes**: the polish-loop verify, every gate re-verify, and the integrated suite at merge. Unit dispatch stays unbounded — their test lanes do not, or the wave saturates the box and then judges wall-clock budgets against the load it created. Timing-only — resume-safe |
| `codexProfile` | `null` | `-p <profile>` (`$CODEX_HOME/<name>.config.toml`) when set |
| `fableEffort` | `'high'` | Effort for the frontier Fable judgment calls that adjudicate hard decisions — the plan-check and the mid-loop architect consult. Fable 5's `high` default; these fire only on the hard calls, so they run there rather than on the floor |
| `gateEffort` | `'high'` | Effort on forced Fable exit-gate calls (the frontier gate) |
| `opusEffort` | `'medium'` | Effort for every Opus call the harness makes — the Opus-first plan-check, the first-pass exit gate wherever `gateModel` puts it on Opus, and merge-conflict/integration fixes (the boundary assessors moved to Codex in 0.14.0, so this no longer reaches them). Opus 5 review accuracy holds at lower effort; the paid-fixture `gate-bad` signal is the tripwire if a downgrade ever costs gate teeth. (`implementEffort` was **removed** in 0.14.0: it only ever drove plan/replan, and the implementer plans its own work on codex now — a codex role's effort is `codexRoleEffort`. Setting it is inert.) |
| `planCheckRisk` | `['low','med','high']` | Which risk tiers get *any* pre-implementation plan-check. Which tier *pays* is set by `planCheck` |
| `planCheck` | `'opus-first'` | `'opus-first'` \| `'always-fable'` (guaranteed Fable on every checked unit). `risk:high` and `feasible:false` always take Fable regardless |
| `exitGate` | `'opus-first'` | `'opus-first'` \| `'always-fable'` (guaranteed Fable gate on every unit) |
| `gateModel` | `{low:'sonnet', med:'opus', high:'opus'}` | Claude tier for the **first-pass exit gate**, by unit risk. Affordable because the codex pre-gate review hands the gate a digest; the raw diff stays in front of med/high units regardless. An override **replaces** the whole map (the config spread is shallow), so name every tier you care about; an unknown tier falls back to `'opus'`. Two conditions override it back to Opus-on-the-raw-diff in **code**, never by prompt: no digest at all, or a digest the reviewer graded `blocking`/high-risk. The frontier (Fable) gate's own routing is untouched by this knob |
| `gateAuditRate` | `0.10` | Fraction of first-pass-approved units that still take a Fable audit gate (anti-rubber-stamp). Deterministic per unit id (resume-safe); `0` disables |
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
evidence of an under-specified plan, and the fix is a better plan. Frontier *saved* at the first-pass
gate is simply saved: per-unit quality is held by that gate plus the cross-model review digest in
front of it, systemic quality by the between-wave health check. **Where to spend a downgrade, and
where never to:** `gateModel` is the dial for per-unit gate cost, and the paid fixtures are its
tripwire — `gate-bad` and `gate-convention` merging unfixed means the diet went too far, and
`gate-good` picking up fix rounds means it is over-blocking. Never dial the *frontier* gate's
routing (`exitGate`, `gateAuditRate`, the forced-Fable triggers) to save tokens: those are the
anti-rubber-stamp checks on everything below them.

## Model tiers — the economic contract

| Tier | Does | Never does |
|---|---|---|
| codex (CLI) | ALL implementation: unit builds, fix rounds and adjudicated resumes (via `exec resume`), plus every ROLE dispatched through the adapter — the cross-model spec critique, the unit's own implementation **plan**/replan, **verify** and every gate re-verify, the **pre-gate review digest**, the quarantine **dossier write**, and the four wave-tail **boundary
roles** (runtime explorer, health assessor, flake band, design reconciler), each of which writes its
own report file. Runs its own implement→test→fix loop inside the brief's pinned scope | **Decide.** It advises — a review digest, a critique, a plan — but nothing it says is a verdict: it never gates, never approves a merge, never rules on an escalation, never plans the roadmap, and never adjudicates its own findings |
| `fable` | Plan pack, plan-checks for med/high-risk units (taste/overengineering charter) + escalations, escalated + audit-sample exit gates, rescue + spec-gap consults (Codex's escalation channel), wave replans, feedback/debt triage, the conductor's tier-3 boundary agent, integration review | Code, fixes, bulk text |
| `opus` | Opus-first plan-check (low-risk singles), the first-pass exit gate for med/high-risk units and for **every** unit whose review digest is missing or flagged, the escalation ladder's adjudicator (`adjudicate:<id>#<stop>`, effort `high` — not `opusEffort`), merge-conflict resolution and the one integration fix, the conductor's tier-2 boundary triager | Implementation and planning (Codex's); the wave-tail explorer/health/flake/design roles (Codex's since 0.14.0) |
| `sonnet` | The first-pass exit gate for low-risk units with a clean review digest (`gateModel`), roadmap normalization, quarantine-dossier investigation, feedback-batch compression, the conductor's spec **revisions** | Spec **expansion** (composed in code, written by a cksum-verified Haiku courier since 0.14.0) |
| `haiku` | Codex steering (launch/poll/kill/disk-verify/report) for the build lane **and every role**, git mechanics, the launch pack read, mirror advance / preview refresh, the conductor's census, the verbatim spec writes the script composed, feedback archiving and gh projections, and the quarantine-dossier write when codex could not do it | Judgment |

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
  pre-merge worktree report for a unit that had since landed). Anything that must vary per launch cannot be generated in-script — it
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
