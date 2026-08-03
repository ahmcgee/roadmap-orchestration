# WORKSTREAM 0.10.0 — combined hardening (feat/combined-hardening-0.10.0)

**Delete this file before the PR merges.** It is the plan-of-record + resume brief for a
budget-constrained workstream (authored 2026-08-03 at ~10% weekly budget; paid eval cycle
deferred until after the usage reset). If resuming cold: tasks live in the session task list;
commits are risk-ascending so a partial branch is still mergeable up to its last green commit.

## Standing directives (user)

- **Never scrimp on Fable at discernment seams** — in the skill's design AND in how this branch
  is built. New judgment paths route to Fable; no effort downgrades anywhere in this batch.
- **One paid eval cycle only**, post-reset: harness fixture + conductor fixture, sequential.
  Until then: parse.sh + unit sims on every commit, zero model tokens.
- Division of labor: Fable (main loop) designs seams and writes the two scripts' source
  (dense, integration-heavy, full context held); Opus subagents write sims/tests per feature
  AFTER each feature commit, following existing test idioms.

## Scope and commit order (risk-ascending)

1. **Docs commit** — rulings ledger + prefix pre-allocation + handoff census (SKILL.md,
   reference.md; no script changes).
2. **Owed-marker chassis** (harness + conductor).
3. **Preview loudness** (harness).
4. **Merge-path `.roadmap/` refusal** (harness).
5. **Prefix-uniqueness assertion** (harness, plan-driven).
6. **Plan carries context** (harness).
7. **Implementer-pulled consults** (harness).
8. **Warm-lane chain batching** (harness — the big one, last).
9. **Docs sweep** — RATIONALE/DESIGN/reference sections, version bump 0.10.0
   (plugin.json + marketplace.json), prune root skill-feedback.md (0.9.0 resolved the
   checkpoint-32k persist path via staged `<<<PART k/n>>>` writes + `write-failed`
   degradations, and item 10c via §15 debt hardening), remove this file.

**Cache-aligned preambles (feedback item 4) is deliberately scoped down** to: a sim that
asserts the shared prompt constants (STRICT/TERSE/writeVerbatim) stay byte-identical across
harness.mjs and conductor.mjs (real drift risk today), plus prefix-aligned preambles on the
NEW chain prompts only. Rationale: restructuring every load-bearing prompt's opening for an
offline-unverifiable caching gain, immediately before a single paid validation cycle, risks
the gate-teeth wording for a benefit we cannot measure this side of the run. Documented as
partially-addressed; revisit with its own paid cycle.

## Seam designs (settled — implement as written unless code contradicts)

### Owed markers
- Harness `serialize()` gains `owed: [{job: 'explorer'|'design'|'health'|'flake', wave, why,
  units?, count}]`. Written by `runBoundary()` when a job was DUE but produced no result:
  skipped (preview down ⇒ explorer/design; healthCheck off is NOT owed — config choice) or
  died (`.catch(() => null)` path). Seeded from `prior.owed`: a job that runs successfully
  this wave discharges its owed entries (design: only if this wave's design set ⊇ owed units);
  still-undischarged entries carry forward with `count + 1`.
- Design job unions owed units: `designUnits` = this wave's newly-merged design-cited units
  ∪ plan units named in prior owed `design` entries (still in plan, still design-cited).
- Conductor `predicates()` exposes `owed = state.owed ?? []`; `anyJudgment ||= owed.length`.
  Entries with `count >= 2` force tier 3 (Fable adjudicates: waive with journal entry — a new
  `waiveOwed: strArr` field on S_boundaryPlan — or escalate). Tier-2 prompt: owed jobs in
  evidence; may NOT silently drop; either the wave discharged them or they ride forward.
  Terminal returns include `owed` in the envelope when non-empty; SKILL.md close-out: an
  undischarged owed job must be run (or explicitly waived in the architect log) pre-close-out.
- Conductor threads `owed` through `consumed` state untouched (it is the harness's field).

### Preview loudness
- Setup prompt: BEFORE the detach, `git status --porcelain`; if dirty, do not detach; report
  ok:false with the porcelain output AND whether `git diff <tip>` is empty for the modified
  paths (the carried-modification signature: modified vs the stale detach point, byte-identical
  to the target tip) in `detail`. Keep never-stash/reset/force.
- Harness: on setup failure, `degrade(kind: 'preview-failed')` carrying the diagnosis + precise
  operator guidance (carried-modification case: "content matches the target tip — a plain
  `git checkout --detach <tip>` after inspecting `git status` is safe; real local edits: commit
  or stash them yourself"). runBoundary()'s owed generation then records explorer/design as owed
  (preview-down), which is the loud boundary downgrade.
- reference.md degradation kinds += `preview-failed`.

### Merge-path .roadmap/ refusal
- Merge prompt (first, Haiku): before merging, `git diff --name-only $(git merge-base HEAD
  unit/<id>)..unit/<id> -- .roadmap/`; if non-empty, do NOT merge; report merged:false and the
  paths in new optional S.merge field `roadmapPaths: arr('string')`.
- Harness `mergeUnit()`: on `!res.merged && res.roadmapPaths?.length`: dispatch a Haiku strip
  agent in the unit worktree — one commit restoring every listed path to its state at the merge
  base (`git checkout <base> -- <path>` for modified/deleted; `git rm -f` for added; commit
  "strip .roadmap/ — orchestrator-owned; content preserved in prior commits"), then bank
  `{kind:'contract', severity:'major'}` debt naming the paths + branch shas (content stays in
  history), log loudly, and re-run the normal merge step once. Contract-kind debt already
  routes the boundary to the root (`contract-amendment`) — the architect adjudicates the
  stripped content, exactly the observed-incident disposition.
- Belt: verify prompt's existing contracts check widens from `.roadmap/contracts/` to all of
  `.roadmap/` (still reported as `contractSurfaceTouched` — forces the Fable gate pre-merge).

### Prefix uniqueness
- Plan-driven, absent ⇒ byte-identical prompts (fixture safety): `plan.prefixUniqueGlobs:
  string[]` (e.g. `["migrations/*"]`). When set, the merge prompt adds: after a clean merge,
  before the suite, list files matching each glob; extract leading digit-runs; on any duplicate
  prefix, ABORT the merge (`git merge --abort` / revert if committed) and report merged:false
  with the collisions in new optional field `prefixCollision: arr('string')`.
- Harness: `prefixCollision` ⇒ quarantine with reason "migration prefix collision — pre-allocate
  numbers in the conventions contract and respec" (tier 3 / Fable respecs; never silent repair).
- SKILL.md Phase 0: repos with numbered sequences MUST pre-allocate explicit numbers per unit in
  the conventions contract and set `plan.prefixUniqueGlobs`.

### Plan carries context
- `S.plan` += optional `evidence: {keyFiles: [≤20 × ≤200ch], signatures: [≤15 × ≤300ch],
  seams: [≤10 × ≤400ch]}`. Plan prompt: record the manifest while exploring; state each budget
  (prompt-hygiene). Implement/fix get it free (plan is JSON.stringify'd in already).
- Reviewer gets `keyFiles` ONLY, as "the planner's reading list, not a boundary — judge the
  whole diff" (independence preserved); '' clause when absent (byte-identity on old plans).

### Implementer-pulled consults (10a)
- `S.impl` += optional `specGap {maxLength:300}`: "a decision the spec does not settle where
  reasonable engineers would diverge — state the decision you took and the alternative". REPORT
  const gains its budget sentence + MISMATCH-style "leave EMPTY unless" discipline text
  (scratchpad abuse is the known failure mode).
- Tracked like `mismatch`: `gap`/`gapEver`, noted from impl/debt-fix/fix reports. `stuck`
  condition += `|| !!gap`; rescue dossier + Fable consult prompts carry it; consult consumes it.
  If a gap was reported but never consulted (budget exhausted), `forceFrontier ||=` that — the
  unadjudicated silent-design-decision is exactly the evidence class (0 consult fires in 92
  units while every real failure was a spec-silence decision).

### Warm-lane chain batching
- Platform reality: agent() is one-shot; no persistent implementer exists. The warm lane is ONE
  plan call + ONE implement call for the whole chain, then the EXISTING per-link cold pipeline.
- Detection (wave start, after the unblock loop): among in-scope, pending, non-existingBranch
  units — maximal linear segments of `mode:'contract'` edges where consecutive links have
  out-degree 1 (from) and in-degree 1 (to) within the candidate set. Length ≥ 2, capped at
  `C.maxChainLength` (default 5; longer chains split). Knob `C.warmLanes: true`; false ⇒
  byte-identical legacy behavior (sim-asserted).
- Lane start when link 1 is `ready()`. All links → status 'running', stage 'chain-implement'.
  One worktree at `wtRoot/<u1.id>` (branch `unit/<u1.id>`), one provision.
- Chain PLAN: one Opus call, schema = per-link array of S.plan bodies (+ evidence). Per-link
  plan-checks run UNCHANGED (Opus-first; risk:high/infeasible → Fable) on each link's slice.
  Redirect ⇒ revise that link's slice; quarantine on link i ⇒ links < i proceed as a (possibly
  length-1 ⇒ normal path) chain, link i quarantined, links > i blocked via existing blockedBy.
- Chain IMPLEMENT: one Opus call, ordered specs; per link: implement, test, commit,
  `git branch unit/<id> HEAD`, continue. Report schema: per-link {id, filesChanged, summary,
  contractMismatch?, specGap?, debt[]} (maxItems = chain length; budgets stated). A Haiku
  tip-probe then records each `unit/<id>` sha; `base_i` = link i-1's recorded tip (base_1 =
  lane-start integrationTip).
- Then per link, IN ORDER: the existing pipeline from verify onward (adoption-style entry, diff
  base = recorded base_i, own worktree via `git worktree add` on the existing branch, own
  provision), including debt-fix on that link's confessions, polish loop, gates with ALL force
  rules (mismatch/specGap/risk/audit) computed per link, serial merge (existing mergeUnit,
  branch names already match). Link i merges before link i+1's pipeline starts.
- Report lost ⇒ per-link commit probes: links with commits enter their pipelines; the missing
  tail gets ONE chain-continuation implement call, else those links quarantine.
- Crash recovery: links are ordinary units in the map; a crashed lane's committed branches
  auto-adopt via the existing `running`-status guard; uncommitted links re-enter pending and
  re-chain among themselves next launch. No new recovery machinery.
- New prompts open with a shared byte-identical chain preamble (the scoped-down item 4).

### Docs-only items
- **Rulings ledger**: SKILL.md — constraints.md is a numbered rulings ledger: `C-nn — <one-line
  rule> (provenance: who/when/why)`; ids stable, never renumbered or reused; specs, dismissal
  criteria, and tier prompts cite ids; superseding is a NEW ruling referencing the old.
  reference.md constraints.md description updated to match.
- **Handoff census**: SKILL.md close-out/relaunch — after writing any continuation brief,
  dispatch one Haiku census comparing the brief's tip sha, unit counts, unit ids, and pending
  sets against plan.json/state.json; fix mismatches before ending the session (the class:
  hand-written continuations carried a stale tip and an off-by-one unit count).

## Validation

- Every commit: `bash evals/parse.sh && bash evals/unit/run.sh` green.
- New sims per feature (Opus-delegated, existing idioms in evals/unit/): owed lifecycle
  (skip → owed → discharge; count≥2 → tier 3), preview-failed degradation + owed generation,
  .roadmap refusal (strip + re-merge + contract debt), prefixCollision → quarantine (and: no
  globs ⇒ byte-identical merge prompt), plan-evidence threading + reviewer reading-list clause
  ('' when absent), specGap → consult consumption + forceFrontier when unconsulted, chain
  detection/cap/contingent-exclusion/crash-adoption/per-link gate forces, warmLanes:false
  byte-identity, cross-script shared-const identity.
- Post-reset paid cycle: harness fixture, then conductor fixture (both exercise the
  add-multiply→add-divide chain on the happy path; gate-bad/gate-convention keep the teeth
  probes). README rerun discipline applies; a red bisects via `warmLanes:false` for diagnosis
  only, never to ship around.
