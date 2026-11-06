import type { Waited, WaitReason } from '../core/waiting.ts';

/** In-memory integration of the reasons from the previous evaluation up to this one. */
export class WaitAccumulator {
  #at: number;
  #reasons: readonly WaitReason[] = [];
  #totalMs = 0;
  readonly #byReasonMs: Partial<Record<WaitReason, number>> = {};

  constructor(at = Date.now()) { this.#at = at; }

  observe(reasons: readonly WaitReason[], at = Date.now()): void {
    const ms = Math.max(0, at - this.#at);
    if (this.#reasons.length > 0) this.#totalMs += ms;
    for (const reason of this.#reasons) this.#byReasonMs[reason] = (this.#byReasonMs[reason] ?? 0) + ms;
    this.#at = at;
    this.#reasons = [...new Set(reasons)];
  }

  measured(): Waited { return { totalMs: this.#totalMs, byReasonMs: { ...this.#byReasonMs } }; }
  reasons(): readonly WaitReason[] { return this.#reasons; }
}
