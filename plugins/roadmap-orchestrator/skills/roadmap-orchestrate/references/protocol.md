# Shared roadmap protocol, version 1

This is the compatibility contract for the Codex skill and the updated Claude persister.
An unversioned arc is a legacy arc. Acquiring it creates `.roadmap/protocol.json` containing
`{"version":1}`. Both writers refuse unknown versions. Install/update both skills before switching;
an older installation cannot enforce the new ownership protocol. Same repository, filesystem and
worktree paths are required. This does not transfer live model sessions or relocate an arc.

## Durable artifacts

Keep these in the central repository's `.roadmap/`, not a worker's copy:

| Artifact | Meaning |
| --- | --- |
| `plan.json` | Unit DAG, cut line, provisioning, tracking and configuration |
| `state.json` | Integration branch/tip, wave, unit statuses and cumulative budgets |
| `protocol.json` | Format version, separate from runtime serializers |
| `brief.md`, `specs/<id>.md`, `contracts/*.md` | Shared implementation and acceptance instructions |
| `constraints.md`, `debt.md` | Living decisions and file-mode debt |
| `architect-log.md` | Direction, boundary decisions, amendments and waivers |
| `feedback/{explorer,health,design,user}/`, `feedback/triaged/<wave>/` | Pending and consumed evidence |
| `quarantine/<id>.md`, `evidence/<id>/` | Failure dossiers and commit-addressed verification/review |
| `degradations.jsonl`, `escalations.jsonl`, `skill-feedback.md`, `skill-degradations.md` | Living orchestrator diagnostics |

Detailed legacy optional fields keep their original meaning. The Claude distribution's
`orchestrate/reference.md` remains its execution reference; Codex never loads its Claude runtime rules.

Minimal compatible plan and initial state:

```json
{
  "repoPath": "/absolute/project",
  "worktreeRoot": "/absolute/project-worktrees",
  "cutLine": "milestone-1",
  "tracking": "files",
  "units": [{"id":"core-api","title":"Core API","risk":"high","kind":"code","inScope":true}],
  "edges": [],
  "config": {"codexNative":{"integrationTestCommand":"npm test","maxConcurrent":3,"maxWaves":20,"testTimeoutMs":600000}}
}
```

```json
{
  "integrationBranch":"roadmap/session-2026-09-17",
  "integrationTip":"FULL_BASE_COMMIT_SHA",
  "wave":0,"consultsUsed":0,"units":{}
}
```

Edges are `{from,to,type:"semantic"|"file-overlap",mode:"contract"|"contingent",contract?}`;
`from` must be merged before `to` starts. A contingent edge requires boundary replanning.
Optional unit fields include `existingBranch` (never its own `unit/<id>`), `supersedes`, `design`,
`issue` and `closes`. Provisioning is `{copy:[".env"],setup:"npm ci"}`. Preserve optional
`designAuthorities`, `conventions`, `scopeAllow`, `prefixUniqueGlobs` and `preview` settings.

Unit statuses: `pending → running → merge-ready → merged`; alternatives `blocked`, `quarantined`,
`deferred`. Running stages: `setup`, `plan`, `implement`, `polish`, `gate`, `merge-queue`.
`pending` plus `parked:true` authorizes adoption of unfinished work. Preserve `rounds` including
`fix`, `opusGate`, `gate`, `verifyBlocked`, cumulative `spend`, `consultsUsed`, `escalationStops`,
`owed`, held boundary findings, `debt`, and `scopeRulings` across handoffs. No renaming legacy counters.
Do not invent token counts for native agents whose host does not expose them.

Settings inside `config.codexNative` configure the native driver, without changing Claude model
routing. The section's presence also opts the Claude scheduler into preserving consumed per-unit retry
budgets across waves/handoffs; legacy plans without it retain their original per-wave accounting.
Set `integrationTestCommand` from the brief before the first native dispatch of an imported arc.
Native workers inherit Astra unless explicitly overridden in the host's delegation;
record the choice in the architect log, not in the unit's acceptance criteria.

## Helper interface

Write a request JSON file outside worker checkouts, then invoke:

```sh
node /path/to/roadmap-orchestrate/scripts/roadmap.mjs /absolute/request.json
```

All requests have `command` and absolute `roadmapDir`; mutations after acquisition require `token`.
Responses are JSON; errors exit 1 with a reason. Tokens are concurrency identifiers, not credentials.

| Command | Additional fields / result |
| --- | --- |
| `init` | `plan`, `state`; refuses an existing arc, returns the Codex ownership token |
| `status` | Returns plan/state, their hashes, owner and runtime directory |
| `acquire` | `driver:"codex"|"claude"`; takeover also needs `previousToken`, `stopped:true` |
| `assert-owner` | Check token before resuming a driver dispatch |
| `recover` | Finish a pending checkpoint before any other reads |
| `inspect` | Git/worktree facts without changing state |
| `reconcile` | Adopt landed commits and park unfinished units; optional `retryBlocked:true` after fixing blockers |
| `wave` | Advance the wave after the previous boundary is triaged |
| `eligible` | Ready unit IDs; never polls GitHub |
| `setup` | `unit`; returns the explicit worktree and stage; checkpoints intent before side effects |
| `transition` | `unit`, `stage`; optional `round:"fix"|"opusGate"|"gate"`; terminal stages need reasons/dossiers |
| `approve` | `unit`, `implementer`, `reports:{verify,review,gate}` with paths relative to central `.roadmap/` |
| `merge` | `unit`; serial candidate merge + integrated suite + branch advance |
| `checkpoint` | `stateHash`, `planHash` from status; optional whole `plan`, `state`, and `files:{relativePath:textOrNull}` |
| `release` | `stopped:true` after workers stop; invalidates token |

Use `checkpoint` to update boundary state, planning documents, debt and journal as one transaction.
`null` deletes an explicitly named artifact. Read/modify the entire existing object to preserve
unknown fields. Do not use it to skip unit lifecycle commands. Branch recovery uses real Git history:
a branch tip must appear as a merge's non-first parent to count as a newly recovered completed unit;
simple ancestry would incorrectly mark an empty unit branch as done. Already-recorded merged units
also require their `mergedAt` commit to remain reachable.

Verifier report:

```json
{"head":"FULL_UNIT_SHA","actor":"verifier-thread","verdict":"pass","lanes":[{"command":"npm test -- core","exitCode":0}]}
```

Reviewer report:

```json
{"head":"FULL_UNIT_SHA","actor":"reviewer-thread","verdict":"approve","findings":[]}
```

Gate report:

```json
{"head":"FULL_UNIT_SHA","actor":"gate-thread","verdict":"approve","acceptance":[{"clause":"AC-1","verdict":"pass","evidence":"test output path"}]}
```

Use actual actor/thread identities. Review and gate actors must differ from the implementer; a
fresh independent reviewer may perform both judgments. Approvals bind the unit commit, current
integration tip, spec, brief, constraints, architect direction and contract/config inputs. Any change
requires new reports. The helper checks report shape, attribution and commit identity; judging their
truth and full acceptance coverage remains the independent reviewer's responsibility.

## Ownership and interrupted work

Ownership and redo journals live under the Git common directory, in `roadmap-runtime/<arc-path-hash>/`.
They do not travel through Claude's state serializer and cannot be inherited from a unit's fork.
There is no automatic lease expiry. Stop both the old root and its workers before takeover, supplying
its token from `status` plus `stopped:true`. Never assume hitting a usage limit stopped a shell process.

Every helper operation takes a short exclusive process lock. If a process dies holding
`operation.lock`, inspect its recorded PID and relevant worker processes. Only after confirming it
is dead, remove that lock and run `recover`. Do not delete the checkpoint journal: it is the recovery
source. `status` refuses an unfinished checkpoint; read `owner.json` directly from the lock's parent
directory if the token was lost. Takeover can also finish a pending checkpoint after stopping the old
owner. File replacements are atomic; the journal makes a multi-file update recoverable, not invisible
to arbitrary readers. Both drivers must recover before reading.

On a Claude → Codex switch, stop the Workflow and all spawned Codex processes, persist its latest
return/journal under the Claude token, then release/acquire. If replay cannot recover, retain the
last durable checkpoint; reconcile branches and re-run incomplete verification. Codex → Claude:
checkpoint and stop native workers, release/acquire as Claude, and launch a **fresh** conductor with
a new `launchId` and `ownerToken`. Do not replay a foreign or stale `run`/session identifier.
The updated Claude persister rejects a delayed result with a revoked token and preserves unknown
extension fields. Older drivers must be upgraded before entering a versioned arc.

Dirty worktrees, failed candidate merges and quarantined branches are never discarded automatically.
Inspect and commit useful unfinished changes before resuming; an active worker's partial file is not
safe to commit until that worker stops. Resolve failed candidate changes into the unit branch and
review that branch again. Keep review evidence small and file-based so legacy readers can still
transport the plan/state pack.

## Boundary checkpoint example

After `status`, edit its state copy to add the boundary disposition, without altering unit results:

```json
{"command":"checkpoint","roadmapDir":"/absolute/project/.roadmap","token":"OWNER_TOKEN","stateHash":"FROM_STATUS","planHash":"FROM_STATUS","state":{"integrationBranch":"roadmap/session-2026-09-17","integrationTip":"FULL_SHA","wave":1,"consultsUsed":0,"units":{},"boundary":{"triaged":true,"wave":1}},"files":{"architect-log.md":"FULL updated journal\n","debt.md":"FULL updated debt ledger\n"}}
```

This is an interface example: retain the real units, budgets and all outstanding obligations from
status rather than substituting its empty example map. `owed` entries are
`{job:"explorer"|"health"|"flake"|"design",wave,why,count,units?}`. Clear one only after a successful
job or an explicit lead waiver recorded in the same journal update. No debt-only continuation waves.
