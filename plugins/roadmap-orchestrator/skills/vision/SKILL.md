---
name: vision
description: Distils the owner's vision for a roadmap-orchestrator arc through dialogue, from scattered thoughts to a confirmed, complete picture of the target world, and calibrates it between arcs. Use before planning a holistic arc, after an arc completes, or whenever the owner wants to work out or revisit what they are really building toward.
---

# Vision

The vision is the root of every arc: the owner's picture of the world the work builds toward. Obligations,
contracts, plans and code are means to it, and the executor's judges steer by it (OR-V). Your job is to get
that picture out of the owner's head, make it coherent, make it complete, and prove you understood it, in
conversation. Expect to start from scattered, disorganised thoughts. Organising them is your work, not theirs.

## The files

Two files. The vision document lives in the product's corpus; its compiled record lives in the product repo.

- **The vision document is the vision.** Its path is the `vision` field of the corpus guide,
  `.roadmap/corpus.md` (under the guide's `root`); `vision.md` below stands for that path, whatever its name. You
  write it and the owner reads and confirms it. It is a coherent piece someone would want to read: prose, not a
  form. Never save the owner's raw words, your notes or unresolved tensions in it; what it holds is always the best
  coherent form so far. It carries no `rules` block: rules belong to the rest of the corpus, and the executor
  refuses a vision document holding one (`rules-in-vision`).
- **`.roadmap/vision.json` is compiled from it** at confirmation (`roadmap/vision-m3`, SCHEMAS.md "M3: the
  holistic layer" and "M4a"). Never edit it by hand and never write it before the owner confirms. It is committed,
  like the document: `start` and `apply` refuse `tree-uncommitted` while it differs from `HEAD`.

No guide yet: the `orchestrate` bootstrap writes `.roadmap/corpus.md` first. Never choose the corpus home yourself.

Pick the mode from the files; never ask the owner which:

| Files | Mode |
|---|---|
| no `vision.md` | **Distil** from nothing |
| `vision.md` marked draft, or edited since its confirmation (its sha256 differs from `confirmation.ref`) | **Distil**, resuming: an edited confirmed vision is unconfirmed until its changes are played back |
| `vision.md` confirmed, hash matches | **Calibrate** |

## The shape of `vision.md`

```markdown
# <name of the world, not the product>

Status: Draft | Confirmed, rev <n>, <YYYY-MM-DD>

## The world
### <scene title> {V-1}
<A scene in prose: who is there, what they are doing and experiencing on an ordinary day, and why it is better
than today, set against how it is now. Distant is fine. Visceral and specific beats general.>

## Why this world {V-2}
<the purpose: one paragraph of why this world is worth building>

## Who it serves
- <who> {V-3}: <and who it deliberately does not serve>

## What good looks like
- <an observable sign, something recognisable in a day of use> {V-4} (in: V-1)

## Non-negotiables
- <the line that holds> {V-5} (in: V-1). Costs: <what the owner gives up to keep it>

## Trade-offs, in rank order
1. <A over B, where both are goods> {V-6} (in: V-1)

## Open questions
- <the question> {Q-1}. Bears on V-1, V-4. Who could answer: <person, or "only real use will tell">.
  Meanwhile: <the working assumption the arc acts on>.
```

Each clause carries one `{V-n}` anchor; each facet notes the scenes it serves with `(in: V-…)`. Show only the
living vision: a clause that is replaced or dropped leaves `vision.md` and is withdrawn in `vision.json`.

## Distil

Run a dialogue, one question at a time. Lead with hypotheses, not open questions: after each burst of input,
say what you think the heart of it is, specifically and strongly enough to be knocked down, and let the
correction carry the signal. "I think what you want isn't faster reconciliation; it's month-end never eating
your weekend. Is that it?" Then fold the answer into `vision.md` and show the owner the passage that changed.

Get past the surface with these:

- **The why ladder, as guesses.** "You want X because Y?" Climb until the answer stops being instrumental.
- **Subtraction.** "If it did all of this except X, would you still want it?" A shrug means X was surface.
- **The cost probe.** "What would you give up to keep this?" Nothing: it is a preference, not a non-negotiable.
- **Scenes, not features.** "That is a feature, not a world. What does someone's day look like because of it?"
- **Forks between goods.** Put concrete choices ("unattended or fast, which loses?") to rank trade-offs; never
  ask for a ranking in the abstract.
- **Bolder worlds.** When the owner's fragments point past what they said, propose the more ambitious world.
  They accept or reject it; never adopt it silently.

Stop pressing a point when the answer survives one more probe without shifting, not when the owner tires. An
owner's "move on" on something unresolved makes it an open question (below), never a silent gap.

Hold tensions (contradictions, gaps, surface answers) in the session and attack them there, most important
first. They never go in a file. When a session ends early, leave `vision.md` marked draft in its best coherent
form; anything still unresolved that the owner cannot settle today becomes an open question.

### The vision is free of solutions

The vision says what the world is like and why, never how it is built. The test, for a clause or an open
question: could one implementation satisfy every reading of it? If a clause names a mechanism ("a CLI that…"),
push back to the experience the mechanism exists for. If a question's answers would only choose between
implementations, it is a design question: it belongs in obligations or the plan, not here. A vision open
question is one whose answers would produce different worlds: who is served, what their day feels like, what
good is, how the trade-offs rank.

### Open questions

The owner may not know everything yet, may need to ask someone, or may only learn it from real use. Write down
everything known today so the arc can act on it, and record the rest as open questions. Each names the
clauses it bears on, who or what could answer it, and a working assumption the arc acts on meanwhile. A
question without an assumption blocks confirmation: the arc would be guessing silently. Never answer an open
question yourself.

### Complete

The vision is complete when every test passes or is covered by an open question:

1. **A world, not a product.** At least one scene a reader can picture, with people doing and experiencing
   things, and why it beats today stated against today.
2. **Coherent.** The scenes describe one world. Every facet serves a scene; every scene is carried by facets.
   A facet no scene needs is surface; a scene no facet supports is decoration.
3. **The purpose reaches bedrock.** One more "why does that matter?" gets "because that is the point".
4. **Served people are concrete,** including who it does not serve.
5. **Good is observable.** Each served person has a sign of good someone could recognise in a day of use.
6. **Each non-negotiable has a stated cost.**
7. **Trade-offs are ranked between real goods,** each settled at a concrete fork, covering the forks the arcs
   will hit.
8. **Free of solutions** (above).
9. **Decidable.** The playback (below) passes.

## Playback and confirmation

When tests 1–8 pass or are covered, play back:

1. **The whole `vision.md`**, in final form, so the owner reads exactly what will be recorded.
2. **Three to five decisions you would make on their behalf**, at concrete forks the arc or the horizon will
   hit, each decided only from the vision and citing the clauses that decided it ("an import is malformed:
   refuse and explain, never guess; V-6 over V-9"). At least one rests on an open question's working
   assumption, to show how the provisional parts will behave.
3. **What the vision rules out**: things you would refuse to build even if asked.

Confirmation is the owner agreeing with every decision and every exclusion, then an explicit "confirmed".
"Looks good" in passing is not confirmation. A "no, I'd go the other way" means a clause is missing or
mis-ranked: find it, revise, and play back only what changed.

On confirmation:

1. Set the status line to `Confirmed, rev <n>, <date>`. `n` is the previous `vision.json` rev plus one, or 1;
   keep the previous rev when calibration changed nothing.
2. Hash the final file: `sha256sum <root>/<vision path>`.
3. Compile `vision.json`:
   - `schema` `roadmap/vision-m3`, `rev` `n`.
   - `confirmation` `{"ref": "corpus:<vision path>#sha256:<hex>", "at": "<now, ISO 8601>"}`, the path as the
     guide's `vision` field spells it (relative to `root`). The executor hashes the pinned copy of that file at
     every `start` and `apply` and refuses a mismatch (`vision-unconfirmed`).
   - `clauses`: every anchored clause as `{id, kind, text, rank, state: "active"}`. The kind follows the
     section: world, purpose, serves, good, non-negotiable, tradeoff. `rank` is the trade-off's position and
     null otherwise. `text` is the clause's prose with its cost and its `(in: …)` note. Every withdrawn clause
     carries over from the previous `vision.json` unchanged.
   - `questions`: each open question as `{id, text, bears, assumption, state: "open"}`. Every answered one
     carries over from the previous file as `closed`.
   - New ids count up from the highest ever used, withdrawn ones included; ids are never reused. A rewording
     that keeps a clause's meaning keeps its id. A change to what it demands withdraws the old id and adds a new
     one.
4. Validate with the executor's own parser, from the plugin root:
   `node --input-type=module -e "import {readFileSync} from 'node:fs'; import {parseVision} from './executor/src/holistic/types.ts'; parseVision(JSON.parse(readFileSync('<repo>/.roadmap/vision.json', 'utf8')))"`
   Silence means the record is sound. On a refusal, fix the compilation, never the vision.
5. Commit the vision document and `.roadmap/vision.json` together: in the bootstrap commit, or between arcs
   in the between-arc commit (for an `other-repo` or `checkout` corpus, the document is committed in the corpus
   source and `vision.json` in the product repo). Then re-pin the corpus (`orchestrate`): the pin carries the
   document the confirmation hashes.

Then hand back to `orchestrate`. The arc's plan names no vision file (a corpus arc reads `.roadmap/vision.json`);
its `holistic.advances` and the Phase-0 record's `slice.advances` name the slice it advances: the clauses this arc
moves toward, at least one of them a scene. Choose the first slice with the owner; later slices `orchestrate`
chooses from the census and reports. A vision change belongs between arcs. On a running arc it takes a commit, a
re-pin and `roadmap apply`, which refuses a slice naming a withdrawn clause.

## Calibrate

Between arcs, before the next plan is written. Same dialogue, but from evidence: `roadmap brief` and `status` of
the arc that just ran (its vision coverage, divergences, the checkpoints' interpretations, the census and the
questions the corpus raised), the product as it now stands, and `vision.md`.

1. **Open questions first.** For each one: is it answered now? Fold the answer into the world and close the
   question. If the answer contradicts the working assumption, name what the arc built on that assumption.
2. **Reality against the scenes.** For each scene in the last slice, describe what now exists and ask whether
   that day feels the way the scene says. A gap is either work for the next slice or a wrong scene.
3. **Interpretations.** Each place the checkpoint read the vision in a way the owner reversed, or that
   surprised them, is an ambiguity. Propose the clarification.
4. **What has the owner learned about what they want?** The vision grows as the arcs do. Propose bolder or
   different worlds from what the arc revealed. Change anything outright when the owner's picture has
   moved, scenes, purpose and rankings included. Withdrawal keeps that safe: the vision coverage in `status`
   (`withdrawnCited`) names every obligation still citing a withdrawn clause.
5. **The next slice.**

Close with a playback limited to what changed (all of it if much did), then confirm and compile as above. A
calibration that changes nothing still re-confirms: same rev, fresh `confirmation.at`.

## What you never do

- Write a mechanism into the vision, or a design question into its open questions.
- Adopt a bolder world, or resolve an open question, without the owner saying so.
- Save raw notes, transcripts or tensions in `vision.md`.
- Compile `vision.json` without an explicit "confirmed", edit it by hand, or reuse an id.
- Start a holistic arc on a vision that is draft or whose hash does not match.
- Put a `rules` block in the vision document, or a mechanism the corpus rules should carry.
