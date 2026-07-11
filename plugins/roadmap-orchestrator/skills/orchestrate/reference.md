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
  state.json           # harness-owned after wave 1; you write the initial one.
                       #   PRESENT AT TOP LEVEL = an arc is in flight (resume, don't plan over)
  quarantine/<unit>.md # dossiers written by the harness
  feedback/            # accumulated runtime evidence; triaged in batch at judgment boundaries
    explorer/*.md      #   per-wave adversarial exploration findings (architect-spawned Opus)
    health/*.md        #   per-wave code/test/structure/ergonomics health findings (Opus);
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
                                   //   eval fixture probes the gate; see evals/)
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
    "stop": "",                    // optional; default: kill the recorded pid
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
  "consultsUsed": 0, "wave": 0, "units": {} }
```

The harness also records `"preview": { "sha": "<sha>", "status": "live" | "failed" | "none" }` —
the green-tip mirror's position. `failed` never affects any unit outcome (see Preview &
feedback semantics below).

Unit statuses: `pending → running → merge-ready → merged`, or `quarantined` / `blocked`
(dependency quarantined) / `deferred` (beyond cut line). Dependents launch only when every
dependency is `merged`.

## Config knobs (defaults in the harness, or the skill for the between-wave knobs; override via `plan.config` or the Workflow `config` arg)

| Knob | Default | Meaning |
|---|---|---|
| `maxFixRounds` | 2 | Free Opus verify→review→fix rounds before the unit must face the gate or rescue |
| `maxGateRounds` | 2 | Architect directive→fix→re-check cycles before quarantine |
| `maxConsults` | 3 | Mid-loop rescue consults per wave (fired by code: verify still failing at the round cap, or contract surface touched) |
| `minBlockConfidence` | 0.6 | Review findings below this confidence don't trigger fix rounds — false blockers are the reviewer's main cost |
| `gateEffort` | `medium` | Effort on the Fable exit-gate calls; raise to `high` for risky arcs |
| `planCheckRisk` | `['low','med','high']` | Which risk tiers get the pre-implementation plan-check — every unit by default; drop `low` only to trade plan quality for speed |
| `exitGate` | `'opus-first'` | `'opus-first'`: Opus grades its own work and escalates to the Fable architect gate only when stuck / facing a hard trade-off / when the increment is architecturally foundational. `'always-fable'`: restore a guaranteed Fable exit gate on every unit |
| `gateAuditRate` | `0.15` | Fraction of Opus-approved units that still take a Fable audit gate (anti-rubber-stamp). Deterministic per unit id (resume-safe); `0` disables. `risk:high` and contract-touching units always take Fable regardless |
| `previewRefresh` | `'merge'` | Green-tip mirror cadence: `'merge'` (advance after every suite-green merge, coalescing latest-wins), `'wave'` (once, after the queue drains), `'off'` (no mirror). Inert without a `plan.preview` block |
| `healthCheck` | `'each-wave'` | Between-wave codebase-health assessment (architect-run, not the harness): `'each-wave'` or `'off'` |
| `flakeReruns` | `3` | Full-suite re-runs the between-wave health check uses to catch intermittent failures; `0` disables flake detection |

Spend direction when tuning: extra frontier budget goes to the **planning side** (spec
detail, plan-checks, Phase-0 interrogation), never to more mid-flight touchpoints — gate
non-convergence is evidence of an under-specified plan, and the fix is a better plan.
Frontier *saved* at the Opus-first exit gate is simply saved, not redirected to new
mid-flight touchpoints: per-unit quality is held by the Opus gate, and systemic quality
(brittleness, structural drift, ergonomics) by the between-wave health check — a boundary
act, not a per-unit one.

## Model tiers — the economic contract

| Tier | Does | Never does |
|---|---|---|
| `fable` | Plan pack, plan-checks, escalated exit gates + audit-sample gates, rescue consults, wave replans, feedback/debt triage (at existing boundaries only — never a new touchpoint), integration review | Code, fixes, bulk text |
| `opus` | Implementation, tests, adversarial review, Opus-first exit gate, fixes, conflict resolution, preview exploration + codebase-health assessment incl. cross-unit consistency + drafting consolidation fix-unit specs (between waves, architect-spawned; the architect still decides what to admit) | — |
| `sonnet` | Roadmap normalization, dossier compression, feedback-batch compression | — |
| `haiku` | Git mechanics, running suites (incl. flake re-runs), state checkpoints, mirror advance / preview refresh, verbatim writing of dossiers / health findings / the debt ledger, status rendering | Judgment |

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

The returned state includes a `spend` tally (per-tier agent calls, plan-checks, gate
rounds) — the session report's "where did frontier attention go" table, and the evidence
base for tuning the dial next session.

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
fixed), and the between-wave health assessor. The harness collects the wave's items into the
returned state's `debt` array (surfaced *this* wave, not accumulated — the file is the
accumulator). At the between-wave boundary the architect triages debt alongside feedback:
promote worth-fixing-now items into fix units, or have Haiku append the rest to `debt.md`.
Debt is durable (carries across waves and arcs, read at Phase 0 as candidate scope) where
feedback is consumed; a resolved item is annotated, not deleted.

## Health check semantics — the systemic quality backstop

Between waves (unless `healthCheck: 'off'`), an architect-spawned **Opus** health assessor
reads the integration tip for what per-unit gates structurally cannot see: **test health**
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
