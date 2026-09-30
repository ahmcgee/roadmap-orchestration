// Shared by the docs publication tests (test/publish.test.ts) and their child (publish-child.ts): a unit-common arc
// whose first revision an M3 start recorded (payload, `revision.commit`), a command context whose docs publisher is
// the real one (src/pipeline/publish.ts) over one arbiter the unit's stages share, and `rule` records whose
// consistency is judged at the current tip (fresh, G21).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../../src/commands/apply.ts';
import { submitCommand } from '../../src/commands/queue.ts';
import { openJournal } from '../../src/core/log.ts';
import { arcId, sha } from '../../src/core/ids.ts';
import type { CommandFile } from '../../src/core/records.ts';
import { absPath, isoTimeOf } from '../../src/core/values.ts';
import { atomicJson } from '../../src/core/fsx.ts';
import type { RunStart } from '../../src/core/records.ts';
import { SCHEMA_VERSION } from '../../src/core/version.ts';
import { profileName } from '../../src/routing/types.ts';
import { parseRulingSidecar } from '../../src/holistic/types.ts';
import { readInputFiles, recordPlan } from '../../src/input/inforce.ts';
import type { StageContext } from '../../src/pipeline/dispatch.ts';
import { docsPublisher, rulingContextAt } from '../../src/pipeline/publish.ts';
import { type Arbiter, createArbiter } from '../../src/schedule/arbiter.ts';
import { consistencyRevs } from '../../src/spec/rulings.ts';
import { bytesSha256 } from '../../src/spec/spec.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import type { LaneJson } from './stage-common.ts';
import { type ArcDescriptor, type ArcOptions, type ArcRun, commandContextFor, setupArc } from './unit-common.ts';

/** Lays out a unit-common arc (`edit` changes its files first) and records them as revision 1, as an M3 first start does. */
export function publishArc(opts: ArcOptions, edit: (d: ArcDescriptor) => void = () => {}): ArcDescriptor {
  const d = setupArc(opts);
  edit(d);
  const j = openJournal(absPath(d.runDir), arcId(d.arc));
  recordPlan(j, absPath(d.runDir), readInputFiles(absPath(d.planPath)), [], { profile: 'default', config: null });
  j.close();
  const start: RunStart = { v: SCHEMA_VERSION, generation: 1, at: isoTimeOf(new Date()), repo: absPath(d.repo), planFile: absPath(d.planPath), profile: profileName('default', 'profile') };
  atomicJson(join(d.runDir, 'start.json'), start);
  return d;
}

/** The stage context with the run's arbiter (units acquire through it), and the command context whose docs publisher shares it. */
export type Wired = Readonly<{ stage: StageContext; commands: CommandContext; arbiter: Arbiter }>;

export function wire(r: ArcRun): Wired {
  const arbiter = createArbiter(r.ctx);
  const stage: StageContext = { ...r.ctx, acquire: arbiter.acquire };
  const commands: CommandContext = {
    ...commandContextFor(r, stage),
    docs: docsPublisher({ ...r.ctx, hostEnv: r.ctx.hostEnv, planFile: absPath(r.d.planPath), arbiter }),
  };
  return { stage, commands, arbiter };
}

/**
 * A suite lane whose first run anywhere parks until `<dir>/lane.release` exists (after writing `<dir>/lane.reached`),
 * printing progress; every later run passes at once. The unit's candidate runs it first and parks there.
 */
export function barrierSuite(dir: string): LaneJson {
  const script = [
    "const fs = require('node:fs'); const d = process.argv[1];",
    "if (!fs.existsSync(d + '/lane.reached')) {",
    "  fs.writeFileSync(d + '/lane.reached', String(process.pid));",
    '  const until = Date.now() + 120000; const cell = new Int32Array(new SharedArrayBuffer(4));',
    "  while (!fs.existsSync(d + '/lane.release')) { if (Date.now() > until) process.exit(3); process.stdout.write('.'); Atomics.wait(cell, 0, 0, 50); }",
    '}',
  ].join('\n');
  return { id: 'suite', argv: ['node', '-e', script, dir] };
}

/** An architect's ruling record (raw JSON), its consistency judged at `r`'s integration tip and the revisions in force. */
export function ruleRecord(r: ArcRun, id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const tip = sha(git(r.d.repo, 'rev-parse', 'main'));
  const draft: Record<string, unknown> = {
    schema: 'roadmap/ruling-m3', id, statement: 'Helpers take finite numbers only.', kind: 'decision', ruledBy: { type: 'architect' }, trigger: 'review',
    supersedes: [], condition: null,
    docRefs: [{ path: 'contracts/api.md', anchor: '#api-contract', quotedText: 'returns the sum', relation: 'consistent' }],
    contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: [], evidence: [],
    appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
    consistency: { verdict: 'consistent', judgedRevs: { head: tip, ledgerSha256: 'a'.repeat(64), obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } },
    ...over,
  };
  const fresh = consistencyRevs(parseRulingSidecar(draft), rulingContextAt({ journal: r.journal, runDir: r.ctx.runDir, planFile: absPath(r.d.planPath), repo: r.ctx.repo }, tip));
  if ('reasons' in fresh) throw new Error(fresh.reasons.join('; '));
  return { ...draft, consistency: { ...(draft['consistency'] as object), judgedRevs: fresh.revs } };
}

/** A contract op on contracts/api.md, listed in the ruling's contractRefs. */
export const API_OP = {
  contractRefs: ['contracts/api.md'],
  contractOps: [{ path: 'contracts/api.md', anchor: '#api-contract', oldText: 'the sum of two numbers', newText: 'the sum of two finite numbers' }],
} as const;

/** Writes `record` to a file and submits `rule <file>`. */
export function submitRule(r: ArcRun, record: Record<string, unknown>): CommandFile {
  const path = join(tmpDir('rule-record'), `${String(record['id'])}.json`);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  writeFileSync(path, bytes);
  return submitCommand(r.ctx.runDir, r.ctx.plan().arc, { type: 'rule', path: absPath(path), sha256: bytesSha256(bytes) });
}

