import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Journal } from '../src/journal.mjs'
import { CodexWorkflowRuntime } from '../src/runtime.mjs'
import { parseStructuredOutput, toStrictOutputSchema } from '../src/schema.mjs'

class FakeCodex {
  constructor() { this.options = []; this.prompts = [] }
  startThread(options) {
    this.options.push(options)
    const id = `thread-${this.options.length}`
    return { id, runStreamed: async (prompt) => {
      this.prompts.push(prompt)
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: id }
        yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ok: true }) } }
        yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }
      })() }
    } }
  }
}

const schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] }
const sink = () => { const events = []; return { events, emit: (event) => events.push(event) } }

test('agent uses a fresh SDK thread, structured output, requested effort, and safe sandbox options', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'); const wt = join(root, 'wt')
  const journal = new Journal({ root: wt, runId: 'one' })
  await journal.init({ host: 'codex' })
  const fake = new FakeCodex(); const eventSink = sink()
  const runtime = new CodexWorkflowRuntime({ repo, worktreeRoot: wt,
    modelMap: { opus: 'gpt-test' }, journal, eventSink, codex: fake, concurrency: 1 })
  runtime.rootArgs = { plan: { methodology: { scopePolicy: 'bounded-v1' }, units: [] } }
  runtime.sourceStack.push({ sourceDigest: 'source' })
  assert.deepEqual(await runtime.agent('do it', { model: 'opus', effort: 'high', label: 'impl:u', phase: 'Implement', schema }), { ok: true })
  assert.deepEqual(await runtime.agent('again', { model: 'opus', effort: 'low', label: 'checkpoint', phase: 'Persist', schema }), { ok: true })
  assert.equal(fake.options.length, 2)
  assert.equal(fake.options[0].modelReasoningEffort, 'high')
  assert.equal(fake.options[1].modelReasoningEffort, 'low')
  assert.equal(fake.options[0].sandboxMode, 'workspace-write')
  assert.equal(fake.options[0].approvalPolicy, 'never')
  assert.equal(fake.options[0].networkAccessEnabled, false)
  assert.deepEqual(fake.options[0].additionalDirectories, [wt])
  assert.match(fake.prompts[0], /codex-execution-contract/)
})

test('adapter schema projection requires every transit field and restores optional-field semantics locally', () => {
  const base = { type: 'object', additionalProperties: false, properties: {
    ok: { type: 'boolean' }, detail: { type: 'string' }, nested: { type: 'object', properties: {
      value: { type: 'string' }, note: { type: 'string' },
    }, required: ['value'], additionalProperties: false },
  }, required: ['ok'] }
  const strict = toStrictOutputSchema(base)
  assert.deepEqual(strict.required, ['ok', 'detail', 'nested'])
  assert.deepEqual(strict.properties.detail.type, ['string', 'null'])
  assert.deepEqual(strict.properties.nested.properties.note.type, ['string', 'null'])
  assert.deepEqual(parseStructuredOutput(JSON.stringify({ ok: true, detail: null,
    nested: { value: 'x', note: null } }), base), { ok: true, nested: { value: 'x' } })
})

test('schema-invalid output throws StructuredOutput while an unrecoverable turn failure returns null', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new Journal({ root, runId: 'bad' }); await journal.init({ host: 'codex' })
  const bad = { startThread: () => ({ id: 'bad', runStreamed: async () => ({ events: (async function* () {
    yield { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":"no"}' } }
  })() }) }) }
  const runtime = new CodexWorkflowRuntime({ repo: root, worktreeRoot: root, modelMap: { opus: 'x' },
    journal, eventSink: sink(), codex: bad })
  runtime.sourceStack.push({ sourceDigest: 'source' })
  await assert.rejects(runtime.agent('x', { model: 'opus', label: 'impl:x', schema }), /StructuredOutput/)

  const failedJournal = new Journal({ root, runId: 'failed' }); await failedJournal.init({ host: 'codex' })
  const failed = { startThread: () => ({ id: 'failed', runStreamed: async () => ({ events: (async function* () {
    yield { type: 'turn.failed', error: { message: 'model unavailable' } }
  })() }) }) }
  const failedRuntime = new CodexWorkflowRuntime({ repo: root, worktreeRoot: root, modelMap: { opus: 'x' },
    journal: failedJournal, eventSink: sink(), codex: failed })
  failedRuntime.sourceStack.push({ sourceDigest: 'source' })
  assert.equal(await failedRuntime.agent('x', { model: 'opus', label: 'impl:x', schema }), null)
})

test('resume replays only a matching completed prefix and rejects divergence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = new Journal({ root, runId: 'resume' }); await original.init({ host: 'codex' })
  await original.append({ ordinal: 0, fingerprint: 'same', status: 'completed', parsedResult: { ok: true } })
  await original.append({ ordinal: 1, fingerprint: 'later', status: 'started' })
  const resumed = new Journal({ root, runId: 'resume', resume: true }); await resumed.init({ host: 'codex' })
  assert.deepEqual(resumed.replay(0, 'same').parsedResult, { ok: true })
  assert.equal(resumed.replay(1, 'later'), null)
  assert.equal(resumed.replay(2, 'anything'), null)
  assert.throws(() => {
    const divergent = new Journal({ root, runId: 'x' }); divergent.entries = original.entries
    divergent.replay(0, 'different')
  }, /journal divergence/)

  const gap = new Journal({ root, runId: 'gap' })
  gap.entries = [{ ordinal: 1, fingerprint: 'later', status: 'completed', parsedResult: { late: true } }]
  assert.equal(gap.replay(0, 'missing'), null)
  assert.equal(gap.replay(1, 'later'), null, 'a later completion is suffix after the first missing ordinal')
})

test('nested conductor-to-harness uses one runtime and rejects a second nesting level', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-nested-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const child = join(root, 'child.mjs'); const parent = join(root, 'parent.mjs'); const grand = join(root, 'grand.mjs')
  await writeFile(child, `export const meta = {name:'child'}\nreturn {child:true}\n`)
  await writeFile(parent, `export const meta = {name:'parent'}\nreturn workflow({scriptPath:args.child},{grand:args.grand})\n`)
  await writeFile(grand, `export const meta = {name:'grand'}\nreturn workflow({scriptPath:args.grand},{})\n`)
  const journal = new Journal({ root, runId: 'nested' }); await journal.init({ host: 'codex' })
  const runtime = new CodexWorkflowRuntime({ repo: root, worktreeRoot: root, modelMap: {}, journal, eventSink: sink(), codex: {} })
  assert.deepEqual(await runtime.execute(parent, { child }), { child: true })
  await assert.rejects(runtime.execute(parent, { child: grand, grand }), /nesting exceeds one level/)
})

test('stop prevents a call queued on the concurrency semaphore from dispatching', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-stop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let releaseFirst; let reportStarted
  const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve })
  const firstStarted = new Promise((resolve) => { reportStarted = resolve })
  const fake = { calls: 0, startThread() {
    this.calls++; reportStarted()
    return { id: 'one', runStreamed: async () => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'one' }
      await firstMayFinish
      yield { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }
      yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
    })() }) }
  } }
  const journal = new Journal({ root, runId: 'signal' }); await journal.init({ host: 'codex' })
  const runtime = new CodexWorkflowRuntime({ repo: root, worktreeRoot: root, modelMap: { haiku: 'x' },
    journal, eventSink: sink(), codex: fake, concurrency: 1 })
  runtime.sourceStack.push({ sourceDigest: 'source' })
  const first = runtime.agent('one', { model: 'haiku', label: 'one', schema })
  await firstStarted
  const queued = runtime.agent('two', { model: 'haiku', label: 'two', schema })
  runtime.stop(); releaseFirst()
  assert.deepEqual(await first, { ok: true })
  assert.equal(await queued, null)
  assert.equal(fake.calls, 1)
})
