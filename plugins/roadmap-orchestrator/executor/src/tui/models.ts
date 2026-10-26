import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { LaunchFile } from '../core/records.ts';
import type { Invocation } from './types.ts';

type ModelInfo = Pick<Invocation, 'model' | 'requestedModel' | 'backend' | 'adapter'>;
/** Only explicit launch flags and recorded init metadata identify a model; never the current routing config. */
export class ModelReader {
  #cache = new Map<string, { identity: string; size: number; complete: boolean; info: ModelInfo }>();
  read(launch: LaunchFile | null, path: string): ModelInfo {
    const terminal = launch?.terminal;
    if (terminal?.type === 'command') return {};
    const argv = launch?.argv ?? [];
    const flag = argv.findIndex((arg) => arg === '--model' || arg === '-m');
    const requested = flag >= 0 ? argv[flag + 1] : argv.find((arg) => arg.startsWith('--model='))?.slice(8);
    const base: ModelInfo = { ...(requested ? { requestedModel: requested, model: requested } : {}),
      ...(terminal?.type === 'backend' ? { backend: terminal.session.backend } : {}) };
    let stat;
    try { stat = statSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base; throw error; }
    const identity = `${stat.dev}:${stat.ino}`;
    const cached = this.#cache.get(path);
    if (cached?.identity === identity && stat.size >= cached.size && (cached.complete || stat.size === cached.size)) return { ...base, ...cached.info };
    const fd = openSync(path, 'r'); const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    let bytes: number;
    try { bytes = readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
    let info: ModelInfo = {}; let complete = false;
    for (const text of buffer.subarray(0, bytes).toString().split('\n').slice(0, -1)) {
      let event; try { event = JSON.parse(text); } catch { continue; }
      if (!event || event.type !== 'system' || event.subtype !== 'init') continue;
      complete = true;
      if (typeof event.model === 'string') info.model = event.model;
      const adapter = event.adapter_metadata;
      if (adapter && typeof adapter.name === 'string' && typeof adapter.model === 'string' && ['codex', 'claude'].includes(adapter.backend)) {
        info = { model: adapter.model, backend: adapter.backend, adapter: adapter.name };
      }
      break;
    }
    this.#cache.set(path, { identity, size: stat.size, complete: complete || bytes === 64 * 1024, info });
    if (this.#cache.size > 128) this.#cache.delete(this.#cache.keys().next().value!);
    return { ...base, ...info };
  }
}
export const modelLabel = (inv: Invocation): string => inv.model ? `${inv.model}${inv.adapter ? ' via adapter' : ''}` : 'unavailable';
