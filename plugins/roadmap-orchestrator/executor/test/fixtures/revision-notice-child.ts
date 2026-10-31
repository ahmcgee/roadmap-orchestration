// Commit an evaluated automatic revision in a child killed at an existing notice-publication crash point.
import { parseRevisionPayload } from '../../src/core/events.ts';
import { commitRevisionNow } from '../../src/input/inforce.ts';
import { type ArcDescriptor, contextFor } from './unit-common.ts';

const [descriptor, json] = process.argv.slice(2);
if (descriptor === undefined || json === undefined) throw new Error('usage: revision-notice-child <arc json> <payload json>');
const r = contextFor(JSON.parse(descriptor) as ArcDescriptor);
const payload = parseRevisionPayload(JSON.parse(json));
if (payload.source.type !== 'bundle') throw new Error('expected a bundle revision');
commitRevisionNow(r.journal, r.ctx.runDir, payload, { type: 'job', job: payload.source.job });
r.journal.close();
