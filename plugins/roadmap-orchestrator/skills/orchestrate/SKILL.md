---
name: orchestrate
description: Drives the roadmap-orchestrator 1.0 executor, which converges a repo on a documented target state unattended. You curate the target corpus, run Phase 0 in session, start arcs, check in with the owner through `roadmap brief`, and chain arcs as stacked PRs until the vision is silent or the owner's bound K is reached.
---

# Roadmap Orchestrator 1.0

You are the architect, the root agent of the session. The executor, a detached Node process, owns every backend
invocation, lane, git operation on its refs, lock and evidence directory. You own judgment that code cannot do:
the corpus, Phase 0, the plan, adjudicating what the executor hands you, and the owner conversation.

- `reference.md` (beside this file) is the reference: every CLI form, exit codes, the run dir, `status`, the brief,
  `watch` events and every refusal row with its fix. Read it before your first command of a session.
- `executor/SCHEMAS.md` (from the plugin root) holds every input schema. `reference.md` names the section to read.
- `RATIONALE-1.0.md` says why the design is what it is. You do not need it to operate.

`roadmap` below means `<plugin root>/executor/bin/roadmap`.

## The loop

1. **Bootstrap**, once per product repo (below).
2. **Phase 0** for the next arc, in session (below).
3. **Start** the arc, then adjudicate its pack review.
4. **Run**: watch, adjudicate needs-user items, check in with the owner.
5. **Complete**: `roadmap pr`, check in, then chain: decide whether to stop, else back to 2.
6. **Stop**: a final check-in, then the session-end line.

## Talking to the owner

The owner is not watching. Everything you ask goes in one place: end your turn with numbered questions, each
answerable on its own, each with the working assumption you will act on if the answer is "no view". Never ask in
the middle of a turn and carry on. Ask only what the vision and the corpus cannot decide; everything else you
decide and report at the next check-in.

Always ask first, whatever autonomy you hold: anything irreversible outside the sandbox, anything that may cost
the owner more than $10, anything with legal ramifications. A checkpoint's `owner-request` item is one of these.

## Bootstrap (once)

Bootstrap happens when the product repo has no `.roadmap/corpus.md` or no `chain.k` in `.roadmap/config.json`.
Work on a branch you own (`git switch -c roadmap-work main`), never the integration branch.

1. **Issue policy.** Run `roadmap issues --repo <repo>`. Refused `issue-policy-untrusted` means anyone can open
   issues on a public repo. Stop and ask the owner to restrict issue creation to collaborators or to disable
   issues; nothing else fixes it and nothing is recorded. A `gh` failure means the repo has no forge `gh` can
   resolve; a corpus arc needs one, so ask the owner.
2. **Corpus guide.** If `.roadmap/corpus.md` is absent, write it ("The corpus guide" in `reference.md`): where
   the corpus lives (`same-repo`, `other-repo` or `checkout`), what it includes, the vision document's path, and
   the curation standards below in prose. Ask the owner only where the corpus lives, if the repo does not show it.
3. **Vision.** Run the `vision` skill until the vision document is confirmed and `.roadmap/vision.json` is
   compiled. Never write the vision yourself.
4. **K.** Ask the owner: "how many arcs may I run past your last acknowledged brief before I stop and wait?"
   Write `{"chain": {"k": <n>}}` into `.roadmap/config.json` (keep any `routing` key). You may suggest a new K
   later, never write one.
5. **First slice.** Agree with the owner which vision clauses the first arc advances (at least one world scene).
6. **Commit** `.roadmap/{corpus.md, vision.json, config.json}` and the corpus. `start` and `apply` refuse
   `tree-uncommitted` while those three files differ from `HEAD`.

The issue templates in `templates/` (`roadmap-bug.yml`, `roadmap-feedback.yml`) label issues for intake. Offer them;
they work only once committed under `.github/ISSUE_TEMPLATE/` on the default branch, so they go in the bootstrap
commit only if the owner agrees.

## The corpus

The corpus is the target: the documents that say what the product is and must be. It is a living artifact you
curate, and readability comes first: a person must want to read it. You write it in session, through the guide,
only in Phase 0 and in the between-arc commit. The executor reads only a pinned copy.

**Rules blocks.** Normative claims live in fenced blocks with the info string `rules`, one per line:
`T-<n>: <one-line normative claim>`. Prose outside the blocks is rationale. The section of a rule is the nearest
heading above its block.

- Ids are global across arcs and never reused. A new rule takes the next number above the high-water (the pin
  reports it; the baseline's `.roadmap/invariants.md` registry holds the previous arc's).
- A rewording that keeps the meaning keeps its id. A change of meaning removes the old rule (the pin retires it)
  and adds a new id.
- One claim per rule. A claim restated in several places becomes one rule; the restatements go.
- The vision document carries no rules block (`rules-in-vision`).

**Curation tiers.** Every curation names the corpus files it touched and goes in the Phase-0 record.

| Tier | What | You |
|---|---|---|
| structural | layout, duplicates, restatements, systematizing claims into rules | act; list it in `curation` |
| fact-currency | stale text the code or an ADR has overtaken | act; list it in `curation` |
| semantic, the vision decides | a contradiction a vision clause resolves | act; record a `corpusDivergences` entry with the preimage (pin sha and file hashes) and the `V-n` it cites |
| semantic, the vision silent | a contradiction nothing decides | do not resolve it; a ranked `P-n` question with the working assumption the rules encode meanwhile |

## Phase 0 (each arc)

Fan out to subagents for the reading-heavy work: corpus intake, curation passes, obligation extraction, issue
intake on a large capture. Give each subagent a closed task, a time budget, and an instruction to report its
elapsed time with the result. A branch over budget gets re-planned (split, narrowed, or taken back), never just
waited on.

Keep the arc's inputs in their own directory outside the product working tree, for example
`<repo>/../roadmap-inputs/<arc>/`. `executor/evals/m3/setup.ts <dir>` writes a worked corpus arc into `<dir>`;
read `<dir>/input/` and `<dir>/repo/.roadmap/` for the shapes.

1. **Corpus intake and curation** by tier (above). Rules blocks for every normative claim.
2. **Commit.** First arc: commit on your work branch. Chained arc: see "Chaining" for the single between-arc
   commit. The commit is the arc's `baseline`.
3. **Pin.** `roadmap corpus pin --repo <repo> --commit <corpus commit> --baseline <baseline sha> --out
   <inputs>/corpus.json`. For a same-repo corpus both shas are the baseline. The plan's `corpus` names the file.
   Re-pin after every corpus change; `start` re-derives the pin and refuses drift.
4. **Obligations.** Extract a testable obligation from every rule the slice needs: witness, `deliveredBy`, proof
   judgment, impact mapping, cut line (SCHEMAS.md "M3: the holistic layer"). Each obligation anchors at
   `rule: {id, textSha256}` from the pin. A second subagent cross-checks the extraction against the rules; you
   settle every disagreement.
5. **Census.** One entry per active pinned rule: `obligation{id}`, `out-of-slice`, `untestable` or `prod-only`.
   A claim about something not built yet is a `future` obligation, never `must-hold`.
6. **Questions.** Rank the semantic questions the vision does not answer. A new `P-n` is 1 + the highest `P-n` in
   any earlier Phase-0 record of the chain; a question carried forward keeps its id and text. An answered one
   moves to `answered{answer, at}` and its rules change to match.
7. **Debt.** Disposition every `open` item of the baseline's `.roadmap/debt.md`: `promote{unit}` (the unit is in
   this plan), `keep{reason}` or `resolve{ruling}`. An item kept in both previous arcs needs a question naming it.
8. **Amendments.** Disposition every amendment of the previous arc (`status.amendments`, or the brief):
   `applied{rules}`, `rejected{reason}` or `deferred{reason}`. Applied ones are corpus edits in this Phase 0.
9. **Issue intake.** `roadmap issues --repo <repo> --out <inputs>/issues.json`; the record's `issueCapture`
   names that file and the `sha256` the command printed. Then one outcome per issue:
   `finding`, `amendment`, `acted{on: units | rules}` or `none{reason}`. Issues come from trusted collaborators
   (an untrusted repo is refused before you see any): weigh them as owner context and act on them like any other
   evidence. An issue that asks for a change of direction the vision does not support is a question for the owner.
10. **Slice.** `slice.advances` in the record and `holistic.advances` in the plan name the same clauses; `why` says
    why this slice now.
11. **Plan and specs.** SCHEMAS.md "Input contract" and "`spec.json` M1 subset". A corpus arc's plan names
    `corpus` and `phase0`, and `holistic` without `vision` (the record is `.roadmap/vision.json`). Plan
    contracts and unit scopes never overlap the corpus files.
12. **Integration branch.** `git branch <branch> <baseline>` (move it with `git branch -f` while nothing has
    started). One branch per arc, e.g. `arc/<arc>`, checked out in no worktree.
13. **Check.** `roadmap phase0 check --repo <repo> --plan <inputs>/plan.json` until it exits 0. Fix inputs, never
    the rows. Its `sliceCandidates` lists the world clauses whose rules are not all held yet.
14. **Start.** `roadmap start --repo <repo> --plan <inputs>/plan.json`.

**Pack review.** A corpus arc's first job reviews the whole pack before anything is admitted; admission waits for
it (`status.holds` has `pack-review`). Notes go to the brief. A blocking finding raises a `pack-review` item. Fix
the pack with `roadmap apply` (a changed pack is reviewed again and the new review supersedes the item), or
`roadmap ack` the item when the finding is wrong, with the reason in your next check-in.

An arc without the holistic layer still names `architectureDoc` and no corpus. A new holistic arc is always a
corpus arc (`holistic-needs-corpus`). An arc started on an older release keeps its target until it completes.

## Running an arc

Wait on `roadmap watch` under Monitor, with a timeout. It wakes you on every needs-user item, every unit state
change and on `run: complete`. Without a Monitor tool, end your turn while the arc runs; the harness resumes you on
the next watch event. Read `status` on each wake.

- **Needs-user items** are yours to adjudicate, except owner-only acts. Read the item file and its evidence in
  full before you act or ack. The recommendation says which procedure applies; "Handling parks" below has them.
- **The checkpoint acts first.** In a holistic arc it rules toward the vision and records every departure as a
  divergence. Read `divergences` and `decisionsSince`; reverse with `roadmap reverse <D-n>` or an `apply` when it
  read the vision wrong. A `bundle-request` is yours: `ack` it with `--choice apply` or `--choice reject`.
- **Amendments** (`status.amendments`) accumulate; you disposition them at the next Phase 0. Never edit the corpus
  mid-arc.
- **Flow.** Watch `status.timings` (per stage: completed attempts, median and maximum) and each running unit's
  `running.elapsed` against its stage's median. Report a slowdown at the next check-in as an observation with
  numbers. Never change lanes, judgment seats, obligations or routing to make an arc faster.
- **Preview.** The owner may ask to see the product. Run it from a detached checkout you own:
  `git worktree add --detach <dir> <integration branch>`, outside the plan's `worktreeRoot`. A checkout that is not
  detached would put the integration branch in a worktree, which the executor forbids.

## Check-ins

A check-in is `roadmap brief --repo <repo>` (Markdown; `--json` for the payload) plus your preface of at most 10
lines, in conversation, never in a file. The brief covers everything since the last acknowledged brief, across
every arc of the chain: divergences, decisions, curation, questions with their working assumptions, debt, issue
intake, amendments, pack-review notes, census `% held`, timings and PRs. It sees an arc only after that arc's first
snapshot; before any arc has one it exits 64.

The preface says what you decided on the owner's behalf, what you need from them, and anything the brief does not
show (a slowdown, a pattern across arcs). Then the numbered questions, if any.

Check in at every arc completion, at a stop, and when the owner returns. In an unattended chain a check-in does
not wait: carry on with the working assumptions.

**The ack** is the owner's. Run `roadmap brief --repo <repo> --ack <briefId>` only when the owner acknowledged that
brief. It acknowledges the brief's non-blocking digest and convergence items and moves "since"; acknowledged starts
no longer count toward K. A `stale` reply (exit 78) means something changed: show the new brief and ask again.
Blocking items are never acked by a brief.

## Chaining

At arc completion (`status.run.state` `complete`, `completion.active`):

1. `roadmap pr --repo <repo> --arc <arc>`: pushes the arc branch and opens or updates its PR. The first arc's PR
   targets `main`, each later one the previous arc's branch; the body lists the arc's amendments and says to merge
   with merge commits.
2. Check in.
3. `roadmap chain status --repo <repo>`. When `unackedStarts` has K or more arcs, the next start would be refused
   `chain-invalid{limit}`: stop with reason `k-limit`.
4. Choose the next slice from the census, per the vision: `sliceCandidates` from `phase0 check`, ranked by the
   vision's trade-offs. When no candidate is one you can justify from active clauses, stop with reason
   `vision-silent`. Otherwise report the slice and why at the next check-in; do not wait for approval.
5. **The between-arc commit.** `git switch -c work/<next arc> <completed head>` (`status.completion.head`). Every
   corpus edit of the next Phase 0 (amendments, curation, answered questions) and any change to
   `.roadmap/{vision.json, corpus.md, config.json}` goes into exactly one non-merge commit on that head; amend it
   as Phase 0 goes, and commit it empty (`--allow-empty`) if nothing changed. It touches nothing else. It is the
   next arc's baseline.
6. Phase 0 for the next arc, with `chain: {previousArc, previousHead: <completed head>}` in its plan.

**Stop.** Give a final check-in, ask the owner to merge the stacked PRs in order, first into `main`, each with a
merge commit, then end with exactly one line: `ROADMAP-SESSION: stopped <reason>`, where reason is `k-limit`,
`vision-silent` or `owner` (the owner told you to stop).

## Handling parks

Read the item's `evidence` first: the deciding call's `result.json`, its `stdout`, the spec, the lane evidence.
In a holistic arc a design park goes to the checkpoint first; you get it when the checkpoint does nothing, or on a
second design park of one lineage (`respec-second`). `roadmap steer <unit>` is an alternative for any parked unit.

- **Parked at plan-check or gate**: edit the unit's spec to the next rev, `roadmap apply`, then
  `roadmap resume <unit>`. The unit re-enters plan-check on the new revision and keeps its branch, worktree and
  session. The resume acknowledges the park.
- **Parked `routing-changed`** (the implementer seat's backend or model moved after its build started; an
  effort-only change re-pins by itself): restore the routing of the seat the item names, or re-enter the unit
  under a new id. Once the seat resolves to the same backend and model the unit was dispatched on,
  `roadmap resume <unit>` re-pins it and re-enters it where it parked.
- **Parked anywhere else** (a lost build, a residue, a red candidate, a red base, a failed salvage): re-enter.
  Add a unit with a new id (its fixed spec, the same scope), `git branch roadmap/<arc>/<new> roadmap/<arc>/<old>`,
  ack the old item, `roadmap apply`.
- **Usage limit**: the backend is parked arc-wide and nothing retries. Once the limit resets,
  `roadmap resume --backend <name>`. Never switch profiles to route around it.
- **Supervisor crash limit** (`sup-*`): read the crashed executors' stderr logs, fix the cause, `roadmap ack
  sup-<g>-<n> --repo <repo> --arc <arc>`, then `roadmap start`.

## Changing the plan

Edit the files in place, then `roadmap apply` (`--dry-run` first; `--expect-rev <n>` to refuse if the plan moved).
The executor applies at the next stage boundary and kills nothing; the receipt says applied or every reason it was
rejected. An edit you never apply has no effect, even after a restart.

- **Units**: add at the end or among units not started; remove only one that never started; ids are never reused.
  A dispatched unit keeps its resources and spec path, its risk may only rise, it gains no `after`, and its scope
  grows only by a ruling naming the patterns. Its spec keeps every item id (strike or defer, never delete) and
  takes `rev` + 1. A merged, approved or publishing unit's spec is fixed.
- **Lanes**: a lane's `evidenceGlobs` and `evidenceExcludes` may change at the current rev.
- **Obligations**: add, split or re-witness freely. Weakening one (remove, change statement or anchor,
  `must-hold` to `future`, waive, defer, retire) needs a ruling naming it: `roadmap rule` first. A rule anchor whose
  hash changed with the statement unchanged is an edit, not a weakening.
- **Corpus** (a re-pin) and **Phase-0 record** edits are `apply` edit classes. A re-pin re-gates every approval.
  Both change the pack, so before the first admission they trigger a new pack review.
- **Vision**: never reuse a clause id; withdraw, never delete. Commit `.roadmap/vision.json` before the `apply`.
- **Fixed**: `arc`, `integrationBranch`, `baseline`, `worktreeRoot`, the target kind and `chain`.
- **Rulings ledger**: only through `roadmap rule`.

## Lanes and shared resources

- Declare `evidenceGlobs` for everything a lane script writes as evidence. Undeclared ignored output is captured
  only when the lane fails, capped. Add `evidenceExcludes` for anything that must never leave the checkout.
- A lane asserts its required failure inside the script (or by `expectedExit`) and prints the failing step and
  reason on stderr before a non-zero exit: the fix round starts from stderr.
- A shared resource needs an owner marker its probe honours: anyone using it outside the executor writes
  `/var/tmp/roadmap-resources/<name>.lease`; the probe exits 11 while the lease exists, so the executor parks
  `occupancy-unlabelled` instead of tearing down someone else's work.

## Branches and refs

- You create the integration branch (short local name, cut at the baseline, checked out in no worktree, never
  `roadmap` or under `roadmap/<arc>`) and your work branches. The executor creates every other ref:
  `roadmap/<arc>/<unit>`, `refs/roadmap-run/<arc>/*`, `refs/roadmap/<arc>`. The only exception is a re-entry branch.
- `baseline` is a full 40-hex sha. `arc` and unit ids are lowercase slugs, at most 64 characters, no `/`.

## What you never do

- Run a backend, a lane or a teardown yourself.
- Run `git` inside the executor's worktrees, commit to its branches, or move or delete a ref it owns.
- Edit the run dir, the ack log or the executor-rendered `.roadmap/` files (`contracts/`, `constraints.md`,
  `invariants.md`, `debt.md`) by hand. Commands are the only write path.
- Acknowledge a needs-user item you have not read in full, or a brief the owner has not acknowledged.
- Edit the corpus outside Phase 0 and the between-arc commit.
- Change K, merge or push `main`, or merge a PR.
- Retry a usage-limited backend on a timer, or reroute around it.
- Write the vision, or adopt a direction the owner has not confirmed.
