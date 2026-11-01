---
name: estate-compaction
description: Review the corpus rules, obligations, plain decision ledger and open debt with the owner; record approved retirements, merges, tightening and folding for the next Phase 0.
---

# Estate compaction

Reduce the material later arcs must carry without silently weakening the target. Survey and propose; the owner
approves each semantic change. The next Phase 0 applies approved decisions through ordinary validated inputs.
Structural housekeeping that preserves meaning remains part of normal Phase 0.

## Estate and authority

| Kind | Authoritative material | Application |
|---|---|---|
| Rules T-n | Corpus through `.roadmap/corpus.md`; retired ids/high-water in invariants registry | Edit corpus, commit, re-pin, refresh anchors and census |
| Obligations I-n | Latest inputs in force, exported during a run | Revise the complete split family, mapping by system and carried specs |
| Decisions C-n | Plain ledger named by plan.rulings | Edit root-facing text and keep references valid |
| Debt B-n | `.roadmap/debt.md`, plus live status | Promote, keep with reason or resolve with a C-n ledger reference in Phase 0 |

The vision belongs to the vision skill. Contracts change through gate-reviewed units. Do not edit executor-rendered
invariants, constraints or debt files. Questions and active findings go through the root's normal adjudication.
System notes are non-normative memory and cannot replace corpus claims.

Seats read selected relevant rules/obligations and the campaign audit reads the whole target. The plain C-n ledger
is root-facing; it is not embedded in worker prompts. Measure the actual material and references rather than
assuming every item reaches every call.

## Record

Keep `<repo>/../roadmap-inputs/compaction.md` outside the product tree. Append approved decisions immediately;
never edit the estate while surveying a running arc. There is no executor-reserved future-input directory.

```markdown
## K-<n> <retire|merge|tighten|fold|resolve>
Items: <ids and surveyed text>
Replacement: <exact text and id, T-? for a new rule, or none>
Gives up: <what stops being demanded, or nothing>
Why: <one line>
Approved: <YYYY-MM-DD>
Applied: <arc> | Blocked: <refusal row>
```

Number approved entries K-1, K-2, … without gaps, independently of proposal numbers; append one above the highest
record id. If approval is revoked in an entirely unapplied draft, rebuild it with contiguous ids and preserve the
owner exchange as evidence. Use only Applied or Blocked after attempting Phase 0.

## Survey and propose

Read the current corpus, registry, exported obligations/ledger, open debt, vision, census and brief. Identify
retired material that ordinary Phase 0 already omits. Give the owner counts and approximate input sizes.

Actions:

- **Retire:** no longer relevant or sufficiently important to demand. Name the lost requirement explicitly.
- **Merge:** replace overlapping items with one that demands all their properties.
- **Tighten:** preserve meaning in fewer words, moving explanation into rationale prose.
- **Fold:** move a lasting truth from the root ledger into the normative corpus.
- **Resolve:** close obsolete, duplicate or negligible debt. Name any behavior deliberately left unfixed.

For merge, tighten and fold, list every original consequence/prohibition and verify the replacement demands it.
Witnesses must still cover each property. Any lost property makes that part a retirement. “Gives up: nothing”
is a checked claim. Prefer high-payoff items, but investigate heavily cited material and anything serving the
current slice before proposing removal.

Present up to ten concrete decisions per batch: current text, action, exact replacement, loss and reason.
Approval is explicit per decision or batch. Recheck owner-written replacements and play them back before recording.
Deferred and rejected proposals are not approvals. Finish with the approved record and before/after counts.

## Applying the record

For each approved decision with neither Applied nor Blocked:

- Make the exact corpus/ledger/obligation/debt edits in the next Phase-0 pack. Each curation `what` starts with
  `compaction K-n:` and names original ids, replacement ids, reason, loss and owner approval. Use structural for
  equivalent restructuring or an owner-approved retirement, fact-currency for something the product overtook.
  `files` is nonempty: existing source-evidence paths relative to the corpus root, not the input directory.
  For ledger/debt-only changes cite the relevant corpus context there and name the ledger/debt source in `what`;
  an external `rulings.md` is not a corpus source. `rules` lists affected T-n ids, or `[]` when none change.
- Retiring a rule removes its line and rationale that explains nothing else. Update the census and anchored
  obligation family. Keep retired rule ids retired. A new meaning takes a new id above the high-water.
- Merging rules gives the replacement one census entry; keep an old id only if its meaning is unchanged.
  A merged obligation spanning lanes can use a split parent with one child per lane and the census naming the parent.
- Tightening equivalent text keeps its id and refreshes rule hashes. A normative obligation edit increments its
  revision and needs a fresh proof judgment for the statement revision and exact test ids/files.
- Removing an obligation removes the whole family and every reference in system mapping and carried specs. Within
  a live revision, prefer explicit retired dispositions and the root's apply reason where the classifier requires
  conservation; never manufacture a record to bypass refusal. New obligation ids are never reused.
- The ledger format is `C-n — <text>`; withdrawal is `C-n — withdrawn by C-m`, with C-m present. A merge/fold updates
  carried `cites.rulings` and debt references before removing a referenced entry. No metadata directory is required.
- The debt disposition JSON is `{"type":"resolve","ruling":"C-n"}`. Its active plain ledger entry names both B-n
  and compaction K-n, explains why the debt closes and states any behavior deliberately left unfixed.

For example, with corpus root `docs/corpus`, source `register.md` explaining a removed bridge, and C-41 the next
ledger id, propose this exact replacement and record it after approval:

```markdown
## K-1 resolve
Items: B-2: Remove the old bridge retry queue.
Replacement: C-41 — B-2 resolved by compaction K-1: the bridge is gone; retry-queue cleanup is given up.
Gives up: retry-queue cleanup in the removed bridge
Why: the product removed the bridge
Approved: 2026-11-01
```

In `phase0.json`, append this curation and replace B-2's disposition (keep all other required entries):

```json
{"tier":"fact-currency","what":"compaction K-1: resolve B-2 by C-41; .roadmap/debt.md tracks the removed bridge queue; owner approved giving up its cleanup on 2026-11-01.","files":["register.md"],"rules":[]}
```
```json
{"id":"B-2","disposition":{"type":"resolve","ruling":"C-41"}}
```

Append the exact `C-41 — …` replacement line to the ledger named by `plan.rulings`. These are authored inputs;
the rendered debt file remains untouched. Append `Applied: <arc-id>` to K-1 only after successful start.

Commit corpus/config/vision changes as required, regenerate the pin, then run Phase 0 validation and start.
Running-arc revisions use export → edit → CAS apply with the exported revision and one-line reason. Do not infer
that validation waives intentional weakening. Only the root authorizes dispositions; report a refusal and correct
its application, never quietly apply a different decision.

After a successful start, mark Applied with the arc id. If the approved change cannot pass as written, mark Blocked
with the exact row and return it to the owner. Keep evidence of the approved text and the no-loss check.
