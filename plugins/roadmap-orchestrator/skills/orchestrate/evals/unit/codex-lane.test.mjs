// Zero-token control-flow simulation of the CODEX EXECUTOR LANE.
//
// Codex (the OpenAI CLI) is THE implementer — there is no Claude implementation lane. A unit's
// whole implement→test→fix inner loop is one background `codex exec` in the unit worktree, driven
// by a cheap Haiku steering agent that launches it, polls, verifies the work ON DISK, and copies
// the schema-constrained final message into an S.impl-shaped report. S.impl is the seam: verify,
// gates, consults, merge and every trigger work untouched, and nothing downstream learns who
// wrote the code.
//
// What this file locks, and why each one is here rather than left to a paid run:
//   1. LANE SHAPE — the new labels fire, the removed ones (impl:/review:/debt-fix:) do not, and
//      the Claude judgment surfaces (verify/gates/merge) are untouched.
//   2. INVOCATION SHAPE — every CLI fact the steering prompt asserts is pinned by
//      evals/codex-probe.sh (P1). A silent drift here (a lost `--output-schema`, a sandbox
//      widened to `-a never`/`--dangerously-bypass`) is a class of failure that costs a paid arc
//      to find and can write outside the unit worktree while it does.
//   3. DETERMINISM — a steering prompt that leaks a session id or a timestamp breaks
//      resumeFromRunId replay. Two identical drives must produce byte-identical prompts.
//   4. HALT SEMANTICS — the probe (auth gone) and any limitHit PARK, never quarantine, and the
//      conductor early-returns to the root BEFORE spending anything on a census.
//   5. BRIEF HYGIENE — the embedded brief and its `--output-schema` are held to the same bar as
//      every Claude prompt (hygiene-lib.mjs), plus OpenAI strict mode's every-key-required rule.
//   6. THE JUDGMENT SHIFT the lane paid for — the cross-model spec critique threaded into the
//      plan-check, the plan-check's med/high-risk flip to Fable, and the pinned-scope machinery
//      (envelope, scope-growth degradation, gate creep clause, directive cap) that only became
//      observable once S.verify started requiring `diffFiles`.
//
// Same contract as harness.test.mjs: the UNMODIFIED harness is the source of truth. A red here is
// a fake/assumption bug until proven otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import { makeAgent, makeWorkflow, packRules, BASE_SHA, implCodexOk, codexMetaOk, codexRoleOk, codexRoleDead, reviewDigestOk,
  courierSaying, courierOk, courierResult } from './fakes.mjs'
import { capsOf, statesBudgetFor } from './hygiene-lib.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
const CONDUCTOR = fileURLToPath(new URL('../../conductor.mjs', import.meta.url))
const HARNESS_PATH = '/abs/path/to/harness.mjs'

// ---- fixtures ---------------------------------------------------------------------------
const WT = '/wt'
const makePlan = (units, edges = [], extra = {}) => ({ repoPath: '/repo', worktreeRoot: WT, units, edges, ...extra })
const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/session-codex', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})
async function runWave(agentFn, plan, state, config = {}) {
  const runner = await loadScript(HARNESS)
  return runner({ args: { plan, state, config: { gateAuditRate: 0, ...config } }, agent: agentFn })
}

const has = (calls, prefix) => calls.some((c) => c.label === prefix || c.label.startsWith(prefix))
const promptOf = (calls, label) => calls.find((c) => c.label === label)?.prompt ?? ''
const labels = (calls) => calls.map((c) => c.label)

// S.verify REQUIRES diffFiles (the objective input to envelope pinning + the scope-growth check).
const VERIFY_OK = { pass: true, blocked: false, failures: [], lanes: [{ command: 'npm run test:ci', exitCode: 0 }], contractSurfaceTouched: false, diffFiles: [] }
const VERIFY_FAIL = (failures = ['assert: expected 1, got 2']) =>
  ({ pass: false, blocked: false, failures, lanes: [{ command: 'npm run test:ci', exitCode: 1 }], contractSurfaceTouched: false, diffFiles: [] })
// There is no review stage: the ONLY route into the polish loop's fix step is a failing verify.
const failThenPass = () => { let n = 0; return () => (n++ === 0 ? VERIFY_FAIL() : VERIFY_OK) }
// A codex run that died with nothing on the branch — the one shape that earns the fresh retry.
const deadRun = () => ({ ...implCodexOk(), codex: { ...codexMetaOk(), exitCode: 1, commits: 0, doneMarker: false } })

// =========================================================================================
// a. Lane shape. The default one-unit plan must probe once, build through the steering agent,
//    and keep every Claude judgment surface — while emitting none of the removed labels.
// =========================================================================================
test('a lane shape: probe + codex-build replace the Claude implementation lane entirely', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(has(calls, 'codex-probe:w1'), 'every wave probes codex availability before dispatch')
  assert.ok(has(calls, 'codex-build:a'), 'the unit is built by a steering-driven codex run')
  for (const gone of ['impl:', 'review:', 'debt-fix:', 'fix:', 'gate-fix:', 'opus-gate-fix:', 'chain-impl:'])
    assert.ok(!has(calls, gone), `${gone} is a removed label and must never be emitted again`)

  // Judgment stays Claude-side and unchanged.
  assert.ok(has(calls, 'verify:a#0'), 'the mechanical verify still runs')
  assert.ok(has(calls, 'opus-gate:a#0'), 'the Opus-first exit gate still runs')
  assert.ok(has(calls, 'merge:a'), 'the serial merge queue still runs')
  assert.equal(state.units.a.status, 'merged')

  // The probe is a cheap Haiku read; the steering agent is cheap too — the expensive tier never
  // touches the implementation lane any more.
  assert.equal(calls.find((c) => c.label === 'codex-probe:w1').model, 'haiku')
  assert.equal(calls.find((c) => c.label === 'codex-build:a').model, 'haiku')
  assert.equal(state.codex.available, true, 'a green probe records availability in the wave state')
  assert.equal(state.codex.probed, 1)
  assert.equal(state.halt, undefined, 'nothing halted')
})

// Rounds counters are the measurable ceiling on runaway revision loops (the paid fixtures assert
// on them), and they must survive onto the TERMINAL record — start() replaces the running record
// wholesale, so a missing carry-over silently zeroes the arc's only revision telemetry.
test('a2 rounds counters accumulate and survive onto the terminal record', async () => {
  const { fn } = makeAgent([{ match: /^verify:a/, result: failThenPass() }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.deepEqual(state.units.a.rounds, { fix: 1, opusGate: 1, gate: 0 })
  assert.equal(state.units.a.status, 'merged', 'the tally rides a terminal record, not only a running one')
})

// =========================================================================================
// b. Steering-prompt mechanics. Every fact below is pinned by evals/codex-probe.sh; the ones
//    that are ABSENT matter as much as the ones present — `-a`/`--dangerously-bypass` would
//    remove the approval-free sandbox's only remaining boundary, and exec has no approval
//    prompts anyway, so widening buys nothing and risks writes into sibling worktrees.
// =========================================================================================
test('b steering prompt: the pinned codex invocation shape, and the flags that must NOT appear', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())
  const p = promptOf(calls, 'codex-build:a')
  assert.ok(p, 'the build steering call fired')

  for (const required of [
    'setsid',                 // process-group leader, so the deadline kill can take the whole tree
    "sh -c 'echo $$ > ",      // …and the pid recorded is the DETACHED SHELL'S OWN, written as its
                              //   first act. `… & echo $! > codex.pid` named the fork setsid makes
                              //   under job control — dead within a second, so every liveness check
                              //   in this prompt was reading a corpse (2026-09-02, 3 waves lost).
    'trap "kill -TERM $CPID; T=1" TERM;',   // `timeout` sits in its own process group, so a group
                                            //   kill reaches this sh and stops unless the sh
                                            //   forwards it on — and records that it did
    'wait $CPID; RC=$?; if [ -n "$T" ]; then wait $CPID; RC=$?; fi;',  // re-wait ONLY on the trap's
                                       //   own flag: a trap-interrupted wait has not reaped the
                                       //   child, but a SIGKILLed one HAS, and re-waiting a reaped
                                       //   pid reports whatever the shell remembers — which an
                                       //   `RC > 128` test cannot tell apart from the real thing
    '--json',                 // events.jsonl is the only machine-readable channel
    '-o ',                    // the final message lands in a file, never in the steering context
    '--output-schema',        // the report is schema-constrained at the codex end too
    '-C ',                    // run IN the unit worktree
    '-s danger-full-access',  // the sandbox mode, pinned. NOT a relaxation for convenience:
                              //   bubblewrap needs an unprivileged user namespace, and where the
                              //   container blocks that syscall `workspace-write` builds no
                              //   sandbox and enforces nothing SILENTLY (probe-observed: a write
                              //   outside the worktree succeeded) while still failing every
                              //   apply_patch verification. See RATIONALE's P1.7 note. Flip this
                              //   back with the config wherever namespaces actually work.
    'tail --pid',             // sleep-free polling (a bare sleep loop burns steering turns)
  ]) assert.ok(p.includes(required), `the steering prompt must pin \`${required}\``)
  assert.ok(!p.includes('echo $! >'),
    'and NEVER `echo $! >` after the `&` — the pid that recorded was dead before the first poll')

  // Artifacts live OUTSIDE the repo, under the worktree root — structurally invisible to the
  // NOROADMAP write-bar and to the merge fence.
  assert.ok(p.includes(`${WT}/__codex`), 'the artifact dir is ${worktreeRoot}/__codex, outside every tracked tree')
  assert.ok(!/__codex[^\s`]*\.roadmap/.test(p), 'no artifact path is ever routed through .roadmap/')

  // Sandbox-widening flags. `-a` is checked as a token so a word like "-analysis" cannot mask it;
  // the brief legitimately discusses .roadmap contracts, so only the ARTIFACT paths are policed.
  // The sandbox MODE is a measured environment decision (above), but these two are not: they widen
  // risk without buying anything back, in any environment.
  assert.ok(!p.includes('--dangerously-bypass'), 'never the bypass flag — the mode is set explicitly by -s')
  assert.ok(!/(^|\s)-a(\s|=)/.test(p), 'no approval-policy flag: exec has no approval prompts, so `-a` only widens risk')

  // The brief is delivered by file, not by argv, and the steering agent is told never to read the
  // transcript — that read-back discipline IS the economics of the lane.
  assert.ok(p.includes('<<<BRIEF>>>'), 'the brief is delimited for a verbatim file write')
  assert.ok(/never open .*events\.jsonl whole/.test(p), 'the full transcript is never loaded into the steering context')
})

// =========================================================================================
// b2. session-id capture. Fixture wf_26d28b9e-4ed: add-divide's build dir had a thread.started
//    line in events.jsonl but no session-id file — the steerer (Haiku) skipped the read-back
//    instruction that used to be the only place this got written, and COMMAND R's resume silently
//    fell back to a fresh session. The launch line now captures it itself: codex is backgrounded
//    and raced by a bounded loop, in the SAME sh -c, that greps events.jsonl for thread_id and
//    writes session-id the moment it appears — a closed command, not a step the steerer can skip.
// =========================================================================================
test('b2 session-id capture: the launch line races codex with a bounded thread_id watcher, never the steerer', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())
  const p = promptOf(calls, 'codex-build:a')
  assert.ok(p, 'the build steering call fired')

  const dir = `${WT}/__codex/a/w1/build`
  assert.ok(p.includes('CPID=$!'), 'codex is backgrounded so the watcher loop can race it')
  assert.ok(p.includes('wait $CPID'), 'the script still waits on codex for the real exit code')
  assert.ok(
    p.includes(`grep -m1 -o "\\"thread_id\\":\\"[^\\"]*\\"" ${dir}/events.jsonl`),
    'the launch line greps events.jsonl for thread_id'
  )
  assert.ok(p.includes(`cut -d\\" -f4 > ${dir}/session-id`), 'a match is written to session-id, bare id only')
  assert.ok(/\[ ! -s \S*\/session-id \]/.test(p), 'the loop stops once session-id is already non-empty')

  // The steerer is never asked to write session-id itself — that used to be a step-5 read-back
  // instruction, and Haiku skipped it once (the fixture above). One canonical capture point.
  assert.ok(!p.includes('write the bare id to'), 'the steerer prompt no longer instructs the model to write session-id')
  assert.equal((p.match(/thread_id/g) ?? []).length, 1, 'thread_id is read in exactly one place: the launch line')
})

// =========================================================================================
// c. Determinism. Prompts are deterministic functions of unit ids and shas so resumeFromRunId
//    can replay completed calls from the journal. A session id, a timestamp or a counter leaking
//    into a prompt breaks replay silently — the second run just re-does paid work.
// =========================================================================================
test('c determinism: two identical drives emit byte-identical prompts per label', async () => {
  const drive = async () => {
    const { fn, calls } = makeAgent([{ match: /^verify:a/, result: failThenPass() }])
    await runWave(fn, makePlan([unit('a')]), makeState())
    return calls.map((c) => `${c.label} :: ${c.model} :: ${c.effort} :: ${c.prompt}`)
  }
  const first = await drive()
  const second = await drive()
  assert.ok(first.some((s) => s.startsWith('codex-build:a ')), 'the drive actually reached the codex lane')
  assert.ok(first.some((s) => s.startsWith('codex-fix:a#0 ')), 'and its resume-carrying fix round')
  assert.deepEqual(second, first, 'a codex prompt leaked non-deterministic state (session id / timestamp / counter)')
})

// =========================================================================================
// d. Probe failure halts the wave BEFORE dispatch. Auth expires between waves (ChatGPT-plan
//    OAuth) and re-auth is a human act the harness never attempts. Units must stay PENDING —
//    quarantining a unit because the operator's login lapsed would destroy plannable work.
// =========================================================================================
test('d probe failure: nothing dispatches, units stay pending, the wave halts resumably', async () => {
  const { fn, calls } = makeAgent([{ match: /^codex-probe:/, result: { ok: false, detail: 'not logged in' } }])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())

  assert.ok(!has(calls, 'codex-build:'), 'no codex dispatch after a failed probe')
  assert.ok(!has(calls, 'setup:'), 'ready() gates on the halt, so not even a worktree is built')
  assert.equal(state.units.a.status, 'pending', 'a lapsed login is not a unit defect — never quarantine')
  assert.equal(state.units.b.status, 'pending')
  assert.equal(state.halt.reason, 'codex-unavailable')
  assert.equal(state.halt.codex, 'codex-unavailable')
  assert.equal(state.codex.available, false)

  const d = state.degradations.find((x) => x.kind === 'codex-unavailable')
  assert.ok(d, 'the halt is a loud, operator-actionable degradation')
  // A courier that never reported has told us nothing about the BACKEND — only that the probe
  // itself did not run — so the remedy stays the credential one. Reading a missing smoke exit
  // code as an outage would park an operator in front of a provider that is perfectly healthy.
  assert.ok(/codex login/.test(d.what), 'and it names the exact remedy the human has to perform')
  assert.equal(state.boundary, undefined, 'boundary spend against a halted wave buys nothing the relaunch will not')
})

// The 2026-09-03 backend outage: `codex --version` and `codex login status` both passed and the
// wave ran anyway, on a backend that 404'd every single run. The probe's third command is a real
// bounded `codex exec`, and its pass test is its EXIT CODE — so a live CLI with a live credential
// in front of a dead service halts the wave here, before a single unit is dispatched.
test('d2 probe smoke: a dead BACKEND halts before dispatch, exactly as a dead CLI does', async () => {
  const { fn, calls } = makeAgent([{ match: /^codex-probe:/, result: (p) => {
    // Commands 1 and 2 pass exactly as they did on the day; only the smoke fails, non-zero.
    const r = courierResult(p, BASE_SHA)
    return { ok: true, results: [r.results[0], r.results[1], { exitCode: 1,
      stdout: 'ERROR: turn.failed: unexpected status 404 Not Found: chatgpt.com/backend-api/codex/responses' }] }
  } }])
  const state = await runWave(fn, makePlan([unit('a'), unit('b')]), makeState())

  assert.equal(state.halt.codex, 'codex-unavailable', 'a backend that cannot answer is codex being unavailable')
  assert.equal(state.codex.available, false)
  assert.equal(state.units.a.status, 'pending', 'a provider outage is not a unit defect')
  assert.equal(state.units.b.status, 'pending')
  assert.ok(!has(calls, 'codex-build:'), 'nothing is dispatched onto a dead backend')
  assert.ok(!(state.degradations ?? []).some((d) => d.kind === 'codex-exec'),
    'and there are no codex-exec rows at all — the 23 of them are the incident this prevents')
  const rows = (state.degradations ?? []).filter((d) => d.kind === 'codex-unavailable')
  assert.equal(rows.length, 1, 'one row, naming which of the three probe commands failed')
  assert.match(rows[0].what, /backend\/exec smoke failed/)
  assert.match(rows[0].what, /Codex BACKEND/, 'and the operator is told to wait, not to re-login')
})

// 2026-09-15: codex exits 0 when its sandbox cannot start — the bwrap error is its final MESSAGE —
// so the smoke now makes codex run `pwd` and the shell checks the answer. A failure whose verbatim
// output carries the bwrap line is a HOST fact with its own fix, never a provider outage to wait out.
test('d3 probe smoke: a sandbox that cannot start halts as codex-unavailable and names the SANDBOX fix', async () => {
  const { fn } = makeAgent([{ match: /^codex-probe:/, result: (p) => {
    const r = courierResult(p, BASE_SHA)
    return { ok: true, results: [r.results[0], r.results[1], { exitCode: 1,
      stdout: 'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.' }] }
  } }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState(), { codexSandbox: 'workspace-write' })
  assert.equal(state.halt.codex, 'codex-unavailable')
  assert.equal(state.units.a.status, 'pending', 'parked, not judged')
  const row = (state.degradations ?? []).find((d) => d.kind === 'codex-unavailable')
  assert.match(row.what, /Codex SANDBOX cannot start/, 'the third why: the host, not the provider')
  assert.match(row.what, /-s workspace-write/, 'naming the flag it failed under')
  assert.match(row.what, /danger-full-access[\s\S]*bypass-permissions/, 'and the two-part fix')
  assert.ok(!/Wait out the outage/.test(row.what), 'never sends the operator to wait out a provider that is fine')
})

// =========================================================================================
// e. Dead-on-arrival runs. A codex run that exits non-zero with NOTHING on the branch earns one
//    fresh retry (the branch, not the report, is the deliverable). Past that the ordinary
//    commit-probe/quarantine path rules — there is no Claude implementer to fall back to.
// =========================================================================================
test('e no-commit failure: exactly one fresh retry, and the unit merges when the retry lands', async () => {
  const { fn, calls } = makeAgent([{ match: /^codex-build:a$/, result: () => deadRun() }])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(has(calls, 'codex-build-retry:a'), 'exit!=0 with zero commits earns one fresh retry')
  assert.equal(calls.filter((c) => c.label.startsWith('codex-build-retry:')).length, 1, 'exactly one — never a loop')
  assert.equal(state.units.a.status, 'merged', 'the retry landed, so the unit proceeds normally')
  assert.ok(state.degradations.some((d) => d.kind === 'codex-exec' && /no commits survive/.test(d.what)),
    'the dead first run is ledgered with the artifact dir to read')
})

test('e2 no-commit failure: a retry that reports nothing over an empty branch quarantines', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => deadRun() },
    { match: /^codex-build-retry:a/, result: () => { throw new Error('steering agent died') } },
    { match: /^commit-probe:a$/, result: courierSaying([[/rev-list --count/, '0']]) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(has(calls, 'commit-probe:a'), 'the BRANCH is asked before assuming the worst')
  assert.equal(state.units.a.status, 'quarantined')
  assert.match(state.units.a.reason, /neither a report nor a commit/)
  assert.ok(has(calls, 'dossier-write:a'), 'a quarantine still writes its redesign dossier')
  assert.ok(!has(calls, 'verify:a#0'), 'nothing was built, so nothing is verified')
})

test('e3 a run that exits non-zero but COMMITTED is judged on its merits, never retried', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...implCodexOk(), codex: { ...codexMetaOk(), exitCode: 1, commits: 2 } }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.ok(!has(calls, 'codex-build-retry:'), 'commits on the branch mean there is work to judge — no retry')
  assert.equal(state.units.a.status, 'merged')
  assert.ok(state.degradations.some((d) => d.kind === 'codex-exec' && /2 commit\(s\) survive/.test(d.what)))
})

// =========================================================================================
// f. Usage limit observed mid-wave. One OpenAI account sits behind every run, so a limit is
//    arc-wide, not unit-wide: no NEW dispatch this wave, but a unit already past its build is
//    NOT thrown away — it rides the rest of the (Claude) pipeline to its natural end.
// =========================================================================================
test('f limitHit: halts new dispatch mid-wave; the in-flight unit finishes, the next never starts', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-build:a$/, result: () => ({ ...implCodexOk(), codex: { ...codexMetaOk(), limitHit: true } }) },
  ])
  // A contract edge keeps b behind a's merge, so the halt is observed BEFORE b is ever ready;
  // warmLanes:false keeps the two units on the cold path (a chain would be one codex session).
  const state = await runWave(fn, makePlan([unit('a'), unit('b')],
    [{ from: 'a', to: 'b', type: 'semantic', mode: 'contract' }]), makeState(), { warmLanes: false })

  assert.equal(state.halt.reason, 'codex-usage-limit')
  assert.equal(state.halt.codex, 'codex-usage-limit')
  assert.equal(state.codex.available, false)
  assert.ok(state.degradations.some((d) => d.kind === 'codex-usage-limit'), 'the limit is ledgered for the root')

  // CHANGED CONTRACT (0.14.0): the unit that observed the limit no longer rides to completion.
  // VERIFY is a codex role now, so with codex halted there is no way to check the branch, and
  // nothing may be gated or merged on evidence that was never gathered. It PARKS instead — commits
  // intact, adopted next wave — which is the same answer every other halted codex step gives.
  assert.equal(state.units.a.status, 'pending', 'the unit whose next step is codex parks; it is never discarded')
  assert.equal(state.units.a.parked, true)
  assert.match(state.units.a.note, /codex-usage-limit/, 'and the note names the halt that stopped it')
  assert.equal(state.units.b.status, 'pending', 'ready() gates on the halt — b is never dispatched')
  assert.ok(!has(calls, 'codex-build:b'), 'and it certainly never reaches codex')
  assert.ok(!has(calls, 'setup:b'))
  assert.equal(state.boundary, undefined, 'a halted wave skips the boundary — the relaunch pays for it instead')
})

test('f2 a unit that still needs a codex step after the halt PARKS (pending + parked), never quarantines', async () => {
  const { fn, calls } = makeAgent([
    // a's build reports a limit AND its verify fails, so the polish loop reaches for a fix step
    // that can no longer be dispatched.
    { match: /^codex-build:a$/, result: () => ({ ...implCodexOk(), codex: { ...codexMetaOk(), limitHit: true } }) },
    { match: /^verify:a/, result: () => VERIFY_FAIL() },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(!has(calls, 'codex-fix:a#0'), 'the halt is checked before the fix step dispatches')
  assert.equal(state.units.a.status, 'pending', 'a parked unit is pending, not quarantined')
  assert.equal(state.units.a.parked, true, '`parked` is what makes next wave\'s setup ADOPT its commits')
  assert.match(state.units.a.note, /codex-usage-limit/, 'the note names the halt so the record explains itself')
})

// =========================================================================================
// g. Fix rounds resume the build session in place — P1-pinned: a resumed session still holds the
//    original brief's constraints. Two rules the prompts must obey:
//    - the session id is read from the FILE at run time (`$(cat <buildDir>/session-id)`); a
//      literal id in the prompt would be non-deterministic and break replay;
//    - the LAST gate round runs `fresh` — a session that has already failed a gate twice is
//      anchored on its own approach, so the final attempt starts cold with the full directive set.
// =========================================================================================
test('g fix rounds: resume by session-id FILE, and the last gate round starts cold', async () => {
  const { fn, calls } = makeAgent([
    { match: /^verify:a/, result: failThenPass() },
    { match: /^gate:a/, result: { verdict: 'revise', directives: [{ what: 'tighten the seam', why: 'it leaks' }], debt: [] } },
  ])
  await runWave(fn, makePlan([unit('a')]), makeState(), { exitGate: 'always-fable' })

  const buildDir = `${WT}/__codex/a/w1/build`
  for (const label of ['codex-fix:a#0', 'codex-gate-fix:a#0']) {
    const p = promptOf(calls, label)
    assert.ok(p, `${label} fired`)
    assert.ok(p.includes('codex exec resume'), `${label} offers the resume path`)
    assert.ok(p.includes(`$(cat ${buildDir}/session-id)`), `${label} reads the session id from disk, never a literal`)
    assert.ok(p.includes(`[ -f ${buildDir}/session-id ]`), `${label} guards the resume on the file existing`)
    assert.ok(p.includes(`"$(cat ${buildDir}/cwd)" = "${WT}/a"`), `${label} refuses to resume into a different checkout`)
    // Arc-observed: a resume collided with a live session ("thread already has a…") and died at
    // once — a transient. The steering prompt carries a retry-then-cold rule for exactly that.
    assert.ok(p.includes(`grep -qi 'thread already'`), `${label} carries the resume-collision retry rule`)
    assert.ok(p.includes('relaunch COMMAND R once') && p.includes('launch COMMAND F instead'),
      `${label} retries the resume once, then falls back to a cold session`)
  }

  // maxGateRounds defaults to 2, so g === 1 is the last round: no resume conditional at all.
  const last = promptOf(calls, 'codex-gate-fix:a#1')
  assert.ok(last, 'the second gate round fired')
  assert.ok(!last.includes('codex exec resume'), 'the LAST gate round starts a fresh session, not a resume')
  assert.ok(!last.includes('COMMAND R'), 'and therefore carries no resume branch at all')
  assert.ok(!last.includes("grep -qi 'thread already'"), 'nor the resume-collision rule')
  assert.ok(last.includes('use this launch command'), 'it takes the plain exec launch')
})

// =========================================================================================
// i. Brief hygiene. The embedded brief is a prompt for a model on the other side of a process
//    boundary, so it earns the same bar as every Claude prompt: a cap the model is never told
//    about is a trap. Plus OpenAI strict mode (P1-pinned): the --output-schema must list EVERY
//    property as required at every level, or the turn 400s with invalid_json_schema.
// =========================================================================================
// The steering prompt writes the schema with `... one-line JSON: {…}\n`. Pull it back out the
// same way the steering agent would read it — if the emitted text ever stops being one line of
// parseable JSON, that alone is the defect.
function schemaAndBriefOf(prompt) {
  const marker = 'exactly this one-line JSON: '
  const at = prompt.indexOf(marker)
  assert.notEqual(at, -1, 'the steering prompt no longer emits an inline --output-schema')
  const start = at + marker.length
  const end = prompt.indexOf('\n', start)
  assert.notEqual(end, -1, 'the schema is not terminated by a newline — it is no longer ONE line')
  const raw = prompt.slice(start, end)
  const open = prompt.indexOf('<<<BRIEF>>>')
  const close = prompt.lastIndexOf('<<<BRIEF>>>')
  assert.ok(open !== -1 && close > open, 'the brief markers are missing or unpaired')
  return { raw, schema: JSON.parse(raw), brief: prompt.slice(open + '<<<BRIEF>>>'.length, close) }
}

// OpenAI strict mode: `required` must list every key in `properties`, at every level.
function strictViolations(schema, path = 'root', out = []) {
  if (!schema || typeof schema !== 'object') return out
  if (schema.properties) {
    const props = Object.keys(schema.properties)
    const req = Array.isArray(schema.required) ? schema.required : []
    const missing = props.filter((k) => !req.includes(k))
    if (missing.length) out.push(`${path}: required omits ${missing.join(', ')}`)
    for (const [k, v] of Object.entries(schema.properties)) strictViolations(v, `${path}.${k}`, out)
  }
  if (schema.items) strictViolations(schema.items, `${path}[]`, out)
  return out
}

test('i brief hygiene: the output schema round-trips, is strict-mode legal, and every cap is budgeted', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())

  const { schema, brief } = schemaAndBriefOf(promptOf(calls, 'codex-build:a'))

  assert.deepEqual(strictViolations(schema), [],
    'OpenAI strict mode requires every property listed in `required` at every level — a violation ' +
      '400s with invalid_json_schema and the whole run dies')

  // Same policy as assertBudgetsAreStated: top-level caps must be budgeted in the prose the model
  // actually reads (the BRIEF, not the steering wrapper); nested []-item caps ride the generic
  // clause instead of bloating the brief with every leaf.
  const caps = capsOf(schema)
  assert.ok(caps.length > 0, 'the schema carries no caps — this check would be vacuous')
  const unbudgeted = caps
    .filter((c) => !c.path.includes('[]') && !statesBudgetFor(brief, c.name))
    .map((c) => `${c.name} (maxLength ${c.max})`)
  assert.deepEqual([...new Set(unbudgeted)].sort(), [],
    'the embedded brief drives a capped field without stating its budget. Codex cannot respect a ' +
      'limit it is never told, and an over-long final message is a lost run.')
})

test('i2 the brief carries the guardrails that must survive a half-read: scope, .roadmap bar, escalation', async () => {
  const { fn, calls } = makeAgent([
    { match: /^plan:a$/, result: () => ({ approach: 'x', files: ['src/pinned.js'], testPlan: 'x', feasible: true }) },
  ])
  await runWave(fn, makePlan([unit('a')]), makeState())
  const { brief } = schemaAndBriefOf(promptOf(calls, 'codex-build:a'))

  assert.ok(brief.includes('src/pinned.js'), 'the pinned scope envelope is INLINED, not referenced by path')
  assert.ok(/Scope is fixed before you start and does not grow/.test(brief), 'and stated as a fixed envelope')
  assert.ok(brief.includes('/repo/.roadmap/'), 'the .roadmap write-bar names the directory it protects')
  assert.ok(/# ESCALATION/.test(brief), 'the stop contract is inlined too — it is a guardrail, not a reference')
  assert.ok(brief.includes('DONE a'), 'the disk-checked done marker is the brief\'s own, keyed on the unit id')
})

// =========================================================================================
// Cross-model spec critique. A short read-only-by-brief `codex exec` interrogates the spec + plan from the
// OTHER model family's perspective BEFORE the plan-check adjudicates — GPT and Claude miss
// different things, and the pre-dispatch gate is the highest-leverage judgment point in this lane.
// The plan-check gets the questions as INPUT, never as verdicts, and the pass gates nothing.
// =========================================================================================
test('l spec critique: questions and risks thread into the plan-check as adjudication input', async () => {
  const Q = 'CRITIQUE_QUESTION_MARKER'
  const R = 'CRITIQUE_RISK_MARKER'
  const { fn, calls } = makeAgent([
    { match: /^codex-spec-review:a$/, result: () => codexRoleOk({ questions: [Q], risks: [R], notes: '' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  const review = calls.find((c) => c.label === 'codex-spec-review:a')
  assert.ok(review, 'the critique fires on a fresh build whose risk is in planCheckRisk')
  assert.equal(review.model, 'haiku', 'it is steered at codexSteerModel like every other codex step')
  // It reaches Codex through the ROLE ADAPTER, not a bespoke path: the courier's schema is the
  // adapter's envelope (the caller's S.critique nested under `result`), never S.critique itself.
  assert.deepEqual(Object.keys(review.schema.properties), ['ok', 'codex', 'result', 'notes'],
    'the critique rides run(..., {model:"codex"}) — its courier reports the adapter envelope')
  assert.deepEqual(Object.keys(review.schema.properties.result.properties), ['questions', 'risks', 'notes'],
    'and the caller\'s own schema is what codex is held to, nested verbatim under `result`')
  // Sandbox: NOT `-s read-only` — that needs the bwrap namespace this devcontainer cannot build
  // (arc-observed EPERM while reading the spec). It runs under C.codexSandbox like the build lane;
  // "change nothing" is carried by the brief text.
  assert.ok(review.prompt.includes('-s danger-full-access'), 'the critique honours codexSandbox like the build lane')
  assert.ok(!review.prompt.includes('-s read-only'), 'and never hardcodes the read-only sandbox')
  assert.ok(review.prompt.includes('change nothing'), 'read-only intent lives in the brief')
  // Location: STRICT makes the steerer cd to the first path named; that must be the unit worktree,
  // and the __codex artifact dir must be marked as scratch (arc-observed: Haiku cd'd to wtRoot and
  // refused because it "is not a git repository").
  const cdIdx = review.prompt.indexOf(`Your cd target is ${WT}/a —`)
  assert.ok(cdIdx >= 0 && cdIdx < review.prompt.indexOf('__codex/roles/w1/codex-spec-review-a'),
    'the worktree is named as the cd target before the artifact dir')
  assert.ok(/scratch artifact directory, NOT a git checkout/.test(review.prompt), 'the artifact dir is marked scratch')
  // Schema hard-cut: an entry truncated at its cap is a valid entry (arc-observed: Haiku reported
  // ok:false and the critique was thrown away).
  assert.ok(/cut off\s+mid-sentence at its cap is still a valid entry/.test(review.prompt) &&
    /truncation is never a failure/.test(review.prompt), 'a hard-cut entry is copied through, not failed')
  // A role collects no git truth: there is no diff base, so nothing here may ask for one or try to
  // commit on the tree it was pointed at.
  assert.ok(!/git rev-list --count/.test(review.prompt) && !/commit them yourself/.test(review.prompt),
    'a read-only role never counts commits and never commits')

  const check = promptOf(calls, 'opus-plan-check:a')
  assert.ok(check.includes('A second engineer from a different model family'),
    'the plan-check is told where the questions came from — cross-model disagreement is signal')
  assert.ok(check.includes(Q) && check.includes(R), 'and is handed the questions and risks verbatim')
  assert.ok(/Adjudicate each item explicitly/.test(check), 'as items to adjudicate, never as verdicts')
  assert.equal(state.units.a.status, 'merged')
})

test('l2 spec critique is best-effort: a failed critique degrades and the plan-check runs without it', async () => {
  // Anchored WITHOUT `$` so the adapter's own `#reattempt` dispatch is dead too — the pass only
  // gives up after its retry.
  const { fn, calls } = makeAgent([
    { match: /^codex-spec-review:a/, result: () => codexRoleDead() },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.ok(has(calls, 'codex-spec-review:a#reattempt'), 'the adapter reaps and retries once before giving up')
  const d = state.degradations.find((x) => x.kind === 'codex-role')
  assert.ok(d, 'the skip is ledgered, not silent')
  assert.equal(d.label, 'codex-spec-review:a', 'and the ledger row names the ROLE that failed')
  assert.equal(state.halt, undefined, 'a codex role failure is codex\'s, never a platform outage — nothing halts')
  const check = promptOf(calls, 'opus-plan-check:a')
  assert.ok(check, 'the plan-check still ran')
  assert.ok(!check.includes('A second engineer from a different model family'),
    'no critique -> the clause is EXACTLY absent, keeping the prompt byte-identical to the no-critique form')
  assert.equal(state.units.a.status, 'merged', 'this pass gates nothing')
})

// =========================================================================================
// n. THE CODEX ROLE ADAPTER — `run(brief, {model:'codex', cwd, sandbox, schema, label, …})`.
//
// One way to reach Codex from anywhere in the script: a Haiku courier launches `codex exec`
// exactly as the build lane does (detached, `timeout -k` inside the launch, pidfile,
// attach-don't-relaunch, reap-then-retry) and hands the caller back an object the PLATFORM
// validated against the caller's own schema — or null. The spec critique is its first caller and
// the only one this wave; wave 2 moves the rest of the judgment roles onto it.
//
// What these lock is the contract wave-2 callers are written against, and the two brakes that
// cannot be prose: a role never runs in the operator's checkout, and a role failure is CODEX's,
// never the platform's.
// =========================================================================================
test('n adapter: the caller gets its own schema back, validated — the courier envelope never leaks', async () => {
  const { fn, calls } = makeAgent([
    { match: /^codex-spec-review:a$/, result: () => codexRoleOk({ questions: ['Q1'], risks: ['R1'], notes: 'n' }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  const check = promptOf(calls, 'opus-plan-check:a')
  assert.ok(check.includes('Q1') && check.includes('R1'), 'the caller reads `result`, not the envelope')
  assert.ok(!/"ok":true/.test(check) && !/sessionCaptured/.test(check),
    'the adapter unwraps: `ok`/`codex` are the courier\'s bookkeeping and never reach the caller')
  assert.equal(state.units.a.status, 'merged')
})

test('n2 adapter: cwd and sandbox are interpolated exactly as given, and never the repo root', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState())
  const p = promptOf(calls, 'codex-spec-review:a')

  assert.ok(p.includes(`-C ${WT}/a `), 'codex is pointed at the cwd the caller named')
  assert.ok(!/-C \/repo(\s|$)/.test(p), 'never at the operator\'s checkout')
  assert.ok(p.includes('-s danger-full-access'),
    'codexSandbox is the environment\'s ruling and overrides the role\'s intent, as in the build lane')
  assert.ok(!p.includes('-s read-only'), 'so the role\'s read-only intent is carried by the brief, not the flag')
  // The launch mechanics are the build lane's, not a second implementation of them — including the
  // self-written pidfile, the TERM forward and the double wait, which the roles get for free only
  // because the seam is shared.
  for (const required of ['setsid', '--json', '-o ', '--output-schema', 'tail --pid', 'timeout -k 30 900',
    `sh -c 'echo $$ > ${WT}/__codex/roles/w1/codex-spec-review-a/codex.pid; `,
    'trap "kill -TERM $CPID; T=1" TERM;',
    'wait $CPID; RC=$?; if [ -n "$T" ]; then wait $CPID; RC=$?; fi;',
    // …and the bounded pidfile wait the launch command ends on. Without it the role's own
    // `tail --pid=$(cat …/codex.pid)` — a SEPARATE Bash call — races the detached shell's first
    // write and reads an absent file, which is exactly the false death the pidfile mechanic exists
    // to remove (2026-09-04).
    `exit-code' & i=0; while [ ! -s ${WT}/__codex/roles/w1/codex-spec-review-a/codex.pid ] && ` +
    '[ "$i" -lt 50 ]; do sleep 0.2; i=$((i+1)); done'])
    assert.ok(p.includes(required), `the role launch must reuse the pinned build-lane mechanic \`${required}\``)
  assert.ok(!p.includes('echo $! >'), 'and never the $! pidfile the build lane no longer writes either')
  assert.ok(/A MISSING .*exit-code MEANS RUNNING, NEVER DEAD/.test(p), 'including the absent-exit-code rule')
  assert.ok(/if .*codex\.pid already exists/.test(p), 'and the attach-don\'t-relaunch preamble')
  assert.ok(p.includes(`${WT}/__codex/roles/w1/codex-spec-review-a`),
    'role artifacts live in the roles namespace under the worktree root, outside every tracked tree')
})

test('n3 adapter: one reap-first retry, then a tagged failure — and the platform is never halted', async () => {
  const seen = []
  const { fn, calls } = makeAgent([
    { match: /^codex-spec-review:a/, result: (p, o) => { seen.push(o.label); return codexRoleDead() } },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.deepEqual(seen, ['codex-spec-review:a', 'codex-spec-review:a#reattempt'], 'exactly one retry — never a loop')
  const retry = promptOf(calls, 'codex-spec-review:a#reattempt')
  assert.ok(retry.includes(`${WT}/__codex/roles/w1/codex-spec-review-a-retry`), 'the retry runs in a FRESH artifact dir')
  assert.ok(/REAP THE PREVIOUS ATTEMPT FIRST/.test(retry) &&
    retry.includes(`kill -TERM -- -$(cat ${WT}/__codex/roles/w1/codex-spec-review-a/codex.pid)`),
    'and reaps the dead run\'s process group before it launches — two codex on one tree is not a state to reason about')
  assert.ok(/# PRIOR ATTEMPT/.test(retry), 'the brief says so too, so a live sibling is reported as a harness bug')

  // The tagged failure: ONE `codex-role` row, the caller sees null, and nothing wave-level moves.
  const rows = state.degradations.filter((d) => d.kind === 'codex-role')
  assert.equal(rows.length, 1, 'the give-up is ledgered exactly once, at the event')
  assert.ok(/never a Claude platform outage/.test(rows[0].what), 'and says whose failure it was')
  assert.equal(state.halt, undefined, 'no platform halt, no codex halt — a dead role halts nothing')
  assert.equal(state.units.a.status, 'merged', 'and the caller\'s coded fallback carries the unit through')
})

test('n4 adapter: a role never runs in the operator\'s checkout — the cwd brake is code, not prose', async () => {
  // The one configuration that can point a role at the repo root: a worktree root whose child IS
  // the repository. The brake throws rather than improvising, and the unit fails loudly.
  const { fn } = makeAgent()
  const plan = { repoPath: `${WT}/a`, worktreeRoot: WT, units: [unit('a')], edges: [] }
  const state = await runWave(fn, plan, makeState())

  assert.equal(state.units.a.status, 'quarantined', 'the throw is not swallowed anywhere')
  assert.match(state.units.a.reason, /pipeline error/)
  assert.match(state.units.a.reason, /operator's checkout/,
    'and the error names what was wrong: a role was pointed at the repo root')
})

test('n5 adapter: codex dispatches land in their own spend bucket', async () => {
  const { fn, calls } = makeAgent()
  const clean = await runWave(fn, makePlan([unit('a')]), makeState())
  // One tick per codex exec the ADAPTER launched. A clean single-unit wave dispatches six roles:
  // the spec critique, the plan, the verify and the pre-gate review from the per-unit pipeline,
  // plus the wave-tail health assessor and flake band. (The build/fix lane has its own `codexRuns`
  // counter — it is not a role.)
  assert.equal(clean.spend.codex, 6, 'one role call = one codex exec = one tick in the `codex` bucket')
  assert.deepEqual(
    calls.filter((c) => c.schema?.properties?.result).map((c) => c.label).sort(),
    ['codex-review:a', 'codex-spec-review:a', 'flake:w1', 'health:w1', 'plan:a', 'verify:a#0'],
    'and those six are exactly the roles the per-unit pipeline plus the boundary dispatches')

  const { fn: fn2 } = makeAgent([{ match: /^codex-spec-review:a/, result: () => codexRoleDead() }])
  const retried = await runWave(fn2, makePlan([unit('a')]), makeState())
  assert.equal(retried.spend.codex, 7, 'the reattempt is a second codex process and is counted as one')
  assert.ok(retried.spend.haiku > clean.spend.haiku, 'and each one also costs its own Haiku courier')

  // The boundary roles ride the same bucket — that is the whole point of the 0.14.0 shift. With the
  // wave-tail band switched off, only the four per-unit roles tick, and the Opus bill is unmoved:
  // the health assessor that used to be an Opus investigator costs that tier nothing now.
  const { fn: fn3 } = makeAgent()
  const noBoundary = await runWave(fn3, makePlan([unit('a')]), makeState(), { healthCheck: 'off' })
  assert.equal(noBoundary.spend.codex, 4, 'the health assessor and the flake band are codex dispatches')
  assert.equal(noBoundary.spend.opus, clean.spend.opus, 'and neither costs the Opus tier anything')
})

// =========================================================================================
// o. THE 0.14.0 PER-UNIT SHIFT — plan/replan, verify, the pre-gate review, the dossier write and
//    the flake band all run on the codex role adapter, and the exit gate eats a DIGEST instead of
//    the raw diff. What these lock is the part that cannot be recovered from a prompt diff: which
//    tier each role reaches, which tree it runs in, and — the load-bearing half — that every path
//    where evidence goes MISSING routes to MORE Claude scrutiny, never less.
// =========================================================================================
const ROLE_LABELS = (calls) => calls.filter((c) => c.schema?.properties?.result).map((c) => c.label)

test('o1 moved roles: each one reaches codex, in the right tree, with the sandbox it intended', async () => {
  // codexSandbox is the ENVIRONMENT's ruling and normally overrides every role's intent, so it is
  // pinned to null here — that is the only way a role's own `sandbox` argument becomes observable,
  // and the intent is what a future environment with working user namespaces will actually enforce.
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('a')]), makeState(), { codexSandbox: null })

  const roles = ROLE_LABELS(calls)
  for (const l of ['plan:a', 'verify:a#0', 'codex-review:a', 'flake:w1'])
    assert.ok(roles.includes(l), `${l} must dispatch through the codex role adapter, not a Claude agent`)

  const where = { 'plan:a': `${WT}/a`, 'verify:a#0': `${WT}/a`, 'codex-review:a': `${WT}/a`,
    'flake:w1': `${WT}/__integration` }
  const sand = { 'plan:a': 'read-only', 'verify:a#0': 'workspace-write', 'codex-review:a': 'read-only',
    'flake:w1': 'workspace-write' }
  for (const [label, cwd] of Object.entries(where)) {
    const p = promptOf(calls, label)
    assert.ok(p.includes(`-C ${cwd} `), `${label} runs codex in ${cwd}`)
    assert.ok(p.includes(`-s ${sand[label]} `), `${label} declares sandbox ${sand[label]}`)
    assert.ok(!/-C \/repo(\s|$)/.test(p), `${label} must never be pointed at the operator's checkout`)
  }
  // The two readers say so in the BRIEF as well: codexSandbox normally overrides `-s`, so where the
  // sandbox cannot carry "change nothing", the brief has to.
  for (const l of ['plan:a', 'codex-review:a'])
    assert.match(promptOf(calls, l), /Read-only\. Change nothing|Read-only\. Write no code/,
      `${l} carries its read-only intent in the brief, not only in the flag`)
})

test('o2 gate diet: gateModel by risk, and only a low-risk unit trades the raw diff for the digest', async () => {
  const gate = (calls, id) => calls.find((c) => c.label === `opus-gate:${id}#0`)
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan([unit('lo'), unit('mid', { risk: 'med' })]), makeState())

  assert.equal(gate(calls, 'lo').model, 'sonnet', 'a low-risk unit takes the cheap first-pass gate')
  assert.equal(gate(calls, 'mid').model, 'opus', 'med keeps Opus')
  assert.match(gate(calls, 'lo').prompt, /git -C '\/wt\/lo' diff --stat/,
    'and reads a diet, expanding on suspicion — with the worktree in the command, not in an earlier cd')
  assert.match(gate(calls, 'mid').prompt, /read `git -C '\/wt\/mid' diff [0-9a-f]+\.\.HEAD` in full/,
    'while med keeps the raw diff in front of it')
  for (const id of ['lo', 'mid']) {
    const p = gate(calls, id).prompt
    assert.match(p, /A cross-model reviewer/, `${id}'s gate is handed the digest`)
    assert.match(p, /"verdict":"clean"/, 'verbatim, as the object the reviewer emitted')
    assert.match(p, /never as a verdict and never as coverage/,
      'and told it is evidence to adjudicate — this sentence is what stands between a diet and a rubber stamp')
  }
  // The knob is a plan/config map, and an override replaces it wholesale.
  const { fn: fn2, calls: c2 } = makeAgent()
  await runWave(fn2, makePlan([unit('lo')]), makeState(), { gateModel: { low: 'opus' } })
  assert.equal(gate(c2, 'lo').model, 'opus', 'gateModel is a knob, not a hardcode')
})

test('o3 a dead reviewer buys MORE Claude: Opus gate, raw diff, and a review-skipped row', async () => {
  const { fn, calls } = makeAgent([{ match: /^codex-review:lo/, result: () => codexRoleDead() }])
  const state = await runWave(fn, makePlan([unit('lo')]), makeState())

  assert.ok(has(calls, 'codex-review:lo#reattempt'), 'the adapter retries once before giving up')
  const g = calls.find((c) => c.label === 'opus-gate:lo#0')
  assert.equal(g.model, 'opus', 'no digest -> Opus, whatever the unit\'s risk')
  assert.match(g.prompt, /read `git -C '[^']+' diff [0-9a-f]+\.\.HEAD` in full/, 'and on the raw diff, not a diet')
  assert.match(g.prompt, /No cross-model review digest exists/, 'told plainly that nothing was pre-checked')
  const d = (state.degradations ?? []).filter((x) => x.kind === 'review-skipped')
  assert.equal(d.length, 1, 'the skip is ledgered — a spend audit has to see why the gate got expensive')
  assert.match(d[0].what, /never less scrutiny/, 'and the row states the direction the fallback moves in')
  assert.equal(state.halt, undefined, 'a dead codex role halts nothing')
  assert.equal(state.units.lo.status, 'merged')
})

test('o3b a digest the reviewer graded `blocking` or high-risk refuses the diet too', async () => {
  for (const digest of [{ verdict: 'blocking' }, { risk: 'high' }]) {
    const { fn, calls } = makeAgent([
      { match: /^codex-review:lo/, result: () => reviewDigestOk(digest) },
      // a blocking digest is still only ADVICE: the gate rules, and here it approves.
      { match: /^opus-gate:lo/, result: () => ({ verdict: 'approve', trigger: 'none', directives: [], debt: [] }) },
    ])
    await runWave(fn, makePlan([unit('lo')]), makeState())
    const g = calls.find((c) => c.label === 'opus-gate:lo#0')
    assert.equal(g.model, 'opus', `${JSON.stringify(digest)} must not ride the cheap tier`)
    assert.match(g.prompt, /read `git -C '[^']+' diff [0-9a-f]+\.\.HEAD` in full/,
      `${JSON.stringify(digest)} must not ride the diet — the gate has to be able to disagree`)
  }
})

test('o3c the frontier gate is handed the same digest', async () => {
  const MARK = 'DIGEST_SPEC_FINDING_MARKER'
  const { fn, calls } = makeAgent([
    { match: /^codex-review:hi/, result: () => reviewDigestOk({ verdict: 'concerns',
      specFindings: [{ criterion: 'rounds half away from zero', what: MARK, evidence: 'Math.round(-0.5)' }] }) },
  ])
  await runWave(fn, makePlan([unit('hi', { risk: 'high' })]), makeState())
  const p = promptOf(calls, 'gate:hi#0')
  assert.ok(p, 'a high-risk unit still goes straight to the frontier gate')
  assert.match(p, /A cross-model reviewer/)
  assert.ok(p.includes(MARK), 'with the reviewer\'s findings verbatim')
})

test('o4 a dead dossier writer falls back to the Haiku writer once — a dossier must exist', async () => {
  const { fn, calls } = makeAgent([
    // wrong base -> quarantine, read back out of the worktree by the script
    { match: /^setup:a$/, result: courierSaying([[/rev-parse HEAD/, 'f'.repeat(40)]]) },
    // Anchored WITHOUT `$` so the adapter's own `#reattempt` dispatch is dead too — the write only
    // gives up after its retry, exactly like every other role.
    { match: /^dossier-write:a(?!#fallback)/, result: () => null },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'quarantined')
  const fb = calls.find((c) => c.label === 'dossier-write:a#fallback')
  assert.ok(fb, 'the Haiku writer this replaced is still there as the fallback')
  assert.equal(fb.model, 'haiku')
  assert.equal(calls.filter((c) => c.label === 'dossier-write:a#fallback').length, 1, 'exactly once — never a loop')
  const d = (state.degradations ?? []).filter((x) => x.kind === 'dossier-write-fallback')
  assert.equal(d.length, 1, 'and the fallback is ledgered, not silent')
})

// =========================================================================================
// Plan-check routing. Better judgment before dispatch means less wasted implementation, fewer
// findings and fewer fix rounds — so Fable now takes every chain and every med/high-risk unit,
// and ONLY low-risk singles ride the cheaper Opus-first ladder.
// =========================================================================================
test('m plan-check routing: med and high go straight to Fable; only low rides Opus-first', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan([unit('lo'), unit('mid', { risk: 'med' }), unit('hi', { risk: 'high' })]), makeState())

  assert.ok(has(calls, 'opus-plan-check:lo'), 'a low-risk single still gets the cheap first pass')
  assert.ok(!has(calls, 'plan-check:lo'), 'and never pays the frontier unless it escalates')

  for (const id of ['mid', 'hi']) {
    assert.ok(has(calls, `plan-check:${id}`), `${id} takes the Fable plan-check directly`)
    assert.equal(calls.find((c) => c.label === `plan-check:${id}`).model, 'fable')
    assert.ok(!has(calls, `opus-plan-check:${id}`), `${id} must NOT pay for an Opus pass it will bypass anyway`)
  }
  for (const id of ['lo', 'mid', 'hi']) assert.equal(state.units[id].status, 'merged')
})

// =========================================================================================
// Scope discipline. A fresh build's envelope is the APPROVED PLAN's `files`, pinned once and
// never recomputed from the live diff (scope→diff→fixes→scope is the review spiral). Growth past
// it is recorded loudly and handed to the exit gate to adjudicate — never used to license more
// fixing. This is only observable because S.verify now REQUIRES diffFiles.
// =========================================================================================
test('k scope growth: files beyond the plan\'s envelope degrade loudly and reach the gate as a creep clause', async () => {
  const { fn, calls } = makeAgent([
    { match: /^plan:a$/, result: () => ({ approach: 'x', files: ['src/a.js'], testPlan: 'x', feasible: true }) },
    { match: /^verify:a/, result: () => ({ ...VERIFY_OK, diffFiles: ['src/a.js', 'src/wandered.js'] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  const d = state.degradations.find((x) => x.kind === 'scope-growth')
  assert.ok(d, 'a diff outside the pinned envelope is a recorded signal, not a silent one')
  assert.ok(d.what.includes('src/wandered.js'), 'and it names the file that wandered')

  const gate = promptOf(calls, 'opus-gate:a#0')
  assert.ok(gate.includes("This diff touches 1 file(s) outside the unit's pinned scope"),
    'the exit gate adjudicates the growth (necessary vs creep) — that is where judgment already lives')
  assert.ok(gate.includes('src/wandered.js'), 'with the specific paths to adjudicate')
  assert.ok(/never a licence|Do not treat their presence as licence/.test(d.what + gate),
    'growth is never licence to fix the extra files — that is the spiral')
  assert.equal(state.units.a.status, 'merged', 'annotate-and-decide, not force-frontier')
})

test('k2 an in-envelope diff produces no growth signal and leaves the gate prompt clean', async () => {
  const { fn, calls } = makeAgent([
    { match: /^plan:a$/, result: () => ({ approach: 'x', files: ['src/a.js'], testPlan: 'x', feasible: true }) },
    { match: /^verify:a/, result: () => ({ ...VERIFY_OK, diffFiles: ['src/a.js'] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())
  assert.ok(!(state.degradations ?? []).some((x) => x.kind === 'scope-growth'), 'no growth, no signal')
  assert.ok(!promptOf(calls, 'opus-gate:a#0').includes('outside the unit'), 'and no clause at all in the gate prompt')
})

// plan.scopeAllow: files the repo's conventions put in every unit's scope (evidence, tests) are
// excluded from the growth CHECK — never counted, never adjudicated — while a real wander still is.
// The pinned envelope itself is untouched. Absent, SCOPE/FIX_SCOPE text is byte-identical (the paid
// fixtures carry no scopeAllow, so an unconditional clause would silently change every brief).
test('k3 scopeAllow: matching files are never growth; non-matching still are; absent -> byte-identical scope text', async () => {
  const setup = () => makeAgent([
    { match: /^plan:a$/, result: () => ({ approach: 'x', files: ['src/a.js'], testPlan: 'x', feasible: true }) },
    { match: /^verify:a/, result: (() => { let n = 0; return () => ({ ...(n++ === 0 ? VERIFY_FAIL() : VERIFY_OK),
      diffFiles: ['src/a.js', 'docs/evidence/a/shot.png', 'src/a.test.js', 'src/wandered.js'] }) })() },
  ])
  const allow = ['docs/evidence/**', '**/*.test.*']

  const { fn, calls } = setup()
  const state = await runWave(fn, makePlan([unit('a')], [], { scopeAllow: allow }), makeState())
  const d = state.degradations.find((x) => x.kind === 'scope-growth')
  assert.ok(d, 'the non-matching wander is still a recorded signal')
  assert.ok(d.what.includes('1 file(s)') && d.what.includes('src/wandered.js'), 'and only that file is counted')
  assert.ok(!d.what.includes('shot.png') && !d.what.includes('a.test.js'), 'allowed files are not growth')
  const gate = promptOf(calls, 'opus-gate:a#0')
  const clause = gate.match(/This diff touches .*?outside the unit's pinned scope: .*?\. Adjudicate/)?.[0] ?? ''
  assert.ok(clause.includes("1 file(s) outside the unit's pinned scope: src/wandered.js."), 'the gate clause carries only the wander')
  assert.ok(!clause.includes('shot.png') && !clause.includes('a.test.js'), 'and never the allowed files')
  const { brief } = schemaAndBriefOf(promptOf(calls, 'codex-build:a'))
  assert.ok(brief.includes('In scope: src/a.js, plus by repo convention any file matching: docs/evidence/**, **/*.test.*, plus any file'),
    'the implementer is told the convention globs are in scope beside the pinned files')
  const { brief: fix } = schemaAndBriefOf(promptOf(calls, 'codex-fix:a#0'))
  assert.ok(fix.includes('The files you may touch are: src/a.js, plus by repo convention any file matching: docs/evidence/**, **/*.test.*, plus any file named'),
    'FIX_SCOPE carries the same convention clause')

  const { fn: fn2, calls: calls2 } = setup()
  const state2 = await runWave(fn2, makePlan([unit('a')]), makeState())
  const d2 = state2.degradations.find((x) => x.kind === 'scope-growth')
  assert.ok(d2.what.includes('3 file(s)'), 'without scopeAllow, all three are growth')
  const { brief: brief2 } = schemaAndBriefOf(promptOf(calls2, 'codex-build:a'))
  assert.ok(brief2.includes("In scope: src/a.js, plus any file you must"), 'no scopeAllow -> no convention clause')
  assert.ok(!brief2.includes('repo convention'), 'byte-identical: the clause is absent, not empty-listed')
  const { brief: fix2 } = schemaAndBriefOf(promptOf(calls2, 'codex-fix:a#0'))
  assert.ok(fix2.includes('The files you may touch are: src/a.js, plus any file named'), 'and FIX_SCOPE is unchanged too')
})

// The directive cap is a cap on REPORTING, never on reading: overflow past C.maxBlockingFindings
// is BANKED as debt (the ledger invariant), not dropped. A dropped finding is exactly the silent
// loss the debt ledger exists to prevent.
test('k3 gate directives past the cap are banked as debt, not dropped', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ what: `directive ${i}`, why: 'because' }))
  const { fn } = makeAgent([
    { match: /^opus-gate:a#0$/, result: () => ({ verdict: 'approve', trigger: 'none', directives: many, debt: [] }) },
  ])
  const state = await runWave(fn, makePlan([unit('a')]), makeState())

  assert.equal(state.units.a.status, 'merged')
  const banked = state.debt.filter((d) => /^directive \d$/.test(d.what))
  assert.equal(banked.length, 3, '9 directives against a cap of 6 bank exactly the 3-item overflow')
  assert.deepEqual(banked.map((d) => d.what), ['directive 6', 'directive 7', 'directive 8'],
    'the overflow is the TAIL (worst-first ordering means the cap keeps the worst)')
  assert.ok(banked.every((d) => d.kind === 'structure'), 'banked overflow lands at the default kind')
})

// =========================================================================================
// j. Conductor halt. Codex is the only implementer, so there is no lane to fall back to: the
//    conductor must early-return the halt to the root BEFORE it spends anything on a census or
//    triage. A census against a wave the root has to hand to a human is pure waste.
// =========================================================================================
async function driveConductorWith(waveState) {
  const { fn: workflowFn } = makeWorkflow(() => waveState)
  const plan = makePlan([unit('a'), unit('b')])
  const state = makeState({ spend: {}, wave: 0 })
  const { fn: agentFn, calls } = makeAgent([
    ...packRules(plan, state),
    { match: /^bank-debt:/, result: { ok: true } },
    { match: /^move-feedback:/, result: courierOk },
  ])
  const runner = await loadScript(CONDUCTOR)
  const res = await runner({
    args: {
      roadmapDir: `${plan.repoPath}/.roadmap`,
      launchId: 'sim-launch',
      config: {},
      harnessPath: HARNESS_PATH,
    },
    agent: agentFn,
    workflow: workflowFn,
  })
  return { res, calls }
}

test('j conductor: a codex halt early-returns at tier 4, before any census or triage spend', async () => {
  const { res, calls } = await driveConductorWith({
    integrationBranch: 'roadmap/session-codex', integrationTip: BASE_SHA, consultsUsed: 0,
    spend: {}, wave: 1, debt: [],
    units: { a: { status: 'pending', parked: true, note: 'parked mid-polish: codex-usage-limit' }, b: { status: 'pending' } },
    halt: { reason: 'codex-usage-limit', codex: 'codex-usage-limit' },
    codex: { probed: 1, available: false },
  })

  assert.equal(res.reason, 'codex-usage-limit', 'the halt value IS the return reason — the root reads it verbatim')
  assert.deepEqual(res.parked, ['a'], 'the return names the parked units so the root knows what resumes')
  assert.ok(!has(calls, 'census:'), 'no census against a wave the root must hand to a human')
  assert.ok(!has(calls, 'triage:'), 'and certainly no boundary triage')
  assert.ok(!has(calls, 'boundary:'))
  assert.ok(res.state?.units, 'the full wave state rides home on the envelope — the halt must be resumable')
  const b = res.state.conductor?.boundaries ?? []
  assert.deepEqual(b.map((x) => x.tier), [4], 'recorded as a tier-4 boundary outcome')
  assert.equal(b[0].escalated, 'codex-usage-limit')
})

test('j2 conductor: the unavailable-probe halt returns its own reason, not a generic one', async () => {
  const { res, calls } = await driveConductorWith({
    integrationBranch: 'roadmap/session-codex', integrationTip: BASE_SHA, consultsUsed: 0,
    spend: {}, wave: 1, debt: [],
    units: { a: { status: 'pending' }, b: { status: 'pending' } },
    halt: { reason: 'codex-unavailable', codex: 'codex-unavailable' },
    codex: { probed: 1, available: false },
  })
  assert.equal(res.reason, 'codex-unavailable', 're-auth and wait-out-the-limit are different human actions')
  assert.deepEqual(res.parked, [], 'a pre-dispatch halt parks nothing — the units never started')
  assert.ok(!has(calls, 'census:'))
  assert.ok(labels(calls).every((l) => !/^(census|triage|boundary):/.test(l)), 'no boundary spend at all')
})

test('j3 conductor: a healthy wave still reaches the census (the halt guard is not always-on)', async () => {
  const { calls } = await driveConductorWith({
    integrationBranch: 'roadmap/session-codex', integrationTip: BASE_SHA, consultsUsed: 0,
    spend: {}, wave: 1, debt: [],
    units: { a: { status: 'merged' }, b: { status: 'merged' } },
    codex: { probed: 1, available: true },
    boundary: { explorer: null, health: { findings: [], fixUnits: [] }, flake: null },
  })
  assert.ok(has(calls, 'census:w1'), 'without a halt the boundary runs normally — j/j2 are not vacuous')
})

// =========================================================================================
// p. The four BOUNDARY roles on the adapter (0.14.0). The wave-tail explorer, health assessor and
//    design reconciler were Opus investigators, and the flake band a Haiku test-runner; all four
//    had a Haiku verbatim-writer transcribe their structured result to
//    `.roadmap/feedback/<job>/wave-N.md`. They are codex roles now and each writes its own report,
//    so what has to stay pinned is: WHERE each one runs, WHAT it may write, and what a dead one
//    costs the wave. The judgment that reads their output — the conductor's tier-2/tier-3 triagers
//    — is deliberately untouched.
// =========================================================================================
const PREVIEW = { kind: 'server', howToAccess: 'http://localhost:5173', start: 'npm run dev' }
const AUTH_P = [{ id: 'checkin', source: 'design-project', path: 'apps/web/src/design/checkin/', covers: ['/checkin'] }]
const boundaryPlan = () => makePlan([unit('ui', { design: ['checkin#chrome'] })], [],
  { designAuthorities: AUTH_P, preview: PREVIEW })

test('p1 boundary roles: each is a codex dispatch, in the tree it judges', async () => {
  const { fn, calls } = makeAgent()
  // `codexSandbox: null` drops the ENVIRONMENT's override so the role's own declared intent is what
  // reaches the command line — the only way to observe it (the shipped default is
  // 'danger-full-access' for the measured reason on that knob, and it wins by design).
  await runWave(fn, boundaryPlan(), makeState(), { codexSandbox: null })

  for (const [label, cwd] of [['explorer:w1', `${WT}/__preview`], ['health:w1', `${WT}/__integration`],
    ['flake:w1', `${WT}/__integration`], ['design:w1', `${WT}/__preview`]]) {
    const c = calls.find((x) => x.label === label)
    assert.ok(c, `${label} ran`)
    assert.equal(c.model, 'haiku', `${label} is steered by the codex courier, not an Opus turn`)
    assert.ok(c.prompt.includes(`codex exec -C ${cwd} -s workspace-write`),
      `${label} runs codex in ${cwd} and declares workspace-write (it writes exactly one file: its report)`)
    assert.ok(c.prompt.includes(`${WT}/__codex/roles/w1/${label.replace(':', '-')}`),
      `${label} gets its own artifact dir under the roles namespace`)
  }
  // The preview tree is where a shell may reach the running product; the operator's checkout never is.
  for (const label of ['explorer:w1', 'design:w1'])
    assert.ok(!calls.find((c) => c.label === label).prompt.includes('codex exec -C /repo '),
      `${label} must never be pointed at the operator's checkout`)
})

test('p2 boundary roles: each writes its own report, and no transcription courier survives', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, boundaryPlan(), makeState())

  for (const [label, path] of [['explorer:w1', '/repo/.roadmap/feedback/explorer/wave-1.md'],
    ['health:w1', '/repo/.roadmap/feedback/health/wave-1.md'],
    ['design:w1', '/repo/.roadmap/feedback/design/wave-1.md'],
    // The flake band's record is its OWN file, not a section inside the health report: the health
    // assessor owns that path end to end, and two writers on one path lose a section.
    ['flake:w1', '/repo/.roadmap/feedback/health/wave-1-flake.md']])
    assert.ok(calls.find((c) => c.label === label).prompt.includes(path),
      `${label} is told to write ${path} itself`)

  for (const gone of ['explorer-write:', 'health-write:', 'design-write:', 'flake-write:'])
    assert.ok(!has(calls, gone), `${gone} is a removed label — the role has a filesystem now`)
})

test('p3 boundary roles: a dead explorer or design role goes OWED, exactly as a skipped one did', async () => {
  const { fn } = makeAgent([
    { match: /^explorer:w1/, result: () => codexRoleDead() },
    { match: /^design:w1/, result: () => codexRoleDead() },
  ])
  const state = await runWave(fn, boundaryPlan(), makeState())

  const owed = Object.fromEntries((state.owed ?? []).map((o) => [o.job, o]))
  assert.ok(owed.explorer, 'the explorer is owed at the next boundary')
  assert.ok(owed.design, 'so is the design reconcile')
  assert.deepEqual(owed.design.units, ['ui'], 'and it names the surfaces that went unchecked')
  assert.equal(state.halt, undefined, 'a dead codex role halts nothing — that is the adapter contract')
  // One `codex-role` row per dead role, from the adapter, plus the design job's own no-report row.
  const kinds = (state.degradations ?? []).map((d) => d.kind)
  assert.equal(kinds.filter((k) => k === 'codex-role').length, 2, 'each dead role is ledgered once, at the event')
  assert.ok(kinds.includes('no-report'), 'and the unchecked design surfaces are named for the operator')
})

test('p4 boundary roles: a dead health role degrades `health-skipped` and yields no drafts', async () => {
  const { fn } = makeAgent([{ match: /^health:w1/, result: () => codexRoleDead() }])
  const state = await runWave(fn, boundaryPlan(), makeState())

  assert.equal(state.boundary.health, null, 'no drafts — an empty draft set here means UNASSESSED')
  const row = (state.degradations ?? []).find((d) => d.kind === 'health-skipped')
  assert.ok(row, 'and the ledger says so, so a triager cannot read silence as "nothing to consolidate"')
  assert.match(row.what, /UNASSESSED/)
  assert.ok(state.boundary.explorer, 'the boundary itself proceeds — a skipped assessment is not a failed wave')
  assert.ok((state.owed ?? []).some((o) => o.job === 'health'), 'and it is re-queued')
})
