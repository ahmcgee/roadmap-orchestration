import { parentPort } from 'node:worker_threads';
import { ClaudeUsageReader } from './usage.ts';
import { Observer } from './observer.ts';
import type { ObserveRequest } from './types.ts';
const observer = new Observer();
const usage = new ClaudeUsageReader();
parentPort!.on('message', (request: ObserveRequest) => parentPort!.postMessage({ ...observer.observe(request), usage: usage.poll() }));
