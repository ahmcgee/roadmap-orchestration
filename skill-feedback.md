# Skill feedback — roadmap-orchestrator

Defects and improvement asks for the ORCHESTRATOR itself (not the product). Carry
these back to the skill's repository; they are not product debt and never archive
with an arc. **Cleared 2026-08-16 of everything predating the skill update of 2026-08-15 by Aaron, everything below was observed AFTER the update**

## 2026-08-16 (agent-competence arc, wave 1, conductor run wf_f4f9d3b5-ba6)

- **`prefixUniqueGlobs` false positive, second occurrence.** SKILL.md Phase 0 tells the architect
  to set it for any numbered artifact sequence; the merge check asserts GLOBAL uniqueness over the
  post-merge tree, so a repo whose history already holds duplicate prefixes (grandfathered pairs,
  sealed by the product's own migration-number seal) refuses EVERY merge. Cost here: 8 gate-approved
  units quarantined, one full wave (~5.4h, ~10.5M subagent tokens) with zero merges. Wave 8 of the
  prior arc hit the same thing (see above). Fix belongs in the skill: (a) the check must diff prefix
  sets base-vs-merged (only NEW duplicates refuse), and (b) SKILL.md must say "set only if the tree
  is currently prefix-unique; otherwise rely on a product-side seal". Until then: architects, grep
  the tree first.
- `write-failed` checkpoint ×5: the Haiku multi-part state.json writer failed on multiline JSON
  string values ("three/four parts") — the final persist landed, but mid-wave state trailed. A
  chunked writer that base64s or writes via a here-doc per part would remove the class.
- `codex-timeout` ×2 (agent-day-read fix0, executor-abandonment-truth opus-gate-fix0) with
  surviving commits — judged on merits, fine. `codex-exec` thread-store conflict on a gate-fix
  resume ("thread already has a…") — one resume collided with a live session; worth a retry rule.

**ADDRESSED 2026-08-16 v0.11.1**

## 2026-08-16 → 08-28 (agent-competence arc, waves 2–19, skill 0.12.0) — triaged 2026-09-01

188 degradations + 22 narrative entries, collapsed by cause. Raw dump dropped after triage
(committed as 746c412). Root cause under most of it: the workflow script has no filesystem or
shell — `run()` is `agent()` — so every write, checkout, sweep and probe was a model given a *goal*
where the script could have handed it a *closed command list*. That is now the design rule
(RATIONALE §19: "couriers, not janitors"; brakes in code, not prose).

- **`write-failed` ×91 (checkpoint + persist), rising to 35/wave by wave 17.** Not a writer defect:
  degradations + escalations rode inside state.json (~⅓ of a 170–190 KB, 7–8-part document by
  wave 19), so per-checkpoint loss ≈ n·p² and every failed write appended a row that made the next
  write likelier to fail. Fix: events are appended once, at the event, to `.roadmap/degradations.jsonl`
  / `escalations.jsonl` (cksum over the file's tail); state.json carries only the stop counts and is
  back to 1–3 parts. The skill-feedback marker region — an unverified Haiku rewrite that ate a
  hand-written entry (the truncated fragment in this dump) — is gone: the scripts never write
  `skill-feedback.md`; the per-kind summary lands in `.roadmap/skill-degradations.md`.
- **A merge on a detached HEAD orphaned, then the tip reconciled BACKWARDS (08-28); resume
  re-verified and quarantined merged units (08-25, 08-26 ×2).** The merge step never asserted HEAD was
  on the integration branch or that the merge commit was reachable; the wave-start reconcile adopted
  the live sha on mere inequality. Fix: merge attaches HEAD to the branch and `merged` is written only
  after `merge-reach` proves reachability; reconcile is one-way (ancestor or `tip-regressed` + halt);
  "merged" is decided in code at dispatch, in `quarantine()`, and in the crash-residue loop by the
  second-parent test (bare `is-ancestor` false-positives on commit-less branches — the ledger's ask
  was corrected). Environment probes (setup/provision/git/codex/env/preview) are salted with
  `args.launchId` so a resume re-probes live instead of replaying a cached `cd: No such file`.
- **Haiku with destructive reach** — preview `kill -9` of every node process (08-21), tracker
  bootstrap clobbering three issues and issue-new/bank-debt fuzzy marker hits (08-22, 08-23), the
  `.roadmap/` wipe (08-28), the invented codex credential rule (08-26). One fix shape: `courierRun`
  (closed command list in, verbatim `{exitCode, stdout}` out, script judges). Codex probe passes on
  `/logged in/i`; STRICT checks `git rev-parse --git-dir` (linked worktrees valid); the exact
  first-line marker match is a jq predicate the script composes, at all six `gh` sites, and CLOSED
  issues are never edited; debt markers are arc-keyed (the per-unit marker was arc-free too — worse
  than filed); the port sweep is a literal allowlist from `plan.preview.ports` with name-sweeps
  forbidden; the preview lives in `__preview`, so nothing the harness does can touch the operator's
  checkout — that one move closes the kill-9, the wipe and the refused-checkout entries together.
  The ledger's "plain `run()` with no agent" is impossible; containment is the substitute.
- **Agent death → unit verdict (08-25 ×2, quota outage).** Seven bare `run()` sites dereferenced a
  null and fell into `quarantine('pipeline error')`; the dead commit probe became "nothing was
  built". Fix: `runReq` + a platform halt that parks units (`platform-outage`), mirroring the codex
  halt; nulls carry no error text, so the trigger is structural, text-matching only on the throw
  path. Codex lifecycle: `timeout -k` inside the detached launch so the deadline survives steerer
  death; `-1` only after `kill -0` fails; steer prompts are idempotent (pid file → attach), which also
  closes an unfiled second double-codex route (every `schema-retry` on a `codex-build:*` steerer
  re-ran the launch); build-retry reaps first; `fixStep` retries once; the one `codex-exec` bucket
  splits into a NEW kind `codex-lifecycle` (`-1`, no exit file — nobody observed the run finish, so
  its status is unknown, not bad) and `codex-exec` proper (`>0`, codex reporting failure) — the 29
  rows were mostly the former.
- **Wave-level brakes that were prose (08-22 pids, 08-25 shared red, 08-23 precedent, 08-28
  admissions).** The harness had one wave-level flag (`codexHalt`). Now a halt record
  `{codex, env, platform}`; a pids/PID-1 preflight parks before dispatch; `gateMaxConcurrent`
  semaphore; a shared-red breaker collapses N identical out-of-scope failures into ONE finding (never
  debt, so the termination guarantee holds); scope rulings are recorded and shown to sibling gates as
  precedent; `admissions:'closed'` + `tier1MaxDrafts` enforced in code and covering `promote`;
  duplicate drafts are dropped instead of renamed (`x`/`x-2` was #1261/#1262); owed explorer/design
  run at the final wave; persist-plan refuses instead of overwriting root-admitted units; escalating
  returns stage specs/plan/issues/debt first; bank-debt clears only confirmed markers and debt is
  persisted on receipt.
- **Corrected or stale as filed:** the "`.git` directory" STRICT wording no longer existed; mirror
  advance was already sha-gated; contracts/specs were already threaded by absolute root path (gap
  only in boundary agents with a relative `plan.conventions`); `scope-growth` ×22 was ~15 incidents
  (the re-emit guard double-counted 4→5 files) on an arc where Phase 0 never set `scopeAllow`; the
  flake band did NOT run beside live gates — `runBoundary` runs after the scheduler drains, its
  co-tenants were its own siblings + preview, so load is recorded, not gated on, and `LOAD_CMDS`
  stayed one shared command vocabulary (the preflight courier seeds the sample before any lane runs)
  rather than becoming a per-lane courier — an agent per lane, sampling before the suite instead of
  during; "the degradations ledger already carries sibling rulings" — it carried breaches, never
  verdicts.
- **Working as designed / watch:** `codex-timeout` ×10 with surviving commits (unit-sizing signal);
  `codex-uncommitted` ×4; the one `preview-failed` was the root-checkout mirror, now structural.
- **Deferred (backlog, not dropped):** per-unit gate commands in `plan.json` so lane *coverage* is
  script-asserted rather than gate-asserted; delta checkpoints reduced by the root at wave end
  (superseded in 0.14.0: no checkpoints at all; `persist.mjs` replays the journal);
  arc-cumulative scope precedent (wave-scoped now to bound the prompt);
  auto-annotating banked debt that a later merge resolved; `rebanked` over-triggers on crash-residue
  re-entry (a prior-state `merge-ready`), bounded because `mismatchEver` still forces the frontier
  gate.

**ADDRESSED 2026-09-01 v0.13.0**
