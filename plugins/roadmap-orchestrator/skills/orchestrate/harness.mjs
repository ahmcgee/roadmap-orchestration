export const meta = {
  name: 'roadmap-wave',
  description: 'Execute one wave of a roadmap plan: per-unit build/gate pipelines and a serial merge queue',
  phases: [
    { title: 'Launch', detail: 'verified plan/state pack read (Haiku)' },
    { title: 'Setup', detail: 'integration + unit worktrees' },
    { title: 'Implement', detail: 'codex plan + codex build (Haiku steer)' },
    { title: 'Architect', detail: 'plan-check + exit gate (Fable)' },
    { title: 'Opus-gate', detail: 'first-pass exit gate (gateModel); escalates to Fable when hard' },
    { title: 'Verify', detail: "the spec's lanes, run by codex" },
    { title: 'Review', detail: 'cross-model pre-gate review digest (codex)' },
    { title: 'Fix', detail: 'codex resume applies findings/directives' },
    { title: 'Escalate', detail: 'rescue consults (Fable, capped)' },
    { title: 'Merge', detail: 'serial queue + integrated suite gate' },
    { title: 'Preview', detail: 'green-tip mirror advance (Haiku)' },
    { title: 'Quarantine', detail: 'dossiers for redesign' },
    { title: 'Boundary', detail: 'wave-tail explorer + health assessor + flake re-runs (codex)' },
  ],
}

/* ------------------------------------------------------------------------
 * Launch. This script has no filesystem access, so its input arrives through
 * an agent: the ROOT passes only a small envelope — { roadmapDir, launchId,
 * config? } — and the script's FIRST act is a Haiku courier that reads the
 * plan/state pack off disk and proves what it transcribed, by cksum, in code.
 * The root used to paste plan.json and state.json into `args`, which put the
 * whole pack through the most expensive tier in the system (the root session)
 * on every launch and every resume.
 *
 * NESTED LAUNCH. The conductor dispatches each wave with `plan` and `state`
 * already IN MEMORY — its plan is mutated wave to wave and deliberately does
 * not round-trip through disk — so a nested launch passes both in `args` and
 * reads no pack. The rule, in one line: BOTH in memory => nested; NEITHER =>
 * root, read the pack. One without the other is a caller bug and throws.
 *
 * Shapes: reference.md. Every call pins its model explicitly — agents would
 * otherwise inherit the main-loop model (frontier) silently. All delegations go
 * through run(), a thin wrapper that also tallies per-tier spend for the report.
 * Prompts are deterministic functions of unit ids and shas so that
 * resumeFromRunId can replay completed calls from the journal.
 *
 * This script writes NOTHING under .roadmap/. Everything it decides rides home
 * in the RETURN value, and `persist.mjs` — a real Node process replaying this
 * run's journal at zero model cost — is what puts it on disk. See reference.md
 * "Who writes `.roadmap/`".
 * ---------------------------------------------------------------------- */
// args can arrive JSON-stringified depending on how the caller encoded them — tolerate both.
// (Observed in smoke testing: a stringified args object makes every destructured field
// `undefined`, and undefined paths in prompts make agents improvise in their cwd.)
const A = typeof args === 'string' ? JSON.parse(args) : args
const { roadmapDir, config: overrides } = A

// Cache-buster for ENVIRONMENT READS only. `resumeFromRunId` replays any agent() call whose
// (prompt, opts) is byte-identical — which is exactly what makes a resume cheap, and exactly what
// makes a probe lie: arc-observed twice (2026-08-25/26) a resume replayed a pre-rebuild
// `cd: No such file` provisioning failure and a pre-merge `state:'ready'`, quarantining units whose
// real environment was fine. A probe's whole value is what the disk and git look like RIGHT NOW, so
// every probe prompt carries `args.launchId`, which the ROOT re-generates on every launch AND every
// resume. The launch pack read is one of these: plan.json and state.json on disk are what the LAST
// run left there, so a replayed pack would silently dispatch from a stale plan. WORK-PRODUCT calls
// never carry it — replaying those for free is the point of resume.
// A missing launchId DEGRADES to unsalted rather than throwing (the `no-launch-id` entry below,
// raised once `degrade` exists): the salt is freshness hygiene, and converting one stale-probe
// defect into a dead arc is strictly worse than the defect.
const LAUNCH = A.launchId
  ? `\nProbe id ${A.launchId} — this line exists only to make this request unique; ignore it.`
  : ''

/* --------------------------- schema helpers ---------------------------- */
// Declared here rather than beside the schemas: the launch pack's courier needs them before any
// plan-dependent line has run.
const obj = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required })
const arr = (t) => ({ type: 'array', items: { type: t } })
const oneOf = (vals) => ({ type: 'string', enum: vals })

/* ------------------------- courier vocabulary -------------------------- */
// Location discipline for mechanical agents. THE MECHANISM, established 2026-09-02 (conductor run
// wf_318afa1b-e9d): the Bash tool's working directory RESETS between tool calls. That agent ran
// `cd <fixture> && pwd`, got the fixture back, and its very next call — `git rev-parse
// --show-toplevel`, no cd — printed the orchestrator's own repo. Every relative command after it
// ran here; it reported four wave-1 feedback files "missing (idempotent skip)" and ok:true while
// the fixture's files sat untouched. So "cd first, then prove you are there" was structurally
// UNSATISFIABLE across calls, and every "the agent ran in the wrong cwd" incident in the ledger is
// this one fact. The only rule that survives a reset is: the cd is IN the command. STRICT now says
// that; where the SCRIPT composes the commands, cdGuard makes it mechanical rather than instructed.
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
// EVERY prompt whose schema carries a maxLength must also carry this. A cap is a contract with the
// model, and the prompt is the only place that contract is communicated — a capped field with no
// matching instruction is a trap: the agent overruns it, burns its schema-retries, and dies
// returning null (arc-observed: the conductor's triage prompt had a 600-char `notes` cap, no
// terseness clause, and an invitation to put overflow THERE — it died at two consecutive
// boundaries). Applied as a const, not remembered per-prompt, so it cannot drift out of a new prompt.
const TERSE = 'Keep every free-text field terse — an oversized report fails schema validation and the work is ' +
  'lost. Free-text fields are for what the structured fields cannot carry, not a transcript of your reasoning. ' +
  'Respect every character budget named below exactly, keep each finding to a sentence or two, and emit no ' +
  'field the schema does not define — an unexpected key is rejected as hard as an over-long one. '
// Default per-command output budget. Enough for a `codex login status`, a porcelain status, a
// rev-parse or a failing command's error tail; a test lane's full output does not belong in a
// courier report. The launch pack read raises it (READ_CHUNK) — echoing a whole JSON document is
// the entire point of that one call.
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
// Mirrored in conductor.mjs — keep the two in sync (shared-consts.test.mjs enforces it).
const cdGuard = (where, cmd) => {
  if (typeof where !== 'string' || !where.trim())
    throw new Error(`cdGuard: a command needs an explicit absolute working directory (got ${JSON.stringify(where)}) — ` +
      'a path the script did not compose is a path the model will improvise')
  return `cd '${where.replace(/'/g, "'\\''")}' && ( ${cmd} )`
}
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
// never running the composed command at all. Mirrored in conductor.mjs — keep the two in sync
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
// Raw courier report -> the shape the SCRIPT reads. Shared by courierRun (below, once run() exists)
// and by the launch pack read, which cannot use courierRun: run() tallies spend against the plan
// this very read is what fetches. `out` is trimmed, for the ordinary fact-reading callers; `raw` is
// the untouched capture, which the pack read needs — a JSON document's indentation is content.
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
// Kept after the verbatim WRITERS were deleted, because it is what makes the pack READ
// trustworthy: a courier that truncated, summarised or re-escaped a JSON document cannot produce
// the crc `cksum` prints for the real file, and a crc cannot be iterated toward. (Byte count alone
// was gamed live, in the writer era: a transcriber un-escaped `\"`/`\\` inside string values and
// padded the tail until `wc -c` matched.)
// Mirrored in conductor.mjs — keep the two in sync (shared-consts.test.mjs enforces it).
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
// One courier's content budget for a pack file, sized like the writers it replaces: a single
// response caps at ~32k output tokens, so ~24 KB of echoed document is the shape that fits. A file
// bigger than this is re-read over line ranges rather than silently truncated (readPack below).
// Mirrored in conductor.mjs — keep the two in sync (shared-consts.test.mjs enforces it).
const READ_CHUNK = 24000
// The pack: the documents the root used to paste into `args`.
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
// BOTH in memory => nested (the conductor's live plan); NEITHER => root, read the pack.
if ((A.plan == null) !== (A.state == null))
  throw new Error('args carries only one of plan/state — a NESTED launch passes both in memory, a ROOT launch ' +
    'passes neither and names roadmapDir')
if (A.plan == null && !roadmapDir)
  throw new Error('args.roadmapDir is required on a root launch — the absolute path of the arc\'s .roadmap directory')
const { plan, state: prior } = A.plan != null ? { plan: A.plan, state: A.state } : await readPack()

const C = {
  maxFixRounds: 2,
  maxGateRounds: 2,
  maxConsults: 3,
  maxStops: 5,               // escalation-ladder rounds per unit. Generous units mean several
                             //   stops are normal; this is a runaway brake, not a rationing rule.
  // Reporting cap on a single adversarial pass (gate directives per revise round). A cap on
  // REPORTING, never on reading — overflow past it is banked as debt, not dropped. Enforced
  // code-side, never as schema maxItems (a schema rejection burns the retry cap and kills the
  // call — the documented StructuredOutput death class).
  maxBlockingFindings: 6,
  // Fable is the frontier judgment tier (plan-check, exit gate, mid-loop consult, boundary
  // triage). Fable 5's guidance makes `high` the default for real adjudication — and these calls
  // fire only on the hard decisions — so they run there rather than on the floor. `fableEffort`
  // covers the plan-check + consult; the exit gate has its own `gateEffort`, and the audit
  // spot-check `auditEffort` can be dialled below a full gate to keep the 10% sample cheap.
  fableEffort: 'high',
  gateEffort: 'high',
  // Opus reasoning effort. ONE knob now: `implementEffort` died with 0.14.0's move of planning
  // onto the implementer's own model family — there is no Opus code-authoring pipeline left to
  // dial, and codex roles take `codexRoleEffort`. `opusEffort` covers every Opus call the harness
  // still makes: the boundary assessors, the Opus-first plan-check, the first-pass exit gate where
  // `gateModel` puts it on Opus, and merge conflict/integration fixes. Opus 5 holds review quality
  // at `medium` at a fraction of the tokens; raise per-arc via plan.config if a workload proves
  // effort-sensitive.
  opusEffort: 'medium',
  planCheckRisk: ['low', 'med', 'high'],
  previewRefresh: 'merge',   // 'merge' | 'wave' | 'off' — inert without a plan.preview block
  // Frontier economy: Fable is the metered tier, so Opus grades first everywhere and escalates
  // only on a genuinely hard call. The plan-check is Opus-first (see below) unless
  // planCheck === 'always-fable'; the exit gate is Opus-first unless exitGate === 'always-fable'.
  // High-risk and contract-touching units always take the Fable gate regardless; gateAuditRate
  // deterministically samples a fraction of Opus-approved units for a Fable audit (0 disables),
  // and audit-only forced gates run at the cheaper auditEffort.
  planCheck: 'opus-first',   // 'opus-first' | 'always-fable'
  exitGate: 'opus-first',    // 'opus-first' | 'always-fable'
  gateAuditRate: 0.10,
  auditEffort: 'high',
  // The FIRST-PASS exit gate's Claude tier, by unit risk. 0.14.0 put a cross-model Codex reviewer
  // in front of the gate (`codex-review:<id>`), so the gate's ordinary job is adjudicating a
  // DIGEST — spec-prose findings, convention-reuse findings, contract touches, scope observations —
  // beside the lane ledger and this wave's scope precedent, rather than re-reading the whole diff.
  // A low-risk unit does not need Opus for that; med/high still do, and they still get the raw diff.
  // Overridden per arc via plan.config, and an override REPLACES the map (the config spread is
  // shallow), so name every tier you care about. An unknown tier falls back to 'opus'.
  // Two conditions in code override it back to Opus-on-the-raw-diff, and the direction is
  // deliberate — less evidence must never buy less scrutiny: no digest at all (the reviewer died),
  // and a digest the reviewer itself graded `blocking` or high-risk. The gate has to be able to
  // DISAGREE with the review, and a gate that cannot see the diff cannot.
  gateModel: { low: 'sonnet', med: 'opus', high: 'opus' },
  boundary: 'on',            // 'on' | 'off' — wave-tail explorer + health assessor inside the
                             //   workflow; 'off' for the arc's final wave (the session
                             //   integration review supersedes it)
  healthCheck: 'each-wave',  // 'each-wave' | 'off' — the health-assessor half of the boundary
  flakeReruns: 3,            // full-suite re-runs hunting intermittents; 0 disables
  /* ---- Codex executor lane (Codex is REQUIRED — there is no Claude implementation lane).
     The implementer is `codex exec`, launched as a background process by a cheap steering
     agent inside the unit worktree; Claude keeps every judgment surface (plan, plan-check,
     verify, gates, consults, merge). All facts these knobs rely on are pinned by
     evals/codex-probe.sh (P1) — read it before changing invocation shape. ---- */
  codexModel: 'gpt-5.6-sol',  // -m <model>; null = omit the flag (fall back to Codex's own config)
  codexEffort: 'high',        // -c model_reasoning_effort= — under-provisioned effort is the
                              //   top documented cause of bad Codex output; xhigh for hard arcs
  codexFixEffort: 'medium',   // resume/fix rounds are narrower work than the build
  codexSandbox: 'danger-full-access',  // DELIBERATE, and measured rather than assumed. Codex's OS
                              //   sandbox is built with bubblewrap, which needs an unprivileged
                              //   user namespace. A devcontainer whose runtime seccomp profile
                              //   blocks that syscall (`unshare --user` -> EPERM, even with
                              //   kernel.unprivileged_userns_clone=1) cannot build one, so
                              //   'workspace-write' degrades SILENTLY to no enforcement at all:
                              //   probe-observed, Codex wrote to an absolute path outside its
                              //   worktree under that setting. It was therefore buying zero
                              //   protection while still costing reliability — every apply_patch
                              //   went through a bwrap verification helper that failed and
                              //   retried. Sibling-worktree containment is accepted as a RISK
                              //   here, not enforced. Set back to 'workspace-write' in any
                              //   environment that permits user namespaces, where it is real.
  codexNetwork: false,        // -c sandbox_workspace_write.network_access=true when true
  codexTimeoutMin: 240,       // build deadline before kill-and-assess. This knob — not the
                              //   Phase-0 sizing prose — is the binding constraint on unit size:
                              //   units are sized by what we can specify, and Codex runs the
                              //   horizon. Per-milestone commits are what make a kill survivable.
  codexFixTimeoutMin: 45,     // resume-round deadline (fix rounds and adjudicated resumes)
  codexRoleEffort: 'medium',  // model_reasoning_effort for a ROLE run (`run(p, {model:'codex'})`) —
                              //   a role reads, judges or drafts one artifact, so it is neither a
                              //   240-minute build nor a trivial errand
  codexRoleTimeoutMin: 20,    // role deadline. Deliberately far below codexTimeoutMin: a role that
                              //   has not finished in 20 minutes is stuck, not thinking, and its
                              //   caller has a coded fallback (or a null) either way
  codexBoundaryTimeoutMin: 45,  // deadline for the four BOUNDARY roles (explorer, health, flake,
                              //   design). Longer than codexRoleTimeoutMin for a stated reason: those
                              //   roles drive a live product end to end, read a whole integrated tree,
                              //   or run the full suite N times over — real work rather than the
                              //   one-artifact errand the 20-minute bar was written for. Still far
                              //   below codexTimeoutMin — a boundary role that has not reported in 45
                              //   minutes is stuck, and its caller (an owed marker) handles the null.
  codexSteerModel: 'haiku',   // steering tier; 'sonnet' if Haiku proves unable to drive it (P2)
  codexMaxConcurrent: 4,      // semaphore on concurrent codex processes (one OpenAI account)
  gateMaxConcurrent: 4,       // semaphore on concurrent TEST lanes (verify, gate re-verify, and the
                              //   integrated suite at merge). Unit dispatch is deliberately unbounded —
                              //   the units are cheap to start and mostly wait on codex — but their test
                              //   lanes are not: N full suites on one box is load the orchestrator itself
                              //   creates, and wall-clock budgets are then judged against a host it
                              //   saturated (arc-observed: loads of 28-56 on 16 cores, three false
                              //   env-quarantines in one wave). Throughput-only, like codexMaxConcurrent:
                              //   prompts are unaffected, so resumeFromRunId replay is safe.
  codexProfile: null,         // -p <profile> ($CODEX_HOME/<name>.config.toml) when set
  envPreflight: 'on',         // host-health preflight (pid-cgroup headroom + a reaping PID 1) before
                              //   dispatch; 'off' is the documented escape for a healthy box whose
                              //   PID 1 is not on the known-init list, and it is the ONLY way past it
  ...(plan.config ?? {}),
  ...(overrides ?? {}),
}
const repo = plan.repoPath          // absolute path to the repository
const wtRoot = plan.worktreeRoot    // absolute path OUTSIDE the repository
const intBranch = prior.integrationBranch
const intWt = `${wtRoot}/__integration`
// The preview gets its OWN worktree, exactly like the merge queue's __integration. It used to be
// the operator's PRIMARY checkout — which, in the era when the wave wrote its own tracked
// .roadmap/state.json, made git refuse the detach ("local changes … would be overwritten"),
// explorer and design silently went owed, and a Haiku agent told to make the checkout work
// anyway deleted 163 untracked .roadmap/ files to get past it (twice, 2026-08-28). A dedicated
// worktree puts the operator's tree outside the harness's reach by construction: no preview
// prompt names ${repo} as a checkout target any more.
const prevWt = `${wtRoot}/__preview`
// Preview process artifacts live OUTSIDE every worktree so a mirror checkout never touches them.
const prevPid = `${wtRoot}/__preview.pid`
const prevLog = `${wtRoot}/__preview.log`
// The ports the preview owns — the ONLY listeners a sweep may ever kill. Declared by the architect
// (plan.preview.ports) or, failing that, read off the URL in howToAccess. NEVER inferred by an
// agent: asked to free "the preview's ports", Haiku swept 3000/5173/8000 and then escalated to
// `ps | grep | kill -9`, killing every node process on the host — this workflow included.
const previewPorts = [...new Set(
  (plan.preview?.ports ?? [...String(plan.preview?.howToAccess ?? '').matchAll(/:(\d{2,5})\b/g)].map((m) => Number(m[1])))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536))]
// Preview process control, shared by first setup and every mirror restart. Every entry below is a
// LITERAL command string the script composes, because these ride in a courier's closed command
// list (see `courier`) rather than in prose an agent has to interpret. setsid makes the recorded
// pid a process-group leader so stop can kill the whole tree, not just the parent — a single-pid
// kill strands child listeners and leaves ports held.
// THE DETACHED SHELL WRITES ITS OWN PID, and `${start}` runs INSIDE it. Both halves are 2026-09-02
// scars (see the codex launch sites for the long version of the first):
//   - `… & echo $! > pid` recorded a pid that was dead within a second. The courier's Bash shell has
//     job control on, so a backgrounded job is already a process-group leader and `setsid` must
//     FORK; `$!` names the short-lived parent, and every kill and liveness check hung off a corpse.
//     `sh -c 'echo $$ > …'` records the surviving shell instead — which, after setsid, is also the
//     pgid that `kill -TERM -- -<pid>` targets. Never `echo $!` after the `&`, at any launch site.
//   - `setsid nohup <start>` made `nohup` the thing exec'ing the plan's string, so a start beginning
//     with an env assignment died at once ("nohup: failed to run command 'DEV_SLOT=9'") and every
//     wave that arc ran with no preview at all. Under `sh -c` the string is SHELL input: `VAR=value
//     cmd`, `&&` chains and pipelines all work. A single quote in it cannot survive this wrapping,
//     so `plan.preview.start` is validated against one at load and throws there rather than
//     composing a command that would end the quoted string mid-flight.
const previewStartCmd = (start) => `setsid nohup sh -c 'echo $$ > ${prevPid}; ${start}' > ${prevLog} 2>&1 &`
const previewStopCmd =
  `if [ -f ${prevPid} ]; then kill -TERM -- -$(cat ${prevPid}) 2>/dev/null || kill -TERM $(cat ${prevPid}) ` +
  `2>/dev/null || true; rm -f ${prevPid}; fi`
// The complete, closed kill set: the pidfile's own process group and the declared ports, nothing
// else. Dispatched by the SCRIPT as a one-shot retry when a bring-up fails — never left standing
// inside a bring-up prompt as a licence to "clean up".
const previewSweepCmds = [previewStopCmd, ...previewPorts.map((p) => `fuser -k ${p}/tcp || true`)]
// The allowlist clause carried by every preview courier. A prohibition list is weaker than an
// allowlist, so this states the closed set first and only then names the two hammers that were
// actually reached for.
const previewSweepRetry =
  `The ONLY processes you may kill are the ones the listed commands name: the process group recorded in ` +
  `${prevPid}` +
  (previewPorts.length ? `, and listeners on the preview's own ports (${previewPorts.join(', ')}). ` : ' — no others. ') +
  `Never sweep by process NAME (\`pkill\`, \`killall\`) and never \`ps | grep | kill\`: a name sweep once killed ` +
  `every node process on this host, this workflow included. If a port is held by something the listed commands ` +
  `do not identify, leave it alone and report the failing exit code. `
// The commands that bring the preview up in whatever tree ${prevWt} currently holds. `first` adds
// the one-time setup step and forces a stop/start (a `refresh` command presumes a live process).
const previewBringUp = (first) => {
  const p = plan.preview
  const cmds = []
  if (first && p.setup) cmds.push(p.setup)
  if (!first && p.refresh) cmds.push(p.refresh)
  else if (p.start) cmds.push(p.stop || previewStopCmd, previewStartCmd(p.start))
  // ~60 s of patience (was 5×3 s = 15 s, which a dev stack that builds before it listens loses
  // every time — 2026-09-02: three `preview-failed`, every explorer and design job owed). A stack
  // slower than this window still has to carry its own wait inside `plan.preview.healthcheck`;
  // this loop is the floor, not a substitute for one.
  if (p.healthcheck)
    cmds.push(`i=0; while [ "$i" -lt 20 ]; do ${p.healthcheck} && break; sleep 3; i=$((i+1)); done; ${p.healthcheck}`)
  return cmds
}
const specOf = (u) => `${repo}/.roadmap/specs/${u.id}.md`
const wtOf = (u) => `${wtRoot}/${u.id}`
// Codex process artifacts live OUTSIDE the repo, same contract as the preview pidfile: brief +
// output schema in, events/last-message/stderr/exit-code/session-id out. Structurally outside
// every worktree's tracked tree, so the NOROADMAP write-bar and the merge fence can never see
// them; kept until close-out (SKILL.md) for post-hoc forensics — a degradation's `what` names
// the directory to read. Layout: ${wtRoot}/__codex/<unit>/<step>/{brief.txt,schema.json,
// events.jsonl,last-message.txt,stderr.log,exit-code,session-id,cwd,done.txt,codex.pid,launched-at}
// Codex ROLE runs (the adapter below `noteCodexMeta`) are not owned by a unit, so they share one
// namespace: ${wtRoot}/__codex/roles/<label>/ (and <label>-retry), with the same file layout.
const codexHome = plan.codex?.home ? `CODEX_HOME=${plan.codex.home} ` : ''
const codexDir = (id, step) => `${wtRoot}/__codex/${id}/${step}`
// Report discipline for the code-writing agents: commit first (the commit is the deliverable,
// and it is what makes a killed unit recoverable), then keep the structured report short. The
// platform's schema-retry resends an over-long payload verbatim until the unit dies, so an
// oversized report can waste all the work it describes.
// Every budget here is stated because the cap exists: 2026-07-18 evidence is that opus structured-
// output deaths happened ONLY on capped schemas (16/62 vs 0/102 uncapped), and a cap the model is
// never told is one it cannot respect. Which FIELD overran is unknown — no payloads survive — so
// every capped field names its budget rather than betting on one.
const REPORT = 'Commit your work BEFORE emitting the structured report — the commit is the deliverable. Then keep ' +
  'every free-text field terse and inside its budget: `summary` 2–3 short sentences (max 700 characters); ' +
  '`contractMismatch` one or two sentences (max 300 characters), left empty unless it truly applies; `specGap` ' +
  'likewise one or two sentences (max 300 characters), left empty unless it truly applies; each `debt` ' +
  "entry's `what` and `why` a sentence or two (max 400 characters each); `notes` at most a short paragraph " +
  '(max 2000 characters). An oversized report fails validation and can kill this unit even though the work is done. '
// .roadmap/ belongs to the orchestrator, never to a coding agent. Arc-observed: an
// implementer that respected the write-bar still left a "see debt.md" comment for an
// entry it could not write, and a gate quarantined partly on the phantom reference.
const NOROADMAP = `You cannot create or modify anything under ${repo}/.roadmap/ — that directory is the ` +
  `orchestrator's. Never leave code comments or commit messages referencing debt-ledger or dossier entries: ` +
  `you cannot write those entries, so the reference would be fabricated. Report deviations and deferred ` +
  `imperfections ONLY through your structured output fields. `
// The banking bar, shared by both exit gates. REWRITTEN for the pinned-scope discipline: the old
// form keyed "must fix" on the LIVE diff ("a file this diff touches"), so the eligible-fix set was
// a function of the diff's own growth — and scope→diff→fixes→scope is the closed loop that IS the
// review spiral (RATIONALE: the spiral, named). Banking is now the DEFAULT outside the unit's
// pinned scope; correctness inside it still blocks at any severity, and the correctness-never-banks
// coercion below is unchanged. This knowingly re-creates the §15 debt-volume symptom and trades it
// for diff discipline: a banked item costs one boundary-triage read; a widened diff costs re-review
// on every later round and raises regression odds. Do not tighten this back toward the live diff.
const DEBT_DISCIPLINE = 'Debt discipline: banking is the DEFAULT for anything outside this unit\'s declared ' +
  'scope; blocking is the default for correctness inside it. A defect in scope that makes the spec\'s ' +
  'behaviour wrong, violates a contract or the conventions contract, or leaves an acceptance criterion ' +
  'untested is a revise directive whatever its severity, and may never be banked. Everything else is debt: ' +
  'record it in `debt` (what, why, severity, kind, bankReason — each `what` and `why` a sentence or two, max ' +
  '400 characters each) with bankReason one of: out-of-scope-file | needs-migration-or-ruling | ' +
  'pre-existing-untouched, and do NOT write a directive for it — a directive that widens the diff beyond ' +
  'this unit\'s scope costs more than the imperfection it removes. Structure, naming, ergonomics and ' +
  'tidiness are debt even in scope, unless leaving one would make the NEXT change to that file materially ' +
  'wrong or unsafe — not merely less pleasant. A correctness-kind item is never bankable — you may not ' +
  'approve while one exists; revise or escalate instead. '
// The lane-coverage bar, carried by both exit gates. The verifier reports which commands it ran;
// the gate is the only reader that also has the spec in front of it, so the gate is where "did you
// run what the spec named" is decided. Arc-observed (2026-08-26/27): the verifier substituted
// `test:unit` for the spec's `test:ci`, the architecture-lane row-shape seal was red the whole
// time, and the gate found it only because it re-read the spec.
const LANE_BAR = 'The verification evidence carries `lanes`: every command the verifier actually ran and the exit ' +
  'code it returned. Check that ledger against the acceptance checks the spec names BEFORE you weigh anything ' +
  'else. A check the spec names that `lanes` does not contain — or a narrower, faster or cheaper substitute for ' +
  'one — means this unit is UNVERIFIED whatever `pass` says: issue a revise directive naming the exact command ' +
  'to run, and do not approve on the strength of a lane that was never run. '
// Host facts are never a verdict — carried by every tier that WRITES or ADJUDICATES spec text:
// both plan-checks, both exit gates, the verifier brief, and the conductor's spec-writing tiers.
// Arc-observed 2026-09-04: an Opus plan-check adjudicated an acceptance criterion as "no vitest,
// playwright, test-ci or dev-stack process anywhere on the host" before verify may run. The
// harness's own preview dev-stack is always live and `gateMaxConcurrent` lanes overlap by design,
// so that clause is unsatisfiable BY CONSTRUCTION: the verifier reported blocked and the unit was
// quarantined for a defect no unit had. A tier minted the defect, so the rule lives with the tiers.
// The companion facts are already in the harness: load is recorded and never gated on (LOAD_FACTS,
// `host load: recorded, never gated on` below), and the wave's own concurrency is what produces it.
const HOST_BAR = 'Host facts are never a verdict and never a precondition. The orchestrator\'s own preview ' +
  'dev-stack is always live, verification lanes for sibling units overlap by design, and the host\'s load ' +
  '(loadavg1/cpuCount) is on the record precisely so a wall-clock claim can be judged against it. So never ' +
  'require a quiet host, the absence of other processes (a dev server, a sibling unit\'s test lane, another ' +
  'test runner), or a wall-clock ceiling as an acceptance clause or as a precondition for verification: a ' +
  'spec or plan clause that does is unsatisfiable by construction, and it is a SPEC DEFECT for the ' +
  'adjudicating tier to resolve through its verdict — never something the implementer or the verifier absorbs. '
// The pinned scope envelope, stated to every code-writing agent (the Codex brief's Constraints
// block; FIX_SCOPE is the fix-round counterpart). Scope is computed ONCE per unit before the
// first fix round — fresh build: the approved plan's `files`; adopted branch: the diff at entry
// — and NEVER recomputed from the live diff. Pinning is the
// mechanism, not the membership rule: the spiral's first clause defined the eligible-fix set as
// "files you are already touching", i.e. as a function of the diff the fix rounds themselves grow.
// Do not "simplify" this back to the live diff.
// `plan.scopeAllow` (optional globs — evidence dirs, test files, rehearsal transcripts) names files
// the repo's conventions put in EVERY unit's scope: they are stated to the implementer alongside the
// pinned files and never counted as scope growth, so `scope-growth` stays a real signal instead of
// re-adjudicating the unit's own screenshots at every gate. Absent → the clause is '' and the
// SCOPE/FIX_SCOPE text is byte-identical to before (the paid fixtures depend on that). This is an
// exclusion from the growth CHECK, not a widening of the pinned envelope.
const scopeAllow = plan.scopeAllow ?? []
// Minimal glob → RegExp (no Node APIs here): `**/` = zero or more directories, `**` = anything,
// `*` = any run without `/`. Matched against the diff's repo-relative paths.
const globRe = (g) => new RegExp('^' + g.split('**/').map((part) => part.split('**').map((seg) =>
  seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')).join('(?:.*/)?') + '$')
const scopeAllowRes = scopeAllow.map(globRe)
const scopeAllowed = (f) => scopeAllowRes.some((re) => re.test(f))
const scopeAllowClause = scopeAllow.length
  ? `, plus by repo convention any file matching: ${scopeAllow.join(', ')}` : ''
const SCOPE = (files) =>
  `Scope is fixed before you start and does not grow as you work. In scope: ${
    files?.length ? files.join(', ') : "the files this unit's diff already touches"}${scopeAllowClause}, plus any file you must ` +
  `change to make an acceptance criterion pass — name each such extra file in \`notes\` with a one-line ` +
  `reason (\`notes\` is at most a short paragraph, max 2000 characters). Inside that scope, finish the job ` +
  `properly: wrong behaviour, a missing acceptance test, or a test that would still pass if the behaviour ` +
  `were wrong is yours to fix now, not to defer. Outside it, an imperfection is not yours to fix however ` +
  `easy it is and however plainly wrong it looks — record it in \`debt\` (what, why, severity, kind, and a ` +
  `bankReason from: out-of-scope-file | needs-migration-or-ruling | pre-existing-untouched; each \`what\` ` +
  `and \`why\` a sentence or two, max 400 characters each) and leave the code as it stands. Opportunistic ` +
  `refactoring, renaming, reformatting, tidying adjacent code and improving what the spec did not ask for ` +
  `are excluded from this unit: every one widens the diff a reviewer must read, and a wider diff produces ` +
  `more findings, which produce more fixes. If the spec genuinely cannot be satisfied inside this scope, ` +
  `that is a finding, not a licence — say so in \`specGap\` (one or two sentences, max 300 characters) and ` +
  `stop widening. `
// Fix rounds license exactly the named repairs, nothing adjacent — the counterpart of SCOPE for
// directive-driven work, threaded into every prompt that hands findings/directives to a fixer.
const FIX_SCOPE = (files) =>
  `Fix exactly what is listed above and nothing else. The files you may touch are: ${
    files?.length ? files.join(', ') : "this unit's declared scope"}${scopeAllowClause}, plus any file named in the findings or ` +
  `directives you are addressing. Touching anything outside that set is a scope violation, not initiative — ` +
  `if a listed fix truly cannot be made without it, make the minimal necessary change and name the file and ` +
  `the reason in \`notes\` (at most a short paragraph, max 2000 characters). Do not refactor, rename, ` +
  `reformat, tidy or improve anything the findings did not name; do not add tests for behaviour they did ` +
  `not name; do not re-litigate a finding you disagree with — implement it, or say in \`notes\` why it is ` +
  `wrong and leave the code as it is. `
// The bounded finding policy, shared by both exit gates. Replaces the "over-reporting costs
// nothing" coverage doctrine: every finding becomes a fix round, every fix widens the diff the
// next pass re-reads, and that compounding loop — not any single bad finding — is what burned
// whole arcs. Bounds the REPORTING, never the reading.
const FINDING_BAR = (noun) =>
  `Report a ${noun} only when all three hold: this diff introduced the problem, or the spec requires ` +
  `something the diff omits; you can state the evidence in one sentence — for a spec, contract or ` +
  `conventions violation, QUOTE the clause violated; and it falls in one of exactly four categories: ` +
  `(1) incorrect behaviour; (2) a spec, contract or conventions violation; (3) an acceptance criterion left ` +
  `untested, or a test that would still pass if the behaviour were wrong; (4) scope creep — behaviour or ` +
  `files in this diff that the spec did not ask for. Nothing else qualifies: not style, naming or ` +
  `formatting, nothing a linter, formatter or typechecker enforces, no preference without a defect behind ` +
  `it, and never the same defect twice under two headings. Under-reporting a real defect and over-reporting ` +
  `a non-defect are BOTH failures here: every ${noun} becomes a fix round, and every fix widens the diff ` +
  `that must be read again. `
// `contractMismatch` is a TRIGGER, not a notes field: its mere PRESENCE fires the architect consult,
// forces the (metered) Fable exit gate, banks a kind:'contract' debt entry, and bounces the whole run
// back to the root for a contract amendment. The model must be told that, or it uses the field as a
// scratchpad — arc-observed: an implementer wrote "None. FYI: ..." (explicitly stating no contract was
// contradicted) and cost a frontier gate plus a full root round-trip on a non-existent amendment.
// NOTE: deliberately no code-side "is this really a mismatch" guard. Suppressing a genuine
// frozen-surface deviation (the H-7 failure, RATIONALE §10) is far worse than an extra escalation, and
// any string-matching heuristic would eventually swallow a real one. Over-escalation is the safe error.
const MISMATCH_IS_A_TRIGGER =
  'Leave `contractMismatch` EMPTY unless you actually deviated from a frozen contract surface. It is a trigger, ' +
  'not a notes field: merely filling it in escalates to the frontier architect and returns the whole run for a ' +
  'contract amendment. Never write "none" or an FYI there — observations, caveats and things you merely want ' +
  'flagged go in `notes` or `debt`. '
// The pull-channel to the architect (feedback 10a). Evidence for its existence: the mechanical
// rescue triggers fired ZERO times in 92 units, while every real failure was a silent design
// decision under a spec that didn't cover it. The same scratchpad-abuse discipline as
// MISMATCH_IS_A_TRIGGER applies — an FYI here costs a frontier consult.
const GAP_IS_A_TRIGGER =
  'Separately, `specGap` is your pull-channel to the architect: fill it ONLY when you made (or must make) a ' +
  'decision the spec does not settle and reasonable engineers would diverge — one or two sentences stating the ' +
  'decision you took and the alternative. It is a trigger: its mere presence consults the frontier architect, who ' +
  'may redirect the work. Routine judgment calls you are confident in, observations, and deferrals do not belong ' +
  'there — those go in `notes` or `debt`. '
// The arc's DIRECTION — the architect's steering, threaded into JUDGMENT surfaces only.
// architect-log.md already exists and is already seeded at Phase 0, but until now it reached the
// conductor's boundary agents alone: plan-check, the exit gate and the escalation adjudicator saw
// spec + contracts + conventions, which say what must be TRUE and never what the arc is aiming at.
// That left the ladder's `decided` tier picking between defensible options on local reasoning —
// arc-observed (horizon fixture, run 3): a named open decision with two defensible answers and no
// principle available to choose by. Direction is a TIE-BREAKER, strictly subordinate: it steers
// where the spec and the contracts are silent, and it never overrides either. It is deliberately
// absent from every Codex brief — a target state in an implementer's prompt is an invitation to
// build the end state instead of the unit.
const architectLog = plan.architectLog ?? `${repo}/.roadmap/architect-log.md`
const directionClause = plan.direction === false ? '' :
  `The arc's DIRECTION — where this codebase is deliberately heading, and the preferences to break ties ` +
  `by — is the "## Direction" section of ${architectLog}; read it before you rule. It is subordinate to the ` +
  `spec and the frozen contracts: where they settle a question it does not apply, and it never licenses ` +
  `widening scope. Where they are silent and two answers are both defensible, prefer the one the direction ` +
  `leans toward, and say which preference decided it. `
const sameSha = (a, b) => !!a && !!b && (a.trim().startsWith(b.trim()) || b.trim().startsWith(a.trim()))
const brief = plan.briefPath ?? `${repo}/.roadmap/brief.md`   // Phase-0 codebase brief: commands + conventions
// Optional standing cross-cutting conventions contract (shared-utility catalog + naming/
// error/pattern conventions). Threaded into implement/review/both gates so units enforce
// cross-unit consistency proactively; '' when absent, leaving those prompts byte-identical.
// Place it under .roadmap/contracts/ so edits to it fire the same frozen-surface escalation.
const conventions = plan.conventions
const convClause = conventions
  ? `A standing cross-cutting conventions contract at ${conventions} catalogues shared utilities every unit must ` +
    `reuse rather than reinvent and conventions (naming, error handling, recurring patterns) every unit must ` +
    `follow; treat it as a frozen contract alongside the unit's own. Reimplementing a catalogued shared ` +
    `utility inside this unit's own diff is a violation of that contract, not a style preference: it blocks, ` +
    `and it is never bankable as structure. `
  : ''
// Design authorities bind like contracts (SKILL.md Phase 0). Arc-observed: without this, UI units
// built without their comps in the fork base and "comp-conformant" criteria were graded by jsdom
// presence tests — the result was systematic bespoke reimplementation of every designed screen.
// The dominant failure was ADOPTION, not visual drift, and adoption is judgeable from the comp
// SOURCE by a text agent, so this clause carries the per-unit half; the eyes live at the boundary.
// Same idiom as convClause: '' when the unit cites no design, leaving every prompt byte-identical
// on arcs without designAuthorities (the property the sims assert, and what makes the paid
// fixtures valid evidence for changes that ride alongside this one).
const authOf = (cite) => (plan.designAuthorities ?? []).find((a) => a.id === String(cite).split('#')[0])
const designClause = (unit) => unit.design?.length
  ? `This unit's surface is governed by design authorities — binding sections: ${unit.design.join(', ')}; ` +
    `source in-repo at ${[...new Set(unit.design.map((d) => authOf(d)?.path).filter(Boolean))].join(', ')}. ` +
    `A comp binds like a frozen contract: adopt the comp's component and wire it through thin adapters — never ` +
    `rebuild a designed screen from primitives. Partial adoption can be right, but it is a deliberate choice: ` +
    `it must be stated and justified, never left to pass silently. `
  : ''
// GitHub issue projection (issue mode only; reference.md "GitHub issue tracking"). Issues MIRROR the
// work — the scheduler stays on state.json, which the script owns; agents (not the script) run gh.
// Every clause below is a BEST-EFFORT trailing addendum to an agent whose real job is elsewhere, and
// resolves to '' in file mode so every prompt stays byte-identical to the legacy path (the property
// the sims assert and the paid fixtures rely on). Sync is idempotent by a body MARKER, never by a
// threaded issue number (numbers are non-deterministic and would break resumeFromRunId): a stale or
// absent unit.issue cache is harmless. A gh failure is swallowed and reconciled by the wave-tail
// sweep (syncIssues) — no unit or wave outcome may ever depend on issue state.
const issueMode = plan.tracking === 'issues'
const ghRepo = plan.repoSlug ? `--repo ${plan.repoSlug} ` : ''
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
// `gh` has no `-C`: without `--repo` it reads the repository out of its WORKING DIRECTORY, and a Bash
// tool's working directory RESETS between commands (wf_318afa1b-e9d). So every gh command this script
// composes carries its own `cd`, exactly as cdGuard does for a courier's list — redundant when a
// repoSlug supplies `--repo`, load-bearing when the plan has none, and free either way.
// Mirrored in the other workflow script — keep the two in sync (shared-consts.test.mjs enforces it).
const GH_HERE = `cd '${repo}' && gh`
const markerFind = (marker) => `${GH_HERE} issue list ${ghRepo}--search '"${marker}" in:body' --state all --limit 30 ` +
  `--json number,body,state --jq '[.[] | select(((.body // "") | split("\\n")[0] | sub("\\r$"; "")) == ` +
  `"<!-- ${marker} -->")] | .[0] | select(. != null) | "\\(.number) \\(.state)"'`
// The obligations that ride with every markerFind. Duplicated in both scripts — keep them in sync.
const MARKER_RULE = 'Run that search command EXACTLY as written: its jq predicate is what makes the match ' +
  'trustworthy, requiring the candidate body\'s FIRST line to be exactly the marker comment. Never widen the ' +
  'search, never fall back to `.[0].number`, and never adopt an issue you found some other way — no exact ' +
  'match means ABSENT, and absent means create. Never edit the labels, milestone, title or body of a CLOSED ' +
  'issue, and never remove a `status:merged` label. '
// Resolve a unit's issue number into $ISS and its state into $ISSTATE. Prefer the cached number
// (recorded at Phase 0 — exact and immune to GitHub search-index lag on a just-created issue); fall
// back to the exact-marker search for resume or when the cache is absent. Either way the semantics
// are find-by-id, never thread-a-dependency. $ISSTATE is empty on the cached path (unknown, and the
// cache only ever holds an issue this arc opened) and OPEN/CLOSED on the search path.
const findIssue = (id, cached) =>
  cached != null
    ? `ISS=${cached}; ISSTATE=; `
    : `HIT=$(${markerFind(`roadmap:unit id=${id}`)} 2>/dev/null); ISS=\${HIT%% *}; ISSTATE=\${HIT##* }; `
const GH_BEST_EFFORT = 'Do the following on a BEST-EFFORT basis, only AFTER the work above is finished and its ' +
  'result decided: if any gh command errors (no network, auth, rate limit, missing issue), ignore it and carry ' +
  'on — issue state is observability, never a gate, and a wave-tail sweep reconciles anything missed. ' +
  `Write every gh command you compose yourself as \`${GH_HERE} …\`: your working directory does not persist ` +
  'between commands, and without `--repo` gh reads the repository from wherever it happens to be standing. '
// The unit's issue moves to status:running once the SCRIPT has decided the worktree is buildable.
// This used to ride on the setup prompt; setup is a closed command list now, and a `gh` find-or-
// create is one of the two things that genuinely still needs a model (an exact-marker search whose
// hit is a candidate, not an answer). So it is its own best-effort call — dispatched ONLY in issue
// mode, so file mode makes no call at all and the offline paid fixtures stay byte-identical.
const ghUnitRunning = (unit) => run(
  STRICT +
  `In the git repository at ${repo}: ${GH_BEST_EFFORT}${MARKER_RULE}The scheduler has confirmed a buildable ` +
  `worktree for unit ${unit.id}, so mark its tracking issue in progress: ${findIssue(unit.id, unit.issue)}` +
  `if $ISS is non-empty AND $ISSTATE is not CLOSED, run ` +
  `\`${GH_HERE} issue edit ${ghRepo}"$ISS" --remove-label status:pending --add-label status:running\`. ` +
  `Run no other command: no checkout, no branch, no worktree, no merge. Report ok. ` +
  `Keep \`detail\` to one sentence.`,
  { model: 'haiku', effort: 'low', phase: 'Setup', label: `issue-running:${unit.id}`, schema: S.ok },
).catch(() => null)
const ghMerged = (unit) => issueMode
  ? `\n${GH_BEST_EFFORT}${MARKER_RULE}If and only if the merge LANDED and the full suite PASSED, close this ` +
    `unit's tracking issue as done: ${findIssue(unit.id, unit.issue)}if $ISS is non-empty, run ` +
    `\`${GH_HERE} issue edit ${ghRepo}"$ISS" --remove-label status:running,status:merge-ready --add-label status:merged\` ` +
    `then \`${GH_HERE} issue close ${ghRepo}"$ISS" --reason completed --comment "Merged into ${intBranch}."\`. ` +
    (unit.closes?.length
      ? `Under the same condition (merge landed, suite passed), also close each issue this unit RESOLVES: ` +
        unit.closes.map((n) =>
          `\`${GH_HERE} issue close ${ghRepo}${n} --reason completed --comment "Resolved by unit ${unit.id} (merged into ${intBranch})."\``).join('; ') +
        ` — skip any already closed. `
      : '')
  : ''
// Per-tier spend tally, returned in the wave state so the session report can show
// where frontier attention actually went (and the dial can be tuned on evidence).
// `codex` counts codex ROLE dispatches (one per `codex exec` the role adapter launched, retries
// included) — the bucket the 0.14.0 shift off Claude tiers actually shows up in. `codexRuns` below
// counts every codex PROCESS including the build/fix lane's.
const spend = { fable: 0, opus: 0, sonnet: 0, haiku: 0, codex: 0, planChecks: 0, opusPlanChecks: 0, gateRounds: 0, opusGateRounds: 0 }
// Arc-cumulative semantics — relaunches accumulate instead of resetting (arc-observed: cross-crash
// tallies had to be hand-summed). Tolerant of older state files: unknown numeric keys carry over, junk drops.
for (const [k, v] of Object.entries(prior.spend ?? {}))
  if (typeof v === 'number' && Number.isFinite(v)) spend[k] = (spend[k] ?? 0) + v
// Debt ledger for this wave: consciously-deferred imperfections surfaced by the reviewer,
// the exit gates, or the implementer. Returned in the wave state; the architect triages it
// at the next boundary and appends un-promoted items to the living .roadmap/debt.md.
const debtLog = []
// Escalation ledger. Every ruling on an implementer stop: which tier answered it, which boundary it
// crossed, and who ruled — one row each, RETURNED with the wave and appended to
// .roadmap/escalations.jsonl by persist.mjs. state.json keeps only the per-unit STOP COUNT, which
// is the only part the run itself READS: the three-strikes brake needs a count that survives a unit
// re-entering in a LATER wave (the in-pipeline counter resets), and escalation-rate-per-unit is the
// calibration signal that replaced the old self-estimated "0.5-2 agent-hours" sizing heuristic.
// A unit that stopped five times was under-specified; one that never stopped could have been sized
// larger. Forensics in the envelope, decisions in state.
const escalationStops = { ...(prior.escalationStops ?? {}) }
const escalations = []
const escalate = (row) => {
  escalationStops[row.unit] = (escalationStops[row.unit] ?? 0) + 1
  escalations.push({ script: 'harness', wave: (prior.wave ?? 0) + 1, ...row })
}
// Normalized against the schema enums: an out-of-enum kind (the old 'quality' default was one)
// rode into state.json and collapsed unpredictably downstream. 'contract' is legal here — the
// mismatch pathway stamps it directly and the conductor routes on it.
const DEBT_KINDS = ['correctness', 'test', 'structure', 'ergonomics', 'contract']
const DEBT_BANK_REASONS = ['out-of-scope-file', 'needs-migration-or-ruling', 'pre-existing-untouched']
// Dedupe key: (unit, kind, hash of the text). The ledger was a pure append with no identity at
// all, so a resume — which replays a cached implementer report byte-identically — re-banked the
// same items against a branch that had since resolved them (2026-08-25). Hashing `what` rather
// than keying on the whole item means a re-worded confession still counts as new (it is), while a
// literal replay does not. Wave-scoped, like `debtLog` itself.
const debtSeen = new Set()
const addDebt = (unitId, sha, items, defaults = {}) => {
  for (const d of items ?? []) {
    if (!d) continue
    const o = typeof d === 'string' ? { what: d } : d
    const kind = [o.kind, defaults.kind].find((k) => DEBT_KINDS.includes(k)) ?? 'structure'
    const bankReason = [o.bankReason, defaults.bankReason].find((r) => DEBT_BANK_REASONS.includes(r))
    const what = o.what ?? o.summary ?? ''
    const key = `${unitId}|${kind}|${hashStr(what)}`
    if (debtSeen.has(key)) continue
    debtSeen.add(key)
    debtLog.push({
      unit: unitId, sha, kind,
      severity: o.severity ?? defaults.severity ?? 'minor',
      what, why: o.why ?? '',
      ...(bankReason ? { bankReason } : {}),
      // A REBANKED item is one banked against a unit whose work has already landed — a ghost of a
      // finding the branch resolved. It stays in the ledger (dropping evidence is worse) but the
      // conductor's contract-debt filter ignores it, so a resolved ghost can no longer force a
      // contract-amendment return to the root.
      ...(defaults.rebanked ? { rebanked: true } : {}),
    })
  }
}
// Gate coercion helpers: a gate that APPROVES while holding a correctness-kind debt item is the
// verdict-downgrade path the debt discipline forbids — the items become revise directives instead.
const correctnessDebt = (items) => (items ?? []).filter((d) => d && typeof d === 'object' && d.kind === 'correctness')
const asDirectives = (items) => items.map((d) => ({
  what: `Fix now (correctness debt is not bankable): ${d.what}`,
  why: d.why || 'a correctness-kind finding blocks approval; banking it would ship a known bug',
}))

// Skill-defect ledger: every time the ORCHESTRATOR's own machinery misbehaves — an agent dies
// without a report, a schema-retry fires, a salvage rescues a null — record it instead of silently
// swallowing it. Every safety net below is otherwise SILENT, which is exactly how a deterministic
// schema-cap bug masqueraded as three runs of "network flakiness" (RATIONALE §14). Defects in the
// ORCHESTRATOR only — product imperfections go to `debt`, a different audience.
// This wave's rows, in memory: read in-script (the commit-probe dossier mines them for the real
// cause) and RETURNED, whence persist.mjs appends them to the arc's .roadmap/degradations.jsonl.
// Deliberately NOT in serialize(): carrying an arc-cumulative ledger inside state.json is what made
// each snapshot bigger than the last (a third of a 170-190 KB document by wave 19 of one arc).
const degradations = []
const degrade = (o) => {
  degradations.push({ script: 'harness', wave: (prior.wave ?? 0) + 1, ...o })
  log(`DEGRADED [${o.label ?? 'agent'} · ${o.model}] ${o.what}`)
}

// The `no-launch-id` degradation for an unsalted run. LAUNCH itself is computed at the top of the
// file (it salts the launch pack read, which happens before `degrade` exists); this is where it is
// finally recorded.
if (!LAUNCH)
  degrade({ label: 'launch-id', model: 'haiku', phase: 'Setup', kind: 'no-launch-id',
    what: 'args.launchId absent — environment probes (provisioning, integration setup, the merged/reachability ' +
      'probes) run UNSALTED, so a resumeFromRunId replay can serve stale disk/git facts from cache. ' +
      'Root: pass a fresh args.launchId on every launch and every resume.' })

/* ------------- host load: recorded, never gated on (wave-scoped) -------- */
// Two closed commands appended to every lane that spends the box's cores. Courier work — the
// lane reports the numbers, nobody judges them. The point is auditability: a unit quarantined for
// breaching a wall-clock budget at load 35 on 16 cores is a scheduling artefact, and without the
// numbers on the record that is indistinguishable from a real defect (arc-observed 2026-08-26).
// Deliberately NOT a gate: the load is largely self-inflicted, so waiting on it would wait on our
// own siblings.
// ONE vocabulary for the two commands, shared with the env preflight, which runs them through
// courierRun (the canonical way to RUN a shell fact) and seeds `lastLoad` before any lane exists.
// The lanes keep reporting them inline rather than paying a second agent per lane: a lane already
// runs commands, and the number that matters is the load WHILE the suite ran, which a courier
// sampled beforehand cannot give.
const LOAD_CMDS = ['cat /proc/loadavg', 'nproc']
const LOAD_FACTS =
  `Also report loadavg1 = the first number printed by \`${LOAD_CMDS[0]}\`, and cpuCount = the number printed ` +
  `by \`${LOAD_CMDS[1]}\` — run those two commands exactly and report what they print, as numbers. `
// Most recent load pair any lane reported, so a degradation raised where no verify result is in
// hand (a codex wall-clock kill) can still cite the host it happened on.
let lastLoad = null
const noteLoad = (v) => {
  // Finite, not merely `typeof number`: the preflight parses these out of command output, and a
  // NaN riding into a degradation reads as "host load NaN on NaN cpu" — worse than saying nothing.
  if (Number.isFinite(v?.loadavg1) && Number.isFinite(v?.cpuCount))
    lastLoad = { loadavg1: v.loadavg1, cpuCount: v.cpuCount }
}
const loadNote = (v) => {
  const l = (typeof v?.loadavg1 === 'number' && typeof v?.cpuCount === 'number') ? v : lastLoad
  return l ? ` [host load ${l.loadavg1} on ${l.cpuCount} cpu]` : ''
}

/* ------------- host health: the two facts that halt a wave -------------- */
// Read by the env preflight below (see the block beside the codex probe). Kept here with the other
// host-fact vocabulary so the commands the box is asked about live in one place.
const PIDS_CUR = '/sys/fs/cgroup/pids.current'
const PIDS_MAX = '/sys/fs/cgroup/pids.max'
// Below this fraction of the pid cgroup free, forking is a coin flip: the arc-observed box was at
// 36,350/36,792 (1.2% free) when three full-suite gates died of EAGAIN in one wave.
const PIDS_MIN_HEADROOM = 0.2
// PID 1 must reap orphans — and whether it does is EVIDENCE, not a name. A known-init allowlist
// (`init|tini|systemd|docker-init|dumb-init`) was the first cut and it was wrong in practice: the
// ordinary devcontainer idiom is PID 1 = `sh` running `while sleep 1 & wait $!; do :; done`, which
// reaps perfectly (0 zombies, 35 of 36,790 pids after three days of heavy agent runs) and would
// have halted every wave on a healthy box. So count the zombies instead. `|| true` because
// `grep -c` exits 1 when it counts none, and the courier stops at the first non-zero exit — a
// healthy host must not truncate the command list.
const ZOMBIE_CMD = "ps -eo stat= | grep -c '^Z' || true"
// The threshold is deliberately far from both edges: a reaping host sits at 0 to a few transient
// zombies, while the two real incidents were ~9,500 and 35,940. 1000 is an order of magnitude
// above any transient burst and an order of magnitude below either incident, so it cannot fire on
// a healthy box and cannot miss a reaper-less one.
const ZOMBIE_HALT = 1000


/* ------------- shared-red circuit breaker (wave-scoped) ----------------- */
// One pre-existing red outside every unit's diff used to be judged N times independently: N fix
// rounds, N scope-creep patches to the same file on N branches, then quarantines for a failure no
// unit caused (arc-observed 2026-08-25). The breaker collapses that into one signal. A failing
// spec claimed by >= 2 units that appears in NONE of their diffs is not a unit defect — it is one
// shared assertion. It is degraded ONCE, suppressed in every affected unit's fix rounds (the units
// proceed on their remaining failures), and surfaced to the boundary as a FINDING.
//
// A finding, never a debt item, and that distinction is load-bearing: debt must never create a
// wave (that brake is what makes arcs terminate), so a shared red rides the promote/escalation
// path instead, which the cut line already brakes.
const specOwners = new Map()   // failing spec path -> Set(unitId)
const unitDiffs = new Map()    // unitId -> Set(diffFiles), the diff at the time of that verify
const sharedReds = new Map()   // failing spec path -> { spec, units, wave }
const noteFailingSpecs = (unitId, v) => {
  noteLoad(v)
  if (!v || v.pass || v.blocked) return
  unitDiffs.set(unitId, new Set(v.diffFiles ?? []))
  for (const f of v.failingSpecs ?? []) {
    if (!f) continue
    if (!specOwners.has(f)) specOwners.set(f, new Set())
    specOwners.get(f).add(unitId)
  }
  for (const [f, owners] of specOwners) {
    if (sharedReds.has(f) || owners.size < 2) continue
    // If any claimant's own diff touches the spec, it is that unit's business, not a shared red.
    if ([...owners].some((id) => unitDiffs.get(id)?.has(f))) continue
    sharedReds.set(f, { spec: f, units: [...owners], wave: (prior.wave ?? 0) + 1 })
    degrade({ label: `shared-red:${f}`, model: 'haiku', phase: 'Verify', kind: 'shared-red',
      what: `${f} fails for ${owners.size} units (${[...owners].join(', ')}) and appears in none of their ` +
        `diffs — a shared pre-existing red, not a unit defect${loadNote(v)}. Fix rounds for it are suppressed ` +
        `on every affected unit, and it goes to the boundary as ONE finding to adjudicate` })
  }
}
const suppressedSpecs = (v) => (v?.failingSpecs ?? []).filter((f) => sharedReds.has(f))
// True when the breaker has taken over this verify's ENTIRE red: the unit has nothing of its own
// left to fix, so it proceeds to its gates on the work it actually did rather than burning fix
// rounds — or a quarantine — on somebody else's assertion.
const fullySuppressed = (v) =>
  !!v && !v.pass && !v.blocked && (v.failingSpecs?.length ?? 0) > 0 &&
  suppressedSpecs(v).length === v.failingSpecs.length
const sharedRedClause = (v) => {
  const f = suppressedSpecs(v)
  return f.length
    ? ` These failing specs are a SHARED pre-existing red — they fail for several units and no unit's diff ` +
      `touches them: ${f.join(', ')}. They are being adjudicated once at the boundary. Do not attempt to fix ` +
      `them and do not edit them; fix only the remaining failures.`
    : ''
}

/* ------------- gate scope rulings + precedent (wave-scoped) ------------- */
// The breach was always recorded (a `scope-growth` degradation); the gate's approve/revert VERDICT
// on each out-of-scope file never was, so a later gate had nothing to be consistent with and two
// identical breaches in one wave got opposite answers (arc-observed 2026-08-23). Record the
// rulings, then hand a gate the ones its siblings already made.
const scopeRulings = []
const recordScopeRulings = (unitId, g) => {
  for (const r of g?.scopeRulings ?? [])
    if (r?.file && (r.verdict === 'approve' || r.verdict === 'revert'))
      scopeRulings.push({ unit: unitId, file: r.file, verdict: r.verdict })
}
// Deterministically ordered and capped, so the clause is a pure function of the rulings recorded
// so far. It IS order-dependent across concurrent units, which is the one price here: a resume
// whose gate ordering differs sees a different prompt and re-runs the call instead of replaying it
// from the journal — a cache miss, never a wrong answer.
const scopePrecedent = (unitId) => {
  const rows = scopeRulings.filter((r) => r.unit !== unitId)
    .sort((a, b) => (a.unit === b.unit ? a.file.localeCompare(b.file) : a.unit.localeCompare(b.unit)))
    .slice(0, 12)
  return rows.length
    ? ` Precedent — rulings other gates already made on out-of-scope files this wave. Follow them unless you ` +
      `can say what makes this case different: ${rows.map((r) => `${r.file} (${r.unit}) → ${r.verdict}`).join('; ')}.`
    : ''
}

// One code-level retry on structured-output failure: agents deep in tool-work
// occasionally end their turn without a valid structured report (observed ~1 in 15
// impl-stage calls across eval runs). A single retry with an explicit report-last
// instruction converts a unit-killing flake into an occasional double-cost call.
const run = async (prompt, opts) => {
  // `model:'codex'` is not a Claude agent call at all — it goes to the CODEX ROLE ADAPTER
  // (`codexRole`, below `noteCodexMeta`), which spends one Haiku courier and one `codex exec`,
  // never throws, and never touches the platform halt. Everything below this line — the spend
  // tally, the StructuredOutput retry, `agent()` itself — is Claude-only.
  if (opts.model === 'codex') return codexRole(prompt, opts)
  spend[opts.model] = (spend[opts.model] ?? 0) + 1
  try { return await agent(prompt, opts) }
  catch (e) {
    if (!String(e?.message ?? e).includes('StructuredOutput')) throw e
    spend[opts.model] = (spend[opts.model] ?? 0) + 1
    // A schema-retry firing is itself a signal: one is noise, a pattern means a cap is wrong.
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'schema-retry',
      what: `structured output rejected, retrying — ${String(e?.message ?? e).slice(0, 200)}` })
    return agent(
      prompt + ' IMPORTANT: your previous structured report was REJECTED, so the work may be done but unrecorded. ' +
      'Emit exactly the requested schema and no other keys — an unexpected key is rejected as hard as an ' +
      'over-long one. Cut every free-text field to one sentence; drop optional fields entirely rather than ' +
      'filling them. Do not redo the task: if the commit already exists, report what it did.',
      { ...opts, label: `${opts.label ?? 'agent'}#retry` })
  }
}
// agent() RESOLVES TO null (it does NOT throw) when a subagent dies — a terminal API error, or its
// own schema-retries exhausted. run()'s StructuredOutput retry above only fires on a THROW, so it
// never covers that path. Any result that gets DEREFERENCED must funnel through runOr(), which
// re-runs the shorten-aggressively rescue on a null and then falls back. Wave-level calls
// (integration worktree setup, provisioning) are the fatal ones: a null there is a TypeError that
// kills the whole wave — and, under the conductor, the whole multi-wave run.
// The null carries NO error object — the platform tells us nothing about why. So record what we DO
// know (which agent, where) and point at the transcript; that is the difference between "the network
// is flaky, probably" and "read agent-*.jsonl for label X".
// A dead REPORT is not a dead UNIT. 2026-07-18, twice: a code-writing agent committed its work,
// then its structured report was rejected five times, `run()` rethrew, and the scheduler's catch
// quarantined a unit whose commits were on the branch and correct. The architect re-verified and
// resurrected both by hand. REPORT's commit-first discipline exists precisely so the commit
// survives the report — this sentinel is the other half of that bargain: when a code-writing
// agent's report is lost, ASK THE BRANCH what happened instead of assuming the worst.
const REPORT_LOST = { summary: '(report lost — see degradations)', filesChanged: [], reportLost: true }
// Both wrappers below are CLAUDE-only recoveries, and reaching either with `model:'codex'` is a
// caller bug worth failing on rather than absorbing: runOr's salvage would re-launch a whole
// `codex exec` with a "your report was rejected" sentence stapled to the brief, and runReq would
// convert a dead OpenAI seat into a PLATFORM outage that halts the wave. A codex role has its own
// retry and its own tagged failure (see the adapter's header) — call `run()` and branch on null.
const refuseCodexWrapper = (opts, who) => {
  if (opts?.model === 'codex')
    throw new Error(`${who}() is Claude-only — a codex role failure is not a platform outage. Call ` +
      `run(prompt, {model:'codex', …}) and branch on its null (label: ${opts.label ?? 'unlabeled'}).`)
}
const runOr = async (fallback, prompt, opts) => {
  refuseCodexWrapper(opts, 'runOr')
  const r = await run(prompt, opts).catch((e) => {
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'threw',
      what: `threw — ${String(e?.message ?? e).slice(0, 200)}` })
    return null
  })
  if (r) return r
  degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'no-report',
    what: 'agent died without a report (agent() returned null — cause not exposed by the platform); ' +
      'salvaging once, then falling back. Read the agent transcript for the real error.' })
  const retried = await run(
    prompt + ' IMPORTANT: your previous report was rejected — most likely a free-text field exceeded ' +
    'its maximum length. Shorten EVERY free-text field aggressively; one sentence each is acceptable. ' +
    'Emit exactly the requested schema and no other fields.',
    { ...opts, label: `${opts.label ?? 'agent'}#salvage` },
  ).catch(() => null)
  if (!retried)
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'salvage-failed',
      what: 'salvage retry also produced no report — degrading to the coded fallback' })
  return retried ?? fallback
}
// A REQUIRED result: the caller DEREFERENCES what comes back, so there is no honest fallback to
// substitute — a coded stand-in for a dead agent is a verdict about the unit invented out of a
// platform failure. 2026-08-25, twice: a quota outage and a run of "Connection lost mid-response"
// deaths were each turned into unit-level conclusions — three units quarantined on
// "pipeline error: null is not an object (evaluating 'verify.blocked')", one on "implementer
// produced neither a report nor a commit" with all three milestones committed on its branch.
// So: salvage once (runOr's rescue), and if the result is STILL missing, declare the platform
// halted and throw. The scheduler converts the throw into a PARK, ready() stops dispatching, and
// the conductor early-returns the wave to the root — the same shape the codex halt already had.
//
// The signal is STRUCTURAL, deliberately: an agent() null carries no error object at all (see
// runOr above), so "match the quota error text" is not implementable on that path. A required
// result missing after its salvage IS the signal. Text matching applies only where text exists —
// the THROW path below, where "Connection lost", 429s and usage-limit strings really do appear —
// and there it is a fast path, not the trigger: it halts without burning a second agent on a
// platform that just said it is down.
const OUTAGE_TEXT = /usage limit|rate limit|quota|\b429\b|connection lost|overloaded|service unavailable|\b50[23]\b/i
const haltPlatform = (label, phase, why) => {
  if (halt.platform) return
  halt.platform = 'platform-outage'
  degrade({ label, model: 'platform', phase, kind: 'platform-outage',
    what: `a required agent result never arrived (${String(why).slice(0, 200)}) — treating this as a PLATFORM ` +
      `outage, not a unit defect: dispatch stops, in-flight units park with their commits intact, and the ` +
      `wave returns to the root. Operator: wait out the outage or usage-limit window and relaunch; parked ` +
      `units re-enter by adoption.` })
}
// Tagged so the scheduler can tell "the platform died" from an ordinary pipeline bug. Checked by
// `name`, not instanceof: it crosses .catch boundaries and Promise chains, and a name test cannot
// be defeated by a re-wrapped error.
const platformOutage = (label) =>
  Object.assign(new Error(`platform outage — required result for "${label ?? 'agent'}" never arrived`),
    { name: 'PlatformOutage' })
const runReq = async (prompt, opts) => {
  refuseCodexWrapper(opts, 'runReq')
  const r = await run(prompt, opts).catch((e) => {
    const msg = String(e?.message ?? e)
    degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'threw',
      what: `threw — ${msg.slice(0, 200)}` })
    if (OUTAGE_TEXT.test(msg)) haltPlatform(opts.label, opts.phase, msg)
    return null
  })
  if (r) return r
  if (halt.platform) throw platformOutage(opts.label)
  degrade({ label: opts.label, model: opts.model, phase: opts.phase, kind: 'no-report',
    what: 'agent died without a report (agent() returned null — cause not exposed by the platform); ' +
      'salvaging once, then halting the wave as a platform outage. Read the agent transcript for the real error.' })
  const retried = await run(
    prompt + ' IMPORTANT: your previous report was rejected — most likely a free-text field exceeded ' +
    'its maximum length. Shorten EVERY free-text field aggressively; one sentence each is acceptable. ' +
    'Emit exactly the requested schema and no other fields.',
    { ...opts, label: `${opts.label ?? 'agent'}#salvage` },
  ).catch((e) => {
    const msg = String(e?.message ?? e)
    if (OUTAGE_TEXT.test(msg)) haltPlatform(opts.label, opts.phase, msg)
    return null
  })
  if (retried) return retried
  haltPlatform(opts.label, opts.phase, 'no result after the salvage retry')
  throw platformOutage(opts.label)
}
// Verdict-threshold tilt by plan-time risk tier — makes `risk` bind at review/gate time.
const riskTilt = (r) =>
  r === 'high' ? 'This unit is high-risk: a missed defect ships — when in doubt, demand revision rather than approve. '
  : r === 'low' ? 'This unit is low-risk: block only on clear correctness or contract violations; do not gold-plate. '
  : ''
// Deterministic audit sampling — a stable fraction of Opus-approved units still take the
// Fable gate as an anti-rubber-stamp check. Keyed on the unit id so it is a pure function
// (no Date.now/Math.random — those are forbidden and would break resumeFromRunId replay).
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h }
const auditPick = (unit) => C.gateAuditRate > 0 && (hashStr(unit.id) % 1000) < Math.round(C.gateAuditRate * 1000)

/* ------------------------------- schemas ------------------------------- */
// Deferred-imperfection items — consciously accepted, not blocking. Collected into the
// wave's debt ledger. Banking is not free-form: `bankReason` is the closed set of legitimate
// grounds for deferring instead of fixing (arc-observed: ~350 banked items in one arc, most of
// them fix-in-unit corrections — "minor" alone is never a reason to bank). The code-writing
// schemas leave it optional (their debt is a confession that triggers a fix round, not a bank
// request); the exit-gate schemas REQUIRE it — an approve is where banking actually happens.
const BANK_REASONS = ['out-of-scope-file', 'needs-migration-or-ruling', 'pre-existing-untouched']
const debtItem = (req) => obj({
  what: { type: 'string', maxLength: 400 }, why: { type: 'string', maxLength: 400 },
  severity: oneOf(['minor', 'major']), kind: oneOf(['correctness', 'test', 'structure', 'ergonomics']),
  bankReason: oneOf(BANK_REASONS),
}, req)
const debtArr = { type: 'array', items: debtItem(['what']) }
const gateDebtArr = { type: 'array', items: debtItem(['what', 'bankReason']) }
const directiveArr = { type: 'array', items: obj({ what: { type: 'string' }, why: { type: 'string' } }, ['what', 'why']) }
// One entry per out-of-scope file the gate adjudicated: the VERDICT, which was previously never
// written down anywhere (only the breach was). Wave-scoped precedent is built from these, so two
// identical breaches in one wave get the same answer. A completeness list bounded by the diff.
const scopeRulingArr = { type: 'array', items: obj({ file: { type: 'string' },
  verdict: oneOf(['approve', 'revert']) }, ['file', 'verdict']) }
// Codex process metadata, attached by the steering agent to its S.impl-shaped report. All
// scalars read mechanically from the artifact dir (exit-code file, events.jsonl greps, git) —
// never recalled from memory; `error` is the one capped prose field (the tail of the error
// grep). `commits` = `git rev-list --count base..HEAD`, the disk truth every downstream
// decision keys on; `doneMarker` = the brief's own DONE file appeared (finished vs ran-dry).
const CODEX_META = obj({
  exitCode: { type: 'number' }, commits: { type: 'number' }, turns: { type: 'number' },
  inputTokens: { type: 'number' }, outputTokens: { type: 'number' },
  timedOut: { type: 'boolean' }, doneMarker: { type: 'boolean' }, limitHit: { type: 'boolean' },
  sessionCaptured: { type: 'boolean' }, error: { type: 'string', maxLength: 300 },
}, ['exitCode', 'commits'])
// The same facts for a codex ROLE run, minus the two that only a unit branch can answer:
// `commits` (there is no diff base) and `doneMarker` (roles carry no DONE-WHEN file). Everything
// downstream reads `commits` through `typeof m.commits === 'number'`, so its absence is a shape,
// not a hole. Kept a separate literal rather than derived, so `noteCodexMeta` can be read against
// either one without chasing a spread.
const CODEX_ROLE_META = obj({
  exitCode: { type: 'number' }, turns: { type: 'number' },
  inputTokens: { type: 'number' }, outputTokens: { type: 'number' },
  timedOut: { type: 'boolean' }, limitHit: { type: 'boolean' },
  sessionCaptured: { type: 'boolean' }, error: { type: 'string', maxLength: 300 },
}, ['exitCode'])
// The COURIER's own report for a codex role run: the caller's schema nested VERBATIM under
// `result`, plus the process facts. `result` is deliberately optional — a dead codex has no
// result, and a courier forced to fill one would be inventing the caller's answer out of a
// process failure (the §9 rule, across a process boundary).
const codexRoleReport = (schema) => obj({
  ok: { type: 'boolean' }, codex: CODEX_ROLE_META, result: schema,
  notes: { type: 'string', maxLength: 500 },
}, ['ok', 'codex'])
const EVIDENCE = obj({
  keyFiles: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 } },
  signatures: { type: 'array', maxItems: 15, items: { type: 'string', maxLength: 300 } },
  seams: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 400 } },
})
const S = {
  ok: obj({ ok: { type: 'boolean' }, detail: { type: 'string' } }, ['ok']),
  // No `ws`/`intws`/`setup` schemas any more (0.14.0): every step that used to report a sha, a
  // branch state or an ancestry exit code as a JUDGMENT is a courier now, and the script reads
  // those facts out of the commands' own stdout. See "the courier contract" in reference.md.
  // Closed-list git courier (gitProbe below): exit codes and first stdout lines, verbatim, in the
  // order the script interpolated the commands. Deliberately carries NO verdict field — the whole
  // point is that the courier reports and the SCRIPT judges.
  git: obj({ ok: { type: 'boolean' }, exitCodes: { type: 'array', items: { type: 'integer' } },
    out: arr('string'), detail: { type: 'string' } }, ['ok', 'exitCodes']),
  // `feasible:false` is the planner's escape valve for an unsatisfiable spec — without
  // it, an agent that correctly refuses to build has no legal output (eval-observed).
  // Optional `notes` on the tight schemas is a pressure-release: with
  // additionalProperties:false and no free-text field, agents with something unusual to
  // report emit extra keys and burn the structured-output retry cap (eval-observed).
  // Structured/scalar required fields FIRST, the long free-text `approach` LAST (+ the required-array
  // order matches). An Opus agent that emits a long `approach` first tends to bleed the XML tool-call
  // syntax (`</approach><parameter name="files">…`) into the JSON on the transition OUT of the
  // free-text into the next field, dropping every field that follows and burning the structured-output
  // retry cap — same required-first discipline as S.impl (eval-observed on plan:* at the
  // then-default implementEffort 'xhigh': 5 invalid outputs, all missing files/testPlan/feasible
  // that trailed the essay).
  plan: obj({
    feasible: { type: 'boolean' }, files: arr('string'), testPlan: { type: 'string' },
    // Evidence manifest — the plan pass already explored the code; hand that context forward
    // instead of making the implementer re-acquire it (feedback item: the plan should carry
    // context, not just intentions). Optional so pre-0.10 plans and resumes stay valid. The
    // implementer gets it whole (the plan JSON is threaded in); the reviewer gets keyFiles
    // ONLY, as a reading list — its fresh-eyes judgment must stay its own.
    evidence: EVIDENCE,
    approach: { type: 'string' }, notes: { type: 'string' },
  }, ['feasible', 'files', 'testPlan', 'approach']),
  planVerdict: obj({
    verdict: oneOf(['approve', 'redirect', 'quarantine']), guidance: { type: 'string' }, notes: { type: 'string' },
  }, ['verdict', 'guidance']),
  // Opus-first plan-check: approve/redirect itself, but killing a unit is frontier-only, so it
  // escalates (never quarantines) — trigger names why frontier judgment is needed on the plan.
  opusPlanVerdict: obj({
    verdict: oneOf(['approve', 'redirect', 'escalate']),
    trigger: oneOf(['uncertain', 'foundational', 'contract', 'quarantine-candidate', 'none']),
    guidance: { type: 'string' }, notes: { type: 'string' },
  }, ['verdict', 'guidance']),
  // filesChanged first so a truncated payload loses free text, not the required audit trail;
  // summary/notes capped because the platform's schema-retry resends over-long output verbatim.
  impl: obj({
    filesChanged: arr('string'),
    summary: { type: 'string', maxLength: 700 },
    // Conscious deviation from a frozen contract's *implementation* (the contract file is
    // untouchable, so contractSurfaceTouched can never see this case — arc-observed).
    // Presence fires the mid-loop architect consult and forces the Fable exit gate.
    contractMismatch: { type: 'string', maxLength: 300 },
    // Implementer-pulled consult (10a): a decision the spec does not settle. Presence fires a
    // Fable consult even on an all-green unit (the silent-design-decision class); if the
    // consult budget is spent, it forces the Fable exit gate instead.
    specGap: { type: 'string', maxLength: 300 },
    debt: debtArr, notes: { type: 'string', maxLength: 2000 },
  }, ['summary', 'filesChanged']),
  // The steering agent's report for a codex build/fix step: S.impl plus the process metadata.
  // Downstream (verify/gates/merge/triggers) reads only the S.impl half — S.impl is the seam,
  // and nothing past the steering agent learns who wrote the code.
  get implCodex() {
    return obj({ ...this.impl.properties, codex: CODEX_META }, [...this.impl.required, 'codex'])
  },
  // Opus exit gate: approve as-is, revise (a mechanical fix Opus can specify itself), or
  // escalate to the Fable architect — trigger names the reason frontier judgment is needed.
  opusGate: obj({
    verdict: oneOf(['approve', 'revise', 'escalate']),
    trigger: oneOf(['stuck', 'hard-tradeoff', 'foundational', 'oversight', 'none']),
    directives: directiveArr, debt: gateDebtArr, scopeRulings: scopeRulingArr,
    notes: { type: 'string' },
  }, ['verdict']),
  // Cross-model spec critique (codex-spec-review) — what CODEX itself returns, handed straight
  // back by the role adapter. `questions`/`risks` are sampling arrays (worst-first, verbatim);
  // best-effort, gates nothing. There is no `ok` here any more: "the pass did not happen" is the
  // adapter's null, not a field the critique fills in about itself.
  critique: obj({
    questions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
    risks: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 300 } },
    notes: { type: 'string', maxLength: 500 },
  }, ['questions', 'risks', 'notes']),
  // The cross-model PRE-GATE REVIEW DIGEST (`codex-review:<id>`), designed for the GATE to consume
  // rather than for a human to read: every field is something the gate would otherwise have had to
  // re-derive from the raw diff, and the gate's diet (config `gateModel`) is only affordable
  // because this arrives first. The two scalars are what the SCRIPT routes on — `verdict` and the
  // reviewer's own `risk` grade — so they are enums, never prose. The finding arrays are SAMPLING
  // arrays: worst-first, capped in both dimensions, and deliberately small. `unread` is the
  // honesty channel and it is load-bearing: a reviewer that could not read something must say so,
  // because the gate is about to trust this digest in place of the diff, and silence would read as
  // coverage. `notes` is capped for the usual reason — an over-long field is a lost report.
  reviewDigest: obj({
    verdict: oneOf(['clean', 'concerns', 'blocking']),
    risk: oneOf(['low', 'med', 'high']),
    // The `gate-bad` class: a diff that passes every runnable check and still violates what the
    // spec's PROSE requires. One entry per criterion, each quoting the clause it fails.
    specFindings: { type: 'array', maxItems: 6, items: obj({
      criterion: { type: 'string', maxLength: 200 }, what: { type: 'string', maxLength: 300 },
      evidence: { type: 'string', maxLength: 300 },
    }, ['criterion', 'what', 'evidence']) },
    // The `gate-convention` class: a catalogued shared helper reimplemented inside this diff.
    conventionFindings: { type: 'array', maxItems: 4, items: obj({
      helper: { type: 'string', maxLength: 120 }, where: { type: 'string', maxLength: 200 },
      what: { type: 'string', maxLength: 300 },
    }, ['helper', 'where', 'what']) },
    contractTouches: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } },
    scopeNotes: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } },
    unread: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 200 } },
    notes: { type: 'string', maxLength: 600 },
  }, ['verdict', 'risk', 'specFindings', 'conventionFindings', 'contractTouches', 'scopeNotes',
    'unread', 'notes']),
  // `blocked` = the tooling itself could not run (env/deps/config) — a third outcome,
  // never conflated with a failing assertion. Routed to env-quarantine, not fix rounds.
  verify: obj({
    pass: { type: 'boolean' }, blocked: { type: 'boolean' },
    failures: arr('string'),
    // The LANE LEDGER: every acceptance-check command the verifier actually ran, verbatim, with the
    // exit code it returned. Without it "the tests scoped to this unit" was prose the verifier
    // interpreted, and it interpreted it cheaply — running `test:unit` where the spec said
    // `test:ci`, leaving an architecture-lane seal red for a whole unit until the architect gate
    // found it. The script cannot assert coverage itself: which commands a spec's acceptance checks
    // name lives in the spec markdown, not in plan.json (units carry no gate-command field). So the
    // ledger is reported here and the EXIT GATES assert it against the spec they already read
    // (LANE_BAR); the script's own check is only the degenerate one — a pass with no lanes at all.
    lanes: { type: 'array', maxItems: 12, items: obj({
      command: { type: 'string', maxLength: 300 }, exitCode: { type: 'number' },
    }, ['command', 'exitCode']) },
    contractSurfaceTouched: { type: 'boolean' },
    // The diff's name-only file list — the objective input to the code-side scope-growth check
    // (envelope pinning + the scope-creep gate annotation). A completeness list, never capped.
    diffFiles: arr('string'),
    // The failing tests' SPEC FILES (repo-relative paths), one entry per distinct file — courier
    // work, not judgment. Feeds the shared-red circuit breaker, which needs a stable key it can
    // intersect with `diffFiles`; `failures` is verbatim runner output and cannot be keyed on.
    // A completeness list, never capped. Optional: absence only costs the breaker a signal.
    failingSpecs: arr('string'),
    // Host-load facts as read off the box this lane ran on. Recorded, never gated on — the wave's
    // own concurrency is what produces high load, so gating on it would wait on siblings; but a
    // wall-clock verdict ("this unit breached its 100ms budget") is unauditable without it.
    loadavg1: { type: 'number' }, cpuCount: { type: 'number' },
    notes: { type: 'string' },
  }, ['pass', 'blocked', 'failures', 'lanes', 'contractSurfaceTouched', 'diffFiles']),
  // (The standalone adversarial-review stage — and its S.review schema — was removed with the
  // codex executor: the gates carry the hunting clauses. See RATIONALE §17.)
  gate: obj({
    verdict: oneOf(['approve', 'revise', 'quarantine']),
    directives: directiveArr, debt: gateDebtArr,
    scopeRulings: scopeRulingArr,
    notes: { type: 'string' },
  }, ['verdict', 'directives']),
  // 'confirm' exists for the specGap consult (the decision stands as built — no fix round);
  // the stuck-rescue consult never offers it and its prompt is unchanged.
  directive: obj({ action: oneOf(['redirect', 'quarantine', 'confirm']), guidance: { type: 'string' } }, ['action', 'guidance']),
  // The escalation ladder's cheap tier (see the ladder in the unit pipeline). `boundary` is a
  // CLOSED enum on purpose: it is the only thing standing between "Opus triages escalations" and
  // "Opus forwards everything to the frontier", so difficulty must not be expressible as a reason.
  adjudication: obj({
    tier: oneOf(['cited', 'decided', 'escalate']),
    boundary: oneOf(['none', 'contract', 'scope-envelope', 'other-unit', 'plan-of-record', 'mis-specified']),
    guidance: { type: 'string' },
  }, ['tier', 'boundary', 'guidance']),
  dossier: obj({ attempted: { type: 'string' }, evidence: { type: 'string' }, hypothesis: { type: 'string' } },
    ['attempted', 'evidence', 'hypothesis']),
  merge: obj({
    merged: { type: 'boolean' }, suitePass: { type: 'boolean' },
    head: { type: 'string' }, detail: { type: 'string' },
    // Refusal channels, both optional and empty on a clean merge: unit diffs touching the
    // orchestrator's directory (NOROADMAP made mechanical — the merge strips and surfaces),
    // and duplicate numeric prefixes under plan.prefixUniqueGlobs (quarantined, never repaired).
    roadmapPaths: arr('string'), prefixCollision: arr('string'),
  }, ['merged', 'suitePass', 'head', 'detail']),
  // Boundary results — capped hard: these ride in state.json and the platform's
  // schema-retry resends over-long payloads verbatim (the H-1 failure mode).
  explore: obj({
    findings: { type: 'array', maxItems: 10, items: obj({
      severity: oneOf(['blocker', 'major', 'minor', 'idea']),
      summary: { type: 'string', maxLength: 300 }, repro: { type: 'string', maxLength: 400 },
      observed: { type: 'string', maxLength: 300 }, expected: { type: 'string', maxLength: 300 },
    }, ['severity', 'summary']) },
    shaObserved: { type: 'string' }, notes: { type: 'string', maxLength: 500 },
  }, ['findings', 'shaObserved']),
  health: obj({
    findings: { type: 'array', maxItems: 12, items: obj({
      area: oneOf(['test', 'structure', 'consistency', 'ergonomics']),
      what: { type: 'string', maxLength: 400 }, where: { type: 'string', maxLength: 200 },
    }, ['area', 'what']) },
    // Ready-to-dispatch consolidation fix-unit drafts — a unit spec's shape, so boundary
    // triage admits them without re-authoring (drafts are the default action, not a suggestion).
    fixUnits: { type: 'array', maxItems: 6, items: obj({
      id: { type: 'string', maxLength: 60 }, goal: { type: 'string', maxLength: 300 },
      files: arr('string'), acceptance: arr('string'),
    }, ['id', 'goal', 'acceptance']) },
    notes: { type: 'string', maxLength: 500 },
  }, ['findings', 'fixUnits']),
  // `loads` is the band's per-run load record (one loadavg1 sample taken before each run) plus the
  // box's cpuCount. The band's real co-tenants are its own sibling boundary agents and the preview
  // server — the unit gates have all drained by then — so the flips are not read as caused by the
  // gates; the numbers are here so a triager can tell a flip under saturation from a real sentinel
  // instead of guessing. Recorded, never gated on. Completeness lists, never capped.
  flake: obj({ runs: { type: 'number' }, flips: arr('string'), loads: arr('number'),
    cpuCount: { type: 'number' }, detail: { type: 'string', maxLength: 400 } },
    ['runs', 'flips']),
  // Per-wave design reconcile. The severity split is the atlas2 handoff's own taxonomy, because it
  // is the one that changes what you DO: a bug is a fix unit, an adoption gap is a fix unit that
  // deletes code, and 'irreconcilable' is the signal that a dedicated arc is needed — the finding
  // that arrived a whole arc too late last time. `visionUsed` is REQUIRED and load-bearing: with no
  // screenshot capability provisioned the agent must degrade to comparing DOM against comp source
  // and SAY so, because a fidelity check that silently cannot see is worse than none.
  design: obj({
    findings: { type: 'array', maxItems: 10, items: obj({
      surface: { type: 'string', maxLength: 120 }, comp: { type: 'string', maxLength: 120 },
      severity: oneOf(['bug', 'adoption-gap', 'irreconcilable']),
      what: { type: 'string', maxLength: 400 },
    }, ['surface', 'severity', 'what']) },
    fixUnits: { type: 'array', maxItems: 6, items: obj({
      id: { type: 'string', maxLength: 60 }, goal: { type: 'string', maxLength: 300 },
      files: arr('string'), acceptance: arr('string'),
    }, ['id', 'goal', 'acceptance']) },
    visionUsed: { type: 'boolean' },
    shaObserved: { type: 'string' }, notes: { type: 'string', maxLength: 500 },
  }, ['findings', 'fixUnits', 'visionUsed']),
}

/* ------------------------------ the courier -----------------------------
 * The ONE canonical way to have a cheap agent run shell on the script's behalf.
 *
 * Ground truth: this script has no filesystem and no shell — `run()` IS `agent()`. So every git,
 * gh, kill and test command necessarily passes through a model, and the only deterministic levers
 * are which tier runs it, how mechanically it is phrased, and WHAT LITERAL STRINGS the script
 * computes and injects. The rule this helper exists to enforce: the cheapest tier is never handed
 * a GOAL with destructive reach ("clean up the ports", "make the checkout work", "find the
 * issue") — it is handed a CLOSED LIST of exact commands whose verbatim output the script judges.
 * A prohibition list is weaker than an allowlist: what is absent from `commands` is outside the
 * agent's remit by construction, so `rm`, `find -delete`, `git clean/stash/reset`, `pkill` and
 * `ps | grep | kill` need no "never" clause here — they are simply not on the list. Three
 * arc-observed disasters (a host-wide `kill -9`, 163 deleted untracked files, a wave halted by an
 * invented credential requirement) were all a goal-shaped prompt at Haiku.
 *
 * The second rule, added after wf_106cdf59-c5f: WHERE a command runs is composed, not asked for.
 * Every listed command goes out as `cd '<where>' && ( <cmd> )`, so a courier that ignores STRICT's
 * cd sentence (Haiku did, and ran a whole preview list in the workflow session's own checkout)
 * produces a NON-ZERO EXIT of that numbered command instead of a plausible answer from the wrong
 * repository. `where` is required and empty throws here, at compose time.
 *
 *   courierRun(where, commands, opts, extra) -> { ok, results, exit(i), out(i), detail }
 *     where     absolute path every command is `cd`'d into by the script (required; empty throws)
 *     commands  ordered array of exact command strings; index i is stable and load-bearing —
 *               results are POSITIONAL, the courier never echoes the command text back
 *     opts      the usual run() opts minus `schema` (model/effort/phase/label) — the schema is
 *               built here, sized to the list — plus optional `outMax`, the per-command output
 *               budget (default COURIER_OUT; the launch pack read is the one caller that raises it),
 *               and optional `required`, which routes the call through runReq instead of runOr: for
 *               the couriers whose absent result would be an invented verdict about a unit rather
 *               than an honest empty answer (adopt-tip). A dead REQUIRED courier halts the wave as
 *               a platform outage; a dead ordinary one reports `ok:false` and the script decides.
 *     extra     prompt text appended BEFORE the command list (context, allowlist reminders)
 *     ok        every listed command ran and exited 0 — the ONLY blanket verdict offered
 *     exit(i)   the i-th command's integer exit code, or null if it never ran
 *     out(i)    the i-th command's captured output, trimmed ('' if it never ran)
 *     raw(i)    the same capture untouched — for a caller to whom whitespace is content
 *
 * THE SCRIPT decides what the output means: pattern-match `exit(i)`/`out(i)`, never ask the agent
 * for a verdict about the commands it ran. Callers that need a value read it out of the output of
 * a command they put on the list for that purpose (`git rev-parse HEAD`, `codex login status`).
 * The conductor carries a byte-identical copy of this function (0.14.0: its `move-feedback` step
 * became a courier) alongside the PROMPT, SCHEMA and SHAPE (courierPrompt / courierSchema /
 * courierShape) — keep all four in sync (shared-consts.test.mjs enforces it). Only the `required`
 * branch is harness-specific: over there `runReq` is a throwing stub, since the conductor has no
 * wave-level halt record for a dead required courier to set.
 */
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

/* --------------------------- live wave state --------------------------- */
const units = new Map(Object.entries(prior.units ?? {}))
for (const u of plan.units) {
  if (!units.has(u.id)) units.set(u.id, { status: u.inScope ? 'pending' : 'deferred' })
}
let integrationTip = prior.integrationTip
let consultsUsed = prior.consultsUsed ?? 0
// The wave's HALT RECORD — one shape for every wave-level brake. Once any slot is set: no NEW
// unit dispatch this wave (ready() gates on it), in-flight units PARK (status pending +
// parked:true, re-entering by adoption next wave) — never quarantine, never a verdict. The wave
// state carries `halt.reason` so the conductor early-returns to the root, where the human acts.
//   codex    — the per-wave probe found the CLI/auth gone, or a step observed a usage/rate limit.
//              Codex is the only implementer, so there is no lane to fall back to.
//   env      — the host cannot support the work: pid-cgroup headroom gone, or a PID 1 that does
//              not reap (the preflight below), or two units' verification tooling failing to run
//              in one wave (`env-verify-blocked`, see envBlocked). Burning codex+gate rounds on
//              any of them buys quarantines.
//   platform — a REQUIRED agent result went missing after its salvage retry (runReq), i.e. the
//              Claude platform itself is down or rate-limited. A model's death is a platform
//              fact, never a unit verdict.
// Nothing carries forward from a prior wave: every slot is re-established by this wave's own
// probes and observations, so a cleared/expired condition never keeps an arc halted.
const halt = { codex: null, env: null, platform: null }
// Most fundamental layer first: a dead platform explains a dead codex, and a dead box explains
// both. The winner is what the conductor returns and what a park note names, so the operator is
// pointed at the cause rather than at a symptom.
const HALT_ORDER = ['platform', 'env', 'codex']
const haltReason = () => HALT_ORDER.map((k) => halt[k]).find(Boolean) ?? null
// Units whose verification TOOLING could not run this wave (a verifier that RAN and reported
// `blocked:true`). Wave-scoped, like every other brake here. ONE such unit is a fact about one
// checkout — it blocks, keeps its commits, and is re-verified next wave. TWO DISTINCT units in one
// wave is a fact about the HOST (a black-holed registry, a dead network, a missing global tool),
// and no number of unit verdicts fixes a host: the wave halts on `env-verify-blocked` and parks.
// Arc-observed 2026-09-04: `pnpm audit --audit-level high` inside `pnpm verify` hung on a
// black-holed registry POST, and the first unit to reach it was quarantined for the box.
const verifyBlockedUnits = new Set()
let inFlight = 0
let mergeChain = Promise.resolve()
let settleWaiters = []
// Green-tip mirror (DESIGN §7.5): the PRIMARY checkout rides the latest suite-green
// integration tip so the user — and the between-wave explorer — only ever observe real
// states, never mid-merge trees. Strictly observability: every path below logs and
// continues on failure; no unit outcome may depend on the preview.
let previewStatus = plan.preview && C.previewRefresh !== 'off' ? 'pending' : 'none'
let previewSha = null
let previewTarget = null
let previewChain = Promise.resolve()
let boundary = null
// Owed boundary jobs — a job that was DUE but did not run (skipped or died) leaves a
// machine-readable marker the next boundary trips over, instead of silently vanishing
// (arc-observed: a preview-down wave skipped the design reconcile over five design-cited
// units and nothing re-queued it — the root had to notice by hand). Seeded from the prior
// wave; discharged when the job next runs successfully; carried with count+1 otherwise.
// The conductor escalates entries owed two boundaries running to the Fable tier.
let owed = (prior.owed ?? []).map((o) => ({ ...o }))

const rec = (id) => units.get(id)
// Per-unit forensic breadcrumb: stamp the pipeline stage onto a running record and snapshot it.
// Guarded to `running` so a terminal result (which replaces the record wholesale) never keeps
// a stale stage — after a crash, `stage` tells you how far a running unit got.
const setStage = (id, stage) => {
  const r = units.get(id)
  if (r?.status !== 'running') return
  units.set(id, { ...r, stage })
  snapshot()
}
// Per-unit round tally ({fix, opusGate, gate}) — makes runaway revision loops measurable
// (the paid fixtures assert ceilings on these). Stamped on the running record like `stage`;
// the terminal store in start() carries it onto the final record. No snapshot
// here — the next stage/status snapshot carries it, and a slightly-stale tally after a
// crash is acceptable forensics.
// `verifyBlocked` is tallied here too but is deliberately NOT one of the three seeded keys: it is
// rare, it counts across waves (start() carries it), and seeding it would put a `verifyBlocked: 0`
// on every unit record in every arc. Hence `?? 0` rather than a bare `++`, which is NaN on a key
// the seed does not name.
const bumpRound = (id, kind) => {
  const r = units.get(id)
  if (r?.status !== 'running') return
  const rounds = { fix: 0, opusGate: 0, gate: 0, ...(r.rounds ?? {}) }
  rounds[kind] = (rounds[kind] ?? 0) + 1
  units.set(id, { ...r, rounds })
}
const depsOf = (id) => plan.edges.filter((e) => e.to === id).map((e) => e.from)
// A unit is dispatched at most once per WAVE. Every terminal status is self-limiting (only
// 'pending' is ready), but a PARK deliberately returns the record to 'pending' — that is what makes
// the unit re-enter by adoption in the NEXT wave — so without this the scheduler would re-dispatch
// it immediately in THIS one, forever. `parked` itself cannot be the guard: it has to survive into
// the next wave's state, where it is exactly what tells setup to adopt the branch's commits.
const dispatched = new Set()
const ready = (u) => !haltReason() && !dispatched.has(u.id) && rec(u.id).status === 'pending' &&
  depsOf(u.id).every((d) => rec(d)?.status === 'merged')
const blockedBy = (u) => depsOf(u.id).some((d) => ['quarantined', 'blocked'].includes(rec(d)?.status))
const serialize = () => ({
  integrationBranch: intBranch, integrationTip, consultsUsed, spend,
  // Run identity ({runId, scriptPath}) set by the architect at launch — carried through so
  // same-session resume is mechanical and crash forensics are one `cat` of state.json.
  ...(prior.run ? { run: prior.run } : {}),
  // The conductor block is the conductor's, but the harness's serialize() is what the persister
  // writes — so without this passthrough the wave would strip it, and a crash mid-wave (the common
  // case) would leave the rung-3 recovery signal and the arc-cumulative boundary forensics missing
  // from disk. Arc-observed: three completed waves on disk, `conductor: undefined`. Passthrough
  // only — never authored here.
  ...(prior.conductor ? { conductor: prior.conductor } : {}),
  preview: { sha: previewSha, status: previewStatus },
  // Debt surfaced THIS wave (not accumulated across waves): the architect triages it at the
  // boundary and appends un-promoted items to the living .roadmap/debt.md ledger.
  debt: debtLog,
  // Escalation stop counts per unit, arc-cumulative — the three-strikes brake reads these. The
  // rulings themselves, and every degradation, ride home in the RETURN envelope and land as
  // append-only lines in .roadmap/{escalations,degradations}.jsonl: NEITHER is serialized here.
  // They were, and re-transcribing an arc-cumulative ledger at every write is what drove
  // state.json to 8 parts and 91 lost checkpoints in one arc.
  ...(Object.keys(escalationStops).length ? { escalationStops } : {}),
  ...(owed.length ? { owed } : {}),
  // Shared pre-existing reds the circuit breaker took over this wave. The conductor folds these
  // into the boundary FINDINGS (never into debt — debt must not create a wave) so the triager
  // adjudicates the red once instead of every unit fighting it independently.
  ...(sharedReds.size ? { sharedReds: [...sharedReds.values()] } : {}),
  // This wave's exit-gate rulings on out-of-scope files, so the root can audit consistency and a
  // later gate has precedent to follow. Wave-scoped: rulings are about this wave's diffs.
  ...(scopeRulings.length ? { scopeRulings } : {}),
  ...(boundary ? { boundary } : {}),
  // The wave-level halt record, the conductor's early-return signal: a `reason` here means the
  // wave stopped dispatching (units parked, state resumable) and the ROOT must surface it to the
  // user (re-auth, fix the box, wait out the outage window, relaunch). Never route around it
  // in-script. `reason` is the winner by HALT_ORDER — the conductor reads exactly that field, so
  // the precedence lives here, in one place, and never has to be duplicated over there.
  ...(haltReason() ? { halt: { reason: haltReason(), ...Object.fromEntries(HALT_ORDER.filter((k) => halt[k]).map((k) => [k, halt[k]])) } } : {}),
  codex: { probed: (prior.wave ?? 0) + 1, available: !halt.codex },
  wave: (prior.wave ?? 0) + 1, units: Object.fromEntries(units),
})
const notifySettle = () => { const w = settleWaiters; settleWaiters = []; w.forEach((f) => f()) }
const nextSettle = () => new Promise((r) => settleWaiters.push(r))

// Wave-state snapshot, for FORENSICS ONLY — it costs nothing and writes nothing. The old
// checkpoint() paid a Haiku agent to transcribe the whole of state.json at every status change;
// the journal is the checkpoint now, so a snapshot is one tagged `log` line. `persist.mjs` keeps
// the LAST one it sees during a replay: when a crash stops the replay short of the return value,
// that snapshot is what lands as the partial state.json, with a `partial` marker naming the call
// the replay could not serve. A complete run's return value supersedes every snapshot.
// Mirrored in conductor.mjs and read by persist.mjs — keep all three in sync
// (shared-consts.test.mjs enforces it).
const SNAPSHOT_TAG = 'ROADMAP-SNAPSHOT '
const snapshot = () => log(SNAPSHOT_TAG + JSON.stringify(serialize()))

/* ------------------------- git facts, read in code ---------------------- */
// Every git fact the harness ACTS on comes back through this one shape: the cheapest tier runs
// EXACTLY the commands the script interpolated, in order, and reports each one's exit code and
// first stdout line verbatim. It is a courier, not a judge — no "is it merged?" prompt anywhere,
// because a question shaped like a judgment gets an answer shaped like agreement (2026-08-28: a
// merge made on a detached HEAD was reported `merged:true` for a commit no branch could reach).
// Exit codes cannot be talked into the wrong answer. Salted: these are environment facts.
async function gitProbe(label, dir, cmds, phase) {
  const r = await runOr({ ok: false, exitCodes: [], out: [] },
    STRICT +
    `In the directory ${dir}, run these ${cmds.length} shell commands IN ORDER, exactly as written, and report ` +
    `only what they did:\n` +
    // Same rule as courierRun: the directory is composed into each command, never left to the model.
    cmds.map((c, i) => `${i + 1}) ${cdGuard(dir, c)}`).join('\n') + '\n' +
    `Each command already carries its own \`cd\` prefix — run it exactly as written, prefix included, and never ` +
    `strip or shorten it: the working directory is part of the command, not a choice of yours. ` +
    `Run no other command. Change NOTHING — no checkout, merge, fetch, reset, repair or cleanup. A command ` +
    `that fails is not a problem to fix: its failure IS the answer, and you report it. Report \`exitCodes\` as ` +
    `the ${cmds.length} exit codes ($? immediately after each command) in that same order, and \`out\` as each ` +
    `command's first line of stdout in that same order (empty string where it printed nothing). ` +
    `Report ok:true once you have run all ${cmds.length}.` + LAUNCH,
    { model: 'haiku', effort: 'low', phase, label, schema: S.git })
  // A dead courier reports nothing, and "nothing" must never read as a git fact: -1 is not 0.
  return { raw: r, code: (i) => r.exitCodes?.[i] ?? -1, line: (i) => (r.out?.[i] ?? '').trim() }
}

// "Merged" is a git fact decided in CODE, before dispatch, before any re-verify, before any
// quarantine. NOT a bare `merge-base --is-ancestor`: a commit-less branch parked at an old
// integration commit false-positives on it (eval-observed — the same reason the setup prompt's
// case 1 is written the way it is). The real test is that the branch tip is the SECOND parent of a
// merge commit on the integration branch, i.e. it landed through one of our own --no-ff merges.
// Also reports whether the unit's worktree DIRECTORY is there right now, so a cached setup report
// claiming a checkout that a rebuilt host no longer has cannot be believed.
async function mergedInGit(unit, phase = 'Setup') {
  const b = `unit/${unit.id}`
  const g = await gitProbe(`merged-probe:${unit.id}`, repo, [
    `git rev-parse --verify --quiet ${b}^{commit}`,
    `SHA=$(git rev-parse --verify --quiet ${b}^{commit}) && git log --merges --format=%P ${intBranch} | ` +
      `awk '{print $2}' | grep -qxF "$SHA"`,
    `test -d ${wtOf(unit)}`,
  ], phase)
  // Both halves required: without the branch-exists gate, an unresolvable ref makes command 2's
  // $SHA empty, and an empty pattern matches the empty second-parent field of every ordinary commit.
  return { merged: g.code(0) === 0 && g.code(1) === 0, branchSha: g.line(0), worktree: g.code(2) === 0, raw: g.raw }
}

// Optional environment provisioning (plan.provision: {copy: [...gitignored files], setup: "cmd"}).
// A fresh worktree has no deps/env; without this, the test gate fails for non-code reasons.
//
// A COURIER, not a prose brief (0.14.0). This prompt was the LAST free-form step with `cp` in its
// remit, and wf_c6971376-1a5 is what that cost: the `provision:preview` agent skipped STRICT's cd,
// printed `/workspaces/roadmap-orchestration` from `git rev-parse --show-toplevel` without
// reporting it as the failure STRICT says it is, and then improvised its way to a bare
// `cd /workspaces/roadmap-orchestration && git worktree add <prevWt>` — no `--detach`, no base sha,
// run in the ORCHESTRATOR'S OWN checkout. That created a `__preview` BRANCH in this repo and left
// the path registered as a worktree of two different repositories, so both waves' previews died
// with "fatal: unable to read tree". Nothing in its brief mentioned worktrees; a goal ("provision
// this checkout") is what let it reach for one. The plan's copy list and setup command are
// interpolated verbatim and are the whole list; `git` is not on it at all.
async function provision(where, label) {
  if (!plan.provision) return { ok: true }
  const p = plan.provision
  const cmds = [
    // `mkdir -p` on the DESTINATION's parent only — a copy target's directory, never a checkout.
    ...(p.copy ?? []).map((f) => `mkdir -p "$(dirname '${where}/${f}')" && cp -a '${repo}/${f}' '${where}/${f}'`),
    ...(p.setup ? [p.setup] : []),
  ]
  if (!cmds.length) return { ok: true }
  return courierRun(where, cmds, { model: 'haiku', phase: 'Setup', label },
    `These commands copy the gitignored files this checkout needs and run the project's own setup ` +
    `command. Creating, moving or deleting a git worktree, a branch or a checkout is not among them, ` +
    `at any path and in any repository. ` + LAUNCH)
}

// One green-tip advance of the PREVIEW WORKTREE, as a closed command list: detach at `sha`, bring
// the preview back up, read HEAD back. `rm`, `find -delete`, `git clean/stash/reset` and
// `git checkout -- <path>` are outside that list by construction, which is the point — the old
// prompt's "never stash, reset, or force" was honoured exactly as well as any other "never" handed
// to Haiku (twice it deleted files instead). The sweep retry fires only when the detach itself
// already succeeded: a failed detach is never a port problem.
async function previewAdvance(sha, label, first) {
  const build = (sweep) => [
    ...(sweep ? previewSweepCmds : []),
    `git checkout --detach ${sha}`,
    ...previewBringUp(first),
    'git rev-parse HEAD',
  ]
  const attempt = async (sweep) => {
    const cmds = build(sweep)
    const r = await courierRun(prevWt, cmds, { model: 'haiku', phase: 'Preview', label: sweep ? `${label}#sweep` : label },
      previewSweepRetry + LAUNCH)
    return { ok: r.ok, sha: r.out(cmds.length - 1), detail: r.detail,
      detached: r.exit(sweep ? previewSweepCmds.length : 0) === 0 }
  }
  const a = await attempt(false)
  return a.ok || !a.detached ? a : attempt(true)
}

// Green-tip mirror advance: move the preview worktree to a suite-green tip and refresh the preview
// process there. Coalescing latest-wins chain — merges never wait for it, and an advance that finds
// the mirror already at target is a no-op. Failure leaves the mirror stale (or 'failed' at setup)
// and the wave continues: observability, never a gate.
function refreshMirror() {
  if (previewStatus !== 'live') return
  previewTarget = integrationTip
  previewChain = previewChain.then(async () => {
    if (previewSha === previewTarget) return   // coalesce: latest-wins
    const sha = previewTarget
    const r = await previewAdvance(sha, `mirror:${sha.slice(0, 7)}`, false)
    if (r.ok && sameSha(r.sha, sha)) previewSha = sha
    else log(`preview mirror stale (advance to ${sha.slice(0, 7)} failed: ${r.detail || r.sha || 'agent error'})`)
  }).catch(() => null)
}

// `mergeReverted` is the ONE legitimate quarantine of a branch git still calls merged: when the
// integrated suite cannot be saved, the fix agent reverts with `git revert -m 1 HEAD`, which keeps
// the merge commit in history — so the second-parent test still matches while the unit's code is
// no longer in the tree. Every other caller runs before any merge could have landed.
async function quarantine(unit, reason, extra, { mergeReverted = false } = {}) {
  // Git decides `merged`, not the pipeline's opinion of the unit. Quarantining a merged unit
  // re-opens landed work for redesign and (issue mode) relabels a closed issue — arc-observed
  // 2026-08-25, where a resume replayed a cached pre-merge verdict onto a unit already on the
  // integration branch. A probe that dies reports nothing, which reads as NOT merged: the
  // quarantine proceeds, exactly as it did before this guard existed.
  if (!mergeReverted) {
    const g = await mergedInGit(unit, 'Quarantine')
    if (g.merged) {
      degrade({ label: `quarantine-refused:${unit.id}`, model: 'haiku', phase: 'Quarantine', kind: 'quarantine-refused',
        what: `refused to quarantine ${unit.id} ("${String(reason).slice(0, 120)}") — git says its branch landed on ` +
          `${intBranch} (tip ${g.branchSha.slice(0, 7)}). Recorded as merged; the verdict that asked for the ` +
          `quarantine disagrees with git — most often a stale or cached read.` })
      return { status: 'merged', branch: `unit/${unit.id}`, mergedAt: g.branchSha, note: 'quarantine refused — git says merged' }
    }
  }
  // The dossier is the redesign feed, so the investigator RETURNS findings through the schema and
  // a separate writer agent renders the FILE from them — investigative agents flake on
  // side-effects; a writer with nothing to do but write doesn't (observed across eval runs). The
  // prose then stays in the file: the unit record carries `dossierPath`, never the text. It used
  // to carry both, and a handful of ~5 KB dossiers took one arc's state.json to 145 KB — past the
  // ~35 K characters a launch courier can copy, so the arc could not be relaunched at all
  // (2026-09-03). Every reader of a dossier is a model with a filesystem; the file is the record.
  const dossierPath = `${repo}/.roadmap/quarantine/${unit.id}.md`
  const d = await run(
    `Unit ${unit.id} of a roadmap build is being quarantined (${reason}). Its spec is at ${specOf(unit)} and its ` +
    `work-in-progress lives on branch unit/${unit.id} (worktree ${wtOf(unit)}). Investigate briefly and report a ` +
    `concise redesign dossier: what was attempted, what failed (with the strongest evidence), and your best ` +
    `hypothesis for the root cause. Report your findings in the structured output — do not write any files. ` +
    `Additional context: ${JSON.stringify(extra ?? {})}`,
    { model: 'sonnet', phase: 'Quarantine', label: `dossier:${unit.id}`, schema: S.dossier },
  ).catch(() => null)
  const dossier = d ?? {
    attempted: 'investigation agent failed — raw harness evidence only',
    evidence: JSON.stringify(extra ?? {}),
    hypothesis: reason,
  }
  // ONE writing task, two possible writers. The content is a pure function of the structured
  // findings above, so a resume renders it byte-identically either way.
  const dossierTask =
    `Create the file ${dossierPath} (creating parent directories as needed) with exactly this content:\n` +
    `# ${unit.id} — quarantine dossier\n\nReason: ${reason}\n\n## Attempted\n${dossier.attempted}\n\n` +
    `## Evidence\n${dossier.evidence}\n\n## Hypothesis\n${dossier.hypothesis}\n` +
    (issueMode
      ? `\n${GH_BEST_EFFORT}${MARKER_RULE}Then reflect the quarantine on the unit's tracking issue, keeping it ` +
        `OPEN: ${findIssue(unit.id, unit.issue)}if $ISS is non-empty AND $ISSTATE is not CLOSED, run ` +
        `\`${GH_HERE} issue edit ${ghRepo}"$ISS" ` +
        `--remove-label status:running,status:merge-ready --add-label status:quarantined\` and post the dossier ` +
        `as a comment: \`${GH_HERE} issue comment ${ghRepo}"$ISS" --body-file ${dossierPath}\`. `
      : '')
  // Codex writes it directly — it has a shell, so the file lands as a heredoc instead of being
  // transcribed by a courier. cwd is the INTEGRATION worktree, not the unit's: quarantine is
  // reachable before a unit worktree exists at all (an unresolvable existingBranch, a failed
  // setup), and pointing a role at a directory that may not be there buys two doomed codex runs
  // before the fallback. The dossier path is absolute, so the cwd is only ever the cd target.
  const dw = await run(
    `# GOAL\n${dossierTask}\n\n# CONSTRAINTS\n` +
    `Write that ONE file and nothing else. Do not edit, stage, commit or revert anything in the checkout you ` +
    `are running in, do not touch the unit's branch or worktree, and do not investigate — the findings above ` +
    `are already decided and are yours to write down verbatim, not to revise.\n\n` +
    `# REPORT\nReport ok:true only if \`test -f ${dossierPath}\` succeeds after you have written it; ` +
    `otherwise ok:false with the exact error in \`detail\` (one sentence).`,
    { model: 'codex', cwd: intWt, sandbox: 'workspace-write', schema: S.ok,
      phase: 'Quarantine', label: `dossier-write:${unit.id}` },
  )
  // A dossier must EXIST — it is the redesign feed, and a quarantine with no dossier sends the next
  // reader hunting. So the null (or a codex that reported it could not write) falls back to the
  // Haiku writer this replaced, exactly once.
  if (!dw?.ok) {
    degrade({ label: `dossier-write:${unit.id}`, model: 'codex', phase: 'Quarantine', kind: 'dossier-write-fallback',
      what: `codex did not write ${unit.id}'s quarantine dossier (${dw ? `reported ok:false — ${String(dw.detail ?? '').slice(0, 160)}` : 'no result'}) ` +
        `— falling back to the Haiku writer once. A dossier must exist: ${dossierPath} is the only record of the findings, and the unit record carries just that path.` })
    await run(
      dossierTask,
      { model: 'haiku', effort: 'low', phase: 'Quarantine', label: `dossier-write:${unit.id}#fallback`, schema: S.ok },
    ).catch(() => null)
  }
  return { status: 'quarantined', branch: `unit/${unit.id}`, reason, dossierPath }
}

// The report-write clause every BOUNDARY role's brief carries. Through 0.13.0 each of these three
// roles was an Opus investigator whose structured result a Haiku verbatim-writer then transcribed
// into `.roadmap/feedback/<job>/wave-N.md`. The role is a Codex process now, and a Codex process has
// a filesystem — so it writes its own report and the transcription courier is gone (0.14.0's rule:
// Claude decides, Codex drafts and executes, Haiku only couriers). The rendering is dictated here
// rather than left to the role's taste, because the file is the human-readable face of the SAME
// structured report the triager reads: a file that says something the JSON does not is a second,
// unreviewed account of the wave.
// `noteField` is the schema key a role uses for free prose — `notes` for the three investigators,
// `detail` for the flake band, whose report is numbers plus one line. Defaulted, so the three
// investigator briefs stay byte-identical to the version this clause was written for.
const reportWrite = (path, heading, body, noteField = 'notes') =>
  `Write your report to ${path} — create its parent directories with \`mkdir -p\` first — and write NO ` +
  `other file anywhere. Its content is exactly: the line \`${heading}\`, a blank line, then ${body}. ` +
  `The file must carry the same findings as your final JSON report and nothing else: it is that ` +
  `report rendered for a human, never a longer account of what you did. If the write fails, say so in ` +
  `\`${noteField}\` in one sentence and still report your findings — a lost file is not a lost wave. (The ` +
  `budget for every field, \`${noteField}\` included, is stated in FINAL MESSAGE below; this clause does not ` +
  `restate it, so the two can never drift.)\n\n`

// Wave-tail boundary phase (invariant 8: strictly after every merge and mirror advance;
// findings gate nothing — they are the NEXT boundary's triage input). In-workflow so the
// root wakes exactly once, cache warm, with explorer findings, health findings + fix-unit
// drafts, and flake flips all in the returned state (arc-observed: separately-launched
// boundary agents finishing minutes apart cost two cold full-history reloads).
async function runBoundary() {
  const waveN = (prior.wave ?? 0) + 1
  const tip = integrationTip
  const explSha = previewSha ?? tip
  // Owed-only mode. The arc's FINAL wave is expected to run with `boundary:'off'`, and an owed
  // explorer/design job used to be deferred there to a boundary that never came — it left the run
  // as a manual chore in the return envelope (arc-observed). So when the boundary is off but the
  // ledger is not empty, this phase still runs, restricted to exactly the jobs that are owed:
  // the debt is paid in the last boundary that exists. Nothing else runs, so a switched-off
  // boundary stays switched off for every job that isn't owed.
  const owedOnly = C.boundary === 'off'
  const isOwed = (job) => owed.some((o) => o.job === job)
  const dueHere = (job, base) => base && (!owedOnly || isOwed(job))
  const doExplore = dueHere('explorer', previewStatus === 'live')
  const doHealth = dueHere('health', C.healthCheck !== 'off')
  // Design-cited units that reached `merged` IN THIS WAVE. The plan is the authority on what is
  // UI work — deliberately NO diff-path heuristic (*.tsx and friends), because a unit that touches
  // a designed surface without citing it is the plan-pack defect Phase 0 hunts, and papering over
  // it here would hide exactly what we want surfaced. Needs the preview: the green-tip mirror is
  // the only place a browsable, integrated surface is guaranteed to exist.
  // Owed design units from a prior skipped/dead reconcile re-enter the due set (still merged,
  // still design-cited) so the debt is paid, not merely remembered.
  const owedDesignIds = new Set(owed.filter((o) => o.job === 'design').flatMap((o) => o.units ?? []))
  const designUnits = plan.units.filter((u) => u.design?.length && rec(u.id)?.status === 'merged' &&
    (owedOnly ? owedDesignIds.has(u.id)
      : (prior.units?.[u.id]?.status !== 'merged' || owedDesignIds.has(u.id))))
  const doDesign = dueHere('design', designUnits.length > 0 && previewStatus === 'live')
  const fb = `${repo}/.roadmap/feedback`
  // The four BOUNDARY ROLES (explorer, health, flake, design) run on the CODEX role adapter, not on
  // Opus. Three notes on how they are wired, because each was a decision:
  //   cwd — the explorer and the design reconciler run in the PREVIEW worktree (${prevWt}): the thing
  //     they judge is the running product, and that tree is where a shell may reach it without any
  //     sanctioned command touching the operator's checkout (§19). The health assessor and the flake
  //     band run in the integration worktree, which is the tree they read and re-run.
  //   sandbox — all four declare `workspace-write`, INCLUDING the read-only health assessor, because
  //     each writes exactly one file: its own report. The read-only-ness is therefore carried by the
  //     BRIEF, which is the adapter's documented answer whenever the sandbox cannot carry it — and in
  //     this environment it never can, since `config.codexSandbox` ('danger-full-access', for the
  //     measured reason on that knob) overrides the role's intent anyway. The feedback directory also
  //     sits OUTSIDE every one of these cwds, so no writable-roots scoping would express the real
  //     permission set either; a knob the environment overrides is a knob that lies.
  //   null — a codex role failure is codex's (adapter contract): it degrades `codex-role` once and
  //     returns null, and the settleOwed block below turns that into an owed marker, exactly as a
  //     dead Opus explorer did. No `.catch` here: the adapter never throws, and a throw from it would
  //     be a caller bug worth surfacing rather than swallowing.
  const [expl, hlth, flk, dsgn] = await Promise.all([
    !doExplore ? null : run(
      `You are the wave-${waveN} runtime explorer for a roadmap build. The integrated result is live as a ` +
      `preview — drive it via: ${plan.preview.howToAccess}. It serves integration tip ${explSha}. Your charter ` +
      `is runtime behavior ONLY — the diff, tests, and gates already judged the code: drive flows end to end ` +
      `the way a skeptical user would, poke edge cases, feed hostile/empty/huge inputs, break expected ` +
      `sequences — hunting behavior that is unexpected, counterintuitive, underdocumented, brittle, or ` +
      `misaligned with the specs' intent (specs: ${repo}/.roadmap/specs/). ` +
      // The sandbox cannot carry this (see the boundary-role comment above the array), so the brief does.
      `CHANGE NOTHING: no commits, no edits to any file under ${prevWt} or ${repo}, no restarts of a process ` +
      `you did not start. The ONE file you may create is the report named below. At most 10 findings — ` +
      `severity, exact repro, observed vs expected; an empty report is legitimate and better than manufactured ` +
      `findings.\n\n` + reportWrite(`${fb}/explorer/wave-${waveN}.md`,
        `# Wave ${waveN} — runtime exploration (sha ${explSha})`,
        `one bullet per finding, \`- **<severity>** <summary>\`, each followed by the two indented sub-bullets ` +
        `\`  - repro: <repro>\` and \`  - observed: <observed> · expected: <expected>\` — or the single line ` +
        `\`No findings.\` when you have none — then, only when \`notes\` is non-empty, a blank line and the ` +
        `line \`Notes: <notes>\``) +
      `Report shaObserved: ${explSha}.`,
      { model: 'codex', cwd: prevWt, sandbox: 'workspace-write', phase: 'Boundary',
        label: `explorer:w${waveN}`, schema: S.explore, timeoutMin: C.codexBoundaryTimeoutMin }),
    !doHealth ? null : run(
      `You are the wave-${waveN} codebase-health assessor for a roadmap build. In the integration worktree at ` +
      `${intWt} (tip ${tip}) — the directory you are running in: per-unit gates each saw one unit; you own what ` +
      `none could see. Report with ` +
      `file-level specifics: test health — coverage gaps, slow tests, brittleness (assertions on ` +
      `implementation detail, over-mocking, order/timing dependence); structural health — files grown too ` +
      `large, misplaced code, architectural drift; cross-unit consistency — units that independently added ` +
      `equivalent helpers, diverged on the pattern for the same task, or reimplemented something ` +
      `${conventions ? `the conventions contract at ${conventions} already catalogs` : `another unit already provides`}; ` +
      `ergonomics — manual dev steps that should be automated, missing tooling that taxes every round. For ` +
      `each finding worth fixing, also return a ready-to-dispatch fix-unit draft (id, goal, files, acceptance ` +
      `criteria as individually checkable clauses) — a draft is the default action, not a suggestion, and it ` +
      `is what the boundary triage admits without re-authoring. ` +
      `READ-ONLY: change nothing in ${intWt} and nothing under ${repo} — no edits, no commits, no test runs ` +
      `that write. The ONE file you may create is the report named below. An empty report is legitimate.\n\n` +
      reportWrite(`${fb}/health/wave-${waveN}.md`, `# Wave ${waveN} — codebase health (tip ${tip})`,
        `one bullet per finding, \`- **<area>** <what> (<where>)\` with the parenthesis omitted when \`where\` ` +
        `is empty — or the single line \`No findings.\` — then a blank line, the heading \`## Fix-unit drafts\`, ` +
        `and one bullet per draft, \`- <id>: <goal>\` followed by the indented sub-bullets ` +
        `\`  - files: <files joined by ", ">\` and \`  - acceptance: <acceptance clauses joined by " · ">\`, ` +
        `or the single line \`None.\` when you drafted none`),
      { model: 'codex', cwd: intWt, sandbox: 'workspace-write', phase: 'Boundary',
        label: `health:w${waveN}`, schema: S.health, timeoutMin: C.codexBoundaryTimeoutMin }),
    // Pure execution — no judgment in it at all — so the flake band runs on codex too, in the same
    // integration worktree the health assessor reads. It is a boundary role like the other three, and
    // takes their deadline rather than the 20-minute role default: N full suites back to back is real
    // work, not the one-artifact errand that bar was written for. And, like them, it writes its own
    // record — a Codex process has a shell, so the Haiku transcriber it used to need is gone.
    !(doHealth && C.flakeReruns > 0 && dueHere('flake', true)) ? null : run(
      `# GOAL\nHunt intermittent tests in the integration worktree at ${intWt} (tip ${tip}). Run the ` +
      `project's full test suite ${C.flakeReruns} times in a row (build/test commands are documented at ` +
      `${brief}). Fix nothing, edit nothing, commit nothing — you are measuring, not repairing. The ONE ` +
      `file you may create is the record named below.\n\n` +
      `# METHOD\nImmediately BEFORE each run, read the first number printed by \`cat /proc/loadavg\` and ` +
      `keep it for \`loads\`. Then run the suite. A flip is not worth less because the box was busy — the ` +
      `numbers are recorded so a triager can tell a saturated run from a real sentinel, and you must not ` +
      `withhold, wait, or re-run on account of them.\n\n` +
      `# REPORT\n\`runs\` = how many of the ${C.flakeReruns} runs completed. \`flips\` = the exact name of ` +
      `every test that changed pass/fail between runs (an empty list is the healthy answer, and the right one ` +
      `when the suite was stable). \`loads\` = the loadavg1 samples you took, in run order. \`cpuCount\` = ` +
      `the number printed by \`nproc\`.\n\n` +
      // Its own file, not a section inside the health report: the health assessor owns that path end
      // to end, and two writers on one path is a lost section waiting to happen.
      reportWrite(`${fb}/health/wave-${waveN}-flake.md`, `# Wave ${waveN} — flake re-runs (tip ${tip})`,
        `the single line \`<runs> runs; flips: <flips joined by ", ">\` — or \`<runs> runs; stable\` when ` +
        `\`flips\` is empty — with \` (loadavg1 per run: <loads joined by ", "> on <cpuCount> cpu)\` appended ` +
        `to that same line when you took load samples, the \` on <cpuCount> cpu\` omitted when you have no ` +
        `cpu count, and \` — <detail>\` appended last when \`detail\` is non-empty`, 'detail'),
      { model: 'codex', cwd: intWt, sandbox: 'workspace-write', schema: S.flake, phase: 'Boundary',
        label: `flake:w${waveN}`, timeoutMin: C.codexBoundaryTimeoutMin }),
    !doDesign ? null : run(
      `You are the wave-${waveN} design-fidelity reconciler for a roadmap build. These units merged this wave ` +
      `against design authorities: ${designUnits.map((u) => `${u.id} (${u.design.join(', ')})`).join('; ')}. ` +
      `FIRST read ${repo}/.roadmap/architect-log.md: the architect may have APPROVED divergences from a comp, or ` +
      `folded a divergence into the comp itself — those are decisions, not drift, and reporting them as findings ` +
      `wastes a wave. Then, for each unit's covered surfaces, drive the live preview (${plan.preview.howToAccess}, ` +
      `serving ${explSha}) and compare what it renders against the comp source under the authority paths ` +
      `(${[...new Set(designUnits.flatMap((u) => u.design.map((d) => authOf(d)?.path)).filter(Boolean))].join(', ')}). ` +
      `If the brief (${brief}) documents a screenshot command, capture each surface and judge it VISUALLY against ` +
      `the comp render, and report visionUsed:true. If no screenshot capability is provisioned, compare the served ` +
      `DOM against the comp source instead and report visionUsed:FALSE — do not imply you saw anything you did ` +
      `not. Classify each finding: "bug" = it renders wrong; "adoption-gap" = the surface reimplements what the ` +
      `comp already provides; "irreconcilable" = the built behaviour and the comp cannot both be right, so a ` +
      `human decision is needed. For each finding worth fixing, return a ready-to-dispatch fix-unit draft (id, ` +
      `goal, files, acceptance criteria as individually checkable clauses). ` +
      `Change nothing — no commits, no edits. The ONE file you may create is the report named below. ` +
      `An empty report is legitimate.\n\n` +
      reportWrite(`${fb}/design/wave-${waveN}.md`,
        `# Wave ${waveN} — design fidelity (sha ${explSha}, <"screenshots compared visually" when you set ` +
        `visionUsed true, else "NO SCREENSHOT CAPABILITY — DOM vs comp source only">)`,
        `one bullet per finding, \`- **<severity>** <surface> vs <comp> — <what>\` with the \` vs <comp>\` ` +
        `omitted when \`comp\` is empty — or the single line \`No findings.\` — then a blank line, the heading ` +
        `\`## Fix-unit drafts\`, and one bullet per draft, \`- <id>: <goal>\` followed by the indented ` +
        `sub-bullets \`  - files: <files joined by ", ">\` and ` +
        `\`  - acceptance: <acceptance clauses joined by " · ">\`, or the single line \`None.\` when you ` +
        `drafted none; then, only when \`notes\` is non-empty, a blank line and the line \`Notes: <notes>\``) +
      `Report shaObserved: ${explSha}.`,
      { model: 'codex', cwd: prevWt, sandbox: 'workspace-write', phase: 'Boundary',
        label: `design:w${waveN}`, schema: S.design, timeoutMin: C.codexBoundaryTimeoutMin }),
  ])
  // Settle the owed ledger BEFORE any early return: a job that was DUE but produced nothing is
  // owed whether it was skipped (precondition down) or died; a successful run discharges its
  // entries; a job not due this wave carries its prior entry untouched. `count` = consecutive
  // boundaries owed — the conductor escalates repeat offenders to the Fable tier.
  const settleOwed = (job, due, ok, why, unitIds) => {
    const prevEntry = owed.find((o) => o.job === job)
    owed = owed.filter((o) => o.job !== job)
    if (ok) return
    if (!due) { if (prevEntry) owed.push(prevEntry); return }
    owed.push({ job, wave: prevEntry?.wave ?? waveN, why, count: (prevEntry?.count ?? 0) + 1,
      ...(unitIds?.length ? { units: unitIds } : {}) })
  }
  const previewWhy = previewStatus === 'failed' ? 'preview failed at setup — fix the primary checkout and relaunch'
    : 'no live preview this wave'
  settleOwed('explorer', dueHere('explorer', previewStatus !== 'none'), !!expl,
    doExplore ? 'explorer agent produced no report' : previewWhy)
  settleOwed('health', doHealth, !!hlth, 'health assessor produced no report')
  settleOwed('flake', dueHere('flake', doHealth && C.flakeReruns > 0), !!flk, 'flake re-runs produced no report')
  settleOwed('design', dueHere('design', designUnits.length > 0), !!dsgn,
    doDesign ? 'design reconcile produced no report' : previewWhy,
    designUnits.map((u) => u.id))
  // A health role that produced nothing leaves this wave with NO fix-unit drafts — the boundary's
  // one source of consolidation work — and the triage tiers cannot tell "nothing to consolidate"
  // from "nobody looked". The adapter already filed a `codex-role` row saying the process died;
  // this one says what that cost the wave, in the ledger the triager reads. The boundary proceeds
  // either way: a skipped assessment is not a failed wave, and the owed marker re-queues it.
  if (doHealth && !hlth)
    degrade({ label: `health:w${waveN}`, model: 'codex', phase: 'Boundary', kind: 'health-skipped',
      what: `the wave-${waveN} health assessment produced no report — no findings and no fix-unit drafts ` +
        `were available to this boundary, so an empty draft set here means UNASSESSED, not clean. ` +
        `An owed marker re-queues it at the next boundary.` })
  // Only assign when a job actually ran, so serialize() omits an empty all-null block.
  if (!expl && !hlth && !flk && !dsgn) return
  if (designUnits.length && !dsgn)
    degrade({ label: `design:w${waveN}`, model: 'codex', phase: 'Boundary', kind: 'no-report',
      what: `design reconcile did not report for ${designUnits.map((u) => u.id).join(', ')} ` +
        `(${doDesign ? 'agent produced nothing' : 'no live preview'}) — those surfaces went unchecked this wave. ` +
        `An owed marker re-queues them at the next boundary; they must be reconciled or explicitly waived before close-out.` })
  boundary = { explorer: expl, health: hlth, flake: flk, design: dsgn }
  // Every boundary ROLE writes its own report (reportWrite, above) — a Codex process has a
  // filesystem, so the four Haiku verbatim-writers that used to transcribe explorer/health/design
  // results and the flake band's re-run record are all gone.
}

// Issue-projection reconciliation sweep (issue mode only): one Haiku pass at the wave tail that
// re-derives every unit issue's status:* label from the final map — catching a missed folded flip, a
// `blocked`, or a transient `merge-ready` the live clauses (setup/merge/dossier) don't cover — and
// refreshes the arc tracking issue's status table. Best-effort, idempotent (find-or-create by
// marker), and the one place UNIT sync records a gh-sync degradation. A single Haiku call, present on
// BOTH dispatch paths because it lives here; a no-op in file mode (keeping that path byte-identical).
async function syncIssues() {
  if (!issueMode) return
  const N = (prior.wave ?? 0) + 1
  const issueOf = new Map(plan.units.map((u) => [u.id, u.issue]))
  const closesOf = new Map(plan.units.filter((u) => u.closes?.length).map((u) => [u.id, u.closes]))
  const rowsOf = (entries) => entries.map(([id, r]) => ({ id, status: r.status, issue: issueOf.get(id) ?? null,
    ...(closesOf.has(id) ? { closes: closesOf.get(id) } : {}) }))
  const allRows = rowsOf([...units])
  // Reconcile LABELS only for units whose status CHANGED this wave. Prior waves' units were already
  // reconciled by the sweep of the wave that moved them, so re-editing all of them every wave only burns
  // GitHub API quota — an O(all-units) burst of redundant `gh issue edit`s that grows every wave and, on
  // a large arc, risks the secondary (abuse) rate limit. The delta still backstops THIS wave's folded
  // clauses (a merged/quarantined unit counts as changed), and the task list still lists ALL units in a
  // single tracking-issue edit, so the dashboard stays whole. gh rate-limit errors are tolerated anyway.
  const changed = rowsOf([...units].filter(([id, r]) => r.status !== (prior.units?.[id]?.status ?? 'pending')))
  const r = await run(
    STRICT +
    `In the git repository at ${repo}, reconcile the GitHub issue projection after wave ${N} of this roadmap ` +
    `build. Best-effort throughout: if a gh command fails (a rate limit included), note it and keep going — never ` +
    `error out; issue state is observability, not a gate. ${MARKER_RULE}For each CHANGED unit below, resolve its ` +
    `issue number — use its \`issue\` field if non-null, else run the exact-marker search ` +
    `(\`${markerFind('roadmap:unit id=<id>')}\`, substituting the unit's id; it prints \`<number> <state>\` for ` +
    `the one exact match and nothing at all when there is none); ` +
    `if found and NOT closed, make its labels match its status — remove any other \`status:*\` label, add the one that matches, ` +
    `and ensure \`wave:${N}\` on any unit that is running or beyond: pending/running/merge-ready/blocked/` +
    `quarantined stay OPEN; merged → add \`status:merged\` then \`${GH_HERE} issue close ${ghRepo}<n> --reason completed\`; ` +
    `deferred → add \`status:deferred\` then \`${GH_HERE} issue close ${ghRepo}<n> --reason "not planned"\`. For any ` +
    `changed unit whose row carries a \`closes\` array and whose status is merged, also ensure each listed issue ` +
    `number is closed (\`${GH_HERE} issue close ${ghRepo}<n> --reason completed --comment "Resolved by unit <id>."\`) — ` +
    `skip numbers already closed. Skip any unit ` +
    `whose issue is not found, and do NOT touch any unit not listed here — they were reconciled in an earlier ` +
    `wave. Changed units:\n${JSON.stringify(changed)}\n` +
    (plan.trackingIssue
      ? `Then refresh the arc tracking issue #${plan.trackingIssue} from the FULL unit list: rewrite only the ` +
        `region between the \`<!-- roadmap:status -->\` and \`<!-- /roadmap:status -->\` markers in its body with ` +
        `a GitHub task list — one item per unit, \`- [x] #<n> <id> — <status>\` when that unit's issue is closed ` +
        `(merged or deferred) and \`- [ ] #<n> <id> — <status>\` while it is still open — so the tracking issue ` +
        `renders a native progress rollup and each item links to its unit issue. This is one edit of a single ` +
        `issue, not a per-unit call. Skip any unit whose issue number is unknown, and leave the rest of the body ` +
        `intact. Full unit list:\n${JSON.stringify(allRows)}\n`
      : '') +
    `Report ok:true when the sweep completed (even if some individual gh calls failed); put a one-line summary of ` +
    `any failures in detail.`,
    { model: 'haiku', effort: 'low', phase: 'Boundary', label: `issue-sync:w${N}`, schema: S.ok },
  ).catch(() => null)
  if (!r?.ok)
    degrade({ label: `issue-sync:w${N}`, model: 'haiku', phase: 'Boundary', kind: 'gh-sync',
      what: `wave-tail issue reconciliation did not complete cleanly${r?.detail ? ` — ${r.detail}` : ''} ` +
        `(issue projection only; state.json is authoritative and the arc is unaffected)` })
}

// Opus-first plan-check ladder, shared by the per-unit pipeline and the warm-lane per-link
// checks. Returns {verdict: approve|redirect|quarantine, guidance, notes}. The Fable pass fires
// on high risk, claimed-infeasible, always-fable policy, or an Opus escalation.
// Charter note (arc-observed, RATIONALE §4): 11 plan-checks in one arc never fired on plan
// PLAUSIBILITY but approved past spec-internal contradictions the implementer then had to
// reconcile ad hoc. Hence the spec-interrogation clause in both prompts — don't drop it.
async function runPlanCheck(unit, implPlan, spec, { critique = null } = {}) {
  // The pre-dispatch gate is THE highest-leverage judgment point in the codex lane (better
  // judgment up front means less wasted implementation, fewer findings, fewer fix rounds), so
  // Fable takes every med/high-risk unit — only low-risk singles ride Opus-first.
  // `critique` threads the cross-model spec review (codex-spec-review) in as adjudication input.
  const critiqueClause = critique?.questions?.length || critique?.risks?.length
    ? ` A second engineer from a different model family reviewed the spec and this plan read-only before you. ` +
      `Adjudicate each item explicitly — cross-model disagreement here is signal, not noise, and an unanswered ` +
      `genuine question is a spec defect to resolve through your verdict, never something the implementer ` +
      `absorbs mid-build. Questions: ${JSON.stringify(critique.questions ?? [])}. ` +
      `Risks: ${JSON.stringify(critique.risks ?? [])}.`
    : ''
  // The Fable plan-check — the frontier pass. `lead` carries an Opus escalation's assessment
  // so the architect confirms/overturns a concrete concern rather than re-deriving it; '' when
  // reached directly, keeping that prompt byte-identical to before.
  const fablePlanCheck = (lead = '') => {
    spend.planChecks++
    return run(
      `You are the architect of a roadmap build. A capable engineer proposes this implementation plan for unit ` +
      `${unit.id} — read the spec at ${spec} and its contracts yourself, then judge it:\n${JSON.stringify(implPlan)}\n` +
      `You are the only frontier eyes between this spec and code, so interrogate the SPEC as hard as the plan: ` +
      `hunt contradictions within the spec, clauses that contradict ` +
      `a referenced contract or documented codebase reality, and stale premises. ${designClause(unit)}${unit.design?.length ? 'A spec clause that contradicts the comp it cites ranks with a contract contradiction — '+ 'resolve it now. ' : ''}A spec defect is not the ` +
      `engineer's to absorb — resolve it now through your verdict. ${HOST_BAR}And judge the plan the way only frontier ` +
      `eyes can — the implementer is an able, literal-minded builder who will execute exactly what is approved, ` +
      `so what you wave through is what the codebase becomes: overengineering and complexity that does not earn ` +
      `its keep, structure that makes the NEXT change harder, missed reuse or a simpler shape for the same ` +
      `outcome, and decisions that quietly close doors the roadmap needs open. A plan can be technically ` +
      `correct and still deserve redirection on those grounds.${critiqueClause} ${directionClause}` +
      `Your verdict controls what happens next — use it precisely: "approve" = proceed to IMPLEMENT this plan ` +
      `as-is; "redirect" = the engineer revises the plan per your guidance, then implements (this includes ` +
      `naming the explicit resolution of a spec contradiction when the right call is clear); "quarantine" = do ` +
      `not implement at all (e.g. the spec is unsatisfiable or self-contradictory within its contracts, or needs ` +
      `redesign above the engineer's pay grade). Approve unless something is meaningfully wrong. If redirecting, ` +
      `say what and why in a few sentences — the engineer needs direction, not instructions.${lead}`,
      { model: 'fable', effort: C.fableEffort, phase: 'Architect', label: `plan-check:${unit.id}`, schema: S.planVerdict })
  }
  if (unit.risk !== 'low' || !implPlan.feasible || C.planCheck === 'always-fable')
    return fablePlanCheck()
  spend.opusPlanChecks++
  const oc = await runReq(
    `You are an Opus plan-checker standing in for the architect on unit ${unit.id} of a roadmap build — but ` +
    `killing a unit is frontier-only, so you may approve or redirect the plan yourself, never quarantine. Read ` +
    `the spec at ${spec} and the contracts it references, then judge this plan against them:\n` +
    `${JSON.stringify(implPlan)}\n` +
    `This check is the only pre-code eyes on the spec itself, so interrogate the SPEC as hard as the plan: ` +
    `hunt contradictions within the spec, clauses that contradict a referenced contract or documented codebase ` +
    `reality, and stale premises the implementer would otherwise resolve ad hoc mid-build. ${designClause(unit)}${unit.design?.length ? 'A spec clause contradicting the comp it cites ranks with a contract contradiction: '+ 'redirect, or escalate on the "contract" trigger. ' : ''}` +
    `${HOST_BAR}` +
    `Choose a verdict: "approve" = proceed to IMPLEMENT as-is (approve unless something is meaningfully wrong); ` +
    `"redirect" = the engineer revises per your guidance, then implements (say what and why in a few sentences, ` +
    `not instructions; this includes naming the explicit resolution of a spec contradiction when the right ` +
    `call is clearly within your authority); "escalate" = hand to the frontier architect when the call turns ` +
    `on contract interpretation, a spec contradiction you cannot resolve yourself, architectural foundations, ` +
    `genuine uncertainty, or the unit looks unbuildable. Name the escalation trigger.${critiqueClause} ${directionClause}`,
    { model: 'opus', effort: C.opusEffort, phase: 'Implement', label: `opus-plan-check:${unit.id}`, schema: S.opusPlanVerdict })
  if (oc.verdict === 'escalate') {
    const lead = ` A first-pass Opus plan-check could not clear this itself` +
      `${oc.trigger && oc.trigger !== 'none' ? ` (escalation trigger "${oc.trigger}")` : ''}; use its assessment ` +
      `as a lead to confirm or overturn — not as ground truth: ` +
      `${JSON.stringify({ guidance: oc.guidance, notes: oc.notes })}.`
    return fablePlanCheck(lead)
  }
  // approve/redirect map straight onto the shared verdict handling at the call sites.
  return { verdict: oc.verdict, guidance: oc.guidance, notes: oc.notes }
}

// Cross-model spec critique (best-effort, read-only by INTENT): a short `codex exec` interrogates
// the spec + plan from the OTHER model family's perspective before the plan-check adjudicates. GPT
// and Claude miss different things; the plan-check gets the questions as input, never as verdicts.
// A null skips the pass — the adapter has already ledgered why, and this pass gates nothing.
//
// It is the first caller of the codex ROLE adapter, and deliberately has no bespoke path left: the
// launch, the wait, the reap-and-retry, the read-back discipline and the FINAL MESSAGE section all
// come from `run(..., {model:'codex'})`. What stays here is the only thing that was ever specific
// to this pass — the task text. "Read-only" is stated as the role's `sandbox` AND carried by the
// brief ("change nothing"), because `codexSandbox` overrides the former: `-s read-only` needs the
// same bwrap namespace that fails in this devcontainer (arc-observed: the critique was skipped for
// a bwrap EPERM while merely reading the spec).
const specCritique = (unit, w, implPlan) =>
  run(
    `Read-only critique task for unit ${unit.id}. Read the spec at ${specOf(unit)}, the contract files it ` +
    `references under ${repo}/.roadmap/contracts/, and this implementation plan:\n${JSON.stringify(implPlan)}\n` +
    `You are a second engineer reviewing before implementation begins. Name what you would have to ASK before ` +
    `building this — decisions the spec and plan leave genuinely unsettled (a question you could answer by ` +
    `reading the code is not one), risks the plan underestimates, and acceptance criteria that are missing or ` +
    `untestable as written. Do not propose an alternative design; do not write code; change nothing. ` +
    `Report at most 8 \`questions\` and at most 5 \`risks\`, worst first, each one or two sentences; \`notes\` ` +
    `only if something needs saying.`,
    { model: 'codex', cwd: w, sandbox: 'read-only', schema: S.critique, phase: 'Implement',
      effort: 'low', timeoutMin: 15, label: `codex-spec-review:${unit.id}` },
  )

/* --------------------------- per-unit pipeline -------------------------- */
/* --------------------------- codex executor lane ---------------------------
 * Codex (the OpenAI CLI) is THE implementer — there is no Claude implementation lane. A unit's
 * whole implement→test→fix inner loop is one background `codex exec` in the unit worktree,
 * driven by a cheap steering agent that launches it, polls to completion, disk-verifies, and
 * copies the schema-constrained final message into an S.impl-shaped report. S.impl is the seam:
 * verify, gates, consults, merge and every trigger (specGap/contractMismatch/debt) work
 * untouched, and nothing downstream learns who wrote the code. Fix rounds ride
 * `codex exec resume` (P1-pinned: a resumed session retains the original brief's constraints).
 * Every CLI fact used here is pinned by evals/codex-probe.sh — read it before changing shape.
 */
// OpenAI strict mode (P1-pinned): the --output-schema must list EVERY property as required at
// every level, or the turn 400s with invalid_json_schema and the run dies. Semantically-optional
// fields still appear, as "" / [] / false — the falsy checks downstream already treat them as
// absent. Pure function of the schema literal, so the emitted string is resumeFromRunId-safe.
const strictify = (s) => {
  if (!s || typeof s !== 'object') return s
  const out = { ...s }
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, strictify(v)]))
    out.required = Object.keys(s.properties)
  }
  if (s.items) out.items = strictify(s.items)
  return out
}
// What Codex itself reports (the steering agent adds CODEX_META on top). Mirrors S.impl's caps
// EXACTLY so the steering read-back is a copy, never a compression — a budget mismatch here
// reintroduces the RATIONALE §9 StructuredOutput death class across the process boundary.
const CODEX_OUT = JSON.stringify(strictify(obj({
  status: oneOf(['complete', 'blocked', 'stopped-spec-gap', 'stopped-contract-mismatch']),
  filesChanged: arr('string'), headSha: { type: 'string' },
  summary: { type: 'string', maxLength: 700 },
  contractMismatch: { type: 'string', maxLength: 300 },
  specGap: { type: 'string', maxLength: 300 },
  debt: debtArr, notes: { type: 'string', maxLength: 2000 },
}, [])))
// The shared budget paragraph for every codex brief's FINAL MESSAGE section — byte-for-byte the
// same caps as S.impl/CODEX_OUT.
const CODEX_BUDGETS =
  `Your final message must be ONLY a JSON object matching the output schema you were given; prose outside ` +
  `it is discarded, and every field is required — emit "" / [] / false where you have nothing to say. Take ` +
  `\`filesChanged\` from \`git diff --name-only\` against the base named above and \`headSha\` from ` +
  `\`git rev-parse HEAD\` — read them, do not recall them. Budgets: \`summary\` 2-3 short sentences (max 700 ` +
  `characters); \`contractMismatch\` and \`specGap\` one or two sentences each (max 300 characters); each ` +
  `\`debt\` entry's \`what\` and \`why\` a sentence or two (max 400 characters each), at most 8 debt entries ` +
  `(consolidate related items); \`notes\` at most a short paragraph (max 2000 characters).`
// The build brief — Goal / Context / Constraints / Method / Done-when / Escalation / Final
// message (OpenAI's own scoping structure). Artifacts are referenced by path, EXCEPT the scope
// envelope and the escalation contract, which are inlined because they ARE the guardrails: a
// brief Codex only half-reads must still carry them in its context window.
const codexBuildBrief = (unit, w, dir, base, implPlan, priorAttempt = '') =>
  `# GOAL\n` +
  `Implement unit ${unit.id} in the git worktree at ${w} (branch unit/${unit.id}, diff base ${base}) until ` +
  `every check under DONE-WHEN passes, and commit it. You own the whole loop: write it, test it, fix it, ` +
  `commit it. Nobody is watching between now and your final message.\n\n` +
  priorAttempt +
  `# CONTEXT\n` +
  `- The spec at ${specOf(unit)} is authoritative. Read it in full before writing anything.\n` +
  `- Frozen contracts it references live under ${repo}/.roadmap/contracts/ — immutable requirements. ` +
  `${convClause}${designClause(unit)}\n` +
  `- Codebase conventions and build/test commands are documented at ${brief}.\n` +
  `- A senior engineer already planned this unit and an architect approved the plan — start from it instead ` +
  `of re-exploring: ${JSON.stringify(implPlan)}\n` +
  `- Follow the approved approach. If it is actually wrong, that is a STOP (see ESCALATION), not a licence ` +
  `to substitute your own.\n\n` +
  `# CONSTRAINTS\n` +
  `${SCOPE(implPlan.files)}${NOROADMAP}Never run git rebase, git reset --hard, or git push, and never ` +
  `delete a branch. Work only inside ${w}.\n\n` +
  `# METHOD\n` +
  `1. Read the spec and its contracts, then split the unit into ordered MILESTONES — the smallest slices that ` +
  `each leave the branch green and committable. Work one at a time; do not start the next until the current ` +
  `one is committed. 2. For each acceptance criterion that admits a test, write the test ` +
  `FIRST, at the seams the plan's testPlan names — do not invent new seams and do not restructure production ` +
  `code to create one. 3. Implement until it passes. 4. Run the unit-scoped tests and lint/typecheck ` +
  `(commands: ${brief}). 5. Iterate until green — never report done with a failing check. 6. A test that ` +
  `would still pass if the behaviour were wrong is a failed task, not a pass: for each test you add, break ` +
  `the behaviour it claims to test, confirm the test fails, then restore. NEVER write or amend a test to ` +
  `assert behaviour you believe is wrong, and never narrow one to dodge a case that fails — if correct ` +
  `behaviour needs a change you are not allowed to make, that is a STOP (see ESCALATION), not something to ` +
  `encode as intended. A green suite that documents a defect is the worst outcome available to you. 7. Commit at the end of EVERY ` +
  `milestone, not only at the end of the unit, naming the milestone in the message — this run has a deadline ` +
  `and uncommitted work does not survive it.\n` +
  `8. At each milestone boundary, before starting the next, re-read ${dir}/brief.txt and run ` +
  `\`git log --oneline ${base}..HEAD\`. This run is long enough that your own context may be compacted along ` +
  `the way; those two are the authoritative record of your instructions and of what you have actually landed, ` +
  `and re-reading them is a fresh tool call, not a memory. Trust them over your recollection.\n\n` +
  `# DONE-WHEN (each is checked on disk after you exit; your claim is not the check)\n` +
  `- Every acceptance criterion in ${specOf(unit)} demonstrably holds.\n` +
  `- The unit-scoped tests and lint/typecheck exit 0.\n` +
  `- \`git status --porcelain\` is empty and \`git rev-list --count ${base}..HEAD\` is greater than zero — ` +
  `the commit is the deliverable; uncommitted work does not exist.\n` +
  `- \`git diff --name-only ${base}..HEAD\` lists no path under .roadmap/ and stays inside the scope above.\n` +
  `- Only when ALL of the above hold, write the single line \`DONE ${unit.id}\` to ${dir}/done.txt. ` +
  `If you finish without all of them holding, do NOT write it.\n\n` +
  `# ESCALATION — stop, do not improvise\n` +
  `Stop only if you cannot proceed without making a decision that the spec, the contracts, the conventions ` +
  `and the code do not settle AND a competent engineer could reasonably decide the other way. A question you ` +
  `can answer by reading is not a stop — read the spec, the contracts and the code first, every time. There is ` +
  `no cap on stops across this unit: an adjudicator answers and resumes you, so a second genuine decision is a ` +
  `second stop, never a licence to improvise. When you stop: commit everything already ` +
  `finished, set \`status\` to "stopped-spec-gap" (a decision the spec leaves unsettled) or ` +
  `"stopped-contract-mismatch" (a frozen contract contradicts code that exists, or cannot be implemented as ` +
  `written), fill \`specGap\` or \`contractMismatch\` with one or two sentences (max 300 characters: which ` +
  `decision or surface, and the alternative you did not take), and exit. Never amend a contract; never widen ` +
  `scope to route around a contradiction. Otherwise leave BOTH fields as empty strings — each is a trigger ` +
  `that summons the architect, never a notes field; never write "none" or an FYI there.\n\n` +
  `# FINAL MESSAGE\n${CODEX_BUDGETS}\n`
// What a retry brief says about the attempt it is replacing. The steerer has already reaped that
// process (see `reap` in steerCodex), so a live sibling in this worktree means the reap failed —
// a harness bug to report, never a run to wait on or race. Arc-observed 2026-08-23: a retry codex
// found the first process still editing the worktree and spent an hour narrating it read-only.
const PRIOR_ATTEMPT =
  `# PRIOR ATTEMPT\n` +
  `An earlier Codex run on this worktree died and has been killed and reaped. Its commits, if any, are on the ` +
  `branch and are yours to build on — read \`git log\` before you start. There must be no other Codex process ` +
  `in this worktree: if you find one running, that is a HARNESS bug, not a condition to wait on — stop ` +
  `immediately, set \`status\` to "blocked", say so in \`summary\`, and exit. Do not wait for it, do not ` +
  `hand off to it, and do not edit alongside it.\n\n`
// A fix-round brief. Self-contained enough to work in a FRESH session too (the fresh fallback
// when no resumable session matches this worktree): it names the spec, the scope, and the exact
// repairs. P1-pinned: a resumed session still holds the build brief's constraints, so the scope
// text here is reinforcement, not the sole carrier.
const codexFixBrief = (unit, w, base, envelope, payload) =>
  `Follow-up on unit ${unit.id} in the git worktree at ${w} (branch unit/${unit.id}, diff base ${base}; ` +
  `spec: ${specOf(unit)}).\n\n${payload}\n\n` +
  `${FIX_SCOPE(envelope)}Run the unit-scoped tests and lint/typecheck (commands: ${brief}) until green — ` +
  `never report done with a failing check. ${NOROADMAP}Commit your fixes on the current branch.\n\n` +
  // A resume brief with no termination condition does not idle — it invents work. Probe-observed
  // (codex-horizon-probe.sh): a resumed session finished every specified milestone, then kept
  // going into self-directed "Audit:" commits, expanding a spec line that asked only for
  // `restore(snapshot(s))` to round-trip into a custom serializer for cyclic references, BigInt
  // and NaN, plus an exported internals hook to test it with. The build brief is protected by its
  // DONE-WHEN; every resume needs the same stopping rule restated or it inherits none.
  `# ESCALATION — the same rule as your original brief\n` +
  `A decision the spec, the contracts and the code do not settle is still a STOP, not yours to make — including ` +
  `any decision the spec explicitly names as open, and any point where a frozen contract contradicts what you ` +
  `must build. Never write or amend a test to assert behaviour you believe is wrong. Set \`status\` to ` +
  `"stopped-spec-gap" or "stopped-contract-mismatch", fill the matching field, commit what is finished, and exit; ` +
  `an adjudicator answers and resumes you. Arc-observed: fix rounds silently decided a decision the spec had ` +
  `marked escalate-only, in twelve modules at once, because this brief did not repeat the rule.\n\n` +
  `# DONE-WHEN\n` +
  `The repairs above are made, the checks are green, and your work is committed. Then STOP and report. ` +
  `Do not add requirements the spec does not state, do not harden or refactor beyond the repairs, and do not ` +
  `invent follow-up work — finishing early is correct, and anything past the repairs is scope creep the gate ` +
  `will reject.\n\n` +
  `# FINAL MESSAGE\n${CODEX_BUDGETS}\n`
// The steering prompt: launch codex in the background (the preview-process idiom: setsid +
// pidfile + group kill), poll sleep-free, kill at the deadline, verify the work ON DISK, read
// back only the allowlisted slivers, and emit the S.implCodex report. The full transcript is
// never loaded — that is the entire economic point of the lane.
// `id`/`subject` name the run in prose; `sandbox` and `gitTruth` are what the ROLE adapter varies
// (a role has no diff base, so it collects no git truth and commits nothing). Every other seam —
// the reap, the attach-don't-relaunch rule, the detached `timeout -k` launch, the sleep-free wait,
// the absent-exit-code rule — is shared verbatim, which is the whole point of not forking it.
const steerCodex = ({ id, subject = `unit ${id}`, w, dir, base, briefText, effort, timeoutMin,
  sandbox = C.codexSandbox, gitTruth = true, resumeDir, reapDir, outSchema, reportInstr }) => {
  const launch = resumeDir
    ? `if [ -f ${resumeDir}/session-id ] && [ "$(cat ${resumeDir}/cwd)" = "${w}" ]; then use COMMAND R below; ` +
      `otherwise use COMMAND F below.\n` +
      `COMMAND R: cd ${w} && ${codexHome}setsid nohup sh -c 'echo $$ > ${dir}/codex.pid; ` +
      `timeout -k 30 ${timeoutMin * 60} ` +
      `codex exec resume "$(cat ${resumeDir}/session-id)" ` +
      `-c sandbox_mode="${sandbox}" ${C.codexModel ? `-m ${C.codexModel} ` : ''}` +
      `-c model_reasoning_effort=${effort} -c projects."${w}".trust_level="trusted" ` +
      `${C.codexNetwork ? '-c sandbox_workspace_write.network_access=true ' : ''}` +
      `${C.codexProfile ? `-p ${C.codexProfile} ` : ''}--skip-git-repo-check ` +
      `--output-schema ${dir}/schema.json -o ${dir}/last-message.txt --json - < ${dir}/brief.txt ` +
      `> ${dir}/events.jsonl 2> ${dir}/stderr.log & CPID=$!; trap "kill -TERM $CPID; T=1" TERM; ` +
      `wait $CPID; RC=$?; if [ -n "$T" ]; then wait $CPID; RC=$?; fi; echo $RC > ${dir}/exit-code' &\n` +
      `COMMAND F: `
    : `use this launch command:\n`
  // Resume-collision rule (arc-observed: one gate-fix resume died at once with "thread already
  // has a…" because a live codex process still held the session — a transient, not a verdict on
  // the unit). One timed retry of the resume, then a cold session on the same self-contained brief.
  const collisionRule = resumeDir
    ? ` If you launched COMMAND R and ${dir}/exit-code appears within 2 minutes with a non-zero value while ` +
      `\`grep -qi 'thread already' ${dir}/stderr.log\` matches, the session is still held by another live codex ` +
      `process: run \`sleep 60\`, \`rm -f ${dir}/exit-code ${dir}/codex.pid\`, and relaunch COMMAND R once; if it ` +
      `fails the same way again, \`rm -f ${dir}/exit-code ${dir}/codex.pid\` and launch COMMAND F instead. Say ` +
      `in \`notes\` which of these happened.`
    : ''
  // `timeout -k 30 <deadline>` wraps codex INSIDE the detached sh -c, so the deadline is enforced
  // by the process tree itself and survives the steerer's death. It used to live only in the steer
  // prompt — i.e. in the very process whose death is the failure mode — and a steerer that died
  // left a detached, session-leading codex running unbounded while its OpenAI seat was already
  // handed to the next unit (2026-08-25). `timeout` exits 124 on the deadline; the report
  // instruction reads that as timedOut.
  // `session-id` used to be a steerer instruction (step 5's grep, below) — a model step, and Haiku
  // skipped it at least once (fixture wf_26d28b9e-4ed, add-divide: events.jsonl had a thread.started
  // line, no session-id file). That silently downgrades every fix round to a fresh session, since
  // the resume launch (COMMAND R above) reads this file. Capture is now in the launch line itself:
  // codex is backgrounded so a bounded poll loop can race it, in the SAME process group (so a
  // group kill reaps the loop too), writing the id the moment thread.started appears — durable even
  // if the steerer dies mid-run. The loop only writes on a match, never touches the file otherwise,
  // so a run with no thread.started leaves no file (`test -s` stays honest).
  //
  // THE PIDFILE IS WRITTEN BY THE DETACHED SHELL ITSELF, as its first act — never `echo $! >` after
  // the `&`, at any of the three launch sites. 2026-09-02, reproduced directly rather than inferred:
  // the steerer's Bash tool shell runs with job control ON, so a backgrounded `… &` job is ALREADY a
  // process-group leader, `setsid` must therefore FORK, and `$!` names the short-lived parent —
  // dead within a second (observed 3564161; the real detached sh was 3564163, ppid 1). Every
  // liveness fact the harness has hangs off that pid, so all of them lied at once: `tail --pid`
  // returned instantly and `kill -0` failed ("no exit-code file, pid dead" → 82 `codex-lifecycle`
  // rows at exitCode -1), the reap's `kill -TERM -- -<pid>` hit nothing and its fallback
  // manufactured every "exit 137", and each "reattempt" launched a SECOND codex into a worktree the
  // first was still writing. Cost: 3 waves, ~13 h, 220 codex processes for 4 merges, 14/20 units
  // quarantined on deaths that never happened — codex's own rollout logs show `task_complete`
  // minutes after each steerer reported the process dead. `sh -c 'echo $$ > …; …'` records the
  // shell that survives, and after setsid that `$$` is also the pgid the group kill targets.
  //
  // The `trap` + conditional second `wait` is the other half, and it is what makes a GENUINE reap
  // work. `timeout` puts ITSELF in its own process group, so `kill -TERM -- -$(cat codex.pid)`
  // reaches the detached sh and stops there — `timeout → codex` beneath it survived a group kill
  // (verified with a stand-in sleep). Forwarding the signal from the sh is the fix that stays inside
  // the closed command list (`pkill -s` would not). The second `wait` is gated on the trap's own
  // flag `T`, never on `RC > 128`. Only a trap-INTERRUPTED wait leaves the child unreaped, and only
  // there is re-waiting correct; a child killed outright (an OOM `SIGKILL`, or `timeout -k`
  // escalating) is already reaped by the first wait and returns a true 137. `RC > 128` cannot tell
  // those two states apart, so it re-waited a reaped pid — whose status is then whatever the shell
  // happens to remember about a finished job (POSIX licenses 127 for a pid it no longer knows;
  // dash here returns the remembered 137). The flag decides on what actually happened instead of
  // guessing from a number two different things produce.
  const execCmd =
    `${codexHome}setsid nohup sh -c 'echo $$ > ${dir}/codex.pid; ` +
    `timeout -k 30 ${timeoutMin * 60} codex exec -C ${w} -s ${sandbox} ` +
    `${C.codexModel ? `-m ${C.codexModel} ` : ''}-c model_reasoning_effort=${effort} ` +
    `-c projects."${w}".trust_level="trusted" ` +
    `${C.codexNetwork ? '-c sandbox_workspace_write.network_access=true ' : ''}` +
    `${C.codexProfile ? `-p ${C.codexProfile} ` : ''}--skip-git-repo-check ` +
    `--output-schema ${dir}/schema.json -o ${dir}/last-message.txt --json - < ${dir}/brief.txt ` +
    `> ${dir}/events.jsonl 2> ${dir}/stderr.log & CPID=$!; ` +
    `( i=0; while [ "$i" -lt 120 ] && [ ! -s ${dir}/session-id ]; do ` +
    `L=$(grep -m1 -o "\\"thread_id\\":\\"[^\\"]*\\"" ${dir}/events.jsonl 2>/dev/null); ` +
    `if [ -n "$L" ]; then printf "%s" "$L" | cut -d\\" -f4 > ${dir}/session-id; fi; ` +
    `sleep 1; i=$((i+1)); done ) & ` +
    `trap "kill -TERM $CPID; T=1" TERM; ` +
    `wait $CPID; RC=$?; if [ -n "$T" ]; then wait $CPID; RC=$?; fi; echo $RC > ${dir}/exit-code' &`
  // Reap preamble — only on a retry into a worktree a previous attempt owned. The retry branch is
  // reachable from a GENUINE death and from a false one alike, so the kill is unconditional: a
  // steerer that concluded "dead" while the process was alive once launched a second codex into the
  // same checkout (2026-08-23), and two implementers in one worktree is not a state to reason about.
  const reap = reapDir
    ? `0) REAP THE PREVIOUS ATTEMPT FIRST. If ${reapDir}/codex.pid exists: run ` +
      `\`kill -TERM -- -$(cat ${reapDir}/codex.pid)\` (an error here just means it is already gone — ` +
      `continue), \`sleep 5\`, then \`kill -KILL -- -$(cat ${reapDir}/codex.pid)\`, then wait until ` +
      `${reapDir}/exit-code exists, up to 60 seconds; if it never appears, run ` +
      `\`echo 137 > ${reapDir}/exit-code\` yourself. Do NOT continue to step 1 until the old process is ` +
      `gone — a second Codex writing this worktree while the first is alive corrupts both.\n`
    : ''
  // The cd target is NAMED here, always, rather than left to STRICT's "the first path this task
  // names" — which is `${dir}`, the scratch artifact directory, in every step below. Arc-observed
  // on the role lane before this moved out of one caller's preamble: Haiku cd'd into __codex and
  // refused the whole run because it "is not a git repository".
  const location = `Your cd target is ${w} — the directory Codex itself runs in. ${dir} is a scratch ` +
    `artifact directory, NOT a git checkout: create it with mkdir -p and never cd into it or judge it; ` +
    `Codex is pointed at ${w} by -C. `
  return STRICT +
    `You are the steering agent for an autonomous Codex CLI run on ${subject}. You never write product ` +
    `code yourself — you launch the run, wait for it, verify its work on disk, and report. ${location}` +
    `Do exactly this:\n` +
    reap +
    `1) Create the artifact directory: \`mkdir -p ${dir}\`. Write the file ${dir}/brief.txt with EXACTLY the ` +
    `content between the <<<BRIEF>>> markers at the end of this message (excluding the marker lines; if one ` +
    `write is rejected as too large, write it in consecutive appended parts). Write the file ` +
    `${dir}/schema.json with exactly this one-line JSON: ${outSchema ?? CODEX_OUT}\n` +
    `2) Record launch facts: \`date +%s > ${dir}/launched-at\` and \`printf '%s' "${w}" > ${dir}/cwd\`.\n` +
    `3) Launch Codex in the background. FIRST: if ${dir}/codex.pid already exists, a run was ALREADY ` +
    `launched from this exact request (you are a re-dispatch — a schema retry, a salvage, or a replay) — do ` +
    `NOT launch a second one and do NOT delete the file; skip straight to step 4 and attach to the run that ` +
    `is already there. Otherwise, ${launch}${execCmd}${collisionRule}\n` +
    `4) Wait, sleep-free: repeat \`timeout 540 tail --pid=$(cat ${dir}/codex.pid) -f /dev/null\`, each time ` +
    `setting your Bash tool's own timeout to its 600000 ms maximum so the call is not cut short (a 124 exit ` +
    `just means still running). Runs here are long — hours, not minutes — so expect many such waits and never ` +
    `conclude from a 124 that anything is wrong. Repeat until ${dir}/exit-code exists. ` +
    `A MISSING ${dir}/exit-code MEANS RUNNING, NEVER DEAD: the only evidence of death is a dead pid, so ` +
    `before you may stop waiting on that ground, run \`kill -0 $(cat ${dir}/codex.pid)\` — if it SUCCEEDS the ` +
    `process is alive and you keep waiting, however long it has been; only if it FAILS while ${dir}/exit-code ` +
    `is still absent may you stop and report exitCode -1. Elapsed time on its own is never evidence. If \`$(date +%s)\` minus the value in ` +
    `${dir}/launched-at ever exceeds ${timeoutMin * 60}, the run is TIMED OUT: kill the process group with ` +
    `\`kill -TERM -- -$(cat ${dir}/codex.pid)\`, wait ~5 seconds, \`kill -KILL -- -$(cat ${dir}/codex.pid)\`, ` +
    `then treat whatever is on disk as the result.\n` +
    `5) Read back ONLY these — never open ${dir}/events.jsonl whole, never read a Codex transcript, never ` +
    `paste more than these slivers into your context:\n` +
    `   - \`head -c 8000 ${dir}/last-message.txt\` (the schema-constrained final report; may be absent),\n` +
    `   - \`grep '"turn.completed"' ${dir}/events.jsonl | tail -1\` (usage: input/output tokens, turn count),\n` +
    `   - \`grep -h -iE 'turn.failed|"type":"error"|usage limit|rate limit|quota|429|thread already' ${dir}/events.jsonl ` +
    `${dir}/stderr.log | tail -5 | cut -c1-250\` (errors; also decides \`limitHit\`)${gitTruth ? ',' : '.'}\n` +
    (gitTruth
      ? `   - git truth in ${w} — every one of these carries its own \`-C\`, because your working directory ` +
        `does not survive from one command to the next: \`git -C '${w}' rev-list --count ${base}..HEAD\`, ` +
        `\`git -C '${w}' diff --name-only ${base}..HEAD\`, \`git -C '${w}' status --porcelain\`, ` +
        `\`git -C '${w}' rev-parse HEAD\`, and whether ${dir}/done.txt exists.\n` +
        `6) If \`git -C '${w}' status --porcelain\` shows uncommitted changes, commit them yourself — ` +
        `\`git -C '${w}' add -A && git -C '${w}' commit -m "${id}: commit work left uncommitted by codex"\` — ` +
        `and say so in \`notes\`: uncommitted work is invisible to every downstream judge.\n`
      : '') +
    `${gitTruth ? 7 : 6}) ${reportInstr ?? (`Emit the structured report: copy \`summary\`/\`contractMismatch\`/\`specGap\`/\`debt\`/\`notes\` ` +
    `through from the final report VERBATIM (never summarize or expand them; empty strings stay empty — ` +
    `each budget already matches your schema: summary max 700 characters, contractMismatch and specGap ` +
    `max 300 characters each, debt entries' what/why max 400 characters each, notes max 2000 characters); ` +
    `if the final report is absent or unparseable, set \`summary\` to one sentence saying so (that absence ` +
    `is data, not a failure to hide). \`filesChanged\` comes from the git diff you ran, NOT from the report. `)}` +
    `Fill \`codex\` with the process facts you observed: exitCode (the integer in ${dir}/exit-code; -1 ONLY ` +
    `when that file is absent AND step 4's \`kill -0\` proved the pid dead — never because waiting felt long), ` +
    (gitTruth ? `commits (the rev-list count), ` : '') +
    `turns/inputTokens/outputTokens from the usage line (0 if ` +
    `absent), timedOut (you killed it at the deadline, OR ${dir}/exit-code contains 124 — the launcher's own ` +
    `\`timeout\` fired), ` + (gitTruth ? `doneMarker (${dir}/done.txt existed), ` : '') +
    `limitHit (any error sliver mentioned a usage/` +
    `rate limit, quota, or 429), sessionCaptured (${dir}/session-id written non-empty), and \`error\` — ONE ` +
    `of those error lines, the most informative, copied as a SINGLE line of at most 250 characters; never ` +
    `concatenate several of them and never let a newline into it (five 300-character lines joined is 1500 ` +
    `characters into a 300-character field, which is a rejected report, not an error message). Empty string ` +
    `if there is none. ${TERSE}\n` +
    `<<<BRIEF>>>\n${briefText}\n<<<BRIEF>>>`
}
// Counting semaphore on concurrent codex PROCESSES (one OpenAI account behind them all; 16
// concurrent execs would trip its limits immediately). The steering agent's lifetime brackets
// the process's, so gating the steering call gates the process. Timing-only — prompts are
// unaffected, so resumeFromRunId replay is safe.
let codexSlots = 0
const codexQueue = []
const withCodexSlot = async (fn) => {
  while (codexSlots >= C.codexMaxConcurrent) await new Promise((r) => codexQueue.push(r))
  codexSlots++
  try { return await fn() } finally { codexSlots--; codexQueue.shift()?.() }
}
// Counting semaphore on concurrent TEST lanes — the codex semaphore's twin, a different resource.
// Codex runs are gated by one OpenAI account; test lanes are gated by the HOST. Everything that
// spends the box's cores goes through here: the polish-loop verify, every gate re-verify, and the
// integrated suite at merge. Timing-only — no prompt changes, so replay is safe — and it cannot
// deadlock: a slot is always released by the call that took it, and nothing holding one waits on
// another. When a slot is free it returns fn()'s OWN promise rather than a wrapper, so an
// uncontended lane settles on exactly the tick it did before: the merge queue and the mirror
// chain both serialise on microtask timing.
let gateSlots = 0
const gateQueue = []
const withGateSlot = (fn) => {
  if (gateSlots >= C.gateMaxConcurrent)
    return new Promise((r) => gateQueue.push(r)).then(() => withGateSlot(fn))
  gateSlots++
  const release = () => { gateSlots--; gateQueue.shift()?.() }
  const p = fn()
  p.then(release, release)   // releases a tick AFTER p settles; never delays p itself
  return p
}
// ---- the CODEX BACKEND breaker: the codex counterpart of haltPlatform() ----------------------
// A provider's death is a fact about the PROVIDER, never a verdict on a unit. `haltPlatform`
// (above) says exactly that for the Claude platform; this says it for Codex, and the design is
// deliberately the same shape: one wave-level halt, dispatch stops, in-flight units PARK with
// their commits intact, and the operator waits the outage out instead of reading N quarantines.
//
// 2026-09-03, from ~14:43 UTC: every codex run died with `turn.failed: unexpected status 404 Not
// Found … chatgpt.com/backend-api/codex/responses` while `codex login status` still said "Logged
// in". The wave ran to the end on a dead backend — 23 `codex-exec` rows, five units BLOCKED at
// verify, one QUARANTINED as "the planner died twice", the whole boundary owed, and a tier-4
// return with nothing to judge. The wave-start smoke (below) catches an outage that is already
// underway; this catches one that STARTS mid-wave.
//
// It differs from `haltPlatform` in its SIGNAL only, and it can afford to: a codex failure
// carries the one error line the steerer copies back, where an `agent()` null carries no error
// object at all (which is why runReq's trigger is structural instead). So the trigger here is
// text — but text plus REPETITION ACROSS DIFFERENT WORK, which is the part that makes it safe.
// One unit's 404 could be that unit's bad luck; the same HTTP status on two different units or
// roles back-to-back cannot be a unit defect, because no defect is shared by work that has
// nothing in common but the provider.
const outageStatus = (err) => {
  const s = String(err ?? '')
  if (!/turn\.failed/i.test(s)) return null
  return (/unexpected status\s+([45]\d\d)\b/i.exec(s) ?? /\b([45]\d\d)\b/.exec(s))?.[1] ?? null
}
// CONSECUTIVE is load-bearing in both directions: any codex result WITHOUT the signature clears
// the run (an outage has to be happening now, not to have happened once an hour ago), and
// distinctness is by `id` — a unit id, or a role's label — so a unit whose build and its retry
// both 404 is still ONE unit's story and never trips this alone.
const CODEX_OUTAGE_RUN = 2
const codexOutage = { status: null, ids: [], tripped: false }
// True once the wave has established that CODEX ITSELF is down: the wave-start smoke failed, or
// the breaker tripped. Every codex-shaped dead end in the unit pipeline reads this and PARKS
// instead of judging — see `outagePark` below.
const codexOutaged = () => halt.codex === 'codex-unavailable' || codexOutage.tripped
// The park a codex outage earns, in the shape every other halted step already returns: back to
// `pending` with `parked:true`, no dossier, no verdict, no retry. The unit re-enters by adoption
// next wave with whatever commits are on its branch.
const outagePark = (label) => ({ status: 'pending', parked: true,
  note: `parked at ${label}: ${haltReason() ?? 'codex-unavailable'} (codex provider outage — nothing ` +
    `about this unit was judged)` })

// Degradation + spend bookkeeping shared by every codex process — build, fix and role alike. A
// dead process is not a dead unit (the branch is judged on its commits); every entry names the
// artifact dir to read. `id` names whatever the run was about (a unit id, or a role's label); a
// ROLE meta carries no `commits` (no diff base exists), so the "what survives" clause is simply
// absent there rather than guessing at zero.
const noteCodexMeta = (id, r, dir, label, phase = 'Implement') => {
  const m = r?.codex
  if (!m) return
  const survived = typeof m.commits === 'number'
    ? ` — ${m.commits > 0 ? `${m.commits} commit(s) survive and the branch is judged on its merits` : 'no commits survive'}`
    : ''
  spend.codexRuns = (spend.codexRuns ?? 0) + 1
  spend.codexInputTokens = (spend.codexInputTokens ?? 0) + (m.inputTokens ?? 0)
  spend.codexOutputTokens = (spend.codexOutputTokens ?? 0) + (m.outputTokens ?? 0)
  if (m.limitHit) {
    halt.codex = halt.codex ?? 'codex-usage-limit'
    degrade({ label, model: 'codex', phase, kind: 'codex-usage-limit',
      what: `codex reported a usage/rate limit on ${id} (${dir}) — halting new codex dispatch for this ` +
        `wave; the wave state returns intact and the arc resumes cleanly after the limit window` })
  } else if (m.timedOut) {
    degrade({ label, model: 'codex', phase, kind: 'codex-timeout',
      what: `codex run for ${id} exceeded its deadline and was killed (${dir})${loadNote()}${survived}` })
  } else if (m.exitCode !== 0) {
    // Two different facts wore one label. `-1` means the exit-code file was ABSENT when the steerer
    // reported — nobody observed the process finish, so this says something about the LIFECYCLE (a
    // killed process, or a steerer that gave up on a live run); the exit status is unknown, not bad.
    // Anything > 0 is codex itself reporting failure. One bucket made the arc's 29-row `codex-exec`
    // cluster unreadable and hid the false-death defect inside it.
    const lifecycle = m.exitCode === -1
    degrade({ label, model: 'codex', phase, kind: lifecycle ? 'codex-lifecycle' : 'codex-exec',
      what: (lifecycle
        ? `no exit-code file for ${id} (${dir}${m.error ? `; ${m.error}` : ''}) — the run was never observed ` +
          `to finish, so its exit status is unknown; the steering agent reported it dead after \`kill -0\` failed`
        : `codex exited ${m.exitCode} on ${id} (${dir}${m.error ? `; ${m.error}` : ''})`) + survived })
  }
  // The breaker, fed by every codex result there is — build, fix, verify, plan, boundary role.
  // Roles are best-effort and their failures are never unit verdicts, but they COUNT: a dead
  // backend kills an explorer exactly as readily as a build, and the census is about the provider.
  const status = outageStatus(m.error)
  if (!status) { codexOutage.status = null; codexOutage.ids = [] }
  else {
    if (codexOutage.status !== status) { codexOutage.status = status; codexOutage.ids = [] }
    if (!codexOutage.ids.includes(id)) codexOutage.ids.push(id)
    if (codexOutage.ids.length >= CODEX_OUTAGE_RUN && !codexOutage.tripped) {
      codexOutage.tripped = true
      // `??` and not `=`: a usage limit already recorded is the more specific truth and keeps the
      // slot, exactly as `haltPlatform` refuses to overwrite an outage it already declared.
      halt.codex = halt.codex ?? 'codex-unavailable'
      degrade({ label, model: 'codex', phase, kind: 'codex-unavailable',
        what: `${codexOutage.ids.length} consecutive codex runs across different units or roles failed with HTTP ` +
          `${status} (turn.failed) — a provider outage, not unit defects; dispatch halts, units park, ` +
          `relaunch after the outage. Failing ids: ${codexOutage.ids.join(', ')}.` })
    }
  }
  if (m.commits > 0 && r.notes?.includes('left uncommitted by codex'))
    degrade({ label, model: 'codex', phase, kind: 'codex-uncommitted',
      what: `codex left uncommitted work on ${id}; the steering agent committed it (${dir}) — a ` +
        `discipline signal worth watching, not a failure` })
}

/* --------------------------- the codex ROLE adapter ---------------------------
 * `const r = await run(brief, { model: 'codex', cwd, sandbox, schema, label, phase,
 *                              effort?, timeoutMin? })`
 *
 * ONE way to reach Codex from anywhere in the script. `run()` dispatches here on
 * `model:'codex'`; the caller gets back an object VALIDATED AGAINST ITS OWN `schema`, exactly as
 * a Claude agent would have returned one, or `null`.
 *
 *   brief       the task, handed to Codex verbatim. Write it for GPT, not for a Claude subagent —
 *               the adapter appends the FINAL MESSAGE section (the strict-mode rule plus the
 *               budgets it derives from `schema`), so never hand-write those.
 *   cwd         REQUIRED absolute directory Codex runs in (`-C`): a unit worktree, the integration
 *               tree, the mirror, the preview tree. Passing the operator's checkout THROWS — there
 *               is no default, because a defaulted cwd is how a read-only role edits the repo.
 *   sandbox     the ROLE's intent: 'read-only' for reviewers/explorers, 'workspace-write' for
 *               writers. `config.codexSandbox`, when set (it is by default), is the ENVIRONMENT's
 *               ruling and overrides it — exactly as in the build lane, and for the measured
 *               reason recorded on that knob: bubblewrap needs a user namespace this devcontainer
 *               cannot build, so `-s read-only` EPERMs while `workspace-write` silently enforces
 *               nothing. Where the sandbox cannot carry "change nothing", the BRIEF must.
 *   schema      the caller's own `S.*` schema. It goes to `codex exec --output-schema` (strictified
 *               — OpenAI strict mode needs every key required at every level) AND, nested under
 *               `result`, to the courier's StructuredOutput, so the platform validates what comes
 *               back instead of the harness trusting a copy.
 *   label       ledger/journal label; also names the artifact dir. Retry runs as `<label>#reattempt`.
 *   phase       the phase its degradations are filed under.
 *   effort      `model_reasoning_effort` (default `config.codexRoleEffort`).
 *   timeoutMin  deadline (default `config.codexRoleTimeoutMin`), enforced by `timeout -k` INSIDE
 *               the detached launch, so it survives the courier's death.
 *
 * FAILURE CONTRACT — the one thing wave-2 callers must handle:
 *   A codex role failure is CODEX's, never the platform's. It NEVER throws, NEVER sets
 *   `halt.platform`, and never reaches `runReq`'s outage path (both wrappers refuse `model:'codex'`
 *   loudly). The adapter reaps, retries ONCE into a fresh artifact dir, and if that also produces
 *   no result it returns `null` after appending ONE `codex-role` degradation naming the label, both
 *   dirs and what the courier said. `null` is the whole tagged failure: branch on it with a coded
 *   fallback where one is honest, or skip/quarantine where it is not — the same choice `runOr` vs
 *   `runReq` makes for Claude. A usage limit still sets `halt.codex` (one OpenAI account sits behind
 *   every run) and a halted wave short-circuits to `null` without dispatching.
 */
// Every `maxLength` in the caller's schema, keyed by the nearest NAMED field (array items inherit
// their array's name), smallest bound winning on a name collision. The adapter cannot know a
// wave-2 role's fields, so it derives the budget clause from the schema itself — which is what
// keeps every role's prompt in step with its own caps without each caller restating them.
const capBudgets = (schema, name = null, out = new Map()) => {
  if (!schema || typeof schema !== 'object') return out
  if (typeof schema.maxLength === 'number' && name)
    out.set(name, Math.min(out.get(name) ?? Infinity, schema.maxLength))
  if (schema.properties) for (const [k, v] of Object.entries(schema.properties)) capBudgets(v, k, out)
  if (schema.items) capBudgets(schema.items, name, out)
  return out
}
const budgetClause = (schema) => {
  const caps = [...capBudgets(schema)]
  return caps.length
    ? `Budgets — an over-long field is a rejected report, so cut rather than overrun: ` +
      `${caps.map(([n, m]) => `\`${n}\` at most ${m} characters`).join('; ')}. `
    : ''
}
// The FINAL MESSAGE section every role brief ends with — the role lane's CODEX_BUDGETS, derived
// from the caller's schema instead of hard-coded to S.impl's caps.
const roleFinalMessage = (schema) =>
  `\n\n# FINAL MESSAGE\n` +
  `Your final message must be ONLY a JSON object matching the output schema you were given; prose ` +
  `outside it is discarded, and every field is required — emit "" / [] / false where you have ` +
  `nothing to say. ${budgetClause(schema)}\n`
// What a role retry says about the attempt it replaces. The build lane's PRIOR_ATTEMPT talks about
// commits on a branch; a role has neither, so it gets its own two sentences and the same rule: a
// live sibling is a harness bug to report, never a run to wait on.
const PRIOR_ROLE_ATTEMPT =
  `# PRIOR ATTEMPT\n` +
  `An earlier Codex run of this exact task died and has been killed and reaped. Redo it from the ` +
  `beginning; nothing it produced is available to you. There must be no other Codex process working ` +
  `here — if you find one running, that is a HARNESS bug: stop immediately and say so in your final ` +
  `message rather than waiting for it or working alongside it.\n\n`
// The courier's report instruction: copy Codex's JSON through, or say plainly that there was none.
// The courier never judges the content and never fills a gap in it.
const roleReportInstr = (dir, schema) =>
  `Emit the structured report. If ${dir}/last-message.txt holds a parseable JSON object, set \`ok\` ` +
  `true and copy that object into \`result\` field for field, VERBATIM — never summarize, expand, ` +
  `re-order or re-word it, and never invent a field it does not have. An entry the schema cut off ` +
  `mid-sentence at its cap is still a valid entry: copy it through as-is and report ok:true — ` +
  `truncation is never a failure. If that file is absent, empty or unparseable, report \`ok\` false, ` +
  `omit \`result\` entirely, and write one sentence in \`notes\` (max 500 characters) saying what ` +
  `happened — that absence is data, not a failure to hide. ${budgetClause(schema)}`
const codexRole = async (prompt, opts) => {
  const { cwd, sandbox, schema, label, phase } = opts
  // Fail loud on a malformed call rather than improvising a default: each of these is a decision
  // only the caller can make, and the cwd default in particular is the dangerous one.
  if (!cwd || !sandbox || !schema || !label)
    throw new Error(`codex role "${label ?? '(unlabeled)'}" needs cwd, sandbox, schema and label — got ` +
      `${JSON.stringify({ cwd: !!cwd, sandbox: !!sandbox, schema: !!schema, label: !!label })}`)
  if (cwd === repo)
    throw new Error(`codex role "${label}" was pointed at the operator's checkout (${repo}). Roles run in a ` +
      `worktree, the mirror or the preview tree — never in the repo root.`)
  const dir = codexDir('roles', label.replace(/[^A-Za-z0-9_.-]+/g, '-'))
  const retryDir = `${dir}-retry`
  const briefText = `${prompt}${roleFinalMessage(schema)}`
  const outSchema = JSON.stringify(strictify(schema))
  // "Usable" is the retry trigger and the return test alike: an `ok` with no `result` is a courier
  // that contradicted itself, and it buys the same second attempt a dead process does.
  const usable = (x) => !!x?.ok && !!x.result
  const attempt = (at, brief, reapDir, l) => withCodexSlot(async () => {
    spend.codex++
    const r = await runOr(null, steerCodex({
      id: label, subject: `role ${label}`, w: cwd, dir: at, briefText: brief, sandbox: C.codexSandbox ?? sandbox,
      effort: opts.effort ?? C.codexRoleEffort, timeoutMin: opts.timeoutMin ?? C.codexRoleTimeoutMin,
      gitTruth: false, reapDir, outSchema, reportInstr: roleReportInstr(at, schema),
    }), { model: C.codexSteerModel, effort: 'low', phase, label: l, schema: codexRoleReport(schema) })
    noteCodexMeta(label, r, at, l, phase)
    return r
  })
  const noResult = (why) => {
    degrade({ label, model: 'codex', phase, kind: 'codex-role',
      what: `codex role ${label} produced no result (${why}) — its caller sees null. This is a CODEX ` +
        `failure, never a Claude platform outage: nothing is halted on account of it.` })
    return null
  }
  if (haltReason()) return noResult(`dispatch is halted (${haltReason()}), so it was never launched`)
  let r = await attempt(dir, briefText, null, label)
  // One reattempt, reaping the dead pid first — the build lane's rule for the build lane's reason:
  // this branch is reached by a genuine death and by a courier that only believed one, and two
  // codex processes on one tree is not a state to reason about. Never past a halt (a usage limit
  // observed on the first attempt lands here as halt.codex).
  if (!usable(r) && !haltReason()) r = await attempt(retryDir, `${PRIOR_ROLE_ATTEMPT}${briefText}`, dir, `${label}#reattempt`)
  if (usable(r)) return r.result
  return noResult(`${dir}, then ${retryDir}; ${String(r?.notes ?? 'no courier report').slice(0, 160)}`)
}
// Dead on arrival with nothing on the branch: worth exactly one more attempt. Never on a lost
// report (the branch may hold work nobody described), never past a halt, never on a usage limit.
const worthRetry = (r) =>
  !r.reportLost && r.codex && r.codex.exitCode !== 0 && r.codex.commits === 0 && !r.codex.limitHit && !haltReason()
// One codex build step = the unit's whole implement→test→fix inner loop. Parks (never
// quarantines) when dispatch is halted; retries ONCE fresh when a run dies with no
// commits; past that the normal pipeline (verify → gates) judges whatever is on the branch.
async function buildStep(unit, w, base, implPlan) {
  if (haltReason()) return { parked: true }
  const dir = codexDir(unit.id, 'build')
  const briefText = codexBuildBrief(unit, w, dir, base, implPlan)
  const opts = (label) => ({ model: C.codexSteerModel, effort: 'low', phase: 'Implement', label, schema: S.implCodex })
  let r = await withCodexSlot(() => runOr(REPORT_LOST,
    steerCodex({ id: unit.id, w, dir, base, briefText, effort: C.codexEffort, timeoutMin: C.codexTimeoutMin }),
    opts(`codex-build:${unit.id}`)))
  noteCodexMeta(unit.id, r, dir, `codex-build:${unit.id}`)
  if (worthRetry(r)) {
    // The retry REAPS the previous pid before it launches (reapDir) and says so in its brief
    // (PRIOR_ATTEMPT). Both are unconditional: this branch is reached by a genuine death and by a
    // steerer that only believed one, and the second case is how two codex processes ended up in
    // one worktree (2026-08-23). Then the commit-probe/quarantine path in runUnit rules. Never a
    // Claude implementer — there is no Claude lane.
    const dir2 = codexDir(unit.id, 'build-retry')
    r = await withCodexSlot(() => runOr(REPORT_LOST,
      steerCodex({ id: unit.id, w, dir: dir2, base, briefText: codexBuildBrief(unit, w, dir2, base, implPlan, PRIOR_ATTEMPT),
        effort: C.codexEffort, timeoutMin: C.codexTimeoutMin, reapDir: dir }),
      opts(`codex-build-retry:${unit.id}`)))
    noteCodexMeta(unit.id, r, dir2, `codex-build-retry:${unit.id}`)
  }
  return r
}
// One codex fix step: resume the unit's build session in place when it matches this worktree
// (cwd rule — resuming into a different tree edits the wrong checkout), else run fresh with the
// self-contained fix brief. `payload` carries the verbatim repairs (verify failures, gate
// directives, or an architect ruling).
async function fixStep(unit, w, base, envelope, { step, label, fresh = false }, payload) {
  if (haltReason()) return { parked: true }
  const dir = codexDir(unit.id, step)
  const briefText = codexFixBrief(unit, w, base, envelope, payload)
  // `fresh` skips the resume: a session that has already failed a gate twice is anchored on its
  // own approach (the resumed-session-bias finding) — the last attempt starts cold, carrying the
  // full directive set in the self-contained brief instead of the session's history.
  const opts = (l) => ({ model: C.codexSteerModel, effort: 'low', phase: 'Fix', label: l, schema: S.implCodex })
  const resumeDir = fresh ? null : codexDir(unit.id, 'build')
  let r = await withCodexSlot(() => runOr(REPORT_LOST,
    steerCodex({ id: unit.id, w, dir, base, briefText, effort: C.codexFixEffort, timeoutMin: C.codexFixTimeoutMin, resumeDir }),
    opts(label)))
  noteCodexMeta(unit.id, r, dir, label, 'Fix')
  // The same one-shot retry the build step gets, for the same reason: a fix round that died with
  // nothing on the branch used to fall straight through to a re-verify that could only fail, and
  // the `codex-gate-fix`/`codex-gap-fix` rows in one arc's ledger produced no recovery at all.
  // Reaps this round's own pid first — the round it resumes from is a different, finished dir.
  // `#reattempt`, not `#retry`: run()'s schema retry already owns `#retry`, and two different
  // recoveries under one label make the degradation ledger unreadable.
  if (worthRetry(r)) {
    const dir2 = codexDir(unit.id, `${step}-retry`)
    r = await withCodexSlot(() => runOr(REPORT_LOST,
      steerCodex({ id: unit.id, w, dir: dir2, base, briefText: `${PRIOR_ATTEMPT}${briefText}`,
        effort: C.codexFixEffort, timeoutMin: C.codexFixTimeoutMin, resumeDir, reapDir: dir }),
      opts(`${label}#reattempt`)))
    noteCodexMeta(unit.id, r, dir2, `${label}#reattempt`, 'Fix')
  }
  return r
}
async function runUnit(unit) {
  setStage(unit.id, 'setup')   // status became 'running' in start() before this call
  // Merged is settled by GIT, in code, before anything else touches this unit. The setup agent
  // has its own already-merged case, but it is an agent report and therefore cache-replayable:
  // on a resume it replayed a pre-merge `state:'ready'` and drove a landed unit back through
  // build/verify/quarantine (2026-08-25). This probe is salted, so it cannot be replayed.
  const g0 = await mergedInGit(unit)
  if (g0.merged) {
    log(`${unit.id}: already merged in git (${g0.branchSha.slice(0, 7)}) — no dispatch`)
    return { status: 'merged', branch: `unit/${unit.id}`, mergedAt: g0.branchSha, note: 'git says merged at dispatch' }
  }
  const spec = specOf(unit)
  const w = wtOf(unit)
  const base = integrationTip   // diff base: the freshest integrated tip we know
  // unit.existingBranch adopts pre-written work (a hand-authored branch, or an eval
  // fixture): skip plan/implement and run it through the same verify → review → gate.
  const source = unit.existingBranch ?? base
  // Adoption intent — read from the ORIGINAL prior.units, not the live map (start() overwrote
  // the record with {status:'running'} before us). A unit that was 'running' in the last
  // checkpoint crashed mid-flight, so committed work on its branch is its own prior progress.
  // `blocked` is in the list for the same reason `running` is: a unit blocked because its verify
  // never ran, or because its verification TOOLING could not run, keeps every commit it made and
  // re-enters dispatch next wave. Without adoption those commits read as un-adopted work beyond
  // base and the unit would quarantine on 'has-commits' — the exact verdict blocking exists to
  // avoid. (A dependency-blocked unit has no commits at all, so it takes the fresh path anyway.)
  const adopt = !!unit.existingBranch ||
    ['running', 'merge-ready', 'blocked'].includes(prior.units?.[unit.id]?.status) ||
    !!prior.units?.[unit.id]?.parked   // parked mid-pipeline (any halt): its commits are its own progress

  // H-7: implementer-reported deviation from a frozen surface. `mismatch` is consumable
  // (one consult per report, respecting the consult budget); `mismatchEver` sticks — carrying
  // the latest report's text — forces the Fable exit gate and feeds its prompt. Banked into
  // the wave ledger so boundary triage sees it even when the unit merges.
  let mismatch = null
  let mismatchEver = null
  // The pinned scope envelope (see SCOPE): the plan's `files` for a fresh build, the link's
  // planned files for a warm-lane entry, the diff-at-entry for an adopted branch (pinned at the
  // first verify). Computed once, NEVER recomputed from the live diff — pinning is the whole
  // anti-spiral mechanism. `scopeGrew` is the latest verify's files beyond the envelope; it is
  // recorded loudly once and handed to the exit gates to adjudicate (necessary vs creep), never
  // used to license further fixing.
  let envelope = null
  let scopeGrew = []
  // Every file this unit has EVER reached outside its envelope. The re-emit guard used to be set
  // equality, so a unit that added one more file on the next fix round degraded a second time for
  // the same incident (arc-observed: 22 `scope-growth` rows, ~15 real incidents). Superset-aware:
  // only a genuinely new file re-degrades.
  const scopeGrewSeen = new Set()
  // A `blocked` verify is a verdict about the ENVIRONMENT, never about the unit, and the host's
  // load is the fact that most often explains one — recorded beside the outcome so it is auditable.
  // Still deliberately distinct from `verifyUnrun` below: `blocked:true` is a verifier that RAN and
  // found the tooling broken (a fact about this checkout), while a null verify is a dead codex role
  // (a fact about CODEX). What they now share is the refusal to convert either into a unit verdict.
  //
  // The outcome is graduated, because tooling that cannot run is only this unit's problem if it is
  // this unit's alone:
  //   first blocked verify   -> BLOCKED. Commits intact, no dossier, no fix rounds; the wave-start
  //                             loop re-opens a blocked unit whose blocker is gone, so it is
  //                             re-dispatched and re-verified next wave and judged then.
  //   blocked again          -> not transient for this unit: quarantine, with the reason it always
  //                             had. `rounds.verifyBlocked` is the tally, carried across waves in
  //                             start() precisely so this is countable.
  //   two units, one wave    -> a HOST fact, not two unit defects: halt (`env-verify-blocked`), so
  //                             nothing new dispatches and everything in flight parks.
  // Arc-observed 2026-09-04: `pnpm audit --audit-level high` inside `pnpm verify` hung on a
  // black-holed registry POST and the FIRST unit to hit it was quarantined for the host's fault.
  const envBlocked = (label, v) => {
    verifyBlockedUnits.add(unit.id)
    // `!halt.env` both keeps an already-set env halt (the preflight's) and makes the row fire once.
    if (verifyBlockedUnits.size >= 2 && !halt.env) {
      halt.env = 'env-verify-blocked'
      degrade({ label, model: 'haiku', phase: 'Verify', kind: 'env-verify-blocked',
        what: `two units' verification tooling could not run in one wave (${[...verifyBlockedUnits].join(', ')})` +
          `${loadNote(v)} — that is a host fact (a registry or network black hole, a missing global tool), not two ` +
          `unit defects, so the wave halts and every unit parks with its commits. Operator: read the verifiers' ` +
          `failure output, fix the host, relaunch` })
    }
    bumpRound(unit.id, 'verifyBlocked')
    const blockedRounds = rec(unit.id)?.rounds?.verifyBlocked ?? 1
    const first = String(v?.failures?.[0] ?? '').slice(0, 300)
    const firstNote = first ? ` First failure: ${first}` : ''
    // A halt is never a verdict, so a wave halted by the shared case above blocks this unit too,
    // whatever its own tally says — the operator fixes the host, and the unit is judged next wave.
    if (blockedRounds >= 2 && !haltReason()) {
      degrade({ label, model: 'haiku', phase: 'Verify', kind: 'verify-blocked',
        what: `verification tooling could not run for ${unit.id} on ${blockedRounds} separate waves${loadNote(v)} — ` +
          `quarantined as an environment failure, not a unit defect; fix provisioning, not the spec.${firstNote}` })
      return quarantine(unit, 'environment/tooling blocked verification — fix provisioning, not the spec', v)
    }
    degrade({ label, model: 'haiku', phase: 'Verify', kind: 'verify-blocked',
      what: `verification tooling could not run for ${unit.id}${loadNote(v)} — the unit is BLOCKED, not ` +
        `quarantined: nothing about it was judged, its commits are intact, and it is re-verified next wave. ` +
        `Fix provisioning, not the spec.${firstNote}` })
    return { status: 'blocked', branch: `unit/${unit.id}`, note: `verification tooling could not run (${label})` }
  }
  // A lost report is a hole in the evidence, not just a hiccup: the unit's `debt` entries and any
  // `contractMismatch` trigger went down with it, so the cheap Opus gate would be adjudicating a
  // diff nobody described. Sticky, and forces the frontier gate — the same compensation
  // mismatchEver makes, for the same reason (missing signal, high stakes).
  let reportLostEver = false
  // 10a pull-channel state: `gap` is consumable (one consult per report), `gapEver` sticks.
  // An unconsulted gap (budget spent) forces the Fable exit gate — an unadjudicated
  // spec-silence decision is exactly the missing-signal/high-stakes case mismatchEver covers.
  let gap = null
  let gapEver = null
  let gapConsulted = false
  // Codex emits the two-character string `""` when it means "nothing to report" (arc-observed) —
  // truthy, so it fires the trigger with an empty payload and banks a bogus major debt entry.
  // A trigger whose content is empty once quote characters are stripped IS an empty trigger.
  const triggerText = (v) => (typeof v === 'string' ? v.replace(/^["'\s]+|["'\s]+$/g, '') : '')
  const noteGap = (r) => {
    if (!triggerText(r?.specGap) || r.reportLost) return
    gap = triggerText(r.specGap)
    gapEver = gap
  }
  // A contract mismatch banked from a report about work that has ALREADY landed is a ghost: on a
  // resume the cached report replays verbatim, and `kind:'contract'` debt is what forces a
  // contract-amendment return to the root (arc-observed: a resolved mismatch dragged the whole run
  // back for an amendment nobody needed). The record keeps it, stamped `rebanked`, and the
  // conductor's filter requires a non-rebanked item.
  const alreadyLanded = () =>
    ['merge-ready', 'merged'].includes(prior.units?.[unit.id]?.status) || rec(unit.id)?.status === 'merged'
  const noteMismatch = (r) => {
    if (!triggerText(r?.contractMismatch)) return
    mismatch = triggerText(r.contractMismatch)
    mismatchEver = mismatch
    addDebt(unit.id, base, [{
      what: `implementer-reported contract mismatch: ${mismatch}`,
      why: 'frozen surface contradicts reality — needs architect adjudication',
    }], { kind: 'contract', severity: 'major', ...(alreadyLanded() ? { rebanked: true } : {}) })
  }
  // No debt-fix sweep in the codex lane: the brief's SCOPE already demands in-scope fixing
  // before the run reports done, and out-of-scope confessions BANK by design (DEBT_DISCIPLINE) —
  // a sweep round would be an invitation to widen the diff, the exact spiral clause it once was.

  // The sha assertion below must never trust the SAME agent that could have recreated the branch
  // (arc-observed: a setup agent deleted its own source branch and recreated it from main). One
  // read-only command, and `required` — an absent answer here would be an invented verdict about
  // a unit, so a dead courier halts the wave rather than blaming the plan.
  let adoptTip = null
  if (unit.existingBranch) {
    const rp = await courierRun(repo, [`git rev-parse ${unit.existingBranch}^{commit}`],
      { model: 'haiku', effort: 'low', phase: 'Setup', label: `adopt-tip:${unit.id}`, required: true },
      `This command only READS. ` + LAUNCH)
    if (!rp.ok || !/^[0-9a-f]{7,40}$/.test(rp.out(0)))
      return quarantine(unit, `existingBranch ${unit.existingBranch} does not resolve — fix the plan; nothing was touched`,
        { detail: rp.detail, out: rp.out(0) })
    adoptTip = rp.out(0)
  }

  // WHICH CASE this unit is in used to be the setup agent's to choose, from four cases written as
  // prose. In wf_c6971376-1a5 that agent forked `consolidate-stats-gcd` from the fixture repo's
  // `main` HEAD after deciding — from `git branch -a`, `git cat-file -t` and a `--oneline | grep`
  // of an 8-character sha, every one of them run in the ORCHESTRATOR'S OWN checkout because it had
  // dropped the cd — that the base sha it was handed "does not exist in repository". The sha
  // existed; another agent had read it off the integration worktree two minutes earlier. It then
  // reported `ok:false` alongside `state:'ready'` and a sha from the wrong history.
  //
  // So: the case is chosen HERE from git's own exit codes, the ONE command that case calls for is
  // composed HERE, and the base and branch are read back OUT OF THE WORKTREE by the script. Nothing
  // about which repository, which base or which case is left to a model.
  //
  // `g0` (mergedInGit, salted, run at the top of this function) already answered "does the branch
  // exist", "did it land through one of our merges" and "is the worktree directory there". Only the
  // commit count is missing, and only when the branch exists at all — so the common fresh path
  // spends no extra call.
  let ahead = 0
  if (g0.branchSha) {
    const a = await gitProbe(`setup-commits:${unit.id}`, repo, [`git rev-list --count ${base}..unit/${unit.id}`], 'Setup')
    if (a.code(0) !== 0)
      return quarantine(unit, `could not count unit/${unit.id}'s commits beyond ${String(base).slice(0, 12)} — the ` +
        `branch state is unknown and nothing was touched`, a.raw)
    ahead = Number(a.line(0)) || 0
  }
  // Case 2 counts against `base`, not `source`: under self-adoption (existingBranch = the unit's
  // own branch) source..branch is always empty, and the fresh path would delete the work adoption
  // preserves. ('already-merged' is not a case here at all: g0 short-circuited it above, in code.)
  const state = !g0.branchSha || ahead === 0 ? 'ready' : adopt ? 'adopted' : 'has-commits'
  // Un-adopted commits beyond base: nothing was destroyed — surface for a deliberate decision.
  if (state === 'has-commits')
    return quarantine(unit, `branch unit/${unit.id} has commits beyond its base and was not adopted — nothing was ` +
      `destroyed; adopt via unit.existingBranch on relaunch, or delete the branch deliberately`,
      { branchSha: g0.branchSha, ahead })
  // ONE composed command, so crash re-entry never becomes a choice: `test -d … && … || …` is the
  // "if the worktree is already there, keep it; else add it" branch, decided by the shell.
  const live = `test -d '${w}' && git -C '${w}' rev-parse --git-dir >/dev/null 2>&1`
  const dropWt = `git worktree remove --force '${w}' 2>/dev/null; git worktree prune`
  const create = state === 'adopted'
    // The BRANCH is never touched — only the worktree pointing at it. No -b, no reset.
    ? `${live} || { ${dropWt}; git worktree add '${w}' unit/${unit.id}; }`
    : g0.branchSha
      // A branch with nothing beyond base holds no work, so the stale remnant is cleared and the
      // fork redone. This is the only place a unit branch is ever deleted, and only when git has
      // just said it has zero commits of its own.
      ? `${dropWt}; git branch -D unit/${unit.id} >/dev/null 2>&1; git worktree add -b unit/${unit.id} '${w}' ${source}`
      : `${live} || git worktree add -b unit/${unit.id} '${w}' ${source}`
  // The adopt-tip invariant is SCOPED BY CASE, and the re-entry half needs a fact only the
  // worktree can answer, so it rides this same list. At the initial fork the worktree was just
  // created from existingBranch, so HEAD must BE that tip (checked in code below, no command
  // needed). On RE-ENTRY of an adopted unit the worktree is checked out on unit/<id>, whose tip
  // legitimately moves the moment a fix round commits — so what still has to hold is ANCESTRY:
  // the pre-captured existingBranch tip is reachable from HEAD. A recreated or force-moved
  // existingBranch is not an ancestor and still quarantines. `; echo $?` for the same reason the
  // integration-worktree probe uses it: a legitimate answer of 1 is not a courier failure, so the
  // exit code is printed by the SHELL and kept off the stop-at-first-failure path.
  const ancestryAt = adoptTip && state === 'adopted' ? 3 : -1
  const ws = await courierRun(repo, [
    create,
    `git -C '${w}' rev-parse HEAD`,
    `git -C '${w}' rev-parse --abbrev-ref HEAD`,
    ...(ancestryAt < 0 ? [] : [`git -C '${w}' merge-base --is-ancestor ${adoptTip} HEAD; echo $?`]),
  ], { model: 'haiku', phase: 'Setup', label: `setup:${unit.id}` },
  `The first command sets up the worktree for unit ${unit.id}; the others report back what it ` +
  `actually is. Never substitute a different base, a different branch or a different repository ` +
  `for the ones written here, and never "repair" a failing command — its failure is the answer. ` +
  // Setup is normally worth replaying from cache — it is idempotent and its report is a fact
  // about a directory that still exists. When the probe says that directory is GONE (a rebuilt
  // host, a pruned worktree root), the cached report describes a world that no longer exists, so
  // this one call is salted back into a cache miss. Deliberately conditional: blanket-salting
  // setup would re-run every unit's worktree creation on every resume (and the shas the commands
  // carry already self-salt it whenever the tip moves).
  (g0.worktree ? '' : LAUNCH))
  const wsSha = ws.out(1)
  const wsBranch = ws.out(2)
  const wsExtra = { detail: ws.detail, sha: wsSha, branch: wsBranch, state }
  if (!ws.ok)
    return quarantine(unit, `workspace setup failed: ${ws.detail}`, wsExtra)
  // The branch NAME is a read-back too, not an assumption: the live failure produced a worktree on
  // the right branch name over the wrong history, and a variant of it produces the reverse.
  if (wsBranch !== `unit/${unit.id}`)
    return quarantine(unit, `the worktree at ${w} is on branch ${wsBranch || 'nothing'}, not unit/${unit.id}`, wsExtra)
  // A fresh 'ready' worktree must sit exactly on the expected base unless forked from an explicit
  // existingBranch (an eval fixture legitimately differs); an adopted branch legitimately diverges,
  // so the assertion is 'ready'-only.
  if (state === 'ready' && !unit.existingBranch && !sameSha(wsSha, base))
    return quarantine(unit, `workspace setup failed or wrong base (got ${wsSha || 'nothing'}, expected ${source})`, wsExtra)
  // Adopt-tip, the fork half: a worktree just created FROM existingBranch must be exactly its tip.
  if (adoptTip && ancestryAt < 0 && !sameSha(wsSha, adoptTip))
    return quarantine(unit, `adopt tip mismatch (got ${wsSha || 'nothing'}, forked from pre-captured ` +
      `${unit.existingBranch} = ${adoptTip}) — the branch may have been recreated; check reflog / git fsck --unreachable`,
      wsExtra)
  // …and the re-entry half: unit/<id> may have grown commits (a fix round that landed before the
  // wave was parked — wf_ec56ce3b-59f quarantined exactly that), but it must still CONTAIN the
  // pre-captured tip. Exit 0 = ancestor; 1 = diverged; 128 = unresolvable; anything unparseable is
  // read as "not an ancestor", which refuses rather than waves through.
  if (ancestryAt >= 0 && ws.out(ancestryAt) !== '0')
    return quarantine(unit, `adopt tip mismatch (unit/${unit.id} is at ${wsSha || 'nothing'}, which does not ` +
      `contain pre-captured ${unit.existingBranch} = ${adoptTip}; \`merge-base --is-ancestor\` exited ` +
      `${ws.out(ancestryAt) || 'nothing'}) — the branch may have been recreated or force-moved; check reflog / ` +
      `git fsck --unreachable`, wsExtra)
  if (issueMode) await ghUnitRunning(unit)
  const prov = await provision(w, `provision:${unit.id}`)
  if (!prov.ok)
    return quarantine(unit, `environment provisioning failed — fix tooling/provision config, not the spec: ${prov.detail}`, prov)

  if (!unit.existingBranch && state !== 'adopted') {
  setStage(unit.id, 'plan')
  // Plan first, then the architect plan-check — wrong approaches die before code exists.
  // The IMPLEMENTER plans its own work (0.14.0): the same model family that will build this unit
  // reads the spec, the contracts and the tree itself and produces the plan. Claude's judgment on
  // it is unchanged and is still the point — the Opus/Fable plan-check below is what a plan has to
  // survive, and a self-planned unit is exactly why that check interrogates the SPEC as hard as
  // the plan. Nothing is pasted in here that a shell can read: the brief names paths.
  let implPlan = await run(
    `# GOAL\nPlan one unit of a larger roadmap, then hand the plan over. You are not writing code in this ` +
    `run: an architect reviews the plan first, and only an approved plan is built.\n\n` +
    `# CONTEXT (read these — do not guess at them)\n` +
    `- The unit spec at ${spec} is authoritative.\n` +
    `- Contract files it references live under ${repo}/.roadmap/contracts/ and are frozen — immutable ` +
    `requirements, never something to plan around amending.\n` +
    `- Codebase conventions and build/test commands are documented at ${brief}.\n` +
    `- The code is in front of you at ${w}; explore as much of it as you need.\n` +
    `${convClause}${designClause(unit)}${unit.design?.length ? 'Confirm each cited design source ' + 'actually exists in this worktree; if one is missing, set feasible:false and name it — building a designed ' + 'screen without its comp is how screens get reinvented. ' : ''}\n\n` +
    `# CONSTRAINTS\nRead-only. Write no code, create no files, run no build, make no commit — this run produces ` +
    `a plan and nothing else.\n\n` +
    `# METHOD\nThe engineer who builds this works from your plan and CANNOT ask you anything — everything it ` +
    `needs must be in the plan or in the spec. Before you finish, ask what an implementer would have to ask ` +
    `you, and answer it here. A question with a look-up-able answer is yours to resolve now, by reading; a ` +
    `question that is a genuine unsettled DECISION is a spec defect — set \`feasible\`:false and name it in ` +
    `\`approach\`. If the spec cannot be satisfied within its contracts, do not force it: set ` +
    `\`feasible\`:false and explain the contradiction in \`approach\`.\n\n` +
    `# REPORT\n\`feasible\` (boolean). \`files\` — the file paths the implementer may touch; this list ` +
    `becomes its BINDING scope, so an omission forces the work out of scope: err complete, not broad. ` +
    `\`testPlan\` — the specific seams its tests hook into (as few as possible, one is ideal) and the exact ` +
    `command that runs them. \`approach\` — your approach. \`evidence\` — the context manifest your ` +
    `exploration already earned, so the implementer starts from it instead of re-exploring and the reviewer ` +
    `gets its file list as a reading list: \`keyFiles\` (at most 20, one line each: path plus a one-phrase ` +
    `why), \`signatures\` (at most 15, each one line: an exact signature/type the work builds against, ` +
    `quoted), \`seams\` (at most 10, each a sentence or two: where the change hooks in, with a short quoted ` +
    `anchor). Emit each as a real JSON field — never fold files/testPlan into the approach prose.`,
    { model: 'codex', cwd: w, sandbox: 'read-only', schema: S.plan,
      phase: 'Implement', label: `plan:${unit.id}` })
  // No honest coded stand-in for a missing plan: a fabricated plan is a verdict about the unit
  // invented out of an infrastructure failure. Same answer as the dead plan-check below — the
  // unit does not get built, and the dossier says infrastructure rather than blaming the spec.
  // Never a platform halt: a dead codex role is CODEX's failure (the adapter has already ledgered
  // it) and the rest of the wave's Claude pipeline is unaffected.
  // …unless CODEX ITSELF is down, in which case "the planner died twice" is the outage saying so
  // twice and not a fact about this unit at all. 2026-09-03: a 404'd backend quarantined a unit on
  // exactly this line. Park instead — no dossier, no verdict, re-entry by adoption next wave.
  if (!implPlan && codexOutaged()) return outagePark(`plan:${unit.id}`)
  if (!implPlan)
    return quarantine(unit, 'no implementation plan was produced (the codex planner died twice) — ' +
      'infrastructure, not the spec; relaunch to retry', { role: `plan:${unit.id}` })

  // Plan-check — Opus-first: every eligible unit still gets a check (wrong approaches die
  // before code exists), but only structural calls (high risk, claimed-infeasible, or the
  // always-fable policy) pay the Fable architect up front. Everything else gets a free Opus
  // plan-check that escalates to Fable only when the call turns frontier.
  if (C.planCheckRisk.includes(unit.risk) || !implPlan.feasible) {
    const critique = await specCritique(unit, w, implPlan)
    const check = await runPlanCheck(unit, implPlan, spec, { critique })
    // An agent that DIED returns null (API error, safeguard refusal, retry exhaustion), and reading
    // `.verdict` off it took the whole unit pipeline down with a TypeError — arc-observed when a
    // plan-check tripped a provider safeguard. A missing verdict is an infrastructure failure, not
    // a plan defect: quarantine with that said plainly rather than blaming the unit.
    if (!check?.verdict)
      return quarantine(unit, 'plan-check produced no verdict (agent died or was refused) — infrastructure, not the plan', check)
    if (check.verdict === 'quarantine') return quarantine(unit, 'plan rejected by architect', check)
    if (check.verdict === 'redirect') {
      // The plan-check is an ADJUDICATION path too — its charter explicitly lets it name the
      // resolution of a spec contradiction, including a decision the spec marked escalate-only.
      // It must therefore write to the same ledger the escalation ladder does. Arc-observed
      // (horizon fixture, run 3): a plan-check legitimately resolved a named open decision, the
      // build brief cited "the architect ruled", twelve modules were pinned to it — and the exit
      // gate, reading an EMPTY escalations ledger, correctly judged the ruling fabricated and
      // demanded an escalation that had already happened. The unit quarantined with its retry
      // budget spent. Two adjudication paths and one ledger is the defect; the gate was right.
      escalate({ unit: unit.id, stop: 0, tier: 'decided', boundary: 'none',
        by: 'plan-check', gap: `plan-check redirect: ${check.guidance}` })
      // And the ruling lands in the spec for the same reason a tier-1 ladder ruling does: the
      // prompt that carried it does not outlive the session, but every later reader — review,
      // gate, the next unit — reads the spec.
      await run(
        STRICT +
        `In the git repository at ${repo}: append to the spec file ${spec} — do not modify anything already ` +
        `in it. Add a section titled ` +
        `"## Adjudicated during implementation" if it is not already present, then one bullet recording ` +
        `this ruling verbatim: the architect redirected the plan for unit ${unit.id} with "${check.guidance}". ` +
        `Report ok.`,
        { model: 'haiku', effort: 'low', phase: 'Escalate', label: `spec-append:${unit.id}#plan`, schema: S.ok })
      implPlan = await run(
        `# GOAL\nRevise your implementation plan for unit ${unit.id} (spec: ${spec}; contracts under ` +
        `${repo}/.roadmap/contracts/; the code is at ${w}).\n\n` +
        `# THE ARCHITECT'S DIRECTION\n${check.guidance}\n\n` +
        `# YOUR PREVIOUS PLAN\n${JSON.stringify(implPlan)}\n\n` +
        `# CONSTRAINTS\nRead-only. Write no code, create no files, make no commit — this run produces a ` +
        `revised plan and nothing else. The direction is a ruling, not a suggestion: apply it, or set ` +
        `\`feasible\`:false and say in \`approach\` why it cannot be applied.\n\n` +
        `# REPORT\nAll four required fields again — \`feasible\`, \`files\`, \`testPlan\`, \`approach\` — ` +
        `and refresh the \`evidence\` manifest (keyFiles one line each, signatures one line each, seams a ` +
        `sentence or two each) wherever the direction changes it.`,
        { model: 'codex', cwd: w, sandbox: 'read-only', schema: S.plan,
          phase: 'Implement', label: `replan:${unit.id}` })
      // The architect redirected and the revision never came back. Building the plan the architect
      // just rejected is the one thing that must not happen here.
      if (!implPlan && codexOutaged()) return outagePark(`replan:${unit.id}`)
      if (!implPlan)
        return quarantine(unit, 'the architect redirected the plan and the revision never came back (the codex ' +
          'planner died twice) — infrastructure, not the plan; relaunch to retry', check)
    }
  }
  // Never hand an infeasible plan to an implementer — there is no honest way to execute it.
  if (!implPlan.feasible)
    return quarantine(unit, 'spec unsatisfiable at planning (architect-confirmed) — needs respec, not retry', implPlan)
  envelope = implPlan.files?.length ? [...implPlan.files] : null

  setStage(unit.id, 'implement')
  const impl = await buildStep(unit, w, base, implPlan)
  // Dispatch halted (a codex probe failure, a usage limit, a sick host, a dead platform): PARK,
  // don't judge. The unit re-enters by adoption next wave with whatever commits exist.
  if (impl.parked) return { status: 'pending', parked: true, note: `parked before implement: ${haltReason()}` }
  // The build RAN and the backend was dead under it — either this unit's own run carries the
  // outage signature, or a sibling's did and tripped the breaker while this one was in flight
  // (in which case `worthRetry`'s `!haltReason()` has already skipped its retry, so what came
  // back is a single dead run). Park on the same terms as the entry-time halt above: the commit
  // probe below decides between "judge the branch" and "nothing was built", and neither of those
  // is an answerable question while the provider is down.
  if (codexOutaged() && (impl.reportLost || outageStatus(impl.codex?.error)))
    return outagePark(`implement:${unit.id}`)
  // The report died. Ask the branch whether the WORK died with it: commits present means the
  // implementer finished and only its report was lost, so the diff must be judged on its merits by
  // the normal verify -> review -> gate path. No commits means nothing was built, and quarantine is
  // still the right answer. Getting this backwards is what cost two units and two hand-rescues.
  if (impl.reportLost) {
    // `unknown` is the fallback, NOT `ok:false`: a dead probe used to read as "no commits", and a
    // branch with every milestone committed was quarantined as "nothing was built" during a quota
    // outage (2026-08-25). Absence of an answer is not the answer. This one parks the unit instead
    // of halting the wave the way runReq would — a single cheap probe dying twice while the rest of
    // the wave runs is not evidence of a platform outage, and the unit's commits are safe either
    // way: it re-enters by adoption next wave and is judged then.
    // "Is there work on this branch?" was a QUESTION put to a model ("report ok:true if the count
    // is greater than zero"). It is two read-only commands and a comparison the script makes.
    const cp = await courierRun(w, [`git rev-list --count ${base}..HEAD`, 'git rev-parse HEAD'],
      { model: 'haiku', effort: 'low', phase: 'Implement', label: `commit-probe:${unit.id}` },
      `These commands only READ. Change nothing. ` + LAUNCH)
    const commits = cp.exit(0) === 0 && /^\d+$/.test(cp.out(0)) ? Number(cp.out(0)) : null
    // A dead or unreadable probe is `unknown`, never "no commits" — absence of an answer is not
    // the answer, and the difference decides between a park and a quarantine.
    const probe = { unknown: commits === null, ok: commits !== null && commits > 0,
      sha: cp.out(1), detail: cp.detail }
    if (probe.unknown) {
      degrade({ label: `commit-probe:${unit.id}`, model: 'haiku', phase: 'Implement', kind: 'commit-probe-unknown',
        what: `the implement report for ${unit.id} was lost AND the commit probe died — whether the branch holds ` +
          `work is unknown, so the unit PARKS with its branch intact rather than being quarantined for having ` +
          `built nothing. It re-enters by adoption next wave, when the probe can be asked again.` })
      return { status: 'pending', parked: true, note: 'parked: implement report lost and the commit probe never answered' }
    }
    if (!probe.ok) {
      // Nothing was built, so quarantine is right — but runOr swallowed whatever actually went
      // wrong into the degradation ledger, and a dossier that says only "no commit" sends the next
      // reader hunting. Carry the real cause into the reason.
      const why = degradations.filter((d) => typeof d.label === 'string' &&
        (d.label === `codex-build:${unit.id}` || d.label === `codex-build-retry:${unit.id}`))
        .map((d) => d.what).join(' | ')
      return quarantine(unit,
        `implementer produced neither a report nor a commit — nothing was built${why ? ` (${why})` : ''}`, probe)
    }
    reportLostEver = true
    log(`${unit.id}: implement report lost but ${probe.sha?.slice(0, 7) ?? 'work'} is committed — judging the branch`)
  }
  noteMismatch(impl)
  noteGap(impl)
  // Confessed debt banks directly: the brief's SCOPE already demanded in-scope fixing before
  // reporting done, so what remains is out-of-scope by declaration — ledger, not fix round.
  if (!impl.reportLost) addDebt(unit.id, base, impl.debt)
  } // end fresh-build block — existingBranch and adopted (crash-recovered) branches enter the pipeline here

  // Mechanical polish loop: verify → codex fix, bounded. There is deliberately NO review stage
  // INSIDE it: Codex's build already ran its own implement→test→fix loop, and a review that can
  // issue directives here is a free pass widening the diff the exit gate re-reads with authority
  // anyway (the spiral's third clause). The gates carry the hunting clauses (FINDING_BAR); this
  // loop fixes only what the mechanical verify can prove failing. The cross-model review added in
  // 0.14.0 sits AFTER this loop and before the gate, issues no directives at all, and reports to
  // the gate rather than to a fixer — which is exactly why it does not re-open that failure mode.
  // ONE canonical verifier, and it is CODEX. The polish loop's check and every gate re-verify only
  // ever differed in tense, so they are one brief now — and a shell-capable verifier reads the
  // acceptance-check commands out of the SPEC itself instead of being handed a transcription of
  // them. `LOAD_CMDS` deliberately stays inline rather than becoming a second courier call: the
  // number that matters is the load WHILE the lanes ran, and only the process that ran them can
  // sample it.
  const verifyBrief =
    `# GOAL\nVerify unit ${unit.id} in the git worktree at ${w} (branch unit/${unit.id}, diff base ${base}). ` +
    `Run the checks and report what they did. Fix NOTHING and commit nothing — a failing check is a RESULT ` +
    `to report, never a problem for you to solve.\n\n` +
    `# METHOD\nCheck cheapest-first — lint/typecheck the changed files first, then run EXACTLY ` +
    `the acceptance-check commands ${spec} names, verbatim, in the order it names them (commands and ` +
    `conventions: ${brief}). NEVER substitute a narrower, faster or cheaper lane for one the spec names: ` +
    `running \`test:unit\` where the spec says \`test:ci\` is a false green, and it once hid a red seal for a ` +
    `whole unit. If the spec names no runnable command at all, run the tests scoped to this unit and say so in ` +
    `\`notes\`. Do NOT run the full project suite — that happens at merge.\n\n` +
    `# REPORT\nReport \`lanes\` = every command you ` +
    `ran, in run order, each {command (verbatim, max 300 characters), exitCode}; \`pass\` is true ONLY if every ` +
    `one of those exit codes is 0. Report \`diffFiles\` = the exact output ` +
    `lines of \`git diff --name-only ${base}..HEAD\`, and check whether that diff touches any path under ` +
    `.roadmap/ (report that as contractSurfaceTouched — ` +
    `the whole directory is the orchestrator's, not just contracts/). Report failures with the exact ` +
    `verbatim error output, never paraphrased, and \`failingSpecs\` = the repo-relative path of every test ` +
    `FILE that has a failure, one entry per file. ${LOAD_FACTS}If the tooling itself cannot run (missing ` +
    `dependency, broken command, environment failure) — as opposed to an assertion failing — report ` +
    `blocked:true and stop.\n\n` +
    `# HOST\n${HOST_BAR}If the spec makes one of those a check you are supposed to run, that clause is the ` +
    `defect: report it as a FAILING check, quoting the clause verbatim in \`failures\`, and carry on with the ` +
    `rest. Never report blocked:true over it — \`blocked\` is for tooling that could not run, and a spec ` +
    `nobody can satisfy is a result to report, not an environment failure.`
  // Still inside withGateSlot: a codex verify spends the box's cores exactly as a Haiku one did, and
  // gateMaxConcurrent bounds the HOST, not the driver. It nests OUTSIDE the adapter's own codex
  // semaphore and cannot deadlock — nothing holding a codex slot ever waits on a gate slot. Its
  // deadline is the fix-round deadline, not the 20-minute role default: a lane is the one role that
  // legitimately spends most of an hour.
  const runVerify = async (label) => {
    const v = await withGateSlot(() => run(verifyBrief, { model: 'codex', cwd: w, sandbox: 'workspace-write',
      schema: S.verify, phase: 'Verify', label, timeoutMin: C.codexFixTimeoutMin }))
    if (v) noteFailingSpecs(unit.id, v)
    return v
  }
  // A verify that never RAN is not a verdict about the unit. It BLOCKS: the branch and its commits
  // stay, and the wave-start loop re-opens a `blocked` unit whose blocker is gone, so it re-enters
  // dispatch next wave and is judged then. Deliberately NOT the env-blocked quarantine beside it —
  // `blocked:true` is a verifier that ran and found the tooling broken, a fact about this checkout;
  // a dead codex role is a fact about CODEX, and re-opening finished work for redesign over one is
  // the invented-verdict class (§9) with a process boundary in front of it.
  const verifyUnrun = (label) => {
    // A HALTED wave is a park, not a block, and not a degradation either: the halt is already
    // ledgered with its own cause, the role was never launched, and the unit re-enters by adoption
    // next wave exactly as every other halted step leaves it.
    if (haltReason()) return { status: 'pending', parked: true, note: `parked at ${label}: ${haltReason()}` }
    degrade({ label, model: 'codex', phase: 'Verify', kind: 'verify-unrun',
      what: `the codex verifier produced no report for ${unit.id} after its retry${loadNote()} — the unit is ` +
        `BLOCKED, not quarantined: nothing about it was judged, its commits are intact, and it re-enters ` +
        `dispatch next wave` })
    return { status: 'blocked', branch: `unit/${unit.id}`, note: `verification never ran (${label})` }
  }

  setStage(unit.id, 'polish')
  let verify
  for (let round = 0; round <= C.maxFixRounds; round++) {
    verify = await runVerify(`verify:${unit.id}#${round}`)
    if (!verify) return verifyUnrun(`verify:${unit.id}#${round}`)
    // The only coverage assertion the SCRIPT can make: a pass with no lane ledger at all is not
    // evidence of anything. Coverage against the spec's named list is the exit gates' (LANE_BAR).
    if (verify.pass && !verify.lanes?.length)
      degrade({ label: `verify:${unit.id}#${round}`, model: 'haiku', phase: 'Verify', kind: 'lane-substituted',
        what: `unit ${unit.id} verified pass with an empty \`lanes\` ledger — no acceptance-check command was ` +
          `reported, so the green is unattributable and the exit gate must demand the spec's named lanes` })
    if (verify.blocked) return envBlocked(`verify:${unit.id}#${round}`, verify)
    // (Cross-unit aggregation — the shared-red breaker — already ran inside runVerify, before this
    // unit could spend a fix round on a red none of its siblings caused either.)
    // Adopted/existing-branch entry has no plan pass: the envelope is the diff AT ENTRY —
    // pinned from the first verify and never widened after (that distinction is the mechanism).
    if (!envelope && verify.diffFiles?.length) envelope = [...verify.diffFiles]
    else if (envelope && verify.diffFiles) {
      const env = new Set(envelope)
      const grew = verify.diffFiles.filter((f) => !env.has(f) && !scopeAllowed(f))   // scopeAllow: never growth
      if (grew.some((f) => !scopeGrewSeen.has(f)))
        degrade({ label: `verify:${unit.id}#${round}`, model: 'haiku', phase: 'Verify', kind: 'scope-growth',
          what: `unit ${unit.id}'s diff reaches ${grew.length} file(s) outside its pinned scope: ` +
            `${grew.slice(0, 8).join(', ')}${grew.length > 8 ? ', …' : ''} — the exit gate adjudicates each ` +
            `(necessary vs creep); this is a signal, never a licence to fix them` })
      for (const f of grew) scopeGrewSeen.add(f)
      scopeGrew = grew
    }
    // A unit whose entire red belongs to the breaker has nothing of its own left to fix.
    if (verify.pass || fullySuppressed(verify)) break

    // Mid-loop rescue: fired by code over objective signals only, and capped.
    let directive = null
    const stuck = round >= C.maxFixRounds || verify.contractSurfaceTouched || !!mismatch || !!gap
    if (stuck && consultsUsed < C.maxConsults) {
      consultsUsed++
      const dossier = await run(
        `Distill a brief dossier for an architect about unit ${unit.id}, which is stuck. Read the spec at ${spec}; ` +
        `summarize what was attempted (branch unit/${unit.id}, worktree ${w}), the strongest failure evidence, and ` +
        `the most plausible root cause. Verify: ${JSON.stringify(verify)}.` +
        ` Implementer-reported contract mismatch: ${mismatch ?? 'none'}.` +
        ` Implementer-reported spec gap (a decision the spec does not settle): ${gap ?? 'none'}.`,
        { model: 'sonnet', phase: 'Escalate', label: `rescue-dossier:${unit.id}`, schema: S.dossier })
      directive = await runReq(
        `You are the architect. Unit ${unit.id} is stuck. Dossier: ${JSON.stringify(dossier)} (spec: ${spec} — ` +
        `consult it and the code in ${w} yourself if the dossier is not enough). Decide: redirect with brief ` +
        `guidance, or quarantine for redesign. Do not write code.`,
        { model: 'fable', effort: C.fableEffort, phase: 'Escalate', label: `consult:${unit.id}`, schema: S.directive })
      if (directive.action === 'quarantine') return quarantine(unit, 'architect consult', directive)
      mismatch = null   // consumed — one consult per reported mismatch
      if (gap) { gap = null; gapConsulted = true }   // the dossier carried it; the architect saw it
    }

    bumpRound(unit.id, 'fix')
    const fixed = await fixStep(unit, w, base, envelope, { step: `fix${round}`, label: `codex-fix:${unit.id}#${round}` },
      `Failing checks (verbatim): ${JSON.stringify(verify.failures)}.${sharedRedClause(verify)}` +
      `${directive ? ` Architect direction: ${directive.guidance}` : ''}${designClause(unit)}` +
      ` If a fix forces you to deviate from a frozen contract surface, report it in \`contractMismatch\` ` +
      `(one or two sentences, max 300 characters).`)
    if (fixed.parked) return { status: 'pending', parked: true, note: `parked mid-polish: ${haltReason()}` }
    if (fixed.reportLost) reportLostEver = true
    addDebt(unit.id, base, fixed.debt)
    noteMismatch(fixed)
    noteGap(fixed)
  }
  // Quarantining a unit for a red the breaker owns would be exactly the failure the breaker exists
  // to stop — one shared assertion killing every unit in the wave.
  if (!verify.pass && !fullySuppressed(verify)) return quarantine(unit, 'verification never passed', verify)
  // Implementer-pulled consult (10a): a specGap on an all-green unit still gets frontier
  // adjudication — the polish loop's rescue only fires on failure signals, and the class this
  // closes is precisely the silent design decision under an all-green suite. One consult per
  // reported gap, riding the same maxConsults budget; an unconsulted gap forces the Fable gate.
  // Units are sized by what we can specify, not by duration, so stops are the release valve and
  // several per unit are normal. Most are nonsense — a decision the spec DOES settle that the
  // implementer failed to read — so Opus triages first and only genuine boundary-crossings reach
  // the frontier. Triage is free by design: charging it to maxConsults would let three misreads
  // starve the rescue channel. Three strikes goes straight to Fable regardless of content —
  // at that point the finding is not the decision, it is that the unit was specified wrong.
  let stops = 0
  while ((gap || mismatch) && stops < C.maxStops) {
    stops++
    // A contract mismatch is tier-2 BY CONSTRUCTION and skips triage: "a frozen contract is wrong
    // or cannot be implemented as written" is the first entry in the boundary enum, and no
    // adjudicator confined to this unit can rule on a surface that binds every other one. Only the
    // architect may amend a contract. Arc-observed (horizon fixture, run 2): with the ladder wired
    // to specGap alone, a unit that stopped with `stopped-contract-mismatch` — naming its own fix
    // in the report — got no ruling at all, went to the gate twice and quarantined as
    // "did not converge". That is the most important stop type, and it was the one that could not
    // reach an architect.
    const isMismatch = !!mismatch
    const reported = isMismatch ? mismatch : gap
    if (isMismatch) mismatch = null
    else gap = null
    let guidance = null                 // set only when a ruling must be applied as a fix round
    const pinned = envelope?.length ? envelope.join(', ') : 'the files this unit already touches'
    const priorStops = escalationStops[unit.id] ?? 0
    const v = (isMismatch || priorStops >= 2) ? null : await run(
      `You are adjudicating an implementer escalation on unit ${unit.id}. The implementer stopped and reported a ` +
      `decision it says the spec does not settle: "${reported}". Read the spec at ${spec}, the contracts it ` +
      `references, and \`git -C '${w}' diff ${base}..HEAD\` as needed. Rule with \`tier\`:\n` +
      `- "cited" — the spec, a contract, the conventions or the existing code DOES settle this and the ` +
      `implementer missed it. Most escalations are this. Put the exact location and the answer in \`guidance\`.\n` +
      `- "decided" — a genuine gap, but the decision stays inside this unit's pinned scope (${pinned}) and is ` +
      `recoverable. Put the decision and the reasoning behind it in \`guidance\`.\n` +
      `- "escalate" — the decision leaks past what you can see from this unit alone. Name the boundary and put ` +
      `the question for the architect in \`guidance\`.\n` +
      `\`boundary\` is "none" for cited and decided. For escalate it is exactly one of: "contract" (a frozen ` +
      `contract is wrong or cannot be implemented as written), "scope-envelope" (the pinned scope must widen), ` +
      `"other-unit" (another unit's spec or the dependency order is implicated), "plan-of-record" (the approved ` +
      `implementation plan is itself wrong), "mis-specified" (the unit is wrong in shape — Phase-0 territory). ` +
      `Difficulty is NOT a boundary: a hard decision that stays inside this unit is "decided", not "escalate". ` +
      `${directionClause}Do not write code.`,
      { model: 'opus', effort: 'high', phase: 'Escalate', label: `adjudicate:${unit.id}#${stops}`, schema: S.adjudication })
    if (v && v.tier !== 'escalate') {
      gapConsulted = true
      guidance = v.guidance
      escalate({ unit: unit.id, stop: stops, tier: v.tier, boundary: v.boundary, by: 'opus', gap: reported })
      // A "decided" ruling settles something the spec did not. It has to land IN the spec: the
      // implementer's own context may compact before the unit ends, and review, the gate and any
      // later reader see the spec, never this resume prompt.
      if (v.tier === 'decided')
        await run(
          STRICT +
          `In the git repository at ${repo}: append to the spec file ${spec} — do not modify anything already ` +
          `in it. Add a section titled ` +
          `"## Adjudicated during implementation" if it is not already present, then one bullet recording ` +
          `this ruling verbatim: the question was "${reported}"; the ruling is "${v.guidance}". Report ok.`,
          { model: 'haiku', effort: 'low', phase: 'Escalate', label: `spec-append:${unit.id}#${stops}`, schema: S.ok })
    } else if (consultsUsed < C.maxConsults) {
      consultsUsed++
      gapConsulted = true
      const gd = await run(
        `You are the architect on unit ${unit.id}. ` +
        (isMismatch
          ? `The engineer reports that a FROZEN CONTRACT contradicts what this unit must build: "${reported}". ` +
            `You own the contracts and the engineer may not amend one, so this is yours alone. Rule on the ` +
            `CONTRACT, not just this unit: confirm the engineer's reading and direct the lawful implementation ` +
            `under the surface as frozen, redirect with the amendment you are making and what it now requires, ` +
            `or quarantine if the unit cannot exist under it. Weigh that the surface binds every other unit too.\n`
          : `The engineer made a decision the spec does not settle and pulled you in: "${reported}". ` +
            (v ? `A first-line adjudicator escalated it because it crosses a boundary it could not see past: ` +
                 `${v.boundary}. Its reading: ${v.guidance}\n`
               : `This is the third stop on this unit — the earlier ones were adjudicated below you. Weigh whether ` +
                 `the unit itself is specified wrongly, not just this decision.\n`)) +
        `Read the spec at ${spec} and the contracts it references, and \`git -C '${w}' diff ${base}..HEAD\` ` +
        `as needed. Decide: "confirm" if the decision stands as built; "redirect" with brief guidance if it ` +
        `(or a better alternative) must be steered — the engineer applies your guidance as one fix round; ` +
        `"quarantine" only if the unsettled decision invalidates the unit's premise. Do not write code.`,
        { model: 'fable', effort: C.fableEffort, phase: 'Escalate', label: `gap-consult:${unit.id}#${stops}`, schema: S.directive })
      // Same dead-agent class as the plan-check guard: a null consult must not be dereferenced.
      // Leaving the trigger unconsumed is the conservative outcome — mismatchEver/gapEver still
      // force the frontier gate, so the decision is adjudicated there instead of being lost.
      if (!gd?.action) break
      escalate({ unit: unit.id, stop: stops, tier: 'escalate',
        boundary: isMismatch ? 'contract' : (v?.boundary ?? 'three-strikes'),
        by: 'fable', action: gd.action, gap: reported })
      if (gd.action === 'quarantine') return quarantine(unit, 'spec-gap consult: the unsettled decision invalidates the unit', gd)
      if (gd.action === 'redirect') guidance = gd.guidance
    } else {
      break   // budget spent: the gap stays unadjudicated, which forces the Fable exit gate below
    }
    if (!guidance) continue   // "confirm" / a citation with nothing to change — no fix round
    const gFix = await fixStep(unit, w, base, envelope, { step: `gap-fix-${stops}`, label: `codex-gap-fix:${unit.id}#${stops}` },
      (isMismatch
        ? `You reported that a frozen contract contradicts this unit, and the architect ruled: ${guidance}\n`
        : `The spec left a decision unsettled; you reported it, and the ruling is: ${guidance}\n`) +
      `Apply that ruling.`)
    if (gFix.parked) return { status: 'pending', parked: true, note: `parked at gap-fix: ${haltReason()}` }
    addDebt(unit.id, base, gFix.debt)
    if (gFix.reportLost) reportLostEver = true
    noteMismatch(gFix)
    // A stop DURING the fix round re-enters the ladder rather than being dropped — the whole
    // point of the release valve is that it can fire more than once on a long unit.
    noteGap(gFix)
    verify = await runVerify(`gap-verify:${unit.id}#${stops}`)
    if (!verify) return verifyUnrun(`gap-verify:${unit.id}#${stops}`)
    if (verify.blocked) return envBlocked(`gap-verify:${unit.id}#${stops}`, verify)
  }

  // Cross-model PRE-GATE REVIEW. The old standalone Claude review stage was removed with the codex
  // executor (RATIONALE §17) because it graded the same diff the exit gate then re-read with
  // authority — a free pass whose only durable effect was widening the diff. This is not that. It
  // is the OTHER model family reading the diff once, read-only, and producing a DIGEST built for
  // the GATE to consume: the gate's diet (`gateModel`) is affordable only because this arrives
  // first, and this is the only reader whose whole job is the two classes no runnable check can
  // see — a diff that passes every command and still violates what the spec's PROSE requires, and
  // one that reimplements a helper the conventions contract already catalogues.
  setStage(unit.id, 'review')
  const reviewBrief =
    `# GOAL\nReview unit ${unit.id} of a roadmap build before its exit gate, and report a DIGEST the gate will ` +
    `adjudicate. You are a second engineer, from a different model family than both the gate and the ` +
    `implementer: what you catch is what the runnable checks and that family both missed.\n\n` +
    `# CONTEXT (read these — do not guess at them)\n` +
    `- The spec at ${spec} is authoritative, ITS PROSE INCLUDED. A criterion stated in words binds exactly as ` +
    `hard as one a command can check.\n` +
    `- Frozen contracts it references live under ${repo}/.roadmap/contracts/.\n` +
    (conventions
      ? `- The standing conventions contract at ${conventions} catalogues the shared utilities every unit must ` +
        `REUSE rather than reinvent, and the naming/error/pattern conventions every unit must follow. Read it: ` +
        `a catalogued helper reimplemented inside this diff violates that contract, is never a style ` +
        `preference, and is invisible to every runnable check.\n`
      : '') +
    `- The diff is \`git diff ${base}..HEAD\` in ${w} (branch unit/${unit.id}). Read it in full, plus whatever ` +
    `surrounding code you need to judge it.\n` +
    `- This unit's pinned scope is: ${envelope?.length ? envelope.join(', ') : "the files its diff already touched at entry"}${scopeAllowClause}.\n` +
    `- What actually ran, and what it returned: ${JSON.stringify(verify)}.\n` +
    `${designClause(unit)}\n` +
    `# CONSTRAINTS\nRead-only. Change nothing, write nothing, run no build, commit nothing, and fix not one ` +
    `thing you find — the report IS your output. Do not propose an alternative design, and do not re-litigate ` +
    `the approach: it was planned and an architect approved it.\n\n` +
    `# WHAT TO HUNT\n` +
    `1. \`specFindings\` — acceptance criteria this diff does NOT satisfy, graded one at a time against what ` +
    `the spec SAYS rather than against what the suite happens to check. The highest-value finding available to ` +
    `you is the criterion every runnable command passes and the prose still forbids: a rule stated in words and ` +
    `implemented with the language's default, an edge case the spec names and no test covers. Quote the clause ` +
    `you are grading as \`criterion\` and state what makes it fail as \`evidence\`.\n` +
    `2. \`conventionFindings\` — a shared utility the conventions contract catalogues, reimplemented inside ` +
    `this diff. Name the catalogued \`helper\` and \`where\` the diff duplicates it.\n` +
    `3. \`contractTouches\` — every frozen-contract surface this diff touches or depends on, one line each.\n` +
    `4. \`scopeNotes\` — behaviour or files in this diff the spec did not ask for, and anything the pinned ` +
    `scope names that the diff never reached.\n` +
    `5. \`unread\` — whatever you could NOT check, and why. The gate may read this digest INSTEAD of the diff, ` +
    `so silence reads as coverage: a criterion you skipped and did not list becomes one nobody knows was ` +
    `skipped. An honest short list beats a complete-looking one.\n\n` +
    FINDING_BAR('finding') +
    `\n# VERDICT\n\`verdict\`: "clean" = you would merge this as it stands; "concerns" = findings the gate ` +
    `should weigh that do not by themselves block; "blocking" = at least one finding makes the spec's behaviour ` +
    `wrong, violates a contract or the conventions contract, or leaves an acceptance criterion untested. ` +
    `\`risk\` = what a missed defect in THIS diff would cost — "low", "med" or "high". The SCHEDULER reads ` +
    `both: "blocking" or "high" puts a frontier-capable gate back in front of the raw diff, and "clean"/"low" ` +
    `is what lets a cheaper one stand on your report. Grade honestly in both directions — inflating costs the ` +
    `arc frontier attention it needed elsewhere, and deflating hands a defect a cheaper gate was never given ` +
    `the evidence to catch.`
  const digest = await run(reviewBrief,
    { model: 'codex', cwd: w, sandbox: 'read-only', schema: S.reviewDigest,
      phase: 'Review', label: `codex-review:${unit.id}` })
  // No digest is not a cheaper gate — it is a MORE expensive one. The adapter has already ledgered
  // why codex produced nothing; this row records what the harness did about it, because "the gate
  // read the raw diff at Opus this time" is the fact a spend audit needs. Not on a HALT, though:
  // there the role was never launched, the halt carries its own ledger row and its own cause, and a
  // second row blaming the reviewer would point the reader at the wrong thing.
  if (!digest && !haltReason())
    degrade({ label: `codex-review:${unit.id}`, model: 'codex', phase: 'Review', kind: 'review-skipped',
      what: `no cross-model review digest for ${unit.id} — the exit gate falls back to reading the raw diff ` +
        `itself, at Opus whatever the unit's risk. Less evidence buys MORE Claude here, never less scrutiny` })

  // Exit gate — first-pass tier per `gateModel`, escalating to the Fable architect only when the call is
  // genuinely hard. High-risk units, contract-touching diffs, and a deterministic audit
  // sample skip straight to the guaranteed Fable gate: no first-pass tier reliably self-detects the
  // subtle oversights that gate exists to catch, so where the stakes are structurally
  // highest, frontier judgment stays mandatory (DESIGN.md decision 4) — unchanged by 0.14.0.
  setStage(unit.id, 'gate')
  // Scope growth is adjudicated at the gate, where judgment already lives — annotate-and-decide,
  // not force-frontier (which would fire constantly on legitimately-underestimated file lists).
  // Evaluated per gate CALL, not once: the precedent it carries is this wave's sibling rulings,
  // which accumulate while this unit is in flight.
  const scopeCreepClause = () => scopeGrew.length
    ? ` This diff touches ${scopeGrew.length} file(s) outside the unit's pinned scope: ${scopeGrew.join(', ')}. ` +
      `Adjudicate each explicitly: necessary to satisfy the spec (say so and approve it), or scope creep to ` +
      `be reverted (a revise directive). Do not treat their presence as licence to review them as though ` +
      `they were in scope. Record one entry per file in \`scopeRulings\` ({file, verdict:"approve"|"revert"}) — ` +
      `that record is what makes the next gate's answer consistent with yours.` + scopePrecedent(unit.id)
    : ''
  // Directive-cap enforcement, both gates: a cap on REPORTING, never on reading — overflow past
  // it is banked as debt (the ledger invariant), and the cap runs BEFORE the correctness-debt
  // coercion so a coerced correctness directive is never dropped by it.
  const capDirectives = (g, label) => {
    const over = (g.directives ?? []).slice(C.maxBlockingFindings)
    if (over.length) {
      addDebt(unit.id, base, over.map((d) => ({ what: d.what, why: d.why })), { kind: 'structure' })
      g.directives = g.directives.slice(0, C.maxBlockingFindings)
      log(`${unit.id}: ${label} issued ${over.length} directive(s) past the cap — banked as debt`)
    }
  }
  // mismatchEver: the Fable gate catching exactly this case (silent frozen-surface deviation,
  // all-green tests) is arc-observed value.
  const forceFrontier =
    C.exitGate === 'always-fable' || unit.risk === 'high' ||
    verify.contractSurfaceTouched || auditPick(unit) || mismatchEver || reportLostEver ||
    (gapEver && !gapConsulted)   // an unadjudicated spec-silence decision — same missing-signal logic
  // An audit-only force (the sample fired, nothing structural did) is a spot-check of an
  // Opus-approved unit, not a from-scratch re-gate: it runs at the cheaper auditEffort and
  // reads a diet of the diff. Any structural force keeps the full-read gateEffort path.
  const auditOnly = auditPick(unit) && C.exitGate !== 'always-fable' &&
    unit.risk !== 'high' && !verify.contractSurfaceTouched && !mismatchEver && !reportLostEver &&
    !(gapEver && !gapConsulted)

  // THE GATE DIET. The first-pass gate's ordinary job is now adjudicating the review digest, the
  // lane ledger, this wave's scope precedent and the contract notes — not re-reading the whole diff
  // — so `gateModel` puts a low-risk unit on a cheaper tier. Two conditions refuse the diet outright
  // and put Opus back in front of the RAW DIFF, and the direction is the whole safety argument: a
  // gate that cannot see the diff cannot DISAGREE with the review, and a review that says "clean"
  // over a spec-prose violation must never become a rubber stamp (the `gate-bad` fixture is exactly
  // that probe). So: no digest at all, or a digest the reviewer itself graded `blocking` or
  // high-risk, and the cheap path is off. Med/high-risk units keep the raw diff either way.
  const digestUsable = !!digest && digest.verdict !== 'blocking' && digest.risk !== 'high'
  const dietRefused = !digestUsable || unit.risk !== 'low'
  const firstGateModel = digestUsable ? (C.gateModel?.[unit.risk] ?? 'opus') : 'opus'
  const firstGateRead = dietRefused
    ? `read \`git -C '${w}' diff ${base}..HEAD\` in full and whatever surrounding code you need. `
    : `read \`git -C '${w}' diff --stat ${base}..HEAD\` and then, IN FULL, the diff of every file the review digest's ` +
      `findings, contract touches or scope notes name — expanding to the complete diff the moment anything ` +
      `looks off, the digest looks thin for the size of the change, or an acceptance criterion is not settled ` +
      `by what you have read. The raw diff is one command away and reading it is never wrong: this is where to ` +
      `start, not a ceiling on what you may read. `
  // Handed to BOTH gates. A digest is evidence to adjudicate, never a verdict and never coverage —
  // that sentence is what stands between a cheaper gate and a rubber stamp.
  const reviewClause = digest
    ? ` A cross-model reviewer — a different model family, read-only — has already read this diff in full ` +
      `against the spec, the contracts${conventions ? ', the conventions contract' : ''} and the pinned scope, ` +
      `and reported this digest: ${JSON.stringify(digest)}. Treat it as EVIDENCE to adjudicate, never as a ` +
      `verdict and never as coverage: a "clean" digest is not an approval, what it does not mention is not ` +
      `thereby correct, and anything it lists under \`unread\` was checked by nobody. Confirm what it claims ` +
      `against the spec yourself, add what it missed, and say plainly where you disagree — cross-model ` +
      `disagreement is signal, not noise.`
    : ` No cross-model review digest exists for this unit (the reviewer produced nothing), so the diff itself ` +
      `is the only account of what was built. Read it in full and assume nothing was pre-checked.`

  // When the Opus-first gate hands off to the Fable gate (escalation or non-convergence),
  // carry its last assessment across so the frontier gate confirms/overturns a concrete lead
  // rather than re-deriving the concern from the spec, contracts, and diff from scratch.
  let opusHandoff = null
  if (!forceFrontier) {
    // Bounded Opus self-gate: a FRESH adversarial Opus (not the implementer) grades the
    // acceptance criteria one by one, then approves, self-revises (free), or escalates.
    for (let g = 0; g < C.maxGateRounds; g++) {
      spend.opusGateRounds++
      bumpRound(unit.id, 'opusGate')
      const og = await runOr({ verdict: 'escalate', trigger: 'stuck', directives: [], debt: [],
        notes: 'the first-pass exit gate produced no report — degraded to the frontier gate' },
        riskTilt(unit.risk) +
        `You are the exit gate for unit ${unit.id} of a roadmap build, standing in for the architect — but you ` +
        `are the FIRST PASS, not the frontier, so escalate to the frontier architect the moment the call ` +
        `exceeds a capable engineer's ` +
        `authority rather than guessing. In the worktree at ${w}: read the spec at ${spec} and the contracts it ` +
        `references, then ${firstGateRead}` +
        `${convClause}${designClause(unit)}Verification evidence: ${JSON.stringify(verify)}. ${LANE_BAR}${HOST_BAR}${reviewClause} Grade each of the spec's acceptance criteria ` +
        `individually before any overall verdict — a gestalt impression hides exactly the misses you are here to ` +
        `catch; subtle spec misses, contract edge cases, and tests that would not fail if the behaviour were ` +
        `actually wrong are exactly what to hunt. ${unit.design?.length ? 'For a comp-governed criterion, grade conformance against the comp SOURCE: a jsdom presence test is not fidelity evidence, and a fidelity criterion that cannot be checked as written is debt, not a pass. ' : ''}${FINDING_BAR('revise directive')}${scopeCreepClause()}${directionClause}Then choose a verdict: "approve" only if you would merge this ` +
        `as-is and personally vouch for it; "revise" if there is a concrete, mechanical fix you can specify and it ` +
        `needs no frontier judgment (give at most ${C.maxBlockingFindings} directives, worst first — what and ` +
        `why, not code); "escalate" to the frontier ` +
        `architect if you are stuck, if the right choice is a genuinely hard trade-off where every option carries ` +
        `a substantive drawback, if the increment is architecturally foundational to the wider solution, or if ` +
        `you have found an oversight you are not confident you can resolve. Name the escalation trigger. ` +
        `${DEBT_DISCIPLINE}${TERSE}` +
        `${g > 0 ? ' You gated this unit before; focus on whether your previous directives were properly addressed.' : ''}`,
        // The label and the per-unit `rounds.opusGate` tally keep their names — the paid fixtures'
        // round-ceiling graders and every resume journal key on them — but the TIER is `gateModel`'s
        // now, and `spend` records what actually ran, per tier, either way.
        { model: firstGateModel, effort: C.opusEffort, phase: 'Opus-gate', label: `opus-gate:${unit.id}#${g}`, schema: S.opusGate })
      capDirectives(og, 'opus-gate')
      recordScopeRulings(unit.id, og)
      // Approve-with-correctness-debt is the verdict-downgrade path the discipline forbids: the
      // items become revise directives (rounds remaining) or force the frontier gate (round cap).
      // Coercion consumes the EXISTING gate rounds, so token cost stays bounded by maxGateRounds.
      const ogCd = correctnessDebt(og.debt)
      if (og.verdict === 'approve' && ogCd.length) {
        og.debt = og.debt.filter((d) => !ogCd.includes(d))
        og.directives = [...(og.directives ?? []), ...asDirectives(ogCd)]
        if (g < C.maxGateRounds - 1) {
          og.verdict = 'revise'
          log(`${unit.id}: opus-gate approved with correctness debt in hand — coerced to revise`)
        } else {
          og.verdict = 'escalate'
          og.trigger = 'oversight'
          log(`${unit.id}: opus-gate approved with correctness debt at the round cap — escalating to the frontier gate`)
        }
      }
      addDebt(unit.id, base, og.debt)
      opusHandoff = og
      if (og.verdict === 'approve') return { status: 'merge-ready', branch: `unit/${unit.id}`, base }
      if (og.verdict === 'escalate') break
      const ogFix = await fixStep(unit, w, base, envelope,
        { step: `opus-gate-fix${g}`, label: `codex-opus-gate-fix:${unit.id}#${g}`, fresh: g === C.maxGateRounds - 1 },
        `The exit gate reviewed your work and issued these directives:\n${JSON.stringify(og.directives)}`)
      if (ogFix.parked) return { status: 'pending', parked: true, note: `parked at opus-gate-fix: ${haltReason()}` }
      addDebt(unit.id, base, ogFix.debt)   // was silently dropped — a fix round's confessions are debt too
      if (ogFix.reportLost) {
        // forceFrontier was computed before this loop, so flagging alone changes nothing here.
        // Hand the unit to the frontier gate directly: the fix's self-reported evidence is gone and
        // an Opus round approving on the strength of a missing report is the failure we are closing.
        reportLostEver = true
        log(`${unit.id}: opus-gate-fix report lost — escalating to the frontier gate`)
        break
      }
      verify = await runVerify(`opus-gate-verify:${unit.id}#${g}`)
      if (!verify) return verifyUnrun(`opus-gate-verify:${unit.id}#${g}`)
      if (verify.blocked) return envBlocked(`opus-gate-verify:${unit.id}#${g}`, verify)
    }
    // Opus approved nothing across its rounds — whether it escalated or merely failed to
    // converge, the frontier architect decides next. Fall through to the Fable gate below.
  }

  // Fable architect gate — the frontier pass. Reached by force policy, an Opus escalation,
  // or Opus non-convergence. Nothing merges through here without frontier approval.
  // On an Opus handoff, the first Fable round inherits Opus's lead (see opusHandoff above);
  // '' when the gate was forced, so a forced-frontier prompt is byte-identical to before.
  const opusContext = opusHandoff
    ? ` A first-pass Opus exit gate already examined this unit and could not clear it itself ` +
      `(last verdict "${opusHandoff.verdict}"` +
      `${opusHandoff.trigger && opusHandoff.trigger !== 'none' ? `, escalation trigger "${opusHandoff.trigger}"` : ''}). ` +
      `Use its findings as a lead to confirm or overturn — not as ground truth, and do not re-derive them from ` +
      `scratch: ${JSON.stringify({ directives: opusHandoff.directives, notes: opusHandoff.notes })}.`
    : ''
  // Hand the gate the implementer's own report — forcing the Fable gate and then making it
  // rediscover the deviation from the diff would defeat half the structured channel.
  const reportLostClause = reportLostEver
    ? ' A code-writing agent on this unit committed work but its structured report was lost, so the usual ' +
      'self-reported summary, debt entries and contract-mismatch signal are ABSENT. Judge the diff itself; ' +
      'do not read the missing report as "nothing to declare".'
    : ''
  const gapClause = gapEver
    ? ` The implementer reported a decision the spec does not settle: "${gapEver}"` +
      `${gapConsulted ? ' (already adjudicated by an architect consult)' : ' (NOT yet adjudicated — the consult budget was spent)'}. ` +
      `Judge that decision explicitly against the spec's intent.`
    : ''
  const mismatchClause = mismatchEver
    ? ` The implementer reported deviating from a frozen contract surface: "${mismatchEver}". Adjudicate that ` +
      `deviation explicitly — approve it as recorded debt, direct a revert to the contract as written, or ` +
      `quarantine for contract amendment (amendments are the architect's alone, above this gate).`
    : ''
  // Audit-only gates read a diet first and expand on suspicion (a full re-read of an
  // Opus-approved unit is the false economy the audit is meant to avoid); every forced gate
  // keeps the byte-identical full-read instruction, since summarising their diff hides misses.
  const diffRead = auditOnly
    ? `read \`git -C '${w}' diff --stat ${base}..HEAD\`, the spec's acceptance criteria, and the verification evidence ` +
      `first, then read in full the diff of every file where a spec or contract violation would be consequential ` +
      `— expand to the complete diff the moment anything looks off. You are auditing an Opus-approved unit for ` +
      `systematic rubber-stamping, not re-gating from scratch. `
    : `read \`git -C '${w}' diff ${base}..HEAD\` in full and whatever surrounding code you need. `
  for (let g = 0; g < C.maxGateRounds; g++) {
    spend.gateRounds++
    bumpRound(unit.id, 'gate')
    const gate = await runReq(
      riskTilt(unit.risk) +
      `You are the architect gate for unit ${unit.id} of a roadmap build; nothing merges without your approval. ` +
      `In the worktree at ${w}: read the spec at ${spec} and the contracts it references, then ${diffRead}${convClause}${designClause(unit)}Verification evidence: ` +
      `${JSON.stringify(verify)}. ${LANE_BAR}${HOST_BAR}${reviewClause} Grade each of the spec's acceptance criteria individually before forming your ` +
      `overall verdict — a gestalt impression hides exactly the misses you are here to catch. Judge the work as ` +
      `if you must personally vouch for it: approve only if you would merge it without further steering. Small ` +
      `oversights — subtle spec misses, contract edge cases, tests that would not fail if the behaviour were ` +
      `actually wrong, the things a capable engineer plausibly overlooks — are exactly your job. ` +
      `${unit.design?.length ? 'For a comp-governed criterion, grade conformance against the comp SOURCE: a jsdom presence test is not fidelity evidence, and a fidelity criterion that cannot be checked as written is debt, not a pass. ' : ''}` +
      `${FINDING_BAR('revise directive')}${scopeCreepClause()}${directionClause}If revising, ` +
      `give at most ${C.maxBlockingFindings} specific directives, worst first: what and why, not code. ` +
      `${DEBT_DISCIPLINE}${TERSE}${mismatchClause}${gapClause}${reportLostClause}` +
      `${g === 0 ? opusContext : ' You gated this unit before; focus on whether your previous directives were properly addressed.'}`,
      { model: 'fable', effort: auditOnly ? C.auditEffort : C.gateEffort, phase: 'Architect', label: `gate:${unit.id}#${g}`, schema: S.gate })
    capDirectives(gate, 'frontier gate')
    recordScopeRulings(unit.id, gate)
    // Same coercion as the Opus gate — but this IS the frontier, so at the round cap the items
    // bank at severity:major with a LOUD degradation instead of quarantining work the frontier
    // gate judged mergeable (banking + evidence beats destroying an approved unit).
    const gCd = correctnessDebt(gate.debt)
    if (gate.verdict === 'approve' && gCd.length) {
      if (g < C.maxGateRounds - 1) {
        gate.verdict = 'revise'
        gate.debt = gate.debt.filter((d) => !gCd.includes(d))
        gate.directives = [...(gate.directives ?? []), ...asDirectives(gCd)]
        log(`${unit.id}: frontier gate approved with correctness debt in hand — coerced to revise`)
      } else {
        for (const d of gCd) d.severity = 'major'
        degrade({ label: `gate:${unit.id}#${g}`, model: 'fable', phase: 'Architect', kind: 'correctness-debt-banked',
          what: `frontier gate approved ${unit.id} at the round cap with ${gCd.length} correctness-kind debt ` +
            `item(s) still banked — banked at severity:major; the boundary triage must treat these as bugs, not hygiene` })
      }
    }
    addDebt(unit.id, base, gate.debt)
    if (gate.verdict === 'approve') return { status: 'merge-ready', branch: `unit/${unit.id}`, base }
    if (gate.verdict === 'quarantine') return quarantine(unit, 'rejected at architect gate', gate)
    const gFix = await fixStep(unit, w, base, envelope,
      { step: `gate-fix${g}`, label: `codex-gate-fix:${unit.id}#${g}`, fresh: g === C.maxGateRounds - 1 },
      `The frontier architect gate reviewed your work and issued these directives:\n${JSON.stringify(gate.directives)}`)
    if (gFix.parked) return { status: 'pending', parked: true, note: `parked at gate-fix: ${haltReason()}` }
    addDebt(unit.id, base, gFix.debt)   // was silently dropped — a fix round's confessions are debt too
    if (gFix.reportLost) reportLostEver = true
    verify = await runVerify(`gate-verify:${unit.id}#${g}`)
    if (!verify) return verifyUnrun(`gate-verify:${unit.id}#${g}`)
    if (verify.blocked) return envBlocked(`gate-verify:${unit.id}#${g}`, verify)
  }
  return quarantine(unit, 'architect gate did not converge')
}

/* --------------------- serial merge queue + suite gate ------------------ */
async function mergeUnit(unit) {
  // NOROADMAP made mechanical: the merge is the last place a unit diff can smuggle
  // orchestrator-state edits in (arc-observed: a unit edited a frozen contract from its
  // worktree and the queue accepted it — content sound, channel wrong). Refusal is checked
  // by the merge agent, the strip preserves the content in branch history, and the
  // kind:'contract' debt entry routes adjudication to the architect (root return).
  const roadmapCheck =
    `check \`git -C '${intWt}' diff --name-only $(git -C '${intWt}' merge-base HEAD unit/${unit.id})..unit/${unit.id} ` +
    `-- .roadmap/\` — if it ` +
    `lists ANY path, do NOT merge; touch nothing and report merged:false with those exact paths in \`roadmapPaths\`. `
  // Plan-driven prefix-uniqueness guard, '' when unset so the prompt stays byte-identical on
  // plans without numbered sequences (arc-observed: next-free-at-dispatch numbering collided
  // twice in one arc; one collision silently erased a CHECK constraint at merge). The check is
  // a DIFF of duplicate sets, pre-merge tip (HEAD^1 of the --no-ff merge commit) vs merged tree:
  // only a duplicate the merge INTRODUCES refuses. Twice arc-observed: a global-uniqueness check
  // on a repo whose history already held grandfathered duplicate pairs refused every merge in a
  // wave — 8 gate-approved units quarantined, zero merges, ~5h burned.
  const prefixClause = plan.prefixUniqueGlobs?.length
    ? ` Then, if you performed the merge, before the suite: for each of these globs — ${plan.prefixUniqueGlobs.join(', ')} — ` +
      `list the matching filenames in the PRE-MERGE tip (\`git -C '${intWt}' ls-tree -r --name-only HEAD^1 -- '<glob>'\`) and in ` +
      `the MERGED tree (same command with HEAD), extract each filename's leading digit run, and compute the set of ` +
      `digit runs shared by two or more files in each list. Digit runs already duplicated in the pre-merge tip are ` +
      `grandfathered and never refuse. If the merged tree has a duplicated digit run that the pre-merge tip did ` +
      `NOT already have, the merge is REFUSED: undo it with \`git -C '${intWt}' reset --hard ORIG_HEAD\` and report merged:false ` +
      `with every filename of the NEW collision(s) in \`prefixCollision\`.`
    : ''
  const mergePromptText =
    STRICT +
    `In the integration worktree at ${intWt} — every command below already carries \`-C '${intWt}'\`, and any ` +
    `command of your own must carry it too or start with \`cd '${intWt}' && \`, because your working directory ` +
    `does not survive from one command to the next. First, confirm HEAD is ON branch ${intBranch} — run ` +
    `\`git -C '${intWt}' symbolic-ref --quiet --short HEAD\`; a detached HEAD prints nothing. If it prints anything other than ` +
    `${intBranch}, run \`git -C '${intWt}' checkout ${intBranch}\` before touching anything else, and if that checkout fails, ` +
    `report merged:false with the exact error. A merge made on a detached HEAD produces a commit no branch can ` +
    `reach, and the work is lost the moment anything else checks the branch out. Then, if a merge is already ` +
    `in progress ` +
    `(a MERGE_HEAD exists), clear it with \`git -C '${intWt}' merge --abort\`. Then, if unit/${unit.id} is already an ancestor ` +
    `of HEAD (\`git -C '${intWt}' merge-base --is-ancestor unit/${unit.id} HEAD\` succeeds — a crash-replay after this merge ` +
    `already landed), skip the merge but still run the project's full test suite (each command as ` +
    `\`cd '${intWt}' && <command>\`; commands: ${brief}) and report ` +
    `merged:true with the current HEAD sha. Otherwise ${roadmapCheck}Only if it lists nothing, merge branch ` +
    `unit/${unit.id} ` +
    `(\`git -C '${intWt}' merge --no-ff unit/${unit.id}\`). If the merge conflicts, abort it ` +
    `(\`git -C '${intWt}' merge --abort\`) and report ` +
    `merged:false naming the conflicting paths in detail — do not resolve conflicts yourself. If it merges ` +
    `cleanly, run the project's full test suite (each command as \`cd '${intWt}' && <command>\`; commands: ` +
    `${brief}) and report the result.${prefixClause} ` +
    `Report the current HEAD sha (\`git -C '${intWt}' rev-parse HEAD\`) either way.` + ghMerged(unit)
  let res = await withGateSlot(() => runReq(mergePromptText, { model: 'haiku', phase: 'Merge', label: `merge:${unit.id}`, schema: S.merge }))

  if (!res.merged && res.roadmapPaths?.length) {
    log(`${unit.id}: unit diff touches orchestrator-owned .roadmap/ (${res.roadmapPaths.join(', ')}) — stripping before merge`)
    // A closed list, because this is the harness's only DESTRUCTIVE edit to a unit's branch. The
    // pathspec `-- .roadmap/` is on every command, so "touch nothing outside .roadmap/" is a
    // property of the commands rather than a promise extracted from an agent.
    const strip = await courierRun(wtOf(unit), [
      `BASE=$(git merge-base ${intBranch} HEAD) && { git checkout "$BASE" -- .roadmap/ 2>/dev/null || true; } && ` +
        `git diff --name-only --diff-filter=A "$BASE"..HEAD -- .roadmap/ | tr '\\n' '\\0' | ` +
        `xargs -0 -r git rm -f -q --ignore-unmatch --`,
      'git add -A -- .roadmap/',
      `git diff --cached --quiet -- .roadmap/ || git commit -q -m 'strip .roadmap/ — orchestrator-owned; ` +
        `original content preserved in prior commits'`,
      'git rev-parse HEAD',
    ], { model: 'haiku', phase: 'Merge', label: `strip-roadmap:${unit.id}` },
    `Every command carries the \`-- .roadmap/\` pathspec: nothing outside that directory is in scope, ` +
    `and no other path may be added to any of them. `)
    addDebt(unit.id, res.head, [{
      what: `unit diff touched orchestrator-owned .roadmap/ paths, stripped before merge: ${res.roadmapPaths.join(', ')}`,
      why: 'units may never write .roadmap/; the stripped content survives in the branch history — adjudicate ' +
        'whether it belongs in a contract amendment (the channel it should have used)',
    }], { kind: 'contract', severity: 'major' })
    if (!strip.ok)
      return quarantine(unit, `unit diff touches .roadmap/ (${res.roadmapPaths.join(', ')}) and the strip commit ` +
        `failed — nothing merged; the branch is intact`, res)
    res = await withGateSlot(() => runReq(mergePromptText, { model: 'haiku', phase: 'Merge', label: `merge:${unit.id}#restrip`, schema: S.merge }))
    if (!res.merged && res.roadmapPaths?.length)
      return quarantine(unit, 'unit diff still touches .roadmap/ after a strip commit — nothing merged', res)
  }
  // Guarded on the CONFIG, not just the report: the schema field exists whether or not the plan
  // sets prefixUniqueGlobs, and a merge agent facing an ordinary conflict has used it as a
  // scratchpad for "the colliding files" (paid-run-observed 2026-08-11: a plain textual conflict
  // quarantined as a prefix collision before the resolver ever ran). Without configured globs
  // there is no prefix policy to violate — the conflict path below owns the outcome.
  if (!res.merged && plan.prefixUniqueGlobs?.length && res.prefixCollision?.length)
    return quarantine(unit, `numbered-prefix collision at merge (${res.prefixCollision.join(', ')}) — pre-allocate ` +
      `explicit numbers in the conventions contract and respec; never renumber silently`, res)

  if (!res.merged) {
    res = await withGateSlot(() => runReq(
      `In the integration worktree at ${intWt} (branch ${intBranch}): merge branch unit/${unit.id}, resolving ` +
      `conflicts. Your working directory does not survive from one command to the next, so run every git command ` +
      `as \`git -C '${intWt}' …\` and every other command as \`cd '${intWt}' && <command>\`. ` +
      `First ${roadmapCheck}Both sides are intentional work — consult ${specOf(unit)}, the specs of ` +
      `recently merged units ` +
      `under ${repo}/.roadmap/specs/, and the contracts under ${repo}/.roadmap/contracts/ to decide each ` +
      `resolution. Then run the full test suite.${prefixClause} If you are genuinely unsure a resolution is ` +
      `semantically right, ` +
      `abort the merge and report merged:false rather than guessing. Report the HEAD sha and suite result.`,
      { model: 'opus', effort: C.opusEffort, phase: 'Merge', label: `resolve:${unit.id}`, schema: S.merge }))
    if (!res.merged && res.roadmapPaths?.length)
      return quarantine(unit, 'unit diff touches .roadmap/ at conflict resolution — nothing merged', res)
    if (!res.merged && plan.prefixUniqueGlobs?.length && res.prefixCollision?.length)
      return quarantine(unit, `numbered-prefix collision at merge (${res.prefixCollision.join(', ')}) — pre-allocate ` +
        `explicit numbers in the conventions contract and respec; never renumber silently`, res)
    if (!res.merged) return quarantine(unit, 'unresolvable merge conflicts', res)
  }

  if (!res.suitePass) {
    res = await withGateSlot(() => runReq(
      `The integrated test suite fails after merging unit/${unit.id} into ${intBranch} (worktree ${intWt}). ` +
      `Evidence: ${res.detail}. First check whether the failure predates this merge. If the merge caused it, ` +
      `diagnose and fix on ${intBranch} — this may be a cross-unit interaction; the specs of all units live under ` +
      `${repo}/.roadmap/specs/. Your working directory does not survive from one command to the next, so run ` +
      `every git command as \`git -C '${intWt}' …\` and every other command as \`cd '${intWt}' && <command>\`. ` +
      `Re-run the suite. If you cannot make it pass, revert the merge commit ` +
      `(\`git -C '${intWt}' revert -m 1 HEAD\`, keeping the branch intact for later redesign) and report ` +
      `suitePass:false.`,
      { model: 'opus', effort: C.opusEffort, phase: 'Merge', label: `integration-fix:${unit.id}`, schema: S.merge }))
    if (!res.suitePass) return quarantine(unit, 'broke the integrated suite', res, { mergeReverted: true })
  }

  // `merged:true` is an agent's claim; REACHABILITY is the fact — and reachability is the WHOLE
  // fact. 2026-08-28: a merge ran on a detached HEAD in the integration worktree, reported
  // merged:true, was recorded as `merged` with a `mergedAt` no branch pointed at, and the next
  // wave's tip reconcile adopted the branch tip over it — the whole unit vanished.
  // 2026-09-01: this gate ALSO demanded HEAD still be ATTACHED to the integration branch at probe
  // time, which was never the invariant. Paid run wf_bb1301d7-70e: the integration worktree's
  // history held a clean `Merge branch 'unit/add-multiply'` with HEAD on the branch, the
  // attachment test came back 1 anyway, and a landed merge went down the quarantine path — rescued
  // only by quarantine()'s mergedInGit refusal. What the merge prompt asks for (check the branch
  // out first) is how to make the result reachable; it is not the same claim as where HEAD happens
  // to point once the merge is done. So HEAD is a REPORTED fact here that decides nothing, kept
  // for the degradation detail, and the verdict is ancestry alone: the unit branch is an ancestor
  // of the integration branch, and the head the agent reported is reachable from it.
  const reach = await gitProbe(`merge-reach:${unit.id}`, intWt, [
    'git symbolic-ref --quiet --short HEAD',
    `git merge-base --is-ancestor unit/${unit.id} ${intBranch}`,
    `git merge-base --is-ancestor ${res.head} ${intBranch}`,
  ], 'Merge')
  // The decisive exit codes lead: quarantine-refused truncates this reason at 120 chars, and a
  // reason whose evidence falls off that cliff is a degradation row nobody can act on.
  if (reach.code(1) !== 0 || reach.code(2) !== 0)
    return quarantine(unit, `unit/${unit.id} is-ancestor exit ${reach.code(1)}, head ` +
      `${String(res.head).slice(0, 8)} is-ancestor exit ${reach.code(2)} — the merge reported success but is NOT ` +
      `reachable from ${intBranch} (HEAD was ${reach.line(0) || 'detached'}), most likely a dangling merge commit. ` +
      `Nothing is recorded as merged and the unit branch is intact: re-merge it and leave the result on ` +
      `${intBranch}`, res)

  integrationTip = res.head
  if (C.previewRefresh === 'merge') refreshMirror()
  return { status: 'merged', branch: `unit/${unit.id}`, mergedAt: res.head }
}

/* ------------------------------- scheduler ------------------------------ */
function start(unit) {
  inFlight++
  dispatched.add(unit.id)
  // `rounds.verifyBlocked` is the ONE tally that counts across waves — the second blocked verify
  // for a unit is what quarantines it — so it is carried onto the fresh running record. Read from
  // `prior`, this wave's immutable input, because the wave-start re-open loop rewrites a blocked
  // record to a bare `{status:'pending'}`. The per-wave tallies (fix/opusGate/gate) deliberately do
  // NOT carry: they measure one wave's revision loops and the fixtures assert ceilings on them.
  const blockedRounds = prior.units?.[unit.id]?.rounds?.verifyBlocked
  units.set(unit.id, { status: 'running', ...(blockedRounds ? { rounds: { verifyBlocked: blockedRounds } } : {}) })
  snapshot()   // a 'running' record is what a crash-residue recovery adopts
  ;(async () => {
    let result = await runUnit(unit)
      // A PlatformOutage is the platform's death, not this unit's: park it (commits intact, adopted
      // next wave) instead of converting a dead agent into a unit verdict. Everything else that
      // reaches here is a real pipeline bug and still quarantines, loudly.
      .catch((e) => e?.name === 'PlatformOutage'
        ? { status: 'pending', parked: true, note: `parked on platform outage: ${e.message}` }
        : quarantine(unit, `pipeline error: ${e?.message ?? e}`).catch(() =>
          ({ status: 'quarantined', reason: `pipeline error: ${e?.message ?? e}` })))
    // The terminal result replaces the running record wholesale — carry the round tally over.
    const rounds = units.get(unit.id)?.rounds
    if (result.status === 'merge-ready') {
      // Stamp 'merge-queue' directly (not via setStage — status is 'merge-ready', not 'running');
      // this transient record is overwritten by the terminal result below, so no stale stage survives.
      units.set(unit.id, { ...(rounds ? { rounds } : {}), ...result, stage: 'merge-queue' })
      snapshot()
      const segment = mergeChain.then(() => mergeUnit(unit)).catch((e) => e?.name === 'PlatformOutage'
        ? { status: 'merge-ready', branch: `unit/${unit.id}`, base: units.get(unit.id)?.base, parked: true,
           note: `merge parked on platform outage: ${e.message}` }
        : quarantine(unit, `merge pipeline error: ${e?.message ?? e}`))
      mergeChain = segment.then(() => null, () => null)
      result = await segment
    }
    units.set(unit.id, { ...(rounds ? { rounds } : {}), ...result })
    log(`${unit.id}: ${result.status}`)
    inFlight--
    snapshot()
    notifySettle()
  })()
}

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

// Fail loudly on a malformed graph — a bad edge reference or a cycle otherwise strands
// units as silently-pending: ready() never fires, no error is raised, the wave just ends.
// A cycle should never GET here: the conductor runs the same planCycle before every dispatch and
// returns 'plan-cycle' instead. So this throw means the plan came straight from a root launch (the
// root's error to fix in plan.json) or the conductor wired one anyway (a conductor bug).
{
  const ids = new Set(plan.units.map((u) => u.id))
  for (const e of plan.edges)
    if (!ids.has(e.from) || !ids.has(e.to))
      throw new Error(`plan edge references unknown unit: ${e.from} -> ${e.to}`)
  const cyc = planCycle(plan.units, plan.edges)
  if (cyc)
    throw new Error('plan dependency graph contains a cycle — fix the plan before dispatch: ' +
      cyc.edges.map((e) => `${e.from} -> ${e.to}`).join(', '))
  // A design citation naming an authority that does not exist is a plan-pack defect that would
  // otherwise degrade silently into an empty clause — the exact "invisible to the pipeline"
  // failure designAuthorities exists to end. Fail loud, like the unknown-edge check above.
  for (const u of plan.units)
    for (const cite of u.design ?? [])
      if (!authOf(cite))
        throw new Error(`unit ${u.id}: design citation "${cite}" names no authority in plan.designAuthorities ` +
          `(known ids: ${(plan.designAuthorities ?? []).map((a) => a.id).join(', ') || 'none'})`)
  // A self-referential adopt makes the setup agent's remove-stale-remnants path delete its own
  // source — this destroyed finished work once; refuse at validation.
  // `closes` names existing issue numbers the merge path closes — a malformed entry would ride
  // silently into merge/sweep prompts as garbage gh commands. Fail loud, like the checks above.
  for (const u of plan.units)
    if (u.closes !== undefined && (!Array.isArray(u.closes) ||
        u.closes.some((n) => !Number.isInteger(n) || n <= 0)))
      throw new Error(`unit ${u.id}: \`closes\` must be an array of positive integer issue numbers — fix the plan`)
  // The preview's start string is wrapped in `sh -c '…'` by previewStartCmd, so a single quote in
  // it would close that quote and hand the rest of the string to the courier's shell as commands.
  // Refuse at load, naming the field: an unquotable start is a plan-pack defect with a one-line fix
  // (a script entry, or double quotes), not something to paper over with escaping at compose time.
  if (typeof plan.preview?.start === 'string' && plan.preview.start.includes("'"))
    throw new Error(`plan.preview.start contains a single quote — it is run as \`sh -c '<start>'\` (which is why ` +
      `\`VAR=value cmd\` and \`&&\` chains work there) and a single quote cannot survive that wrapping. ` +
      `Use double quotes, or move the command into a package script: ${plan.preview.start}`)
  for (const u of plan.units)
    if (u.existingBranch && u.existingBranch === `unit/${u.id}`)
      throw new Error(`unit ${u.id}: existingBranch is the unit's own branch unit/${u.id} — setup could delete ` +
        `its own source and recreate it from the wrong base. Anchor the commits under a differently-named ref ` +
        `first (e.g. \`git branch adopt/${u.id} $(git rev-parse unit/${u.id})\`) and set existingBranch to that.`)
}

phase('Setup')
// The integration worktree, as a CLOSED COMMAND LIST (0.14.0). It used to be a three-step prose
// brief — "ensure the branch exists", "verify it is a clean checkout and reset it if not", "report
// the exit code verbatim" — i.e. three goals and a promise, handed to Haiku. Two of the three were
// janitorial ("reset it if not"), and the third was the deciding fact of a two-way door. All three
// are shell now: the branch is created only where `show-ref` says it is absent, the worktree only
// where the path is not already a checkout, and the ancestry test's exit code is printed by the
// SHELL (`; echo $?`) rather than transcribed by a model — which also keeps it off the courier's
// stop-at-first-failure path, since a legitimate `is-ancestor` answer of 1 is not an error.
const intCmds = [
  `git show-ref --verify --quiet refs/heads/${intBranch} || git branch ${intBranch} ${integrationTip}`,
  `test -d '${intWt}' && git -C '${intWt}' rev-parse --git-dir >/dev/null 2>&1 || git worktree add '${intWt}' ${intBranch}`,
  // Idempotent, and the one thing the merge queue cannot do without: a merge on a detached HEAD
  // makes a commit no branch can reach (2026-08-28). Already-on-branch exits 0.
  `git -C '${intWt}' checkout ${intBranch}`,
  `git -C '${intWt}' rev-parse HEAD`,
  `git merge-base --is-ancestor ${integrationTip} ${intBranch}; echo $?`,
]
const intSetup = await courierRun(repo, intCmds, { model: 'haiku', phase: 'Setup', label: 'integration-worktree' },
  `This list prepares the integration branch and its worktree and then READS one ancestry fact. ` +
  `Never "fix" a non-zero exit and never rewind, reset or force a branch to make one zero — the ` +
  `scheduler reads the exit codes and decides. ` + LAUNCH)
if (!intSetup.ok) throw new Error(`integration worktree setup failed: ${intSetup.detail}`)
const intSha = intSetup.out(3)
// The raw exit of `git merge-base --is-ancestor <checkpointed tip> <intBranch>`: 0 = the branch
// merely moved ahead, 1 = the checkpointed tip is NOT on the branch, 128 = it does not resolve.
// Anything unparseable is treated as "not an ancestor", which refuses rather than adopts.
const priorTipAncestorExit = Number.isInteger(Number(intSetup.out(4))) ? Number(intSetup.out(4)) : -1
// Git is the source of truth for the branch; state.json is bookkeeping. A relaunch with a
// stale checkpoint would otherwise fork every unit off the old tip — and, if every unit
// short-circuits at setup, write that stale tip back out, poisoning the next wave.
// STRICTLY ONE-WAY. The reconcile used to fire on mere INEQUALITY and call it "ahead": it moved the
// tip backwards as readily as forwards. 2026-08-28: a merge landed on a detached HEAD, the
// checkpointed tip was that dangling commit, and this line adopted the branch tip over it — a whole
// wave's merged work orphaned, silently, with the log line claiming progress. Adopt only when the
// checkpointed tip is an ANCESTOR of the live branch tip (exit 0). Anything else means our record
// and the branch have diverged, which is corruption, not drift — refuse to dispatch on top of it.
if (!sameSha(intSha, integrationTip)) {
  if (priorTipAncestorExit === 0) {
    log(`integration branch is ahead of the checkpointed tip — reconciled to ${intSha.slice(0, 7)}`)
    integrationTip = intSha
  } else {
    degrade({ label: 'integration-worktree', model: 'haiku', phase: 'Setup', kind: 'tip-regressed',
      what: `checkpointed integration tip ${String(integrationTip).slice(0, 12)} is NOT an ancestor of ` +
        `${intBranch} (tip ${String(intSha).slice(0, 12)}, is-ancestor exit ${priorTipAncestorExit}) — ` +
        `the branch was rewound, or merges landed where no branch can reach them. Wave halted before dispatch.` })
    throw new Error(`integration tip regressed: the checkpointed tip ${integrationTip} is not an ancestor of ` +
      `${intBranch} (now ${intSha}); \`git merge-base --is-ancestor\` exited ${priorTipAncestorExit}. ` +
      `Refusing to dispatch a wave on top of a branch our own record cannot reach. Operator: find the merges ` +
      `(\`git reflog ${intBranch}\`, \`git fsck --unreachable\`), decide which history is real, point ${intBranch} ` +
      `at it, and set state.json's integrationTip to match before relaunching. Nothing was changed.`)
  }
}
const intProv = await provision(intWt, 'provision:integration')
if (!intProv.ok) throw new Error(`integration worktree provisioning failed: ${intProv.detail}`)

// Host-health preflight — every wave, beside the codex probe and for the same reason: a fact about
// the BOX is cheaper to read than to infer from three quarantines. Arc-observed 2026-08-22: a
// devcontainer whose PID 1 was `sleep infinity` accumulated 35,940 zombies, the pid cgroup hit
// 36,350 of 36,792, and wave 3's three full-suite gates all forked into `spawn sh EAGAIN` and were
// quarantined as "environment blocked" — a whole wave of unit verdicts for one host defect that no
// unit caused and none could fix. Closed command list, script-side pass test (the codex-probe
// lesson: never ask the cheapest tier to judge a binary fact), salted with LAUNCH so a resume
// re-reads the box instead of replaying a stale answer.
if (C.envPreflight !== 'off') {
  const waveN = (prior.wave ?? 0) + 1
  // pids.current/pids.max in one `cat` (two lines, in that order); the zombie count; PID 1's comm
  // (REPORTED, never judged — see ZOMBIE_CMD); then the load pair, which seeds `lastLoad` so a
  // degradation raised before any test lane can still cite the host it happened on.
  const cmds = [`cat ${PIDS_CUR} ${PIDS_MAX}`, ZOMBIE_CMD, 'ps -p 1 -o comm=', ...LOAD_CMDS]
  const ep = await courierRun(repo, cmds,
    { model: 'haiku', effort: 'low', phase: 'Setup', label: `env-probe:w${waveN}` },
    `This is a read-only host-health probe. Report what the commands print and judge none of it — ` +
    `whether the numbers are healthy is not yours to assess. Change nothing, kill nothing. ` + LAUNCH)
  if (ep.exit(3) === 0 && ep.exit(4) === 0)
    noteLoad({ loadavg1: Number(ep.out(3).split(/\s+/)[0]), cpuCount: Number(ep.out(4)) })

  // 1. pid-cgroup headroom. `pids.max` reads `max` when the cgroup is unlimited — not a number and
  //    not a problem. An unreadable file (cgroup v1, a non-Linux host) is UNKNOWN, not exhausted:
  //    the guard is a floor under a known fact, never a verdict on an absent one.
  const [cur, max] = ep.out(0).split(/\s+/)
  const curN = Number(cur)
  const maxN = Number(max)
  if (ep.exit(0) !== 0 || !Number.isFinite(curN) || !(max === 'max' || Number.isFinite(maxN)))
    degrade({ label: `env-probe:w${waveN}`, model: 'haiku', phase: 'Setup', kind: 'env-unprobed',
      what: `could not read pid-cgroup headroom (\`cat ${PIDS_CUR} ${PIDS_MAX}\` exited ${ep.exit(0) ?? 'nothing'}: ` +
        `${ep.out(0).slice(0, 120) || '(no output)'}) — the wave runs unguarded on that axis` })
  else if (max !== 'max' && (maxN - curN) / maxN < PIDS_MIN_HEADROOM)
    halt.env = 'env-pids-exhausted'

  // 2. Is PID 1 reaping? Judged on the OUTCOME — the zombie count — never on PID 1's name. Its
  //    comm is read anyway because it is the first thing the operator needs, but it decides
  //    nothing: the devcontainer `sh`/`sleep` idiom reaps, and an allowlist of init names halts a
  //    healthy box while proving nothing about an unlisted one.
  const comm = ep.out(2).split('\n')[0].trim() || '(unread)'
  const zombies = Number(ep.out(1).split(/\s+/)[0])
  if (ep.exit(1) !== 0 || !Number.isFinite(zombies))
    degrade({ label: `env-probe:w${waveN}`, model: 'haiku', phase: 'Setup', kind: 'env-unprobed',
      what: `could not count zombies (\`${ZOMBIE_CMD}\` exited ${ep.exit(1) ?? 'nothing'}: ` +
        `${ep.out(1).slice(0, 120) || '(no output)'}) — the wave runs unguarded on the reaper axis` })
  else if (zombies >= ZOMBIE_HALT) halt.env = halt.env ?? 'env-no-reaper'

  if (halt.env)
    degrade({ label: `env-probe:w${waveN}`, model: 'haiku', phase: 'Setup', kind: halt.env,
      what: (halt.env === 'env-pids-exhausted'
        ? `pid cgroup at ${cur}/${max} — under ${Math.round(PIDS_MIN_HEADROOM * 100)}% headroom, so the next ` +
          `fork storm is a test lane dying of EAGAIN`
        : `${zombies} zombie processes (PID 1 is \`${comm}\`) — orphans are not being reaped, and killed test ` +
          `runs will accumulate until the pid cgroup is full`) +
        `. Wave halted before dispatch: units stay pending, the wave state returns intact and is resumable. Operator: ` +
        `recreate the container with a reaping PID 1 (compose \`init: true\`) — or, if this box is genuinely ` +
        `healthy, set \`config.envPreflight: 'off'\` in the plan and relaunch.` })
}

// Codex availability probe — every wave, because auth expires between waves (ChatGPT-plan
// OAuth) and the Phase-0 preflight is only as fresh as the arc's start. Failure halts the wave
// BEFORE dispatch: units stay pending, state checkpoints, the conductor early-returns to the
// root, and the human re-auths (`codex login` / `--device-auth`) and relaunches. Auth is a
// human act — the harness never attempts it.
{
  const waveN = (prior.wave ?? 0) + 1
  // THREE commands, and the PASS CONDITION IS DECIDED HERE, not by the agent. Asked to judge
  // "is it logged in", Haiku saw `Logged in using ChatGPT`, invented a requirement that the
  // credential be Anthropic's, returned ok:false, and halted a wave whose auth had just driven
  // 111 codex runs (2026-08-26). The courier reports exit codes and verbatim output; the pass test
  // below is the script's. Any credential provider passes — that judgement is not delegated.
  //
  // The third command is the SMOKE, and it exists because the first two answer a question that
  // was not the one being asked. 2026-09-03: the ChatGPT Codex backend 404'd
  // (`turn.failed: unexpected status 404 Not Found … chatgpt.com/backend-api/codex/responses`)
  // while `codex --version` printed a version and `codex login status` still said "Logged in" —
  // the credential was valid, the SERVICE was gone. The probe passed, the wave ran, and it cost
  // 23 `codex-exec` rows, five BLOCKED units, one quarantine and a whole owed boundary. A binary
  // that exists and a token that parses are not availability; the only thing that proves Codex
  // can do work is Codex doing a trivial piece of work, so the probe asks it for one word.
  // Bounded (`timeout 120`, `low` effort, a one-word answer) and read-only by intent — the
  // sandbox flag is composed the way the harness composes it EVERYWHERE (`config.codexSandbox`
  // overriding the role's stated intent), because `-s read-only` needs the bwrap user namespace
  // this devcontainer cannot build and would EPERM on a healthy box: a probe that halts every
  // wave on a working host is worse than the outage it was written for. Which is also why `-C`
  // points at the probe's own scratch directory, never the operator's checkout: with the sandbox
  // wide open, the one place a one-word prompt can do no harm is an empty directory of its own.
  const smokeDir = `${wtRoot}/__codex/roles/probe-w${waveN}`
  const smoke =
    `${codexHome}timeout 120 codex exec -C ${smokeDir} -s ${C.codexSandbox ?? 'read-only'} ` +
    `${C.codexModel ? `-m ${C.codexModel} ` : ''}-c model_reasoning_effort=low ` +
    `-c projects."${smokeDir}".trust_level="trusted" ` +
    `${C.codexProfile ? `-p ${C.codexProfile} ` : ''}--skip-git-repo-check ` +
    `-o ${smokeDir}/last-message.txt 'Reply with exactly the word pong'`
  const cmds = [`${codexHome}codex --version`, `${codexHome}codex login status`,
    `mkdir -p ${smokeDir} && ${smoke}`]
  const cp = await courierRun(repo, cmds,
    { model: 'haiku', effort: 'low', phase: 'Setup', label: `codex-probe:w${waveN}` },
    `This is a read-only availability probe. Report what the commands print and judge none of it — which ` +
    `credential provider is in use (ChatGPT plan, API key, device auth) is not yours to assess and not a ` +
    `failure of any kind. The third command asks Codex itself for one word; whether it answers with that ` +
    `word is not yours to assess either — report its exit code and its output, nothing more. ` +
    `Change nothing. ` + LAUNCH)
  // Mechanical, and deliberately spelled out: `codex login status` prints "Not logged in" when it
  // is not, and a bare /logged in/i test matches that substring.
  const status = cp.out(1)
  const loggedIn = /logged in/i.test(status) && !/not\s+logged\s+in/i.test(status)
  // The smoke's pass test is THE SCRIPT'S, and it is the exit code — never a reading of the text.
  // "Did it say pong?" is a judgment, and a judgment is what a courier must never be handed; a
  // backend that 404s cannot produce a zero exit, which is the whole signal.
  const smokeOk = cp.exit(2) === 0
  // The BACKEND is what failed only when the CLI and the credential both passed first — a courier
  // that stopped at command 1 reported nothing about the smoke, and reading its missing exit code
  // as an outage would send the operator to wait out a provider that is perfectly healthy.
  const backendDown = cp.exit(0) === 0 && loggedIn && !smokeOk
  if (!(cp.exit(0) === 0 && loggedIn && smokeOk)) {
    halt.codex = 'codex-unavailable'
    // Three distinct whys, in the order they are established, because they call for DIFFERENT
    // operator actions: install, re-login, or wait. Collapsing the third into the second is what
    // would send a human to `codex login` during a provider outage that no login can fix.
    const why = cp.exit(0) !== 0 ? `\`codex --version\` exited ${cp.exit(0) ?? 'nothing (no report)'}`
      : !loggedIn ? `\`codex login status\` printed no "logged in" line: ${status.slice(0, 200) || '(no output)'}`
      : `backend/exec smoke failed — \`codex exec … "reply pong"\` exited ` +
        `${cp.exit(2) ?? 'nothing (no report)'}: …${cp.out(2).slice(-300) || '(no output)'}`
    degrade({ label: `codex-probe:w${waveN}`, model: 'haiku', phase: 'Setup', kind: 'codex-unavailable',
      what: `codex CLI unavailable (${why}) — wave halted before dispatch; the wave state returns ` +
        `intact and is resumable. Operator: ` + (backendDown
          ? `the CLI and the credential are both fine and re-logging in will not help — this is the ` +
            `Codex BACKEND. Wait out the outage, then relaunch the arc.`
          : `codex login (or codex login --device-auth headless), then relaunch the arc.`) })
  }
}

// Preview setup: provision the preview's OWN worktree at the wave-start tip and stand the preview
// up there. Nothing here touches the operator's checkout — that is the whole point of __preview.
// Failure never gates the wave: throwing here would gate the arc on its own observability.
if (previewStatus === 'pending') {
  // 1. The worktree itself, from the primary checkout (the only place `git worktree add` can run).
  //    Idempotent by the worktree list, so a relaunch adopts the existing tree instead of failing.
  //    Salted like every other environment probe: this command's answer is a fact about the DISK,
  //    and a resume after a container rebuild that replayed a cached "already there" would skip
  //    the create and leave the wave with no preview worktree at all.
  const wt = await courierRun(repo, [
    previewStopCmd,
    // The guard tests the property the NEXT step actually needs — can the tree at ${prevWt} resolve
    // this tip? — not merely "is that path in our worktree list". wf_c6971376-1a5: a rogue
    // `git worktree add` from the orchestrator's own repo re-pointed the path at THAT repository
    // while our stale list record survived, so `grep -qx` matched, the repair never ran, and both
    // waves' `git checkout --detach <tip>` died with "fatal: unable to read tree". A worktree that
    // cannot see the sha is not this repository's worktree, whatever the list says.
    `git -C '${prevWt}' cat-file -e ${integrationTip}^{commit} 2>/dev/null || ` +
      `{ git worktree remove --force '${prevWt}' 2>/dev/null; git worktree prune; ` +
      `git worktree add --detach '${prevWt}' ${integrationTip}; }`,
    // Read back what the tree can see, so the SCRIPT decides whether the worktree is usable.
    `git -C '${prevWt}' cat-file -t ${integrationTip}^{commit}`,
  ], { model: 'haiku', phase: 'Preview', label: 'preview-worktree' }, previewSweepRetry + LAUNCH)
  const wtUsable = wt.ok && wt.out(2) === 'commit'
  // 2. Deps/env, exactly as the integration worktree gets them. 3. Detach + bring the preview up.
  const pv = wtUsable ? await provision(prevWt, 'provision:preview')
    : { ok: false, detail: wt.ok ? `${prevWt} cannot resolve ${String(integrationTip).slice(0, 12)} — it is not a ` +
      `worktree of ${repo}` : wt.detail }
  const ps = pv.ok ? await previewAdvance(integrationTip, 'preview-setup', true) : { ok: false, detail: pv.detail }
  if (ps.ok && sameSha(ps.sha, integrationTip)) { previewStatus = 'live'; previewSha = integrationTip }
  else {
    previewStatus = 'failed'
    // Loud, not a log line: a dead mirror silently no-ops the explorer AND the design reconcile
    // for the whole wave (arc-observed) — the boundary's owed markers re-queue those jobs, and
    // this entry tells the operator which of the three steps failed and where to look.
    degrade({ label: 'preview-setup', model: 'haiku', phase: 'Preview', kind: 'preview-failed',
      what: `preview mirror never came up (${String(ps.detail || ps.sha || 'no report').slice(0, 300)}) — the wave ` +
        `runs without runtime observability and the boundary will record owed explorer/design markers. Operator: ` +
        `the preview lives in its own worktree at ${prevWt} (log ${prevLog}, pidfile ${prevPid}); your own ` +
        `checkout is never touched. Inspect or \`git worktree remove --force ${prevWt}\` and relaunch.` })
  }
}

const inScope = plan.units.filter((u) => u.inScope)
log(`wave ${serialize().wave}: ${inScope.length} in-scope units, ${C.maxConsults} rescue consults available`)

// `blocked` is a snapshot of one wave's dependency state, NOT a terminal verdict — but nothing
// ever cleared it: ready() requires 'pending', and the record initializer only fires when a record
// is absent. So a unit blocked behind a quarantine that was later superseded and merged stayed
// blocked forever, invisible to arcSummary and undispatchable. 2026-07-18: four in-scope units
// stranded that way, and the root reset them by hand twice. Re-open at wave start whenever the
// blocking dependency is gone; ready() still holds them until it actually merges.
for (let changed = true; changed;) {
  changed = false
  for (const u of inScope) {
    const st = rec(u.id)?.status
    // `deferred` on an in-scope unit is always stale: it was stamped when the unit was out of
    // scope (or transiently withheld) and the plan has since said otherwise.
    // `running`/`merge-ready` at wave START are crash residue — the script just started, so
    // nothing can actually be running. Without this reset the adopt guard in runUnit
    // (prior.units status running) was unreachable on a relaunch and crashed units stranded
    // exactly like the 'blocked' class this loop already heals: ready() requires 'pending',
    // and nothing ever restored it. Reset re-enters dispatch; setup then auto-adopts any
    // committed branch work (rung-3 recovery as documented, now actually mechanical).
    // Crash residue is only residue if the unit did not finish. A `merge-ready` record whose merge
    // then landed (or a `running` one killed after its merge) reset to `pending` and got rebuilt from
    // scratch — the 2026-08-25 regression. Git is asked first, in code, and its answer is terminal.
    if (st === 'running' || st === 'merge-ready') {
      const g = await mergedInGit(u)
      if (g.merged) {
        units.set(u.id, { status: 'merged', branch: `unit/${u.id}`, mergedAt: g.branchSha,
          note: 'crash residue — git says the branch already merged' })
        log(`${u.id}: recorded ${st} at the last checkpoint but git says merged (${g.branchSha.slice(0, 7)}) — not re-dispatched`)
        changed = true
        continue
      }
    }
    if (st === 'deferred' || st === 'running' || st === 'merge-ready' || (st === 'blocked' && !blockedBy(u))) {
      units.set(u.id, { status: 'pending' })
      log(`${u.id}: ${st === 'deferred' ? 'in scope again'
        : st === 'blocked' ? 'unblocked (dependency resolved)'
        : `crash residue (was ${st}) — committed work auto-adopts`} — re-entering dispatch`)
      changed = true
    }
  }
}

while (true) {
  for (const u of inScope.filter(ready)) {
    start(u)
  }
  for (const u of inScope) {
    if (rec(u.id).status === 'pending' && blockedBy(u)) {
      units.set(u.id, { status: 'blocked' })
      log(`${u.id}: blocked (dependency quarantined)`)
      snapshot()
    }
  }
  if (inFlight === 0) break
  await nextSettle()
}

if (C.previewRefresh === 'wave') refreshMirror()   // single advance to the final tip
await previewChain                                  // drain pending mirror advances
// Boundary phase — strictly after all merges and mirror advances (invariant 8). Skipped on a
// halt: the conductor early-returns this wave to the root regardless, and boundary
// spend against a halted wave buys nothing the relaunch's boundary won't.
// Owed jobs still run when the boundary is off — see runBoundary's owed-only mode. A halt of any
// kind still skips everything: the conductor early-returns that wave regardless.
if ((C.boundary !== 'off' || owed.length > 0) && !haltReason()) {
  phase('Boundary')
  await runBoundary().catch((e) => log(`boundary phase failed — continuing (${e?.message ?? e})`))
}
// Reconcile the GitHub issue projection from the final unit map (issue mode only; no-op otherwise).
// Best-effort observability — never gates, so a failure only logs/degrades and the wave still returns.
await syncIssues().catch((e) => log(`issue sync failed — continuing (${e?.message ?? e})`))
snapshot()                                          // last forensic line: mirror + boundary included
// The RETURN value carries this wave's event ledgers; serialize() (the state itself) does not.
// The conductor absorbs them in memory for its own envelope, and persist.mjs is what appends them
// to .roadmap/{degradations,escalations}.jsonl — so no ledger is ever re-transcribed by a model.
return { ...serialize(), degradations, escalations }
