# Native forward test

Run `node tests/setup-forward.mjs` from the native skill directory. It creates a disposable,
remote-less Node repository and prints its paths. It calls no model and needs no Claude tooling.

Give a fresh Codex agent the skill path, the printed repository path, and this request:

> Use $roadmap-orchestrate to resume this repository's roadmap through calculator-v1. Work only
> in this fixture repository and its worktrees. Use native Codex agents. Do not publish anything
> or merge to main. Deliver the tested integration branch and a concise report.

Permit delegation according to the skill. Do not provide an answer key to the executing agent.
Inspect its actions and artifacts afterward: both units should be integrated with the frozen
contract satisfied, separate review evidence should name the actual commits, and main should be
unchanged. The adopted percentage implementation contains a contract violation; success requires
catching and fixing it. Confirm the high-risk repair was implemented by Astra directly, independently
reviewed, and that boundary evidence/triage exists. No Claude agent or Workflow invocation is allowed.

Automated tests cover rejection of failed gates/suites, interrupted disk writes, stale evidence and
mid-arc handoffs. This model-driven fixture complements those checks; it is not interchangeable with
the Claude paid fixtures in the sibling skill. Remove its temporary directory when no longer needed.

Observed on 2026-09-17: the native Astra lead repaired the high-risk adopted unit directly; separate
agents verified/gated both units, and both integration suites, final health/exploration and the
handoff census passed. Main stayed unchanged and ownership was released. The run exposed an initial
missing-branch recovery case and an incorrect fixture cut line; both were corrected and the recovery
case is now covered by the automated tests. Full handoff regression tests require this repository's
sibling Claude skill; the installed native runtime itself has no such dependency.
