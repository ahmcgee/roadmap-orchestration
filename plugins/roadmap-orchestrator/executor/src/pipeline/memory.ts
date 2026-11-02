// Commit memory comes only from completed evidence snapshots. Live build files and the current spec
// may have changed by the time a stage is retried; neither can supply a recorded commit's message.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { IntentOf } from '../core/events.ts';
import type { UnitId } from '../core/ids.ts';
import { resultFile } from '../core/records.ts';
import { repoPattern } from '../core/values.ts';
import { SchemaError } from '../core/validate.ts';
import { FILES_DIR, readCapturedEvidence } from '../git/evidence.ts';
import { DECISIONS_FILE, validateBuildOutput, validateDecisionsFile } from '../prompts/schemas.ts';
import type { StageContext } from './dispatch.ts';
import type { BuildRun } from './stages.ts';

type MemoryContext = Pick<StageContext, 'journal' | 'runDir'>;

function buildSnapshots(ctx: MemoryContext, unit: UnitId): readonly IntentOf<'evidence.snapshot'>[] {
  return ctx.journal.view.opsOf('evidence.snapshot').filter((i) =>
    i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'evidence'
    && i.expect.source === ctx.runDir && ctx.journal.view.doneOf(i.op) !== null);
}

/** A build round's summary and decision text, including the reasons the builder recorded in it. */
function snapshotSummary(ctx: MemoryContext, snapshot: IntentOf<'evidence.snapshot'>): string {
  const captured = readCapturedEvidence(ctx.journal.view, snapshot.op);
  if (typeof captured === 'string') throw new Error(captured);
  const read = (path: string): unknown => JSON.parse(readFileSync(join(snapshot.expect.dest, FILES_DIR, path), 'utf8'));
  const report = captured.manifest.files.find((f) => /^inv\/[^/]+\/result\.json$/.test(f.path));
  const parts: string[] = [];
  if (report !== undefined) {
    const result = resultFile(read(report.path), report.path);
    if (result.type !== 'backend' || result.role !== 'build') throw new Error(`${report.path}: not a build result`);
    if (result.outcome.kind === 'success') parts.push(validateBuildOutput(result.outcome.value).summary);
  }
  const decisions = captured.manifest.files.find((f) => /^work\/[^/]+\/[^/]+\/decisions\.json$/.test(f.path));
  if (decisions !== undefined) {
    try {
      const entries = validateDecisionsFile(read(decisions.path)).decisions;
      if (entries.length > 0) parts.push(`Decisions:\n${entries.map((d) => `${d.id}: ${d.text}`).join('\n')}`);
    } catch (error) {
      // A lost build can leave an invalid decisions file; evidence already reports why it was not appended.
      if (!(error instanceof SyntaxError || error instanceof SchemaError)) throw error;
    }
  }
  return parts.filter((p) => p !== '').join('\n\n');
}

export function salvageSummary(ctx: MemoryContext, unit: UnitId, run: BuildRun): string {
  const report = `${relative(ctx.runDir, run.invDir)}/result.json`;
  const snapshot = buildSnapshots(ctx, unit).find((i) => i.expect.globs.includes(repoPattern(report)));
  if (snapshot === undefined) throw new Error(`build ${run.inv}: no kept evidence for ${DECISIONS_FILE} and its report`);
  return snapshotSummary(ctx, snapshot);
}

/** Chronological build memory, including rounds whose builder committed everything before salvage. */
export const salvageSummaries = (ctx: MemoryContext, unit: UnitId): readonly string[] =>
  buildSnapshots(ctx, unit).map((i) => snapshotSummary(ctx, i));

export const memoryMessage = (subject: string, summaries: readonly string[]): string => {
  const body = summaries.filter((s) => s !== '').join('\n\n');
  return `${subject}\n${body === '' ? '' : `\n${body}\n`}`;
};
