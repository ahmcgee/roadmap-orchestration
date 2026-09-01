// Scripted fakes for the zero-token simulation layer. FROZEN API — conductor.test.mjs is
// written independently against these exact signatures, so treat the exported surface as a
// contract:
//   makeAgent(rules, baseSha?) -> { fn, calls }
//   makeWorkflow(handler)      -> { fn, calls }
//   packRules(plan, state)     -> rules satisfying the launch pack read
//   BASE_SHA, INT_SHA
//   assertAllModelsPinned(calls), assertSchemasPresent(calls), conformsToSchema(result, schema)
//   structuredOutputError()
//
// The fakes are deliberately minimal and honest: they return canned STRUCTURED outputs keyed
// off `opts.label` (short, stable, load-bearing — prompts drift with wording edits, labels
// don't). Every fake result is shallow-checked against the call's own schema so a fake that
// drifts from the harness's schema fails loudly rather than silently feeding a bad shape.
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'

// A plausible-looking 40-char sha used as the default base/integration tip everywhere. Tests
// that probe sha-dependent logic (reconciliation, adopt-tip mismatch) inject their own
// divergent shas; in the default happy path nothing about shas changes, so dependent units
// keep forking a stable tip. INT_SHA is exported for tests that want a distinct value.
export const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
export const INT_SHA = 'b0a9f8e7d6c5b4a3d2e1f0d9c8b7a6f5e4d3c2b1'

// Shared monotonic sequence counter ACROSS makeAgent and makeWorkflow — so a test that mixes
// both fakes can assert cross-fake ordering (e.g. persist-before-dispatch).
let __seq = 0
export const nextSeq = () => __seq++

// The `<crc> <bytes>` line coreutils `cksum` prints for stdin — what a verbatim writer is told to
// expect. Computed by the REAL system tool so every run cross-validates the scripts' in-script
// cksumOf (which the workflow sandbox needs because it has no crypto) against coreutils.
export const sysCksum = (text) => execSync('cksum', { input: text, encoding: 'utf8' }).trim()

// A COURIER call (harness.mjs `courierRun`) is handed a closed, numbered command list and reports
// {command, exitCode, stdout} per command. The fake replays that exact list back with exit 0 and a
// plausible stdout, so the scripts' own pattern-matching — `git rev-parse HEAD` -> the mirror sha,
// `codex login status` -> the /logged in/i probe test — runs for real instead of being
// short-circuited by a canned verdict. A canned {ok:true} here would prove nothing about the code
// that reads the results, which is the whole point of moving those decisions into the script.
// The host-health defaults are a HEALTHY box: pid cgroup nearly empty, ZERO zombies (PID 1 is the
// ordinary devcontainer `sh` supervisor — a name that decides nothing), an idle load. A test that wants a sick box overrides `env-probe:` with its own stdout (see wave-policy).
const courierStdout = (cmd, head) =>
  /\brev-parse HEAD\b/.test(cmd) ? head
    : /codex login status/.test(cmd) ? 'Logged in using ChatGPT (plan: pro)'
      : /codex --version/.test(cmd) ? 'codex-cli 0.52.0'
        : /pids\.current/.test(cmd) ? '412\n36792'
          : /grep -c '\^Z'/.test(cmd) ? '0'
            : /^ps -p 1\b/.test(cmd) ? 'sh'
              : /proc\/loadavg/.test(cmd) ? '1.20 1.05 0.98 3/512 12345'
                : /^nproc$/.test(cmd) ? '16'
                  : ''
export function courierResult(prompt, baseSha, stdoutFor = courierStdout) {
  const block = prompt.split('\nCommands:\n')[1] ?? ''
  const commands = block.split('\n').map((l) => /^\s*\d+\.\s+(.*)$/.exec(l)?.[1]).filter(Boolean)
  assert.ok(commands.length, 'fakes.courierResult: no numbered `Commands:` block — not a courier prompt')
  // A detach in the list MOVES the fake tree, so a later `git rev-parse HEAD` reads the target
  // back. Anything cheaper would let a mirror advance "succeed" against a sha it never reached —
  // exactly the read-back check the script relies on.
  let head = baseSha
  return { ok: true, results: commands.map((command) => {
    const m = /checkout --detach (\S+)/.exec(command)
    if (m) head = m[1]
    return { command, exitCode: 0, stdout: stdoutFor(command, head) }
  }) }
}

// The LAUNCH PACK read — the scripts' first act on a root launch. Given the plan and state a test
// wants the script to see, this returns the rule that satisfies every `pack-read:<file>` courier.
// The `cksum` line comes from the REAL coreutils tool over exactly the bytes the fake echoes back,
// so the verification the script performs at launch runs for real in every sim: a script that
// stopped checking, or checked the wrong candidate, fails here rather than silently accepting a
// mis-transcribed plan. The on-disk file is modelled as `JSON.stringify(...) + "\n"` — the trailing
// newline every writer leaves, and the one the script's two-candidate check exists for.
export function packRules(plan, state) {
  const docs = {
    'plan.json': `${JSON.stringify(plan, null, 2)}\n`,
    'state.json': `${JSON.stringify(state, null, 2)}\n`,
  }
  return [{
    match: /^pack-read:/,
    result: (prompt, opts) => {
      const name = String(opts.label).slice('pack-read:'.length).replace(/#.*$/, '')
      const file = docs[name]
      assert.ok(file !== undefined, `fakes.packRules: no canned document for ${name}`)
      const lines = file.split('\n').slice(0, -1)   // the trailing newline terminates the last line
      return courierResult(prompt, BASE_SHA, (cmd) => {
        if (/^cksum </.test(cmd)) return sysCksum(file)
        if (/^wc -c </.test(cmd)) return String(Buffer.byteLength(file))
        if (/^wc -l </.test(cmd)) return String(lines.length)
        const m = /^sed -n '(\d+),(\d+|\$)p'/.exec(cmd)
        if (!m) return ''
        const a = Number(m[1])
        const b = m[2] === '$' ? lines.length : Number(m[2])
        return `${lines.slice(a - 1, b).join('\n')}\n`
      })
    },
  }]
}

// A spec WRITE report (conductor `spec-expand:` / `spec-revise:`). The conductor composes the exact
// bytes and verifies them by `cksum`, so an honest fake has to produce the cksum of the document the
// prompt actually carries — computed with the REAL coreutils tool, which is what cross-validates the
// script's in-script cksumOf on every run (the same trick packRules uses for the launch pack).
// The document is every line after the <<<DOCUMENT>>> marker; the here-doc that writes it leaves one
// trailing newline. `mutate` lets a test corrupt the transcription the way a real writer would.
export const specWriteOk = (prompt, mutate = (t) => t) => {
  const at = String(prompt).indexOf('<<<DOCUMENT>>>\n')
  // spec-revise carries no document: nothing is compared against its cksum, so any line will do.
  if (at === -1) return { ok: true, cksum: '0 0', detail: '' }
  const doc = String(prompt).slice(at + '<<<DOCUMENT>>>\n'.length)
  return { ok: true, cksum: sysCksum(`${mutate(doc)}\n`), detail: '' }
}

// ---- built-in default results, keyed by harness label prefix ---------------------------
// Each entry: [labelMatches(label) -> bool, (baseSha, prompt, opts) -> freshResultObject]. Colons in
// the prefixes disambiguate siblings (`gate:` never matches `gate-verify:` etc.), but the list is
// ordered specific-first defensively. Every generator returns a FRESH object per call so the
// harness can never mutate a shared canned result across units.
const DEFAULTS = [
  // priorTipAncestorExit: the exit code of `merge-base --is-ancestor <checkpointed tip> <branch>`.
  // 0 = the checkpointed tip is on the branch, which is the only state the tip reconcile adopts.
  [(l) => l === 'integration-worktree', (b) => ({ ok: true, sha: b, priorTipAncestorExit: 0 })],
  [(l) => l.startsWith('setup:'), (b) => ({ ok: true, sha: b, state: 'ready' })],
  [(l) => l.startsWith('adopt-tip:'), (b) => ({ ok: true, sha: b })],
  // Closed-list git couriers (gitProbe): exit codes in the order the script interpolated the
  // commands, nothing interpreted. `merged-probe:` -> branch exists (0), NOT a second parent of any
  // merge commit on the integration branch (1), worktree directory present (0) — i.e. an ordinary
  // unmerged unit. `merge-reach:` -> HEAD on the integration branch (0), unit branch an ancestor
  // (0), reported head reachable (0) — i.e. a merge that really landed on the branch.
  [(l) => l.startsWith('merged-probe:'), () => ({ ok: true, exitCodes: [0, 1, 0], out: [] })],
  [(l) => l.startsWith('merge-reach:'), () => ({ ok: true, exitCodes: [0, 0, 0], out: [] })],

  [(l) => l.startsWith('opus-plan-check:'), () => ({ verdict: 'approve', trigger: 'none', guidance: '' })],
  [(l) => l.startsWith('plan-check:'), () => ({ verdict: 'approve', guidance: '' })],
  [(l) => l.startsWith('replan:'), () => ({ approach: 'x', files: [], testPlan: 'x', feasible: true })],
  [(l) => l.startsWith('plan:'), () => ({ approach: 'x', files: [], testPlan: 'x', feasible: true })],

  [(l) => l.startsWith('opus-gate-verify:'), () => verifyOk()],
  [(l) => l.startsWith('gate-verify:'), () => verifyOk()],
  [(l) => l.startsWith('verify:'), () => verifyOk()],

  [(l) => l.startsWith('opus-gate:'), () => ({ verdict: 'approve', trigger: 'none', directives: [], debt: [] })],
  [(l) => l.startsWith('gate:'), () => ({ verdict: 'approve', directives: [], debt: [] })],

  // Codex lane: the steering agent's report = S.impl + process metadata. The default is a clean
  // one-commit run; tests probing failure axes (exit!=0, no commits, limitHit, timeout) override
  // with their own `codex` block.
  [(l) => l.startsWith('codex-probe:'), (b, p) => courierResult(p, b)],
  // Host-health preflight (pid-cgroup headroom, PID 1, load) — a courier like the codex probe.
  [(l) => l.startsWith('env-probe:'), (b, p) => courierResult(p, b)],
  // The cross-model spec critique fires on EVERY fresh build whose risk is in planCheckRisk
  // (the shipped default is all three tiers), so it needs a default or every wave records four
  // spurious degradations. Clean-and-silent: ok with nothing to say, so the plan-check prompt
  // stays byte-identical to the no-critique form.
  [(l) => l.startsWith('codex-spec-review:'), () => codexRoleOk({ questions: [], risks: [], notes: '' })],
  // The CODEX ROLE ADAPTER (`run(brief, {model:'codex', …})`) dispatches one Haiku courier whose
  // report is the caller's schema nested under `result`. Tests drive a synthetic role by labelling
  // it `codex-role:<name>`; real roles keep their own label (`codex-spec-review:` above) and get
  // their own entry, exactly like every other lane here.
  [(l) => l.startsWith('codex-role:'), () => codexRoleOk({})],
  [(l) => l.startsWith('codex-build-retry:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-build:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-fix:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-gap-fix:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-opus-gate-fix:'), () => implCodexOk()],
  [(l) => l.startsWith('codex-gate-fix:'), () => implCodexOk()],

  [(l) => l.startsWith('merge:'), (b) => mergeOk(b)],
  [(l) => l.startsWith('resolve:'), (b) => mergeOk(b)],
  [(l) => l.startsWith('integration-fix:'), (b) => mergeOk(b)],


  [(l) => l.startsWith('mirror:'), (b, p) => courierResult(p, b)],
  [(l) => l.startsWith('preview-setup'), (b, p) => courierResult(p, b)],
  [(l) => l === 'preview-worktree', (b, p) => courierResult(p, b)],
  [(l) => l.startsWith('provision:'), () => ({ ok: true })],
  [(l) => l.startsWith('dossier-write:'), () => ({ ok: true })],
  [(l) => l.startsWith('spec-append:'), () => ({ ok: true })],   // adjudication rulings appended to the spec
  [(l) => l.startsWith('issue-sync:'), () => ({ ok: true })],   // issue-mode wave-tail projection sweep
  // The flake band is the ONE boundary job that still has a Haiku verbatim-writer: it is a test
  // runner rather than a codex role, so it has no filesystem of its own. explorer/health/design
  // write their own reports now (0.14.0), and their `*-write:` couriers are gone.
  [(l) => l.startsWith('flake-write:'), () => ({ ok: true })],

  // The conductor's verbatim spec writers. Defaulted here so every conductor drive gets an HONEST
  // report — one whose cksum matches the document the prompt carries — rather than a bare ok:true
  // that the script would now (correctly) refuse.
  [(l) => l.startsWith('spec-expand:'), (b, p) => specWriteOk(p)],
  [(l) => l.startsWith('spec-revise:'), (b, p) => specWriteOk(p)],

  [(l) => l.startsWith('rescue-dossier:'), () => ({ attempted: 'a', evidence: 'e', hypothesis: 'h' })],
  [(l) => l.startsWith('dossier:'), () => ({ attempted: 'a', evidence: 'e', hypothesis: 'h' })],
  [(l) => l.startsWith('consult:'), () => ({ action: 'redirect', guidance: 'g' })],
  // The three BOUNDARY ROLES moved onto the codex role adapter in 0.14.0, so what the harness
  // records at these labels is the STEERING COURIER's report — the role's own result nested under
  // `result` — not the bare boundary schema. `flake:` is still a direct Haiku call and keeps its
  // bare shape.
  [(l) => l.startsWith('explorer:'), (b) => codexRoleOk({ findings: [], shaObserved: b })],
  [(l) => l.startsWith('health:'), () => codexRoleOk({ findings: [], fixUnits: [] })],
  [(l) => l.startsWith('flake:'), () => ({ runs: 3, flips: [] })],
  [(l) => l.startsWith('design:'), (b) => codexRoleOk({ findings: [], fixUnits: [], visionUsed: true, shaObserved: b })],
]

export const verifyOk = () => ({ pass: true, blocked: false, failures: [],
  lanes: [{ command: 'npm run test:ci', exitCode: 0 }], contractSurfaceTouched: false, diffFiles: [] })
const implOk = () => ({ summary: 'done', filesChanged: [] })
export const codexMetaOk = () => ({ exitCode: 0, commits: 1, turns: 1, inputTokens: 0, outputTokens: 0,
  timedOut: false, doneMarker: true, limitHit: false, sessionCaptured: true, error: '' })
export const implCodexOk = () => ({ ...implOk(), codex: codexMetaOk() })
// A codex ROLE courier's report. Its `codex` block carries no `commits`/`doneMarker` — a role has
// no diff base and no DONE-WHEN file — which is exactly the shape S.codexRoleReport asks for.
export const codexRoleMetaOk = () => ({ exitCode: 0, turns: 1, inputTokens: 0, outputTokens: 0,
  timedOut: false, limitHit: false, sessionCaptured: true, error: '' })
export const codexRoleOk = (result) => ({ ok: true, result, codex: codexRoleMetaOk(), notes: '' })
// A role whose codex run died: no `result` at all (the courier is forbidden from inventing one).
export const codexRoleDead = (codex = {}) =>
  ({ ok: false, codex: { ...codexRoleMetaOk(), exitCode: 1, ...codex }, notes: 'no last-message file' })
const mergeOk = (b) => ({ merged: true, suitePass: true, head: b, detail: '' })

const defaultFor = (label, baseSha, prompt, opts) => {
  for (const [matches, make] of DEFAULTS) if (matches(label)) return make(baseSha, prompt, opts)
  return undefined
}

// conformsToSchema — shallow: every schema.required key must exist on the result. Used to
// catch fake/schema drift (a canned result that forgot a field the harness now requires).
export function conformsToSchema(result, schema) {
  if (!schema || !Array.isArray(schema.required)) return true
  if (result === null || typeof result !== 'object') return false
  return schema.required.every((k) => k in result)
}

// makeAgent(rules, baseSha) — `fn` is the `agent` global. rules: [{match: RegExp (tested
// against opts.label), result: object | (prompt, opts) => object|Promise|throws}], first match
// wins; unmatched labels with no built-in default throw (fail-loud). A rule's result function
// may throw to inject errors (see structuredOutputError), or return `null` to simulate the
// platform's own death signal (agent() resolves to null when a subagent dies). Every invocation is
// recorded to `calls` at call time (so a deferred/parked result is still recorded in issue order).
export function makeAgent(rules = [], baseSha = BASE_SHA) {
  const calls = []
  const fn = (prompt, opts = {}) => {
    const label = opts.label ?? '(unlabeled)'
    calls.push({
      seq: nextSeq(),
      label,
      model: opts.model,
      effort: opts.effort,
      phase: opts.phase,
      prompt,
      hasSchema: !!opts.schema,
      schema: opts.schema,
    })
    return (async () => {
      const rule = rules.find((r) => r.match.test(label))
      let producer
      if (rule) {
        producer = rule.result
      } else {
        const d = defaultFor(label, baseSha, prompt, opts)
        if (d === undefined)
          throw new Error(`fakes.makeAgent: unmatched label "${label}" — no rule and no built-in default (fail-loud)`)
        producer = d
      }
      let val = typeof producer === 'function' ? producer(prompt, opts) : producer
      val = await val // a throwing producer rejects here, before conformance
      // `null` is not schema drift — it is the platform's OTHER death signal. agent() RESOLVES to
      // null (with no error object at all) when a subagent dies, which is a different code path in
      // the scripts from a throw, and a rule returning null is the only way to simulate it.
      if (val === null) return null
      if (opts.schema && !conformsToSchema(val, opts.schema))
        throw new Error(
          `fakes.makeAgent: canned result for "${label}" violates its schema — ` +
            `required=${JSON.stringify(opts.schema.required)} got keys=${JSON.stringify(Object.keys(val ?? {}))}`,
        )
      return val
    })()
  }
  return { fn, calls }
}

// makeWorkflow(handler) — `fn` is the `workflow` global. Records {seq, scriptPath, args} and
// returns handler(args, callIndex). (Unused by harness.test.mjs — the harness never nests —
// but part of the frozen surface conductor.test.mjs depends on.)
export function makeWorkflow(handler) {
  const calls = []
  let idx = 0
  const fn = (ref, args) => {
    const callIndex = idx++
    calls.push({ seq: nextSeq(), scriptPath: ref?.scriptPath ?? ref, args })
    return handler(args, callIndex)
  }
  return { fn, calls }
}

// Every delegation must pin a real model tier — an omitted model silently inherits the
// main-loop (frontier) model on the real platform.
export function assertAllModelsPinned(calls) {
  const ok = new Set(['fable', 'opus', 'sonnet', 'haiku'])
  for (const c of calls)
    assert.ok(ok.has(c.model), `call "${c.label}" (seq ${c.seq}) has an unpinned/invalid model: ${JSON.stringify(c.model)}`)
}

// Every delegation must carry a schema — the harness never parses prose.
export function assertSchemasPresent(calls) {
  for (const c of calls) assert.ok(c.hasSchema, `call "${c.label}" (seq ${c.seq}) is missing a schema`)
}

// An error whose message contains 'StructuredOutput' — the harness's run() wrapper retries
// exactly these once (any other error propagates). Used to pin the retry contract.
export function structuredOutputError() {
  return new Error('fake agent failure: StructuredOutput report failed validation (payload too long)')
}
