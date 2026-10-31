# P3(b) CI report

Implemented lane inputs/cost/estMin and contextual placement refusals, explicit milestone lane selection, and resource-declaring `spike: {question}` units whose gated reports retire without publication. Inputs filter ls-tree; implicit unit-lane keys use that unit's systems. Expensive local lanes belong at candidate cadence; milestone lanes declare shared-resource or cross-system placement.

Every build/lanes/gate attempt counts, including uncharged and interrupted attempts. `attempt-marker{marker:M4,builds,judged}` fires at 8 builds or 20 judged stages; `attempt-capped` hard-parks at 16/40 and raises blocking `attempt-cap`. P3c can consume `JournalView.ciFacts()` and `attemptCounts()`.

Repeated reds compare diffBase: green charges `regression`, red follows base-red. Fix rounds retain the comparison and its original evidence directory, including cache hits. Diagnostic base runs remain separate from unit failure accounting.

External arc lanes declare `witnessClass: external`. `roadmap witness` binds the submission head, rejects stale/tampered evidence, records file hashes or URLs, replays durably, and reopens the delivering lineage on failure. Capture lanes lease a pool slot, bind its port, contain the dev stack and repo capture script together, require declared PNG states, and hand spec/suite captures to the gate.

Verification complete. Typecheck passed. Non-serial coverage after reruns: 211 files, 2,958 cases (10 new), 2,957 passes and cgroup-real NOT RUN; concurrency 4. Initial run: 2,851 passes, 96 failures, 1 NOT RUN. Locked recheck: 718/719, then corrected rechecks 136/136 and 132/132. Initial `recover/gate` and `residue.recovery-orphan-stays` 90-second timeouts passed unchanged under the lock.

Serial: 10 files, 1,005/1,005; every file ran individually under the shared lock, concurrency 1.

| File | Pass/total |
| --- | ---: |
| pipeline-matrix | 363/363 |
| concurrent-matrix | 498/498 |
| evals-m4a | 23/23 |
| pool-crash | 37/37 |
| probe-crash | 16/16 |
| resource-recover | 62/62 |
| pressure | 1/1 |
| calibrate | 1/1 |
| upgrade | 1/1 |
| walk-browser | 3/3 |

First evals-m4a: 22/23; isolation correctly rejected executor-local verification logs. Logs moved to the worktree root; the complete rerun passed with assertions unchanged. Final coverage: 221 files, 3,962 passes, 1 NOT RUN; no unresolved failures. No full npm test, paid eval, version bump or push.

## Removed-test list

No test case or file was dropped. These obsolete assertions were replaced; all other assertions survive:

- `lanes-rev3 / lanes.inputs-refused-off-spec` and `m4a-rev3-schemas / spec.inputs-dropped`: input refusals become retention assertions. Plan §2: “LaneDef gains `inputs: RepoPattern[]`”. The latter retains its testPaths assertions.
- `spec / a spec lane's systems, test argv and stochastic render beside its evidence`: only the final inputs-refusal assertion changes to parsed/rendered input assertions. Same plan text.
- `systems / cadence is required, tier is refused, and each kind takes its cadences`: unconditional spec-candidate parse refusal becomes contextual refusal plus spike acceptance. Plan §2: “integration lanes refused on unit specs except `spike` units”.
- `status / status.certification`: repeated base-red preserves allowance at 1 instead of spending a second allowance. Plan §2: “red at base → existing base-red.” Other status assertions remain.

## P3b audit fixes

Removed `estMin`; `cost` remains. `batch` is the sole batch/milestone cadence; unit specs take build/unit/candidate cadences. Plain batch suites run at batch points with or without milestones. A milestone additionally selects its shared-resource/cross-system lanes at its node; close-out still runs all batch lanes. Removed fixture defaults that had silently assigned every batch lane to a milestone.

Candidate-cadence spec lanes execute on the candidate built on the current integration tip, retaining spec set, delivering unit, commit and evidence attribution. Their reds feed the delivering unit's fix round. Runtime tests cover a peer tip advance, red/fix/publication, and a selected lane running at its milestone node after its units retire.

A root apply introducing a spike resource is refused and raises a blocking owner request after its durable rejection receipt (replay deduped). Every non-start proposer is refused by the classifier; unit/spec/lane/forced-suite resource use and new environments are covered by the predicate. Capture evidence reaches only milestone design/member gates. The spec and suite capture tests both run the stack and repo script on a leased port, retain both PNG states, check the gate's evidence directory presence/absence, and assert cleanup.

`attemptCapResult` builds the sole attempt-cap park item for the driver and `haltResult`; live, restarted and root-reactivated paths return it identically (no nullable halted-state assumption). `laneFixRound` owns base-comparison text/evidence for live and recovered rounds. Placement is the one integration-placement concept (`kind: capture` remains). The launch env allowlist stays deliberately closed: witness/capture names are executor-generated workload protocol values that must survive launch-file validation; arbitrary ROADMAP names and runner identity variables remain refused. Added protocol preservation/refusal coverage. Replaced inline event type imports with normal imports.

Added test cases: **7** (two candidate runtime cases, one milestone-node case, one owner-escalation case, two additional capture contexts, one launch-protocol case). Removed test cases: **0**. The two original capture cases were expanded into design-cited/non-design contexts; their screenshot, green-certification and cleanup assertions survive. The systems test's obsolete blanket candidate refusal became local-candidate acceptance plus shared-placement refusal, matching adopted atlas2 item (5): “expensive-but-local lanes … run per candidate on the tip (attribution kept)”. The certification allowance fixture now alternates distinct reds so repeated-red base comparison does not bypass the allowance it measures; every existing assertion, including twelve builds, the charging sequence, restart persistence and bound, survives. Plan §2: “Repeated red at lanes: run the lane at diffBase … red at base → existing base-red.” The `rounds.no-escalation` fixture similarly uses distinct initial/next checks of the same add behavior, preserving all three-build, same-seat, resumed-session, red/red/green and charging assertions. No skip was added and no test case was weakened or dropped.

Verification: `npm run typecheck` passed. All 211 non-serial files ran with `node --test --test-concurrency=4 test/*.test.ts`: 2,985 cases, initially 2,980 passes, 4 fixture failures and 1 NOT RUN. The four failures were the two positive capture fixtures' missing port placeholder binding, the allowance fixture and `rounds.no-escalation` described above. Corrected recheck (`ci-efficient`, `certification`, `stage-m2`): **40/40 passed**. Final unique non-serial coverage: **2,984 passes, cgroup-real NOT RUN (read-only cgroup v2), no unresolved failures**. No timing-bound failure occurred in this verification batch.

Reviewing cap reactivation found a nullable halted-state assumption in the first consolidation. The shared constructor now returns a park for a valid root-steered unit that is still over its cap. Initial follow-up recheck: 32/33 (the new fixture incorrectly used `unparked` without a parked decision); corrected to a valid `steered` fact, then **33/33** (`ci-efficient`, `unit-rules`, `steer`), with typecheck passing. Existing assertions remain intact; this adds an assertion to the existing cap case, not another case.

Serial verification: **10 files, 1,005/1,005 passed**, each run individually with `flock` on the requested shared `serial.lock`, `--test-concurrency=1`. No serial failure, cancellation, skip or rerun.

| File | Pass/total |
| --- | ---: |
| pipeline-matrix.test.ts | 363/363 |
| concurrent-matrix.test.ts | 498/498 |
| evals-m4a.test.ts | 23/23 |
| pool-crash.test.ts | 37/37 |
| probe-crash.test.ts | 16/16 |
| resource-recover.test.ts | 62/62 |
| pressure.test.ts | 1/1 |
| calibrate.test.ts | 1/1 |
| upgrade.test.ts | 1/1 |
| walk-browser.test.ts | 3/3 |

Final unique coverage: **221 files, 3,990 cases: 3,989 passes and cgroup-real NOT RUN**. Typecheck passed; no unresolved failures. No full executor `npm test`, paid evals, version bump or push.
