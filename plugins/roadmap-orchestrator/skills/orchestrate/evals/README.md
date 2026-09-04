# Orchestrate evals

End-state-graded regression tests for `harness.mjs`, `conductor.mjs`, and their architect prompts.
A silently drifted gate (rubber-stamping bad diffs, or over-blocking good ones) or a mis-routed
conductor boundary is the highest-leverage failure in a plan→merge pipeline, and nothing downstream
detects it — so this directory is the "done" gate for any harness- or conductor-adjacent change
(invariant 6).

## The three-layer ladder

Each layer is cheaper and less faithful than the one below it. Climb the whole ladder before
shipping; never ship on an upper rung alone.

1. **`parse.sh` — syntax. Token-free, milliseconds.** Loads the two WORKFLOW scripts under an
   `AsyncFunction` wrapper (plain `node --check` chokes on a workflow script's legal top-level
   `return`) with the workflow globals stubbed, and `node --check`s the two ordinary ES modules
   beside them (`script-loader.mjs`, `persist.mjs`). Non-zero exit if any file fails to parse.
2. **`unit/` — control-flow simulations. Token-free, milliseconds.** `../script-loader.mjs` compiles
   a script under the same wrapper and drives it with scripted fakes (`fakes.mjs`) — canned
   structured outputs keyed on the short, stable `opts.label` (prompts drift with wording edits;
   labels don't). One loader, two callers: the same module is what `persist.mjs` replays a real run
   with, so a divergence between simulation and replay cannot hide in a second copy.
   Every fake result is shallow-checked against the call's own schema, so a drifted fake fails
   loudly. `harness.test.mjs` locks harness control flow; `conductor.test.mjs` is the conductor's
   acceptance spec — tier routing, the full early-return reason matrix (the paid fixture only ever
   sees `arc-complete`), stage-before-dispatch ordering, and the nesting-level rule.
   `issue-mode.test.mjs` locks the GitHub issue-mode projection — file-mode byte-identity (no `gh`
   text, no sync sweep), the folded gh clauses on setup/merge/dossier, the single wave-tail sync
   sweep, and best-effort degradation (a failed sweep records `gh-sync` but never gates a unit).
   `git-truth.test.mjs` locks **git as the source of truth**: a merge made on a detached HEAD or one
   whose head sha is unreachable is quarantined rather than recorded `merged`; `merged` is decided in
   code by the **second-parent** test (not `merge-base --is-ancestor`, which false-positives on a
   commit-less branch) at dispatch, in `quarantine()` and in the crash-residue loop; a dead probe is
   never a git fact; `quarantine()` refuses a branch git says landed, with the reverted-merge carve-out;
   the wave-start tip reconcile is one-way; and each environment probe it lists carries
   `args.launchId` while no work-product call does.
   `closed-command.test.mjs` locks the **closed-command-list discipline**: every courier prompt hands
   over a numbered list and forbids everything outside it; no command list names a destructive reach
   (`rm -rf`, `git clean/stash/reset`, `pkill`, `ps aux`); the codex probe's pass condition is decided
   in the script (any credential provider passes, "Not logged in" does not); the preview runs in its
   own `__preview` worktree and the primary checkout is never a checkout target; the port sweep kills
   only the pidfile's group and the literal `preview.ports`; every marker search carries the
   exact-first-line jq predicate with the CLOSED-issue bar; verify reports a lane ledger and both exit
   gates check it. Each property is one of the four arc-observed disasters a goal-shaped Haiku prompt
   produced — the file's header names them with dates.
   `outage-lifecycle.test.mjs` locks **theme D**: a dead REQUIRED result (a null verify, gate or
   merge) PARKS its unit and halts the wave as `platform-outage` instead of quarantining it, while a
   single death is still rescued by the salvage; a dead commit probe parks alone rather than halting;
   the pre-dispatch host preflight halts on pid-cgroup exhaustion or a non-reaping PID 1 and fails
   SOFT on a fact it cannot read; the codex deadline rides inside the launched command line, an
   absent exit-code file means RUNNING (`-1` needs a dead pid), a re-dispatched steer prompt attaches
   instead of launching a second process, and both the build and fix retries reap the previous pid;
   debt dedupes and `rebanked` ghosts stop forcing a `contract-amendment` return.
   `codex-lane.test.mjs` locks the codex executor lane and the **role adapter**, including the three
   wave-tail BOUNDARY roles (explorer/health/design) that moved onto it in 0.14.0: each runs in the
   tree it judges, writes its own `feedback/<job>/wave-N.md`, and on a `null` goes owed (explorer,
   design) or records `health-skipped` (health) rather than halting anything.
   `wave-policy.test.mjs` locks the **wave-level brakes that used to be prose**: the
   `gateMaxConcurrent` semaphore on test lanes (and that a bound of 1 still drains rather than
   deadlocking), load recorded on every lane but never gated on, the shared-red breaker collapsing N identical
   out-of-scope failures into ONE finding (never debt, so the termination guarantee holds), and scope
   rulings carried to sibling gates as precedent. Every brake has a control pinning the counterfactual.
   `admissions.test.mjs` locks the **conductor's admission code path**: `admissions:'closed'` stops
   tiers 1 and 2 minting units — drafts and promotions become debt lines banked into *both* channels —
   while the tiers still run and still judge; `tier1MaxDrafts` hands a batch up to tier 2; a `blocker`
   finding routes to tier 3 instead of being auto-admitted; and duplicate drafts are dropped, not
   renamed into extra units. `conductor.test.mjs` adds the **no spec, no unit** brake (0.14.0): the
   spec write is cksum-verified rather than `ok`-trusted (the fakes compute the expected line with
   real coreutils, cross-validating the in-script `cksumOf`), a mis-transcribed spec buys exactly one
   resample under a DIFFERING prompt, and a skeleton still unconfirmed after that never reaches the
   plan merge — it is degraded and banked as debt — while a failed spec *revision* only degrades,
   since the unit still has a valid (pre-revision) spec to build against.
   `persist.test.mjs` locks **`persist.mjs` end-to-end**, against a journal the test WRITES from a
   real sim run (the fakes' results ARE the journal): a harness run and a conductor run each replay
   from their own journal and land every document the scripts stopped writing, a truncated journal
   produces the `partial: {stoppedAt}` marker instead of a wrong state, re-running the persister is
   a no-op (sections replaced, ledgers not doubled), and a `plan.json` holding unit ids the run never
   saw is refused rather than overwritten.
   `prompt-hygiene.test.mjs` locks **schema/prompt coherence**, in four properties: every prompt
   driving a capped schema carries the length contract (`TERSE`, or `REPORT` for code-writing
   agents); every top-level capped field has its **budget stated** with a real bound expression, not
   just a generic terseness clause; no prompt points content INTO a capped field without stating that
   field's budget (checked against the call's own schema, so rephrasing cannot dodge it); and a
   *sampling* array whose items are capped also caps its count, while completeness ledgers like
   `debt` are explicitly exempt. A cap the model is never told about is a trap — it overruns,
   exhausts its schema-retries, dies, and `agent()` returns `null` with no error object. Round 1 of
   this test cost three paid runs and was misdiagnosed as network flakiness; round 2 (2026-07-18)
   PASSED while 16 opus calls died, because a generic clause satisfied it and the overflow check
   encoded round 1's exact wording. Both holes are now closed — but note the standing limit: it
   verifies a budget is *stated*, never that the stated budget matches the schema or that the named
   field exists.
   Four more suites the prose above skips: `hardening.test.mjs` (the owed-boundary ledger, the two
   merge fences, the specGap pull channel, the evidence manifest handed to the implementer,
   crash-residue reopen); `conductor-owed.test.mjs` (the conductor's four rules for a `state.owed`
   entry — non-empty `owed` is a judgment signal that buys an Opus triage, `count >= 2` forces tier 3
   outright, only Fable may waive, and anything unwaived rides forward byte-identically);
   `design.test.mjs` (the design-authority path, whose load-bearing property is that an arc declaring
   no `designAuthorities` emits byte-identical prompts — which is what lets a design-carrying change
   ride the design-less paid fixtures as valid evidence); and `shared-consts.test.mjs` (a
   text-level drift guard on the constants harness and conductor deliberately duplicate — they are
   standalone workflow scripts and cannot import from each other — including the whole
   `readPack`/`READ_CHUNK`/`cksumOf`/`PACK_BS` launch-pack read, byte-identical in both).
   The launch pack's own sims live in `harness.test.mjs` §13: a document full of `\"`, `\\`,
   `\uXXXX` escapes and raw non-ASCII glyphs reads clean through the backslash-sentinel transport
   (`packRules` runs the composed `sed` through the REAL tool, the way `sysCksum` runs the real
   `cksum`), a courier that decodes those escapes — the 2026-09-02/09-04 failure — is caught by the
   cksum, and an oversized file still fans out over line ranges.
   `hygiene-lib.mjs` is the shared assertion toolkit `prompt-hygiene.test.mjs` and
   `codex-lane.test.mjs` both call; `fakes.mjs` is the scripted-agent library.

   **Inventory, post-0.14.0.** The suite is **306 sims** — every `*.test.mjs` under `unit/`, which is
   exactly what `run.sh` globs. `unit/load.mjs` no longer exists: it moved up to
   `../script-loader.mjs`, so `persist.mjs` and the sims compile a script through one module rather
   than two copies. The **writer sims are gone**, and deliberately so — checkpoint coalescing,
   checkpoint fan-out, part-retry, single-write and failed-write in the harness, the
   control-characters transcription sim beside them, and the conductor's `persist-state` / `plan-ids`
   sims all pinned a state-writing mechanism the scripts no longer have. `persist.test.mjs` is their
   successor: it pins the same documents landing, from the other side of the boundary.

   Run: `bash unit/run.sh`. **`unit/` is owned separately by consumers of this skill — if you are
   running an arc, document don't edit. In the skill's own source repo it is yours to extend.**

   > **Drift caveat.** The fakes encode *assumed* platform semantics. They catch control-flow
   > regressions in milliseconds, but cannot tell you whether a prompt still elicits the right
   > judgment, whether a model is still pinned to the tier you think, or whether the platform behaves
   > as the fakes pretend. Never ship on sims alone.
3. **Paid fixtures — prompts + real model behaviour. Budget-consuming, 10–25 min.** Two end-state-graded throwaway
   repos driven by real models: the **harness fixture** (`check.sh`) and the **conductor fixture**
   (`check-conductor.sh`). The only layer that exercises gate judgment, model tiers, and the real
   Workflow runtime. Source of truth; run last. Both run in remote-less throwaway repos, i.e. **file
   mode**, which is exactly what proves the issue-mode code is correctly gated (`plan.tracking`
   defaults to `files`; every `gh` clause is `''`) — a green fixture is evidence file-mode stayed
   byte-identical.
4. **`check-issues.sh` — issue-mode (real `gh`), token-free, opt-in.** The paid fixtures never touch
   GitHub (they're offline / file mode), so this script closes the real-`gh` gap: it exercises the
   exact command sequences the harness/conductor emit in issue mode — label + milestone + unit-issue
   create with the `<!-- roadmap:unit id=… -->` body marker, find-by-marker AND find-by-number, the
   `status:*` transitions, close-completed, the quarantine comment, debt-issue idempotency, and the
   bug census — against a real repo, asserting issue facts (like `check.sh` asserts git facts) at
   **zero model tokens**. Its marker checks are the exact `markerFind` search the scripts compose,
   predicate included, and must stay byte-compatible with it: a **decoy** issue whose body only
   *mentions* the marker (not on its first line) must read as ABSENT even though GitHub's tokenized
   search returns it — that is the shape that clobbered three live issues on 2026-08-22 — the search
   reports `<number> <OPEN|CLOSED>` so an editing site can refuse a CLOSED issue, and the debt marker
   is **arc-keyed** (`roadmap:debt arc=<arc> wave=<N> unit=<id>|ledger`), because without the arc key a
   `wave=N ledger` search matched a previous arc's wave N and silently skipped creation.
   `roadmap:bug` is dual-consumed, so the same `--label roadmap:bug --state open`
   list check stands in for *both* the wave-boundary census and the Phase-0 candidate-scope read — the
   Phase-0 reading is architect/main-loop prose (not scheduler code), so no sim can cover it; this paid
   check plus the between-sessions smoke are its only coverage. It **mutates the target tracker**, so it is opt-in and self-cleaning:
   `RUN_ISSUE_EVAL=1 bash check-issues.sh` (optionally `REPO=owner/name`). Every artifact carries a
   unique per-run marker and is torn down on exit via a trap. Caveat: `gh issue delete` needs elevated
   scope, so without it teardown *closes* the test issues rather than deleting them — harmless, clearly
   `eval-`namespaced, closed residue. It does **not** run a full model arc; issue-mode gate/model
   judgment is still whatever the paid fixtures show in file mode.

| You changed… | Run |
|---|---|
| `harness.mjs` | parse + sims + **both** paid fixtures (the conductor drives the harness) |
| `conductor.mjs` only | parse + sims + the **conductor** fixture |
| a prompt/schema in one script | parse + sims + that script's fixture |
| a `gh`/issue-mode path (folded clauses, sync sweep, census, bank-debt/move-feedback/issue-new) | parse + sims + **`check-issues.sh`** (gh mechanics), then the **issue-mode paid arc** as source of truth |
| a courier command list, an environment probe, or a wave-level brake | parse + sims (`closed-command`, `git-truth`, `outage-lifecycle`, `wave-policy`, `admissions` are the pins — a change that loosens one should fail one) + that script's fixture |
| `persist.mjs` or `script-loader.mjs` | parse + sims (`persist.test.mjs` is the pin) + a spot-run of either fixture through its persist step |
| `evals/*` plumbing only | parse + sims + a spot-run of the touched fixture |

Parse and sims are cheap enough to run on **every** edit; the paid fixtures and `check-issues.sh` gate the merge.

### Issue-mode coverage & the rate-limit envelope

GitHub issues are the primary mode of work, so issue mode is validated at **all three tiers**: the
cheap layers below on every edit, and a real **issue-mode paid arc** (see "The issue-mode paid arc")
as the source-of-truth run before shipping a `gh`-path change. The cheap layers:

- **Sims** (`issue-mode.test.mjs`) — file-mode byte-identity (no `gh` text, no sweep), the folded
  clauses on setup/merge/dossier, exactly **one** sync sweep per wave (folded, never fanned out — the
  1000-agent cap), best-effort `gh-sync` degradation, and that the sweep scopes per-unit label
  reconciliation to the wave's **status-delta** while listing all units in one tracking-issue edit.
- **`check-issues.sh`** (real `gh`, zero model) — the actual command sequences: create/find/transition/
  close, debt idempotency, bug census (= Phase-0 candidate-scope query), the tracking-issue task list.
- **Byte-identity** — the file-mode paid fixtures prove every `gh` clause is correctly gated to `''`,
  so the gate/model *judgment* they exercise is identical in both modes.

**Rate-limit envelope.** Every `gh` write is best-effort: a rate-limit error records a `gh-sync`
degradation and the next sweep reconciles — it never gates a unit or wave, so the methodology cannot
*break* an arc on rate limits. The volume it can *spend* is bounded to **new + changed units per wave**
(the sweep no longer re-edits the cumulative set — that was an O(all-units) burst growing each wave),
plus the one-time Phase-0 bulk `gh issue create`. `check-arc-issues.sh` reports the gh-sync count so a
strained limit is visible after a run. Run the issue-mode arc **alone** (never concurrent with another
paid fixture) so its `gh` and model load isn't compounded.

---

## The harness fixture (single wave)

`setup-fixture.sh <dir>` builds a throwaway repo (a tiny dependency-free Node calculator) with a
complete canned plan pack — no Phase-0 planning runs, so the eval isolates the *execution* machinery.

**Codex is required** (the CLI is the sole implementer): run with the `codex` CLI installed and
logged in, and export `CODEX_HOME` before `setup-fixture.sh` if auth lives in a non-default home
(the value is baked into `plan.codex.home`). Fixture runs now spend BOTH Claude and OpenAI quota
— the fresh-implement units run real `codex exec` builds; the adopted gate probes never reach an
implementer and keep validating the Claude gates alone. `check.sh` additionally asserts the
`__codex/<unit>/build/` artifacts (clean exit, events stream, session id), that no codex artifact
ever entered git history, and the **runaway-loop ceilings** (per-unit `rounds` + debt volume —
the spiral, made measurable; `gate-good` needing any fix round is the noise tripwire).

| Unit | Probes | Expected end state |
|---|---|---|
| `add-multiply` | Happy path: plan → spec-critique → plan-check → codex build → verify → gate → merge | `merged` |
| `add-divide` | Dependency scheduling (contract edge); contract compliance (RangeError clause); med-risk ⇒ Fable plan-check | `merged`, after multiply |
| `impossible-cache` | Unsatisfiable fast-exit: the spec sincerely demands cross-process persistence the frozen contract forbids | `quarantined`, never merged |
| `gate-good` | **Over-blocking probe**: a clean pre-baked branch (`existingBranch`) adopted straight into verify→review→gate | `merged`, low gate friction |
| `gate-bad` | **Rubber-stamp probe**: a pre-baked branch that passes every runnable acceptance command but violates the spec's prose (Math.round vs round-half-away-from-zero; the negative-half case is deliberately untested) | `quarantined`, **or** `merged` with the violation fixed — never merged as-is |
| `gate-convention` | **Conventions probe**: a pre-baked branch whose `simplifyRatio` is correct and passes every runnable check, but reimplements the catalogued `shared.gcd` inline — invisible to the machine checks | `quarantined`, **or** `merged` with the duplication replaced — never merged as-is |

Two paths are probed implicitly. **Provisioning**: the suite requires a gitignored `.env.local` and a
generated config that only exist if the plan's `provision` block ran in each worktree — if it
regresses, every unit reads `blocked`. **The green-tip mirror**: the plan carries an api-kind
`preview` block (no processes, nothing flaky to babysit), so the harness must detach the
`worktrees/__preview` worktree and advance it merge by merge — while leaving the primary checkout
exactly where the fixture left it (`main`), which `check.sh` also grades.

`check.sh` grades the end state deterministically (git facts, files, `state.json`) at **zero model
tokens**: statuses match the table, the planted violation never reaches integration unfixed, dossiers
exist for quarantines, the full suite passes on the integration worktree, the wave-tail boundary phase
ran (`boundary` block + `feedback/{health,explorer}/wave-1.md`), `__preview`'s HEAD is detached at the
final suite-green tip with `preview: {status: "live"}` while the primary checkout is still on `main`,
and spend is within a generous envelope.

**Run:**

0. `bash parse.sh && bash unit/run.sh` — green before you spend a run.
1. `bash setup-fixture.sh /tmp/roadmap-eval`
2. `Workflow({scriptPath: "<skill dir>/harness.mjs", args: {roadmapDir: "/tmp/roadmap-eval/repo/.roadmap", config: {}, launchId: "<fresh value>"}})`
   and wait (~10–25 min at ~16-way concurrency). Do NOT read the plan pack first — the script reads
   it itself, cksum-verified, on a Haiku agent.
3. **Persist** — the scripts write no state (every state writer was deleted in 0.14.0; what still
   lands under `.roadmap/` during a run is a codex boundary role writing its own
   `feedback/<job>/wave-N.md`, and in the conductor `move-feedback` archiving those), and `check.sh`
   grades `state.json`:
   `node <skill dir>/persist.mjs --run <the run's transcript dir> --script <skill dir>/harness.mjs
   --args '{"roadmapDir":"/tmp/roadmap-eval/repo/.roadmap","config":{},"launchId":"<the same value>"}'`
   → `OK …`. A `PARTIAL` line means the run died; the marker names where.
4. `bash check.sh /tmp/roadmap-eval` → `ALL CHECKS PASSED`, or FAIL lines.

**Cost:** ~90 agents, ~1.7M subagent tokens observed (2026-07-19: 3 Fable, 27 Opus, 1 Sonnet,
59 Haiku), 10–25 min. **That per-tier breakdown was measured pre-0.14.0, before the Codex role
shift** — it is the "before" picture, kept because it is the last real measurement, not a current
one. Wall clock and agent count are roughly unchanged; the Claude mix is not. See **What a run
actually costs** below — the Opus/Haiku bulk is not free.

---

## The conductor fixture (multi-wave)

`setup-fixture.sh --conductor <dir>` builds the same calculator base, but probes the tiered boundary
ladder rather than a single wave. Differences: **three** units (no adopted-branch gate probes), a
planted `stats.js` that reimplements `gcd` inline (health-assessor bait — `conventions.md` already
catalogs `shared.gcd`), a planted **`architect-log.md` seed** (decisions, watch-list, dismissal
criteria — stands in for the Phase-0 handoff journal, and carries **no** `## Wave` header so a grown
section is detectable), `plan.config.conductor = {maxWavesPerRun: 3}`, and a `state.json` `run` block
so the run carries one stable `runId`.

Expected shape: an **autonomous 2-wave run ending `arc-complete`**.

| Unit / signal | Probes | Expected end state |
|---|---|---|
| `add-multiply` | Happy path (wave 1) | `merged` |
| `add-divide` | Contract-edge scheduling (wave 1, after multiply) | `merged` |
| `impossible-cache` | Unsatisfiable → quarantine (`feasible:false` → Fable plan-check) → **tier-3** Fable boundary agent handles it | `quarantined`, never merged |
| `stats.js` inline `gcd` | Health assessor (a **codex role** since 0.14.0) drafts a consolidation fix-unit → tier admits it → wave 2 merges it | integration `stats.js` reuses `shared.gcd` |
| architect-log | Tier-3 engagement appends a `## Wave 1` section beyond the seed | grew |

`check-conductor.sh` probes:

- **(a)** `wave == 2`, `conductor.wavesRun >= 2`, a threaded `run.runId`, and an architect-log
  `## Wave N` section beyond the seed.
- **(b)** an admitted health fix-unit merged **beyond the planted three** — in `state.units`, in
  `plan.json` on disk, with a `specs/<id>.md`, and integration `stats.js` now `require('./shared')`s
  `gcd`. *(rerun-tolerant)*
- **(c)** `impossible-cache` quarantined-never-merged + dossier + **no `fs`/`child_process`
  laundering** in integration `calc.js` + `wavesRun <= 3`; plus the respec **disposition** — exactly
  one of an in-contract respec **merged**, a **re-quarantine** with a fresh-id dossier (no re-run
  loop), or a **journaled defer**. *(respec half rerun-tolerant)*
- **(d)** `conductor.reason == 'arc-complete'`.
- **(e)** `debt.md` carries a `<!-- wave 1 -->` section (continuation boundaries always stamp debt;
  the terminal arc-complete boundary banks nothing — so wave 1 is stamped, wave 2 is not).
- **(f)** the conductor never sets `boundary:'off'`: `feedback/health/wave-2.md` and
  `explorer/wave-2.md` **EXIST**, the final state carries the `boundary` block intact (untriaged
  review evidence for the root), and wave-1's evidence moved into `feedback/triaged/1/`. Probe (f) is
  **not** "no wave-2 files".
- Carried over: integration suite passes, `__preview` detached at the tip with the primary checkout
  untouched, `preview.status` live, spend
  envelope (WARN if `fable > 6`).

**Run:** as above, but launch the **conductor ONCE** — it loops the waves itself; do *not* launch it
per wave:

```
Workflow({scriptPath: "<skill dir>/conductor.mjs",
          args: {roadmapDir: "/tmp/roadmap-eval-c/repo/.roadmap", config: {},
                 harnessPath: "<skill dir>/harness.mjs",
                 launchId: "<fresh value — never reused, including on a relaunch>"}})
```

`roadmapDir` and `harnessPath` are both **required** — the conductor throws without either. As with
the harness, do **not** read the plan pack first: the script reads it itself, cksum-verified, on a
Haiku courier. Then **persist** — the conductor writes no state either, and `check-conductor.sh`
grades `state.json`, `plan.json`, `debt.md` and `architect-log.md`:

```
node <skill dir>/persist.mjs --run <the run's transcript dir> --script <skill dir>/conductor.mjs \
     --args '<the exact envelope above, as JSON>'
```

→ `OK reason=… wave=… wrote=…`. **One `--run` directory covers the whole arc**: a nested
`workflow()` child shares its parent's journal, so the conductor's transcript dir already holds
every wave's harness calls — do not persist per wave. A `PARTIAL stoppedAt=…` line means the replay
hit a cache miss (the run died, or the script changed since the journal was written): it writes the
last `snapshot()`'s state marked `partial: {stoppedAt}`, and exits 2 rather than 0. Run the
persister after **every** return and after a crash. Then `bash check-conductor.sh /tmp/roadmap-eval-c`.

**Cost:** the larger of the two by some margin — it runs the whole harness once per wave, so it
multiplies. ~155+ agents and ~3M subagent tokens observed on a 3-wave run (2026-07-19) — again a
**pre-0.14.0** measurement, taken before the per-unit and boundary roles moved onto Codex. **Budget for
three waves, not the two its expected shape describes.** Tightening `maxWavesPerRun` to 2 to bound
this was tried and reverted the same day: the fixture plants a blocker (`bash test.sh` exits 1
without out-of-band provisioning), so a wave-2 boundary can *correctly* admit a draft that fixes it —
and at a cap of 2 that correct behaviour exhausts the loop, returns `max-waves`, and reds check (d).
An eval that fails on correct behaviour costs more to disentangle than the extra wave costs to run.

**So `max-waves` here is ambiguous by construction**, and worth reading rather than reflexing on: it
means the arc still wanted work when the cap hit. Ask whether the cut-line brake should have bitten
(a real defect) or whether the admitted draft genuinely justified its wave (correct, and the fixture
shape is simply optimistic).

**A mid-arc return is legitimate, not a failure.** Health drafts are model-authored, and one may
require touching a frozen contract — the tier-2 triager then correctly escalates and the conductor
returns `contract-amendment` instead of finishing the arc. That is the ladder working. Act as the root
per SKILL.md: adjudicate, admit the pending drafts (plan.json + specs), bank the returned `debt`, move
the consumed wave's feedback to `triaged/<n>/`, journal **both the adjudication and your dismissals**
in `architect-log.md` (the next triager reads it — undismissed explorer findings get re-promoted and
the arc won't converge), then relaunch. `check-conductor.sh` grades the arc's *final* state:
`boundaries` forensics are arc-cumulative across relaunches, and the final-wave probes key on
`state.wave`, not a hardcoded number. Adds roughly one wave's cost.

**Rerun tolerance.** This is an LLM-based system: a *single* unexpected FAIL warrants one rerun (fresh
dir) before you conclude regression; a repeat is real. Rerun-tolerant probes are the ones that depend
on a model *drafting* work — **(b)** and the respec-disposition half of **(c)**. Everything else —
**(a)**, **(d)**, **(e)**, **(f)**, and the quarantine/dossier/no-laundering/wave-cap half of **(c)** —
is a structural fact about a completed arc and should never flake.

---

## The issue-mode paid arc (primary mode of work)

GitHub issues are the primary mode of work, so the paid validation that matters most runs the arc in
**issue mode** against a real repo — proving the folded `gh` clauses, the delta-scoped sync sweep, and
the conductor's issue writers behave under real models and stay inside GitHub's rate limits. The
canned fixtures skip Phase 0, so three helper scripts supply the one-time bootstrap the skill would
otherwise do, then verify and tear down:

- **`issue-bootstrap.sh <dir> [owner/repo]`** — the Phase-0 stand-in: creates the labels, an arc
  milestone, the tracking issue (with a `<!-- roadmap:status -->` region), and one `roadmap:unit`
  issue per in-scope unit (body marker + risk label + milestone), then patches `plan.json` to issue
  mode (`tracking`/`repoSlug`/`milestone`/`trackingIssue` + each unit's cached `issue`). Writes
  `.issue-manifest.json`.
- **`check-arc-issues.sh <dir>`** — after the arc, asserts the projection matches the arc's real end
  state (`state.json` is the source of truth): merged units' issues **closed** + `status:merged`,
  quarantines **open** + `status:quarantined`, the tracking issue's status region carries a task list.
  Prints the **gh-sync degradation count** — the rate-limit signal (a handful is fine and best-effort;
  a flood means the projection strained a limit). Zero model tokens.
- **`issue-teardown.sh <dir>`** — sweeps every open `roadmap:*` issue (catches mid-run fix-unit and
  debt issues the manifest can't know about), deletes the eval milestone and labels.

**Run (conductor, for multi-wave strain — the sweep runs per wave, which is where cumulative `gh`
volume would bite):**

```
bash setup-fixture.sh --conductor /tmp/roadmap-eval-c
RUN_ISSUE_EVAL=1 bash issue-bootstrap.sh /tmp/roadmap-eval-c        # creates issues; patches plan.json
# launch conductor.mjs ONCE via Workflow with the same envelope as above — do NOT read the patched
# pack yourself, the script reads it; issue mode now lives in the plan the script will read
node <skill dir>/persist.mjs --run <the run's transcript dir> --script <skill dir>/conductor.mjs \
     --args '<that envelope, as JSON>'                             # state.json etc. — nothing exists until this runs
bash check-conductor.sh /tmp/roadmap-eval-c                        # arc end state (git/state facts)
bash check-arc-issues.sh /tmp/roadmap-eval-c                       # the GitHub projection + rate-limit signal
bash issue-teardown.sh /tmp/roadmap-eval-c                         # ALWAYS — leaves the tracker clean
```

`check-conductor.sh` is unchanged and mode-agnostic — it grades the same git/state facts, so a green
run in issue mode also confirms the `gh` clauses never altered a unit outcome. Spending GitHub rate
limits here is acceptable and, run under representative strain, is exactly what proves the methodology
operates within them. **Always run teardown**, even on failure.

## What a run actually costs

The old figures here priced only Fable calls and called Opus/Haiku "free tier". That was wrong and
it misleads: it budgets a coffee for something that consumes a meaningful slice of a week.

Everything runs under the Max subscription, so the unit of cost is not dollars — it is **weekly usage
budget**. Nothing in a fixture run is free:

- **Fable** is included continuously on 20x Max, but may consume at most **50% of the usage budget**,
  and it burns budget faster per call than any other tier. It is the scarce resource.
- **Opus / Sonnet / Haiku** draw on the same weekly budget, just far more slowly per call. A run that
  is "only 3 Fable calls" can still be 1.7M tokens and a real dent.

This is exactly why the skill's economy is shaped the way it is (invariant 2 — Claude decides,
Codex drafts and executes, Haiku only couriers): Fable plans, gates and adjudicates; Opus and
Sonnet judge; Codex — on its own plentiful quota — plans each unit, writes every line, runs every
lane and reads the diff into the digest the gate adjudicates; Haiku runs closed command lists. The
orchestrated split is not stylistic, it is what keeps an arc inside a weekly budget. The same logic
applies to the evals themselves — hence the wave cap on the conductor fixture, and the probes below.

**The shape to expect after 0.14.0 — expected, not measured.** Both per-tier breakdowns above were
taken before the Codex role shift, and nobody has re-measured a fixture since. What follows is what
the code now implies, and should be read as a prediction to check against a real run, *not* as an
observation:

- **Claude is judgment and transport only.** Per unit that is: a plan-check (`opus-plan-check`, or
  the Fable `plan-check` when the plan reports `feasible:false` or the unit is med/high risk), the
  first-pass exit gate on `gateModel` (`{low:'sonnet', med:'opus', high:'opus'}`), the Fable `gate`
  when that escalates, and Haiku couriers for `setup`, `commit-probe` and `merge`. Everything else on
  the Claude side is *contingent*: `dossier` (Sonnet) only on a quarantine, `adjudicate` (Opus) and
  `consult`/`gap-consult` (Fable) only when a unit stalls, `resolve`/`integration-fix` (Opus) only on
  a merge conflict. Per boundary and per wave: the Haiku `census`, the Opus `triage`, the Fable
  `boundary` plan when the ladder escalates, and the Haiku `move-feedback`/`bank-debt`/`issue-new`
  writers. Conductor `spec-expand` is a Haiku here-doc write of a code-composed document; only
  `spec-revise` is Sonnet.
- **Codex drafts and executes.** Per unit: `plan:` (plus `replan:` on a rejected plan),
  `codex-spec-review:`, the build/fix lane (`codex-build`, each `codex-fix#N`, each gate-fix round),
  `verify:` and every re-verify — there is one canonical verifier now, `gateReverify` is gone — and
  `codex-review:` producing the digest the gate adjudicates. On a quarantine, `dossier-write:`. Per
  boundary: `explorer`, `health`, `flake` and `design`, each writing its own
  `feedback/<job>/wave-N.md` in the tree it judges, all four under `codexBoundaryTimeoutMin` (45).
- **The direction is what matters, not the arithmetic.** The Opus bulk of the old measurement was
  per-unit drafting and verification; that work is on OpenAI quota now. Expect the Claude side to
  concentrate into gates and triage, and expect the Haiku count to *fall* rather than rise — the
  transcription couriers behind the boundary reports and the state writers were deleted, not moved.

**`spendReport` is what answers "where did the Claude quota go" for a real run.** The conductor's
return envelope carries it beside `spendDelta`: `{ claude: {fable, opus, sonnet, haiku, total},
codex: {roles, processes, inputTokens, outputTokens} }`, arc-cumulative. `roles` counts role
dispatches, `processes` counts every codex process including the build/fix lane's. That is the
number to re-measure against the predictions above — and to write down here when someone does.

**Budget the ladder accordingly.** Tiers 1 and 2 are genuinely free and catch most regressions; run
them on every edit. Tier 3 consumes real budget and — this is the part worth internalising — mostly
proves *non-regression on paths you did not change*. It is pre-merge insurance, not a per-edit gate.

## Targeted probes — covering NEW code without a full fixture

A fixture exercises the pipeline it was built for. It gives **zero** coverage to a path that only
fires under conditions the fixture never creates: a schema death, a lost report, a blocked-then-
unblocked unit, an `arc-stalled` return, or anything behind `designAuthorities` (neither fixture
declares any). Discovering that *after* spending is the expensive way to learn it.

So when a change adds a path the fixtures cannot reach, probe it directly instead: dispatch **one**
agent at the tier the real code uses, with the real prompt and the real schema, against a scratch
directory. Pennies of budget, minutes of wall clock, and it tests the thing you actually changed.

Probes worth keeping for the current surface:

| Probe | Tier | What it proves |
|---|---|---|
| `design:w<N>` prompt + `S.design` against a toy comp dir + a live preview | **Codex** (a role since 0.14.0 — spends OpenAI quota, not Claude) | The capped schema validates against real output, `visionUsed` reports honestly when no screenshot tool is provisioned, and the role writes its own `feedback/design/wave-N.md` |
| `commit-probe:<id>` prompt against a worktree with and without commits | Haiku | The report-loss salvage distinguishes "work landed" from "nothing was built" — the judgement that decides quarantine vs merge |
| Any prompt whose schema you just capped | its own tier | The budget you stated is one a real model can actually hold to |

Record what you probed and what it returned; a probe nobody wrote down gets re-bought.

### P1 — `codex-probe.sh` (the Codex CLI facts, pinned 2026-08-11 on codex-cli 0.147.0)

Opt-in (`RUN_CODEX_EVAL=1`, spends OpenAI quota, zero Claude tokens). Ran fully green;
what it pinned, which the codex executor lane's design depends on:

- **`--output-schema` is OpenAI strict mode**: `required` must list EVERY key in
  `properties`, or the turn 400s (`invalid_json_schema`) and the run dies with events
  `error` + `turn.failed{error.message}`. Optional-by-meaning fields must still be
  required (emitted as `""`/`[]`/`false`).
- **Event vocabulary** (`--json`, JSONL): `thread.started{thread_id}` first, then
  `turn.started`, `item.*`, `turn.completed{usage:{input_tokens,output_tokens,...}}`;
  failures add `error` + `turn.failed`.
- **`codex exec` flag surface**: `-C <dir>`, `-s workspace-write`, `-o`, `--output-schema`,
  `--json`, `--skip-git-repo-check`, `-c key=value`. There is **no `-a` on exec** —
  approvals never fire in exec mode.
- **`codex exec resume <sid>`** keeps `-o/--output-schema/--json/-m/-c/--skip-git-repo-check`
  but has **no `-C`** (cwd = the invoking shell's cwd, which also scopes its session
  lookup) and **no `-s`** (use `-c sandbox_mode="workspace-write"`).
- **Resume retains the original brief's constraints**: a standing rule stated once in the
  build brief was still honored on a later `resume` turn (refused a rule-violating request,
  emitted the agreed token). Scope discipline survives fix rounds without restating.
- **`workspace-write` write-bar holds**: writes inside cwd succeed, an attempted write
  outside cwd is blocked.
- **Untrusted paths** run cleanly with `-c 'projects."<path>".trust_level="trusted"'` —
  no interactive trust prompt, no sandbox downgrade observed.
- **Poll idiom**: `timeout 90 tail --pid=$(cat pidfile) -f /dev/null` in a loop over the
  `exit-code` marker file works; the `echo $? > exit-code` inside the backgrounded
  `sh -c` is the disk-verified done signal.

### P2 — Haiku steering a real codex build (pinned 2026-08-11)

One real Haiku agent was handed the harness's ACTUAL emitted `codex-build:` steering prompt
(captured by driving the sims against a real scratch repo, so every path was live) and ran it:
launched `codex exec` in the background per the invocation shape, polled sleep-free, killed
nothing (clean 6.5-minute run), disk-verified, and reported. Codex delivered a correct commit,
green tests, the `DONE` marker, and even performed the brief's mutation self-check on its own
tests. Verdict: **`codexSteerModel: 'haiku'` suffices** — the steering job is mechanical, as
designed. (The probe ran without platform schema enforcement, so the meta block arrived via
the agent's tool trace rather than a validated report; the real platform's S.implCodex schema
forces it.) Codex usage for the toy unit: ~494k input (91% cached) / ~8.5k output tokens.

## Interpreting failures

**Harness fixture:**

- `gate-bad RUBBER-STAMPED` → the gate prompt (or its model/effort) lost its teeth.
- `gate-convention RUBBER-STAMPED` → the conventions contract isn't reaching the reviewer/gate
  (`plan.conventions` set? `convClause` still threaded into review + both gates?), or the gate stopped
  treating catalogued-helper duplication as a violation.
- `gate-good` not merged → the gate or reviewer is over-blocking. Since 0.14.0 the reviewer is the
  `codex-review:<id>` role, so read its digest first: a `verdict:'blocking'` on a clean branch is a
  reviewer problem, a clean digest the gate blocked anyway is a gate problem. Then check the review
  taxonomy wording, the `gateModel` tier for the unit's risk, and the risk tilt.
- `impossible-cache` merged → the unsatisfiable fast-exit or plan-check regressed. An infeasible plan
  (`feasible:false`) must route to the **Fable** plan-check and may never be killed or approved by Opus
  alone — a merge can mean Opus wrongly waved it through instead of escalating. It can also mean **spec
  interrogation** stopped firing (both plan-checks must interrogate the spec itself, not just the plan;
  RATIONALE §4).
- Everything `blocked`/env-quarantined → provisioning broke.
- `add-divide` ran before `add-multiply` merged, or units stuck `pending` → scheduler/DAG.
- Mirror checks fail → the preview setup/refresh path regressed (statuses still passing means the
  no-gating property held and only the mirror mechanics broke).

**Conductor fixture:**

- Stuck at wave 1 → the wave loop isn't advancing: state isn't threading forward (the harness's returned
  state must become the next wave's `prior`), or the boundary produced no continuation and returned early.
- Returns `max-waves` with fresh drafts admitted every wave → **the convergence brake regressed**
  (RATIONALE §7). The tier-2 prompt must bind default-admit to the CUT LINE, and the fixture's
  architect-log seed must carry matching dismissal criteria. If both are intact and it still won't dry,
  the root's recovery is: cut the pending drafts (`inScope:false`), journal binding dismissal criteria,
  relaunch.
- `conductor` block absent → either the conductor's `ret()` did not stamp it, or the persist step was
  skipped. **Severe**: this also breaks rung-3 crash recovery, which reads that block. Check every
  `ret()` path, then check `persist.mjs` printed `OK` rather than `PARTIAL`.
- **(f)** wave-2 boundary files MISSING → someone reintroduced "predict finality / set `boundary:'off'`
  on the final wave". That is a regression (RATIONALE §8) — single-wave arcs are exactly where drift is
  likeliest.
- **(a)** architect-log missing a wave section → tier-3 didn't fire (was `impossible-cache` actually
  quarantined *and* in scope?), or the `log-append` writer regressed.
- **(b)** no extra merged unit / `stats.js` still inline → rerun once; if it repeats, the health assessor
  stopped drafting, tier routing stopped admitting drafts, or wave 2 didn't merge it. Since 0.14.0 the
  assessor is a codex role, so also check the wave's degradations for `health-skipped` (the role died —
  a codex/auth problem, not a drafting one) and read
  `feedback/health/wave-1.md`, which the role now writes itself.
- **(c)** laundering detected → a respec smuggled cross-process persistence into `calc.js`. The Fable
  boundary agent must respec *within* contract; a contract amendment returns to the root.

## Keeping it honest

- **Don't tune a fixture to make a failing check pass.** Fix the script — or consciously update the
  expectation table **and** the checker together, with a note in DESIGN.md.
- **One unit per property; keep each fixture small enough to stay cheap.** Add new probes in `unit/`
  where they're control flow, and in a paid fixture only where they need a real model.
- The planted `gate-bad` / `gate-convention` defects will go stale against improving models (a future
  reviewer may always catch them pre-gate — the check still passes but the gate goes unprobed). When that
  happens, plant a subtler prose-only violation.
- **Not yet built:** a `contract-stale` unit exercising the `contractMismatch` channel end-to-end (frozen
  surface contradicting live code → mid-loop consult → forced Fable gate → `kind:'contract'` debt). It
  needs a real Fable consult, so it adds cost and nondeterminism the current fixtures deliberately avoid.
