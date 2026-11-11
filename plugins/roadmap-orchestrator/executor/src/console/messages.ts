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
  /** A collector exited: reads of its arc answer this until it is back. */
  | Readonly<{ kind: 'collector-down'; arc: ArcId; error: ErrorBody }>;

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
  | Readonly<{ kind: 'check-now'; arc: ArcId }>;

/** Main to a collector. */
export type ToCollector = Readonly<{ kind: 'check-now' }>;

/** The maintained arcs: the selected one, then up to `extra` subscribed or read within `recentMs`. */
export const MAINTAIN = { extra: 2, recentMs: 60_000, tickMs: 2_000 } as const;
