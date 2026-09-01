// Drift guard for the prompt constants that harness.mjs and conductor.mjs DELIBERATELY duplicate.
//
// Both files are standalone workflow scripts: the platform loads each as a self-contained body, so
// neither can import from the other and there is nowhere to put a shared module. The duplication is
// therefore permanent and load-bearing, and both files say so in comments ("same const as
// harness.mjs", "Mirrored in conductor.mjs — keep the two in sync"). A comment is not a test: an
// edit to one copy is invisible in review of the other, and the failure mode is silent — the
// conductor's Haiku writers start behaving differently from the harness's for no stated reason.
//
// This suite reads BOTH FILES AS TEXT (never imports or evaluates them — a workflow script's top
// level has bare `return`/`await` and cannot be imported) and compares:
//   (a) STRICT       — byte-identical value
//   (b) WRITE_CHUNK + CK_TABLE + cksumOf + writeVerbatim + runVerbatim — byte-identical value and
//                      byte-identical source (the in-script cksum, the split AND the fan-out that
//                      executes it)
//   (c) TERSE        — same FIRST SENTENCE only (the tails legitimately diverge: the harness copy
//                      adds a findings-specific clause that has no analogue in the conductor)
//   (d) markerFind + MARKER_RULE — byte-identical source/value. These compose the gh find-or-create
//                      search, and its jq predicate is the ONLY thing standing between "adopt by
//                      marker" and GitHub's tokenizing full-text search adopting an unrelated issue
//                      (three live issues clobbered, 2026-08-22). A predicate that drifts in one
//                      script is a silent re-opening of that hole in half the sites.
//
// Extraction anchors on distinctive syntax rather than line numbers so the tests survive edits
// around the constants and fail with a readable, file-naming diff when a copy actually drifts.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HARNESS = fileURLToPath(new URL('../../harness.mjs', import.meta.url))
const CONDUCTOR = fileURLToPath(new URL('../../conductor.mjs', import.meta.url))

const SRC = {
  'harness.mjs': readFileSync(HARNESS, 'utf8'),
  'conductor.mjs': readFileSync(CONDUCTOR, 'utf8'),
}
const FILES = Object.keys(SRC)

/* ------------------------------- extraction ------------------------------- */

// The initializer expression of a top-level `const <name> = ...`, including the ` +`-continued
// lines that follow it. Returns the raw expression TEXT (no normalization) — the caller decides
// whether to compare it raw or evaluate it.
function constExpr(file, name) {
  const src = SRC[file]
  const lines = src.split('\n')
  const head = `const ${name} = `
  const start = lines.findIndex((l) => l.startsWith(head))
  assert.notEqual(start, -1, `could not find a top-level \`${head}\` in ${file} — the anchor this suite keys on is gone`)
  let expr = lines[start].slice(head.length)
  // A multi-line string concatenation continues while the accumulated expression ends in `+`.
  for (let i = start + 1; /\+\s*$/.test(expr); i++) {
    assert.ok(i < lines.length, `unterminated \`${name}\` initializer in ${file}`)
    expr += '\n' + lines[i]
  }
  return expr.replace(/;\s*$/, '')
}

// Evaluate a self-contained literal expression (string concatenation / number). These constants
// reference no identifiers by design; if one ever does, this fails loudly rather than silently
// comparing raw text that happens to match.
function constValue(file, name) {
  const expr = constExpr(file, name)
  try {
    return Function(`"use strict"; return (${expr});`)()
  } catch (e) {
    assert.fail(`\`${name}\` in ${file} is no longer a self-contained literal (${e.message}); ` +
      `this suite can only compare literals — expression was:\n${expr}`)
  }
}

// The full source text of a top-level arrow function, from its declaration line through the
// closing brace at the SAME indent. Each guarded function is declared identically in both files:
//   const writeVerbatim = (path, text, extra = '') => {
//   const runVerbatim = async (plan, opts, prefix = '') => {
// ... so the declaration line (with `sig`, the exact parameter list) is the anchor; the terminator is
// the first later line that is exactly the declaration's indent followed by `}`.
function fnSource(file, name, sig) {
  const lines = SRC[file].split('\n')
  const declRe = new RegExp(`^(\\s*)const ${name} = ${sig.replace(/[()]/g, '\\$&')} => \\{\\s*$`)
  let start = -1
  let indent = ''
  for (let i = 0; i < lines.length; i++) {
    const m = declRe.exec(lines[i])
    if (m) { start = i; indent = m[1]; break }
  }
  assert.notEqual(start, -1,
    `could not find the \`const ${name} = ${sig} => {\` declaration in ${file} — ` +
    `if the signature changed in one file it must change in the other, and this anchor must be updated`)
  const close = `${indent}}`
  for (let i = start + 1; i < lines.length; i++)
    if (lines[i] === close) return lines.slice(start, i + 1).join('\n')
  assert.fail(`no closing \`}\` at indent ${JSON.stringify(indent)} for ${name} in ${file}`)
}

/* ------------------------------ diff reporting ------------------------------ */

function firstDiff(a, b) {
  const al = a.split('\n')
  const bl = b.split('\n')
  for (let i = 0; i < Math.max(al.length, bl.length); i++)
    if (al[i] !== bl[i]) return { line: i + 1, a: al[i], b: bl[i] }
  return null
}

// Fail with a message that names BOTH files and shows the first line that actually differs —
// an "expected X to equal Y" dump of two 1500-character prompt strings is unreadable.
function assertInSync(what, a, b) {
  if (a === b) return
  const d = firstDiff(String(a), String(b))
  assert.fail(
    `${what} has DRIFTED between the two workflow scripts.\n` +
    `  These are duplicated on purpose (neither script can import the other) and both files are ` +
    `commented "keep the two in sync".\n` +
    (d
      ? `  First difference at relative line ${d.line}:\n` +
        `    ${FILES[0]}:   ${JSON.stringify(d.a)}\n` +
        `    ${FILES[1]}: ${JSON.stringify(d.b)}\n`
      : `    ${FILES[0]}:   ${JSON.stringify(String(a).slice(0, 200))}\n` +
        `    ${FILES[1]}: ${JSON.stringify(String(b).slice(0, 200))}\n`) +
    `  Fix by copying one copy over the other. If the divergence is INTENDED, say so in both ` +
    `files' comments and update this test — do not delete it.`)
}

/* ================================== tests ================================== */

test('STRICT (location discipline) is byte-identical in harness.mjs and conductor.mjs', () => {
  const [h, c] = FILES.map((f) => constValue(f, 'STRICT'))
  assert.ok(h.length > 100, 'STRICT should be a substantial instruction, not a stub')
  assertInSync('The STRICT const', h, c)
  // The clause is worthless if it stops naming the behaviour it forbids.
  assert.match(h, /Never substitute/, 'STRICT still forbids cwd substitution')
})

test('WRITE_CHUNK is the same threshold in both scripts', () => {
  const [h, c] = FILES.map((f) => constValue(f, 'WRITE_CHUNK'))
  assert.equal(typeof h, 'number', 'WRITE_CHUNK is a number')
  assertInSync('The WRITE_CHUNK threshold', h, c)
  // A divergent threshold is worse than a divergent prompt: the two scripts would split the SAME
  // state.json differently, so a resume could rewrite the file with a different part boundary.
  assert.ok(h > 1000 && h < 32000, 'WRITE_CHUNK sits below the ~32k output-token response cap')
})

// The in-script POSIX cksum. `CK_TABLE` is an IIFE (`const CK_TABLE = (() => {` … `})()`), so it
// is sliced by its own anchors rather than fnSource; cksumOf is a plain arrow and uses fnSource.
function ckTableSource(file) {
  const lines = SRC[file].split('\n')
  const start = lines.findIndex((l) => l === 'const CK_TABLE = (() => {')
  assert.notEqual(start, -1, `no \`const CK_TABLE = (() => {\` in ${file}`)
  const end = lines.findIndex((l, i) => i > start && l === '})()')
  assert.notEqual(end, -1, `no closing \`})()\` for CK_TABLE in ${file}`)
  return lines.slice(start, end + 1).join('\n')
}

test('cksumOf (the in-script POSIX cksum) has byte-identical source in both scripts', () => {
  const [ht, ct] = FILES.map(ckTableSource)
  assertInSync('The CK_TABLE CRC table', ht, ct)
  const [h, c] = FILES.map((f) => fnSource(f, 'cksumOf', '(s)'))
  assert.ok(h.includes('0x04C11DB7') || ht.includes('0x04C11DB7'), 'the POSIX cksum polynomial')
  assert.ok(h.includes('return { crc: (~crc) >>> 0, bytes }'), 'returns the crc/bytes pair the writer prompts quote')
  assertInSync('The cksumOf function source', h, c)
})

test('writeVerbatim has byte-identical source in both scripts', () => {
  const [h, c] = FILES.map((f) => fnSource(f, 'writeVerbatim', "(path, text, extra = '')"))
  assert.ok(h.includes('<<<PART'), 'the chunked branch is present')
  assert.ok(h.includes('<<<DOCUMENT>>>'), 'the sub-threshold branch hands one writer the whole document')
  assert.ok(h.includes('cksum < ${file}'), 'every writer verifies by cksum')
  assert.ok(!h.includes('wc -c'), 'no writer verifies by byte count (gamed live)')
  // Comments included, deliberately: they are part of what the two copies must keep in sync, and a
  // reader who updates one rationale without the other has already half-forked the function.
  assertInSync('The writeVerbatim function source (comments included)', h, c)
})

test('runVerbatim (the fan-out executor) has byte-identical source in both scripts', () => {
  const [h, c] = FILES.map((f) => fnSource(f, 'runVerbatim', "async (plan, opts, prefix = '')"))
  assert.ok(h.includes('parallel('), 'part writers fan out through the platform `parallel` primitive')
  assert.ok(h.includes(':assemble') && h.includes(':part'), 'sub-agent labels derive from the caller label')
  // The two scripts must fail the same way: a lost part skips assembly (previous file left intact)
  // in both, or a resume could see a partial file from one script and a complete one from the other.
  assertInSync('The runVerbatim function source (comments included)', h, c)
})

test('appendVerbatim (the sidecar append) has byte-identical source in both scripts', () => {
  const [h, c] = FILES.map((f) => fnSource(f, 'appendVerbatim', '(path, text)'))
  assert.ok(h.includes("cat >> ${path} <<'ROADMAP_APPEND'"), 'the append is a quoted here-doc, never an edit tool')
  assert.ok(h.includes('tail -c ${ck.bytes} ${path} | cksum'),
    'and is verified by cksum over the TAIL — the only part of an append-only file the script can know')
  assert.ok(!h.includes('cat > ${path}'), 'an append never truncates the file')
  assert.match(h, /NEVER read, rewrite, reorder, deduplicate, sort or truncate/,
    'the writer cannot reach the rows already on disk')
  // Both scripts append to the SAME .roadmap/degradations.jsonl, interleaved within one run — a
  // divergent append prompt means one of them can corrupt the other's rows.
  assertInSync('The appendVerbatim function source (comments included)', h, c)
})

test('scrubCtrl (control-character scrubbing) is byte-identical in both scripts', () => {
  // scrubCtrl is a multi-line arrow with no `+` continuation, so it is sliced by its own anchors.
  const scrub = (file) => {
    const m = /const CTRL_UNSAFE = .*\n(?:const scrubCtrl = [\s\S]*?\n {2}: v\))/.exec(SRC[file])
    assert.ok(m, `no CTRL_UNSAFE/scrubCtrl pair in ${file}`)
    return m[0]
  }
  const [hf, cf] = FILES.map(scrub)
  assertInSync('The CTRL_UNSAFE + scrubCtrl pair', hf, cf)
  // Both scripts hand transcribed documents to the same Haiku writers; a raw control byte survives
  // JSON.stringify as an escape the transcriber then DECODES, producing an unparseable file.
  assert.match(hf, /padStart\(2, '0'\)/, 'the replacement token is still a printable <0xNN>')
})

test('TERSE opens with the same first sentence in both scripts', () => {
  // Only the OPENING sentence is shared: the harness copy adds "keep each finding to a sentence or
  // two", which is meaningless for the conductor's prompts. The first sentence is the part that
  // states the actual contract (an oversized report loses the work), so that is what is pinned.
  const firstSentence = (s) => {
    const m = /^.*?\.(?=\s|$)/s.exec(s)
    assert.ok(m, 'TERSE should contain at least one full sentence')
    return m[0]
  }
  const [h, c] = FILES.map((f) => firstSentence(constValue(f, 'TERSE')))
  assertInSync('The TERSE const\'s first sentence', h, c)
  assert.match(h, /oversized report fails schema validation/,
    'the shared sentence still states WHY terseness matters, not merely that it is preferred')

  // Both tails must still carry the unexpected-key rule — it is the other half of the contract and
  // the clause most likely to be lost when one copy is reworded.
  for (const f of FILES)
    assert.match(constValue(f, 'TERSE'), /emit no field the schema does not define/,
      `${f}'s TERSE lost the "no undeclared keys" rule`)
})

test('MARKER_RULE (the find-or-create obligations) is byte-identical in both scripts', () => {
  const [h, c] = FILES.map((f) => constValue(f, 'MARKER_RULE'))
  assertInSync('The MARKER_RULE const', h, c)
  assert.match(h, /FIRST line/, 'the rule still names what makes a candidate an actual match')
  assert.match(h, /never fall back to `\.\[0\]\.number`/, 'the fuzzy fallback is still forbidden by name')
  assert.match(h, /CLOSED issue/, 'the closed-issue edit bar survives')
  assert.match(h, /status:merged/, 'and the merged-label bar with it')
})

test('markerFind (the exact-marker search) has byte-identical source in both scripts', () => {
  const [h, c] = FILES.map((f) => constExpr(f, 'markerFind'))
  // The predicate itself, not merely the command shape: `--json number,body,state` is what makes
  // the body readable, and the split/compare is what makes the match exact.
  assert.match(h, /--json number,body,state/, 'the search fetches the body it must verify')
  assert.match(h, /split\("\\\\n"\)\[0\]/, 'it compares the candidate body\'s FIRST LINE')
  assert.ok(!/--jq '\.\[0\]\.number'/.test(h), 'the first-fuzzy-hit form is gone')
  assertInSync('The markerFind search builder', h, c)
})

test('both scripts still declare every shared constant this suite guards', () => {
  // Guards against the quietest failure of all: a constant deleted from one file (inlined,
  // renamed) so the drift tests above silently stop comparing anything real.
  for (const f of FILES)
    for (const name of ['STRICT', 'TERSE', 'WRITE_CHUNK', 'CK_TABLE', 'cksumOf', 'markerFind', 'MARKER_RULE'])
      assert.doesNotThrow(() => constExpr(f, name), `${f} no longer declares ${name}`)
})
