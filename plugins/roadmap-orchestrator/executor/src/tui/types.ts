import type { ClaudeUsage } from './usage.ts';
import type { Run } from '../cli/locate.ts';
import type { Status } from '../status.ts';
import type { RunLocator } from '../input/cli.ts';
import type { AbsPath } from '../core/values.ts';

export type EntryKind = 'unit-status' | 'specification' | 'implementation-plan' | 'arc-plan' | 'intent' | 'vision' | 'vision-clause' | 'vision-question' | 'milestone' | 'milestone-status' | 'arc-slice' | 'debt-ledger' | 'debt-item' | 'document';
export type Entry = { parentId?: string; kind?: EntryKind; description?: string; id: string; label: string; state: string; body: string; links: string[]; provenance: string };
export type Invocation = Entry & {
  assessment?: 'future-gap' | 'baseline-red' | 'mutation-caught' | 'mutation-survived' | 'mutation-inconclusive';
  relatedUnits?: string[]; context?: string;
  inputKind?: 'initial' | 'repair' | 'resume';
  execution?: 'agent' | 'command';
  scope?: 'arc' | 'unit';
  milestone?: string;
  model?: string; requestedModel?: string; backend?: 'claude' | 'codex'; adapter?: string;
  unit: string; role: string; attempt: number; session: string; startedAt: string; endedAt: string | null;
  quietMs: number | null; latest: string;
};
export type Display = {
  run: Run; at: string; seq: number; status: Status; invocations: Invocation[]; estate: Entry[]; exceptions: Entry[];
  milestoneUnits: Record<string, readonly string[]>;
};
export type LogSource = 'transcript' | 'stdout' | 'stderr' | 'runner.log' | 'result' | 'prompt';
export type LogRequest = { inv: string; source: LogSource; before: number | null; after?: number; expanded: boolean; raw?: boolean };
export type LogPage = { key: string; start: number; end: number; size: number; lines: string[]; error: string | null };
export type ObserveRequest = { locator: RunLocator; hostDir: AbsPath; pinned: Run | null; log: LogRequest | null; token: number };
export type ObserveReply = { usage?: ClaudeUsage; token: number; display: Display | null; log: LogPage | null; error: string | null };
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? String(value);
