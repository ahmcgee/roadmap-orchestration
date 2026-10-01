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

Two files, side by side in the directory that holds the arc's `plan.json`. A plan names its vision by a path
under its own directory, so keep the vision at the root of the arc inputs and reuse it across arcs.

- **`vision.md` is the vision.** You write it and the owner reads and confirms it. It is a coherent piece
  someone would want to read: prose, not a form. Never save the owner's raw words, your notes or unresolved
  tensions in it; what it holds is always the best coherent form so far.
- **`vision.json` is compiled from it** at confirmation (`roadmap/vision-m3`, SCHEMAS.md). Never edit it by hand
  and never write it before the owner confirms.

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
2. Hash the final file: `sha256sum vision.md`.
3. Compile `vision.json`:
   - `schema` `roadmap/vision-m3`, `rev` `n`.
   - `confirmation` `{"ref": "vision.md#sha256:<hex>", "at": "<now, ISO 8601>"}`.
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
   `node --input-type=module -e "import {readFileSync} from 'node:fs'; import {parseVision} from './executor/src/holistic/types.ts'; parseVision(JSON.parse(readFileSync('<dir>/vision.json', 'utf8')))"`
   Silence means the record is sound. On a refusal, fix the compilation, never the vision.

Then hand back to `orchestrate`. The arc's `plan.json` names `vision.json` in `holistic.vision` and the slice it
advances in `holistic.advances`: the clauses this arc moves toward, at least one of them a scene. Choose the
slice with the owner. On a running arc, a new vision rev goes in with `roadmap apply`, which refuses a slice
naming a withdrawn clause.

## Calibrate

Between arcs, before the next plan is written. Same dialogue, but from evidence: `status` of the arc that just
ran (its vision coverage, its divergence digest and its checkpoints' interpretations), the product as it now
stands, and `vision.md`.

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
