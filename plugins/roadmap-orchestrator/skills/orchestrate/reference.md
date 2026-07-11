# Roadmap Orchestrator — Reference

Shapes and rules the harness depends on. Read once before Phase 0; don't restate any of
this to the user unless asked.

## `.roadmap/` layout (committed; the plan is a reviewable artifact)

```
.roadmap/
  plan.json            # units, edges, provision, config — written by you at Phase 0
  brief.md             # codebase brief: build/test/lint commands, conventions, module map
                       #   (Phase 0 recon output; interpolated into every per-unit prompt
                       #   so agents never rediscover — or guess — the commands)
  contracts/*.md       # frozen interfaces; any diff touching these fires escalation
  contracts/conventions.md # OPTIONAL standing cross-cutting contract (pointed to by
                       #   plan.conventions): shared-utility catalog units must reuse +
                       #   naming/error/pattern conventions units must follow. Threaded by
                       #   the harness into every unit's implement/review/gate. Kept here so
                       #   edits to it fire the same frozen-surface escalation as any contract.
  constraints.md       # cross-cutting design constraints & decisions from the source
                       #   material that aren't interface contracts (perf budgets, tech
                       #   choices, compliance, non-goals); specs cite the ones that
                       #   bind them. Populated/verified by the Phase-0 fidelity audit.
  debt.md              # LIVING ledger of consciously-deferred technical debt (accepted
                       #   imperfections, brittleness, structural/ergonomics drift); appended
                       #   at each triage, carries across waves and arcs, read at Phase 0 as
                       #   candidate scope. Distinct from feedback — kept, not consumed.
  specs/<unit>.md      # goal, constraints, contract references, acceptance criteria
                       #   (write criteria as individually gradeable clauses — the gate
                       #   grades them one by one, and vague criteria grade noisily)
  architect-log.md     # arc-scoped architect journal: decisions + rationale, watch-list,
                       #   dismissal criteria. Seeded at Phase 0 (Opus, committed with the
                       #   plan pack); the conductor's tier-3 Fable boundary agent appends a
                       #   `## Wave N` section each time it runs, so successive fresh boundary
                       #   agents inherit rationale. Read first by both boundary agents.
                       #   Archived at close-out.
  state.json           # harness-owned after wave 1; you write the initial one.
                       #   PRESENT AT TOP LEVEL = an arc is in flight (resume, don't plan over)
  quarantine/<unit>.md # dossiers written by the harness
  feedback/            # accumulated runtime evidence; triaged in batch at judgment boundaries
    explorer/*.md      #   per-wave adversarial exploration findings (harness-run Opus, wave-tail)
    health/*.md        #   per-wave code/test/structure/ergonomics health findings (harness-run Opus);
                       #   feeds triage → fix units or the debt.md ledger
    user/*.md          #   the user drops notes here AT ANY TIME (copying TEMPLATE.md); read
                       #   at the next boundary — never an input to a running wave
    triaged/<wave>/    #   consumed items, moved here at triage; never re-triaged
  archive/<arc>/       # closed-out arcs: plan, brief, specs, contracts, state, dossiers,
                       #   report — history for future planning, out of the way for humans
```

## Arc lifecycle — arc-scoped vs living

Everything above except `constraints.md`, `debt.md` (and notes) is **arc-scoped**: it
coordinates one arc and is archived at session close-out (SKILL.md, Session end).
`architect-log.md` is arc-scoped too — seeded at Phase 0, appended per tier-3 boundary,
archived at close-out.
`constraints.md` and `debt.md` are **living documents** — they survive arcs and each new arc
reads and extends them (`debt.md` accumulates deferred debt until a later wave or arc mops it
up; a resolved item is annotated, not deleted, so the history stays legible). Contracts
retire with their arc: once merged, the code and its tests are the source of truth; a new
arc freezes *fresh* contracts (seeded from the archive if useful, but never inherited as
binding). `brief.md` is regenerated per arc — the codebase it describes changed. The
detection rule is mechanical: top-level `state.json` present → arc in flight, resume or
ask; absent → plan fresh, treating `archive/` + living docs as prior knowledge.

## `plan.json`

```jsonc
{
  "repoPath": "/abs/path/to/repo",            // required
  "worktreeRoot": "/abs/path/OUTSIDE/repo",   // required — e.g. /tmp/<repo>-roadmap
  "cutLine": "milestone-2",
  "units": [{
    "id": "auth-token-rotation",   // stable kebab slug — prompts and resume key on it; never rename mid-arc
    "title": "...",
    "risk": "high",                // low | med | high — drives plan-check coverage and gate effort
    "kind": "code",                // anything else is yours to handle between waves, not the harness's
    "inScope": true,               // resolved cut line, ancestor-closed
    "existingBranch": "..."        // optional: adopt a pre-written branch — skips
                                   //   plan/implement, runs it through the same
                                   //   verify → review → gate pipeline (also how the
                                   //   eval fixture probes the gate; see evals/).
                                   //   MUST NOT be the unit's own `unit/<id>` — a
                                   //   self-referential adopt is hard-refused at plan
                                   //   validation (setup could delete its own source);
                                   //   anchor under a different ref (adopt/<id>) instead.
                                   //   Its tip is pre-captured read-only before setup and
                                   //   the resulting worktree sha is asserted against it —
                                   //   a setup agent that recreated the branch is quarantined.
  }],
  "edges": [{
    "from": "auth-core",           // dependency
    "to": "auth-token-rotation",   // dependent — launches only after `from` is merged
    "type": "semantic",            // semantic | file-overlap (both just order scheduling)
    "mode": "contract",            // contract | contingent — contingent edges end the wave; you replan after
    "contract": "contracts/token-provider.md"
  }],
  "provision": {                   // optional but strongly recommended — a fresh worktree has
    "copy": [".env", ".npmrc"],    //   no deps/env; without provisioning, test gates fail for
    "setup": "npm ci"              //   non-code reasons and produce false quarantines
  },
  "preview": {                     // optional but encouraged — how the *integrated arc* is
    "kind": "server",              //   exercised. server | cli | api. Planned at Phase 0.
    "setup": "npm run build",      // optional one-time step at wave setup
    "start": "npm run dev",        // server kind: long-running; the harness daemonizes it
                                   //   (log + pidfile at worktreeRoot/__preview.{log,pid},
                                   //   outside the repo so they never dirty the checkout)
    "stop": "",                    // optional; default kills the whole preview process GROUP
                                   //   (the pidfile pid is a group leader). A custom stop
                                   //   MUST group-kill too — a single-pid kill strands
                                   //   child listeners.
    "refresh": "",                 // optional per-advance step after the mirror moves; ""
                                   //   for hot-reloading servers (the checkout move suffices);
                                   //   absent + server kind → stop/start
    "howToAccess": "http://localhost:5173",  // URL or drive-the-surface instructions — shown
                                   //   to the user at dispatch AND to the wave explorer;
                                   //   kind api/cli: how to drive the public surface directly
    "healthcheck": ""              // optional; failure marks the preview failed, NEVER gates
  },
  "briefPath": "…",                // optional; defaults to <repoPath>/.roadmap/brief.md
  "conventions": "…",              // optional; path to the standing cross-cutting conventions
                                   //   contract (e.g. <repoPath>/.roadmap/contracts/conventions.md).
                                   //   Present → threaded into every unit's implement/review/gate
                                   //   as a frozen contract; absent → those prompts are unchanged.
  "config": { }                    // optional overrides — knobs below
}
```

## `state.json` — you write the initial one; the harness owns it afterward

```json
{ "integrationBranch": "roadmap/session-<date>",
  "integrationTip": "<sha to fork from — usually main's HEAD>",
  "consultsUsed": 0, "wave": 0, "units": {},
  "run": { "runId": "<id>", "scriptPath": "<session-persisted harness path>" } }
```

The harness also records `"preview": { "sha": "<sha>", "status": "live" | "failed" | "none" }` —
the green-tip mirror's position. `failed` never affects any unit outcome (see Preview &
feedback semantics below). `run` is an **optional passthrough**: the architect records
`{runId, scriptPath}` (from the Workflow tool result, which returns the session-persisted
script path) into the initial state at launch, and `serialize()` preserves it — it makes
same-session `resumeFromRunId` mechanical and forensics one `cat`. On a **conductor** run
(the default dispatch path — see "conductor.mjs — multi-wave dispatch" below) `run` records
the *conductor's* `{runId, scriptPath}`, now identifying the whole multi-wave run: the
conductor and its child harness share one journal, so `resumeFromRunId` replays completed
waves for free.

When the conductor drives the arc, the state also carries a **`conductor` block** — the
forensics spine and rung-3 recovery signal, checkpointed at every boundary and before every
return: `{ reason, wavesRun, boundaries: [{ wave, tier, escalated }] }`. `reason` is `null`
while a wave is in flight and the frozen return reason on return (enum below); `tier` is the
ladder rung that handled each boundary (1–4); `escalated` is the reason a tier handed up/out,
else `null` (a `null` entry is a boundary the conductor triaged and continued past in-run).
`wavesRun` is per-run; `boundaries` is **arc-cumulative** — seeded from the passed state's
conductor block, same semantics as `spend` — so a root adjudication mid-arc (amend → relaunch)
extends the forensics instead of erasing the prior runs' entries.

The returned state also carries, when the wave-tail boundary phase ran anything, a **`boundary`
block**: `{ explorer, health, flake }` — the explorer result (`findings[]`, `shaObserved`), the
health result (`findings[]`, `fixUnits[]`), and the flake result (`runs`, `flips[]`); any half
is `null` when its job was off or failed, and the whole block is **omitted** when no job ran
(preview not live *and* `healthCheck: 'off'`) or every job failed — its absence is the signal to
run the explorer/health agents yourself. Verbatim renderings are also written to
`feedback/{explorer,health}/wave-<n>.md`. `spend` is **arc-cumulative**: it seeds from the
passed state's `spend` and accumulates across relaunches (a per-wave delta is the difference
between two successive checkpoints), so no cross-crash hand-summing. A conductor run also
merges its own agent() calls into these same tier keys and adds two conductor-specific
counters, `boundaryTriages` (tier-2 Opus) and `boundaryFables` (tier-3 Fable) — both
arc-cumulative like the rest (see the conductor section). `debt`, by contrast, stays
**per-wave** — only the imperfections surfaced *this* wave — because `.roadmap/debt.md` is the
cross-wave accumulator.

Unit statuses: `pending → running → merge-ready → merged`, or `quarantined` / `blocked`
(dependency quarantined) / `deferred` (beyond cut line). Dependents launch only when every
dependency is `merged`. While a unit is `running` it also carries a `stage` field
(`setup | plan | implement | polish | gate | merge-queue`) for forensics and crash recovery;
a terminal status replaces the whole record, so no stale stage survives. Checkpoints land at
every unit status change **and** every stage transition, coalesced latest-wins — the file can
trail the newest event by one write.

## `conductor.mjs` — multi-wave dispatch

The **default** dispatch path. `conductor.mjs` is a top-level Workflow script that loops the
arc's waves in a single run, so the root wakes once per *run* instead of once per boundary
(each wake is an uncached full-history reload past the 5-min prompt-cache TTL). It dispatches
each wave by calling the harness, then routes the boundary through a tiered triage ladder,
returning to the root only when a decision genuinely needs the frontier architect. A direct
per-wave `harness.mjs` launch remains the fallback/recovery path; every conductor knob is
inert there.

**Launch shape** — the root passes `harnessPath` (absolute path to `harness.mjs`); the
conductor throws without it, because it cannot resolve the child script to dispatch a wave:

```jsonc
Workflow({
  scriptPath: "<conductor.mjs>",
  args: { plan, state, config, harnessPath }   // harnessPath REQUIRED
})
```

`args` may arrive JSON-stringified (same platform quirk as the harness — parsed defensively).
`config` is threaded to the harness **untouched** (the conductor never sets `boundary:'off'`
itself — see below).

**Wave loop + state threading.** A bounded loop (≤ `maxWavesPerRun`): dispatch a wave via
`workflow({scriptPath: harnessPath}, …)`, take its returned state, and feed it as the next
wave's `prior`. The harness's `wave: prior.wave+1`, unit map, and arc-cumulative `spend` then
accumulate for free across waves — the returned state of each wave IS the next wave's prior.
`.roadmap/state.json` is overwritten every wave; per-wave boundary evidence is graded from the
`feedback/` files, not the final state's `boundary` block.

**The tier ladder** (per boundary, first match wins — the routing order is load-bearing):

| # | Route | When |
|---|---|---|
| — | return `contingent-replan` | a contingent edge crossed (`from` merged, `to` withheld this wave or out of scope) |
| — | return `contract-amendment` | any `kind:'contract'` debt this wave |
| — | return `boundary-degraded` | boundary block absent while the caller left it enabled, and no quarantine to route |
| — | return `root-triage` | `boundaryTriage:'root'` (every boundary returns — old behaviour / escape hatch) |
| **3** | Fable boundary agent | any unresolved **in-scope** quarantine, or `always-fable` + judgment present |
| **2** | Opus boundary triager | any judgment (explorer/health findings, flake flips, non-contract debt, census user-feedback files), or `fixUnitAdmit:'triage'` + drafts present |
| **1** | script (mechanical) | only health fix-unit **drafts**, or nothing — admitted with no frontier tokens |

- **Tier 2 (Opus)** weighs findings, disposes of debt and non-contract feedback, and admits
  or cuts health-assessor fix-unit drafts (drafts are the default action). It may **not** kill
  a unit, amend a contract, design a contingent dependent, or answer for the user — it
  escalates: `quarantine-redesign`/`hard-call` hand **down** to tier 3 carrying the Opus
  assessment as a lead; `contract-amendment`/`contingent-replan`/`needs-user` return to the
  **root**.
- **Tier 3 (Fable)** handles quarantine respecs and Opus escalations, routing each quarantine
  by its dossier *reason* (env-blocked → re-run under a fresh id; unsatisfiable → respec under
  a new id; else split/revise), and appends the architect journal. It emits **skeletons only**
  (`id/title/risk/goal/constraints/contractRefs/acceptance/edges/supersedes`) plus a `journal`
  — never code, never a contract amendment (escalates to root). `supersedes` retires the old
  unit (`inScope:false`) and repoints its edges to the new id; new ids are kebab-sanitized and
  collision-suffixed; a respec **never** reuses a failed/quarantined id.
- A crossed contingent counts an edge only when the dependent was **withheld this wave or is
  out of scope**. A dependent the root already replanned into scope and that ran this wave is
  not "crossed": if it quarantined it routes through the normal ladder, not a spurious
  `contingent-replan`.
- After a tier runs, **Sonnet `expandSpec`** renders every new-unit skeleton to
  `.roadmap/specs/<id>.md`; a pure-code `mergePlan` appends the units (`inScope:true`) and
  edges and applies `supersedes`/cuts. Arc-completeness is detected **post-hoc**: a tier says
  so, or the boundary produced no new units and no spec revisions → `arc-complete`.

**Contingent withholding** (the harness scheduler ignores `edge.mode`). Before every dispatch
the conductor mechanically sets aside any contingent `to`-unit whose `from` is not yet merged,
via a transient `inScope:false` **on the dispatched plan copy only** — never on the persisted
plan, so a withheld unit is never mistaken for a root cut. Independent work keeps running; the
conductor returns `contingent-replan` when an edge crosses or when withheld units are the only
remaining dispatchable work. **A direct per-wave harness launch inherits this duty** — the
harness's `ready()` ignores `edge.mode`, so a fallback dispatcher must withhold contingent
dependents itself or the harness will launch them early.

**Budget guard.** For waves after the first, a pre-dispatch guard refuses to start a wave that
could cross the 1000-call cap: `runLocalCalls + 8 + dispatchable×perUnitCallEstimate +
agentBudgetReserve > 1000` → return `agent-budget` (with `nextWaveUnits` + `estimate`);
exhausting `maxWavesPerRun` returns `max-waves`. Both mean *relaunch fresh* — a new run resets
the per-run 1000-agent counter. The guard sums **model-tier keys only** (`fable/opus/sonnet/
haiku`) because `spend` also carries derived counters that subset those tiers (summing all
would double-count), and adds only the conductor's not-yet-merged calls on top of the harness
`spend` deltas.

**Persistence semantics.** At a **continuation** boundary (a wave that dispatches another) the
conductor runs five Haiku verbatim-writers in order, all awaited before the next dispatch and
idempotent by wave-N markers for resume safety:

1. `persist-plan` — overwrite `plan.json` with the merged plan.
2. `bank-debt` — a `<!-- wave N -->` section in `debt.md`, **always stamped** (even "no new
   entries"), replace-if-marker-exists.
3. `log-append` — a `## Wave N` section in `architect-log.md`, **tier-3 only** (the Fable
   agent's `journal`), replace-if-header-exists; append-per-wave, resume-safe.
4. `move-feedback` — this wave's `explorer`/`health` renderings plus actioned/dismissed user
   notes → `feedback/triaged/N/`.
5. `persist-state` — the **consumed** state: `boundary` removed, `debt` cleared to `[]`, the
   `conductor` block written — so rung-3 recovery never re-triages folded items.

An **early return** persists **only** `state.json`, with the `boundary` block and `debt` array
left **INTACT** (the root consumes them; the conductor never banks terminal debt itself).

**Return envelope.** Every return (early or arc-complete) carries:

```jsonc
{ status: 'conductor-return',
  reason,            // arc-complete | contingent-replan | contract-amendment | needs-user
                     //   | max-waves | agent-budget | boundary-degraded | root-triage
  wave, wavesRun,
  state,             // final persisted state (incl. the `conductor` block)
  plan,              // the conductor's merged working plan
  spendDelta,        // per-key nonzero delta of state.spend vs the launch state
  /* + reason-specific brief: */
  // contingent-replan → { edges }
  // contract-amendment → { debt, contracts }         // contract-debt items + contract paths
  // needs-user        → { question, context }        // question from the escalating agent's notes
  // arc-complete      → { arcSummary }                // merged/quarantined/deferred/pendingFeedback/wavesRun
  // agent-budget      → { nextWaveUnits, estimate }
  // root-triage       → { pendingFeedback, quarantined }
  // boundary-degraded, max-waves → { }
}
```

The final wave's boundary output is intentionally left **untriaged** — the conductor never
predicts finality (health fix-units are what extend arcs), so it never sets `boundary:'off'`
itself; arc-completeness is post-hoc, and the last wave's boundary evidence is handed to the
root as better-informed integration-review material. The root may still pass `boundary:'off'`
explicitly on a known-final relaunch.

**Nesting budget.** The conductor spends the **one** allowed `workflow()` nesting level
(conductor → harness); neither script may add another. `harness.mjs` stays leaf-only forever —
a `workflow()` call inside a child throws.

**Forensic labels** (for journal reading / `resumeFromRunId` replay): `census:w<N>`,
`triage:w<N>`, `boundary:w<N>`, `spec-expand:<id>`, `spec-revise:<id>`, and the five
persistence writers `persist-plan`/`bank-debt`/`log-append`/`move-feedback`/`persist-state:w<N>`.

## Config knobs (defaults in the harness; override via `plan.config` or the Workflow `config` arg)

| Knob | Default | Meaning |
|---|---|---|
| `maxFixRounds` | 2 | Free Opus verify→review→fix rounds before the unit must face the gate or rescue |
| `maxGateRounds` | 2 | Architect directive→fix→re-check cycles before quarantine |
| `maxConsults` | 3 | Mid-loop rescue consults per wave (fired by code: verify still failing at the round cap, or contract surface touched) |
| `minBlockConfidence` | 0.6 | Review findings below this confidence don't trigger fix rounds — false blockers are the reviewer's main cost |
| `gateEffort` | `medium` | Effort on the forced Fable exit-gate calls (high-risk/contract/`always-fable`); raise to `high` for risky arcs |
| `planCheckRisk` | `['low','med','high']` | Which risk tiers get *any* pre-implementation plan-check — every unit by default; drop `low` only to trade plan quality for speed. Which tier *pays* for the check is set by `planCheck` |
| `planCheck` | `'opus-first'` | `'opus-first'`: a fresh Opus checks the plan and escalates to the Fable architect only on uncertainty / a foundational or contract concern / apparent unbuildability. `'always-fable'`: guaranteed Fable plan-check on every checked unit. `risk:high` units and claimed-infeasible plans always take Fable regardless |
| `exitGate` | `'opus-first'` | `'opus-first'`: Opus grades its own work and escalates to the Fable architect gate only when stuck / facing a hard trade-off / when the increment is architecturally foundational. `'always-fable'`: restore a guaranteed Fable exit gate on every unit |
| `gateAuditRate` | `0.10` | Fraction of Opus-approved units that still take a Fable audit gate (anti-rubber-stamp). Deterministic per unit id (resume-safe); `0` disables. `risk:high` and contract-touching units always take Fable regardless |
| `auditEffort` | `'low'` | Effort for audit-*only* Fable gates (the `gateAuditRate` sample was the sole force reason) — these read diff-stat-first; forced gates keep the full-diff read at `gateEffort` |
| `previewRefresh` | `'merge'` | Green-tip mirror cadence: `'merge'` (advance after every suite-green merge, coalescing latest-wins), `'wave'` (once, after the queue drains), `'off'` (no mirror). Inert without a `plan.preview` block |
| `boundary` | `'on'` | Wave-tail boundary phase (harness-run, strictly after all merges + mirror advances): the Opus runtime explorer (when a preview is live) + Opus health assessor + Haiku flake re-runs, in parallel; results land in the returned state's `boundary` block. `'off'` for the arc's final wave, where the session integration review supersedes it |
| `healthCheck` | `'each-wave'` | The health-assessor half of the boundary phase — now **harness-run at the wave tail**, not architect-spawned: `'each-wave'` or `'off'` |
| `flakeReruns` | `3` | Full-suite re-runs the wave-tail health check uses to catch intermittent failures; `0` disables flake detection |

Spend direction when tuning: extra frontier budget goes to the **planning side** (spec
detail, plan-checks, Phase-0 interrogation), never to more mid-flight touchpoints — gate
non-convergence is evidence of an under-specified plan, and the fix is a better plan.
Frontier *saved* at the Opus-first exit gate is simply saved, not redirected to new
mid-flight touchpoints: per-unit quality is held by the Opus gate, and systemic quality
(brittleness, structural drift, ergonomics) by the between-wave health check — a boundary
act, not a per-unit one.

### Conductor knobs (under `plan.config.conductor` / `config.conductor` — `config` wins; inert on a direct harness launch)

| Knob | Default | Meaning |
|---|---|---|
| `maxWavesPerRun` | `3` | Wave-loop bound; exhaustion → `max-waves` return (a fresh relaunch resets the 1000-agent counter) |
| `boundaryTriage` | `'opus-first'` | `'opus-first'` full ladder · `'always-fable'` skip the Opus tier (judgment goes straight to Fable) · `'root'` every boundary returns (old per-wave behaviour / escape hatch) |
| `agentBudgetReserve` | `200` | Headroom below the 1000-call cap; the pre-wave budget guard returns before crossing |
| `perUnitCallEstimate` | `15` | Pre-wave budget estimate per dispatchable unit; corrected each wave by the actual harness `spend` deltas |
| `fixUnitAdmit` | `'auto'` | `'auto'` tier-1 mechanical admit of health-assessor drafts · `'triage'` force ≥Opus veto when drafts are present |

## Model tiers — the economic contract

| Tier | Does | Never does |
|---|---|---|
| `fable` | Plan pack, escalated/guaranteed plan-checks, escalated exit gates + audit-sample gates, rescue consults, wave replans, feedback/debt triage, the conductor's in-workflow **tier-3 boundary agent** — Opus escalations + quarantine respecs + architect journal — all at existing boundaries only (never mid-wave, never reaching a running unit), integration review | Code, fixes, bulk text |
| `opus` | Implementation, tests, adversarial review, Opus-first plan-check + Opus-first exit gate, fixes, conflict resolution, preview exploration + codebase-health assessment incl. cross-unit consistency + drafting consolidation fix-unit specs (wave-tail, harness-run in the boundary phase; the architect still decides what to admit), the conductor's **tier-2 boundary triager** (may escalate up to Fable or out to the root; never kills a unit, respecs a quarantine, or amends a contract) | — |
| `sonnet` | Roadmap normalization, dossier compression, feedback-batch compression, the conductor's skeleton→spec expansion (`specs/<id>.md`) | — |
| `haiku` | Git mechanics, running suites (incl. flake re-runs), state checkpoints, mirror advance / preview refresh, verbatim writing of dossiers / health findings / the debt ledger, status rendering, the conductor's feedback/quarantine census + between-wave persistence writers (plan/debt/log/feedback/state) | Judgment |

Root-only (never delegated down the conductor ladder): the Phase-0 plan pack, contingent
replans, contract amendments, needs-user calls, and the session integration review — the
conductor early-returns to the root for each.

## Platform rules the harness respects (keep respecting them if you ever modify it)

- `model:` explicit on **every** `agent()` call — omitted, agents inherit the main-loop
  model (frontier) silently. Same for any agent you spawn yourself; never a bare typed
  agent (Explore, Plan, …).
- `schema:` on every call — handoffs are validated structures; the harness never parses prose.
- No `Date.now()` / `Math.random()` / filesystem in the script; prompts are deterministic
  per unit id + sha, so `resumeFromRunId` replays completed calls free (partial replay
  under concurrency reordering is expected and fine).
- The built-in `isolation: 'worktree'` is fresh-per-agent-call — units share a hand-rolled
  worktree at `worktreeRoot/<unit-id>` instead; `worktreeRoot/__integration` is the merge
  checkout. Keep `worktreeRoot` outside the repo.
- **Worktrees contain only committed state.** Gitignored and uncommitted files do not
  materialize in them. Three consequences: plan artifacts are therefore read from the
  *primary* checkout by absolute path (never worktree-relative — this is deliberate;
  don't "fix" it); gitignored files the build/tests need must be enumerated in
  `provision.copy`; and a dirty working tree at dispatch means recon/audit saw code the
  units can't — commit or reconcile before launching a wave (SKILL.md, Phase 0).
- The script can't read disk: the main loop passes parsed `plan` + `state` as `args` and
  persists the returned state; the harness also checkpoints to `.roadmap/state.json` via a
  Haiku agent after every status change (crash safety).
- **`args` may arrive JSON-stringified** (observed empirically) — the harness parses
  defensively. The failure mode of not doing so is vicious: destructured fields become
  `undefined`, prompts say `cd undefined`, and agents improvise in their own cwd.
- **Mechanical agents improvise around bad paths** (observed empirically): given an
  unusable location plus a loose prompt, Haiku will operate on whatever repo it's standing
  in and report plausible success. The harness counters with fail-loud location preambles
  *and* code-side sha assertions — a worktree whose HEAD doesn't match the expected fork
  base is quarantined before any work happens. Keep both if you modify the harness.
- Workflows take no mid-run input; ~16 agents run concurrently; the merge queue is serial
  by design — wall clock, not tokens, is the throughput limit.
- **One `workflow()` nesting level, and the conductor spends it.** The default dispatch path
  is conductor → harness, which consumes the single allowed nesting level; `harness.mjs` must
  stay leaf-only forever. A `workflow()` call inside a child script throws — neither script
  may add another level.

### Known platform issues

Behaviours of the current dynamic-workflow runtime the harness works *around* — not bugs in
this skill, and worth filing upstream at github.com/anthropics/claude-code:

- **Adopt-rejection after host death.** If the Claude Code process dies while a workflow is
  running, the platform's same-session resume/adopt path can refuse to re-attach. Treat it as
  a crash: relaunch fresh and follow the recovery ladder (SKILL.md, Phase 1…n). The setup
  guards make a fresh relaunch behave like a resume — a unit branch already merged into the
  integration branch short-circuits to `merged`, and a crashed `running` unit auto-adopts its
  committed branch and re-enters at verify — so the refusal stops mattering.
- **The crash notification recommends `resumeFromRunId` across sessions.** It cannot work
  there: the journal is same-session only. Obey the ladder, not the notification.
- **Schema-retry resends payloads verbatim.** On a structured-output validation failure the
  platform re-sends the *same* oversized payload until the unit dies, with no chance to
  shorten it. This is why the harness caps free-text field lengths (impl `summary`/`notes`,
  debt `what`/`why`, and the boundary `explore`/`health`/`flake` fields) and tells implementers
  to commit before emitting the report — an over-long report can kill a unit whose work is
  already committed and done.
- **H-7 phantom-ledger reference — resolved.** An implementer that hit a genuine
  frozen-surface-vs-code mismatch once deviated correctly in code but left a "see debt.md"
  comment for a ledger entry it could not write (units never touch `.roadmap/`), and a gate
  quarantined partly on that phantom reference. Resolved two ways: the implement/fix prompts
  now forbid `.roadmap/` references outright (report deviations only through structured
  output), and the impl schema gained an optional **`contractMismatch`** field (string,
  maxLength 300 — "which surface, how reality differs"). A present `contractMismatch` fires the
  mid-loop architect consult (consumable, budget-respecting), **forces the Fable exit gate**
  (skipping any audit-only cheapening) with the report text and an explicit adjudication clause
  in its prompt, and banks a `{ kind: 'contract', severity: 'major' }` debt entry — surfaced in
  the wave's `debt` array even when the unit merges, for the architect to adjudicate the
  contract amendment at the boundary.

## Verify semantics — three outcomes, not two

Per-unit verification is a cheap-to-expensive ladder: lint/typecheck the changed files →
unit-scoped tests + the spec's acceptance checks. The **full suite runs only at the merge
gate** — never in the fix loop. Errors are reported verbatim, never paraphrased. And there
is a third outcome besides pass/fail: **`blocked`** — the tooling itself couldn't run
(missing dep, broken command, env failure). A blocked verify never enters the fix loop; it
quarantines immediately with an *environment* dossier. Prevention is the `provision` block
in `plan.json`, which materializes env files and runs setup in every fresh worktree before
any agent works there.

## Merge & quarantine semantics

Serial queue onto the integration branch: Haiku `merge --no-ff` per unit → conflicts go to
Opus (aborts rather than guessing when semantically unsure) → full suite → on failure, one
Opus diagnose/fix attempt (checking first whether the failure predates the merge) → else
revert the merge, quarantine the unit, continue the queue. Quarantined units keep their
branch and worktree and get a dossier in `.roadmap/quarantine/`; their dependents are
marked `blocked`. Redesign happens between waves, by you, as a new spec.

Quarantine reasons route to different between-wave actions — read them, don't pattern-match:
**environment/tooling blocked** → fix provisioning or the brief, re-run as-is;
**unsatisfiable spec/contract** → respec or amend the contract; everything else → redesign.

The returned state includes a `spend` tally — per-tier agent counts (`fable`/`opus`/
`sonnet`/`haiku`) plus `opusPlanChecks`, `planChecks` (Fable plan-checks only),
`opusGateRounds`, `gateRounds` (Fable), and — on a conductor run — `boundaryTriages`
(tier-2 Opus) and `boundaryFables` (tier-3 Fable) — the session report's "where did frontier
attention go" table, and the evidence base for tuning the dial next session. It is
**arc-cumulative**: the tally seeds from the passed state's `spend` and accumulates across
relaunches, so a crashed-and-resumed arc no longer needs its per-run tallies hand-summed (a
single wave's delta is the difference between two successive checkpoints).

## Preview & feedback semantics

The **green-tip mirror**: when `plan.preview` exists, the harness detaches the *primary
checkout* at the integration tip at wave setup and, after each suite-green merge, has
Haiku advance it (`git checkout --detach <sha>`, coalescing latest-wins — merges never
wait for it) and run the preview's `refresh`/restart + healthcheck there. The user
watches from their own repo and environment, only ever sees real suite-green states, and
`.roadmap/feedback/user/` is in the tree they're standing in. The `main` ref never moves
(detached HEAD), and the merge queue stays in `__integration` — user git activity can at
worst stale the mirror (one detach-checkout heals it), never derail the queue. This works
because units never touch `.roadmap/`, so the harness's dirty `state.json` checkpoint is
identical across tips and survives each checkout; a *refused* checkout (user-dirtied
tracked file) just logs and leaves the mirror stale.

**The preview is observability, never a gate.** Setup, refresh, or healthcheck failures
set `preview.status: "failed"`, log, and continue; no unit outcome may ever depend on the
preview. Process lifecycle convention: pidfile + log at `worktreeRoot/__preview.{pid,log}`
(outside the repo, so resets and archives never touch them). Kill a stale pidfile at
Phase 0, on resume, and at close-out.

**Findings are evidence, not directives.** Explorer findings (severity, area, observed vs
expected, exact repro, `shaObserved`), health-check findings, and user notes change no
statuses and reach no running unit; they wait in `.roadmap/feedback/` for the architect's
next judgment boundary. At triage, consumed files move to `feedback/triaged/<wave>/`
(Haiku); large batches are Sonnet-compressed before the architect reads them; findings
observed at a superseded sha are discounted, not re-litigated. `feedback/user/TEMPLATE.md`
is the user's pro forma — never parsed as feedback itself.

## Plan-check semantics — Opus-first, escalate to Fable

Before any code exists, the plan-check catches a wrong approach — the cheapest place in the
system to redirect. Its charter is **the spec as much as the plan**: this is the only pre-code
eyes on the spec itself, so both variants interrogate the SPEC as hard as the proposed plan —
hunting contradictions *within* the spec, clauses that contradict a referenced contract or
documented codebase reality, and stale premises the implementer would otherwise resolve ad hoc
mid-build. A spec defect is not the engineer's to absorb; it is resolved now, through the
verdict. (Arc-observed rationale: 11 plan-checks never fired on plan plausibility but approved
past spec-internal contradictions the implementer then had to reconcile by hand — the failure
was a charter gap, not a coverage gap, so the charter was refocused rather than narrowed.)

Like the exit gate it is **Opus-first**: a fresh Opus reads the spec, its contracts, and the
implementer's proposed plan, then returns `approve` (implement as-is), `redirect` (the engineer
revises per its guidance, then implements — this includes **naming the explicit resolution of a
spec contradiction** when the right call is clearly within its authority), or `escalate`. Opus
may approve or redirect but **may not quarantine** — kill decisions stay frontier-only. It
escalates to the **Fable architect plan-check** on contract interpretation, **a spec
contradiction it cannot resolve itself**, architectural foundations, genuine uncertainty, or a
plan that looks unbuildable, carrying its assessment across as a lead (the same handoff idiom
the exit gate uses). The Fable plan-check (`approve | redirect | quarantine`) is also reached
unconditionally where the stakes are structural: `planCheck: 'always-fable'`, `risk: high`, or
a plan that declares itself infeasible (`feasible:false`) — an infeasible plan **must** route
to Fable and may never be killed or waved through by Opus alone. `planCheckRisk` still decides
which tiers get *any* check; `planCheck` decides which tier pays. The tally splits
`spend.opusPlanChecks` from `spend.planChecks` (Fable only), mirroring the gate.

## Exit gate semantics — Opus-first, escalate to Fable

Once a unit's fix loop converges (verify passes, no confident blockers), the exit gate
decides merge-readiness. It is **Opus-first**: a fresh adversarial Opus (not the
implementer) grades each acceptance criterion and returns `approve` (merge), `revise` (a
mechanical fix it specifies itself → free Opus fix → re-verify → re-gate, bounded by
`maxGateRounds`), or `escalate`. It escalates to the **Fable architect gate** only on a
genuinely hard call, naming the trigger: `stuck`, `hard-tradeoff` (every option carries a
substantive drawback), `foundational` (the increment's architecture is load-bearing for the
wider solution), or `oversight` (found something it isn't confident it can resolve). The
Fable gate (unchanged behaviour: `approve | revise | quarantine`) is also reached
unconditionally when `forceFrontier` holds — `exitGate: 'always-fable'`, `risk: high`, the
diff touches a frozen contract surface, or the unit falls in the deterministic
`gateAuditRate` sample. Opus non-convergence (rounds exhausted without approving) also falls
through to Fable. The tally splits `spend.opusGateRounds` from `spend.gateRounds` (Fable) so
the report shows how much frontier the Opus-first gate actually saved.

Rationale (and its limit): Opus can reliably self-assess *decision hardness and stakes* —
the three triggers above — but **not** hidden correctness oversights it doesn't know it made
(the exact reason the gate was once guaranteed; see DESIGN.md decision 4). So the guaranteed
Fable pass is retained precisely where those oversights are most costly (high-risk,
contract-touching), an audit sample guards against systematic rubber-stamping, and the
between-wave health check is the systemic backstop for what slips through per-unit.

## Debt ledger semantics

`.roadmap/debt.md` is the **living** record of consciously-deferred imperfection — the
counter to agents quietly leaving "minor" issues behind. Producers emit structured `debt`
items `{what, why, severity: minor|major, kind: correctness|test|structure|ergonomics}`:
the implementer (shortcuts it took), the reviewer (its `nonBlocking` / `preExisting`
findings, which previously evaporated), both exit gates (imperfections approved rather than
fixed), and the wave-tail health assessor. The harness itself also banks a
`{ kind: 'contract', severity: 'major' }` entry for every implementer-reported
`contractMismatch` (see known issues, H-7) and now banks fix-round debt too (it previously
evaporated) — both flow to the same triage. The harness collects the wave's items into the
returned state's `debt` array (surfaced *this* wave, not accumulated — the file is the
accumulator). At the between-wave boundary the architect triages debt alongside feedback:
promote worth-fixing-now items into fix units, or have Haiku append the rest to `debt.md`.
Debt is durable (carries across waves and arcs, read at Phase 0 as candidate scope) where
feedback is consumed; a resolved item is annotated, not deleted.

## Health check semantics — the systemic quality backstop

At each wave's tail (unless `healthCheck: 'off'`), a **harness-run Opus** health assessor —
part of the boundary phase, no longer architect-spawned — reads the integration tip for what
per-unit gates structurally cannot see: **test health**
(coverage gaps, slow tests, brittleness — assertion-on-implementation-detail, over-mocking,
order/timing dependence), **structural health** (oversized files, misplaced code,
architectural drift), **cross-unit consistency** (units that independently added equivalent
helpers, diverged on the pattern/convention for the same task, or reimplemented something the
conventions contract already catalogs — the drift the isolate-and-parallel design produces and
no per-unit gate or proactive contract can catch, since siblings never see each other), and
**ergonomics** (un-automated dev steps, missing tooling that taxes every round). Intermittent
failures are caught mechanically: Haiku runs the full suite `flakeReruns` times (default 3)
and any pass↔fail flip is a brittleness item.

The assessor is **empowered, not merely advisory**: for each finding worth fixing it returns a
ready-to-dispatch **consolidation fix-unit draft** (id, goal, files, acceptance criteria — a
unit spec's shape), and at triage those drafts **default into the next wave** unless the
architect cuts them. This is the counter to findings dying unactioned in a folder; the
architect's judgment enters as a veto over noise, not as authoring each fix. It does not
weaken invariant 8: the drafts gate nothing mid-wave, reach no running unit, and are admitted
only at the boundary the architect already owns — and they run the identical isolation → gate →
merge pipeline as any unit, so admitting one costs no safety. Findings still also flow into
`debt.md` when not promoted. This is where the root architect owns overall product quality and
catches degradations — cross-unit drift and intermittent test failures alike — before they
compound into every later wave.
