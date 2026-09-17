#!/usr/bin/env node
// launch-pack.mjs — hand a launch its plan.json and state.json WITHOUT a model in the data path.
//
// WHY THIS EXISTS. A workflow script has no filesystem, so since 0.14.0 its first act on a root
// launch was a Haiku courier TRANSCRIBING both files into a structured report, verified by cksum.
// The verification always worked; the transport did not. Five transports in three weeks died the
// same way — plain text lost an escape level (2026-09-02, 09-04), the per-backslash sentinel came
// back doubled (09-14), base64 diverged into repetition at 1.5 KB, a 30 KB state stopped at 6.4 K
// characters twice (09-16), and on 2026-09-17 the courier RETYPED the composed `sed` itself,
// un-doubling its backslashes so every plain quote in a backslash-free file became `@q@`. Each fix
// was a better encoding of the same mistake: a model was being asked to copy a document.
//
// The platform already has a way to put data into a run with no model at all: `workflow({scriptPath})`
// loads a script file off disk and returns whatever it returns. So this tool — a plain Node process,
// like persist.mjs — writes a tiny workflow script whose whole body is `return <the two files, as
// text>`, and harness.mjs / conductor.mjs load it (`launchPack`). Probed live before it was built
// (2026-09-17): 68 KB carrying `\"`, `\\`, a raw em dash, a literal backslash-u sequence and U+2028
// came back byte-exact in 91 ms with zero agents; an absent file throws catchably.
//
//   node launch-pack.mjs --roadmap <absolute .roadmap dir> [--launch-id <id>]
//
// Run it before EVERY launch and every resume — it mints the fresh `launchId` the envelope needs and
// prints both values the envelope takes: `launchId`, and `pack` (the absolute path it wrote,
// `<roadmapDir>/launch/pack-<launchId>.mjs`). It also drops a `launch/.gitignore` of `*`: a pack
// duplicates plan+state and must never be committed.
//
// THE ENVELOPE NAMES THE TRANSPORT. `args.pack` present -> the script loads that file and nothing
// else, and a file it cannot load is a loud `pack-missing` throw; `args.pack` absent -> the legacy
// courier read. The choice is never made by looking at the disk, because persist.mjs REPLAYS the run
// later from the same envelope: a route that depended on which files happened to exist at replay
// time would send the replay down a path the live run never took, asking the journal for prompts it
// does not hold.
//
// WRITE-ONCE PER launchId, AND NEVER PRUNED HERE. The replay executes this same file to feed itself
// the pack, and persist.mjs REWRITES plan.json and state.json — so a pack regenerated under a used
// id would hand the replay a different document than the live run saw (`wx` refuses the overwrite),
// and a pack deleted before its run was persisted makes that run unreplayable. Packs are a few tens
// of KB; they go when the arc is closed out (SKILL.md: delete `launch/`), not before.
//
// THIS FILE NEVER CALLS A MODEL. Exit codes: 0 = written, 1 = error (nothing written).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

export const PACK_FILES = ['plan.json', 'state.json']
// The file name a launchId maps to. The scripts never compose this path themselves — the root hands
// them the one this tool printed, as `args.pack` — so the sanitiser is this file's alone.
export const PACK_SAFE = (id) => String(id).replace(/[^A-Za-z0-9_.-]+/g, '-')
export const packPath = (roadmapDir, launchId) => path.join(roadmapDir, 'launch', `pack-${PACK_SAFE(launchId)}.mjs`)

// The script text. `meta` must be a PURE LITERAL and must open the file; the body is one `return`.
// JSON is a JavaScript expression, so `JSON.stringify` of the payload is the literal — with U+2028 and
// U+2029 escaped, since they are line terminators to older parsers and cost nothing to escape. The
// files travel as TEXT, not as parsed objects: the script then verifies the exact bytes against the
// disk's own `cksum` and runs the same `JSON.parse` it always ran, and a `__proto__` key inside a
// plan can never become an object-literal prototype assignment.
export function packScript(launchId, files) {
  const literal = JSON.stringify({ launchId, files })
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029')
  return 'export const meta = {\n' +
    "  name: 'roadmap-launch-pack',\n" +
    "  description: 'Launch pack: plan.json and state.json handed to the run as data (no agents)',\n" +
    '}\n' +
    `return ${literal}\n`
}

export const mintLaunchId = (now = new Date()) =>
  `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`

export async function writeLaunchPack(roadmapDir, launchId = mintLaunchId()) {
  if (!path.isAbsolute(roadmapDir)) throw new Error(`--roadmap must be an absolute path (got ${roadmapDir})`)
  const files = {}
  for (const name of PACK_FILES) {
    const file = path.join(roadmapDir, name)
    if (!existsSync(file)) throw new Error(`${file} does not exist — write the plan pack first`)
    files[name] = await readFile(file, 'utf8')
    try { JSON.parse(files[name]) } catch (e) { throw new Error(`${file} does not parse — ${e.message}`) }
  }
  const dir = path.join(roadmapDir, 'launch')
  await mkdir(dir, { recursive: true })
  const ignore = path.join(dir, '.gitignore')
  if (!existsSync(ignore)) await writeFile(ignore, '*\n')
  const file = packPath(roadmapDir, launchId)
  try { await writeFile(file, packScript(launchId, files), { flag: 'wx' }) }
  catch (e) {
    if (e?.code === 'EEXIST')
      throw new Error(`launchId ${launchId} already has a pack (${file}) — a launchId is never reused; omit --launch-id to mint a fresh one`)
    throw e
  }
  return { launchId, file, bytes: Object.fromEntries(PACK_FILES.map((n) => [n, Buffer.byteLength(files[n])])) }
}

/* ------------------------------- CLI ----------------------------------- */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  const argv = process.argv.slice(2)
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const roadmapDir = flag('roadmap')
  if (!roadmapDir) {
    console.error('usage: node launch-pack.mjs --roadmap <absolute .roadmap dir> [--launch-id <id>]')
    process.exit(1)
  }
  try {
    const r = await writeLaunchPack(roadmapDir, flag('launch-id'))
    console.log(`OK launchId=${r.launchId} pack=${r.file} ${PACK_FILES.map((n) => `${n}=${r.bytes[n]}b`).join(' ')}`)
    console.log(`Put both in the launch envelope: args.launchId = "${r.launchId}", args.pack = "${r.file}". Run this ` +
      'again before every launch and every resume — a launchId is never reused.')
    // The one thing the scripts cannot contain (RATIONALE §23): said here because this is the last
    // command the root runs before a launch.
    console.log('BEFORE YOU LAUNCH: the Workflow runtime relays the user\'s LATEST message in this session to every agent ' +
      'the run dispatches, as "the only user voice". If that message names an action (delete, reset, push, clean up, ' +
      '"when done ..."), do it yourself first or ask the user for a neutral go-ahead — an agent has acted on one.')
  } catch (e) {
    console.error(`launch-pack: ${e.message}`)
    process.exit(1)
  }
}
