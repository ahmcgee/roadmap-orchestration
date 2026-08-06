import { Codex } from '@openai/codex-sdk'
import { loadWorkflow } from '../../workflow-loader.mjs'
import { createBudget, parallel, pipeline } from '../../workflow-primitives.mjs'
import { normalizeEffort } from './config.mjs'
import { adaptPrompt, digest, PROMPT_PROFILE_VERSION } from './prompt-profile.mjs'
import { parseStructuredOutput, toStrictOutputSchema } from './schema.mjs'

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = [] }
  async acquire() {
    if (this.active < this.limit) { this.active++; return }
    await new Promise((resolve) => this.waiters.push(resolve)); this.active++
  }
  release() { this.active--; this.waiters.shift()?.() }
}

const unitIdFromLabel = (label = '') => {
  const tail = label.split(':')[1]
  return tail?.split('#')[0] ?? null
}

export class CodexWorkflowRuntime {
  constructor({ repo, worktreeRoot, modelMap, journal, eventSink, concurrency = 8, maxCalls = 1000,
    network = false, sandboxMode = 'workspace-write', codex = null, CodexClass = Codex }) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer')
    if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new Error('maxCalls must be a positive integer')
    if (!['workspace-write', 'danger-full-access'].includes(sandboxMode))
      throw new Error('sandboxMode must be workspace-write or danger-full-access')
    this.repo = repo
    this.worktreeRoot = worktreeRoot
    this.modelMap = modelMap
    this.journal = journal
    this.eventSink = eventSink
    this.semaphore = new Semaphore(concurrency)
    this.maxCalls = maxCalls
    this.callCount = 0
    this.network = network
    this.sandboxMode = sandboxMode
    // Explicit child environment prevents an ambient API key from silently changing billing.
    const env = { ...process.env }
    delete env.OPENAI_API_KEY
    this.codex = codex ?? new CodexClass({ env })
    this.stopping = false
    this.depth = 0
    this.sourceStack = []
    this.rootArgs = null
  }

  stop() { this.stopping = true }

  scopeFor(label) {
    const plan = this.rootArgs?.plan ?? {}
    const scopePolicy = plan.methodology?.scopePolicy ?? 'legacy'
    const id = unitIdFromLabel(label)
    const unit = plan.units?.find((candidate) => candidate.id === id)
    const scopeMode = unit?.scopeMode ?? (scopePolicy === 'bounded-v1' && unit?.kind === 'code' ? 'feature' : 'legacy')
    return { scopePolicy, scopeMode }
  }

  async agent(basePrompt, opts = {}) {
    if (this.stopping) return null
    if (!opts.schema) throw new Error(`invalid adapter call ${opts.label ?? '(unlabeled)'}: schema is required`)
    if (!this.modelMap[opts.model]) throw new Error(`invalid adapter call: unmapped semantic tier ${opts.model}`)
    const ordinal = this.callCount++
    if (ordinal >= this.maxCalls) throw new Error(`Codex call ceiling exceeded (${this.maxCalls})`)
    const concreteModel = this.modelMap[opts.model]
    const effort = normalizeEffort(opts.effort, opts.model)
    const sourceDigest = this.sourceStack.at(-1)?.sourceDigest
    const scope = this.scopeFor(opts.label)
    const adapted = adaptPrompt(basePrompt, { label: opts.label, ...scope })
    const outputSchema = toStrictOutputSchema(opts.schema)
    const baseSchemaDigest = digest(opts.schema)
    const schemaDigest = digest(outputSchema)
    const fingerprintFields = {
      ordinal, sourceDigest, basePromptHash: adapted.basePromptHash,
      adaptedPromptHash: adapted.adaptedPromptHash, schemaDigest, label: opts.label,
      phase: opts.phase, semanticTier: opts.model, concreteModel, effort,
      methodology: scope.scopePolicy, scopeMode: scope.scopeMode, baseSchemaDigest,
      promptProfileVersion: PROMPT_PROFILE_VERSION,
    }
    const fingerprint = this.journal.fingerprint(fingerprintFields)
    const replayed = this.journal.replay(ordinal, fingerprint)
    if (replayed) {
      this.eventSink.emit({ type: 'call.completed', ordinal, label: opts.label, phase: opts.phase,
        model: concreteModel, effort, replayed: true, usage: replayed.usage })
      return replayed.parsedResult
    }
    if (this.stopping) return null
    await this.semaphore.acquire()
    try {
      // A signal can arrive while this call waits behind the global semaphore. Never turn a queued call into a
      // new paid dispatch after shutdown has begun.
      if (this.stopping) return null
      const started = { ...fingerprintFields, fingerprint, status: 'started', threadId: null,
        promptDigest: adapted.adaptedPromptHash, schemaDigest }
      await this.journal.append(started)
      this.eventSink.emit({ type: 'call.started', ordinal, label: opts.label, phase: opts.phase,
        model: concreteModel, effort })
      let thread
      try {
        thread = this.codex.startThread({
          model: concreteModel,
          modelReasoningEffort: effort,
          workingDirectory: this.repo,
          additionalDirectories: [this.worktreeRoot],
          sandboxMode: this.sandboxMode,
          approvalPolicy: 'never',
          networkAccessEnabled: this.network || !!(this.rootArgs?.plan?.tracking === 'issues'),
          webSearchMode: 'disabled',
        })
      } catch (error) {
        throw new Error(`adapter failed to start thread: ${error.message}`)
      }
      let finalResponse = null
      let usage = null
      let threadId = null
      let failed = null
      try {
        const streamed = await thread.runStreamed(adapted.prompt, { outputSchema })
        for await (const event of streamed.events) {
          if (event.type === 'thread.started') threadId = event.thread_id
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') finalResponse = event.item.text
          if (event.type === 'turn.completed') usage = event.usage
          if (event.type === 'turn.failed' || event.type === 'error') failed = event.error?.message ?? event.message
          await this.journal.appendEvent({ ordinal, event })
        }
      } catch (error) {
        failed ??= error.message
      }
      if (failed || finalResponse == null) {
        await this.journal.append({ ...fingerprintFields, fingerprint, status: 'failed', threadId: threadId ?? thread.id,
          usage, diagnostics: failed ?? 'turn ended without an agent message' })
        this.eventSink.emit({ type: 'call.failed', ordinal, label: opts.label, phase: opts.phase,
          model: concreteModel, effort, message: failed ?? 'no final response' })
        return null
      }
      const parsedResult = parseStructuredOutput(finalResponse, opts.schema)
      await this.journal.append({ ...fingerprintFields, fingerprint, status: 'completed', threadId: threadId ?? thread.id,
        parsedResult, usage, diagnostics: null })
      this.eventSink.emit({ type: 'call.completed', ordinal, label: opts.label, phase: opts.phase,
        model: concreteModel, effort, replayed: false, usage })
      return parsedResult
    } finally {
      this.semaphore.release()
    }
  }

  async execute(scriptPath, args, depth = 0) {
    if (depth > 1) throw new Error('workflow nesting exceeds one level (conductor may invoke harness; harness must remain leaf-only)')
    if (depth === 0) this.rootArgs = args
    const loaded = await loadWorkflow(scriptPath)
    this.sourceStack.push(loaded)
    const workflow = async (ref, childArgs) => {
      if (depth >= 1) throw new Error('workflow nesting exceeds one level (harness cannot invoke another workflow)')
      if (!ref?.scriptPath) throw new Error('nested workflow requires {scriptPath}')
      return this.execute(ref.scriptPath, childArgs, depth + 1)
    }
    try {
      return await loaded.run({
        args,
        agent: this.agent.bind(this),
        workflow,
        log: (message) => this.eventSink.emit({ type: 'log', message }),
        phase: (name) => this.eventSink.emit({ type: 'phase', phase: name }),
        budget: createBudget(),
        parallel,
        pipeline,
      })
    } finally {
      this.sourceStack.pop()
    }
  }
}
