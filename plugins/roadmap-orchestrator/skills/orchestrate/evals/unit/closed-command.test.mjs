// Zero-token simulation of the CLOSED-COMMAND-LIST discipline (theme C).
//
// The principle these tests pin: harness.mjs has no filesystem and no shell — `run()` IS `agent()`
// — so every git/gh/kill/test command necessarily passes through a model. The only deterministic
// levers are which tier runs it, how mechanically the prompt is phrased, and WHAT LITERAL STRINGS
// the script computes. Therefore the cheapest tier is never handed a goal with destructive reach;
// it is handed a closed list of exact commands whose verbatim output the script judges.
//
// Each of the four arc-observed disasters below was a goal-shaped prompt at Haiku:
//   2026-08-21  "sweep leftover listeners" -> `ps aux | grep node | xargs kill -9`, host-wide,
//               killing the conductor workflow itself.
//   2026-08-22  "find or create by marker" over GitHub's tokenizing full-text search -> three
//   /08-23     live issues clobbered; 8 of 11 unit issues resolved to unrelated old issues.
//   2026-08-26  "report ok:true ONLY if the login status says logged in" -> Haiku invented an
//               Anthropic-credential requirement and halted a wave whose auth was fine.
//   2026-08-28  "never stash, reset, or force" -> the mirror agent deleted 163 untracked
//               .roadmap/ files instead, twice.
// A prohibition list is weaker than an allowlist. What is absent from `commands` is outside the
// agent's remit by construction, which is what these tests check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import { makeAgent, courierResult, BASE_SHA, INT_SHA, assertAllModelsPinned, assertSchemasPresent } from './fakes.mjs'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))

const unit = (id, extra = {}) => ({ id, risk: 'low', kind: 'code', inScope: true, ...extra })
const makePlan = (extra = {}) => ({ repoPath: '/repo', worktreeRoot: '/wt', units: [unit('a')], edges: [], ...extra })
const makeState = (extra = {}) => ({
  integrationBranch: 'roadmap/cc', integrationTip: BASE_SHA, consultsUsed: 0, wave: 0, units: {}, ...extra,
})
const runWave = async (agentFn, plan, state, config = {}) =>
  (await loadScript(HARNESS))({ args: { plan, state, config: { gateAuditRate: 0, ...config } }, agent: agentFn })

const PREVIEW = { kind: 'server', howToAccess: 'http://localhost:5173', start: 'npm run dev', healthcheck: 'curl -sf http://localhost:5173' }
const callOf = (calls, label) => calls.find((c) => c.label === label)
const promptOf = (calls, label) => callOf(calls, label)?.prompt ?? ''
// Every courier prompt ends in its numbered command list; this is the list the agent may run.
const commandsOf = (prompt) => (prompt.split('\nCommands:\n')[1] ?? '')
  .split('\n').map((l) => /^\s*\d+\.\s+(.*)$/.exec(l)?.[1]).filter(Boolean)

// A courier fake that fails at `failing` and stops there, exactly as the courier contract says.
const courierFailingAt = (failing) => (prompt) => {
  const full = courierResult(prompt, BASE_SHA)
  const results = []
  for (const e of full.results) {
    if (failing.test(e.command)) { results.push({ ...e, exitCode: 1, stdout: 'listen EADDRINUSE :::5173' }); break }
    results.push(e)
  }
  return { ok: true, results }
}

// =========================================================================================
// 1. The courier contract itself.
// =========================================================================================
test('courier prompts hand over a closed command list and forbid everything outside it', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan({ preview: PREVIEW }), makeState())
  const couriers = calls.filter((c) => c.prompt.includes('\nCommands:\n'))
  assert.ok(couriers.length >= 3, `several courier calls drive this wave (saw ${couriers.length})`)
  for (const c of couriers) {
    const cmds = commandsOf(c.prompt)
    assert.ok(cmds.length, `${c.label} carries a non-empty command list`)
    assert.ok(c.prompt.includes(`run EXACTLY the ${cmds.length} numbered command(s)`),
      `${c.label} states the list length, so a dropped or invented command is visible`)
    assert.match(c.prompt, /run NOTHING ELSE/, `${c.label} closes the list`)
    assert.match(c.prompt, /never summarise or paraphrase/, `${c.label} demands verbatim output`)
    // The script judges the exit codes; the courier is never asked for a verdict about them.
    assert.match(c.prompt, /ok is about YOUR REPORT, not/, `${c.label} keeps the verdict in the script`)
    assert.equal(c.schema.required.join(','), 'ok,results', `${c.label} reports per-command results`)
    assert.equal(c.schema.properties.results.maxItems, cmds.length, `${c.label} bounds results to its own list`)
  }
})

test('no courier prompt contains a destructive command outside its own list', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan({ preview: PREVIEW }), makeState())
  // These are exactly the reaches that hurt: they are absent by CONSTRUCTION now (never on a
  // command list), which is why no "never do X" clause has to hold them back.
  const forbidden = /\brm -rf\b|find [^\n]*-delete|git clean|git stash|git reset|\bpkill\b|\bkillall\b|ps aux/
  for (const c of calls.filter((x) => x.prompt.includes('\nCommands:\n')))
    for (const cmd of commandsOf(c.prompt))
      assert.ok(!forbidden.test(cmd), `${c.label} lists a destructive command: ${cmd}`)
})

// =========================================================================================
// 2. Codex probe: the pass condition is decided in the script, never by the agent.
// =========================================================================================
const probe = (statusOut, versionExit = 0) => (prompt) => {
  const r = courierResult(prompt, BASE_SHA)
  if (versionExit !== 0) return { ok: true, results: [{ ...r.results[0], exitCode: versionExit, stdout: 'codex: not found' }] }
  return { ok: true, results: [r.results[0], { ...r.results[1], stdout: statusOut }] }
}

test('codex probe: any credential provider passes — the script matches /logged in/i itself', async () => {
  for (const out of ['Logged in using ChatGPT (plan: pro)', 'Logged in using an API key', 'logged in via device auth']) {
    const { fn } = makeAgent([{ match: /^codex-probe:/, result: probe(out) }])
    const state = await runWave(fn, makePlan(), makeState())
    assert.equal(state.codex.available, true, `"${out}" is a pass — the credential provider is not the probe's business`)
    assert.equal(state.units.a.status, 'merged', 'the wave dispatches normally')
  }
})

test('codex probe: no logged-in line halts the wave, and so does a missing CLI', async () => {
  for (const [name, rule] of [['not logged in', probe('Not logged in. Run codex login.')], ['no CLI', probe('', 127)]]) {
    const { fn } = makeAgent([{ match: /^codex-probe:/, result: rule }])
    const state = await runWave(fn, makePlan(), makeState())
    assert.equal(state.halt.reason, 'codex-unavailable', `${name} halts dispatch`)
    assert.equal(state.halt.codex, 'codex-unavailable', `${name} fills the codex slot of the halt record`)
    assert.equal(state.units.a.status, 'pending', `${name} leaves the unit resumable, never quarantined`)
    assert.ok(state.degradations.some((d) => d.kind === 'codex-unavailable'), `${name} is ledgered`)
  }
})

test('codex probe: the prompt forbids judging the credential provider at all', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan(), makeState())
  const p = promptOf(calls, 'codex-probe:w1')
  assert.match(p, /not yours to assess/, 'the invented-requirement class is named and closed')
  assert.match(p, /ChatGPT plan, API key, device auth/, 'every provider is spelled out as acceptable')
  assert.equal(commandsOf(p).length, 2, 'exactly two commands: --version and login status')
})

// =========================================================================================
// 3. The preview lives in its OWN worktree. Nothing the harness does reaches the operator's tree.
// =========================================================================================
test('preview: the worktree is provisioned like __integration and the operator checkout is never a target', async () => {
  const { fn, calls } = makeAgent()
  const state = await runWave(fn, makePlan({ preview: PREVIEW, provision: { setup: 'npm ci' } }), makeState())
  assert.equal(state.preview.status, 'live')

  // The one command that must run in the primary checkout — `git worktree add` cannot run anywhere else.
  const wt = promptOf(calls, 'preview-worktree')
  assert.ok(wt.includes('In /repo:'), 'the worktree is added from the primary checkout')
  assert.ok(commandsOf(wt).some((c) => c.includes('git worktree add --detach /wt/__preview')),
    'the preview gets its own worktree')
  assert.ok(commandsOf(wt).some((c) => c.includes('git worktree list --porcelain')),
    'idempotent: a relaunch adopts the existing worktree instead of failing')
  assert.ok(!commandsOf(wt).some((c) => /checkout|status/.test(c)),
    'nothing checks out or inspects the primary checkout')

  // Everything else runs in the preview worktree.
  assert.ok(promptOf(calls, 'provision:preview').includes('/wt/__preview'), 'deps/env, same as __integration')
  const setup = promptOf(calls, 'preview-setup')
  assert.ok(setup.includes('In /wt/__preview:'), 'bring-up runs in the preview worktree')
  assert.ok(commandsOf(setup).includes(`git checkout --detach ${BASE_SHA}`), 'the detach happens there')
  for (const c of calls.filter((x) => /^(preview|mirror)/.test(x.label)))
    assert.ok(!/cd \/repo\b|In \/repo: [^]*checkout/.test(c.prompt) || c.label === 'preview-worktree',
      `${c.label} must not treat the primary checkout as a checkout target`)
})

test('preview: the mirror advance is a closed list, not a "never stash/reset/force" prohibition', async () => {
  const { fn, calls } = makeAgent([{ match: /^merge:/, result: { merged: true, suitePass: true, head: INT_SHA, detail: '' } }])
  const state = await runWave(fn, makePlan({ preview: PREVIEW }), makeState())
  const mirror = calls.find((c) => c.label.startsWith(`mirror:${INT_SHA.slice(0, 7)}`))
  assert.ok(mirror, 'a green merge advances the mirror')
  const cmds = commandsOf(mirror.prompt)
  assert.equal(cmds[0], `git checkout --detach ${INT_SHA}`, 'the advance opens with the detach')
  assert.equal(cmds[cmds.length - 1], 'git rev-parse HEAD', 'and closes by reading HEAD back for the script')
  assert.ok(mirror.prompt.includes('In /wt/__preview:'), 'in the preview worktree, never the operator\'s')
  assert.ok(!/never stash, reset, or force/.test(mirror.prompt), 'the old prohibition is gone — the list replaces it')
  assert.equal(state.preview.sha, INT_SHA, 'the script accepts the advance only on the sha it read back')
})

test('preview: an advance whose reported HEAD is not the target leaves the mirror stale', async () => {
  const { fn } = makeAgent([
    { match: /^merge:/, result: { merged: true, suitePass: true, head: INT_SHA, detail: '' } },
    // The tree never actually moves: `git rev-parse HEAD` keeps reporting the old sha.
    { match: /^mirror:/, result: (p) => courierResult(p, BASE_SHA, (cmd) => (/rev-parse HEAD/.test(cmd) ? BASE_SHA : '')) },
  ])
  const state = await runWave(fn, makePlan({ preview: PREVIEW }), makeState())
  assert.equal(state.preview.sha, BASE_SHA, 'previewSha only moves when the read-back sha matches the target')
})

// =========================================================================================
// 4. The port sweep is an interpolated allowlist, and only the script may dispatch it.
// =========================================================================================
test('preview sweep: ports come from the plan (or the howToAccess URL), never from inference', async () => {
  for (const [where, preview, port] of [
    ['plan.preview.ports', { ...PREVIEW, ports: [4173] }, 4173],
    ['the howToAccess URL', PREVIEW, 5173],
  ]) {
    const { fn, calls } = makeAgent([{ match: /^preview-setup$/, result: courierFailingAt(/npm run dev/) }])
    await runWave(fn, makePlan({ preview }), makeState())
    const sweep = promptOf(calls, 'preview-setup#sweep')
    assert.ok(sweep, `${where}: the script dispatches the sweep retry itself`)
    const kills = commandsOf(sweep).filter((c) => /kill|fuser/.test(c))
    assert.deepEqual(kills.filter((c) => c.includes('fuser')), [`fuser -k ${port}/tcp || true`],
      `${where}: exactly one literal port, taken from ${where}`)
    assert.ok(kills.some((c) => c.includes('/wt/__preview.pid')), 'and the pidfile\'s own process group')
    assert.ok(sweep.includes('Never sweep by process NAME'), 'the two hammers that were reached for are named')
  }
})

test('preview sweep: never fires when the detach itself failed — a bad checkout is not a port problem', async () => {
  const { fn, calls } = makeAgent([{ match: /^preview-setup$/, result: courierFailingAt(/git checkout --detach/) }])
  const state = await runWave(fn, makePlan({ preview: PREVIEW }), makeState())
  assert.ok(!callOf(calls, 'preview-setup#sweep'), 'no kill of any kind when the tree never moved')
  assert.equal(state.preview.status, 'failed')
  assert.ok(state.degradations.some((d) => d.kind === 'preview-failed'), 'and it degrades loudly for the operator')
})

test('preview sweep: with no identifiable ports the only legal target is the pidfile group', async () => {
  const preview = { kind: 'cli', howToAccess: 'run ./bin/app', start: 'npm run dev' }
  const { fn, calls } = makeAgent([{ match: /^preview-setup$/, result: courierFailingAt(/npm run dev/) }])
  await runWave(fn, makePlan({ preview }), makeState())
  const sweep = promptOf(calls, 'preview-setup#sweep')
  assert.ok(!commandsOf(sweep).some((c) => c.includes('fuser')), 'no port is guessed when none is declared')
  assert.match(sweep, /leave it alone and report the failing exit code/, 'an unidentified owner is reported, not killed')
})

// =========================================================================================
// 5. Marker find-or-create: the exactness test lives in the shell string the SCRIPT composes.
// =========================================================================================
const ISSUE_PLAN = (extra = {}) => makePlan({ tracking: 'issues', repoSlug: 'o/r', trackingIssue: 9, ...extra })
const PREDICATE = 'split("\\n")[0]'

test('issue mode: every marker search carries the exact-first-line jq predicate', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, ISSUE_PLAN(), makeState())   // unit 'a' has no cached issue -> the search path
  const searching = calls.filter((c) => c.prompt.includes('gh issue list'))
  assert.ok(searching.length >= 2, `several prompts compose a marker search (saw ${searching.length})`)
  for (const c of searching) {
    assert.ok(c.prompt.includes(PREDICATE), `${c.label} enforces the first-line match in jq, not in prose`)
    assert.ok(c.prompt.includes('"<!-- roadmap:unit id=a -->"') || c.prompt.includes('"<!-- roadmap:unit id=<id> -->"'),
      `${c.label} compares against the full marker COMMENT, not the bare marker text`)
    assert.ok(!c.prompt.includes(`--jq '.[0].number'`), `${c.label} no longer takes the first fuzzy hit`)
    assert.match(c.prompt, /never fall back to `\.\[0\]\.number`/, `${c.label} says so as well`)
    assert.match(c.prompt, /Never edit the labels, milestone, title or body of a CLOSED issue/,
      `${c.label} carries the closed-issue bar`)
    assert.match(c.prompt, /never remove a `status:merged` label/, `${c.label} protects a merged unit's state`)
  }
})

test('issue mode: a label edit resolved by search is gated on the issue not being CLOSED', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, ISSUE_PLAN(), makeState())
  const setup = calls.find((c) => c.label.startsWith('setup:')).prompt
  assert.ok(setup.includes('ISSTATE=${HIT##* }'), 'the search reports the state alongside the number')
  assert.ok(setup.includes('if $ISS is non-empty AND $ISSTATE is not CLOSED'), 'and the edit is gated on it')
})

test('issue mode: a cached issue number skips the search entirely', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, ISSUE_PLAN({ units: [unit('a', { issue: 57 })] }), makeState())
  const setup = calls.find((c) => c.label.startsWith('setup:')).prompt
  assert.ok(setup.includes('ISS=57;'), 'the Phase-0 cache is exact and immune to search-index lag')
  assert.ok(!setup.includes(PREDICATE), 'no search is composed when the number is known')
})

test('file mode stays byte-identical: no marker search, no gh, no predicate', async () => {
  const { fn: fileFn, calls: fileCalls } = makeAgent()
  const { fn: issueFn, calls: issueCalls } = makeAgent()
  await runWave(fileFn, makePlan(), makeState())
  await runWave(issueFn, ISSUE_PLAN(), makeState())
  for (const c of fileCalls) {
    assert.ok(!/gh issue|roadmap:unit id=/.test(c.prompt), `file-mode prompt "${c.label}" leaked a gh clause`)
    assert.ok(!c.prompt.includes(PREDICATE), `file-mode prompt "${c.label}" leaked the marker predicate`)
  }
  // Byte-identity where no gh clause is folded in: the paid offline fixtures run in file mode, so
  // this is what makes them valid evidence for issue-mode-adjacent changes.
  const byLabel = new Map(issueCalls.map((c) => [c.label, c.prompt]))
  const untouched = ['plan:a', 'verify:a#0', 'codex-build:a']
  for (const label of untouched)
    assert.equal(fileCalls.find((c) => c.label === label)?.prompt, byLabel.get(label),
      `"${label}" carries no gh clause and must be byte-identical in both modes`)
})

// =========================================================================================
// 6. Verify runs the spec's lanes, and reports which ones it ran.
// =========================================================================================
test('verify: the prompt demands the spec\'s exact commands and a per-lane exit code', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan(), makeState())
  const v = promptOf(calls, 'verify:a#0')
  assert.match(v, /run EXACTLY\s+the acceptance-check commands/, 'no room to choose a lane')
  assert.match(v, /NEVER substitute a narrower, faster or cheaper lane/, 'the observed failure is named')
  assert.match(v, /`pass` is true ONLY if every ` \+\n?|`pass` is true ONLY if every one of those exit codes is 0/,
    'pass is defined over the lane ledger, not over the verifier\'s impression')
  // CHANGED CONTRACT (0.14.0): the verifier is a codex ROLE, so the call the courier makes carries
  // the ADAPTER ENVELOPE and S.verify rides nested under `result` — still platform-validated, one
  // level deeper. The ledger is exactly as required as it was.
  const schema = callOf(calls, 'verify:a#0').schema.properties.result
  assert.ok(schema.required.includes('lanes'), 'the ledger is required, not optional')
  assert.equal(schema.properties.lanes.items.required.join(','), 'command,exitCode')
})

test('both exit gates check the lane ledger against the spec before anything else', async () => {
  const { fn, calls } = makeAgent([{ match: /^opus-gate:/, result: { verdict: 'escalate', trigger: 'oversight', directives: [], debt: [] } }])
  await runWave(fn, makePlan(), makeState())
  for (const label of ['opus-gate:a#0', 'gate:a#0']) {
    const p = promptOf(calls, label)
    assert.ok(p, `${label} ran`)
    assert.match(p, /The verification evidence carries `lanes`/, `${label} is pointed at the ledger`)
    assert.match(p, /means this unit is UNVERIFIED whatever `pass` says/, `${label} knows a missing lane outranks pass`)
  }
})

test('a pass with an empty lane ledger degrades lane-substituted', async () => {
  const { fn } = makeAgent([{ match: /^verify:/, result: {
    pass: true, blocked: false, failures: [], lanes: [], contractSurfaceTouched: false, diffFiles: [] } }])
  const state = await runWave(fn, makePlan(), makeState())
  const d = (state.degradations ?? []).filter((x) => x.kind === 'lane-substituted')
  assert.equal(d.length, 1, 'an unattributable green is a skill defect, recorded once')
  assert.equal(state.units.a.status, 'merged', 'but it never gates the unit — the exit gate rules on coverage')
})

// =========================================================================================
// 7. STRICT's checkout test is mechanical, and a linked worktree passes it.
// =========================================================================================
test('STRICT: the checkout test is an exit code, and a linked worktree is explicitly valid', async () => {
  const { fn, calls } = makeAgent()
  await runWave(fn, makePlan({ provision: { setup: 'npm ci' } }), makeState())
  const p = promptOf(calls, 'provision:integration')
  assert.ok(p.startsWith('Start by `cd`'), 'STRICT still leads')
  assert.match(p, /`git rev-parse --git-dir`: a NON-ZERO exit is the only failure/, 'mechanical, not a judgement')
  assert.match(p, /A LINKED WORKTREE IS VALID/, 'the case that failed is named — every unit tree is one')
  assert.ok(!/is not the described git checkout/.test(p), 'the judgement-call wording is gone')
  assertAllModelsPinned(calls)
  assertSchemasPresent(calls)
})
