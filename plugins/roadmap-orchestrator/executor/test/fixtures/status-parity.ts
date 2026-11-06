// A portable rich projection fixture. Golden normalization changes only fixture identities and timing.
import { readFileSync, writeFileSync } from 'node:fs';
import { submitCommand, writeReceipt } from '../../src/commands/queue.ts';
import { arcId, commandId } from '../../src/core/ids.ts';
import { SCHEMA_VERSION } from '../../src/core/version.ts';
import { isoTimeOf } from '../../src/core/values.ts';
import { raiseNeedsUser } from '../../src/needsuser.ts';
import { walkArc } from './walk-common.ts';
import { contextFor } from './unit-common.ts';

export function parityArc() {
  const d = walkArc({ steps: [] });
  const raw = JSON.parse(readFileSync(d.planPath, 'utf8'));
  writeFileSync(d.planPath, JSON.stringify({ ...raw, expectations: { arcUsd: 10, perMilestoneUsd: 3 } }));
  const r = contextFor(d);
  raiseNeedsUser(r.journal, r.ctx.runDir, { reason: 'revision-notice', blocking: false, subject: { type: 'arc' }, summary: 'Review the plan', recommendation: 'Inspect', options: [], evidence: [] }, { type: 'arc' });
  const at = isoTimeOf(new Date('2026-01-01T00:00:00.000Z'));
  for (let i = 1; i <= 12; i++) writeReceipt(r.ctx.runDir, { v: SCHEMA_VERSION, command: commandId(`cmd-${i.toString(16).padStart(16, '0')}`), state: 'rejected', at, reason: `Rejected ${i}` });
  submitCommand(r.ctx.runDir, arcId(d.arc), { type: 'pause', target: { type: 'all' } });
  r.journal.close();
  return { d, runDir: r.ctx.runDir, hostDir: r.ctx.hostDir };
}

export function portableStatus(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v: unknown) => {
    if (typeof v === 'string' && /^t-[0-9a-f]{12}$/.test(v)) return '<arc>';
    if (key === 'foldMs' || key === 'bytes') return 0;
    if (typeof v !== 'string') return v;
    if (v.startsWith('/')) return '<path>';
    return v.replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{40}\b/g, '<sha>')
      .replace(/cmd-[0-9a-f]{16}/g, '<command>');
  }));
}
