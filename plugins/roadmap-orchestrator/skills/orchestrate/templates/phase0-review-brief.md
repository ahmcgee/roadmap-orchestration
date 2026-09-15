# GOAL
Review the DRAFT plan pack of a roadmap build before anything is frozen or built, and report what
the engineers who will build it would trip over. You are from the model family that builds every
unit of this plan; the architect who drafted it is from another. What you catch is what that family
cannot see about its own draft — and everything you report is adjudicated by that architect, never
applied by you.

# CONTEXT (read ALL of these — do not guess at them)
- The draft pack is under {{ROADMAP}}: `plan.json` (units, edges, cut line, provision, preview),
  `specs/<id>.md` (one per unit — every acceptance criterion binds), `contracts/*.md` (frozen
  interfaces, including the standing `conventions.md`), `brief.md` (build/test commands and
  conventions every unit agent will trust), `constraints.md` (numbered rulings) and
  `architect-log.md` (the `## Direction` section states the tie-breakers).
- The code is in front of you at {{REPO}}. Explore as much of it as you need.
- The pack is a DRAFT. Nothing in it is frozen yet, so a contradiction you find now is an edit;
  found later it is a quarantine.

# CONSTRAINTS
Read-only. Write no code, create no files, make no commit, and edit nothing under {{ROADMAP}} or
{{REPO}} — this run produces a report and nothing else. You may RUN the commands `brief.md` names
(build, lint, test) exactly as written, to check that they work: that is the one thing here that
reading cannot settle. Do not propose an alternative product; judge the plan as drafted.

# METHOD
Read the whole pack first, then the code the contracts describe, then run the brief's commands.
Hunt, in this order:
1. `contradictions` — two contracts, a contract and a spec, two specs, or a spec and the code as
   it exists, that cannot both be true. Name both sides in `between` (max 200 characters), say
   what conflicts in `what` (max 400 characters) and cite it in `evidence` (file and line or
   command output, max 300 characters). At most 10, worst first.
2. `unbuildable` — a unit you could not build as specified: an acceptance criterion no command can
   check, a decision the spec leaves open that reasonable engineers would settle differently, a
   frozen surface the unit needs but no contract defines, a dependency the edges do not record.
   `unit` is the plan id (max 60 characters), `why` max 400 characters, `question` the exact
   question you would have to ask before starting (max 300 characters). At most 10.
3. `recut` — where you would cut the decomposition differently: two units that will collide on
   the same files, a seam that puts one interface on both sides, a unit too large to hold in one
   review or too small to pay for its own gate. `units` names them (max 200 characters),
   `proposal` says the cut (max 400 characters), `why` the cost of the draft's cut (max 300
   characters). At most 6. A different taste is not a recut; a concrete cost is.
4. `briefDefects` — a command `brief.md` names that does not do what the brief says when run:
   `command` verbatim (max 300 characters), `observed` what actually happened (max 300
   characters). At most 8. Only commands you ran.
5. `questions` (max 300 characters each) — everything else you would have to ask the architect
   before building, one sentence each, worst first. At most 12. A question you could answer by
   reading the code is not one.
6. `notes` — one short paragraph (max 600 characters) only if something needs saying that the
   fields above cannot carry. Empty string otherwise.

An empty field is a legitimate answer and better than a manufactured finding: report what is
there, not what would make the report look thorough.

# FINAL MESSAGE
Your final message must be ONLY a JSON object matching the output schema you were given; prose
outside it is discarded. Every array above is capped as stated and every string has the budget
named beside it — an over-long field is a rejected report, so cut rather than overrun. Emit every
field, even when empty, and no field the schema does not define.
