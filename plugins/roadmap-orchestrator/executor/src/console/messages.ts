import { getHeapStatistics } from 'node:v8';
import type { MessagePort } from 'node:worker_threads';
import type { Run } from '../cli/locate.ts';
import type { ArcId } from '../core/ids.ts';
import type { ConsoleCode } from '../observation/protocol.ts';
import type { Metadata } from './view-protocol.ts';

/** Worker requests are either coalescible reads or ordered subscription mutations. */
export type ConsoleRequest =
  /** `patient`: a browser read, answered from the observation as it stands; the CLI's strict read waits for a check made after it arrived. */
  | Readonly<{ kind: 'read'; path: string[]; params: Record<string, string>; patient?: true }>
  | Readonly<{ kind: 'subscribe' | 'unsubscribe'; arc: string; params?: Record<string, string> }>
  | Readonly<{ kind: 'history-subscribe' | 'history-unsubscribe'; arc: string; invocation: string }>;
type ErrorBody = Readonly<{ code: ConsoleCode; message: string }>;

/** Main to the serve worker. */
export type ToServe =
  /** `arrivedAt`: when main received the request (a strict read is answered by a check made after it). */
  | ConsoleRequest & Readonly<{ id: number; arrivedAt: number }>
  /** The request's caller left (its budget ran out): drop it, compute nothing for it. */
  | Readonly<{ kind: 'cancel'; id: number }>
  /** Every two seconds: recompute the maintained arcs. */
  | Readonly<{ kind: 'tick' }>
  /** The serve end of a new collector's channel. */
  | Readonly<{ kind: 'collector'; arc: ArcId; port: MessagePort }>
  /** A collector exited: reads of its arc answer this until it is back; `stopped`: it is not restarted, so every read answers this. */
  | Readonly<{ kind: 'collector-down'; arc: ArcId; error: ErrorBody; stopped: boolean }>
  /** Main asks for a heap report. */
  | Readonly<{ kind: 'report' }>;

/** The serve worker to main. */
export type FromServe =
  | Readonly<{ kind: 'ready' }>
  /** A read's reply: the response body, already serialized, and the envelope's `checkedAt` when it has one. */
  | Readonly<{ kind: 'reply'; id: number; json: string; checkedAt: string | null }>
  /** A control request's reply (a subscription's registration notice). */
  | Readonly<{ kind: 'value'; id: number; value: unknown }>
  | Readonly<{ kind: 'error'; id: number; error: ErrorBody }>
  /** A strict read waits for its arc's first observation: its two seconds start at `admitted`. */
  | Readonly<{ kind: 'cold' | 'admitted'; id: number }>
  /** What a revision or heartbeat notice carries, and the journal byte the arc is published through. */
  | Metadata & Readonly<{ kind: 'checked'; offset: number }>
  | Readonly<{ kind: 'history'; arc: ArcId; invocation: string; data: unknown }>
  | Readonly<{ kind: 'history-error'; arc: ArcId; invocation: string; error: ErrorBody }>
  /** An arc's capture failed (not a race): its stream gets an error notice. */
  | Readonly<{ kind: 'arc-error'; arc: ArcId; error: ErrorBody }>
  /** The selected arc and whether it is observed (or failed): API discovery waits for that. */
  | Readonly<{ kind: 'selected'; selected: ArcId | null; ready: boolean }>
  | Readonly<{ kind: 'maintain'; arc: ArcId; run: Run }>
  | Readonly<{ kind: 'release'; arc: ArcId }>
  /** A strict read waits on this arc: its collector should check now. */
  | Readonly<{ kind: 'check-now'; arc: ArcId }>
  /** The invocation directories whose history a stream follows: their collector watches them, so a change is checked at once. */
  | Readonly<{ kind: 'follow'; arc: ArcId; dirs: readonly string[] }>
  | HeapReport<ServeSizes>;

/** Main to a collector. */
export type ToCollector = Readonly<{ kind: 'check-now' }> | Readonly<{ kind: 'follow'; dirs: readonly string[] }> | Readonly<{ kind: 'report' }>;

import type { ActivitySizes } from './activity-query.ts';
/**
 * What the serve worker holds: per maintained arc its parsed events and rows, the views it keeps per capture (tab lists and
 * details), and its Activity indexes and query generations (with how many indexes it built from nothing and extended).
 */
export type ServeSizes = Readonly<{ arcs: readonly Readonly<{ arc: string; events: number; rows: number }>[]; tabViews: number;
  activity: ActivitySizes }>;
/**
 * A worker's heap, as v8 sees it inside the worker, with what it holds. Asked for by main, or sent unprompted (`near`) once
 * each time the used heap crosses HEAP_NEAR of its limit. Product telemetry: main logs one line per report.
 */
export type HeapReport<S> = Readonly<{ kind: 'heap'; usedMb: number; limitMb: number; externalMb: number; near: boolean; sizes: S }>;
export const HEAP_NEAR = 0.8;
const MB = 1024 * 1024;
/** This thread's heap report. */
export function heapReport<S>(sizes: S, near: boolean): HeapReport<S> {
  const h = getHeapStatistics();
  return { kind: 'heap', usedMb: Math.round(h.used_heap_size / MB), limitMb: Math.round(h.heap_size_limit / MB), externalMb: Math.round(h.external_memory / MB), near, sizes };
}
/** Whether this thread's used heap is past HEAP_NEAR of its limit. */
export function heapNear(): boolean { const h = getHeapStatistics(); return h.used_heap_size > HEAP_NEAR * h.heap_size_limit; }

/**
 * A worker's own garbage collection. V8 sizes its next full collection from the live heap, not from need: under a guard-sized
 * limit a worker's used heap runs to three times what it holds between collections (measured: a collector 340 MB live, 1.1 GB
 * used). When the console runs with `--expose-gc` (src/entry/console.ts is started so), the returned function collects once
 * the used heap is `overMb` over what the last collection left, and says whether it did; without `gc` it never does. The
 * collector tidies after every step (nothing waits on it); the serve worker after answering, when no read is parked.
 */
export function heapTidy(overMb: number, collect: (() => void) | undefined = (globalThis as { gc?: () => void }).gc,
  usedMb: () => number = () => getHeapStatistics().used_heap_size / MB): () => boolean {
  let settledMb = Infinity;
  return () => {
    if (collect === undefined) return false;
    if (settledMb !== Infinity && usedMb() < settledMb + overMb) return false;
    collect();
    settledMb = usedMb();
    return true;
  };
}

/** The maintained arcs: the selected one, then up to `extra` subscribed or read within `recentMs`. */
export const MAINTAIN = { extra: 2, recentMs: 60_000, tickMs: 2_000 } as const;
