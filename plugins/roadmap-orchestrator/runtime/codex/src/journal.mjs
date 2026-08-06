import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

export class Journal {
  constructor({ root, runId, resume = false }) {
    this.dir = join(root, '__codex-runtime', runId)
    this.runId = runId
    this.resume = resume
    this.entries = []
    this.nextOrdinal = 0
    this.abandoned = false
  }

  async init(manifest) {
    await mkdir(this.dir, { recursive: true })
    this.manifestPath = join(this.dir, 'manifest.json')
    this.callsPath = join(this.dir, 'calls.jsonl')
    this.eventsPath = join(this.dir, 'events.jsonl')
    if (this.resume) {
      let stored
      try { stored = JSON.parse(await readFile(this.manifestPath, 'utf8')) }
      catch (error) { throw new Error(`journal corruption: cannot read manifest: ${error.message}`) }
      if (stored.runId !== this.runId) throw new Error('journal corruption: runId mismatch')
      const text = await readFile(this.callsPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
      try { this.entries = text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
      catch (error) { throw new Error(`journal corruption: invalid calls.jsonl: ${error.message}`) }
      const events = await readFile(this.eventsPath, 'utf8')
        .catch((error) => { throw new Error(`journal corruption: cannot read events.jsonl: ${error.message}`) })
      try { events.split('\n').filter(Boolean).forEach((line) => JSON.parse(line)) }
      catch (error) { throw new Error(`journal corruption: invalid events.jsonl: ${error.message}`) }
      return stored
    }
    const tmp = `${this.manifestPath}.tmp`
    await writeFile(tmp, `${JSON.stringify({ ...manifest, runId: this.runId }, null, 2)}\n`, 'utf8')
    await rename(tmp, this.manifestPath)
    await writeFile(this.callsPath, '', { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error })
    await writeFile(this.eventsPath, '', { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error })
    return manifest
  }

  fingerprint(value) { return hash(value) }

  replay(ordinal, fingerprint) {
    if (this.abandoned) return null
    const entries = this.entries.filter((entry) => entry.ordinal === ordinal)
    const completed = entries.findLast((entry) => entry.status === 'completed')
    if (!completed) {
      // A missing entry is incomplete just as surely as an explicit `started` entry (a queued call can receive an
      // ordinal before it reaches the append). From here onward the journal is a suffix, never a replay source.
      this.abandoned = true
      return null
    }
    if (completed.fingerprint !== fingerprint)
      throw new Error(`journal divergence at ordinal ${ordinal}: expected ${completed.fingerprint}, got ${fingerprint}`)
    return completed
  }

  async append(entry) {
    const handle = await open(this.callsPath, 'a')
    try { await handle.write(`${JSON.stringify(entry)}\n`); await handle.sync() }
    finally { await handle.close() }
    this.entries.push(entry)
  }

  async appendEvent(event) {
    const handle = await open(this.eventsPath, 'a')
    try { await handle.write(`${JSON.stringify(event)}\n`); await handle.sync() }
    finally { await handle.close() }
  }

  async flush() {
    await mkdir(dirname(this.callsPath), { recursive: true })
    const handle = await open(this.callsPath, 'a')
    try { await handle.sync() } finally { await handle.close() }
  }
}
