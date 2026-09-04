export const meta = {
  name: 'roadmap-conductor',
  description: 'Loop multiple roadmap waves in one run, routing each boundary through a tiered triage ladder',
  phases: [
    { title: 'Launch', detail: 'verified plan/state pack read (Haiku)' },
    { title: 'Wave', detail: 'dispatch one wave via the harness workflow' },
    { title: 'Census', detail: 'feedback + quarantine folder census (Haiku)' },
    { title: 'Triage-opus', detail: 'tier-2 boundary triage (Opus)' },
    { title: 'Triage-fable', detail: 'tier-3 boundary agent + quarantine respec (Fable)' },
    { title: 'Spec-expand', detail: 'render new-unit skeletons to specs (Sonnet)' },
    { title: 'Persist', detail: 'feedback archive + issue projection (Haiku)' },
  ],
}

/* ------------------------------------------------------------------------
 * conductor.mjs — a top-level Workflow script that runs the arc's waves in a
 * single launch, so the root wakes once per RUN instead of once per boundary
 * (each wake is an uncached full-history reload past the 5-min prompt-cache TTL).
 *
 * Runtime is identical to harness.mjs: globals `args, agent, workflow, log,
 * phase, budget`; NO filesystem, NO Date.now/Math.random. It consumes the one
 * allowed workflow-nesting level (conductor -> harness); the harness stays
 * leaf-only. Idioms are mirrored from harness.mjs deliberately:
 *   - defensive stringified-args parse (a stringified args object makes every
 *     destructured field undefined and agents improvise in their cwd);
 *   - the LAUNCH-salted, cksum-verified launch pack read (below);
 *   - obj/arr/oneOf schema helpers, additionalProperties:false, maxLength caps,
 *     and a `notes` pressure-release on tight schemas;
 *   - the STRICT fail-loud location preamble for mechanical agents;
 *   - run(), a thin agent() wrapper that pins model+schema, tallies per-tier
 *     spend, and retries ONCE on a StructuredOutput validation failure;
 *   - deterministic prompts: pure functions of the wave number, unit ids, shas,
 *     and the JSON of in-memory structured data, so resumeFromRunId replays
 *     completed calls (both this script's and the child harness's) for free.
 *
 * Inputs: args = { roadmapDir, launchId, config, harnessPath }. The root MUST
 * pass `harnessPath` (absolute path to harness.mjs) and `roadmapDir` (absolute
 * path to the arc's .roadmap directory). `config` is the caller's raw config and
 * is threaded to the harness UNTOUCHED (the conductor never sets boundary:'off'
 * itself — ruling 1). Conductor knobs live under plan.config.conductor /
 * config.conductor; the harness ignores unknown keys.
 *
 * Outputs: this script writes NOTHING under .roadmap/. Every wave's state, the
 * merged plan, the debt, the journal and both event ledgers ride home in the
 * RETURN envelope, and `persist.mjs` — a real Node process replaying this run's
 * journal at zero model cost — is what puts them on disk. The writes it replaces
 * were the second-largest model cost in the system after the root's own wakes.
 * See reference.md "Who writes `.roadmap/`".
 * ---------------------------------------------------------------------- */

// args can arrive JSON-stringified depending on how the caller encoded them — tolerate both.
const A = typeof args === 'string' ? JSON.parse(args) : args
// `launchId` is a per-launch nonce the root regenerates on every launch AND every resume. It salts
// this script's own launch pack read and is passed straight through to each wave so the harness can
// salt its ENVIRONMENT probes out of resumeFromRunId's cache (harness.mjs, LAUNCH).
const { roadmapDir, config: overrides, harnessPath, launchId } = A
// Neither is optional: without harnessPath the wave dispatch cannot resolve the child script, and
// without roadmapDir there is no pack to read.
if (!harnessPath)
  throw new Error('conductor requires args.harnessPath (absolute path to harness.mjs) — the root must pass it')
if (!roadmapDir)
  throw new Error('conductor requires args.roadmapDir (absolute path to the arc\'s .roadmap directory) — the root must pass it')
const LAUNCH = launchId
  ? `\nProbe id ${launchId} — this line exists only to make this request unique; ignore it.`
  : ''

/* --------------------------- schema helpers ---------------------------- */
// Declared here rather than beside the schemas: the launch pack's courier needs them before any
// plan-dependent line has run.
const obj = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required })
const arr = (t) => ({ type: 'array', items: { type: t } })
const oneOf = (vals) => ({ type: 'string', enum: vals })
const strArr = (maxItems, maxLength) => ({ type: 'array', maxItems, items: { type: 'string', maxLength } })

/* ------------------------- courier vocabulary -------------------------- */
// Location discipline for mechanical agents (copied from harness.mjs). The Bash tool's working
// directory RESETS between tool calls — arc-observed here, in this script's own `move-feedback:w1`
// (wf_318afa1b-e9d): it cd'd to the fixture, then read `/workspaces/roadmap-orchestration` out of
// the NEXT call's `git rev-parse --show-toplevel`, checked four relative paths in the wrong repo
// and reported them missing. An earlier `cd` is worth nothing, so every command must carry its own.
const STRICT = 'THE WORKING DIRECTORY DOES NOT PERSIST BETWEEN COMMANDS. Every command you run starts wherever ' +
  'your session began, not where the previous one left off, so a `cd` you ran earlier buys you nothing and a bare ' +
  'relative path silently runs in some other repository. EVERY command must therefore be SELF-CONTAINED: begin it ' +
  'with `cd <the exact absolute path this task names as your working directory> && `, or address every path ' +
  'absolutely (`git -C <path> ...`). Never rely on an earlier `cd`. PROVE the location IN THE SAME COMMAND as the ' +
  'work it guards, never in a command of its own: `cd <path> && pwd` must print that path exactly, character for ' +
  'character, and where the path is inside a git checkout `cd <path> && git rev-parse --show-toplevel` names WHICH ' +
  'checkout you are in — it must print either that same path or a directory the path sits under. If a cd fails, or ' +
  'either proof prints anything else, report ok/pass as false with what it actually printed and stop — never carry ' +
  'on in the directory you happened to start in. A LINKED WORKTREE IS VALID — its `.git` is a FILE and the toplevel ' +
  'it prints is the worktree\'s own root, which is not a defect and must never be reported as one. Never ' +
  'substitute your current working directory, the enclosing project, or any other repository. '
// EVERY prompt whose schema carries a maxLength must also carry this (same const as harness.mjs).
// A cap is a contract with the model, and the prompt is the only place that contract is stated — a
// capped field with no matching instruction is a trap. Arc-observed: this prompt set had a 600-char
// `notes` cap, no terseness clause, and a closing line inviting the agent to put overflow THERE. It
// overran, exhausted its schema-retries, and died at two consecutive boundaries. See RATIONALE §9.
const TERSE = 'Keep every free-text field terse — an oversized report fails schema validation and the work is ' +
  'lost. Free-text fields are for what the structured fields cannot carry, not a transcript of your reasoning. ' +
  'Respect every character budget named below exactly, and emit no field the schema does not define — an ' +
  'unexpected key is rejected as hard as an over-long one. '
// The ONE canonical way to have a cheap agent run shell on this script's behalf: a CLOSED LIST of
// exact commands whose verbatim output the SCRIPT judges, never a goal with destructive reach.
// Mirrored from harness.mjs — see the long rationale there; keep the two in sync
// (shared-consts.test.mjs enforces it).
const COURIER_OUT = 1200
// THE WORKING DIRECTORY IS PART OF THE COMMAND, never a thing the model is asked to arrange.
// STRICT's `cd` sentence explains the rule; this composes it. Arc-observed (wf_106cdf59-c5f): a
// courier read the sentence, never cd'd, and ran an entire preview list in the workflow session's
// OWN checkout — `git worktree add --detach <prevWt> <sha>` failed with "invalid reference" against
// a repository that had never heard of that sha, and a setup courier reported this repo's HEAD as
// the unit's. With the prefix, a wrong or missing directory is a NON-ZERO EXIT of that numbered
// command, which the stop-at-first-failure rule already handles — no compliance required.
// Throws on an empty path: an undefined path interpolated into a prompt is exactly how an agent
// ends up improvising in its own cwd, and a loud compose-time failure beats a plausible report.
// Mirrored from harness.mjs — keep the two in sync (shared-consts.test.mjs enforces it).
const cdGuard = (where, cmd) => {
  if (typeof where !== 'string' || !where.trim())
    throw new Error(`cdGuard: a command needs an explicit absolute working directory (got ${JSON.stringify(where)}) — ` +
      'a path the script did not compose is a path the model will improvise')
  return `cd '${where.replace(/'/g, "'\\''")}' && ( ${cmd} )`
}
// POSIX single-quoting for the paths and bodies THIS script interpolates into a composed command —
// the same escape cdGuard applies to its directory. A feedback filename and a triage reason are both
// model-supplied text, and text that reaches a shell unquoted is a command the script did not write.
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
const courierSchema = (n, outMax = COURIER_OUT) => obj({
  ok: { type: 'boolean' },
  results: { type: 'array', maxItems: n, items: obj({
    exitCode: { type: 'number' },
    stdout: { type: 'string', maxLength: outMax },
  }, ['exitCode', 'stdout']) },
  detail: { type: 'string', maxLength: 300 },
}, ['ok', 'results'])
// COURIERS CARRY NO IDENTITY CHECK — cdGuard already composes `cd '<where>' && ( <cmd> )` into every
// numbered command below, so a courier's own starting cwd is never load-bearing; STRICT's `pwd`/
// `--show-toplevel` proof exists for prompts where the SCRIPT never composes the destination.
// Asking a courier to prove it stood there BEFORE running the command it was just told to trust
// invited a literal-minded read: wf_318afa1b-e9d's `provision:integration` courier ran only `pwd`,
// saw a shell cwd that did not match, and reported a fabricated "working directory mismatch" —
// never running the composed command at all. Mirrored in harness.mjs — keep the two in sync
// (shared-consts.test.mjs enforces the courierPrompt block as a whole).
const courierPrompt = (where, commands, extra = '', outMax = COURIER_OUT) =>
  'Do not `cd` anywhere and do not run `pwd` — do not inspect, probe or verify anything before the ' +
  'commands below or between them. Every numbered command already begins with its own working-directory ' +
  'guard, so there is nothing left for you to check about where you are. Run exactly the numbered ' +
  'command(s) at the end of this message, in that order; stop at the first non-zero exit and run nothing ' +
  'else. A command that fails is a RESULT to report — its real exit code and output — never a problem ' +
  'for you to solve. ' +
  `In ${where}: run EXACTLY the ${commands.length} numbered command(s) at the end of this message, in that ` +
  `order, and run NOTHING ELSE — not a variation, not a repair, not a cleanup, not a retry with different ` +
  `flags, not a command you think would help. Each one already carries its own \`cd\` prefix: run it exactly as ` +
  `written, prefix included, and never strip, shorten or "simplify" it — the working directory is part of the ` +
  `command, not a choice of yours. Anything absent from that list is outside your remit: a command ` +
  `that fails is a RESULT to report, never a problem for you to solve. Stop at the first non-zero exit and ` +
  `report what you have. You are a courier, not an operator — no judgement of yours is wanted here, only the ` +
  `exact output. Report \`results\`: one entry per command you actually ran, IN LIST ORDER — position is the ` +
  `only identifier, so never reorder and never leave a gap, and do NOT echo the command text back (the ` +
  `scheduler already has the list it sent). Each entry is {exitCode (the integer the shell returned), stdout ` +
  `(that command's combined stdout and stderr, first ${outMax} characters — truncate, never summarise or ` +
  `paraphrase)}. Report ok:true when you ran the list and reported it faithfully; ok is about YOUR REPORT, not ` +
  `about whether the commands succeeded — the scheduler reads the exit codes itself. Keep \`detail\` to one ` +
  `sentence (max 300 characters), for something the results genuinely cannot carry. ` + TERSE + extra +
  `\nCommands:\n${commands.map((c, i) => `${i + 1}. ${cdGuard(where, c)}`).join('\n')}`
const courierShape = (r, commands) => {
  const n = commands.length
  const results = (Array.isArray(r?.results) ? r.results : []).slice(0, n)
  const bad = results.findIndex((x) => x?.exitCode !== 0)
  const raw = (i) => String(results[i]?.stdout ?? '')
  const out = (i) => raw(i).trim()
  const short = results.length < n
  return {
    ok: bad < 0 && !short,
    results,
    exit: (i) => (typeof results[i]?.exitCode === 'number' ? results[i].exitCode : null),
    out,
    raw,
    detail: bad >= 0
      ? `\`${commands[bad]}\` exited ${results[bad].exitCode} — ${out(bad).slice(0, 300) || '(no output)'}`
      : short
        ? `only ${results.length}/${n} commands reported — ${String(r?.detail ?? 'no reason given').slice(0, 200)}`
        : String(r?.detail ?? ''),
  }
}

/* --------------------------- the launch pack --------------------------- */
// POSIX cksum: CRC-32 (poly 0x04C11DB7, MSB-first, init 0), then the byte length fed in
// little-endian until zero, then complemented. Pure JS over UTF-8 code units, no Buffer.
// Mirrored in harness.mjs — keep the two in sync (shared-consts.test.mjs enforces it).
const CK_TABLE = (() => {
  const t = new Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04C11DB7) : (c << 1)
    t[i] = c >>> 0
  }
  return t
})()
const cksumOf = (s) => {
  let crc = 0, len = 0
  const feed = (b) => { crc = ((crc << 8) ^ CK_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0; len++ }
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (c < 0x80) feed(c)
    else if (c < 0x800) { feed(0xc0 | (c >> 6)); feed(0x80 | (c & 63)) }
    else if (c < 0x10000) { feed(0xe0 | (c >> 12)); feed(0x80 | ((c >> 6) & 63)); feed(0x80 | (c & 63)) }
    else { feed(0xf0 | (c >> 18)); feed(0x80 | ((c >> 12) & 63)); feed(0x80 | ((c >> 6) & 63)); feed(0x80 | (c & 63)) }
  }
  const bytes = len
  for (let l = bytes; l > 0; l >>>= 8) crc = ((crc << 8) ^ CK_TABLE[((crc >>> 24) ^ (l & 0xff)) & 0xff]) >>> 0
  return { crc: (~crc) >>> 0, bytes }
}
const READ_CHUNK = 24000
const PACK_FILES = ['plan.json', 'state.json']
// BACKSLASH-FREE TRANSPORT — the sentinel every read command rewrites backslashes to, and the one
// place either script names it. THE ROOT CAUSE it answers: a courier's report is structured JSON,
// so a backslash in the file has to survive TWO levels of escaping — a `\"` in the document is
// `\\\"` inside the report's string value, and a `—` serialized as `\u2014` is `\\u2014`. Haiku
// drops exactly one of those levels, so every JSON escape in the pack arrived DECODED: 2026-09-02,
// four `\u2014` escapes, and the copy came back 21 characters short (4x5 + the trailing newline);
// 2026-09-04, twelve `\"` sequences, twelve short. Both launches threw `pack-unreadable` before a
// single wave. Telling the courier that "\n and \" are literal characters to copy" is precisely
// what did not work, twice — so the fix is not a better sentence: the READ command now rewrites
// every backslash to a marker that needs no escaping in ANY layer, the courier copies a document
// with no backslash left in it, and the script puts the backslashes back before verifying. The
// verdict is still the ORIGINAL file's `cksum`, so a sentinel that collides with real prose in the
// document fails loud exactly like a truncation rather than silently rewriting the pack.
// The marker must stay pure ASCII with no character that is special to sh, sed, JSON or a regex
// replacement, and implausible in JSON prose.
// Mirrored in conductor.mjs — keep the two in sync (shared-consts.test.mjs enforces it).
const PACK_BS = '@@BSLASH@@'
const PACK_EXTRA = `These commands only READ, and every content command already rewrites each backslash in the file to the ` +
  `literal marker ${PACK_BS}, so nothing in the text you copy needs escaping of any kind. Copy each command's output ` +
  `through verbatim — byte for byte, including leading indentation, blank lines, and every ${PACK_BS} marker exactly ` +
  `where it appears. Never pretty-print, re-indent, re-escape, decode, summarise, elide or abbreviate: the scheduler ` +
  `puts the backslashes back and verifies the result against the file's own \`cksum\`, and a document that does not ` +
  `match is thrown away. If a document is too long to reproduce in full, report ok:false and say so in \`detail\` — a ` +
  `truncated copy is worse than no copy. `
// Read ONE pack file over the given line ranges (one command each) and verify it. Each content
// command pipes its range through `sed` once more to swap every backslash for PACK_BS, so the
// courier never has to escape anything; the script swaps them back below. The whole file's
// `cksum` is the ONLY verdict: the sentinel round trip and the ranges are both transport, so a
// dropped line, a decoded escape, a summarised tail and a document that already contained the
// sentinel all fail the same check, and the courier's only honest move on a mismatch is to report
// it. Resolves { text } on a match, or { fail, bytes, lines } describing what did not line up.
const readPackFile = async (path, ranges, label, extra) => {
  const cmds = [`cksum < ${path}`, `wc -c < ${path}`, `wc -l < ${path}`,
    ...ranges.map(([a, b]) => `sed -n '${a},${b}p' ${path} | sed 's/\\\\/${PACK_BS}/g'`)]
  const r = courierShape(
    await agent(courierPrompt(roadmapDir, cmds, PACK_EXTRA + extra + LAUNCH, READ_CHUNK),
      { model: 'haiku', effort: 'low', phase: 'Launch', label, schema: courierSchema(cmds.length, READ_CHUNK) })
      .catch(() => null),
    cmds)
  const bytes = Number(r.out(1)) || 0
  const lines = Number(r.out(2)) || 0
  if (!r.ok) return { fail: r.detail || 'courier died without a report', bytes, lines }
  const want = r.out(0).split(/\s+/).slice(0, 2).join(' ')
  // Each range's capture ends in the newline of its last line; the join puts exactly one back, and
  // the sentinel is reversed here — the document the cksum judges is the one with backslashes in it.
  const body = ranges.map((_, i) => r.raw(3 + i).replace(/\n$/, '')).join('\n').split(PACK_BS).join('\\')
  // Two candidates, one document: a report is trimmed in transport, and a JSON file conventionally
  // ends in exactly one newline. Nothing else is accepted.
  for (const text of [body, `${body}\n`]) {
    const ck = cksumOf(text)
    if (`${ck.crc} ${ck.bytes}` === want) return { text, bytes, lines }
  }
  return { fail: `transcription does not match \`cksum\` (${want}) of the ${bytes}-byte file — ${body.length} characters copied ` +
    `(the copy was truncated or mangled in transport, or the file itself contains the ${PACK_BS} transport sentinel)`, bytes, lines }
}
// Read the whole pack, verified. One courier per file, in parallel — the common case is one call
// each. A file that fails its cksum is re-read ONCE: over line ranges when it is simply too big for
// one response, otherwise by a fresh courier whose prompt differs (mis-transcription is per-sample
// stochastic, so a fresh sample is worth one try — and a differing prompt is what stops
// `resumeFromRunId` serving the bad sample straight back). After that the launch FAILS LOUD: a wave
// dispatched from a plan nobody can vouch for is worse than a wave that never started.
const readPack = async () => {
  const attempt = (name, ranges, extra, suffix) =>
    readPackFile(`${roadmapDir}/${name}`, ranges, `pack-read:${name}${suffix}`, extra)
  const text = {}
  const why = {}
  const record = (n, r) => { if (r.text !== undefined) text[n] = r.text; else why[n] = r }
  const first = await parallel(PACK_FILES.map((n) => () => attempt(n, [[1, '$']], '', '')))
  PACK_FILES.forEach((n, i) => record(n, first[i]))
  const again = PACK_FILES.filter((n) => text[n] === undefined)
  const second = await parallel(again.map((n) => () => {
    const { bytes, lines } = why[n]
    if (bytes <= READ_CHUNK || lines < 2)
      return attempt(n, [[1, '$']], 'A previous courier\'s copy of this file did not match its cksum; read it again from scratch. ', '#retry')
    // Too big for one response: split the LINES into ceil(bytes / READ_CHUNK) ranges. The
    // whole-file cksum still decides, so an uneven split is a transport detail, never a risk.
    const per = Math.ceil(lines / Math.ceil(bytes / READ_CHUNK))
    const ranges = []
    for (let a = 1; a <= lines; a += per) ranges.push([a, Math.min(a + per - 1, lines)])
    return attempt(n, ranges, `This file is ${bytes} bytes — too long for one report — so it is read in ${ranges.length} line ranges. Report each range's output exactly as printed. `, '#split')
  }))
  again.forEach((n, i) => record(n, second[i]))
  const missing = PACK_FILES.filter((n) => text[n] === undefined)
  if (missing.length)
    throw new Error(`pack-unreadable: no verified copy of ${missing.join(' + ')} under ${roadmapDir} after two ` +
      `attempts — ${missing.map((n) => `${n}: ${why[n].fail}`).join('; ')}`)
  const parsed = {}
  for (const n of PACK_FILES) {
    try { parsed[n] = JSON.parse(text[n]) }
    catch (e) { throw new Error(`pack-unreadable: ${roadmapDir}/${n} is cksum-verified but does not parse — ${String(e?.message ?? e)}`) }
  }
  log(`launch pack read from ${roadmapDir}: ${PACK_FILES.map((n) => `${n} ${text[n].length}b`).join(', ')}`)
  return { plan: parsed['plan.json'], state: parsed['state.json'] }
}
const { plan: inPlan, state: inState } = await readPack()

// Conductor config: defaults, then plan.config.conductor, then the caller's config.conductor.
const CC = {
  maxWavesPerRun: 3,           // wave-loop bound; exhaustion -> max-waves (a fresh relaunch resets the 1000-agent counter)
  boundaryTriage: 'opus-first', // 'opus-first' full ladder | 'always-fable' skip Opus | 'root' every boundary returns
  agentBudgetReserve: 200,     // headroom below the 1000-call cap; the pre-wave guard returns before crossing
  perUnitCallEstimate: 15,     // pre-wave budget estimate per dispatchable unit; corrected by harness spend deltas
  fixUnitAdmit: 'auto',        // 'auto' tier-1 mechanical admit of health drafts | 'triage' force >=Opus veto when drafts present
  // 'open' | 'closed'. The architect flips this to 'closed' once the plan is DRAINED. Under
  // 'closed' tiers 1 and 2 admit NOTHING: drafts and promotions become debt-ledger lines, in CODE,
  // not by asking a triager nicely. Arc-observed: after PLAN DRAINED at wave 17, waves 18 and 19
  // kept admitting 7 and 8 fresh drafts, so the merged fraction sat at ~93% for 12+ hours while the
  // denominator grew in lockstep. Every other brake in this file is prose an Opus turn can
  // rationalise past; this one is not. The single exception is a finding graded `blocker`, which is
  // routed to the architect tier to be RULED on rather than auto-admitted.
  admissions: 'open',
  // Tier 1 admits health/design drafts mechanically, with no judgment and no cut line applied. That
  // is acceptable for a trickle and not for a batch: a healthy assessor drafts something every wave,
  // so a large batch is exactly the denominator growth above, arriving without anyone deciding. Past
  // this count the wave buys an Opus triage instead, which does apply the cut line.
  tier1MaxDrafts: 3,
  fableEffort: 'high',         // effort for the Fable boundary agent (respec/escalation arbiter) — Fable 5's high default for real adjudication
  opusEffort: 'medium',        // effort for the Opus tier-2 triager — mirrors the harness's opusEffort knob
  ...(inPlan.config?.conductor ?? {}),
  ...(overrides?.conductor ?? {}),
}

const repo = inPlan.repoPath   // absolute path to the repository (agents read .roadmap/ here)

// GitHub issue projection (issue mode only; reference.md "GitHub issue tracking"). Mirrors harness.mjs:
// issues are a Haiku-written projection of state, never read by this script's routing. Every gh clause
// below is '' in file mode, keeping those prompts byte-identical to the legacy path. Best-effort: a gh
// failure records a `gh-sync` degradation and continues.
const issueMode = inPlan.tracking === 'issues'
const ghRepo = inPlan.repoSlug ? `--repo ${inPlan.repoSlug} ` : ''
// `gh` has no `-C`: without `--repo` it reads the repository out of its WORKING DIRECTORY, and a Bash
// tool's working directory RESETS between commands (wf_318afa1b-e9d). So every gh command this script
// composes carries its own `cd`, exactly as cdGuard does for a courier's list — redundant when a
// repoSlug supplies `--repo`, load-bearing when the plan has none, and free either way.
// Mirrored in the other workflow script — keep the two in sync (shared-consts.test.mjs enforces it).
const GH_HERE = `cd '${repo}' && gh`
const GH_BEST_EFFORT = 'Do the GitHub-issue steps below on a BEST-EFFORT basis: if any gh command errors (no ' +
  'network, auth, rate limit, missing issue), ignore it and carry on — issue state is observability, never a gate. ' +
  `Write every gh command you compose yourself as \`${GH_HERE} …\`: your working directory does not persist ` +
  'between commands, and without `--repo` gh reads the repository from wherever it happens to be standing. '
// Find-or-create by BODY MARKER, made mechanical. `--search '"<marker>" in:body'` is GitHub
// FULL-TEXT search: it tokenizes the marker, so `id=raise-verbs` matched an unrelated open agenda
// issue, `id=sweep-truth` a closed unit from a prior arc, and a Phase-0 bootstrap "reused" three
// live issues — overwriting title and body, swapping status:merged for status:pending, moving them
// into the new milestone (2026-08-22; 8 of 11 mis-resolved again on 2026-08-23). A hit is therefore
// a CANDIDATE ONLY, and the exactness test belongs in the shell string THIS SCRIPT composes rather
// than in model compliance: the jq predicate below requires the candidate body's FIRST LINE to be
// exactly the marker comment. Prints `<number> <OPEN|CLOSED>` for the one exact match, or nothing.
// Duplicated across harness.mjs and conductor.mjs (neither can import the other) — keep them in
// sync; shared-consts.test.mjs fails the build if they drift.
const markerFind = (marker) => `${GH_HERE} issue list ${ghRepo}--search '"${marker}" in:body' --state all --limit 30 ` +
  `--json number,body,state --jq '[.[] | select(((.body // "") | split("\\n")[0] | sub("\\r$"; "")) == ` +
  `"<!-- ${marker} -->")] | .[0] | select(. != null) | "\\(.number) \\(.state)"'`
// The obligations that ride with every markerFind. Duplicated in both scripts — keep them in sync.
const MARKER_RULE = 'Run that search command EXACTLY as written: its jq predicate is what makes the match ' +
  'trustworthy, requiring the candidate body\'s FIRST line to be exactly the marker comment. Never widen the ' +
  'search, never fall back to `.[0].number`, and never adopt an issue you found some other way — no exact ' +
  'match means ABSENT, and absent means create. Never edit the labels, milestone, title or body of a CLOSED ' +
  'issue, and never remove a `status:merged` label. '
// The arc key every marker this script mints is scoped by. Without it, `roadmap:debt wave=3 ledger`
// searched across ARCS and matched a prior arc's wave 3 (#1011), which would have silently skipped
// creation; the per-unit `wave=N unit=<id>` marker collides the same way whenever a unit id recurs.
const arcKey = inPlan.trackingIssue ?? inPlan.milestone
// Admissions, enforced in code (not in a prompt an Opus turn can rationalise past). `closed`
// never routes work AWAY from judgment — it only stops judgment from minting units — so it can
// never weaken the termination guarantee. Read by the tier router and by collect()'s bank.
const admissionsClosed = CC.admissions === 'closed'

// Working plan — cloned so wave-to-wave mutation (merged units, edges, cut lines) never aliases
// the caller's object. This is what is persisted and returned; the transient contingent
// withholding below dispatches a SEPARATE copy so a withheld inScope:false is never mistaken
// for a root decision (ruling 2).
let plan = {
  ...inPlan,
  units: (inPlan.units ?? []).map((u) => ({ ...u })),
  edges: (inPlan.edges ?? []).map((e) => ({ ...e })),
}
let state = inState
let wavesRun = 0
// conductor block, checkpointed into state.json every boundary + before every return: forensics
// spine + rung-3 recovery signal. reason is null while in flight, the frozen reason on return.
// `boundaries` is ARC-cumulative (seeded from the passed state's conductor block, same semantics
// as the harness's spend tally): a root adjudication mid-arc relaunches the conductor, and
// without seeding, each relaunch would erase the prior runs' boundary forensics.
const boundaries = (inState.conductor?.boundaries ?? []).map((b) => ({ ...b }))   // [{ wave, tier, escalated: <reason|null> }]
// Last wave's boundary evidence, kept for the max-waves return. Ruling 1 gives the root the final
// wave's evidence on any TERMINAL return, and max-waves is terminal — but it is the one terminal
// return the conductor cannot see coming: every other path returns before the persist step, whereas
// max-waves only becomes terminal after the loop has already triaged the wave and cleared its
// boundary as a continuation. Eval-observed 2026-07-19: a 3-wave run returned max-waves with no
// boundary block at all, so the root relaunching had nothing to read.
let lastBoundary = null
let lastBoundaryWave = null

/* --------------------------- spend accounting -------------------------- */
// Per-tier tally of THIS script's own agent() calls, plus the two conductor-specific counters.
// Merged into the returned/persisted state's arc-cumulative `spend` so the session report sees
// where conductor attention went; a watermark (cMerged) makes the merge idempotent across the
// several persist points so threaded-forward spend is never double-counted.
const cSpend = { fable: 0, opus: 0, sonnet: 0, haiku: 0, boundaryTriages: 0, boundaryFables: 0 }
let cMerged = { ...cSpend }
// Budget arithmetic counts MODEL-TIER keys only: spend also carries derived counters
// (planChecks, gateRounds, boundaryTriages, …) that subset the tier counts — summing
// everything double-counts each gate/check round and trips the guard early. `codex` and the
// codexRuns/token counters stay out for a different reason: the budget guarded here is CLAUDE
// attention, and codex is precisely the thing 0.14.0 moves work ONTO.
const TIER_KEYS = ['fable', 'opus', 'sonnet', 'haiku']
const sumTiers = (o) => TIER_KEYS.reduce((a, k) => a + (typeof o?.[k] === 'number' && Number.isFinite(o[k]) ? o[k] : 0), 0)
const initialSpend = { ...(inState.spend ?? {}) }
const initialSpendTotal = sumTiers(initialSpend)
// Add only the conductor spend accrued since the last merge onto st.spend (idempotent).
function mergeConductorSpend(st) {
  st.spend = { ...(st.spend ?? {}) }
  for (const k of Object.keys(cSpend)) {
    const delta = cSpend[k] - (cMerged[k] ?? 0)
    if (delta) st.spend[k] = (st.spend[k] ?? 0) + delta
  }
  cMerged = { ...cSpend }
}
// Where the arc's attention went, split the way 0.14.0 asks the question: CLAUDE tiers — the
// weekly-limited resource every routing decision is now trying to spend less of — against CODEX,
// which is plentiful and is where the drafting and the building moved. The harness already tallies
// the codex side (`codex` = role dispatches, `codexRuns` = every codex process including the
// build/fix lane's, plus its token counters) and it threads home in `state.spend`; this only splits
// one number into the two an operator actually compares. Arc-CUMULATIVE, like `spend` itself —
// `spendDelta` beside it is this run's contribution.
const spendReport = (sp) => ({
  claude: { ...Object.fromEntries(TIER_KEYS.map((k) => [k, sp?.[k] ?? 0])), total: sumTiers(sp) },
  codex: { roles: sp?.codex ?? 0, processes: sp?.codexRuns ?? 0,
    inputTokens: sp?.codexInputTokens ?? 0, outputTokens: sp?.codexOutputTokens ?? 0 },
})
const deltaSpend = (sp) => {
  const d = {}
  for (const k of new Set([...Object.keys(initialSpend), ...Object.keys(sp ?? {})])) {
    const v = (sp?.[k] ?? 0) - (initialSpend[k] ?? 0)
    if (typeof v === 'number' && v !== 0) d[k] = v
  }
  return d
}

// Debt the conductor has RECEIVED but not yet seen banked. Two reasons it cannot live in
// `state.debt` alone: the harness rebuilds that field from scratch every wave (so an unbanked item
// evaporates at the next dispatch), and the clear used to happen BEFORE the bank call with its
// result never inspected — arc-observed, 23 items vanished at one wave-12 boundary.
let pendingDebt = []
// Skill-defect ledger — the orchestrator misbehaving, not the product (same idiom as harness.mjs).
// THIS RUN's rows only: the conductor's own plus whatever the child harness returns. They ride home
// in the RETURN envelope, and persist.mjs appends them to the arc's append-only
// .roadmap/degradations.jsonl. Nothing re-transcribes them and they never ride in state.json
// (carrying a ledger there is what made every write bigger than the last).
const degradations = []
const degrade = (o) => {
  degradations.push({ script: 'conductor', wave: state?.wave ?? 0, ...o })
  log(`DEGRADED [${o.label ?? 'agent'} · ${o.model}] ${o.what}`)
}
// Wave-state snapshot, for FORENSICS ONLY — it costs nothing and writes nothing. Emitted at every
// continuation boundary, where the run used to pay a Haiku agent to transcribe the consumed state
// to disk. `persist.mjs` keeps the LAST snapshot it sees during a replay, so a run that crashes in
// wave 3 still lands wave 2's consumed state, marked `partial`. A complete run's return value
// supersedes every snapshot. Mirrored in harness.mjs and read by persist.mjs — keep all three in
// sync (shared-consts.test.mjs enforces it).
const SNAPSHOT_TAG = 'ROADMAP-SNAPSHOT '
const snapshot = (st) => log(SNAPSHOT_TAG + JSON.stringify(st))
// Escalation-ladder rulings, collected from each wave's return and passed straight through to
// .roadmap/escalations.jsonl by persist.mjs. The conductor authors none of its own.
const escalations = []
// This run's debt.md sections, one per continuation boundary that banked in FILE mode
// ({ wave, body }). Issue mode banks to roadmap:debt issues instead and leaves this empty.
const debtSections = []
// Architect-log sections the tier-3 boundary agent authored ({ wave, journal }). The TEXT is
// judgment; putting it in the file is transcription, so persist.mjs does that.
const journalEntries = []

// One code-level retry on structured-output failure — identical idiom to harness.mjs's run():
// agents deep in tool-work occasionally end a turn without a valid structured report; a single
// retry with an explicit report-last instruction converts a flake into an occasional double call.
const run = async (prompt, opts) => {
  cSpend[opts.model] = (cSpend[opts.model] ?? 0) + 1
  try { return await agent(prompt, opts) }
  catch (e) {
    if (!String(e?.message ?? e).includes('StructuredOutput')) throw e
    cSpend[opts.model] = (cSpend[opts.model] ?? 0) + 1
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'schema-retry',
      what: `structured output rejected, retrying — ${String(e?.message ?? e).slice(0, 200)}` })
    return agent(
      prompt + ' IMPORTANT: your previous structured report was REJECTED. Emit exactly the requested schema and ' +
      'no other keys — an unexpected key is rejected as hard as an over-long one. Cut every free-text field ' +
      'hard; keep only what the structured fields cannot carry. Do not redo the task.',
      { ...opts, label: `${opts.label ?? 'agent'}#retry` })
  }
}

// agent() RESOLVES TO null (it does NOT throw) when a subagent dies — a terminal API error, OR its
// own schema-retries exhausted. A bare `.catch()` does not cover that path, and neither does run()'s
// StructuredOutput retry, which only fires on a THROW: arc-observed, the tier-2 triager overran a
// 600-char `notes` cap, burned its retries inside the subagent, resolved null, and run()'s
// shorten-aggressively rescue — written for exactly this — never fired once.
// So runOr() re-runs that rescue itself on a null, then falls back. EVERY run() whose result is
// dereferenced must funnel through it: `fallback` (never null) is what keeps a dead agent from
// becoming a dead arc.
const runOr = async (fallback, prompt, opts) => {
  const r = await run(prompt, opts).catch((e) => {
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'threw',
      what: `threw — ${String(e?.message ?? e).slice(0, 200)}` })
    return null
  })
  if (r) return r
  // The null carries NO error object — the platform does not expose the cause. Record what we know
  // and name the transcript, so the next person is not left guessing "network?" for three runs.
  degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'no-report',
    what: 'agent died without a report (agent() returned null — cause not exposed by the platform); ' +
      'salvaging once, then falling back. Read the agent transcript for the real error.' })
  const retried = await run(
    prompt + ' IMPORTANT: your previous report was rejected — most likely a free-text field exceeded ' +
    'its maximum length. Shorten EVERY free-text field aggressively; one sentence each is acceptable, ' +
    'and `notes` is the first thing to cut. Emit exactly the requested schema and no other fields.',
    { ...opts, label: `${opts.label ?? 'agent'}#salvage` },
  ).catch(() => null)
  if (!retried)
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'salvage-failed',
      what: 'salvage retry also produced no report — degrading to the coded fallback' })
  return retried ?? fallback
}

/* ------------------------------ the courier -----------------------------
 * Mirrored from harness.mjs — see the long rationale there. The conductor gained a courier in
 * 0.14.0: `move-feedback` was this script's last free-form shell step, and wf_318afa1b-e9d is what
 * that cost (its `cd` did not survive to the next tool call, so every relative path it checked was
 * checked in the orchestrator's own repo and four wave-1 files were reported "missing"). The body
 * below is byte-identical to the harness's copy; shared-consts.test.mjs enforces that.
 */
// The `required` branch is HARNESS-ONLY: a required courier's death is a wave-level platform halt,
// and this script has no halt record. Nothing here passes `required`; the stub keeps the copy below
// byte-identical with the harness's and fails loudly rather than with a bare ReferenceError.
const runReq = () => { throw new Error('runReq: required couriers are harness-only — the conductor has no halt record') }
const courierRun = async (where, commands, opts, extra = '') => {
  // Fail loud at compose time. cdGuard would catch this too, but only once there is a command to
  // wrap — an empty list with an undefined `where` would otherwise ship a prompt naming `In
  // undefined:` and get whatever the agent's cwd happened to be.
  if (typeof where !== 'string' || !where.trim())
    throw new Error(`courierRun: \`where\` is required (got ${JSON.stringify(where)}) — a courier with no ` +
      'working directory improvises in its own')
  const prompt = courierPrompt(where, commands, extra)
  // `outMax` and `required` steer THIS wrapper; they are not agent() options and never reach it.
  const { outMax, required, ...rest } = opts
  const o = { ...rest, schema: courierSchema(commands.length, outMax) }
  return courierShape(
    required
      ? await runReq(prompt, o)
      : await runOr({ ok: false, results: [], detail: 'courier agent died without a report' }, prompt, o),
    commands)
}

// Spec writers may touch exactly one file under specs/ — never the rest of the orchestrator's dir.
const SPECWRITE = STRICT +
  `Your working directory is the git repository at ${repo}. ` +
  `Write ONLY the single spec file named in this task under ${repo}/.roadmap/specs/ — create or modify nothing ` +
  `else under ${repo}/.roadmap/ (not plan.json, state.json, contracts, other specs, or feedback). ` + TERSE

/* ------------------------------- schemas ------------------------------- */

// Shared new-unit skeleton — judgment-bearing shape the boundary agents emit; Sonnet expands it
// into a full spec file. Capped hard (rides in state/prompts; the platform resends over-long
// payloads verbatim). `notes`-free by design: the boundary schemas carry the pressure-release.
const specSkeleton = obj({
  id: { type: 'string', maxLength: 60 },
  title: { type: 'string', maxLength: 120 },
  risk: oneOf(['low', 'med', 'high']),
  kind: { type: 'string', maxLength: 30 },
  supersedes: { type: 'string', maxLength: 60 },
  goal: { type: 'string', maxLength: 400 },
  constraints: { type: 'string', maxLength: 600 },
  contractRefs: arr('string'),
  // Issue mode only: existing issue NUMBERS this unit resolves (typically the consolidated
  // roadmap:debt issues a sweep fix-unit folds in) — the merge path closes them on landing.
  closes: { type: 'array', maxItems: 40, items: { type: 'integer', minimum: 1 } },
  acceptance: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 200 } },
  edges: {
    type: 'array', maxItems: 8, items: obj({
      from: { type: 'string', maxLength: 60 },
      mode: oneOf(['contract', 'contingent']),
      type: oneOf(['semantic', 'file-overlap']),
      contract: { type: 'string', maxLength: 120 },
    }, ['from', 'mode']),
  },
}, ['id', 'title', 'risk', 'goal', 'acceptance'])

const S_census = obj({
  ok: { type: 'boolean' },
  pendingUserFeedback: strArr(40, 120),
  quarantineDossiers: strArr(40, 120),
  detail: { type: 'string', maxLength: 300 },
}, ['ok', 'pendingUserFeedback'])

// Opus tier-2 triage: routine boundary judgment. admit = draft ids to fold in; promote = full
// skeletons it authors; cut = drafts to drop; feedback = per-file dispositions; escalate hands
// up (Fable) or out (root) — kill/contract/replan/user are escalate-only.
const S_triage = obj({
  admit: strArr(12, 60),
  cut: { type: 'array', maxItems: 12, items: obj({ id: { type: 'string', maxLength: 60 }, reason: { type: 'string', maxLength: 200 } }, ['id', 'reason']) },
  promote: { type: 'array', maxItems: 8, items: specSkeleton },
  debtLedger: strArr(24, 400),
  feedback: { type: 'array', maxItems: 40, items: obj({ file: { type: 'string', maxLength: 120 }, action: oneOf(['actioned', 'dismissed', 'deferred']), reason: { type: 'string', maxLength: 200 } }, ['file', 'action']) },
  escalate: { type: 'boolean' },
  escalateReason: oneOf(['quarantine-redesign', 'contract-amendment', 'contingent-replan', 'needs-user', 'hard-call', 'none']),
  arcComplete: { type: 'boolean' },
  // `notes` is the PRESSURE-RELEASE valve, so it must not be the thing that bursts. At 600 it was:
  // arc-observed, a triager disposing of 15 findings overran it, exhausted its schema-retries, and
  // died — twice at the same boundary. It is also where a 'needs-user' escalation must carry the
  // exact question AND the context to answer it. Cap it loosely; the payload-size risk the other
  // caps guard lives in the ARRAYS (which stay capped), not here.
  notes: { type: 'string', maxLength: 2000 },
}, ['admit', 'cut', 'promote', 'escalate', 'arcComplete'])

// Fable tier-3 boundary agent: escalations + quarantine respecs. newUnits/reviseSpecs/cutUnits
// are plan data (never code); journal seeds the next fresh boundary agent's inherited rationale.
const S_boundaryPlan = obj({
  newUnits: { type: 'array', maxItems: 12, items: specSkeleton },
  reviseSpecs: { type: 'array', maxItems: 8, items: obj({ id: { type: 'string', maxLength: 60 }, goal: { type: 'string', maxLength: 400 }, acceptance: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 200 } }, constraints: { type: 'string', maxLength: 600 } }, ['id']) },
  cutUnits: strArr(12, 60),
  debtLedger: strArr(24, 400),
  // Explicit waiver of owed boundary jobs (job names, e.g. 'design') — Fable-tier only, and
  // only with the justification journaled; anything not waived rides forward.
  waiveOwed: strArr(8, 30),
  journal: { type: 'string', maxLength: 1500 },
  escalate: { type: 'boolean' },
  escalateReason: oneOf(['contract-amendment', 'contingent-replan', 'needs-user', 'cut-line', 'none']),
  arcComplete: { type: 'boolean' },
  notes: { type: 'string', maxLength: 2000 },   // pressure-release — see S_triage.notes
}, ['newUnits', 'journal', 'escalate', 'arcComplete'])

const S = {
  ok: obj({ ok: { type: 'boolean' }, detail: { type: 'string' } }, ['ok']),
  // A verbatim WRITE report. `cksum` is the whole point and therefore REQUIRED: it is what the
  // writer observed `cksum < <file>` print, copied through, and the script — not the writer —
  // decides whether it matches. A writer that cannot run the check reports "", which is data.
  write: obj({ ok: { type: 'boolean' }, cksum: { type: 'string', maxLength: 60 },
    detail: { type: 'string', maxLength: 300 } }, ['ok', 'cksum']),
}
// issue-new returns the {id, number} of every unit issue it created or found, so the conductor can
// cache each number into plan.units[].issue. No maxLength anywhere: the ids are echoed from the units
// passed in, so there is nothing for the model to overrun (and nothing for prompt-hygiene to require).
S.newIssues = obj({
  ok: { type: 'boolean' },
  opened: { type: 'array', items: obj({ id: { type: 'string' }, number: { type: 'number' } }, ['id', 'number']) },
  detail: { type: 'string' },
}, ['ok'])
// bank-debt reports back the markers it VERIFIED are present, so the script clears exactly those and
// carries the rest. Uncapped for the same reason as S.newIssues: every marker is echoed from a string
// this script composed and handed in, so there is nothing for the model to overrun.
S.banked = obj({
  ok: { type: 'boolean' },
  banked: { type: 'array', items: obj({ marker: { type: 'string' }, number: { type: 'number' } }, ['marker']) },
  detail: { type: 'string' },
}, ['ok', 'banked'])

/* ------------------------------- helpers ------------------------------- */
// Kebab-sanitize + 60-char cap. Deterministic (no Date/random) so ids are resume-stable.
const kebab = (s) => (String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'unit')
const uStatus = (id) => (state.units ?? {})[id]?.status
const isMerged = (id) => uStatus(id) === 'merged'
const isTerminal = (id) => ['merged', 'quarantined', 'deferred'].includes(uStatus(id))

// Cycle detection over a plan's dependency graph (Kahn: drain every unit with no remaining
// dependency; whatever will not drain sits on a cycle, or behind one). Returns null for a DAG, else
// the undrained units and the edges among them. MIRRORED between harness.mjs and conductor.mjs —
// shared-consts.test.mjs enforces byte-identity, because the two must agree on what a cycle IS: the
// conductor refuses to dispatch one and hands the root a `plan-cycle` return, and the harness throws
// on one that reached it anyway (which is a conductor bug, or a hand-edited plan.json). An edge
// naming an unknown unit is ignored here; the harness rejects those separately.
const planCycle = (units, edges) => {
  const indeg = new Map(units.map((u) => [u.id, 0]))
  for (const e of edges) if (indeg.has(e.from) && indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1)
  const q = [...indeg.keys()].filter((id) => indeg.get(id) === 0)
  const drained = new Set()
  while (q.length) {
    const id = q.shift()
    drained.add(id)
    for (const e of edges) {
      if (e.from !== id || !indeg.has(e.to)) continue
      indeg.set(e.to, indeg.get(e.to) - 1)
      if (indeg.get(e.to) === 0) q.push(e.to)
    }
  }
  if (drained.size === indeg.size) return null
  const stuck = [...indeg.keys()].filter((id) => !drained.has(id))
  const inCycle = new Set(stuck)
  return { units: stuck, edges: edges.filter((e) => inCycle.has(e.from) && inCycle.has(e.to)) }
}

// Contingent withholding (ruling 2): ready() ignores edge.mode, so the conductor mechanically
// sets aside any contingent `to`-unit whose `from` is not yet merged, keeping independent work
// running. The flip is transient — applied only to the dispatched copy, never to `plan`.
function withhold() {
  const withheldIds = new Set()
  for (const e of plan.edges) if (e.mode === 'contingent' && !isMerged(e.from)) withheldIds.add(e.to)
  const dispatchPlan = { ...plan, units: plan.units.map((u) => (withheldIds.has(u.id) ? { ...u, inScope: false } : u)) }
  return { dispatchPlan, withheld: [...withheldIds] }
}

// Arc-completeness was STATUS-BLIND: the decision read only what the boundary agents emitted, and
// arcSummary buckets merged/quarantined/deferred, so a pending/running/blocked in-scope unit was
// invisible to the triager that declared the arc done. 2026-07-18: four in-scope, satisfiable units
// were still outstanding when tier-2 called arc-complete, and the root caught it by hand.
//
// The guard is deliberately NOT "refuse while anything is non-terminal" — that livelocks. A unit
// whose dependency was cut or quarantined without a respec can never reach a terminal state, and
// refusing on it would burn a paid boundary every relaunch, forever. So: refuse only for units that
// are actually SATISFIABLE — every dependency merged, or itself outstanding-and-satisfiable — and
// hand the rest to the root as evidence rather than silently dropping them.
function outstanding() {
  const inScopeIds = new Set(plan.units.filter((u) => u.inScope).map((u) => u.id))
  const nonTerminal = [...inScopeIds].filter((id) => !isTerminal(id))
  const depsOf = (id) => plan.edges.filter((e) => e.to === id).map((e) => e.from)
  const set = new Set(nonTerminal)
  // Fixed point: drop anything blocked behind a dependency that is neither merged nor itself
  // still-live. What survives is work the next wave could actually dispatch.
  for (let changed = true; changed;) {
    changed = false
    for (const id of [...set])
      if (!depsOf(id).every((d) => uStatus(d) === 'merged' || set.has(d))) { set.delete(id); changed = true }
  }
  return { satisfiable: [...set], stuck: nonTerminal.filter((id) => !set.has(id)) }
}

// Pure routing predicates (a function of plan + returned state + census + this wave's withheld set).
function predicates(census, withheldIds) {
  const units = state.units ?? {}
  const b = state.boundary ?? {}
  const explorer = b.explorer ?? {}
  const health = b.health ?? {}
  const flake = b.flake ?? {}
  // Design-fidelity drift is judged like health: findings flow to triage, drafts are the default
  // vehicle. Folding them in HERE (rather than a parallel channel) is what delivers "drift admitted
  // as fix units by default" — they inherit tier-1/tier-2 default-admit and the cut-line brake.
  const design = b.design ?? {}
  const debt = state.debt ?? []
  const inScopeIds = new Set(plan.units.filter((u) => u.inScope).map((u) => u.id))
  // crossedContingent: a contingent edge whose `from` merged but whose `to` was NOT dispatched —
  // withheld this wave, or still out of scope. A dependent the root already replanned into scope
  // and that ran this wave is not "crossed": if it quarantined or blocked, that routes through
  // the normal ladder (tier 3 / dossiers), not a spurious contingent-replan return.
  const crossedContingent = plan.edges.filter((e) =>
    e.mode === 'contingent' && units[e.from]?.status === 'merged' && units[e.to]?.status !== 'merged' &&
    (withheldIds.has(e.to) || !inScopeIds.has(e.to)))
  // `rebanked` items are excluded: a contract mismatch banked against a unit whose work had
  // already landed is a ghost of a finding the branch resolved (the harness stamps them — see
  // noteMismatch), and on a resume the cached report replays it verbatim. Forcing a
  // contract-amendment return to the root on one of those drags the whole arc back for an
  // amendment nobody needs (arc-observed 2026-08-25). They are still DEBT — they bank with
  // everything else below — they just no longer escalate.
  const contractDebt = debt.filter((d) => d && d.kind === 'contract' && !d.rebanked)
  const nonContractDebt = debt.filter((d) => d && (d.kind !== 'contract' || d.rebanked))
  // Only UNRESOLVED quarantines force tier 3. A unit already superseded or cut is inScope:false in
  // the plan (its record stays 'quarantined' — the harness never rewrites an existing record), so
  // excluding out-of-scope ids stops a respecced quarantine from re-triaging forever.
  const quarantined = Object.entries(units).filter(([id, r]) => r?.status === 'quarantined' && inScopeIds.has(id)).map(([id]) => id)
  // Shared pre-existing reds, collapsed by the harness's circuit breaker: ONE entry per red rather
  // than one per affected unit. They arrive as FINDINGS, never as debt items — debt must never
  // create a wave (that brake is what makes arcs terminate), so a shared red rides the
  // promote/escalation path, which the cut line already brakes.
  const sharedReds = (state.sharedReds ?? []).map((r) => ({
    source: 'shared-red', severity: 'major', spec: r.spec, units: r.units ?? [],
    summary: `${r.spec} failed for ${(r.units ?? []).length} units and no unit's diff touches it — one shared ` +
      `pre-existing red, to be homed once`,
  }))
  const findings = [...sharedReds, ...(explorer.findings ?? []), ...(health.findings ?? []), ...(design.findings ?? [])]
  const healthFixUnits = [...(health.fixUnits ?? []), ...(design.fixUnits ?? [])]
  const flakeFlips = flake.flips ?? []
  const userFeedback = census.pendingUserFeedback ?? []
  // Owed boundary jobs (harness-written): due jobs that did not run. Non-empty is a judgment
  // signal — a tier must consciously ride them forward, act on the broken precondition, or
  // (Fable only) waive them; entries owed two boundaries running force tier 3.
  const owedJobs = state.owed ?? []
  const anyJudgment = findings.length > 0 || flakeFlips.length > 0 || nonContractDebt.length > 0 || userFeedback.length > 0 || owedJobs.length > 0
  return { crossedContingent, contractDebt, nonContractDebt, quarantined, findings, sharedReds, healthFixUnits, drafts: healthFixUnits, flakeFlips, userFeedback, owedJobs, anyJudgment }
}

// A health-assessor fix-unit draft {id, goal, files, acceptance} -> a default skeleton
// (risk 'low', kind 'code'). `files` rides along for the spec prompt only.
const draftSkeleton = (d) => ({
  id: d.id, title: (d.goal ?? d.id).slice(0, 120), risk: 'low', kind: 'code',
  goal: d.goal ?? '', constraints: '', contractRefs: [], acceptance: d.acceptance ?? [], edges: [], files: d.files ?? [],
})

const contractPaths = () => [...new Set(plan.edges.filter((e) => e.contract).map((e) => e.contract))]

// The architect journal is TIER-3 JUDGMENT, and the file it lands in is transcription — so the
// text is collected here and persist.mjs writes the `## Wave N` section. Collected rather than
// written inline because it must survive the TERMINAL tier-3 paths too (cut-line, arc-complete),
// whose returns jump the wave tail: a journal dropped there takes the owed-waiver justifications
// with it. Idempotent by wave: a re-ruled wave replaces its entry rather than adding a second.
// `.roadmap/skill-degradations.md` is likewise rendered by persist.mjs, from the returned
// `degradations` — it is a pure function of them, so nothing here has to author it.
function noteJournal(N, journal) {
  if (!journal) return
  const at = journalEntries.findIndex((e) => e.wave === N)
  if (at >= 0) journalEntries[at] = { wave: N, journal }
  else journalEntries.push({ wave: N, journal })
}
const arcSummary = (census) => {
  const u = state.units ?? {}
  const ids = (s) => Object.entries(u).filter(([, r]) => r?.status === s).map(([id]) => id)
  return { merged: ids('merged'), quarantined: ids('quarantined').map((id) => ({ id })), deferred: ids('deferred'), pendingFeedback: census.pendingUserFeedback ?? [], wavesRun }
}

// Freeze the current `state` (or a supplied variant) with the conductor block and build the return
// envelope. Every early return flows through here; `tier` records the boundary outcome (null skips
// the record — pre-dispatch/post-loop guards belong to no wave's boundary). NOTHING is written: the
// envelope IS the persistence contract, and `persist.mjs` turns it into files at zero model cost.
async function ret(reason, tier, extra = {}) {
  if (tier != null) boundaries.push({ wave: state.wave, tier, escalated: reason })
  const st = { ...state, spend: { ...(state.spend ?? {}) } }   // tier-4 handoff: boundary + debt stay INTACT (the root consumes them)
  mergeConductorSpend(st)
  st.conductor = { reason, wavesRun, boundaries }
  delete st.degradations   // ledger-only: an arc-cumulative ledger inside state.json IS the growth loop
  delete st.escalations
  return {
    status: 'conductor-return', reason, wave: st.wave, wavesRun, state: st, plan,
    spendDelta: deltaSpend(st.spend),
    spendReport: spendReport(st.spend),
    // Everything below is what persist.mjs puts on disk. Always present (empty when clean) so
    // neither the root nor the persister has to wonder whether the run was healthy.
    degradations,
    escalations,
    debtSections,
    journalEntries,
    // The wave's debt exactly as received, for .roadmap/debt.json.
    debt: pendingDebt,
    // Owed boundary jobs surface on every return — on a terminal one they are the root's to
    // discharge (or explicitly waive in the architect log) before close-out.
    ...(st.owed?.length ? { owed: st.owed } : {}),
    ...extra,
  }
}

/* --------------------------- boundary prompts -------------------------- */
// Deterministic functions of repo path + wave N + the JSON of in-memory structured data. Both
// agents read architect-log.md FIRST so successive fresh agents inherit rationale.
const censusPrompt = (N) => STRICT +
  `Your working directory is the git repository at ${repo}. ` +
  `Take a wave-${N} census of a roadmap build's pending bug reports and quarantine dossiers. Report identifiers ` +
  `only — read no contents, change nothing:\n` +
  (issueMode
    ? `1) List open user bug issues: \`${GH_HERE} issue list ${ghRepo}--label roadmap:bug --state open --limit 1000 ` +
      `--json number --jq '.[].number'\` — put each issue NUMBER (as a string) in \`pendingUserFeedback\` (empty ` +
      `array if none or if gh fails). gh defaults to 30 results, so always pass the --limit shown; if the ` +
      `returned count EQUALS the limit the listing is truncated — re-run with the limit doubled until the count ` +
      `is below it, and note in \`detail\` that paging was needed.\n`
    : `1) List the files directly under ${repo}/.roadmap/feedback/user/, EXCLUDING TEMPLATE.md — put their basenames ` +
      `in \`pendingUserFeedback\` (empty array if that directory is absent or holds only TEMPLATE.md).\n`) +
  `2) List the *.md files under ${repo}/.roadmap/quarantine/ — put their basenames in \`quarantineDossiers\` ` +
  `(empty array if absent).\nReport ok:true when both listings completed. Never guess ` +
  `${issueMode ? 'issue numbers' : 'filenames'}. Keep \`detail\` to one sentence (max 300 characters). ${TERSE}`

// The cut-line brake is load-bearing (arc-observed, RATIONALE §7): a healthy assessor drafts
// something EVERY wave, so an admit-by-default triage with no brake never dries — one live run
// admitted fresh test-ergonomics drafts on waves 3/4/5 and returned max-waves. Don't soften it.
const opusTriagePrompt = (N, P) =>
  `You are the wave-${N} boundary triager for a roadmap build, standing in for the architect. Read, in this order: ` +
  `${repo}/.roadmap/architect-log.md FIRST (inherited rationale + dismissal criteria), then ` +
  `${repo}/.roadmap/state.json, ${repo}/.roadmap/plan.json, ${issueMode ? 'the open roadmap:debt issues (`' + GH_HERE + ' issue list ' + ghRepo + '--label roadmap:debt --state open --limit 1000` — if exactly 1000 come back the listing is truncated: re-run with a higher limit; never trust a result equal to its limit)' : `${repo}/.roadmap/debt.md`}, this wave's feedback at ` +
  `${repo}/.roadmap/feedback/{explorer,health}/wave-${N}.md plus ` +
  `${issueMode ? `the open user bug issues named in the evidence below (read each with \`${GH_HERE} issue view ${ghRepo}<n>\`)` : `any user notes under ${repo}/.roadmap/feedback/user/`}, and the specs/contracts under ${repo}/.roadmap/{specs,contracts} as needed. ` +
  `The wave's structured boundary evidence (authoritative — the files are for detail):\n` +
  `${JSON.stringify({ findings: P.findings, drafts: P.healthFixUnits, flakeFlips: P.flakeFlips, debt: P.nonContractDebt, userFeedback: P.userFeedback, owed: P.owedJobs })}\n` +
  `Weigh explorer/health findings, dispose of debt and non-contract feedback, and decide which health-assessor ` +
  `fix-unit DRAFTS to admit. ` +
  (P.owedJobs.length
    ? `The \`owed\` list names boundary jobs that were DUE but did not run (count = consecutive boundaries owed). ` +
      `They discharge automatically when the job next succeeds — never silently ignore one: if its precondition is ` +
      `broken (e.g. the preview is down), that is itself a finding to act on, and only the Fable tier may waive an ` +
      `owed job outright — escalate 'hard-call' if you believe one should be. `
    : '') +
  (P.sharedReds.length
    ? `A finding marked \`source:"shared-red"\` is ONE pre-existing failure that broke several units' gates at once ` +
      `and lies outside every one of their diffs. It is not evidence against those units and their specs are not ` +
      `wrong: home it in a single fix unit (or bank it), and never respec a unit over it. `
    : '') +
  (CC.admissions === 'closed'
    ? `ADMISSIONS ARE CLOSED for this arc: the plan is drained. Nothing you list in \`admit\` or \`promote\` will ` +
      `become a unit — the scheduler banks those entries to the debt ledger instead, in code, whatever you decide. ` +
      `Dispose of the wave on that basis: say what is real so it is banked with a reason, cut what is noise, and set ` +
      `arcComplete. The one exception is a finding graded \`blocker\`, which the scheduler routes to the architect ` +
      `tier to be ruled on — do not try to admit one yourself. `
    : '') +
  `${(plan.designAuthorities ?? []).length ? 'A design-fidelity finding (severity bug | adoption-gap | irreconcilable) means a screen that MERGED has drifted from the comp that governs it: the default vehicle is a fix unit, and an "irreconcilable" one is never yours to cut — escalate it, because it means built behaviour and design cannot both stand and only the architect can choose. ' : ''}` +
  `Drafts are the default action — admit them (list ids in \`admit\`) unless they are ` +
  `noise, in which case \`cut\` them with a reason; author any additional new unit you want as a full skeleton in ` +
  `\`promote\`. SWEEP THE WAVE'S DEBT, don't just bank it: while the plan's own in-scope units still have work ` +
  `left to run (a next wave is happening anyway), fold this wave's debt — even minor items — into one or more ` +
  `consolidation fix-units in \`promote\`, so debt is cleaned up next wave rather than accumulating. ` +
  `${issueMode ? 'When a unit you `promote` resolves specific OPEN roadmap:debt or roadmap:bug issues you read above, set its `closes` field to exactly those issue NUMBERS — the merge path closes them automatically when the unit merges; omit `closes` otherwise and never guess a number. ' : ''}` +
  `But debt must ` +
  `never CREATE a wave: once the plan's own units are all terminal (merged/quarantined), do NOT promote debt — ` +
  `bank it to \`debtLedger\` and set arcComplete, so it becomes durable tracked debt the next session picks up. ` +
  `THE CUT LINE BINDS THE DEFAULT — a healthy assessor drafts something every wave, so admitting by ` +
  `default with no brake would extend the arc forever: once the plan's own units are merged, a ` +
  `draft must justify a WAVE, not merely be an improvement — refactors without a defect, ergonomics polish, and ` +
  `marginal coverage on a healthy suite are noise to cut even though they are real; bank them to \`debtLedger\` ` +
  `instead so nothing is lost. When you cut the last drafts as below-the-line, set arcComplete:true in the same ` +
  `verdict — an arc that never dries is a failure mode, not diligence. ` +
  `Findings observed at a superseded sha are discounted, not re-litigated. You may NOT kill a unit, ` +
  `amend a contract, design a contingent dependent, or answer for the user: set escalate:true with the matching ` +
  `escalateReason — 'quarantine-redesign' or 'hard-call' hands to the Fable boundary agent; ` +
  `'contract-amendment'/'contingent-replan'/'needs-user' return to the root. When escalating 'needs-user', put ` +
  `the exact user-facing question (with the context needed to answer it) in \`notes\` — that text IS what reaches ` +
  `the user. Set arcComplete:true if the cut line ` +
  `is reached and no further work remains. Return structured output only — write nothing. Hold \`notes\` to a ` +
  `few short paragraphs (max 2000 characters). ` + TERSE

const fableBoundaryPrompt = (N, P, lead) =>
  `You are the wave-${N} Fable boundary agent for a roadmap build — the architect's in-workflow stand-in for ` +
  `escalations and quarantine respecs. Read ${repo}/.roadmap/architect-log.md FIRST (inherited rationale), then the ` +
  `dossiers of the quarantined units named here (${JSON.stringify(P.quarantined)}) under ` +
  `${repo}/.roadmap/quarantine/, then ${repo}/.roadmap/state.json, ${repo}/.roadmap/plan.json, this wave's feedback ` +
  `under ${repo}/.roadmap/feedback/, and ${repo}/.roadmap/debt.md. Structured evidence:\n` +
  `${JSON.stringify({ quarantined: P.quarantined, findings: P.findings, drafts: P.healthFixUnits, debt: P.nonContractDebt, owed: P.owedJobs })}\n` +
  (P.owedJobs.length
    ? `The \`owed\` list names boundary jobs that were DUE but did not run (count = consecutive boundaries owed); ` +
      `they discharge automatically when the job next succeeds. For each, either act on the broken precondition ` +
      `(e.g. a fix unit or journal instruction for a downed preview) or — if the job is genuinely moot for this ` +
      `arc — waive it explicitly by putting its job name in \`waiveOwed\` and justifying the waiver in your ` +
      `journal. An owed job you neither act on nor waive rides forward and forces this tier again. `
    : '') +
  (P.sharedReds.length
    ? `A finding marked \`source:"shared-red"\` is ONE pre-existing failure that broke several units' gates at once ` +
      `and lies outside every one of their diffs. Home it once; it is never grounds to respec the units it failed. `
    : '') +
  (CC.admissions === 'closed'
    ? `ADMISSIONS ARE CLOSED for this arc: the plan is drained, and you are reading this tier only because a ` +
      `quarantine, an owed job, or a blocker-graded finding needs a ruling. New units are still yours to emit, but ` +
      `only work of that grade justifies one — everything else belongs in \`debtLedger\`. `
    : '') +
  `Route each quarantined unit by its dossier REASON: environment/tooling-blocked -> re-run as-is (prefer ` +
  `instructing the provisioning fix via the \`journal\` plus a fresh \`newUnit\` carrying the SAME spec under a NEW ` +
  `id); unsatisfiable-as-written -> respec under a NEW id; otherwise split or revise. NEVER reuse a failed or ` +
  `quarantined id. Emit new work as full skeletons in \`newUnits\` (each with a NEW kebab id), spec adjustments in ` +
  `\`reviseSpecs\`, and units to drop below the cut line in \`cutUnits\`. ` +
  `${issueMode ? 'When a `newUnit` resolves specific OPEN roadmap:debt or roadmap:bug issues you read above, set its `closes` field to exactly those issue NUMBERS — the merge path closes them automatically when the unit merges; omit `closes` otherwise and never guess a number. ' : ''}` +
  `Whenever a \`newUnit\` REPLACES a ` +
  `quarantined unit, set its \`supersedes\` field to that unit's id so the failed unit is retired and its edges ` +
  `repoint to the replacement — never leave a replaced quarantine active; a quarantine you abandon without ` +
  `replacing goes in \`cutUnits\`. Append a concise architect \`journal\` ` +
  `entry (decisions + rationale + watch-list) so the next fresh boundary agent inherits your rationale. You may ` +
  `NEVER amend a contract or design a contingent dependent: set escalate:true with escalateReason ` +
  `'contract-amendment'/'contingent-replan'/'needs-user' to return to the root, or 'cut-line' when the arc is ` +
  `complete. When escalating 'needs-user', put the exact user-facing question (with the context needed to answer ` +
  `it) in \`notes\` — that text IS what reaches the user. ` +
  `Return skeletons and journal only — write no code and no files. Hold \`journal\` to one short paragraph ` +
  `(max 1500 characters) and \`notes\` to a few (max 2000 characters). ${TERSE}${lead}`

// A spec file is a PROJECTION of the skeleton the boundary already decided — every section is one
// of the skeleton's own fields, and the prompt that used to buy a Sonnet turn for it said exactly
// that ("render the skeleton's content faithfully; invent no requirements"). So the bytes are
// composed HERE, in code, and a Haiku verbatim-writer puts them on disk: the same move 0.14.0 makes
// everywhere else, and the strongest possible form of "invent no requirements" — there is no longer
// a model between the boundary's decision and the file. It is also replay-exact, being a pure
// function of the skeleton.
// `files` is carried because health/design fix-unit DRAFTS have one (their `{id, goal, files,
// acceptance}` shape) even though the skeleton schema does not require it — dropping it here would
// throw away the one scope hint a consolidation draft ships with.
const specFileText = (s) => {
  const L = [s.title ? `# ${s.id} — ${s.title}` : `# ${s.id}`, '',
    `Risk: ${s.risk ?? 'low'} · Kind: ${s.kind ?? 'code'}${s.supersedes ? ` · Supersedes: ${s.supersedes}` : ''}`, '',
    '## Goal', '', s.goal ?? '', '',
    '## Constraints', '', s.constraints || 'None stated.', '',
    '## Contract references', '',
    ...(s.contractRefs?.length ? s.contractRefs.map((r) => `- ${r}`) : ['None.']), '']
  if (s.files?.length) L.push('## Files in scope', '', ...s.files.map((f) => `- ${f}`), '')
  // The exit gate grades these one by one, so they stay one checkbox per clause. An empty list is
  // written as the defect it is rather than silently omitted: a unit whose acceptance nobody can
  // grade is a unit that cannot pass its gate, and that has to be visible in the spec itself.
  L.push('## Acceptance criteria', '',
    ...(s.acceptance?.length ? s.acceptance.map((a) => `- [ ] ${a}`)
      : ['- [ ] (none stated — the draft shipped no gradeable criteria; the exit gate has nothing to grade)']))
  // NO trailing newline: the here-doc that writes this leaves exactly one, and the expected cksum
  // is computed over `text + '\n'`. An extra blank line here is a cksum mismatch, not cosmetics.
  return L.join('\n')
}
// The on-disk bytes and the `cksum` line they must print. `cksum` (POSIX, in every sandbox) prints
// `<crc> <bytes>` for stdin; cksumOf computes the same in-script, and the sims cross-validate it
// against real coreutils.
const specBytes = (skel) => {
  const text = specFileText(skel)
  const ck = cksumOf(`${text}\n`)
  return { text, want: `${ck.crc} ${ck.bytes}` }
}
// An `ok:true` from a cheap writer is not evidence — that is the whole of RATIONALE §19's second
// half, and the ledger paid for it (bank-debt:w12 reported success and dropped 23 items). A
// mis-transcribed spec is worse than a lost one: the implementer builds the wrong thing and every
// gate grades it against the same wrong text. So the write is COURIER-SHAPED — an exact quoted
// here-doc, then `cksum < <file>` reported VERBATIM — and the SCRIPT decides, by comparing the
// printed line against `cksumOf` of the bytes it composed. A CRC cannot be iterated toward, which
// is why it replaced the byte count that a writer once padded its way to.
const specWritePrompt = (skel, resample = '') => {
  const path = `${repo}/.roadmap/specs/${skel.id}.md`
  const { text, want } = specBytes(skel)
  return SPECWRITE + resample +
    `Write the file ${path} so its content is EXACTLY the document below and nothing else (create parent ` +
    `directories first if needed). You are a courier here, not an author: never reword, reorder, summarise, ` +
    `expand, re-indent or add a section, and never fill a blank you think is missing. Write it in ONE Bash ` +
    `tool call through a single-quoted here-doc so the shell interprets nothing — never echo, printf, or a ` +
    `file-write/edit tool (a file-write tool re-interprets escapes): run \`cat > ${path} <<'ROADMAP_SPEC'\` ` +
    `followed by the document's lines and a closing \`ROADMAP_SPEC\` line. The document is every line after ` +
    `the <<<DOCUMENT>>> marker line to the end of this message, excluding the marker line itself. ` +
    `Then run \`cksum < ${path}\` and report what it printed, VERBATIM, in \`cksum\` (one line, max 60 ` +
    `characters; empty string if you could not run it) — copy the numbers, never compute, round or ` +
    `reformat them, and never edit, pad or trim the file to change what they say: the scheduler compares ` +
    `that line itself and a mismatch is reported, never repaired. Report ok:true when you wrote the file ` +
    `and ran the check, whatever it printed — \`ok\` is about YOUR report, not about the verdict — and ` +
    `ok:false with the exact error in \`detail\` (one sentence, max 300 characters) if the write itself ` +
    `failed.\n<<<DOCUMENT>>>\n${text}`
}
// A fresh sample, worded differently: mis-transcription is per-sample stochastic, so one more try is
// worth it — and a DIFFERING prompt is what stops `resumeFromRunId` serving the bad sample straight
// back (the same rule the launch pack's re-read follows).
const SPEC_RESAMPLE =
  'A previous courier\'s copy of this spec did not match its `cksum`, so the file on disk is wrong. ' +
  'Write it again from scratch, from the document in THIS message only — do not read, diff or patch ' +
  'what is already there. '

// A REVISION is not a projection: the file on disk carries content this script never composed —
// architect rulings the harness appends mid-wave (`spec-append`) among them — so the three sections
// named here have to be edited in place around material that must survive. That is a read-modify-write
// judgment, not transcription, and it is why this one keeps a model where spec-expand shed its.
const specRevisePrompt = (rev) => SPECWRITE +
  `Revise the existing spec at ${repo}/.roadmap/specs/${rev.id}.md in place, applying these changes and nothing ` +
  `else: ${JSON.stringify(rev)}. Update the Goal, Acceptance criteria (keep them individually gradeable), and ` +
  `Constraints sections to match; leave the rest of the spec intact — anything appended below them (an ` +
  `architect ruling, for instance) is not yours to edit. Then run \`cksum < ${repo}/.roadmap/specs/${rev.id}.md\` ` +
  `and report what it printed, VERBATIM, in \`cksum\` (one line, max 60 characters). Nothing is compared ` +
  `against it — the revised content is yours to compose, so there is no expected value — it is recorded so a ` +
  `later reader can tell WHICH version of this spec they are looking at. Report ok:false with the exact error ` +
  `in \`detail\` (one sentence, max 300 characters) if the file cannot be written.`

/* ---------------------------- plan mutation ---------------------------- */
// Assign resume-stable, collision-free kebab ids to a batch of new skeletons. A respec NEVER
// reuses its superseded (quarantined) id — that would re-run a failed spec.
function makeFreshId() {
  const taken = new Set(plan.units.map((u) => u.id))
  const N = state.wave
  return (candidate, supersedes) => {
    let id = kebab(candidate)
    if (supersedes && id === kebab(supersedes)) id = kebab(`${candidate}-r${N}`)
    const base = id
    let i = 2
    while (taken.has(id)) { id = kebab(`${base}-${i}`); i++ }
    taken.add(id)
    return id
  }
}

// Drop drafts a boundary filed twice in ONE batch. makeFreshId dedupes by id string and RENAMES a
// collision (`x` -> `x-2`), which is right for a genuine respec and exactly wrong here: it turned
// one draft filed twice into two real units (arc-observed, #1261/#1262). Exact duplicates go —
// same id, or same title once kebabbed — and suffixing survives only for a `supersedes` respec,
// which legitimately re-files a topic under a new id.
function dedupeDrafts(skeletons) {
  const seen = new Set()
  const kept = []
  const dropped = []
  for (const sk of skeletons) {
    if (sk?.supersedes) { kept.push(sk); continue }
    const id = kebab(sk?.id ?? '')
    const title = kebab(sk?.title ?? sk?.goal ?? '')
    if (seen.has(`id:${id}`) || (title && seen.has(`title:${title}`))) { dropped.push(sk); continue }
    seen.add(`id:${id}`)
    if (title) seen.add(`title:${title}`)
    kept.push(sk)
  }
  return { kept, dropped }
}

// Pure-code merge: append units (inScope:true) + edges, apply supersedes (old unit inScope:false,
// edges repointed old->new), and cut units (inScope:false). Dangling edges are dropped so the
// harness's plan-validation never throws on an unknown reference.
function mergePlan(prepared, cutIds) {
  for (const cid of cutIds ?? []) {
    const u = plan.units.find((x) => x.id === cid || x.id === kebab(cid))
    if (u) u.inScope = false
  }
  // EDGE HYGIENE. An edge must never touch a unit that is ALREADY merged: merged work cannot come
  // to depend on new work, and a dependency ON merged work is already satisfied. Two boundaries
  // that each wired one in successive waves closed a 2-cycle, the harness threw on dispatch, and
  // the throw took a whole conductor run down with it (wf_c6971376-1a5). Self-edges and duplicates
  // are dropped on the same pass — a repoint can manufacture both out of edges that were fine.
  const dropEdge = (why, from, to) => { log(`mergePlan: dropped edge ${from} -> ${to} (${why})`); return true }
  const badEdge = (from, to) => (from === to && dropEdge('self-edge', from, to)) ||
    (isMerged(from) && dropEdge(`${from} is already merged — the dependency is satisfied`, from, to)) ||
    (isMerged(to) && dropEdge(`${to} is already merged — merged work cannot depend on new work`, from, to))
  for (const s of prepared) {
    if (s.supersedes) {
      const oldId = s.supersedes
      const oldU = plan.units.find((x) => x.id === oldId)
      if (oldU) oldU.inScope = false
      const kept = []
      for (const e of plan.edges) {
        if (e.from !== oldId && e.to !== oldId) { kept.push(e); continue }
        const from = e.from === oldId ? s.id : e.from
        const to = e.to === oldId ? s.id : e.to
        if (badEdge(from, to)) continue
        if (kept.some((k) => k.from === from && k.to === to)) { dropEdge('duplicate of an edge already in the plan', from, to); continue }
        kept.push({ ...e, from, to })
      }
      plan.edges = kept
    }
    plan.units.push({ id: s.id, title: (s.title ?? s.id).slice(0, 120), risk: s.risk ?? 'low', kind: s.kind ?? 'code', inScope: true,
      // The push is a whitelist — an unlisted skeleton field is dropped here, so `closes` must be
      // carried explicitly or the merge path never sees it.
      ...(Array.isArray(s.closes) && s.closes.length
        ? { closes: s.closes.filter((n) => Number.isInteger(n) && n > 0) } : {}) })
  }
  for (const s of prepared) for (const e of s.edges ?? []) {
    const from = kebab(e.from)
    if (!plan.units.some((u) => u.id === from)) continue
    if (badEdge(from, s.id)) continue
    if (plan.edges.some((x) => x.from === from && x.to === s.id)) { dropEdge('duplicate of an edge already in the plan', from, s.id); continue }
    plan.edges.push({ from, to: s.id, type: e.type ?? 'semantic', mode: e.mode ?? 'contract', ...(e.contract ? { contract: e.contract } : {}) })
  }
}

const fmtDebt = (d) => typeof d === 'string'
  ? `- ${d}`
  : `- [${d.kind ?? 'structure'}/${d.severity ?? 'minor'}] ${d.what ?? ''}${d.why ? ` — ${d.why}` : ''}` +
    `${d.bankReason ? ` [bank: ${d.bankReason}]` : ''}${d.unit ? ` (${d.unit})` : ''}`

/* ------------------------------ main loop ------------------------------ */
for (let w = 0; w < CC.maxWavesPerRun; w++) {
  // 1. Contingent withholding, computed before dispatch from the latest state.
  const { dispatchPlan, withheld } = withhold()
  if (withheld.length) log(`wave ${w}: withholding ${withheld.length} contingent-dependent unit(s): ${withheld.join(', ')}`)
  // 1b. Cycle guard, on exactly the graph the harness is about to validate. The harness THROWS on a
  // cycle, and a throw inside the nested workflow() takes the whole conductor run down with no
  // return envelope — the run's specs, plan, debt and journal survive only in journal.jsonl
  // (wf_c6971376-1a5). Nothing is lost by returning instead: the previous boundary already staged
  // everything through stage(), and this hands the root the edges to repoint. Placed here rather
  // than inside mergePlan so it also catches a cyclic plan.json handed in by the root.
  const cycle = planCycle(dispatchPlan.units, dispatchPlan.edges)
  if (cycle) {
    log(`wave ${w}: REFUSING to dispatch — plan cycle through ${cycle.units.join(', ')}`)
    return await ret('plan-cycle', 4, { edges: cycle.edges, units: cycle.units })
  }
  const dispatchable = dispatchPlan.units.filter((u) => u.inScope && !isTerminal(u.id))
  // Excluding withheld units nothing dispatchable remains, but withheld ones do -> the root must replan.
  if (dispatchable.length === 0 && withheld.length > 0) {
    const edges = plan.edges.filter((e) => e.mode === 'contingent' && withheld.includes(e.to))
    return await ret('contingent-replan', 4, { edges })
  }

  // 2. Budget guard (waves after the first): refuse to dispatch a wave that could cross the 1000-call cap.
  if (w > 0) {
    // state.spend already carries conductor calls merged at prior continuations; add only the
    // not-yet-merged remainder so the conductor's own work is never counted twice.
    const runLocalCalls = (sumTiers(state.spend) - initialSpendTotal) + (sumTiers(cSpend) - sumTiers(cMerged))
    // Issue mode adds a per-wave overhead of a few Haiku calls (the harness's wave-tail issue-sync
    // sweep + the new-unit issue writer) that fold no work onto individual units — a small fixed bump.
    const estimate = (issueMode ? 12 : 8) + dispatchable.length * CC.perUnitCallEstimate
    if (runLocalCalls + estimate + CC.agentBudgetReserve > 1000)
      return await ret('agent-budget', null, { nextWaveUnits: dispatchable.map((u) => u.id), estimate })
  }

  // 3. Dispatch the wave through the harness. Config is passed UNTOUCHED; boundary:'off' is never
  //    set here (ruling 1). The returned state threads forward (units/spend/wave accumulate).
  phase('Wave')
  state = await workflow({ scriptPath: harnessPath }, { plan: dispatchPlan, state, config: overrides, launchId })
  wavesRun++
  const N = state.wave
  // The harness returns THIS WAVE's degradations and escalation rulings in its ENVELOPE only — its
  // serialize() carries neither. Absorb them for this run's envelope and the summary, then strip
  // them so nothing threads a ledger back into the state that gets persisted.
  const newDegradations = state.degradations ?? []
  for (const d of newDegradations) degradations.push(d)
  for (const e of state.escalations ?? []) escalations.push(e)
  if (newDegradations.length) log(`wave ${N}: ${newDegradations.length} harness degradation(s) recorded`)
  if ('degradations' in state || 'escalations' in state) {
    state = { ...state }
    delete state.degradations
    delete state.escalations
  }

  // Wave debt joins the run's ledger the moment it arrives — before the census, before triage,
  // before any return can skip past the bank. It rides out on EVERY return path as `debt`, which
  // persist.mjs writes to `.roadmap/debt.json`; debt.md / the roadmap:debt issues remain the
  // durable, human-facing record.
  pendingDebt = [...pendingDebt, ...(state.debt ?? [])]

  // Wave-level halt (`state.halt.reason`, one of: codex-unavailable / codex-usage-limit — Codex is
  // the only implementer and there is no lane to fall back to; env-pids-exhausted / env-no-reaper —
  // the box cannot support the work; platform-outage — required agent results stopped arriving).
  // The harness already halted dispatch and parked in-flight units; no census/triage spend against
  // a wave the root must hand to the human anyway (re-auth, recreate the container, or wait out the
  // outage window, then relaunch — state and parked units resume cleanly). The harness picks the
  // winning reason so this precedence is never duplicated here.
  if (state.halt?.reason)
    return await ret(state.halt.reason, 4, { parked: Object.entries(state.units ?? {})
      .filter(([, u]) => u.parked).map(([id]) => id) })

  // 4. Census (Haiku) — feedback + quarantine folder listing. A dead census degrades to an empty
  // one rather than killing the run: the authoritative boundary evidence is the in-memory state,
  // and an empty census only means user-feedback files go untriaged this boundary (they persist
  // on disk and are picked up at the next one).
  phase('Census')
  const census = await runOr(
    { ok: false, pendingUserFeedback: [], quarantineDossiers: [] },
    censusPrompt(N), { model: 'haiku', effort: 'low', label: `census:w${N}`, phase: 'Census', schema: S_census })

  // Single choke point for BOTH arc-complete exits (tier-3 cut-line and the tier-agnostic one
  // below) — each was independently status-blind, so guarding only one would leave the same bug
  // reachable by the other path.
  const finish = async (tier) => {
    const { satisfiable, stuck } = outstanding()
    // An owed boundary job must never leave a TERMINAL return quietly. The harness now runs owed
    // jobs in the final boundary even when it is switched off — which is where they used to vanish
    // — so anything still owed here survived that too and is the root's to discharge or waive
    // before close-out. `ret()` carries the ledger out; this makes it loud in the journal as well.
    if (state.owed?.length)
      log(`wave ${state.wave}: closing with ${state.owed.length} owed boundary job(s) unsettled ` +
        `(${state.owed.map((o) => o.job).join(', ')}) — discharge or waive them before close-out`)
    if (satisfiable.length)
      return await ret('arc-stalled', tier, { arcSummary: arcSummary(census), outstanding: satisfiable, stuck })
    // Nothing dispatchable remains. Units stuck behind an unresolved quarantine are NOT a reason to
    // refuse — nothing further can move them — but they must be named, not silently dropped.
    return await ret('arc-complete', tier, { arcSummary: arcSummary(census), ...(stuck.length ? { stuck } : {}) })
  }

  // 5. Predicates (the wave's withheld set disambiguates crossed vs already-replanned contingents).
  const P = predicates(census, new Set(withheld))

  // 6. Tier routing (first match wins). Contingent/contract routing outranks the degraded check:
  // both are actionable root business computable without a boundary block, and returning
  // 'boundary-degraded' over a pending contract amendment would bury the higher-priority reason.
  if (P.crossedContingent.length) return await ret('contingent-replan', 4, { edges: P.crossedContingent })
  if (P.contractDebt.length) return await ret('contract-amendment', 4, { debt: P.contractDebt, contracts: contractPaths() })

  // Boundary block absent while the caller left it enabled, and nothing to triage -> degraded wave.
  const callerBoundaryOff = (overrides?.boundary ?? inPlan.config?.boundary) === 'off'
  if (!state.boundary && !callerBoundaryOff && P.quarantined.length === 0)
    return await ret('boundary-degraded', 4, {})
  if (CC.boundaryTriage === 'root') return await ret('root-triage', 4, { pendingFeedback: census.pendingUserFeedback ?? [], quarantined: P.quarantined.map((id) => ({ id })) })

  const blockerFinding = P.findings.some((f) => f?.severity === 'blocker')

  let tier
  if (P.quarantined.length || P.owedJobs.some((o) => (o.count ?? 1) >= 2) ||
      // Closed admissions bank everything except a blocker, which needs a ruling, not a bank line.
      (admissionsClosed && blockerFinding) ||
      (CC.boundaryTriage === 'always-fable' && P.anyJudgment)) tier = 3
  else if (P.anyJudgment || (CC.fixUnitAdmit === 'triage' && P.drafts.length) ||
      P.drafts.length > CC.tier1MaxDrafts) tier = 2
  else tier = 1

  let triageResult = null
  let boundaryPlan = null
  let opusLead = ''

  // A dead triage tier has no safe fallback — inventing an empty verdict would silently admit or
  // drop work the root never saw. Hand the boundary back instead: the root triages it by hand (the
  // same recovery as boundary-degraded) and relaunches. Legible return beats a stack trace.
  const degraded = () => ret('triage-degraded', tier,
    { pendingFeedback: census.pendingUserFeedback ?? [], quarantined: P.quarantined.map((id) => ({ id })) })

  // Tier 2 — Opus boundary triager.
  if (tier === 2) {
    phase('Triage-opus')
    cSpend.boundaryTriages++
    triageResult = await runOr(null, opusTriagePrompt(N, P),
      { model: 'opus', effort: CC.opusEffort, label: `triage:w${N}`, phase: 'Triage-opus', schema: S_triage })
    if (!triageResult) return await degraded()
    if (triageResult.escalate) {
      const er = triageResult.escalateReason
      if (er === 'quarantine-redesign' || er === 'hard-call') {
        tier = 3   // hand to the Fable boundary agent, carrying the Opus assessment as a lead
        opusLead = ` A first-pass Opus boundary triage could not clear this itself (escalation trigger "${er}"). ` +
          `Use its assessment as a lead to confirm or overturn — not as ground truth: ` +
          `${JSON.stringify({ admit: triageResult.admit, cut: triageResult.cut, notes: triageResult.notes })}.`
      } else if (er === 'contract-amendment' || er === 'contingent-replan' || er === 'needs-user') {
        // An escalating return is a HANDOFF, not an abort: stage first, or the triager's admitted
        // units, this wave's debt ledger and the journal exist nowhere the root can read them.
        // `unbanked` is deliberately ignored — a tier-4 return hands `state.debt` back INTACT.
        await stage(N, 2, collect(2, P, triageResult, null))
        return await ret(er, 2, briefFor(er, P, N, triageResult, null, census))
      }
    }
  }

  // Tier 3 — Fable boundary agent (quarantine respecs + Opus escalations).
  if (tier === 3) {
    phase('Triage-fable')
    cSpend.boundaryFables++
    boundaryPlan = await runOr(null, fableBoundaryPrompt(N, P, opusLead),
      { model: 'fable', effort: CC.fableEffort, label: `boundary:w${N}`, phase: 'Triage-fable', schema: S_boundaryPlan })
    if (!boundaryPlan) return await degraded()
    // Apply owed-job waivers HERE, at capture — not at persist. The terminal returns below
    // (cut-line, and arc-complete when the plan yields nothing new) are exactly the shape a
    // waiver usually takes ("this job is moot for this arc" comes with no new units), and
    // applying late silently discarded it: the same dead job then re-forced a paid Fable
    // boundary on every relaunch, forever, since only a successful run discharges a marker
    // (eval-observed). Waiving into `state` means every downstream path — finish()/ret()
    // envelope, consumed threading, persisted state.json — inherits it.
    if (boundaryPlan.waiveOwed?.length && state.owed?.length) {
      const owedLeft = state.owed.filter((o) => !boundaryPlan.waiveOwed.includes(o.job))
      state = { ...state }
      if (owedLeft.length) state.owed = owedLeft
      else delete state.owed
      log(`wave ${N}: fable tier waived owed job(s): ${boundaryPlan.waiveOwed.join(', ')}`)
    }
    if (boundaryPlan.escalate) {
      const er = boundaryPlan.escalateReason
      if (er === 'contract-amendment' || er === 'contingent-replan' || er === 'needs-user') {
        await stage(N, 3, collect(3, P, triageResult, boundaryPlan))   // handoff, not abort — see tier 2
        return await ret(er, 3, briefFor(er, P, N, triageResult, boundaryPlan, census))
      }
      // The journal (waiver justifications included) must survive a terminal boundary — the
      // persist-section writer sits past this return and used to drop it.
      if (er === 'cut-line') { noteJournal(N, boundaryPlan.journal); return await finish(3) }
    }
  }
  const ranTier = tier
  const collected = collect(ranTier, P, triageResult, boundaryPlan)
  const { prepared, reviseList, journal, arcCompleteFlag, feedbackDispositions } = collected

  // Arc complete: a tier said so, or the boundary produced no new units and no spec revisions.
  // Routed through finish(), which refuses to close over dispatchable work. A tier-3 journal
  // still lands first — this terminal return used to jump the persist-section writer and drop
  // it (waiver justifications with it).
  if (arcCompleteFlag || (prepared.length === 0 && reviseList.length === 0)) {
    if (ranTier === 3) noteJournal(N, journal)
    return await finish(ranTier)
  }

  // 7. Stage this boundary's decisions on disk — specs, plan, issues, debt, journal.
  const { unbanked } = await stage(N, ranTier, collected)

  // 8. Persist (all awaited before the next dispatch; idempotent by wave-N markers for resume).
  phase('Persist')
  // Consumed continuation state: boundary removed + banked debt cleared, conductor.reason null.
  const consumed = { ...state, spend: { ...(state.spend ?? {}) } }
  if (state.boundary) { lastBoundary = state.boundary; lastBoundaryWave = N }
  delete consumed.boundary
  // Only what the banker CONFIRMED is cleared; the rest rides into the next wave's bank attempt.
  pendingDebt = unbanked
  consumed.debt = pendingDebt
  mergeConductorSpend(consumed)
  boundaries.push({ wave: N, tier: ranTier, escalated: null })
  consumed.conductor = { reason: null, wavesRun, boundaries }
  snapshot(consumed)   // the crash-recovery record for everything this boundary decided

  // move-feedback: consumed user notes + this wave's explorer/health renderings -> triaged/N/.
  // A COURIER since 0.14.0 (RATIONALE §19). This was the last free-form shell step in either
  // script, left that way on the argument that "every path it touches is absolute, so its cwd
  // decides nothing" — and the prompt promptly let the model write relative ones. wf_318afa1b-e9d:
  // `move-feedback:w1` cd'd to the fixture once, then ran `mkdir -p .roadmap/feedback/triaged/1`
  // and four `[ -f ".roadmap/…" ]` probes in SEPARATE tool calls, each of which started back in
  // the orchestrator's own repo (the Bash tool resets cwd between calls). It reported all four
  // files "MISSING (idempotent skip)" and ok:true; nothing moved.
  // Each move is one self-contained command that always exits 0 and prints MOVED/ABSENT/FAILED, so
  // a missing file never stops the list, and the final `ls` of the destination is what the SCRIPT
  // judges — including the crash-replay case, where a file is ABSENT because a previous attempt
  // already moved it. ISSUE MODE: user bug reports are ISSUES, so the disposal half is gh commands
  // appended to the same closed list, each `|| echo GH-FAIL` — best-effort made mechanical instead
  // of promised in prose. In file mode those commands are simply absent, so the prompt carries no
  // gh text at all (which is what keeps the offline paid fixtures byte-identical).
  const consumedFiles = feedbackDispositions.filter((f) => f.action === 'actioned' || f.action === 'dismissed').map((f) => f.file)
  const fbDir = `${repo}/.roadmap/feedback`
  const triagedDir = `${fbDir}/triaged/${N}`
  // The destination basename is ROLE-QUALIFIED: explorer/, health/ and design/ each render a file
  // called `wave-<N>.md`, so the flat `mv … triaged/<N>/` the free-form prompt asked for had the
  // last two silently overwrite the first — three renderings in, one file out.
  // `note: true` marks a user file the CENSUS observed on disk this wave, so its absence at move
  // time is a defect worth a degradation. An internal rendering exists only if its boundary role
  // ran, so a missing one is an ordinary idempotent skip.
  const fbSources = [
    { path: `${fbDir}/explorer/wave-${N}.md`, as: `explorer-wave-${N}.md`, note: false },
    { path: `${fbDir}/health/wave-${N}.md`, as: `health-wave-${N}.md`, note: false },
    { path: `${fbDir}/design/wave-${N}.md`, as: `design-wave-${N}.md`, note: false },
    { path: `${fbDir}/health/wave-${N}-flake.md`, as: `health-wave-${N}-flake.md`, note: false },
    ...(issueMode ? [] : consumedFiles.map((f) => ({ path: `${fbDir}/user/${f}`, as: `user-${f}`, note: true }))),
  ]
  const ghDispose = issueMode
    ? feedbackDispositions.flatMap((f) => {
      const n = String(f.file)
      if (f.action === 'actioned' || f.action === 'dismissed') {
        const body = `Triaged wave ${N}: ${f.action} — ${String(f.reason ?? '').slice(0, 140).replace(/\s+/g, ' ')}`
        return [`gh issue comment ${ghRepo}${shq(n)} --body ${shq(body)} || echo GH-FAIL`,
          `gh issue close ${ghRepo}${shq(n)} --reason completed || echo GH-FAIL`]
      }
      if (f.action === 'deferred') return [`gh issue edit ${ghRepo}${shq(n)} --add-label status:deferred || echo GH-FAIL`]
      return []
    })
    : []
  const fbCmds = [
    `mkdir -p ${shq(triagedDir)}`,
    ...fbSources.map(({ path, as }) =>
      `test -e ${shq(path)} || { echo ABSENT; exit 0; }; ` +
      `git mv -f ${shq(path)} ${shq(`${triagedDir}/${as}`)} 2>/dev/null || ` +
      `mv -f ${shq(path)} ${shq(`${triagedDir}/${as}`)} || { echo FAILED; exit 0; }; echo MOVED`),
    `ls -1 ${shq(triagedDir)}`,
    ...ghDispose,
  ]
  const LS = 1 + fbSources.length   // index of the `ls` whose output is the archive's contents
  const mv = await courierRun(repo, fbCmds,
    { model: 'haiku', effort: 'low', phase: 'Persist', label: `move-feedback:w${N}` },
    `This archives wave ${N}'s consumed feedback. Each move command reports MOVED, ABSENT or FAILED and ` +
    `always exits 0 — an absent file is an expected result, not a failure to repair. `)
  const archived = new Set(mv.out(LS).split('\n').map((l) => l.trim()).filter(Boolean))
  const unmoved = (what) => degrade({ label: `move-feedback:w${N}`, model: 'haiku', phase: 'Persist',
    kind: 'feedback-unmoved', what })
  if (!mv.ok) {
    // Never a wave outcome: the boundary's decisions are already staged and returned. The evidence
    // simply stays where it is, and next wave's census sees it again.
    unmoved(`wave ${N} feedback was not archived into triaged/${N}/ — ${mv.detail}`.slice(0, 300))
  } else {
    fbSources.forEach(({ path, as, note }, i) => {
      if (archived.has(as)) return                          // moved now, or by an earlier attempt
      if (mv.out(i + 1) === 'ABSENT' && !note) return       // that role never rendered one
      unmoved(`wave ${N}: ${path} is not in triaged/${N}/ as ${as} (${mv.out(i + 1) || 'no report'})`)
    })
    if (ghDispose.some((_, i) => /GH-FAIL/.test(mv.out(LS + 1 + i))))
      degrade({ label: `move-feedback:w${N}`, model: 'haiku', phase: 'Persist', kind: 'gh-sync',
        what: `wave ${N}: a roadmap:bug disposal command failed — issue state is observability and gates nothing` })
  }

  state = consumed   // thread the consumed state into the next wave
}

// Loop exhausted without an arc-complete / early return -> relaunch fresh (resets the agent counter).
// Hand back the last wave's boundary (see lastBoundary): the root needs the same evidence here as on
// any other terminal return. Marked `triaged` because, unlike a true terminal boundary, this one was
// already dispositioned — its findings are banked and its feedback moved, so re-actioning it would
// duplicate the ladder's work.
if (lastBoundary) state = { ...state, boundary: { ...lastBoundary, triaged: true, wave: lastBoundaryWave } }
return await ret('max-waves', null, {})


// The wave's mutations, read off whichever tier ran. No disk writes and no agent calls — so an
// escalating return can collect exactly what the continuation path would have. It DOES mint debt
// in memory (the admissions bank below), which every return path carries out one way or another.
function collect(ranTier, P, triageResult, boundaryPlan) {
  const N = state.wave
  const freshId = makeFreshId()
  let newSkeletons = []
  let reviseList = []
  let cutUnitIds = []
  let journal = null
  let arcCompleteFlag = false
  let debtLedger = []

  // Nothing an admissions-closed boundary was not allowed to mint is merely dropped: each unit
  // becomes a debt line carrying its origin. It banks through BOTH debt channels, because the two
  // terminate differently. `state.debt` is what `ret()` hands the root INTACT on a terminal return
  // — the normal outcome under closed admissions, and it fires before the persist section. And
  // `pendingDebt` is what bank-debt banks and verifies on a continuation; the receipt-time snapshot
  // of `state.debt` is taken right after the harness returns, long before this boundary mints
  // anything, so a line added only to `state.debt` here would never reach a debt issue. On a
  // continuation `consumed.debt` is overwritten from `pendingDebt`, so the pair never double-banks;
  // an unbanked line rides into the next wave's debt.json like any other carried item.
  const bankLine = (sk) => `[not admitted — admissions closed] ${sk?.id ?? 'unnamed'}: ${sk?.goal ?? sk?.title ?? ''}`.slice(0, 400)
  const bankUnadmitted = (skeletons) => {
    if (!skeletons.length) return
    const lines = skeletons.map(bankLine)
    state = { ...state, debt: [...(state.debt ?? []), ...lines] }
    pendingDebt = [...pendingDebt, ...lines]
    log(`wave ${N}: admissions closed — banked ${skeletons.length} draft(s)/promotion(s), admitted 0 units`)
  }

  if (ranTier === 1) {
    const drafts = P.healthFixUnits.map(draftSkeleton)
    if (admissionsClosed) bankUnadmitted(drafts)
    newSkeletons = admissionsClosed ? [] : drafts
  } else if (ranTier === 2) {
    arcCompleteFlag = !!triageResult.arcComplete
    const draftById = new Map(P.healthFixUnits.map((d) => [d.id, d]))
    const admitted = [
      ...(triageResult.admit ?? []).filter((id) => draftById.has(id)).map((id) => draftSkeleton(draftById.get(id))),
      ...(triageResult.promote ?? []),
    ]
    if (admissionsClosed) bankUnadmitted(admitted)
    newSkeletons = admissionsClosed ? [] : admitted
    debtLedger = triageResult.debtLedger ?? []
  } else {
    arcCompleteFlag = !!boundaryPlan.arcComplete
    newSkeletons = boundaryPlan.newUnits ?? []
    reviseList = boundaryPlan.reviseSpecs ?? []
    cutUnitIds = boundaryPlan.cutUnits ?? []
    journal = boundaryPlan.journal
    debtLedger = boundaryPlan.debtLedger ?? []
  }

  // Assign final ids up front so spec files and plan units agree — after dropping duplicates, so a
  // draft filed twice can never be renamed into a second unit.
  const { kept: uniqueSkeletons, dropped: duplicateDrafts } = dedupeDrafts(newSkeletons)
  if (duplicateDrafts.length) {
    const names = duplicateDrafts.map((d) => d?.id ?? '(no id)').join(', ')
    log(`wave ${N}: dropped ${duplicateDrafts.length} duplicate draft(s) from this batch: ${names}`)
    degrade({ label: ranTier === 3 ? `boundary:w${N}` : `triage:w${N}`, model: ranTier === 3 ? 'fable' : 'opus',
      phase: 'Persist', kind: 'duplicate-draft',
      what: `the wave-${N} boundary filed ${duplicateDrafts.length} draft(s) already present in the same batch ` +
        `(${names}) — dropped, not suffixed into a second unit` })
  }
  const prepared = uniqueSkeletons.map((s) => ({ ...s, id: freshId(s.id, s.supersedes) }))

  return { prepared, reviseList, cutUnitIds, journal, debtLedger, arcCompleteFlag,
    feedbackDispositions: triageResult?.feedback ?? [] }
}

// Everything a boundary's decisions must LEAVE BEHIND: the specs a model has to author, the merged
// plan, the issue projection, the debt ledger and the architect journal. Two shapes now — an agent
// call where a model must actually do the work (spec-expand, the gh projections), and a collected
// value where it is transcription (debtSections, journalEntries) and persist.mjs writes it.
// Hoisted out of the wave tail so the ESCALATING returns can stage before handing back —
// arc-observed: a tier-3 needs-user return jumped every one of these, and the boundary's new-unit
// skeletons, the wave's debt and the journal survived only in the run's journal.jsonl. Returns the
// debt items whose banking could NOT be confirmed (issue mode only); the caller carries them rather
// than clearing blind.
async function stage(N, ranTier, c) {
  const { prepared, reviseList, cutUnitIds, journal, debtLedger } = c
  // 7. Materialize — every new skeleton gets its spec file, revisions are applied; then merge.
  //
  // NO SPEC, NO UNIT. The writer's `ok` used to be discarded, so a dead spec-expand minted a plan
  // unit whose spec file did not exist — and the harness hands `.roadmap/specs/<id>.md` to the
  // planner, to Codex, to the spec critique and to both exit gates as the authority on what the
  // unit is. A unit dispatched without one is not a degraded unit, it is an unspecified one. So the
  // brake lives here, at the one place units are minted (the same place `admissions:'closed'` and
  // `tier1MaxDrafts` live): a skeleton whose file was not confirmed on disk does NOT reach
  // mergePlan. It is not lost either — it is banked as debt and ledgered — so the next boundary can
  // re-draft it, and a superseded quarantine stays unresolved rather than being retired by a
  // replacement that never got written.
  phase('Spec-expand')
  const unwritten = new Set()
  // One spec, written and VERIFIED. The verdict is the script's: `cksum < <file>` as the courier
  // observed it, against `cksumOf` of the bytes this script composed — never the writer's `ok`,
  // which says only that it reported. A mismatch buys exactly one fresh sample under a differing
  // prompt (mis-transcription is per-sample stochastic; the differing prompt is what stops
  // `resumeFromRunId` replaying the bad one), and then the file is treated as absent.
  const writeSpec = async (skel) => {
    const { want } = specBytes(skel)
    const attempt = async (label, resample) => {
      const r = await run(specWritePrompt(skel, resample),
        { model: 'haiku', effort: 'low', label, phase: 'Spec-expand', schema: S.write }).catch(() => null)
      if (!r) return { why: 'writer produced no report' }
      if (!r.ok) return { why: `writer reported ok:false — ${String(r.detail ?? '').slice(0, 160)}` }
      const got = String(r.cksum ?? '').trim().split(/\s+/).slice(0, 2).join(' ')
      if (got === want) return { ok: true }
      return { why: `\`cksum\` printed ${got ? `\`${got}\`` : 'nothing'}, expected \`${want}\` — the file on disk is not the spec this boundary composed` }
    }
    const first = await attempt(`spec-expand:${skel.id}`, '')
    if (first.ok) return true
    const second = await attempt(`spec-expand:${skel.id}#rewrite`, SPEC_RESAMPLE)
    if (second.ok) return true
    unwritten.add(skel.id)
    degrade({ label: `spec-expand:${skel.id}`, model: 'haiku', phase: 'Spec-expand', kind: 'spec-unwritten',
      what: `the spec file for ${skel.id} was not confirmed on disk after two attempts (${first.why}; then ${second.why}) — ` +
        `the unit is NOT added to the plan, because a unit with no spec has no authority for the planner, ` +
        `Codex or either exit gate to build and grade against. It is banked as debt for the next boundary to re-draft.` })
    pendingDebt.push({ unit: skel.id, kind: 'structure', severity: 'major',
      what: `wave-${N} boundary drafted unit "${skel.id}" but its spec could not be written and verified, so the unit was not created`,
      why: (skel.goal ?? '').slice(0, 400) })
    return false
  }
  await Promise.all(prepared.map(writeSpec))
  await Promise.all(reviseList.map(async (r) => {
    const res = await run(specRevisePrompt(r), { model: 'sonnet', label: `spec-revise:${r.id}`, phase: 'Spec-expand', schema: S.write }).catch(() => null)
    // Unlike an unwritten spec, a failed revision leaves a VALID spec on disk — the pre-revision
    // one. The unit still dispatches; what it loses is the amendment, which is a degradation to
    // read, not a reason to withhold a unit that already has its authority. There is no expected
    // cksum to check here either: the revised content is the model's to compose, so its report is
    // recorded (which version a later reader is looking at) rather than verified.
    if (!res?.ok)
      degrade({ label: `spec-revise:${r.id}`, model: 'sonnet', phase: 'Spec-expand', kind: 'spec-unrevised',
        what: `the spec revision for ${r.id} was not confirmed (${res ? `writer reported: ${String(res.detail ?? 'ok:false').slice(0, 160)}` : 'writer produced no report'}) — ` +
          `the unit keeps its PREVIOUS spec and still dispatches; the boundary's amendment did not land` })
    else log(`wave ${N}: revised spec ${r.id}.md — cksum ${String(res.cksum ?? '(unreported)').trim()}`)
  }))
  // The units that actually exist after this step. Everything downstream — the plan merge and the
  // issue projection, whose issue BODY is the spec file — keys off this list, never off `prepared`.
  const created = prepared.filter((s) => !unwritten.has(s.id))
  mergePlan(created, cutUnitIds)

  // Issue mode: open a roadmap:unit tracking issue for each new unit added this wave (fix-units and
  // respecs), idempotent by marker, so the harness's per-unit sync clauses have an issue to edit next
  // wave. It reports each unit's issue number back, and we CACHE it into plan.units[].issue: without
  // that, a mid-arc unit has no cached number, gets dropped from the arc-issue task-list rollup (the
  // sweep skips unknown-number units), and forces a marker-search fallback in every folded clause.
  // One Haiku call, only when there is new work; a no-op / '' path in file mode.
  if (issueMode && created.length) {
    const opened = await run(
      STRICT + GH_BEST_EFFORT + MARKER_RULE +
      `Your working directory is the git repository at ${repo}. ` +
      `Open a GitHub tracking issue for each new roadmap unit added in wave ${N}, idempotently. For each unit ` +
      `below: run \`${markerFind('roadmap:unit id=<id>')}\`, substituting that unit's id in BOTH places. If it ` +
      `prints a \`<number> <state>\` pair, the issue already exists: report that number and change NOTHING about ` +
      `the issue — no duplicate, no edit, whether it is open or closed. If it prints nothing at all, the issue is ` +
      `ABSENT: create it with title "[unit] <id>", labels \`roadmap:unit,status:pending,risk:<risk>,wave:${N}\`` +
      `${inPlan.milestone ? `, assigned to milestone "${inPlan.milestone}" (\`--milestone\` takes the milestone NAME)` : ''}, and a body ` +
      `whose FIRST line is exactly \`<!-- roadmap:unit id=<id> -->\` followed by the full contents of ` +
      `${repo}/.roadmap/specs/<id>.md. Units:\n${JSON.stringify(created.map((s) => ({ id: s.id, risk: s.risk ?? 'low' })))}\n` +
      `Report ok:true when every unit has an issue, and in \`opened\` give each unit's {id, number} — the issue ` +
      `number you created or found — so the scheduler can cache it. Note any gh failure in detail.`,
      { model: 'haiku', effort: 'low', label: `issue-new:w${N}`, phase: 'Persist', schema: S.newIssues },
    ).catch(() => null)
    // Cache the numbers so the returned plan AND next wave's dispatchPlan carry them.
    for (const o of opened?.opened ?? []) {
      const u = plan.units.find((x) => x.id === o.id)
      if (u && Number.isInteger(o.number)) u.issue = o.number
    }
  }

  phase('Persist')
  // bank-debt: the durable technical-debt record. ISSUE MODE -> find-or-create roadmap:debt issues:
  // ONE consolidated issue per unit-with-residue, keyed arc+wave+unit (arc-observed: per-finding
  // minting produced 650+ issues in one arc, and index-keyed markers duplicated on a reordered
  // resume — the arc+wave+unit key is a pure function of stable ids, and the arc half is what stops
  // a search from matching the SAME wave number in a previous arc). FILE MODE -> a <!-- wave N --> section in
  // debt.md, ALWAYS stamped (even "no new entries" — ruling 7); per-finding lines are fine there,
  // the volume problem was issues, so the file branch is deliberately untouched.
  // Nothing is cleared until the banker says the marker is THERE. `unbanked` is what it did not
  // confirm; the caller carries it rather than dropping it.
  const unbanked = []
  const debtKind = (k) => (['correctness', 'test', 'structure', 'ergonomics'].includes(k) ? k : 'structure')
  if (issueMode) {
    const byUnit = new Map()
    for (const d of pendingDebt) {
      const k = d.unit ?? 'general'
      if (!byUnit.has(k)) byUnit.set(k, [])
      byUnit.get(k).push(d)
    }
    // marker -> the debt rows it carries, so an unconfirmed marker gives its items back verbatim.
    const rowsFor = new Map()
    const items = [
      ...[...byUnit].map(([uid, ds]) => {
        const marker = `roadmap:debt arc=${arcKey} wave=${N} unit=${uid}`
        rowsFor.set(marker, ds)
        return { marker,
          title: `[debt] ${uid}: ${ds.length} deferred item${ds.length === 1 ? '' : 's'} (wave ${N})`,
          labels: ['roadmap:debt',
            `severity:${ds.some((d) => d.severity === 'major') ? 'major' : 'minor'}`,
            ...new Set(ds.map((d) => `debt:${debtKind(d.kind)}`))].join(','),
          body: ds.map(fmtDebt).join('\n') }
      }),
      ...(debtLedger.length ? [{ marker: `roadmap:debt arc=${arcKey} wave=${N} ledger`,
        title: `[debt] wave ${N} triage ledger (${debtLedger.length} item${debtLedger.length === 1 ? '' : 's'})`,
        labels: 'roadmap:debt', body: debtLedger.map((s) => `- ${s}`).join('\n') }] : []),
    ]
    if (items.length) {
      const res = await run(
        STRICT + GH_BEST_EFFORT + MARKER_RULE +
        `Your working directory is the git repository at ${repo}. ` +
        `Project wave-${N} technical debt into GitHub issues, idempotently. For EACH item below run ` +
        `\`${markerFind('<marker>')}\`, substituting that item's marker in BOTH places. If it prints a ` +
        `\`<number> <state>\` pair the item is already banked: leave that issue completely untouched. If it ` +
        `prints nothing at all, create the issue with the item's title, comma-joined labels, and a body whose ` +
        `FIRST line is exactly \`<!-- <marker> -->\` followed by the item body. Items:\n${JSON.stringify(items)}\n` +
        `Report ok:true when every item is present, and in \`banked\` give one {marker, number} entry for each ` +
        `item you have CONFIRMED is now present on an issue — its own marker, verbatim, and that issue's number. ` +
        `Omit any item you could not confirm rather than guessing: an omitted marker is re-banked next wave, a ` +
        `wrongly-claimed one is lost. Note any gh failure in detail.`,
        { model: 'haiku', effort: 'low', label: `bank-debt:w${N}`, phase: 'Persist', schema: S.banked },
      ).catch(() => null)
      const confirmed = new Set((res?.banked ?? []).map((b) => b.marker))
      for (const it of items) if (!confirmed.has(it.marker)) unbanked.push(...(rowsFor.get(it.marker) ?? []))
    }
  } else {
    // FILE MODE: the wave's section is COLLECTED, and persist.mjs writes it into debt.md. Deciding
    // what the section says is this script's job; putting the text in a file is not, and a
    // deterministic writer cannot half-land one — so there is nothing left to confirm and nothing
    // stays unbanked on this branch.
    const debtLines = [...pendingDebt.map(fmtDebt), ...debtLedger.map((s) => `- ${s}`)]
    debtSections.push({ wave: N, body: debtLines.length ? debtLines.join('\n') : `wave ${N}: no new entries` })
  }
  // Issue mode only: gh is best-effort, so an item the banker could not confirm rides forward.
  if (unbanked.length)
    degrade({ label: `bank-debt:w${N}`, model: 'haiku', phase: 'Persist', kind: 'debt-unbanked',
      what: `${unbanked.length} of ${pendingDebt.length} debt item(s) were not confirmed banked as ` +
        'roadmap:debt issues — kept in state.debt and .roadmap/debt.json, and re-banked at the next boundary' })

  // architect journal, ONLY when tier 3 ran (terminal tier-3 paths note it before their own
  // returns — see noteJournal).
  if (ranTier === 3) noteJournal(N, journal)

  return { unbanked }
}

// Reason-specific brief fields for the return envelope. Hoisted (function declaration) so the
// tier-2/3 escalation returns above can call it before its textual position.
function briefFor(reason, P, N, triageResult, boundaryPlan, census) {
  if (reason === 'contingent-replan') return { edges: P.crossedContingent }
  if (reason === 'contract-amendment') return { debt: P.contractDebt, contracts: contractPaths() }
  if (reason === 'needs-user') return { question: (boundaryPlan?.notes ?? triageResult?.notes ?? ''), context: { wave: N, findings: P.findings, userFeedback: P.userFeedback } }
  return {}
}
