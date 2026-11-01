# dev.33 paid ladder diagnosis and dev.34 fixes

Implementation: 0bc529a0 on `cc/paid-fixes`, based on b26c2b90. No push. All diagnosis used saved artifacts; no paid eval/probe/fixture or real Claude/Codex CLI was invoked. Existing tests and grader criteria were preserved. The release versions, including the package lock, advance together to dev.34.

Artifact root: `/tmp/claude-1000/-workspaces-roadmap-orchestration/3acd3311-8eb9-44be-8704-d39a10a293c6/scratchpad/paid` (PAID below).

## 1. Experience output schema and M5

Cause: [schemas.ts](../plugins/roadmap-orchestrator/executor/src/prompts/schemas.ts#L644), dev.33 line 629, exported experience verdict as a bare `anyOf`. The API requires a root object. Both mode branches were individually objects, but the wrapper was not. The saved `out-polishJudge/EC-W-0/compare-1.jsonl` reports `400 tools.6.custom.input_schema.type: Field required`.

Fix: make the shared schema a strict object with required final/mode/verdict fields, retaining mode-specific alternatives and the discriminated TypeScript output union. All other exported output schemas and the smoke schema were inspected; none had this root defect.

New tests: the one backend output-schema invariant checks every exported role/legacy output schema and SMOKE_SCHEMA; another checks that a polish payload cannot masquerade as a walkthrough payload. Existing strict-schema/sample-output tests also pass.

M5 confirmation: runtime events seq 1228–1247 and 1252–1271 show walk-1 and walk-2 abandoned after roughly three seconds each; their CLI output has the same API error. The first milestone reached its walks; later units remained held. The root then waited for intervention with no successful walk. This is not a second executor schema cause.

There are two additional M5 limits: the final campaign audit opened seven findings (one P1), and the **external** `PAID/run-all.sh` runs the driver under `timeout 5h`, while [m5/driver.ts:70](../plugins/roadmap-orchestrator/executor/evals/m5/driver.ts#L70) has a six-hour session deadline and writes its report after cleanup at line 459. The outer timeout killed it before that reporting path; `m5-driver.log` is empty. That script is outside this worktree and was not edited. An owner rerun needs an outer timeout longer than the driver deadline plus cleanup time. Product/audit findings still need normal root adjudication.

Confidence: high that the API rejection is removed; no claim that M5 acceptance or all experience judgments will pass without paid evidence.

## 2. Compare tools probe

Cause: [probe.ts:813](../plugins/roadmap-orchestrator/executor/evals/probe.ts#L813) selected the first arc-backend with role experienceVerdict. After the role merge, that was the earlier canned walkthrough, not compare-1. `PAID/probe.log` incorrectly reports invocation 151#1. Its init even names an old capture cwd and read-only tools. The actual compare is invocation **267#1**: its init has Bash/Edit/Read/Write/Task, bypassPermissions, and the correct compare-1.after cwd.

Fix: select the experience invocation belonging to job compare-1. The tool assertion is unchanged. This CLI/HTTP journey intentionally has no MCP config; browser journeys still use walkthrough.mcp through the existing acting-judge path. Nothing in the signed-off delta removes the acting tool surface: its “Fable judgment” item 1 merges walkthrough and polish into one milestone experience verdict.

Tests: existing argv, dev13-schemas, walk-mcp, polish-loop, roles-polish and agent-surface integration tests cover the acting profile and merged role. The saved init events directly establish the probe's misselection.

Confidence: high; this was a stale selector, not lost tools/config or a stale tools expectation.

## 3. Pre-build directives and trial isolation

Causes: [schemas.ts:284](../plugins/roadmap-orchestrator/executor/src/prompts/schemas.ts#L284) allowed directives for every decision, while gateOutput refused them except with revise. [surface/run.ts:39](../plugins/roadmap-orchestrator/executor/evals/roles/surface/run.ts#L39) previously let that SchemaError escape the whole evaluation.

Fix: decision alternatives now require nonempty directives for revise and empty directives for approve/escalate, and restrict ordering and approval blockers consistently with the parser. Only SchemaError becomes a failed/void trial; unexpected programming errors still throw. Save the answer before grading and include void detail in its row, retaining its cost and continuing subsequent trials. The schema validator checks common fields before alternatives so repairs still receive specific missing-field diagnostics ([adapter.ts:127](../plugins/roadmap-orchestrator/executor/src/backends/adapter.ts#L127)).

New tests: decision/directive matrix against schema and parser, missing-premises diagnostics, and a PATH-isolated fake CLI producing a malformed first trial followed by two successful trials. All three rows and all costs must survive. Existing gate.repair-turn stays unchanged and passes.

Confidence: high for these failures; model reasoning remains unmeasured.

## 4. Verifier isolation, no-read brake and cap

The checkout was correct. Thousands of omitted paths are the deliberately generated size-3000 sweep, not the executor source tree.

Five needle voids: [gate/arc.ts:465](../plugins/roadmap-orchestrator/executor/evals/roles/gate/arc.ts#L465) used witnessLaneArgv, whose wrapper embedded the absolute executor test/fakes/witness-lane.ts path. Judges legitimately read that wrapper, encountered the forbidden path, and sometimes followed it into executor source. This contaminated an otherwise correct trial checkout.

Fix: remove the scripted witness wrapper from corpus trials. The journey lane now runs the planted product's actual vessel-export test using the existing production node-test reporter, with that test's exact id as its witness. Its argv contains no executor path, and its result comes from executable assertions. The forbidden-path scanner remains intact.

Five runaway voids: [gate/arc.ts:239](../plugins/roadmap-orchestrator/executor/evals/roles/gate/arc.ts#L239) counted only Read/Grep as inspection. Saved transcripts show substantive Bash reads and Python/git verification, including the trial reporting 2857 omitted files. Fix: count Bash and Glob inspection alongside Read/Grep; delegation, coverage, load, deadline and cost brakes remain.

Cap: [roles/pool.ts:79](../plugins/roadmap-orchestrator/executor/evals/roles/pool.ts#L79) checks **finished** trial spend before admitting another trial. Four workers may already be in flight. The documented cap therefore permits $27.896 against $20; 39 trials were not started. This is intentional admission control, not a hard live total-spend ceiling. No cap semantics were changed.

New tests drive a real corpus witness through the fake-backed gate pipeline, verify its lane argv contains no repository needle, count shell inspection, and demonstrate in-flight cap overshoot deterministically without spend. Existing role harness/cap/real-process tests pass.

Confidence: high for the observed void causes; no assurance of a zero-void paid run or a hard $20 ceiling.

## 5. Campaign audit clean cell

Cause: [surface/dev.ts:4](../plugins/roadmap-orchestrator/executor/evals/roles/surface/dev.ts#L4). The supplied “clean” test was two bare assert.equal calls with neither assert nor mul imported. Both assertions also allowed the sign-from-first-operand mutant that fails when b is negative. The clean-0 answer explicitly identifies both defects; these are real fixture faults, not new command-center input false positives or schema/grader drift.

Fix: executable imports; assertions for all four sign quadrants and zero; an explicit module package and test command. Artifact files live outside the product checkout, keeping evaluation answers out of its ordinary file listing. The sign cell gets proper imports while retaining its planted wrong implementation and weak positive-only witness. gradeSurface still rejects every finding on clean.

New test runs the clean witness and requires the auditor's exact sign mutant to fail. Existing balanced-cell and strict-grader tests are unchanged.

Confidence: medium-high for eliminating the recorded clean-cell findings; paid auditor stability is unverified.

## 6. Compaction: diagnosed, unresolved

Saved summary: `/var/tmp/compaction-eval/2026-11-01T12-00-03-804Z-3300161/summary.json`, total $30.845755.

- Trial 1 A: honesty fails K-14/B-11 for “nothing” loss. Recall is 13/13; format, trap safety and fidelity pass. The architect argued the footer no longer exists; the key still classifies B-11 as a loss-bearing resolution. This needs semantic reconciliation, not automatic acceptance.
- Trial 2 A: trapSafety reports decision 10 as an unflagged current-slice clause. Fidelity reports K-6 and K-12..14 without matching explicit approval of action/items/replacement. The saved owner narrowed I-52 retirement and said no replacement entry for the debt decisions; the architect's record discusses executor refusals for debt without C-n. This mixes approval/record and fixture-contract issues; no pass is claimed.
- Trial 3 A: format fails because `- Application`/`- No-loss check` bullets occur after Approved. [record.ts:19](../plugins/roadmap-orchestrator/executor/evals/compaction/record.ts#L19) treats continuation lines as part of that field, so its date is no longer exactly YYYY-MM-DD. All A criteria fail on this malformed record. Stage B never finishes: the call returning a result crosses the $30 cap. [driver.ts:55](../plugins/roadmap-orchestrator/executor/evals/compaction/driver.ts#L55) accounts for the returned call then refuses further work; $0.85 overshoot is one completed-call overshoot.
- Trials 1 and 2 B: phase0, rederive, census, ids, markers and rejectedUntouched pass. Effects and rulings fail. Both retain old obligations as explicitly retired with reasons; the oracle demands physical removal and a new replacement obligation. Both also use plain replacement/debt ledger lines; the oracle requires sidecar provenance/supersession metadata. K-8 additionally lacks the fold rationale expected in the corpus.

The stale oracle is concrete: [grade.ts:150](../plugins/roadmap-orchestrator/executor/evals/compaction/grade.ts#L150) identifies replacements by sidecar metadata and line 211 requires compaction sidecar rulings. The signed-off delta's “1. Free the root” CAS/reasons section (lines 7–8) explicitly deletes sidecar validation and replaces authorization with reasons; its Fable item 6 and execution P1 repeat the cut. [preflight/checks.ts:564](../plugins/roadmap-orchestrator/executor/src/preflight/checks.ts#L564) now calls rederive with an empty external reasons map, so keeping a retired disposition's own reason is how these applications passed conservation. The driver prompt also points to removed “Phase 0 Compaction paragraph and step 12” ([driver.ts:104](../plugins/roadmap-orchestrator/executor/evals/compaction/driver.ts#L104)); the architect reported those references absent.

No compaction grader, key or existing test was relaxed. Its free tests still pass because the scripted golden helper manufactures the old sidecars. A schema-2 compaction fixture/oracle migration and resolution of the Stage-A semantic issues remain necessary. Confidence of a paid pass: **low; not fixed**.

## 7. M1 judgment-fresh

Invocation 197#1 is page-id gate attempt 8's repair of invocation **194#1**, not a judgment borrowing another judgment's context. The first output set reraises to pre-build standing id `m1-fixture-15ded3125433/136#1:2`; reraises requires R-n. It was refused, then repaired in the same named session, schema and detached checkout.

The checker at [m1/check.ts:202](../plugins/roadmap-orchestrator/executor/evals/m1/check.ts#L202) formerly rejected all resumes. The binding [DESIGN-1.0.md:93](../DESIGN-1.0.md#L93) and SCHEMAS “Role outputs” explicitly allow one repair of an invalid answer in its own session/schema/cwd. This exception predates this batch (dev.12); the delta did not revoke it. Independent judgments still start fresh.

Fix: the checker allows only that same-parent/role/routing/schema/cwd single-repair association; mismatched argv/session, unnamed sessions, reused fresh session IDs and second repairs fail. Also constrain reraises and dispute ruling IDs to R-n in the backend schema to prevent the original off-schema response.

New test has seven invalid-resume/reuse cases plus a valid fresh-plus-repair case. Existing fresh-gate and repair-turn integration assertions were preserved. Confidence: high for this check and the original ID error.

## Free validation

- `npm run typecheck`: pass.
- Final core rerun: **129/129** (adapter, gate, prompt schemas, surface harness and focused regression files).
- Final real-witness/gate rerun: **26/26**.
- Free real-browser/MCP check: **3/3**, under `flock /tmp/claude-1000/-workspaces-roadmap-orchestration/3acd3311-8eb9-44be-8704-d39a10a293c6/scratchpad/serial.lock`.
- Directly exercised affected files: argv, dev13-schemas, evals-compaction, evals-m1, paid-fixes, prompts, roles-surface, roles-gate, roles-gate-exec, adapter, agent-surface, gate, repair, polish-loop, roles-polish, roles-walkthrough, walk, walk-job, walk-mcp, and serial/walk-browser (all `.test.ts`). The unchanged fake-backed M1 and compaction tests pass. The role execution harness rerun is **6/6**.
- Intermediate failures were corrected without changing existing assertions: the missing-premises repair diagnostic (followed by a full green gate-file rerun), and a new test's use of a nonexistent view.events method (corrected to the canonical holistic witness projection; its final file is green).
- Both flow diagrams parse as XML and retain their white backgrounds; git diff --check passes.

Logs remain locally under `executor/node_modules/.paid-fix-logs/`, outside git.

No full npm test, paid run or real model CLI was used. Serial files run under the owner-specified flock. See the implementation commit for nine new focused regression tests in test/paid-fixes.test.ts.
