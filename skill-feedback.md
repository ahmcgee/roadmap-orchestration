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

## Resolved (for the record — remove entries once shipped in a tagged release)

- **0.11.1 branch (`fix/skill-feedback-2026-08-16`)**: all three 2026-08-16 items — the
  `prefixUniqueGlobs` merge check now diffs duplicate sets pre-merge tip (`HEAD^1`) vs merged tree
  (grandfathered pairs never refuse; SKILL.md/reference.md say so); the chunked state.json writer
  writes one single-quoted here-doc per part per Bash call and byte-count-verifies the file (an
  `ok:false` now carries the observed count); a codex resume that dies at once on "thread already…"
  waits 60s, retries the resume once, then falls back to a cold session on the same brief. Sim-pinned;
  the paid fixtures were NOT re-run (none of the three paths fires in them — no globs, small state,
  no resume collision).
