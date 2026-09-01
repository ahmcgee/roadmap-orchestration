// Zero-token script loader — generalizes the parse.sh AsyncFunction idiom into a
// runnable harness for a workflow script. Reads a workflow .mjs, strips its single
// leading `export ` (the `export const meta` line — the same transform parse.sh
// applies so top-level `return`/`await` parse), and wraps the body in an
// AsyncFunction whose parameters are exactly the workflow globals. The returned
// runner accepts a globals bag and supplies honest defaults for anything omitted,
// so a caller only injects what it drives (normally just `args` + an `agent`).
//
// ONE loader, two callers: the `evals/unit` simulations drive a script with scripted
// fakes, and `persist.mjs` replays a real run against its own journal. Both need the
// same wrapper and the same `parallel`/`pipeline` stand-ins, and two copies of this
// would drift apart exactly where a divergence is hardest to see.
import { readFile } from 'node:fs/promises'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Minimal-but-honest `parallel`: run each thunk; a throw resolves THAT slot to null
// (never rejects the whole batch). Mirrors the "a failure resolves the slot, the batch
// survives" contract the workflow platform gives.
async function parallel(thunks = []) {
  return Promise.all(
    thunks.map(async (t) => {
      try {
        return await t()
      } catch {
        return null
      }
    }),
  )
}

// Minimal-but-honest `pipeline`: push each item through the ordered stages. A stage
// callback receives (prev, originalItem, index); a throwing stage drops that item to
// null (the rest of the batch is unaffected).
async function pipeline(items = [], stages = []) {
  return Promise.all(
    items.map(async (item, index) => {
      let prev = item
      try {
        for (const stage of stages) prev = await stage(prev, item, index)
        return prev
      } catch {
        return null
      }
    }),
  )
}

const noop = () => {}

// Defaults for every global the AsyncFunction body can reference. log/phase are no-ops
// (a caller that wants to record them passes its own). budget/parallel/pipeline are the
// honest stand-ins above. agent/workflow throw loudly if the script reaches for one a
// test forgot to inject — silence there would mask a real dispatch.
const defaultGlobals = () => ({
  args: {},
  agent: async () => {
    throw new Error('loadScript: script called agent() but no `agent` global was provided')
  },
  workflow: async () => {
    throw new Error('loadScript: script called workflow() but no `workflow` global was provided')
  },
  log: noop,
  phase: noop,
  budget: { total: null, spent: () => 0, remaining: () => Infinity },
  parallel,
  pipeline,
})

// loadScript(absPath) → async runner(globals) → the script's resolved return value
// (for the harness: its serialize() wave-state object). Throws from the script (plan
// validation, integration-setup failure) surface as a rejected runner promise.
export async function loadScript(absPath) {
  const raw = await readFile(absPath, 'utf8')
  const src = raw.replace(/^export /m, '') // strip the single `export const meta` — as parse.sh does
  const compiled = new AsyncFunction(
    'args',
    'agent',
    'workflow',
    'log',
    'phase',
    'budget',
    'parallel',
    'pipeline',
    src,
  )
  return async function run(globals = {}) {
    const g = { ...defaultGlobals(), ...globals }
    return compiled(g.args, g.agent, g.workflow, g.log, g.phase, g.budget, g.parallel, g.pipeline)
  }
}

export { parallel, pipeline }
