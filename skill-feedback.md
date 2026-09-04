# Skill feedback — roadmap-orchestrator

Defects and improvement asks for the ORCHESTRATOR itself (not the product). Carry these back to
the skill's repository; they are not product debt and never archive with an arc.
**Cleared 2026-09-03 of everything predating the skill update of 2026-09-01; everything below was
observed AFTER that update (arc issue-intake-2026-09-02, conductor run wf_3683704b-452).**

**ADDRESSED 2026-09-04 v0.15.0** (branch `fix/skill-feedback-2026-09-04`), entry by entry:

- **Dead pidfile** — carried in as asked: all three launch sites (`execCmd`, `COMMAND R`,
  `previewStartCmd`) have the detached `sh` write its own `$$` first and never `echo $!`. The
  "still open" `timeout` process-group gap is closed the second way: the detached `sh` traps TERM and
  forwards it to `$CPID`, then re-waits on a trap flag so the real exit status lands in `exit-code`
  (live-verified: group TERM → 143/124, direct KILL of the child → 137, a child that ignores TERM and
  exits 7 → 7). `codex-probe.sh` P1.8 exercises the same shape. No `pkill -s`; the closed-command rule
  stands.
- **`\uXXXX` escapes / backslashes / 145 KB state** — NOT the `fs` fix: workflow scripts have no
  filesystem (RATIONALE §675), so the pack still rides a courier. Root cause was double-encoding: the
  courier's report is JSON, so every JSON escape in the file needed a second escaping level and Haiku
  dropped one. The read command now pipes through `sed 's/\\/@@BSLASH@@/g'`; the script reverses the
  sentinel and verifies the ORIGINAL file's `cksum`, so any escape is safe and a mangle still fails
  loud. Size: quarantine records carry `dossierPath` (the file under `.roadmap/quarantine/`) instead
  of the dossier prose, which is what took state.json to 145 KB.
- **`nohup VAR=x cmd`** — `preview.start` runs under `sh -c '…'` (env assignments and `&&` fine; a
  single quote in `start` throws at plan validation). Healthcheck window raised 15 s → 60 s and
  reference.md says a slower stack carries its own loop.
- **persist out of order** — an `(out of journal order)` stop, or a partial older than the
  `state.json` on disk, is refused: `state.partial.json` is written beside it, `state.json` untouched,
  `PARTIAL-REFUSED` printed. New `--returned <file>` persists the run's returned value through every
  writer (ledgers, debt.md, architect-log) without a replay.
- **Codex 404 not `codex-unavailable`** — both asks: the wave-start probe runs a bounded
  `timeout 120 codex exec … 'Reply with exactly the word pong'` in its own scratch dir, exit code
  judged in code; and a mid-wave breaker halts `codex-unavailable` on ≥2 consecutive `turn.failed`
  runs with the same HTTP status across different units/roles, parking (never quarantining) the
  units that carried the signature.
- **Quiet-host verify clause** — `HOST_BAR` (mirrored harness/conductor) in both plan-checks, both
  exit gates, the verifier brief (such a clause is a failing check, never `blocked`), and the
  conductor's spec-writing tiers.
- **`pnpm audit` hang → quarantine** — a blocked verify now BLOCKS the unit (commits intact,
  re-verified next wave, `rounds.verifyBlocked`), quarantines only on the second block, and two units
  blocked in one wave halt the wave `env-verify-blocked` (a host fact, parked, resumable).

---

# >>> READ THIS ONE FIRST: the pidfile is a dead pid — it cost the entire first run <<<

## 2026-09-02 — `setsid … & echo $! > codex.pid` records a pid that is dead within one second

**What it cost:** 3 waves, ~13 h wall clock, 220 codex processes (327M input tokens), 524 Claude
agent calls — for 4 merges. 14 of 20 units quarantined as "the codex planner died twice" /
"verification never ran" / "environment blocked verification". **None of those deaths happened.**
Codex's own rollout logs show `task_complete` with feasible plans minutes after each steerer
reported the process dead (see the round-loop-turn-truth dossier in state.json, which traced two
attempts through /codex-state/state_5.sqlite). Every re-cut (-2, -3) then died the same way, so
the conductor's own recovery multiplied the waste instead of containing it.

**Mechanism (reproduced directly in this environment, not inferred):** the steerer's Bash tool
shell runs with job control ON (`set -o monitor`). A backgrounded `… &` job is therefore already a
process-group leader, so `setsid` must FORK, and `$!` names the short-lived parent — dead within
a second (recorded 3564161; the real detached `sh` was 3564163, ppid 1). Everything the harness
knows about liveness hangs off that pid:
- `timeout 540 tail --pid` returns at once and `kill -0` fails → "no exit-code file, pid dead" → the
  82 `codex-lifecycle` rows, `exitCode -1`, the role reported as "produced no result";
- the reap's `kill -TERM -- -<pid>` hits nothing, so the "reattempt" launches a SECOND codex into the
  same worktree while the first is still writing to it (the 2026-08-23 entry's disaster, now
  systematic), and the reap's fallback `echo 137 > exit-code` manufactures every "exit 137";
- the health tier's `ps` scan then found the live first run and returned a "plan" that was a
  self-detection (wave 2, round-loop-turn-truth-2 plan-check).
The same idiom on `previewStartCmd` means the preview's pidfile was equally fictional.

**Fix — APPLIED LOCALLY to the cache copy 0.14.0 on 2026-09-03 (parse + 348/348 unit evals green;
idiom live-checked: `kill -0 $(cat codex.pid)` succeeds after 2 s, group kill reaches the sh).
Exact diff: `.roadmap/skill-patches/2026-09-03-detached-pidfile.patch`.** Three launch sites
(`execCmd`, `COMMAND R`, `previewStartCmd`) now have the detached shell write its OWN pid as its
first act — `sh -c 'echo $$ > <dir>/codex.pid; …' &` — and never `echo $!` after the `&`. After
setsid that `$$` is also the pgid the group kill targets. `evals/codex-probe.sh` carries the same
change; `outage-lifecycle.test.mjs` now asserts the shape and rejects any `echo $! >`.
**Carry it into the skill repo verbatim and re-run the paid fixture there.**

**Still open in the same area (not patched, pre-existing):** `timeout` puts itself in its own
process group, so `kill -TERM -- -$(cat codex.pid)` kills the detached `sh` but NOT
`timeout → codex` beneath it (verified with a stand-in `sleep`: it survived the group kill). A
reap on a GENUINE death is therefore still a no-op. Options: kill by session instead of group
(`pkill -s`, which the closed-command rule currently forbids), or trap TERM in the detached sh and
forward it to `-$CPID`. Decide in the repo, not in the cache.

---

## 2026-09-02 — pack-unreadable on a plan.json containing JSON `\uXXXX` escapes
The launch courier verifies its copy of `plan.json` against `cksum` (bytes). The file held four
`\u2014` escapes (a JSON serializer with ensure_ascii on); the Haiku courier rendered each as the
glyph it denotes, so its copy was 21 characters short (4x5 + the trailing newline) twice and the
launch threw `pack-unreadable` before any wave. Workaround: write `plan.json` / `state.json` with
plain characters and no `\u` escapes (pure ASCII, no escapes, is safest). Fix for the skill: have
the courier `base64` the file or compare a `sha256sum` of what it wrote back, and say so in
reference.md's plan.json section.

## 2026-09-02 — `nohup DEV_SLOT=9 pnpm dev:stack` cannot run an env assignment
`previewStartCmd` prefixes the plan's `preview.start` with `setsid nohup`, so a start string beginning
with a `VAR=value` assignment fails ("nohup: failed to run command 'DEV_SLOT=9'") and every wave ran
without a preview (3 `preview-failed`, all explorer/design jobs owed). Plan-pack side: `env VAR=… cmd`.
Skill side: say so in reference.md's preview section, or wrap start in `sh -c`. Also the healthcheck
window is 5x3s; a dev stack that builds before listening needs the plan's healthcheck to carry its own
patient loop — worth stating next to the example.

## 2026-09-02 — persist.mjs replay stopped out of journal order and wrote a stale wave-1 state
`PARTIAL stoppedAt=codex-fix:transparent-events#0 (out of journal order) wrote=state.json` — the file
it wrote was the wave-1 partial (`halt: platform-outage`, tip d0b4c495) while the conductor's returned
state was wave 3 at c1a0801d. A relaunch from that file would have re-forked every unit from the
plan-pack tip. The architect wrote the conductor's returned `state` over it by hand. Ask: on
out-of-order, prefer the run's returned state (it is in the task output) over a replayed prefix, or
refuse to write.

## 2026-09-03 — the launch courier cannot copy a 145 KB state.json (34,501 chars arrived twice)
Relaunch wf_63118ef1-e6b died at once: `pack-unreadable … state.json: transcription does not match
cksum … of the 144963-byte file — 34501 characters copied`. The Haiku courier's copy tops out near
35 K characters, so any state carrying a few quarantine dossiers (prose, ~5 KB each) is unlaunchable.
Workaround used: dossiers moved out of `state.units[*].dossier` into
`feedback/triaged/<wave>/dossiers-waves-1-3.json` (they are also on each unit's issue as a comment);
state.json is 16 KB again. Fix for the skill: the launch pack should never pass through a model —
read `plan.json` / `state.json` with node `fs` in the script (it already has the path), or at least
keep dossiers out of state and reference them by path. The 2026-09-02 `\uXXXX` entry above is the
same courier; both go away together.

## 2026-09-03 — a Codex BACKEND outage (HTTP 404) is not recognised as `codex-unavailable`
From ~14:43 UTC every codex role failed with `turn.failed: unexpected status 404 Not Found …
chatgpt.com/backend-api/codex/responses` (unauthenticated curl also 404s; CLI 0.147.0 and 0.153.0
alike). The wave-start probe only checks `codex login status`, which still says "Logged in", so the
wave ran on: 23 `codex-exec` rows, five units BLOCKED at verify, one unit QUARANTINED as "the
planner died twice", the whole boundary (explorer/health/flake/design) owed, and a tier-4 return
that spent Fable on a boundary with nothing to judge. Ask: (1) the probe should run a real
`codex exec … "reply pong"` smoke (bounded, read-only) and halt `codex-unavailable` on a
non-zero exit; (2) an N-consecutive `turn.failed` with the same HTTP status across DIFFERENT units
should trip the same halt mid-wave, the way the platform-outage breaker does for Claude, so a
provider outage parks units instead of quarantining them.

## 2026-09-04 — a plan-check tier wrote an unsatisfiable "quiet host" verify clause
The Opus plan-check on round-loop-turn-truth-4 adjudicated D9 as "no vitest, playwright, test-ci or
dev-stack process anywhere on the host" before verify may run. The harness's own preview dev-stack is
always live and `gateMaxConcurrent` lanes overlap by design, so the verifier blocked and the unit was
quarantined as "environment blocked verification" - a spec defect minted by a tier. Ask: the
plan-check/gate prompts should carry the standing rule that host load and sibling processes are never
a verdict (it is already the architect-log watch-list line about `pnpm verify` wall clock), so a tier
cannot re-invent a wall-clock/quiet-host gate.

## 2026-09-04 — `pnpm audit` hanging on the host is reported as a unit quarantine
readings-before-the-room-5 was quarantined because `pnpm audit --audit-level high` (inside `pnpm
verify`) hung on a black-holed registry POST. That is a host fact shared by every unit, like the codex
outage: it should park the wave (`env-*` halt) after the verifier's own curl evidence, not quarantine
the first unit to hit it.

## 2026-09-04 — the launch courier drops backslashes: a state.json with `\"` inside strings is unlaunchable
wf_de8b04a2-b80 died at launch: "27978-byte file — 27966 characters copied". The file was pure ASCII with
no `\u` escapes; it held 6 `\"` sequences (quoted words inside debt/notes strings) and the copy came up 12 characters
short — the Haiku courier mangles each escaped quote. Same family as the `\uXXXX` entry above: any JSON
escape in the pack is corrupted in transit. Workaround: strip inner double quotes from string values before
launch (done). Fix: stop transcribing the pack through a model (read it with node `fs`).
