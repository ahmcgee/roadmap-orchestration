# Evals

Current harness map for **1.0.0-dev.33 / schema 2**. Run commands from executor/. CLAUDE.md defines which ladder rungs a
change triggers. Paid checks run once per merged batch, not once per worker. The historical fixture narratives are in git
history; current setup/driver/check source and saved evidence determine what a run actually exercised.

## Ladder and isolation

1. `npm run typecheck` checks source, tests and evals without building.
2. `npm test` runs free tests with fake backends and real processes/git. The main tier is concurrent; serial files run
   alone. Crash matrices, resource fanout, browser checks, pressure and timing-sensitive harnesses belong in serial.
3. `node evals/probe.ts [--profile default|claude-only]` checks real authenticated backend argv/runner/adapter behavior.
4. Rung 3.5 role evals are path-triggered; paid fixtures are rung 4 when behavior/fixture scope requires them.

Use a shared host lock when coordinating serial checks across workers. A saturated host invalidates timing diagnosis;
rerun a timing failure calmly before changing a bound or assertion. Read-only cgroup-v2 means contain.cgroup-real is
NOT RUN, never a pass. Do not infer week-long reliability or real-model crash recovery from fake integrated coverage.

Dev.33's previous-release test names dev.32 and checks loud schema-1 refusal before claim/recovery. It does not launch an
old executor and adopt its arc. Later schema-2 releases must resume the normal upgrade-in-place contract.

## Targeted probe

The probe uses production backend argv, containment, runner and adapters. It covers smoke, fresh/resumed builds,
judgment isolation and evidence reads, schema/usage parsing, advisor/delegated usage, interruption and current role
surfaces. `evals/probe.ts` is the exact row list. Passing a fake or dry-run harness does not replace this real-CLI check.
The probe is paid; run it only as the batch's triggered rung, not as a documentation syntax check.

## Fixture families

Each family has setup.ts, driver.ts and check.ts; reports are output JSON, not a shared report.ts module. Setup creates a fresh isolated fixture directory. Drivers
write evidence/reports; check re-reads saved evidence and can be rerun without asking a model. Never reuse a run directory
as though it were a fresh trial. Read the family's parser before invoking an option.

| Family | Current focus | Driver form |
|---|---|---|
| m1 | Unit lifecycle, certification, candidate publication, clean PR and durable evidence | `node evals/m1/driver.ts <dir> --profile default|claude-only [--fake <scenario.json>]` |
| m2 | DAG/resources, contingent edges, re-entry, merge conflict and scheduling | `node evals/m2/driver.ts <dir> --profile default|claude-only [--fake <story-dir>]` |
| m3 | Obligations/witnesses, whole-campaign findings, root CAS repair and completion | `node evals/m3/driver.ts <dir> --profile default|claude-only [--fake <story>]` |
| m4a | Corpus curation, Phase 0, owner questions/answers, briefs and chained arcs | `node evals/m4a/driver.ts <dir> [--profile default|claude-only] [--fake story|vision-silent]` |
| m5 | UI milestones, design references, experience verdict/polish, demo and browser evidence | `node evals/m5/driver.ts <dir> [--profile default|claude-only]` |

Use `node evals/<family>/setup.ts <dir>` and `node evals/<family>/check.ts <dir>` with the specific family's supported
arguments. M4a/M5 stage the plugin and run an architect session; their fixture constraints can deliberately be narrower
than general runtime capabilities (for example, holding a profile fixed). Free tests exercise their fake paths and
oracles. `test/serial/evals-m4a.test.ts`, walk-browser and evals-m5-reflow need serial isolation. Paid transcript grading
and acceptance remain separate from free runtime tests.

Reports separate demonstrated properties from limitations. Source checks and hash manifests establish publication and
journal consistency; they do not establish that every product claim is true. Preserve negative controls, actual script
consumption, witness identities and exact-head assertions when migrating a fixture to new behavior.

## Role evals (rung 3.5)

`node evals/roles/triggers.ts <base>` selects affected modes from changed paths; it spends nothing. The dispatcher
`evals/roles/run.ts` accepts these names:

| Name | Runtime role/mode | Sets |
|---|---|---|
| verifier | verifier gate | dev, holdout |
| gate | Alias of verifier gate | dev, holdout |
| pre-build | verifier annotation | dev only (three-cell surface set) |
| walkthrough | experienceVerdict walk | dev, holdout |
| polishJudge | experienceVerdict compare | dev, holdout |
| campaignAudit | campaignAudit | dev only (three-cell surface set) |

Examples:

```sh
node evals/roles/run.ts verifier --set dev --n 3 --cap 20
node evals/roles/run.ts pre-build --set dev --n 3 --dry-run
node evals/roles/run.ts campaignAudit --set dev --n 3 --dry-run
```

Pre-build and campaignAudit dry-run performs no backend calls. Their surface parser supports --fake expected|empty,
--cap and --out. It does not support holdout/rebind/compare. A verifier diagnosis eval is backlog until field diagnoses
supply representative cases; gate-mode coverage is not diagnosis evidence.

Per-mode forms (optional flags in brackets; placeholders are literal usage notation):

```text
node evals/roles/run.ts verifier --set dev|holdout [--n 3] [--cells G0,G3a] [--parallel 4] [--size 3000] [--seed roles-1] [--risk low|med|high] [--rebind CLASS=MODEL:EFFORT] [--out DIR] [--compare SUMMARY] [--cap USD] [--trial-cap USD] [--read-only] [--baseline SUMMARY] [--fake approve-all|revise-all|cite-every-path|cite-plant|overspend]
node evals/roles/run.ts gate --set dev|holdout [same flags as verifier]
node evals/roles/run.ts pre-build --set dev [--n 3] [--dry-run] [--fake expected|empty] [--cap USD] [--out DIR]
node evals/roles/run.ts campaignAudit --set dev [--n 3] [--dry-run] [--fake expected|empty] [--cap USD] [--out DIR]
node evals/roles/run.ts walkthrough --set dev|holdout [--n 3] [--cells S1,S2] [--parallel 2] [--rebind CLASS=MODEL:EFFORT] [--out DIR] [--compare SUMMARY] [--cap USD] [--trial-cap USD] [--fake oracle]
node evals/roles/run.ts polishJudge --set dev|holdout [--n 3] [--cells SP-B,HI-W] [--parallel 2] [--rebind CLASS=MODEL:EFFORT] [--out DIR] [--compare SUMMARY] [--cap USD] [--trial-cap USD] [--fake oracle]
node evals/roles/triggers.ts <base>
```

Rebind can repeat. Gate --size is 2,000–5,000 for real trials (100–5,000 fake); --read-only supplies the comparison arm,
and an acting run's --baseline must name that arm's same-cell summary. --compare is holdout acceptance against saved dev
results. The walkthrough/polish fake oracle validates the grader/harness without paid calls, never the real role's efficacy;
gate uses its listed degenerate fakes instead. Trials write
trials.jsonl, summary.json and per-cell evidence under --out; use an empty directory. Live trial-cap estimation can undercount delegated spend; a
between-trial cap and recorded final usage are distinct. Holdout fixtures are untracked and acceptance-only. Judge actual
catch/false-block/method evidence; a planted case is not caught merely because its file was listed.

Routing/prompt/schema/backend changes can trigger several modes. Shared method changes affect verifier/pre-build/audit.
Walk and comparison share an experience prompt but remain separately graded modes. The five runtime roles are build,
verifier, packReview, experienceVerdict and campaignAudit; eval aliases are not additional routing seats.

## Estate compaction

```sh
node evals/compaction/run.ts --set dev --n 3 --stage both --cap 20
```

Stage a surveys/proposes with a simulated owner; b applies the approved record through Phase 0. Both assesses proposal
quality and actual application. Its holdout uses --set holdout and --compare a matching dev summary. Changes to
estate-compaction or orchestrate's compaction instructions trigger this rung; the path trigger conservatively treats any
orchestrate skill edit as triggering it. Saved evidence can be regraded without backend calls. Approval transcripts and
applied records remain evidence; do not rewrite historical approvals to make a new grader pass.

## Efficacy feed and observation

Unit stage-outcome retains unit/stage/attempt/outcome/class/chargeable. Experience/audit jobs add a second arm with
stage experience-verdict|campaign-audit, job, milestone|null, verdict and P1/P2/P3/total finding counts. Consumers must
handle both arms; job verdicts have no unit/attempt/outcome. Meter, proc.spawn and lane-reused remain available. Codex
partial tokens are retained and missing native USD is estimated from a routed-model price table with costEstimated.

`status --summary` exposes spend, progress, verdicts and an activity aggregate of catches; it is not the role-eval grader.
Its capture list currently shows suite capture spawns, while actual gate evidence includes related spec captures too.
Observer tools read saved runtime/evidence and must not acquire control over the arc.

## M1 execution and coverage

```sh
node evals/m1/setup.ts <dir>
node evals/m1/driver.ts <dir> --profile claude-only
node evals/m1/check.ts <dir>
```

For a free scripted run, append `--fake <scenario.json>` to the driver; it uses PATH shims and a private host directory.
Real runs have a 90-minute driver timeout plus stop grace; fakes have five minutes. Claude-only shadows every PATH
directory containing executable codex so accidental dependence on that CLI fails visibly.

`check.ts` reports NOT EXERCISED for untaken branches: redirect, red lane, fix round, conflict/merge-in, red candidate,
base-red, gate revise, unpublished/fresh candidate and usage-limit. CANNOT SHOW always lists real cgroup containment,
crash boundaries under real models and week-long reliability. A green fixture does not erase either list. Use branch
labels as checker output, not a promise that every label names a current runtime stage.

## M4a independent adjudication

After the paid run and `node evals/m4a/check.ts <dir>`, run **once**:

```sh
node evals/m4a/adjudicate.ts <dir>
```

It builds a read-only evidence tree from arc 1's verified target/plan/product/witness artifacts and grades R1–R7 without
the answer key. Writes adjudication.json and adjudication/transcript.jsonl; an answer-key transcript hit voids the result.
The lead accepts each finding into a fix/backlog or rejects it with a reason; the raw model verdict does not gate alone.
The driver's real-forge before/after canary separately checks that fixture isolation left the real forge unchanged.

## The M5 fixture

Prerequisites: authenticated Claude CLI (and Codex for the mixed profile), Node 24, the `playwright-mcp` executable and
its installed Chromium. Setup vendors the frontend-design skill with its licences under product `.claude/skills/`;
check verifies those bytes remain unchanged. Product config already declares this MCP command:

```text
playwright-mcp --headless --isolated --browser chromium --output-dir {evidence} --viewport-size {viewport}
```

The executor substitutes the evidence directory/viewport and checks the MCP handshake. The rendering oracle expects
exactly one Chromium installation under `~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`.

```sh
node evals/m5/setup.ts <dir>
node evals/m5/driver.ts <dir> --profile claude-only
node evals/m5/check.ts <dir>
node evals/m5/reflow.ts <product> <sha>
```

M5 drives a real architect session rather than scripting its plan. The plant is a long unbreakable URL in the first
book's condition data; at 320 CSS px it causes horizontal page overflow. `reflow.ts` renders the recorded SHA;
plant-repaired requires a fitting page **and** the planted book/title/URL still present. Plant-caught distinguishes a
resolved finding from prevention before the first walk; upstream prevention is not evidence that the walk caught it.
Run walk-browser and evals-m5-reflow free tests serially on this host.

## Background observer

```text
node evals/observer.ts <fixtureDir> [--backend codex|claude] [--interval-min 10] [--model MODEL] [--max-hours 7] [--host-dir DIR] [--once] [--no-retro]
```

Default backend is a read-only Codex session; Claude uses Read/Glob/Grep only. Each tick collects new journal,
root-transcript and host-log evidence, advances observer/cursor.json and appends observer/observations.jsonl.
Abort/high observations print as `OBSERVER ...` lines; raw tick artifacts are retained under observer/.
At report.json it writes a whole-run observer/retro.md unless --no-retro. --once performs one observation; max-hours
bounds the loop. It reports defects/efficiency opportunities and never acts on the fixture.
