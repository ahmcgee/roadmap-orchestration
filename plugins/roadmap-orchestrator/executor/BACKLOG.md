# Backlog after M1

Deferred deliberately during M1 (2026-09-25/26). Each item is either a plan milestone already named in
DESIGN-1.0.md §10 or a follow-up found while building M1. Rulings that changed behaviour are recorded in
SCHEMAS.md and RATIONALE-1.0.md, not here.

## M2 (from the plan)

- Flake reruns, host signatures, retryable parks, cross-model cold start for fix rounds. In M1 a red lane is
  red and fix rounds resume the same model.
- Receipts and needs-user acks are created under their final name and written after; a `status` read between
  create and write sees an empty file. Move them to temp-and-link like command files.
- DAG scheduling and parallel units (M1 is serial). `arc.ts` already lets a unit-scoped park release later
  units.
- A lost build without tree effects that is re-run after a crash gets a fresh deadline rather than the
  inherited one (the live retry path inherits it).

## M3 (from the plan)

- Residue-index compaction at `start`, event-log compaction, `roadmap gc` (also clears the host dir's
  `supervisor.<token>.*` and `executor.<gen>.*` log files).
- Ruling retirement from `constraints.md`, obligation re-derivation at Phase 0, dismissal arc lifetime.
- The holistic layer: obligations, witness protocol, checkpoint authority.
- A read-only Codex judgment profile; until then Codex judgment triples are `unsupported` and the review
  digest seat resolves to the Claude low judgment seat.
- cgroup containment stays experimental until `contain.cgroup-real` passes on a host with a writable,
  delegated cgroup v2 tree.

## M4 (from the plan)

- Debt lifecycle (stable ids, Phase-0 disposition or refuse, the two-arc question).
- Issue mode inbound only; outbound projection in 1.1.
- Phase 0 skill text; SKILL.md becomes the full skill.

## Found while building M1

- Transient check: DESIGN's "ignored patterns" rule is not implemented; salvage never commits ignored files,
  so nothing ignored can reach the candidate today.
- Gate directive overflow banking: every directive goes to the fix round because M1 has no debt ledger.
- Codex resume collision: the message is matched on `thread already` from arc 1; no captured sample exists.
- `launch.graceMs` has a floor of 1000 ms because the backstop fires at deadline plus twice the grace and the
  runner polls every 500 ms; make the relation explicit in one place if the poll interval ever changes.
- `start` prints `ready` once the executor is alive and reconciling; a backend smoke refusal after that shows
  in `status` and exits `refused`. A `--wait` that also covers the smoke would need readiness split in two.
- Adopting a live runner across arcs holds the recovery lock until that runner exits, which can outlast
  `start`'s wait.
- Host directory log files accumulate until `gc` (M3).

## Found fixing interrupted rounds (2026-09-26)

- A `continue` round gets the full window of the round it continues, not the time the interrupted attempt
  had left. A remaining-time deadline would read the interrupted invocation's launch and end times.
- A Claude build killed before the CLI persisted its session (a pause within its first moments) is continued
  with `--resume` of an id the CLI never saved; that call fails as a process fault and parks the unit. Nothing
  in the invocation's files tells the two cases apart today.
- A Codex exec killed mid-write of a stdout line leaves a truncated last line; the reader refuses the whole
  stream, so the thread id it did report is lost and the continue starts fresh with NO_SESSION_NOTE.
- Decisions an interrupted or malformed attempt wrote to its own evidence dir are never appended: its
  evidence stage never runs. CONTINUE_DIRECTIVE asks the session to rewrite decisions.json complete in the
  new dir; the resume after a malformed report relies on the same rule in the build prompt.

## Deferred from arc-1 feedback (2026-09-26)

- Parks outside plan-check and gate (lost build, residue, red candidate, red base, failed salvage, blocked
  lane) are not re-openable: `resume <unit>` rejects them and their needs-user names the re-entry under a new
  unit id. Retryable parks are M2.
- A reopen resets only the redirect bound. The gate's revise bound, the red-candidate bound, per-stage retries
  and routed-up seats carry on, so a unit re-opened after a revise-bound park escalates at its next revise.
  Reset them too if re-opened units keep parking on a carried-over count.
- A spec edited while its unit is in flight (not parked) is not detected: later stages read the edited file
  and the gate's fingerprint binds whatever rev is on disk. Only a reopen checks the architect's rev rule. A
  per-stage check of the file against `UnitState.spec` would catch it.
- A reopen does not re-pin routing: a unit re-opened under a changed routing table meets the pinned
  `routingRev` check at its plan-check like any other dispatched unit.
- `resume <unit>` of a unit that is both paused and parked clears the pause only; a second `resume` re-opens.
- `run.state` shows `held` while the next unit waits on `after` for another unit's open needs-user, though
  what it waits on is that item; `units[].status` (`held-after:<ids>`) names the units.
- Shared-resource owner leases are a documented probe convention (SKILL.md), not executor code.
