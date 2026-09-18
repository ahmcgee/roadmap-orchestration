// launch-pack.mjs — the tool that takes the model out of the launch pack's data path (0.18.0).
//
// The properties that matter, each one a way the transport it replaces actually failed:
//   * the two files come back BYTE-EXACT through the real script loader, whatever they contain —
//     `\"` inside a shell command (2026-09-14), doubled backslashes, a literal backslash-u sequence,
//     raw non-ASCII, U+2028 (a line terminator to older parsers), a `__proto__` key;
//   * a launchId is WRITE-ONCE: persist.mjs replays the run from this same file after it has
//     rewritten plan.json and state.json, so a regenerated pack would feed the replay a different
//     document than the live run saw;
//   * nothing is pruned here — a pack deleted before its run is persisted makes it unreplayable;
//   * a pack is never committable (`launch/.gitignore`), and a pack that does not parse is never written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadScript } from '../../script-loader.mjs'
import { writeLaunchPack, packScript, mintLaunchId, packPath } from '../../launch-pack.mjs'
import { sysCksum } from './fakes.mjs'

const TOOL = fileURLToPath(new URL('../../launch-pack.mjs', import.meta.url))
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
const roadmap = (plan, state) => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'roadmap-launch-pack-')), '.roadmap')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'plan.json'), plan)
  writeFileSync(path.join(dir, 'state.json'), state)
  return dir
}
// Every shape that has broken a courier copy, plus the ones a JS literal could break on its own.
const NASTY_PLAN = `${JSON.stringify({
  units: [{ id: 'a', title: 'sh -c "echo \\"hi\\" && x"', cmd: "sed -e 's/\\\\\"/@q@/g'", win: 'C:\\\\dir\\\\',
    dash: `em ${String.fromCharCode(0x2014)} dash`, sep: `a${LS}b${PS}c`, marker: '@q@ @bs@ @u2014@' }],
  edges: [],
}, null, 2).replace('"edges"', '"__proto__": { "polluted": true },\n  "literal": "\\u2014 stays six characters",\n  "edges"')}\n`
const STATE = '{"wave":3,"note":"line1\\nline2\\ttab"}'   // no trailing newline: bytes are bytes

test('both files come back byte-exact through the real loader, whatever they contain', async () => {
  const dir = roadmap(NASTY_PLAN, STATE)
  const { launchId, file } = await writeLaunchPack(dir, 'L1')
  assert.equal(file, packPath(dir, 'L1'))
  const pack = await (await loadScript(file))({})
  assert.equal(pack.launchId, launchId)
  assert.equal(pack.files['plan.json'], NASTY_PLAN, 'plan.json: every escape form, raw glyph and separator intact')
  assert.equal(pack.files['state.json'], STATE, 'state.json: not even a trailing newline is added')
  // The freshness check the scripts run is `cksum` of the disk against cksumOf(text): same bytes, same line.
  assert.equal(sysCksum(pack.files['plan.json']), sysCksum(readFileSync(path.join(dir, 'plan.json'), 'utf8')))
  assert.deepEqual(Object.keys(JSON.parse(pack.files['plan.json'])).includes('__proto__'), true,
    'a `__proto__` key travels as TEXT and is parsed by JSON.parse — never evaluated as an object literal')
  assert.equal({}.polluted, undefined)
})

test('the script text is a pure-literal meta, then one return — and carries no raw line separator', () => {
  const text = packScript('L1', { 'plan.json': `a${LS}b`, 'state.json': `c${PS}d` })
  assert.match(text, /^export const meta = \{\n  name: 'roadmap-launch-pack',\n  description: '[^'\n]+',\n\}\nreturn \{/)
  assert.ok(!text.includes(LS) && !text.includes(PS), 'U+2028/U+2029 are escaped, so no parser can read one as a line break')
  assert.equal(text.split('\n').filter((l) => l.startsWith('export ')).length, 1,
    'exactly one `export` line — the loader strips the first one it finds, and a JSON payload can never start a line with it')
})

test('a launchId is write-once, and nothing is ever pruned', async () => {
  const dir = roadmap('{"units":[],"edges":[]}\n', '{"wave":0}\n')
  for (let i = 0; i < 12; i++) await writeLaunchPack(dir, `L${i}`)
  await assert.rejects(writeLaunchPack(dir, 'L3'), /already has a pack .* a launchId is never reused/)
  assert.equal(readdirSync(path.join(dir, 'launch')).filter((f) => f.startsWith('pack-')).length, 12,
    'twelve launches, twelve packs: a pack deleted before its run is persisted makes that run unreplayable')
  assert.equal(readFileSync(path.join(dir, 'launch', '.gitignore'), 'utf8'), '*\n', 'and none of them can be committed')
})

test('a pack is never written from a file that does not parse, from a relative dir, or over a missing file', async () => {
  const dir = roadmap('{"units":[', '{"wave":0}\n')
  await assert.rejects(writeLaunchPack(dir, 'L1'), /plan\.json does not parse/)
  assert.ok(!existsSync(packPath(dir, 'L1')))
  await assert.rejects(writeLaunchPack('relative/.roadmap', 'L1'), /absolute path/)
  await assert.rejects(writeLaunchPack(path.join(path.dirname(dir), 'nowhere'), 'L1'), /does not exist/)
})

test('the CLI mints a fresh launchId and prints both envelope values', () => {
  const dir = roadmap('{"units":[],"edges":[]}\n', '{"wave":0}\n')
  const out = execFileSync('node', [TOOL, '--roadmap', dir], { encoding: 'utf8' })
  const m = /^OK launchId=(\S+) pack=(\S+) plan\.json=\d+b state\.json=\d+b$/m.exec(out)
  assert.ok(m, out)
  assert.match(m[1], /^\d{8}T\d{6}Z-[0-9a-f]{6}$/, 'a timestamp plus entropy: fresh on every launch AND every resume')
  assert.equal(m[2], packPath(dir, m[1]))
  assert.ok(existsSync(m[2]))
  assert.match(out, /args\.launchId = ".*", args\.pack = "/, 'and says where each value goes')
  assert.notEqual(mintLaunchId(), mintLaunchId())
  assert.equal(packPath('/r', 'my id/../x'), '/r/launch/pack-my-id-..-x.mjs', 'an id can never climb out of launch/')
})
