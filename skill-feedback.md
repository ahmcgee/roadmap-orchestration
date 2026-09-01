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

<!-- roadmap:degradations -->
## Degradations (188)

- **codex-exec** `codex-build:sweep-truth` (harness · codex · wave 1 · Implement) — codex exited -1 on sweep-truth (/home/no…[see .roadmap/state.json]
- **codex-uncommitted** `codex-fix:sweep-truth#0` (harness · codex · wave 1 · Implement) — codex left uncommitted work on sweep-tru…[see .roadmap/state.json]
- **codex-uncommitted** `codex-fix:sweep-truth#1` (harness · codex · wave 1 · Implement) — codex left uncommitted work on sweep-tru…[see .roadmap/state.json]
- **scope-growth** `verify:sweep-truth#2` (harness · haiku · wave 1 · Verify) — unit sweep-truth's diff reaches 1 file(s…[see .roadmap/state.json]
- **scope-growth** `verify:consultation-rehydrate#0` (harness · haiku · wave 1 · Verify) — unit consultation-rehydrate's diff reach…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 2 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **codex-exec** `codex-build:agent-prior-grounding-2` (harness · codex · wave 2 · Implement) — host process died mid-wave; codex kept r…[see .roadmap/state.json]
- **codex-timeout** `codex-fix:believed-clock-e2e-selectors#0` (harness · codex · wave 3 · Implement) — codex run for believed-clock-e2e-selecto…[see .roadmap/state.json]
- **schema-retry** `explorer:w3` (harness · opus · wave 3 · Boundary) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-exec** `codex-build:agent-prior-grounding-3` (harness · codex · wave 4 · Implement) — codex exited -1 on agent-prior-grounding…[see .roadmap/state.json]
- **schema-retry** `dossier-write:sweep-card-draft-survives-rail` (harness · haiku · wave 4 · Quarantine) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **schema-retry** `opus-gate-verify:believed-day-instant-projection#0` (harness · haiku · wave 5 · Verify) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-exec** `codex-build:raise-verbs` (harness · codex · wave 5 · Implement) — codex exited -1 on raise-verbs (/home/no…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 5 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **scope-growth** `verify:raise-verbs#0` (harness · haiku · wave 5 · Verify) — unit raise-verbs's diff reaches 4 file(s…[see .roadmap/state.json]
- **scope-growth** `verify:raise-verbs#1` (harness · haiku · wave 5 · Verify) — unit raise-verbs's diff reaches 5 file(s…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 5 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **schema-retry** `codex-build:fit-the-day-held-section` (harness · haiku · wave 6 · Implement) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **scope-growth** `verify:fit-the-day-held-section#0` (harness · haiku · wave 6 · Verify) — unit fit-the-day-held-section's diff rea…[see .roadmap/state.json]
- **codex-timeout** `codex-fix:operator-clock-controls-standalone-2#0` (harness · codex · wave 6 · Implement) — codex run for operator-clock-controls-st…[see .roadmap/state.json]
- **codex-uncommitted** `codex-fix:operator-clock-controls-standalone-2#0` (harness · codex · wave 6 · Implement) — codex left uncommitted work on operator-…[see .roadmap/state.json]
- **scope-growth** `verify:operator-clock-controls-standalone-2#1` (harness · haiku · wave 6 · Verify) — unit operator-clock-controls-standalone-…[see .roadmap/state.json]
- **scope-growth** `verify:sweep-card-draft-survives-rail-3#2` (harness · haiku · wave 6 · Verify) — unit sweep-card-draft-survives-rail-3's …[see .roadmap/state.json]
- **scope-growth** `verify:room-entry-kick-hold#1` (harness · haiku · wave 6 · Verify) — unit room-entry-kick-hold's diff reaches…[see .roadmap/state.json]
- **codex-exec** `codex-gate-fix:room-entry-kick-hold#0` (harness · codex · wave 6 · Implement) — codex exited -1 on room-entry-kick-hold …[see .roadmap/state.json]
- **codex-timeout** `codex-fix:calendar-multi-day-span#0` (harness · codex · wave 6 · Implement) — codex run for calendar-multi-day-span ex…[see .roadmap/state.json]
- **codex-exec** `codex-gap-fix:calendar-multi-day-span#1` (harness · codex · wave 6 · Implement) — codex exited -1 on calendar-multi-day-sp…[see .roadmap/state.json]
- **codex-uncommitted** `codex-gap-fix:calendar-multi-day-span#1` (harness · codex · wave 6 · Implement) — codex left uncommitted work on calendar-…[see .roadmap/state.json]
- **schema-retry** `codex-build:all-day-recurrence` (harness · haiku · wave 6 · Implement) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 6 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **scope-growth** `verify:all-day-recurrence#0` (harness · haiku · wave 6 · Verify) — unit all-day-recurrence's diff reaches 1…[see .roadmap/state.json]
- **codex-exec** `codex-fix:fit-band-header-truth#0` (harness · codex · wave 7 · Implement) — codex exited -1 on fit-band-header-truth…[see .roadmap/state.json]
- **codex-timeout** `codex-fix:e2e-tenant-day-smokes#0` (harness · codex · wave 7 · Implement) — codex run for e2e-tenant-day-smokes exce…[see .roadmap/state.json]
- **scope-growth** `verify:fit-band-header-truth#1` (harness · haiku · wave 7 · Verify) — unit fit-band-header-truth's diff reache…[see .roadmap/state.json]
- **codex-exec** `codex-fix:fit-band-header-truth#1` (harness · codex · wave 7 · Implement) — codex exited 1 on fit-band-header-truth …[see .roadmap/state.json]
- **scope-growth** `verify:fit-band-header-truth#2` (harness · haiku · wave 7 · Verify) — unit fit-band-header-truth's diff reache…[see .roadmap/state.json]
- **schema-retry** `verify:e2e-tenant-day-smokes#2` (harness · haiku · wave 7 · Verify) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 7 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `persist-state:w7` (conductor · haiku · wave 7 · Persist) — state.json persist did not land (part 4/…[see .roadmap/state.json]
- **codex-exec** `codex-build:feedback-clock-pill-believed` (harness · codex · wave 9 · Implement) — codex exited -1 on feedback-clock-pill-b…[see .roadmap/state.json]
- **schema-retry** `checkpoint:part2` (harness · haiku · wave 9 · Setup) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-exec** `codex-build:occurrence-detail-span-truth` (harness · codex · wave 9 · Implement) — codex exited -1 on occurrence-detail-spa…[see .roadmap/state.json]
- **scope-growth** `verify:sweep-card-draft-survives-rail-4#0` (harness · haiku · wave 9 · Verify) — unit sweep-card-draft-survives-rail-4's …[see .roadmap/state.json]
- **scope-growth** `verify:all-day-series-edit-door#1` (harness · haiku · wave 9 · Verify) — unit all-day-series-edit-door's diff rea…[see .roadmap/state.json]
- **scope-growth** `verify:e2e-walk-journey-budgets#0` (harness · haiku · wave 10 · Verify) — unit e2e-walk-journey-budgets's diff rea…[see .roadmap/state.json]
- **schema-retry** `codex-build:web-me-fixture` (harness · haiku · wave 10 · Implement) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-exec** `codex-build:evidence-queue-single-source` (harness · codex · wave 11 · Implement) — codex exited -1 on evidence-queue-single…[see .roadmap/state.json]
- **schema-retry** `verify:fit-day-completed-task-truth#0` (harness · haiku · wave 11 · Verify) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **schema-retry** `codex-build:operator-believed-time-input-truth` (harness · haiku · wave 11 · Implement) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **schema-retry** `verify:checkin-last-day-bounded#0` (harness · haiku · wave 11 · Verify) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-exec** `codex-build:fit-day-margin-shading` (harness · codex · wave 11 · Implement) — codex exited -1 on fit-day-margin-shadin…[see .roadmap/state.json]
- **codex-exec** `codex-build:sweep-draft-survives-station-hop` (harness · codex · wave 11 · Implement) — codex exited -1 on sweep-draft-survives-…[see .roadmap/state.json]
- **scope-growth** `verify:chat-queue-settled-decisions#0` (harness · haiku · wave 11 · Verify) — unit chat-queue-settled-decisions's diff…[see .roadmap/state.json]
- **scope-growth** `verify:operator-believed-time-input-truth#0` (harness · haiku · wave 11 · Verify) — unit operator-believed-time-input-truth'…[see .roadmap/state.json]
- **codex-exec** `codex-build-retry:fit-day-margin-shading` (harness · codex · wave 11 · Implement) — codex exited -1 on fit-day-margin-shadin…[see .roadmap/state.json]
- **codex-exec** `codex-build:executor-day-focus` (harness · codex · wave 11 · Implement) — codex exited -1 on executor-day-focus (/…[see .roadmap/state.json]
- **codex-exec** `codex-opus-gate-fix:operator-believed-time-input-truth#0` (harness · codex · wave 11 · Implement) — codex exited 1 on operator-believed-time…[see .roadmap/state.json]
- **codex-spec-review** `codex-spec-review:fit-day-validation-snapshot` (harness · haiku · wave 11 · Implement) — cross-model spec critique skipped for fi…[see .roadmap/state.json]
- **codex-timeout** `codex-fix:checkin-last-day-bounded#0` (harness · codex · wave 11 · Implement) — codex run for checkin-last-day-bounded e…[see .roadmap/state.json]
- **schema-retry** `codex-build:fit-day-validation-snapshot` (harness · haiku · wave 11 · Implement) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-exec** `codex-build:fit-day-validation-snapshot` (harness · codex · wave 11 · Implement) — codex exited -1 on fit-day-validation-sn…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 11 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **schema-retry** `verify:w10-debt-sweep#1` (harness · haiku · wave 11 · Verify) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **schema-retry** `verify:executor-day-focus#0` (harness · haiku · wave 11 · Verify) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-timeout** `codex-opus-gate-fix:checkin-last-day-bounded#0` (harness · codex · wave 11 · Implement) — codex run for checkin-last-day-bounded e…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 11 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **schema-retry** `codex-build-retry:sweep-draft-survives-station-hop` (harness · haiku · wave 11 · Implement) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-timeout** `codex-build-retry:sweep-draft-survives-station-hop` (harness · codex · wave 11 · Implement) — codex run for sweep-draft-survives-stati…[see .roadmap/state.json]
- **schema-retry** `checkpoint:part2` (harness · haiku · wave 11 · Setup) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 12 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 12 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 12 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **codex-unavailable** `codex-probe:w13` (harness · haiku · wave 13 · Setup) — codex CLI unavailable (codex-cli 0.147.0…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 13 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `persist-state:w13` (conductor · haiku · wave 13 · Persist) — state.json persist did not land (part 4/…[see .roadmap/state.json]
- **codex-exec** `codex-build:calendar-chip-helper-reanchor-2` (harness · codex · wave 14 · Implement) — codex exited -1 on calendar-chip-helper-…[see .roadmap/state.json]
- **schema-retry** `verify:week-allday-overflow-door-2#0` (harness · haiku · wave 14 · Verify) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-timeout** `codex-gate-fix:unplanned-task-form-a11y#0` (harness · codex · wave 14 · Implement) — codex run for unplanned-task-form-a11y e…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 14 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 14 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **schema-retry** `checkpoint:part4` (harness · haiku · wave 14 · Setup) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 14 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 14 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 14 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 14 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 14 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `persist-state:w14` (conductor · haiku · wave 14 · Persist) — state.json persist did not land (part 2/…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 15 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 15 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **codex-exec** `codex-build:task-create-scheduling-intent` (harness · codex · wave 15 · Implement) — codex exited -1 on task-create-schedulin…[see .roadmap/state.json]
- **schema-retry** `codex-build:fit-day-snapshot-anchor` (harness · haiku · wave 15 · Implement) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 15 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **codex-exec** `codex-build:chat-queue-redesign` (harness · codex · wave 15 · Implement) — codex exited -1 on chat-queue-redesign (…[see .roadmap/state.json]
- **codex-timeout** `codex-fix:chat-queue-redesign#0` (harness · codex · wave 15 · Implement) — codex run for chat-queue-redesign exceed…[see .roadmap/state.json]
- **schema-retry** `codex-fix:chat-queue-redesign#1` (harness · haiku · wave 15 · Fix) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **scope-growth** `verify:chat-queue-redesign#2` (harness · haiku · wave 15 · Verify) — unit chat-queue-redesign's diff reaches …[see .roadmap/state.json]
- **codex-exec** `codex-build:design-queue-row-shape` (harness · codex · wave 15 · Implement) — codex exited -1 on design-queue-row-shap…[see .roadmap/state.json]
- **codex-timeout** `codex-fix:chat-queue-redesign#2` (harness · codex · wave 15 · Implement) — codex run for chat-queue-redesign exceed…[see .roadmap/state.json]
- **codex-exec** `codex-build:fit-day-agentic-priority` (harness · codex · wave 15 · Implement) — codex exited -1 on fit-day-agentic-prior…[see .roadmap/state.json]
- **scope-growth** `verify:fit-day-agentic-priority#0` (harness · haiku · wave 15 · Verify) — unit fit-day-agentic-priority's diff rea…[see .roadmap/state.json]
- **codex-exec** `codex-fix:fit-day-agentic-priority#0` (harness · codex · wave 15 · Implement) — codex exited 1 on fit-day-agentic-priori…[see .roadmap/state.json]
- **codex-exec** `codex-build:rehearse-domain-import` (harness · codex · wave 16 · Implement) — codex exited -1 on rehearse-domain-impor…[see .roadmap/state.json]
- **schema-retry** `codex-build:fit-open-put-anchor-test` (harness · haiku · wave 16 · Implement) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **schema-retry** `verify:w15-test-hygiene#0` (harness · haiku · wave 16 · Verify) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **scope-growth** `verify:chat-queue-redesign-2#0` (harness · haiku · wave 16 · Verify) — unit chat-queue-redesign-2's diff reache…[see .roadmap/state.json]
- **scope-growth** `verify:chat-queue-redesign-2#1` (harness · haiku · wave 16 · Verify) — unit chat-queue-redesign-2's diff reache…[see .roadmap/state.json]
- **schema-retry** `verify:rehearse-domain-import#1` (harness · haiku · wave 16 · Verify) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **preview-failed** `preview-setup` (harness · haiku · wave 17 · Preview) — preview mirror never came up (git checko…[see .roadmap/state.json]
- **scope-growth** `verify:chat-queue-redesign-3#0` (harness · haiku · wave 17 · Verify) — unit chat-queue-redesign-3's diff reache…[see .roadmap/state.json]
- **schema-retry** `codex-gate-fix:chat-queue-redesign-3#0` (harness · haiku · wave 17 · Fix) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **codex-exec** `codex-build:fit-day-hold-truth` (harness · codex · wave 17 · Implement) — codex exited -1 on fit-day-hold-truth (/…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **schema-retry** `codex-build:fit-day-agentic-priority-2` (harness · haiku · wave 17 · Implement) — structured output rejected, retrying — a…[see .roadmap/state.json]
- **codex-exec** `codex-opus-gate-fix:select-listbox-escape-scroll#1` (harness · codex · wave 17 · Implement) — codex exited -1 on select-listbox-escape…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 17 · Setup) — state.json checkpoint did not land (part…[see .roadmap/state.json]
- **no-report** `design:w17` (harness · opus · wave 17 · Boundary) — design reconcile did not report for fit-…[see .roadmap/state.json]
- **write-failed** `checkpoint` (harness · haiku · wave 18 · Setup) — state.json checkpoint did not land (part 3/4: The file was written but cksum verification failed. Expected checksum: 1879622196 24161. Observed checksum: 4066469282 24661. The file is 500 bytes larger than expected (24661 vs 24161 bytes). Unable  — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 18 · Setup) — state.json checkpoint did not land (part 3/4: File /workspaces/atlas2/.roadmap/state.json.part3 was written via cat here-doc, but checksum verification failed. Expected: 1879622196 24161. Observed: 1433258331 24411 (byte count differs by 250 byte — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 18 · Setup) — state.json checkpoint did not land (part 3/4: File /workspaces/atlas2/.roadmap/state.json.part3 was written via cat here-doc, but checksum verification failed. Expected: 2357072307 24154. Observed: 3940626470 24404 (byte count differs by 250 byte — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **codex-exec** `codex-build:w17-closeout-sweep` (harness · codex · wave 18 · Implement) — codex exited -1 on w17-closeout-sweep (/home/node/atlas2-roadmap-wt/__codex/w17-closeout-sweep/build; Codex process terminated before turn completion. Partial modifications to apps/core/test/fit-sort.test.ts exist but are uncommitted.) — no commits survive
- **write-failed** `checkpoint` (harness · haiku · wave 18 · Setup) — state.json checkpoint did not land (part 3/5: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part3. Expected checksum: 1057565842 24160. Observed checksum: 3825778210 24160. The byte count matches (24160 bytes) but the ch — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 18 · Setup) — state.json checkpoint did not land (part 3/5: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part3. Expected checksum: 1551935542 24098. Observed checksum: 930492050 24348. The file is 250 bytes larger than expected (2434 — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 18 · Setup) — state.json checkpoint did not land (part 3/5: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part3. Expected checksum: 272746938 24157. Observed checksum: 2837794012 23907. The file is 250 bytes smaller than expected (239 — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 18 · Setup) — state.json checkpoint did not land (part 3/5: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part3. Expected checksum: 1057565842 24160. Observed checksum: 3825778210 24160. The byte count matches (24160 bytes) but the ch — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 18 · Setup) — state.json checkpoint did not land (part 3/5: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part3. Expected checksum: 1551935542 24098. Observed checksum: 930492050 24348. The file is 250 bytes larger than expected (2434 — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 18 · Setup) — state.json checkpoint did not land (part 3/5: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part3. Expected checksum: 272746938 24157. Observed checksum: 2837794012 23907. The file is 250 bytes smaller than expected (239 — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 3/5: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part3. Expected checksum: 2907114505 24147. Observed checksum: 397910752 24397. The file is 250 bytes larger than expected (2439 — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 3/5: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part3. Expected checksum: 2907114505 24147. Observed checksum: 397910752 24397. The file is 250 bytes larger than expected (2439 — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 3/5: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part3. Expected checksum: 3758160069 24018. Observed checksum: 4026178684 23518. The file is 500 bytes smaller than expected (23 — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/5: File /workspaces/atlas2/.roadmap/state.json.part4 was written via cat here-doc, but checksum verification failed. Expected checksum: 3075963161 24133. Observed checksum: 2654326785 24383. The file is  — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **schema-retry** `codex-build:checkin-selection-state-published` (harness · haiku · wave 19 · Implement) — structured output rejected, retrying — agent({schema}): StructuredOutput retry cap (5) exceeded — 5 failed calls with no valid output
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/6: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part4. Expected checksum: 2166552923 24141. Observed checksum: 3169141288 24391. The file is 250 bytes larger than expected (243 — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/6: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part4. Expected checksum: 499254932 24156. Observed checksum: 3245338626 23656. The file is 500 bytes smaller than expected (236 — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/6: File /workspaces/atlas2/.roadmap/state.json.part4 was written via cat here-doc, but checksum verification failed. Expected checksum: 2530579057 24161. Observed checksum: 2527106235 21932. The file is  — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **codex-exec** `codex-build:w18-debt-sweep` (harness · codex · wave 19 · Implement) — codex exited -1 on w18-debt-sweep (/home/node/atlas2-roadmap-wt/__codex/w18-debt-sweep/build) — 2 commit(s) survive and the branch is judged on its merits
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/6: File write verification failed. Expected checksum: 3698764564 24150. Observed checksum: 3252109057 24400. The file is 250 bytes larger than expected (24400 vs 24150 bytes). The write was executed via  — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/6: Checksum mismatch. Expected: 456134834 24080. Observed: 1629902445 23080. File size is 1000 bytes short of expected (23080 vs 24080 bytes). The provided content appears to be incomplete or truncated i — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/6: Checksum mismatch: expected 456134834 24080, observed 4274473662 23580. The file was written with exact content from the provided message following the <<<PART 4/6>>> marker. The observed checksum doe — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/6: Checksum mismatch for /workspaces/atlas2/.roadmap/state.json.part4. Observed: 3977178508 23830 (size 23830 bytes). Expected: 456134834 24080 (size 24080 bytes). File size differs by 250 bytes. The mes — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: cksum output: 1901100021 23580 (expected: 456134834 24080). File byte count 23580 does not match expected 24080. Content written does not verify. — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **schema-retry** `gap-verify:executor-project-tree-threshold#1` (harness · haiku · wave 19 · Verify) — structured output rejected, retrying — agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: cksum verification failed. Expected: 456134834 24080. Observed: 1901100021 23580. File written to /workspaces/atlas2/.roadmap/state.json.part4 but content hash does not match expected value. The file  — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: cksum verification failed. Expected: 456134834 24080. Observed: 3977178508 23830. File is 250 bytes shorter than expected. The content provided in the message appears truncated or incomplete. — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **codex-exec** `codex-build:select-trigger-combobox-role` (harness · codex · wave 19 · Implement) — codex exited -1 on select-trigger-combobox-role (/home/node/atlas2-roadmap-wt/__codex/select-trigger-combobox-role/build; Still executing; verify gate in progress.) — 2 commit(s) survive and the branch is judged on its merits
- **scope-growth** `verify:select-trigger-combobox-role#0` (harness · haiku · wave 19 · Verify) — unit select-trigger-combobox-role's diff reaches 5 file(s) outside its pinned scope: apps/e2e/tests/calendar-smoke.spec.ts, apps/e2e/tests/container-lifecycle-journey.spec.ts, apps/e2e/tests/m2-c1-journey.spec.ts, apps/e2e/tests/placement-journey.spec.ts, apps/e2e/tests/today-smoke.spec.ts — the exit gate adjudicates each (necessary vs creep); this is a signal, never a licence to fix them
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: cksum mismatch on /workspaces/atlas2/.roadmap/state.json.part4 — observed `1975502994 23330` but expected `456134834 24080` (file 750 bytes short). Content was written using a single-quoted here-doc a — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: Checksum mismatch: wrote to /workspaces/atlas2/.roadmap/state.json.part4 but observed checksum 414805262 23919 instead of expected 529944215 24169. File size difference: 23919 bytes observed vs 24169  — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: Write failed: checksum mismatch. Expected: 280918075 24197; Observed: 1468335787 24697. The file is 500 bytes larger than expected (24697 vs 24197 bytes). The content was written from the message with — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: Checksum verification failed. Expected: 280918075 24197 | Observed: 3602138420 23923 (24197 - 23923 = 274 bytes short). The file was written from the message content after the <<<PART 4/7>>> marker, b — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: File write completed but checksum mismatch. Expected: 280918075 24197 (size 24197 bytes). Observed: 3602138420 23923 (size 23923 bytes). Difference: 274 bytes short. The message content appears to be  — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: Checksum mismatch: expected 3324081646 24216, got 2698722664 23966. File written is 250 bytes short. The message content appears truncated, ending mid-JSON at 'kind: write-failed,'. Per instructions, ; part 5/7: File write verification failed. Expected checksum: 1793806811 24172. Observed checksum: 448552521 24422. The file is 250 bytes larger than expected (24422 bytes vs expected 24172 bytes). The content w — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/7: Checksum mismatch: observed cksum output is '2698722664 23966' but expected '3324081646 24216'. File size is 23966 bytes instead of 24216 bytes (250 bytes short). The provided content appears to end w; part 5/7: File write to /workspaces/atlas2/.roadmap/state.json.part5 failed checksum verification. Expected checksum: 1793806811 24172 (size 24172 bytes). Observed checksum: 1875844751 24422 (size 24422 bytes). — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 5/7: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part5. Expected: 3388564492 24166. Observed: 2773956637 24416. File is 250 bytes larger than expected (24416 vs 24166 bytes). — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it
- **write-failed** `checkpoint` (harness · haiku · wave 19 · Setup) — state.json checkpoint did not land (part 4/8: Checksum mismatch: wrote file /workspaces/atlas2/.roadmap/state.json.part4 but cksum returned 2698722664 23966 (file size 23966 bytes) instead of expected 3324081646 24216 (expected file size 24216 by; part 5/8: Checksum verification failed for /workspaces/atlas2/.roadmap/state.json.part5. Expected checksum: 3388564492 24166. Observed checksum: 3107583325 24166. The byte count matches (24166 bytes) but the ch — assembly skipped, previous file left intact) — on-disk state may trail the run; the next successful checkpoint heals it

Each line names the agent label — find its transcript in the workflow's agent-*.jsonl to see the real error, which the platform does not expose to the script.
<!-- /roadmap:degradations -->
the sha marker), not a Haiku ok flag; (2) an owed explorer/design at the FINAL wave must run
  in the same boundary, not be deferred to a boundary that never comes. Also: the preview mirror
  keeps core at the process's start commit while vite serves the working tree — the two can
  drift within a wave; restart core on retarget.

## 2026-08-21 — conductor killed by its own preview-refresh agent (kill -9 all node)

The wave-6/7 run (wf_097bb961-db9) completed all merges, checkpointed state, then died
mid-preview-refresh. Journal + agent transcript show the mechanism: the Haiku
preview-refresh agent, following the prompt's port-conflict escalation ("sweep leftover
listeners exactly once"), ran `fuser -k 3000/tcp 5173/tcp 8000/tcp` and then
`ps aux | grep -E "node|chrome" | ... | xargs kill -9` — killing EVERY node process on
the host, including the conductor workflow itself, its steering agents, and unrelated
sessions. Cost: the final all-terminal boundary never ran and the conductor never
returned (`conductor.reason: null`); the arc state had to be reconstructed manually
from journal + state.json (both were coherent — checkpointing worked as designed).

Fix for the skill: the preview prompt's sweep clause must enumerate the ONLY legal kill
targets — the pidfile's process group and listeners on the preview's own ports (fuser on
those ports is fine) — and explicitly forbid process-name sweeps (`pkill node`,
`ps | grep | kill`). Better: the harness performs the sweep itself deterministically
instead of delegating an open-ended "clean up ports" instruction to a Haiku agent; a
cheap model given a janitorial goal and root-ish reach will reach for the biggest hammer.
Same family as the earlier wedged-steerer entry: unbounded operational discretion at the
cheapest tier is where the harness keeps getting hurt.

## 2026-08-22 — Phase-0 tracker bootstrap clobbered three pre-existing issues (loose marker match)

The Haiku bootstrap agent was told to find-or-create unit issues by the body marker
(`gh issue list --search '"roadmap:unit id=<id>"' --state all`). GitHub's search tokenizes the
quoted phrase, so `id=sweep-truth` matched a CLOSED merged unit from the 2026-07-25 arc (#690,
`commuting-answer-truth`), `id=agent-prior-grounding` matched #699 (`executor-mint-fidelity`), and
`id=raise-verbs` matched #5 — the OPEN prompt co-authoring agenda issue. The agent then
"reused" them: overwrote title + body, swapped labels (`status:merged`→`status:pending`,
`wave:8`→`wave:1`), and moved them into the new milestone. Restored by hand from
`userContentEdits` (GraphQL) + the timeline's `renamed`/`labeled`/`milestoned` events; three
real unit issues created (#1058/#1059/#1060); arc checklist and adoption comments repointed.

Fix for the skill (find-or-create in `reference.md` → "Idempotent by marker"): a search hit is a
CANDIDATE only — the agent must fetch the body and require the exact first line
`<!-- roadmap:unit id=<id> -->` before adopting; anything else → create. Also: never relabel or
re-milestone a CLOSED issue at Phase 0, and never strip `status:merged`. Cheapest tier with a
destructive edit and a fuzzy match is the same family as the preview `kill -9` sweep.

## 2026-08-22 — no pids-headroom guard: a reaper-less box quarantines a whole wave (0.12.0)
- Observed: the devcontainer predates compose `init: true` (PID 1 = `sleep infinity` since 08-15);
  killed vitest/pnpm/codex runs left 35,940 zombies parented to PID 1, holding 36,350 of the pid
  cgroup's 36,792. Wave 3's three full-suite gates all forked into `spawn sh EAGAIN` / tsc
  cannot fork / `test:build` SIGABRT and were quarantined as "environment blocked"; tier-3 (Fable)
  diagnosed it correctly and escalated needs-user (the fix — recreate the container — is outside
  the box). The 08-16 zombie-wrapper entry above was the same root cause at ~9.5k zombies.
- Suggestion: harness preflight (and the verify stage) should read `/sys/fs/cgroup/pids.current`
  vs `pids.max` and `ps -p 1 -o comm=`; below ~20% headroom or a non-reaping PID 1, halt dispatch
  with a `reaper`/`pids` halt reason BEFORE burning codex+gate rounds, the way the codex-auth halt
  already parks units. Cheap, deterministic, and it turns a whole-wave quarantine into one line.
- Also arc-observed: `needs-user` returns from tier-3 happen BEFORE the persist step, so the
  skeletons in `newUnits`, the journal and the debt ledger exist only in the workflow journal
  (`journal.jsonl`) — the root had to spec-expand, mergePlan, open issues and bank debt by hand.
  Persist the tier-3 output (specs + plan + journal + debt) before returning needs-user; the user's
  answer rarely changes the staged units.
- Debt-ledger marker `roadmap:debt wave=N ledger` is not arc-keyed: the wave-3 ledger search
  matched #1011 from a prior arc (its wave 3) and would have silently skipped creation. Key it
  with the arc (cut-line date or tracking issue), e.g. `wave=3 ledger arc=<trackingIssue>`.
- Still owed from wave 1: the provisioning STRICT preamble must accept a linked worktree
  (`git rev-parse --git-dir`, not "a .git directory") — see the wave-1 ledger (#1071).

## 2026-08-23 — false "dead on arrival" fires build-retry into a LIVE worktree (two codex processes, same checkout)

- Observed on raise-verbs (wave 5, run wf_78efa40c-155): the Haiku steer agent for `codex-build:raise-verbs`
  returned `codex.exitCode: -1, commits: 0, error: "Process terminated after 96 seconds without exit-code"`
  while the codex process (pid 1558653, `__codex/raise-verbs/build/`) was alive and reading the spec. The
  steer agent inferred death from "no exit-code yet" after ~96 s instead of checking the pid. `buildStep`
  then took the retry branch and launched `build-retry` (pid 1566067) into the SAME worktree 4.5 min later.
- Outcome was benign only by luck: the retry codex noticed "a second Codex implementation process is actively
  editing this exact worktree", reported `blocked`, and has been narrating the first process's progress
  read-only for 1h+ (it will hand off when the original exits). Cost: a full second codex session of tokens
  and a steer agent pinned for the unit's whole lifetime; risk: two implementers racing one checkout.
- Fixes (harness): (1) steer agents must treat "no exit-code file" as RUNNING unless `kill -0 $(cat codex.pid)`
  fails — a dead verdict needs a dead pid; (2) `buildStep`'s retry must `kill` the prior pid (and wait for
  the exit-code file) before launching into the same worktree, or launch nowhere; (3) the retry brief should
  tell codex the previous attempt is dead — if it finds a live sibling, that is itself a harness bug to
  report, not a condition to wait on.

## 2026-08-23 — issue-new/bank-debt "search by marker" is fuzzy: 8 of 11 unit issues resolved to OLD issues

- `gh issue list --search '"roadmap:unit id=<id>" in:body'` is GitHub full-text search: it tokenizes the
  marker, so `roadmap:unit id=clock-pill-day-only` matched `#1055 believed-clock`, `…-standalone-2`
  matched `#1089 web-me-fixture`, `all-day-recurrence` matched `#715`, etc. The Haiku issue-new agent
  reported them as "found" and the plan would have cached wrong numbers (the merge path then closes
  the wrong issues). Same family as the 2026-08-22 tracker clobber.
- Fix: after any search hit, READ the candidate's body first line and accept it only if it equals
  `<!-- roadmap:unit id=<id> -->` exactly (same for `roadmap:debt` markers); treat a non-matching hit
  as "absent". Root did the eight creations by hand this time.

## 2026-08-23 — exit-gate scope adjudication is precedent-blind

Two identical-class out-of-scope e2e edits in one wave (both fixing
calendar-smoke tenant-day drift from inside an unrelated unit): rail-3's
4f8d2557 was rejected and reverted; fit-the-day-held-section's a451aa6c was
admitted and merged. Either verdict is defensible alone — inconsistent
together. Fix: the exit gate's scope-growth adjudication should be shown
sibling/near-past scope rulings from the same wave (the degradations ledger
already carries them) so identical breaches get identical verdicts, and a
surviving out-of-scope fix should auto-annotate any banked debt items that
claim the defect still exists (four units banked "calendar-smoke is red" debt
AFTER the fix had already merged).

## 2026-08-25 — a platform-wide quota outage is not a per-unit verdict

When the weekly usage limit hit mid-wave, the harness translated every dead
agent into unit-level conclusions: three units "quarantined" on "pipeline
error: null is not an object (evaluating 'verify.blocked')", one on
"implementer produced neither a report nor a commit — nothing was built"
(its branch had all three milestones committed). Fixes: (1) an agent() null
whose failure text matches a quota/limit error should PAUSE the run (or return
a distinct 'platform-outage' reason), never quarantine — the errors are
global, synchronized, and say so in their message; (2) the harness crashed on
`verify.blocked` of a null verify result — guard it; (3) a `codex exec
resume` child whose steer agent dies wedges forever at `thread.started` — the
detached launcher needs a watchdog on events.jsonl mtime tied to
codexTimeoutMin, and kill-on-steer-death like the build-retry fix already
logged 2026-08-23.

## 2026-08-25 — second and third null-deref sites on agent death (resume pass)

The resumed wf_773e1460-6e2 lost 6 agents to transient "Connection lost
mid-response" errors and the harness again converted each into a unit
quarantine: the polish loop dereferences `verify.blocked` at four sites
(harness.mjs, per the e2e-tenant-day-smokes dossier) and the frontier exit
gate calls `capDirectives(gate, …)` on a null `gate` (`g.directives`,
harness.mjs ~2211-2224, per the room-feedback-dot-reachable dossier). Same
class as the quota-outage defect logged 2026-08-25: every `agent()` return
needs a null guard that routes to retry-or-pause, never to a unit verdict.
Also: a contract debt item banked from a CACHED implementer report is
re-banked verbatim on resume even after the branch resolves it — dedup debt
by (unit, kind, what-hash) against resolution state, or at least mark
re-banks, so resolved contract ghosts stop forcing contract-amendment
returns.

## 2026-08-25 — resume regressed a merged unit; returned state must be reconciled against git
Resume #2 of wf_773e1460-6e2 re-ran verify agents for fit-band-header-truth — a unit resume #1 had already gated and MERGED (d0da9f16). The re-run verify failed on a pre-existing e2e red and the harness re-marked the unit quarantined and rolled integrationTip back to 73c4885d in the returned state. Merged facts must be immutable on resume: once a unit's merge commit exists on the integration branch, later agent verdicts about it are moot — the harness should pin (status=merged, mergedAt) from the journal and skip re-verify entirely, and the conductor's returned state should never carry a tip older than the branch head it can read from git. Root had to reconcile by hand this wave.

## 2026-08-25 — no circuit breaker for a shared pre-existing red
One pre-existing calendar-smoke defect (deterministic from 2026-08-25) failed EVERY unit's e2e gate simultaneously. The harness produced: 3 per-unit contract majors, 2 quarantines, 4 independent scope-creep patches to the same file on 4 branches (one later reverted to honour an empty-diff AC), and a wave-wide deadlock — instead of ONE arc-level signal "shared gate failure outside all scopes; adjudicate once". Wanted: when N units' gates fail on an identical failing spec that none of their diffs touch, collapse to a single boundary-level contract item, pause the affected gates, and let the architect home one canonical fix. Would have saved ~6 fix rounds and a full conductor round-trip.

## 2026-08-26 — persist-plan overwrites the on-disk plan (root-admitted units lost)
The conductor's Persist phase writes plan.json from its in-memory copy (launch args), silently discarding units/edges the root architect admitted to the on-disk plan while the run was in flight — wave-10 persist dropped all 9 user-admitted units (#1150-#1156, #1128, #1129) even though its own wave-10 triage cited one of them ("covered by pending plan unit fit-day-completed-task-truth") when closing the source issues. Persist should MERGE by unit id (disk wins for units the run never touched) or refuse and surface a conflict; overwrite is only safe if the plan is append-only within the run. Restored at root from the session transcript.

## 2026-08-26 — wall-clock unit budget + self-inflicted load = false quarantines; quarantine-after-merge diverges state from git
Wave 11 quarantined clock-pill-seal-scans for "broke the integrated suite" AFTER its merge commit (76bdc2be) was already an ancestor of the tip — the red was packages/domain recurrence.test.ts breaching the 100ms wall-clock unit budget at load 28-35 on 16 cores, a file/lane the unit never touched, saturation the orchestrator itself created. Two defects: (1) a post-merge red on a shared pre-existing/global cause must not re-verdict an already-merged unit — git is truth, and the harness should attribute integrated-suite reds to the tip, not the last merger; (2) the harness runs N units' full gate suites concurrently with no host-load cap, then evaluates wall-clock budgets against the host it saturated (loads 28-56 observed; 2 more units env-quarantined the same wave). A gate-level concurrency semaphore or load-aware verdict deferral belongs in the harness. Root reconciled state to git and minted unit-duration-budget-under-load for the repo-side gate premise.

## 2026-08-26 — resume replays cached PROVISIONING FAILURES; an aborted resume poisons the journal

Sequence: container rebuilt mid-wave-12 (worktree root wiped). A first resume was TaskStop'd within
a minute, but its per-unit Setup agents had already fired against the missing paths and journaled
`cd: No such file or directory` results. After root repaired every worktree, the second resume
(byte-identical args, same run id) replayed those cached failures and quarantined all 11 wave-12
units — including two already MERGED in git (readings-sleep-plausibility 3d3418fb,
web-draft-store-unify 48a4a218) — then the boundary triage spent a Fable turn and 12 issues
re-landing branches that were sound. Ask: (a) Setup/provision results are environment facts, not
work products — never serve them from cache on resume; re-probe the path live (a `test -d`
is cheaper than the cached agent call). (b) A unit whose branch is already an ancestor of the
integration tip is `merged`, full stop — the harness must check ancestry before any dispatch
or quarantine verdict (third filing of "git is truth"; see 2026-08-25 and 2026-08-26 entries).

## 2026-08-26 — codex probe: Haiku invented a credential requirement and halted the wave

`codex-probe:w13` ran `codex login status`, saw `Logged in using ChatGPT`, and returned ok:false
with detail "not logged in with Claude/Anthropic credentials as required" — a requirement that
exists nowhere in the prompt (which says "ONLY if … the login status says logged in"). Same
auth had just completed 111 codex runs. The wave halted before dispatch and the conductor
returned `codex-unavailable`; `state.codex.halt` then blocks every relaunch until root clears it
by hand. Ask: make the probe mechanical — run `codex --version` and `codex login status` from the
script (or a shell-only step) and pattern-match `/logged in/i`; a model judgment call is the
wrong tool for a binary CLI fact. Until then, the prompt should state explicitly that ANY
"Logged in" line (ChatGPT, API key, device) is a pass.

## 2026-08-26 — bank-debt:w12 dropped the 23 carried debt items; only the triage ledger landed

`state.debt` carried 23 wave-11 items into the wave-12 run. The bank pass created ONE issue
(#1193, the 8-item boundary-triage ledger) and returned ok:true; no per-unit
`roadmap:debt wave=12 unit=<uid>` issue was created or updated, yet the returned state had
`debt: []` — the items were consumed without a durable record. Root recovered all 23 from the
wave-11 journal and banked them by hand (#1194–#1204). Ask: bank-debt must verify each
expected per-unit issue exists (by marker) BEFORE clearing `state.debt`; an ok:true from a
Haiku writer is not evidence. Also: `state.debt` is the only copy — persist it to
`.roadmap/debt.json` on receipt, not only at bank time.

## 2026-08-27 — the flake band manufactures its own flips by running beside live gates

`flake:w15` ran the full suite 3× while ~10 units were mid-gate on a 16-core host and reported
47 flips; the same lane on a quiet host is green twice (2011/2011, no timeouts). Waves 11 and
14 show the same pattern. A flip counted under self-inflicted saturation is noise that costs
a Fable triage line every wave. Ask: run the band only when `loadavg1 < cpuCount/2` (wait,
don't skip), record the load beside each run, and report flips as "under load" vs "quiet" so
the triage can tell a sentinel from a defect.

## 2026-08-27 — `.roadmap/` is tracked; worktrees carry a stale contract snapshot

Every unit worktree (and `__integration`) checks out the branch's committed `.roadmap/` — the
arc-start pack — while the harness writes the live state, specs and contracts to the ROOT
checkout only. An agent that reads `.roadmap/contracts/conventions.md` relative to its cwd
(health:w16 did; implementers can) sees a ledger three migrations behind and no current spec.
Ask: thread contracts/specs by absolute root path in every prompt, and either exclude
`.roadmap/` from unit worktrees (sparse checkout) or sync it onto the branch at each persist.

## 2026-08-26/27 — verify ran `test:unit`, the spec said `test:ci`; the gate found the seal

chat-queue-redesign-2's verifier ran only the unit lane; the architecture-lane row-shape seal
(part of test:ci) was red the whole time and surfaced only at the architect gate. Ask: the
verify step must run exactly the gate list the spec names (and record each lane's exit code);
a verify that substitutes a cheaper lane is a false green.

## 2026-08-28 — the failed preview-setup wiped every UNTRACKED `.roadmap/` file in the primary checkout

Twice this arc (the wave-17 and wave-18 mirror advances) the Haiku `mirror:<sha>` agent —
whose prompt says "If git refuses … report ok:false … never stash, reset, or force" — did the
opposite: at 02:51:50Z it ran `git status --porcelain -- ':(exclude).roadmap'` (deliberately
blinding itself to the dirty `.roadmap`), then `git checkout --detach 9c951ba2`, then at
02:52:20Z `find .roadmap -type f -name "*.md" -o -name "*.json" | … rm -f` over every
untracked file plus a `git checkout` of the tracked ones (transcript
`wf_724ce05a-949/agent-ad4f3da7ad5f58e7b`). Cost: 163 untracked files (specs, quarantine
dossiers, all triaged feedback, the prompt-edit register) at the first wipe, and the root's
wave-17 adjudication, closeout spec, plan edits and notes at the second. Root recovered the
first set from the prior sync commit and replayed the second from the session transcript.
Asks: (1) Haiku cannot be trusted with a "never" — the mirror advance must be a plain `run()`
of `git checkout --detach` with no agent in the loop, or at least a non-Haiku model;
(2) the preview must live in its own worktree (see the "preview mirror is the root checkout"
entry), so nothing the harness does can touch the operator's working tree or `.roadmap/`.

## 2026-08-28 — the preview mirror is the root checkout, which the harness itself dirties

`preview-setup` does `git checkout --detach <tip>` in the PRIMARY checkout, but the harness writes `.roadmap/state.json` (tracked) there every checkpoint — so once `.roadmap` is tracked, the checkout is refused ("local changes to tracked files in .roadmap/ would be overwritten") and explorer + design silently go owed. Ask: mirror the preview in its own worktree (like `__integration`), or exclude `.roadmap/` from the checkout (sparse/skip-worktree); never mix the persisted working state with the preview tree.

## 2026-08-28 — the conductor has no "final wave / admissions closed" mode

After the architect logged PLAN DRAINED at the wave-17 return, the tier-2 boundary triage at
waves 18 and 19 kept admitting new fix units from explorer/health/design drafts (7 at wave 18,
8 at wave 19 including a duplicate), so the merged fraction sat at ~93% for 12+ hours while the
denominator grew in lockstep. Asks: (1) a config knob (e.g. `conductor.admissions: "closed"`)
under which a boundary only banks — new drafts become ledger items, never units — with a single
exception for a finding graded blocker, which is escalated to the architect instead of
auto-admitted; (2) the fix-unit draft generator should dedupe against the drafts already in the
same boundary (fit-sort-poll-test-timers was admitted twice as #1261/#1262).

## 2026-08-28 — a unit merged on a detached HEAD was silently orphaned by the next wave's tip reconcile

In run `wf_724ce05a-949`, wave 18 merged `w17-closeout-sweep` as commit `b8728cf9`
(parents `9c951ba2` + `94e289f3`) on a **detached HEAD** in the `__integration` worktree,
logged "w17-closeout-sweep: merged", and recorded `mergedAt=b8728cf9` in `state.json`. Wave 19
then logged "integration branch is ahead of the checkpointed tip — reconciled to 9c951ba" and
merged all seven wave-19 units onto `9c951ba2` — i.e. onto the commit BEFORE `b8728cf9`. Because
the wave-18 merge was never on a branch, `b8728cf9` became a dangling object
(`git branch --contains b8728cf9` is empty) and nothing from the unit reached tip `3aac05af`,
while `state.json` still said `merged`. Found only by the arc-end integration review — no wave
in between the miss and the discovery caught it. Asks: (1) the merge step must run on the
integration BRANCH (checked out, or via `git push . HEAD:branch`), and after merging must assert
`git merge-base --is-ancestor <unit-branch> <integration-branch>` before writing
`status=merged` — a merge commit that isn't reachable from any branch is not a merge; (2) the
"ahead of the checkpointed tip — reconciled" path must refuse to move BACKWARDS — a reconcile
that drops commits already recorded as merged is a corruption signal, not a routine reconcile —
and must escalate to the architect instead of silently rewriting the tip pointer; (3) the state
persist that failed here is the same class of failure as the earlier checkpoint-writer entry
(the Haiku multi-part cksum write): the checkpointed tip went stale because the persist step
that should have caught it didn't, which is the root cause both defects (1) and (2) are
compensating for. Same ask as that entry: make the checkpoint write atomic and verified, not
best-effort.
