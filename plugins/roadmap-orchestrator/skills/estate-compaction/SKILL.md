---
name: estate-compaction
description: Reviews with the owner the estate a chain of roadmap-orchestrator arcs has accumulated (corpus rules, obligations, rulings, open debt) and decides what to retire, merge, tighten or fold, so every judgment reads less. The next Phase 0 applies the approved decisions. Use when the owner asks, or when an orchestrate check-in recommends it; while an arc runs or between arcs.
---

# Estate compaction

The estate is what a chain of corpus arcs carries forward: the corpus rules (`T-n`), the obligations (`I-n`), the
rulings (`C-n`) and the open debt (`B-n`). Every arc adds to it and the executor never removes anything on its own, so
it only grows. And every carried item is read again:
- **Rules.** Every active rule goes, word for word, to plan-check, the gate, the lenses, the checkpoint and the pack
  review, on every call.
- **Obligations.** The lenses, the checkpoint and the pack review read all of them. The gate reads those its unit
  touches.
- **Rulings.** The checkpoint and the audit read every active ruling in full. Plan-check, the build and the gate read
  the first sentence of every ruling they do not cite.

Past a few hundred items, judgment gets slower, costlier and less precise.

This skill shrinks the estate with the owner. You survey it and propose; the owner decides each change; the next
Phase 0 applies what they approved. Nothing leaves the estate, and no wording changes, without the owner's explicit
approval. Housekeeping that changes no meaning is not this skill's: Phase 0 does it every arc, unasked. It omits
obligations already `retired` (`orchestrate` step 5) and drops withdrawn and arc-lifetime rulings that nothing carried
names (step 12).

## Scope

| Kind | Lives in | Leaves by |
|---|---|---|
| Corpus rules | `rules` blocks in the corpus | removal from the corpus (the pin retires the id) |
| Obligations | each arc's `obligations.json`, published in `.roadmap/invariants.md` | omission from the next arc's `obligations.json`, under a Phase-0 ruling |
| Rulings | each arc's ledger and sidecars, rendered in `.roadmap/constraints.md` | omission from the next arc's ledger (`orchestrate` "Phase 0" step 12) |
| Open debt | `.roadmap/debt.md` | a Phase-0 `resolve{ruling}` disposition |

Out of scope:
- The vision. The `vision` skill owns it.
- Contracts and architecture docs. Arcs change those through contract ops.
- What code renders and keeps: closed debt items, the rules registry, and the files' history.
- Questions, amendments and findings. Phase 0 settles those.

A chain without the holistic layer has only rulings; in such a chain, compact those alone.

## The record

Decisions go to `<repo>/../roadmap-inputs/_next/compaction.md`, never straight into the corpus or an arc's inputs.
The estate changes only in Phase 0. The record lets you run this skill while an arc runs, and the `orchestrate` skill
applies every unapplied decision at the next Phase 0 ("Applying the record", below). Append each decision as soon as
the owner approves it, so a session that ends early loses nothing.

```markdown
## K-<n> <retire|merge|tighten|fold|resolve>
Items: <ids, with their text as surveyed>
Replacement: <exact new text and its id (T-? for a new rule id), or none>
Gives up: <what the estate no longer demands, or nothing>
Why: <one line>
Approved: <YYYY-MM-DD>
Applied: <arc id, written by Phase 0> | Blocked: <the refusal row, written by Phase 0>
```

`K-n` counts up across the chain: one more than the highest `K-n` in any earlier record, the arcs' `next/` copies
included.

## 1. Survey

Read the newest state of each kind:
- **Rules.** The corpus through `.roadmap/corpus.md`, on the owner's checkout. Read retired ids and the high-water
  from the `json roadmap-rules` registry in `.roadmap/invariants.md`.
- **Obligations and rulings.** While an arc runs, read them from `roadmap inputs export`. Otherwise read the latest
  arc's inputs (its `obligations.json` with the census, its ledger and sidecars). Read each ruling's `lifetime` and
  provenance from its sidecar or `.roadmap/constraints.md`.
- **Debt.** The open items of `.roadmap/debt.md`. While an arc runs, also `status.debt.banked`.
- **Context.** `.roadmap/vision.json` (the active clauses and the slice), and the latest brief and `status`
  (findings, vision coverage, the census).

Then give the owner the scale: the count of each kind and how much of it each judgment reads.

## 2. Candidates

There are five actions. Each one applies to particular kinds:

- **retire**: a rule, obligation or ruling that no longer holds or no longer matters. Examples: about something the
  product no longer has; a working assumption whose question is answered; overtaken by a later decision; trivially
  true of any implementation.
- **merge**: several rules, obligations or rulings that state one property, overlap, or where one implies another.
  The result is one replacement. Never merge a ruling that dispositions an obligation (`obligationDispositions`
  non-empty): the obligation's state names it.
- **tighten**: the same meaning in fewer words. Typical targets: hedges, restated context, examples, rationale
  inside a rule line (rationale belongs in prose).
- **fold**: a standing ruling that states a lasting truth about the target becomes a corpus rule. Rulings accumulate
  as patches; the corpus is where the target lives.
- **resolve**: open debt that is obsolete (its code is gone, or another item or unit already covers it), that
  duplicates another item, or that is trivial. Debt is substantive drag on later work. An item whose drag is
  negligible, a nitpick that should have been released, never needed a unit: resolve it with "Gives up" naming
  what stays unfixed.

**The no-loss test**, for every merge, tighten and fold:
1. List each property the originals demand: every testable consequence, every prohibition.
2. Check that the replacement demands each one. Its witnesses run every test the originals' witnesses ran.
3. Whatever is not demanded goes under "Gives up", and that part of the decision is a retirement. Say so in those
   words.

"Gives up: nothing" is a claim you have checked, never a default.

Order candidates by payoff: how many judgments read the item, times its length. Rules come first, because every
judgment reads all of them on every call. Spend the owner's attention on judgment calls: the more an item's id appears
in recent findings, rulings or the census, the stronger the reason it needs before you propose retiring it. Flag any
candidate that serves a clause the vision advances.

Be bold about structure. "These fourteen rules on error handling are one principle and three testable rules" is the
kind of proposal this skill exists for.

## 3. Review with the owner

Present batches of up to ten decisions, one kind at a time. Number each decision and show:
- the items with their current text
- the action
- the exact replacement
- what it gives up
- why

Lead with your recommendation, specific enough to be knocked down, and let the owner's corrections steer the next
batch.

Approval is explicit, per decision or per batch: "yes", "all but 3", "5: keep", or their own wording. When the owner
rewrites a replacement, re-run the no-loss test on their text, play back only that decision, then record it. A
rejected decision is not recorded. Neither is a question the owner defers: it comes back at the next compaction. The
owner may stop at any point.

Close with the new scale (counts and the size each judgment reads) against the survey, and the decisions recorded.

## Applying the record

This section is for the `orchestrate` skill's Phase 0, which applies every decision with neither `Applied` nor
`Blocked`. Each decision becomes ordinary Phase 0 edits.

### Removing an obligation

The other actions rely on this. To remove an obligation:
- Remove its whole split family (parent and children).
- Remove its id from every `mapping` entry, and drop an entry left empty.
- Remove it from the `obligations` of every carried spec.
- Name every removed id in one Phase-0 ruling, in both `obligations` and `obligationDispositions` (disposition
  `retired`).

New obligation ids take the next `I-n` above the highest in any earlier arc's `obligations.json`. Ids are never
reused, and an id that has left `invariants.md` is not otherwise guarded.

### Rules

- **Retire.** Delete the rule line and any prose that only explained it, and its census entry. Remove each binding
  obligation anchored on it. A waived or deferred one may stay: it still resolves against the retired rule.
- **Merge.**
  - The replacement takes the next `T-n` above the high-water. It keeps an original's id only when it says what that
    original said, with only restatements absorbed.
  - Delete the other originals and their census entries.
  - Give the replacement one census entry. When the originals' census states differ, the decision says which state
    holds.
  - Anchor one new obligation on the replacement and remove the originals' obligations. Its witness is one when the
    originals share a lane. When they span lanes, it is a split parent with one child per lane, and the census names
    the parent. It carries a proof judgment like any new obligation.
- **Tighten.** Same id, new text. Refresh `textSha256` on every obligation anchored on it, and in every carried
  sidecar's rule ref to it. No ruling.

### Obligations

- **Merge.** A new id built as in a rule merge, and the originals removed.
- **Tighten.** Same id. A changed statement needs a ruling naming it with disposition `amended`.
- **Retire.** Remove it.

### Rulings

- **Merge and tighten.** Write one new ruling with the replacement text whose `supersedes` names the originals. Fold
  each original's ledger line to `C-n — withdrawn by C-m`, set its sidecar's `status` to `superseded`, and point each
  carried spec's `cites.rulings` at the new ruling.
- **Fold.** Add the rule to the corpus, with its census entry and rationale prose citing the ruling and `K-n`. The
  ruling then leaves the ledger as a retirement does.
- **Retire.** Remove its ledger line and its sidecar file (`<ledger>.d/C-n.json`: every file there is loaded). A
  ruling still named (see `orchestrate` step 12) stays until what names it is gone.

### Debt

`resolve{ruling}` by a Phase-0 ruling that names the items and says why (one ruling may resolve several). For a
duplicate, the ruling names the item that survives.

### Corpus edits and Phase-0 rulings

Corpus edits go in the between-arc commit. Each also needs a `curation` entry whose `what` starts with
`compaction K-n:`:
- `structural` for a merge, tighten or fold;
- `fact-currency` for a retirement the product overtook;
- `structural` for an owner's retirement of a claim still true, the `what` saying so.

A Phase-0 ruling is an architect sidecar (SCHEMAS.md "Ruling sidecars") with these fields:
- `kind: disposition`, `ruledBy` and `consistency.by` both `{type: architect}`, `consistency.verdict: consistent`,
  and `judgedRevs` the revisions it was written against.
- `lifetime: arc`: it is needed only at this arc's start, so it leaves at the next Phase 0.
- `appliesTo: {type: arc}`, `trigger` naming each `K-n` it carries, `cites` and `evidence` empty.
- `docRefs`, never empty: a rule ref to the replacement or surviving rule, or a doc ref to the corpus section the
  decision touched.

Then `phase0 check` until it exits 0, and `start`. `phase0 check` does not diff obligations against the baseline:
an obligation dropped without its ruling is refused only at `start`, as `plan-change-refused` naming
`obligation-dropped`. On a refusal, fix the application, never the decision. A decision that cannot be applied as
approved gets `Blocked: <row>` and goes to the owner at the next check-in. Never apply a variant they did not
approve.

Once `start` succeeds, and before `_next/` is handed over, write `Applied: <arc>` on each applied decision.

## What you never do

- Change the estate outside Phase 0, or record a decision the owner did not explicitly approve.
- Call a change "nothing given up" without running the no-loss test.
- Reuse an id, or bring back a retired rule.
- Touch the vision, the contracts, or a file code renders.
- Work around a refusal by applying something other than the approved decision.
