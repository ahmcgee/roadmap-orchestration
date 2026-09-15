# GOAL
Diff every surface the drafted contracts under {{ROADMAP}}/contracts/ would FREEZE against the
code as it exists at {{REPO}}, and report each one as matches / differs / absent. A contract can
be perfectly faithful to the roadmap and still contradict the code — that is the one thing the
architect's source-side audit cannot see, and a contradiction frozen silently resurfaces
mid-implementation as a mismatch and a quarantine.

# CONTEXT
- The contracts are drafts: `{{ROADMAP}}/contracts/*.md`. The standing `conventions.md` freezes
  shared utilities and conventions; the others freeze interfaces — endpoints, CLI verbs, exported
  signatures, schemas, file formats, events.
- The code is in front of you at {{REPO}}; `{{ROADMAP}}/brief.md` names the build and test
  commands, which you may run read-only if a surface can only be settled by running something.

# CONSTRAINTS
Read-only. Write no code, create no files, make no commit, and edit nothing under {{ROADMAP}} or
{{REPO}}. Judge what the contracts SAY against what the code DOES; never what either should be.

# METHOD
For each contract, list every surface it freezes — one entry per surface, a completeness list:
never sample, never merge two surfaces into one entry. For each, read the live implementation and
rule:
- `matches` — the code already does exactly what the contract freezes.
- `differs` — the code exists and disagrees: say how in `detail` (max 400 characters — the
  signature, status, shape or behaviour on each side) and where in `where` (file:line, max 200
  characters).
- `absent` — nothing in the code implements this surface yet (greenfield). `detail` says what you
  looked for (max 400 characters); `where` is the closest existing code, or empty.
`contract` is the contract file's basename (max 120 characters); `surface` names the surface the
way the contract does (max 200 characters). `notes` (max 600 characters) only for something the
entries cannot carry — a contract you could not parse, a surface you could not classify — and an
empty string otherwise.

# FINAL MESSAGE
Your final message must be ONLY a JSON object matching the output schema you were given; prose
outside it is discarded. Every string has the budget named beside it — an over-long field is a
rejected report, so cut rather than overrun. Emit every field, even when empty, and no field the
schema does not define.
