# Role schema / parser audit

All five live roles in `ROLE_VALIDATORS` were audited, including the shared lens, walkthrough,
polish and full-spec readers they invoke. No parser constraint was removed or relaxed. Wire roots
remain plain objects, with discriminated alternatives nested inside properties.

The wire vocabulary follows the [Claude JSON Schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations):
`enum`, `pattern`, `required`, closed objects, nested `anyOf`, and `minItems: 1`. Nonempty strings
use `[\s\S]+`, not the unsupported `minLength`. Path patterns use positive alternatives, not
unsupported lookaround. Small exit-code domains use a numeric enum; safe-integer bounds live in
property descriptions because numeric bounds are unsupported. Uniqueness, tuple-first-element
checks, and facts requiring runtime inputs or files also live in property descriptions.
`role-schema-parity.test.ts` checks the actual wire vocabulary, all parser branches with mutations,
and path-pattern equivalence against the original readers.

## Observed failures and fixes

| Probe item | Root cause | Correction |
| --- | --- | --- |
| `m3.pre-build.validate` / `m3.pre-build` | `finding` at `src/prompts/schemas.ts:319` requires an experiment or evidence containing `:<digits>`. `GATE_FINDING_FIELDS.evidence` previously advertised only an array of arbitrary strings. Saved invocation 47-1 passes the schema and throws `gate.findings[1].evidence: expected an experiment or path:line evidence`. | Describe the experiment-or-line-evidence rule on the finding's evidence property. Preserve the failing output as `verifier-02.json`, explicitly expecting that described repair. |
| `walk.cli.reported` | `experienceWalk` accepts invocation 148-1. `walkRefusals` at `src/walk/report.ts:70` resolves each entire evidence string as a filename. Strings such as `j1-diagnosis.txt: after ...` and an absolute filename followed by commentary do not name saved files. The wire evidence property never stated this requirement. | Every walk evidence property now describes exact existing file paths, containment, relative resolution, and where explanations belong. `experienceVerdict-01.json` must still pass the role reader and fail the production evidence reader. |
| `polish.compare.judged` | `experiencePolish` accepts invocation 267-1. `judgeRefusals` at `src/walk/compare.ts:232` rejects its filename-plus-commentary strings for the same reason. | Same evidence contract, including the permitted original walk directory. `experienceVerdict-02.json` replays the actual production refusal. |
| Both later exit-99 failures | `evals/probe.ts:751` and `:794` intentionally builds through fakes and delegates only the judging call with a `real` act. Each job had only one such step. A legitimate repair resumes through the same PATH shim, exhausts the scenario, and `test/fakes/fake-backend.ts:476` exits 99. This is probe scripting, not production backend misrouting. The fake's current mode/verdict wrapping already matches the flattened schema. | `evals/probe-steps.ts:realJudgeSteps` supplies a fresh and a repair delegation, checking the acting profile and fresh/resume flags. Local stub integration tests prove both reach the delegate with the same session and current schema, without calling an installed backend. Separate tests check both fake mode/verdict shapes. |

## Constraint inventory

Schema symbols below are in `src/prompts/schemas.ts`; `verdict` refers to the nested experience
payload. Required fields, closed object keys, types, nullable branches and discriminators apply
recursively to **every** object and field below (`sObj`, `sNullable`, `sEnum`, `sArr`).
`str` means nonempty; `text` deliberately permits empty strings. No whitespace prohibition is
invented for fields read with `str` or `text`.

| Role / reader | Every enforced constraint | Where it lives now |
| --- | --- | --- |
| All / `premise`, `lineEvidence` | Nonempty claim and file path; integer line in 1..MAX_SAFE_INTEGER; evidence and premises lists may be empty. | `S_PREMISES`, `S_EVIDENCE_LINES`: `S_STR.pattern`, integer type and `S_LINE.description`. |
| Build / `buildOutput`, `experiment` | Nonempty summary, blocker/note entries and experiment name; experiment argv has at least one string (empty arguments allowed); exit integer 0..255. Grounding text and touches may be empty strings. `tooBig` nullable; estimate may be empty, children must be a nonempty list of strings (empty strings allowed). | `BUILD_SCHEMA`: string patterns, `minItems`, `S_TEXT`, numeric `S_EXIT.enum`, nullable objects. |
| Build and experience / final report readers | Final-report reader requires true. The wire protocol also permits false on interim turns, which the runner waits past. | `S_FINAL.description` explicitly states both phases and that the final-report parser rejects false. Three unedited interim replays explicitly expect that parser-boundary rejection. |
| Verifier / `gateOutput` scalar fields | Decision enum; nonempty reasons list and entries; standing id/evidence entries permit empty strings but evidence list must be nonempty; standing disposition enum. | `GATE_FIELDS`: enums, `S_STR`, `S_TEXT`, `minItems: 1`. |
| Verifier / `finding`, `gateExperiment`, `hunkRef` | Severity enum; nullable nonempty path and contractRef; nonempty text, experiment command/output, debt drag; defect enum or null; R-n reraises or null; hunk nullable with nonempty path and safe positive line. Evidence strings may be empty. | `GATE_FINDING_FIELDS`: patterns, enums, nullable branches, `S_TEXT`, `S_LINE.description`; R-n has positive 1..15 decimal digits. |
| Verifier / `finding` evidence rule | At least one experiment OR at least one evidence entry containing colon followed by digits. | `GATE_FINDING_FIELDS.evidence.description`. `contains`/cross-array conditions are outside the supported wire subset. |
| Verifier / `gateOutput` decision relationships | Approve forbids blocking findings. Revise requires nonempty directives; approve/escalate require no directives. Non-null ordering only for escalate. | `severity.description`, `directives.description`, `ordering.description`. Conditions join root properties, so no root union is reintroduced. Directive entries themselves use `S_STR`. |
| Verifier / `orderingWait` | Ordering nullable; blockers nonempty, unique unit slugs. | `GATE_FIELDS.ordering`: nullable object, `minItems: 1`, `S_SLUG.pattern`; blockers uniqueness description. |
| Verifier / `clusterMap`, `clusterEntry`, `rulingList` | Clusters nullable; if present nonempty, unique nonempty cluster ids; nonempty path-pattern list; review enum. Rulings have unique R-n findings, ruling enum and nonempty reasons. | `GATE_FIELDS.clusters`: `minItems`, string/path patterns and description of unique ids; `rulings` patterns/enum and uniqueness description. |
| Verifier / `gateAnswerFor`, `standingRules`, `reviewRules` | Cluster map absent below large-diff threshold, otherwise every changed path in exactly one cluster. Standing responses only to supplied IDs, no duplicates, every standing item answered before approval. Reraises must name this unit's ledger; a blocking settled finding requires a changed anchor blob. Exactly one ruling per supplied dispute, no extras. | `clusters.description`, `standing.description`, `reraises.description`, `rulings.description`. These require captured gate inputs and repository blobs. Delta demotion is a transformation, not an output-parser rejection. |
| Campaign audit / shared `lensOutput` | Finding severity enum; nullable I-n obligation; unique V-n vision clauses; nonempty claim/cause; line evidence as above; mutant nullable with lane identifier and nonempty edits. Mutant paths must be repository-relative or absolute under the checkout; old is nonempty; new may be empty. Nonempty reasons list and entries. | `LENS_SCHEMA`: enums, I/V patterns (positive 1..15 digits), visionClauses uniqueness description, `S_ITEM_ID.pattern`, `minItems`, edit path `anyOf`, nonempty old `S_STR`, replacement `S_TEXT`. |
| Campaign audit / `campaignAuditOutput` requests | `op: request`; summary permits empty text; evidence is nonempty list of strings (empty strings allowed); dismisses null or F-n; counterEvidence null or contains a non-whitespace character; a dismissal requires non-null counterEvidence. | `CAMPAIGN_AUDIT_SCHEMA.requests.items.anyOf` correlates both request variants; patterns, enum, `minItems`, and `S_COUNTER_EVIDENCE.description`. |
| Campaign audit / mutant admission | Mutant lane must exist among arc lanes; path must name a regular file inside the checkout (absolute paths are normalized relative); old must occur exactly once after earlier edits, and new must differ from old. | `LENS_SCHEMA` mutant lane/path/old/new descriptions; actual checks remain in `src/holistic/audit.ts`. Admission refusals are tallied, not silently accepted as proof. |
| Pack review / `packReviewOutput`, `packTarget`, `packDisposition` | Severity enum, nonempty claim, line evidence. Target discriminates unit slug / I-n obligation / T-n census or rule / plan, with exactly the matching keys. Disposition job review-n, safe nonnegative integer index, disposition enum. Nonempty reasons list and entries. | `PACK_REVIEW_SCHEMA`: nested target `anyOf`, patterns, enums, `S_STR`, `minItems`; index bounds description. |
| Pack review / `dispositionProblem` | Exactly one disposition per unresolved delta finding (job,index), no extras or duplicates; empty on a full review. | `PACK_REVIEW_SCHEMA.dispositions.description`; comparison against captured delta stays in `src/holistic/packreview.ts`. |
| Experience / `experienceOutput`, `experienceWalk`, `experiencePolish` | Mode walkthrough or polish; payload must match mode; job-specific reader requires its own mode. | `EXPERIENCE_SCHEMA`: mode enum, verdict nested `anyOf`, mode/verdict descriptions. Actual required mode comes from the invocation inputs. |
| Walk / `walkthroughOutput` journeys | At least one journey, unique J-n IDs; outcome completed/blocked; nonempty note; evidence entries nonempty but list may be empty. A blocked journey needs a breaks finding for that journey. | `WALKTHROUGH_SCHEMA.journeys`: `minItems`, J pattern, enum, `S_STR`; uniqueness and coverage description; outcome description states blocked→breaks rule. |
| Walk / `walkthroughOutput` findings | Class breaks/deviates; J-n journey reported in journeys; nonempty evidence list/strings, claim/cause; unique repository paths. Breaks permits journey/contract/floor; deviates permits design/vision. | `findings.items.anyOf` correlates class with allowed against shapes; patterns and `minItems`; journey membership and paths uniqueness descriptions. |
| Walk / `walkAgainst` | Journey has only type. Contract/design have repository path and nonempty anchor; contract adds nonempty dependents. Floor has nonempty text and repo path or valid V-n source (numeric V- forms interpreted as IDs). Vision has V-n clause. | `WALK_AGAINST_SCHEMAS`, `S_REPO_PATH`, `S_FLOOR_SOURCE`, `S_STR`, nested `anyOf`, closed `sObj` keys. |
| Walk / `walkthroughOutput` proposals | Reported J-n journey; nonempty evidence list/strings and text; unit slug; nonempty unique system slugs; unique unit IDs across proposals; valid full spec. Reasons list may be empty but entries are nonempty. | `polish` and `unit` schemas: patterns/`minItems`/closed objects; journey, unit-id, systems and polish descriptions; `S_FULL_SPEC`; reasons `S_STR`. |
| Walk/compare / `walkRefusals`, `judgeRefusals` | Every cited evidence string must name an actual file contained in allowed evidence directories, relative or absolute; no prose appended. Walk reports exactly the milestone's journeys. Design/contract target inside milestone reference. Vision clause exists and active; floor clause non-negotiable. Proposal ID new to plan; systems cover every reference; spec unit matches proposal and rev is 1. | Every evidence property uses `S_EVIDENCE.description`. Journey coverage, against/source, unit id, systems and spec descriptions state input-dependent rules. Production file/plan/vision checks are unchanged. |
| Full proposal spec / `fullSpec`, `laneFromWire`, `specM1` | Schema literal; unit slug; rev safe positive integer. Nonempty intent, nonGoals list/entries and acceptance list. Stated lane/acceptance/decision/fact states active/struck/deferred; item IDs letter then letters/digits/underscore/dot/hyphen, 1..64 chars; unique across all sections. Clause/note text nonempty. | `S_FULL_SPEC`, `sStated`, `S_ITEM_ID.pattern`, `S_LINE.description`, `S_STR`, `minItems`; cross-section unique IDs stated on lanes. |
| Full spec / lane fields, `laneEnv` | Nonempty argv, argv[0] nonempty, later strings may be empty; cwd repository path; environment names match shell identifier pattern; values may be empty; set names unique, pass names unique and disjoint from set. Exit 0..255; cadence build/unit. Resource slugs unique; evidence globs/excludes repository patterns. | `LANE_ITEM_FIELDS`: `minItems`, argv first-element description, `S_REPO_PATH`, `S_ENV_NAME`, `S_TEXT`, set/pass descriptions, `S_EXIT.enum`, cadence enum, resource patterns/uniqueness and `S_REPO_PATTERN`. |
| Full spec / `specCites`, `specM1` lists | Unique resource slugs, unique repository contract paths, unique C-digits rulings, unique I-n obligations, unique F-n or I-n repairs. Empty obligations/repairs wire arrays become absent canonical spec fields. | `S_FULL_SPEC` list items use matching patterns; each list describes uniqueness. `fullSpec` preserves existing empty-list normalization. |
| Preflight smoke (auxiliary) | Exactly `{ok:true}`. | Existing `SMOKE_SCHEMA`: boolean enum `[true]`, required key and closed object; no mismatch. |

`decisions.json` is an implementer-written sidecar, not a structured backend result. Its reader
requires unique clause IDs and unique disputed R-n findings, with nonempty text/reasons. It is
outside `ROLE_SCHEMAS` and unchanged. Likewise persisted records and root-authored input parsers
are not additional backend role-output schemas.

## Replay and prevention checks

`test/fixtures/real-role-output/index.json` accounts for 94 immutable, sanitized values: build 22,
verifier 50, campaignAudit 14, packReview 6, experienceVerdict 2. Of 91 schema-valid values, 75 pass
the role parser and 16 require a described parser repair (including three intentional interim reports).
Two of those 75 then fail the production evidence-file reader. Overall: 73 accepted, 18 expected
repairs, and three older invocation-style reraises rejected by the current R-n schema. The
index records original event hashes and source labels; no private project data is included.
The replay corpus also checks that every supported prompt/model pair actually sends its role schema.
The two experience cases also exercise the actual production evidence readers. Eight large saved
experiment logs use lossless gzip; no value is truncated or rewritten to reduce fixture size.

`role-schema-parity.test.ts` adds branch-complete synthetic witnesses and destructive mutations
(type, missing/extra field, empty string/list, bounds, IDs, paths, duplicates), allowing only
specifically described remaining rules. A separate test prevents unsupported wire keywords and
root unions. Positive path patterns are checked against the existing readers over thousands of
small strings and edge cases. `probe-steps.test.ts` uses a local stub delegate to prove repair
routing and verifies both fake experience output envelopes. It never invokes an installed CLI.

## Validation scope

All test files ran one at a time (`node --test --test-concurrency=1`) under the supplied
`scratchpad/serial.lock`. No full `npm test`, paid eval, or installed Claude/Codex CLI was invoked.
The existing tests with `real` acts delegate to local stub executables.

| Area | Affected test files |
| --- | --- |
| New regression coverage (120 tests) | `real-role-output.test.ts`, `role-schema-parity.test.ts`, `probe-steps.test.ts` |
| Existing schema / prompt contracts | `m3-schemas.test.ts`, `m4a-schemas.test.ts`, `m4a-rev3-schemas.test.ts`, `m4b-schemas.test.ts`, `dev13-schemas.test.ts`, `dev17-records.test.ts`, `prompts.test.ts`, `design.test.ts` |
| Backend, fake and build/report contracts | `adapter.test.ts`, `argv.test.ts`, `fakes.test.ts`, `fakes-m2.test.ts`, `fakes-m3.test.ts`, `fakes-m4a.test.ts`, `report.test.ts`, `build-rev3.test.ts`, `patchcheck.test.ts` |
| Unit and job integration / recovery | `gate.test.ts`, `review.test.ts`, `rounds.test.ts`, `stages.test.ts`, `stage-m2.test.ts`, `handover.test.ts`, `roles-surface.test.ts`, `agent-surface.test.ts`, `audit.test.ts`, `packreview.test.ts`, `walk.test.ts`, `walk-job.test.ts`, `walk-mcp.test.ts`, `polish-loop.test.ts` |
| Free eval harnesses | `agent-audit-fixes.test.ts`, `paid-fixes.test.ts`, `roles-gate.test.ts`, `roles-gate-exec.test.ts`, `roles-gate-corpus.test.ts`, `roles-walkthrough.test.ts`, `roles-polish.test.ts`, `evals-m4a-harness.test.ts`, `serial/evals-m4a.test.ts` |

Final results: `npm run typecheck` passed. The 43 distinct affected files contain 686 tests; all
passed, with zero failures, cancellations or skips. Validation batches (overlap is deliberate on
focused rechecks after the final edits):

| Run | Files | Tests passed | Failed / skipped |
| --- | ---: | ---: | ---: |
| Main affected batch | 36 | 631 | 0 / 0 |
| Additional direct consumers and report protocol | 5 | 42 | 0 / 0 |
| Build contract | 1 | 8 | 0 / 0 |
| Regression recheck | 3 | 120 | 0 / 0 |
| Final campaign/admission and regression recheck | 11 | 261 | 0 / 0 |

The final campaign recheck includes the five patch/admission tests, bringing the distinct file
count from 42 to 43 and the distinct test count from 681 to 686. All 120 new regression tests
passed again against the final schemas. SVGs parse as XML, and `git diff --check` passed.
