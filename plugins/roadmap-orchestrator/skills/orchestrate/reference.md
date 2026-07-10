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
  constraints.md       # cross-cutting design constraints & decisions from the source
                       #   material that aren't interface contracts (perf budgets, tech
                       #   choices, compliance, non-goals); specs cite the ones that
                       #   bind them. Populated/verified by the Phase-0 fidelity audit.
  specs/<unit>.md      # goal, constraints, contract references, acceptance criteria
                       #   (write criteria as individually gradeable clauses — the gate
                       #   grades them one by one, and vague criteria grade noisily)
  state.json           # harness-owned after wave 1; you write the initial one.
                       #   PRESENT AT TOP LEVEL = an arc is in flight (resume, don't plan over)
  quarantine/<unit>.md # dossiers written by the harness
  archive/<arc>/       # closed-out arcs: plan, brief, specs, contracts, state, dossiers,
                       #   report — history for future planning, out of the way for humans
```

## Arc lifecycle — arc-scoped vs living

Everything above except `constraints.md` (and notes) is **arc-scoped**: it coordinates one
arc and is archived at session close-out (SKILL.md, Session end). `constraints.md` is a
**living document** — it survives arcs and each new arc reads and extends it. Contracts
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
  "briefPath": "…",                // optional; defaults to <repoPath>/.roadmap/brief.md
  "config": { }                    // optional overrides — knobs below
}
```

## `state.json` — you write the initial one; the harness owns it afterward

```json
{ "integrationBranch": "roadmap/session-<date>",
  "integrationTip": "<sha to fork from — usually main's HEAD>",
  "consultsUsed": 0, "wave": 0, "units": {} }
```

Unit statuses: `pending → running → merge-ready → merged`, or `quarantined` / `blocked`
(dependency quarantined) / `deferred` (beyond cut line). Dependents launch only when every
dependency is `merged`.

## Config knobs (defaults in the harness; override via `plan.config` or the Workflow `config` arg)

| Knob | Default | Meaning |
|---|---|---|
| `maxFixRounds` | 2 | Free Opus verify→review→fix rounds before the unit must face the gate or rescue |
| `maxGateRounds` | 2 | Architect directive→fix→re-check cycles before quarantine |
| `maxConsults` | 3 | Mid-loop rescue consults per wave (fired by code: verify still failing at the round cap, or contract surface touched) |
| `minBlockConfidence` | 0.6 | Review findings below this confidence don't trigger fix rounds — false blockers are the reviewer's main cost |
| `gateEffort` | `medium` | Effort on exit-gate calls; raise to `high` for risky arcs |
| `planCheckRisk` | `['low','med','high']` | Which risk tiers get the pre-implementation plan-check — every unit by default; drop `low` only to trade plan quality for speed |

Spend direction when tuning: extra frontier budget goes to the **planning side** (spec
detail, plan-checks, Phase-0 interrogation), never to more mid-flight touchpoints — gate
non-convergence is evidence of an under-specified plan, and the fix is a better plan.

## Model tiers — the economic contract

| Tier | Does | Never does |
|---|---|---|
| `fable` | Plan pack, plan-checks, exit gates, rescue consults, wave replans, integration review | Code, fixes, bulk text |
| `opus` | Implementation, tests, adversarial review, fixes, conflict resolution | — |
| `sonnet` | Roadmap normalization, dossier compression | — |
| `haiku` | Git mechanics, running suites, state checkpoints, status rendering | Judgment |

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
