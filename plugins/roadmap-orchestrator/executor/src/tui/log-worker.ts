import { parentPort } from 'node:worker_threads';
import { LogReader } from './log-reader.ts';
import type { LogReadRequest } from './types.ts';
const reader = new LogReader();
parentPort!.on('message', (request: LogReadRequest) => parentPort!.postMessage(reader.read(request)));
