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

# --- green-tip mirror (preview) -------------------------------------------------
# The fixture plan carries an api-kind preview block, so the harness must detach the
# primary checkout at the final suite-green tip (state.json's integrationTip — the branch
# tip can sit ahead of it when a final merge was reverted; the mirror tracks green only).
# The load-bearing property is checked implicitly above: unit statuses must match the
# table exactly — the preview may never alter any outcome (feedback accumulates; it
# never steers).
TIP=$(node -e "const s=require('$STATE');console.log(s.integrationTip||'')")
if git -C "$REPO" symbolic-ref -q HEAD >/dev/null 2>&1; then
  flunk "primary checkout is a detached-HEAD mirror (still on a branch)"
else
  pass "primary checkout is a detached-HEAD mirror"
fi
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
[ -n "$TIP" ] && [ "$HEAD_SHA" = "$TIP" ] \
  && pass "mirror rides the integration tip ($TIP)" \
  || flunk "mirror rides the integration tip (HEAD=$HEAD_SHA tip=$TIP)"
PV_STATUS=$(node -e "const s=require('$STATE');console.log((s.preview||{}).status||'absent')")
PV_SHA=$(node -e "const s=require('$STATE');console.log((s.preview||{}).sha||'')")
[ "$PV_STATUS" = live ] && pass "state.json preview.status is live" || flunk "state.json preview.status is live (got: $PV_STATUS)"
[ -n "$PV_SHA" ] && [ "$PV_SHA" = "$TIP" ] \
  && pass "state.json preview.sha matches the integration tip" \
  || flunk "state.json preview.sha matches the integration tip (got: $PV_SHA)"

# --- integrated result --------------------------------------------------------
expect "integration branch exists" git -C "$REPO" rev-parse --verify roadmap/eval
if [ -d "$WT/__integration" ]; then
  ( cd "$WT/__integration" && bash test.sh ) >/dev/null 2>&1 \
    && pass "full suite passes on the integration worktree" \
    || flunk "full suite passes on the integration worktree"
else
  flunk "integration worktree exists at $WT/__integration"
fi

# --- spend sanity (informational thresholds, generous by design) ---------------
node -e "
const s = require('$STATE'); const sp = s.spend || {}
console.log('spend:', JSON.stringify(sp))
const merged = Object.values(s.units).filter(u => u.status === 'merged').length
let warn = ''
if ((sp.gateRounds ?? 0) > merged * 2 + 2) warn += 'gate rounds high relative to merged units (convergence?); '
if ((s.consultsUsed ?? 0) > 2) warn += 'consult cap exceeded?; '
if ((sp.fable ?? 0) > 17) warn += 'frontier call count high for a 6-unit fixture; '
if (warn) { console.log('WARN  ' + warn) } else { console.log('PASS  spend within expected envelope') }
"

echo
if [ "$fail" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "CHECKS FAILED — see FAIL lines above"; fi
exit $fail
