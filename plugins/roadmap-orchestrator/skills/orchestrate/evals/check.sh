#!/usr/bin/env bash
# Deterministic end-state assertions for the roadmap-orchestrator eval fixture.
# Zero model tokens: every check is a fact about git state, files, or state.json.
# Usage: check.sh <target-dir>     — exit 0 = all checks pass.
set -uo pipefail
TARGET=${1:?usage: check.sh <target-dir>}
REPO="$TARGET/repo"; WT="$TARGET/worktrees"; STATE="$REPO/.roadmap/state.json"
fail=0
pass() { printf 'PASS  %s\n' "$1"; }
flunk() { printf 'FAIL  %s\n' "$1"; fail=1; }
expect() { # expect <description> <command...>
  local desc=$1; shift
  if "$@" >/dev/null 2>&1; then pass "$desc"; else flunk "$desc"; fi
}

[ -f "$STATE" ] || { flunk "state.json exists at $STATE"; exit 1; }
pass "state.json exists"

status_of() { node -e "const s=require('$STATE');console.log((s.units['$1']||{}).status||'absent')"; }
reason_of() { node -e "const s=require('$STATE');console.log((s.units['$1']||{}).reason||'')"; }

# A quarantine caused by harness/agent infrastructure ("pipeline error", structured-output
# retry caps) is an eval FAILURE even when the status happens to match expectations — the
# pipeline must reach the right outcome by judgment, not by crashing.
no_pipeline_error() {
  local id=$1; local r; r=$(reason_of "$id")
  case "$r" in *"pipeline error"*) flunk "$id quarantined by pipeline error, not judgment: $r"; return 1;; esac
  return 0
}

# --- scheduling + happy path -------------------------------------------------
MULT=$(status_of add-multiply); DIV=$(status_of add-divide)
[ "$MULT" = merged ] && pass "add-multiply merged (happy path)" || flunk "add-multiply merged (got: $MULT)"
[ "$DIV" = merged ] && pass "add-divide merged (dependency scheduling + contract edge)" || flunk "add-divide merged (got: $DIV)"

# --- unsatisfiable fast-exit -------------------------------------------------
IMP=$(status_of impossible-cache)
if [ "$IMP" = quarantined ] && no_pipeline_error impossible-cache; then
  pass "impossible-cache quarantined by judgment (unsatisfiable spec caught)"
elif [ "$IMP" != quarantined ]; then
  flunk "impossible-cache quarantined (got: $IMP — a merge here means the pipeline built something that violates a frozen contract)"
fi
expect "impossible-cache has a quarantine dossier" test -f "$REPO/.roadmap/quarantine/impossible-cache.md"

# --- gate probes ---------------------------------------------------------------
GOOD=$(status_of gate-good)
[ "$GOOD" = merged ] && pass "gate-good merged (over-blocking probe: clean adopted branch approved)" || flunk "gate-good merged (got: $GOOD — the gate is over-blocking good work)"

GB=$(status_of gate-bad)
if [ "$GB" = quarantined ]; then
  if no_pipeline_error gate-bad; then pass "gate-bad handled: quarantined (planted violation caught)"; fi
  expect "gate-bad has a quarantine dossier" test -f "$REPO/.roadmap/quarantine/gate-bad.md"
elif [ "$GB" = merged ]; then
  # Merged is fine ONLY if the planted rounding violation was actually fixed en route.
  if node -e "const a=require('assert'),c=require('$WT/__integration/calc');a.strictEqual(c.percent(-1,8),-13)" >/dev/null 2>&1; then
    pass "gate-bad handled: merged with the planted violation fixed (caught at review or gate)"
  else
    flunk "gate-bad RUBBER-STAMPED: merged with percent(-1,8) !== -13 — the planted spec violation reached integration"
  fi
else
  flunk "gate-bad handled (got: $GB)"
fi

# --- conventions-contract probe ------------------------------------------------
# gate-convention reimplements the catalogued shared.gcd inline (conventions.md clause 1).
# The runnable checks pass either way, so this is caught only by reading the conventions
# contract against the diff. Quarantine, or merge with the duplication removed, both count;
# merging the inline reimplementation as-is is a rubber-stamp of a frozen-contract violation.
GC=$(status_of gate-convention)
if [ "$GC" = quarantined ]; then
  if no_pipeline_error gate-convention; then pass "gate-convention handled: quarantined (catalogued-helper duplication caught)"; fi
  expect "gate-convention has a quarantine dossier" test -f "$REPO/.roadmap/quarantine/gate-convention.md"
elif [ "$GC" = merged ]; then
  # Merged is acceptable ONLY if the inline gcd was replaced by a reference to shared.gcd.
  if grep -Eq "require\(['\"]\./shared['\"]\)" "$WT/__integration/calc.js" 2>/dev/null \
     && grep -q "gcd" "$WT/__integration/calc.js" 2>/dev/null; then
    pass "gate-convention handled: merged with the duplication removed (reuses shared.gcd)"
  else
    flunk "gate-convention RUBBER-STAMPED: merged with gcd reimplemented inline — the conventions-contract violation reached integration"
  fi
else
  flunk "gate-convention handled (got: $GC)"
fi

# --- green-tip mirror (the __preview worktree) ----------------------------------
# The fixture plan carries an api-kind preview block, so the harness must detach the PREVIEW
# WORKTREE ($WT/__preview) at the final suite-green tip (state.json's integrationTip — the
# branch tip can sit ahead of it when a final merge was reverted; the mirror tracks green
# only). Since 0.13.0 the mirror is that worktree and never the operator's checkout, so the
# primary checkout staying exactly where the fixture left it is itself an assertion.
# The load-bearing property is checked implicitly above: unit statuses must match the
# table exactly — the preview may never alter any outcome (feedback accumulates; it
# never steers).
TIP=$(node -e "const s=require('$STATE');console.log(s.integrationTip||'')")
PREV="$WT/__preview"
if [ ! -d "$PREV" ]; then
  flunk "preview worktree exists at $PREV"
elif git -C "$PREV" symbolic-ref -q HEAD >/dev/null 2>&1; then
  flunk "preview mirror is a detached-HEAD checkout (still on a branch)"
else
  pass "preview mirror is a detached-HEAD checkout"
fi
HEAD_SHA=$(git -C "$PREV" rev-parse HEAD 2>/dev/null)
[ -n "$TIP" ] && [ "$HEAD_SHA" = "$TIP" ] \
  && pass "mirror rides the integration tip ($TIP)" \
  || flunk "mirror rides the integration tip (HEAD=$HEAD_SHA tip=$TIP)"
# The operator's checkout is never touched — that is what __preview exists for. The fixture
# leaves $REPO on `main`; an arc that moves it has broken the invariant, not just the mirror.
REPO_REF=$(git -C "$REPO" symbolic-ref -q --short HEAD 2>/dev/null)
[ "$REPO_REF" = main ] \
  && pass "primary checkout untouched by the run (still on main)" \
  || flunk "primary checkout untouched by the run (expected main, got: ${REPO_REF:-detached HEAD})"
PV_STATUS=$(node -e "const s=require('$STATE');console.log((s.preview||{}).status||'absent')")
PV_SHA=$(node -e "const s=require('$STATE');console.log((s.preview||{}).sha||'')")
[ "$PV_STATUS" = live ] && pass "state.json preview.status is live" || flunk "state.json preview.status is live (got: $PV_STATUS)"
[ -n "$PV_SHA" ] && [ "$PV_SHA" = "$TIP" ] \
  && pass "state.json preview.sha matches the integration tip" \
  || flunk "state.json preview.sha matches the integration tip (got: $PV_SHA)"

# --- boundary phase (wave-tail explorer + health assessor + flake re-runs) ------
# The harness runs the boundary phase at the wave tail (config.boundary defaults on); its
# results ride the returned state's `boundary` block and are rendered to feedback/ by Haiku
# verbatim-writers. healthCheck defaults on, so the health file is always written; the fixture
# plan carries a live api-kind preview, so the runtime explorer runs and its file is too.
# The wave number is READ, never assumed: a fixture that halted (a codex usage limit) and was
# relaunched legitimately finishes on wave 2, and its boundary is written under THAT wave.
# check-conductor.sh keys its own final-wave probes the same way, for the same reason.
WAVE=$(node -e "const s=require('$STATE');console.log(Number(s.wave)||0)")
[ "$WAVE" -ge 1 ] || flunk "state.json carries a wave number (got: $WAVE)"
BOUNDARY=$(node -e "const s=require('$STATE');console.log(s.boundary?'present':'absent')")
[ "$BOUNDARY" = present ] && pass "state.json carries a boundary block (wave-$WAVE tail phase ran)" || flunk "state.json carries a boundary block (got: $BOUNDARY)"
expect "wave-$WAVE health feedback written" test -f "$REPO/.roadmap/feedback/health/wave-$WAVE.md"
expect "wave-$WAVE explorer feedback written" test -f "$REPO/.roadmap/feedback/explorer/wave-$WAVE.md"

# --- integrated result --------------------------------------------------------
expect "integration branch exists" git -C "$REPO" rev-parse --verify roadmap/eval
if [ -d "$WT/__integration" ]; then
  ( cd "$WT/__integration" && bash test.sh ) >/dev/null 2>&1 \
    && pass "full suite passes on the integration worktree" \
    || flunk "full suite passes on the integration worktree"
else
  flunk "integration worktree exists at $WT/__integration"
fi

# --- codex executor lane (the implementer is `codex exec`; steering leaves artifacts) ----
# Fresh-implement units (add-multiply, add-divide) must have been built by a real codex run.
# The contract edge between them makes a warm lane: when it forms, ONE codex chain session
# builds both and the artifacts live under the HEAD's chain/ dir; when it demotes, each unit
# gets its own build/ dir. Either evidence satisfies the check.
for id in add-multiply add-divide; do
  D="$WT/__codex/$id/build"
  [ -f "$D/exit-code" ] || D="$WT/__codex/add-multiply/chain"
  if [ -f "$D/exit-code" ] && [ "$(cat "$D/exit-code")" = "0" ]; then
    pass "$id codex build ran to a clean exit ($D)"
  else
    flunk "$id codex build exit-code is 0 (got: $(cat "$D/exit-code" 2>/dev/null || echo absent))"
  fi
  expect "$id codex events stream captured" test -s "$D/events.jsonl"
  expect "$id codex session id captured" test -s "$D/session-id"
done
# The write-bar, end to end: no codex artifact may ever enter git history.
if git -C "$REPO" log --all --name-only --format= 2>/dev/null | grep -q "__codex"; then
  flunk "no __codex artifact in any commit (write-bar breached)"
else
  pass "no __codex artifact in any commit (write-bar held)"
fi

# --- runaway-loop ceilings (the spiral, made measurable) -------------------------
# units[id].rounds tallies fix/gate rounds; the config bounds them at 2 apiece, and a healthy
# run sits well below. gate-good is the sharpest probe: a clean adopted branch must not need a
# single fix round. Debt volume per unit is bounded by the brief's consolidation cap.
node -e "
const s = require('$STATE'); let bad = 0
const r = (id) => (s.units[id] || {}).rounds || { fix: 0, opusGate: 0, gate: 0 }
for (const id of ['add-multiply', 'add-divide', 'gate-good']) {
  const x = r(id)
  if (x.fix > 2 || (x.opusGate + x.gate) > 4) { console.log('FAIL  ' + id + ' round ceiling: ' + JSON.stringify(x)); bad = 1 }
  else console.log('PASS  ' + id + ' rounds within ceiling: ' + JSON.stringify(x))
}
if (r('gate-good').fix > 0) console.log('WARN  gate-good needed ' + r('gate-good').fix + ' fix round(s) on a clean branch — gate/verify noise')
const perUnit = {}
for (const d of (s.debt || [])) perUnit[d.unit] = (perUnit[d.unit] || 0) + 1
for (const [id, n] of Object.entries(perUnit))
  if (n > 8) { console.log('FAIL  ' + id + ' banked ' + n + ' debt items (> 8 — the consolidation cap is not holding)'); bad = 1 }
console.log('debt per unit: ' + JSON.stringify(perUnit))
process.exit(bad)
" || fail=1

# --- spend sanity (informational thresholds, generous by design) ---------------
# Since 0.14.0 the wave-tail boundary phase spends CODEX, not Claude: explorer, health, flake and
# design are codex roles that write their own reports, and the Haiku transcription writers are
# gone. The envelope below bounds fable/gateRounds/consults only, none of which the boundary
# touches, so no threshold widening is needed for it.
node -e "
const s = require('$STATE'); const sp = s.spend || {}
console.log('spend:', JSON.stringify(sp))
console.log('plan-checks: opus=' + (sp.opusPlanChecks ?? 0) + ' fable=' + (sp.planChecks ?? 0))
console.log('codex: runs=' + (sp.codexRuns ?? 0) + ' in=' + (sp.codexInputTokens ?? 0) + ' out=' + (sp.codexOutputTokens ?? 0))
if ((sp.codexRuns ?? 0) < 2) console.log('WARN  fewer than 2 codex runs recorded for 2 fresh-implement units')
const merged = Object.values(s.units).filter(u => u.status === 'merged').length
let warn = ''
if ((sp.gateRounds ?? 0) > merged * 2 + 2) warn += 'gate rounds high relative to merged units (convergence?); '
if ((s.consultsUsed ?? 0) > 2) warn += 'consult cap exceeded?; '
if ((sp.fable ?? 0) > 12) warn += 'frontier call count high for a 6-unit fixture; '
if (warn) { console.log('WARN  ' + warn) } else { console.log('PASS  spend within expected envelope') }
"

echo
if [ "$fail" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "CHECKS FAILED — see FAIL lines above"; fi
exit $fail
