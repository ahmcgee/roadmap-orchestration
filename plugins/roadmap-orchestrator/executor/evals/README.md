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

Each family has setup.ts, driver.ts, check.ts and report.ts. Setup creates a fresh isolated fixture directory. Drivers
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

Gate/experience harnesses have their own parsers for cells, parallelism, cap/trial-cap, rebind, saved summaries and
holdout comparison; use the selected mode's help/source. Live trial-cap estimation can undercount delegated spend; a
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
