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
