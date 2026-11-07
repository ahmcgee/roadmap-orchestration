# Roadmap web console delivery report

Implemented on `feat/dev55-web-console`, stacked on `c1cd2413` (dev.54). Owner amendments A1–A4 are applied: port 4747, intended devcontainer wildcard binding with loopback guidance for exposed hosts, loud config/occupied-port refusal without port search, and UnitGraph with explicit executor milestone gates. No auth, version changes, push, runtime npm dependencies or process-diagram edits.

## Four sequential phases

| Phase | Commit | Result |
|---|---|---|
| 1 | `0a837764` | Shared measured capture/core derivation, verified cursor epochs, dependency-aware cache and parity protocol |
| 2 | `e7fd185c` | Settings, common-directory lease/mutex, detached startup, read-only worker HTTP/SSE, CLI transport/fallback and contained evidence |
| 3 | `f8c9b2f5` | Verified vendored assets, immutable manifest, Roadmap screens, truthful waiting/resource/CPU adapters |
| 4 | The commit containing this report | Lifecycle/browser/transport/integrity/upgrade checks, cache refinements and required docs |

Each phase commit carries `Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>`.

## Files

Paths below are repo-relative; `E` means `plugins/roadmap-orchestrator/executor/`.

Phase 1:

- `E/src/core/log.ts`
- `E/src/observation/cache.ts`
- `E/src/observation/dependencies.ts`
- `E/src/observation/observer.ts`
- `E/src/observation/protocol.ts`
- `E/src/status.ts`
- `E/src/tui/observer.ts`
- `E/test/console-observation.test.ts`

Phase 2:

- `E/src/cli/main.ts`
- `E/src/console/client.ts`
- `E/src/console/evidence.ts`
- `E/src/console/http.ts`
- `E/src/console/lease.ts`
- `E/src/console/runs.ts`
- `E/src/console/settings.ts`
- `E/src/console/static.ts`
- `E/src/console/worker.ts`
- `E/src/entry/console.ts`
- `E/src/input/cli.ts`
- `E/src/observation/cache.ts`
- `E/src/observation/containment.ts`
- `E/src/routing/layers.ts`
- `E/src/supervisor.ts`
- `E/test/console-lease.test.ts`
- `E/test/console-server.test.ts`
- `E/test/fixtures/console.ts`
- `E/test/fixtures/exec-common.ts`
- `E/test/fixtures/unit-common.ts`
- `E/test/helpers/console-port.ts`
- `E/test/skill-lint.test.ts`
- `plugins/roadmap-orchestrator/skills/orchestrate/reference.md`

Phase 3:

- `E/src/console/model.ts`
- `E/src/console/static.ts`
- `E/src/console/worker.ts`
- `E/src/observation/cache.ts`
- `E/src/observation/observer.ts`
- `E/src/observation/protocol.ts`
- `E/src/status/waiting.ts`
- `E/test/console-assets.test.ts`
- `E/test/console-model.test.ts`
- `E/web/app.css`
- `E/web/app.js`
- `E/web/index.html`
- `E/web/vendor/VENDOR.md`
- `E/web/vendor/bundle.css`
- `E/web/vendor/bundle.js`
- `E/web/vendor/fonts/ibm-plex-mono-400.woff2`
- `E/web/vendor/fonts/space-grotesk.woff2`
- `E/web/vendor/fonts/spectral-400.woff2`
- `E/web/vendor/fonts/spectral-500.woff2`
- `E/web/vendor/fonts/spectral-italic-400.woff2`
- `E/web/vendor/react-dom.LICENSE`
- `E/web/vendor/react-dom.production.min.js`
- `E/web/vendor/react.LICENSE`
- `E/web/vendor/react.production.min.js`
- `E/web/vendor/tokens.css`

Phase 4 (plus `E/WEB-CONSOLE-REPORT.md`):

- `DESIGN-1.0.md`
- `README.md`
- `E/SCHEMAS.md`
- `E/src/console/client.ts`
- `E/src/console/lease.ts`
- `E/src/console/model.ts`
- `E/src/console/worker.ts`
- `E/src/observation/observer.ts`
- `E/src/observation/protocol.ts`
- `E/test/console-lease.test.ts`
- `E/test/console-lifecycle.test.ts`
- `E/test/console-model.test.ts`
- `E/test/console-observation.test.ts`
- `E/test/console-results.test.ts`
- `E/test/console-transport.test.ts`
- `E/test/helpers/console-browser.ts`
- `E/test/serial/console-browser.test.ts`
- `E/test/serial/console-upgrade.test.ts`
- `E/web/app.js`
- `plugins/roadmap-orchestrator/skills/orchestrate/SKILL.md`

## Tests and fail-before evidence

- Phase 1: `node --test --test-concurrency=4 test/console-observation.test.ts` initially failed with `ERR_MODULE_NOT_FOUND` for `src/observation/cache.ts`; the completed suite now checks exact transport bytes from one captured observation, independent side-file/owner invalidation, heartbeat reuse, LRU/epoch behavior, partial tails and corruption.
- Phase 2: `console-server.test.ts` initially failed with `ERR_MODULE_NOT_FOUND` for `src/console/settings.ts`. Added real-server/CLI checks for config, GET/HEAD-only access, API fences, binding refusal, traversal/containment, bounded byte logs, concurrent readiness, worktrees, replacement and identity-safe stop. Existing executor tests additionally exposed refused/early-run discovery errors; production was fixed without changing their assertions. The initial failures remain in `/tmp/roadmap-console-phase2-supervisor.tap`; the final execution run has 31 passes.
- Phase 3: `console-model.test.ts` initially failed with `ERR_MODULE_NOT_FOUND` for `src/console/model.ts`. Its final cases verify every state mapping, overlapping waits, explicit milestone gates, nonblocking attention, measured CPU, actual booking intervals and stable adapter reuse. Assets are checksum-tested and fetched through real HTTP.
- Phase 4: the complete real-browser test was also run against an archived phase-2 commit (`e7fd185c`) and failed waiting for the absent overview; `/tmp/roadmap-console-browser-before.tap` retains that red result. Against the implementation it passes. The browser test caught the incorrect DataTable render signature (the supplied component receives a row); it now proves nonblocking requests render correctly. It audits rendered DOM text, title/aria-label/alt/title attributes and the real Chromium accessibility snapshot for forbidden branding, navigates details/logs, checks focus trapping/restoration and narrow alternatives, proves evidence stays inert, and checks stale content plus reconnection.

Final focused logs: `/tmp/roadmap-console-final-focused.tap`, `/tmp/roadmap-console-final-cache.tap`, `/tmp/roadmap-console-final-checks.tap`, `/tmp/roadmap-console-final-projection.tap`, `/tmp/roadmap-console-final-lease.tap`. Integration: `/tmp/roadmap-console-integration.tap`. Existing real execution: `/tmp/roadmap-console-final-execution.tap`. Browser: `/tmp/roadmap-console-browser.tap`. Upgrade: `/tmp/roadmap-console-upgrade.tap` and `/tmp/roadmap-console-existing-upgrade.tap`. Cost: `/tmp/roadmap-console-status-cost.tap`. Other regressions: `/tmp/roadmap-console-regression-1.tap`, `/tmp/roadmap-console-regression-2.tap`, `/tmp/roadmap-console-walk-browser.tap`.

### Per-file passes

Counts include Node subtests where present, omit suite containers and count repeated runs once. All listed final results have zero failures/skips.

| Added test file | Passes |
|---|---:|
| `test/console-assets.test.ts` | 2 |
| `test/console-lease.test.ts` | 4 |
| `test/console-lifecycle.test.ts` | 4 |
| `test/console-model.test.ts` | 6 |
| `test/console-observation.test.ts` | 5 |
| `test/console-results.test.ts` | 1 |
| `test/console-server.test.ts` | 4 |
| `test/console-transport.test.ts` | 1 |
| `test/serial/console-browser.test.ts` | 1 |
| `test/serial/console-upgrade.test.ts` | 1 |

| Existing test file | Passes |
|---|---:|
| `test/admission-waiting.test.ts` | 2 |
| `test/cli.test.ts` | 23 |
| `test/executor.test.ts` | 13 |
| `test/journal-handoff.test.ts` | 5 |
| `test/observer.test.ts` | 3 |
| `test/routing.test.ts` | 17 |
| `test/skill-lint.test.ts` | 3 |
| `test/status-integrity.test.ts` | 1 |
| `test/status-m3.test.ts` | 8 |
| `test/status-m4a.test.ts` | 3 |
| `test/status-parity.test.ts` | 3 |
| `test/status-rev3.test.ts` | 5 |
| `test/status-summary.test.ts` | 4 |
| `test/status.test.ts` | 9 |
| `test/supervisor.test.ts` | 18 |
| `test/tui.test.ts` | 68 |
| `test/waiting.test.ts` | 2 |
| `test/watch.test.ts` | 4 |
| `test/serial/status-cost.test.ts` | 5 |
| `test/serial/upgrade.test.ts` | 4 |
| `test/serial/walk-browser.test.ts` | 3 |

**29 added + 203 existing = 232 unique passing cases across 31 files.**

`npm run typecheck` and `git diff --check` pass. No `npm test` was run. Affected nonserial files used `--test-concurrency=4` at most; serial browser/upgrade/cost files were run individually with concurrency 1. Tests used ephemeral or explicitly free ports and never bound the product default 4747. Existing test assertions/golden normalization were not weakened. The only existing test-source changes extend the exhaustive command-kind map and give shared supervised fixtures isolated console bindings/cleanup.

The status/summary cost regression passes all five cases: 10× journal input costs 6.03× / 4.55× CPU for full status and 8.07× / 5.97× for summary, below the unchanged 15× bound.

Dev.52 parity goldens are byte-identical to the base:

- `test/fixtures/status-parity.golden.json`: `8bd97a698b92a33d8fc2469da03fc860e76c808b0a09e7aabcd44e220f8a5580`
- `test/fixtures/status-parity-enriched.golden.json`: `290eb22b9ea4ba39d5c8eb1c93b807f0520f6b2dc2262d56d98333623f06b4f4`

## Design adjustments and validation limits

- Per the owner's explicit constraint, no versions were bumped (overrides the design's release paragraph). A1–A4 otherwise clarify the supplied design, without changing arc flow.
- Invocation routes use the existing `seq-ordinal` key because canonical invocation IDs contain `/` and `#`; accepting them as a single segment would conflict with the required rejection of encoded separators. Canonical IDs in status remain unchanged.
- Playwright captures inside its allowed output directory, then the test copies the PNGs to the requested shots directory. No production test hooks were added.
- The owner-supplied design-system snapshot has no licence declaration; `web/vendor/VENDOR.md` records that fact rather than inventing a licence. React/ReactDOM are MIT and retain their licence files. Both npm tarballs were independently checked against registry SHA-512 integrity before UMD extraction; every vendored file has a SHA-256 entry.
- The real backend probe (`node evals/probe.ts`) was attempted but automatic approval review rejected execution because it can use authenticated external CLIs and incur billable side effects. It did not run. Approval is needed to run it.
- The conservative role trigger lists verifier, walkthrough, polishJudge, pre-build and campaignAudit because routing/skill paths changed. Paid role/compaction and paid arc fixtures were not run in this worktree: repo policy reserves those for the merged batch. No backend invocation/parser or arc-flow implementation changed.
- Host cgroup-real validation was not run and is not counted as a pass (this host's cgroup v2 is read-only).

## Fixture screenshots

Both are actual Chromium renders of the retained `enrichedParityArc` fixture (real Git/run records), using the vendored production assets. Reproduce with `node --test --test-concurrency=1 test/serial/console-browser.test.ts`.

- `/tmp/claude-1000/-workspaces-roadmap-orchestration/3acd3311-8eb9-44be-8704-d39a10a293c6/scratchpad/webui/shots/overview.png`
- `/tmp/claude-1000/-workspaces-roadmap-orchestration/3acd3311-8eb9-44be-8704-d39a10a293c6/scratchpad/webui/shots/unit-detail.png`
