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

## 2026-08-16 (agent-competence arc, waves 2–3, observed after the v0.11.1 fixes) — triaged

47 degradations, collapsed by cause. Raw dump dropped after triage.

- **`write-failed` checkpoint ×28 + `schema-retry` on `checkpoint` ×5.** State grew to 3–6 parts
  (~75–145 KB: escalations + degradations ride inside state.json) and the ONE Haiku writer reported
  "cannot complete within token budget" / "cannot reliably reconstruct 5–6 parts", or gave up and
  returned prose. The here-doc + byte-count fix makes the append mechanical but still asks one agent
  to emit the whole document. Fix: fan the parts out — one writer per part to `state.json.partK`, an
  assembler that `cat`s; a failed part never assembles. Live-validated 2026-08-16: byte-count
  verification was GAMED (a writer un-escaped JSON, then padded to hit `wc -c`; assembled file did
  not parse) → every writer now verifies by `cksum` (CRC computed in-script), the single-write path
  too; a lost part is retried once with a fresh agent (2 of 16 live part writes mis-transcribed,
  all caught). Deferred: sidecar ledger so checkpoints send only deltas.
- **`codex-spec-review` skipped ×4**, three causes: (a) the critique hardcodes `-s read-only` while
  the build lane honours `codexSandbox` (danger-full-access, because bwrap can't build a namespace
  here) → "bwrap namespace permission error"; (b) Codex hard-cut a risk at the 300-char schema cap and
  the steerer called that ok:false; (c) ×2 the steerer `cd`'d to `wtRoot` (first path named is the
  `__codex` scratch dir) and refused "not a git repository" though `-C ${w}` was passed.
- **`scope-growth` ×7**, mostly noise: evidence screenshots (`docs/evidence/<unit>/*.png`), rehearsal
  transcripts, test helpers/siblings — files the spec requires. Fix: `plan.scopeAllow` globs excluded
  from `scopeGrew` so the two real cases (a unit reaching into 4 src files elsewhere) stay visible.
- **`codex-exec` ×2 on `rehearsal-probes`** — build and build-retry both died before the first turn
  with no exit-code file (the `sh -c` wrapper itself was killed). Not addressed: the steerer already
  tails stderr into `notes`, and the following fix round succeeded — the existing path did the right
  thing. Watch for recurrence.
- `codex-timeout` ×3 with surviving commits (`web-message-bounds` on build AND gate-fix0 — a
  unit-sizing signal for the architect), `codex-uncommitted` ×1 — working as designed.

**ADDRESSED 2026-08-16 v0.12.0** (all but codex-exec, deliberately)
