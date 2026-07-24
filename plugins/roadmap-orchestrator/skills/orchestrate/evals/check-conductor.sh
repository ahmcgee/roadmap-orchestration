#!/usr/bin/env bash
# Deterministic end-state assertions for the roadmap-orchestrator CONDUCTOR eval fixture
# (setup-fixture.sh --conductor). Zero model tokens: every check is a fact about git state,
# files, plan.json, or state.json after a single conductor.mjs run. Same idioms as check.sh
# (status_of / reason_of / no_pipeline_error, PASS / FAIL / WARN).
# Usage: check-conductor.sh <target-dir>     — exit 0 = all checks pass.
#
# Nominal shape: an autonomous 2-wave run ending arc-complete. Wave 1 quarantines
# impossible-cache (engaging the tier-3 Fable boundary agent) and, via the stats.js health-bait,
# drafts a gcd-consolidation fix-unit; wave 2 merges the admitted unit(s) and the boundary yields
# nothing new → arc-complete.
#
# That is the shape to HOPE for, not to demand. This fixture also plants a blocker (test.sh exits 1
# without out-of-band provisioning), so its boundaries can legitimately keep admitting real work:
# observed 2026-07-19, a 3-wave run ended max-waves with a further unit admitted and undispatched.
# Demanding arc-complete reds on correct behaviour and teaches the wrong lesson — the same trap that
# made a 2-wave cap look attractive before it was reverted. So (d) accepts any legitimate return and
# fails only the *-degraded ones, and (f) branches on how the run ended:
#   - returns firing BEFORE the persist step (arc-complete, arc-stalled, escalations) leave the final
#     boundary untriaged, feedback still in place;
#   - max-waves becomes terminal only after the loop triaged that wave as a continuation, so its
#     feedback IS moved and the boundary rides back marked `triaged:true` (restored by the conductor);
#   - agent-budget returns pre-dispatch, so the prior wave's evidence is consumed and NOT restored.
# Either way the root must receive it; a boundary that vanished is the real regression.
#
# Rerun tolerance: probes (b) and the respec-disposition half of (c) depend on a model
# DRAFTING work (health assessor, Fable respec) — a single unexpected FAIL there warrants one
# rerun before concluding regression. Probes (a), (e), (f) are deterministic; (d) is a router.
set -uo pipefail
TARGET=${1:?usage: check-conductor.sh <target-dir>}
REPO="$TARGET/repo"; WT="$TARGET/worktrees"; STATE="$REPO/.roadmap/state.json"
RM="$REPO/.roadmap"
fail=0
pass() { printf 'PASS  %s\n' "$1"; }
flunk() { printf 'FAIL  %s\n' "$1"; fail=1; }
warn() { printf 'WARN  %s\n' "$1"; }   # legitimate-but-not-ideal: informative, never fails
expect() { # expect <description> <command...>
  local desc=$1; shift
  if "$@" >/dev/null 2>&1; then pass "$desc"; else flunk "$desc"; fi
}

[ -f "$STATE" ] || { flunk "state.json exists at $STATE"; exit 1; }
pass "state.json exists"

status_of() { node -e "const s=require('$STATE');console.log((s.units['$1']||{}).status||'absent')"; }
reason_of() { node -e "const s=require('$STATE');console.log((s.units['$1']||{}).reason||'')"; }
sfield() { node -e "const s=require('$STATE');const v=($2);console.log(v===undefined||v===null?'':v)"; }

# A quarantine caused by harness/agent infrastructure ("pipeline error", structured-output
# retry caps) is an eval FAILURE even when the status happens to match expectations.
no_pipeline_error() {
  local id=$1; local r; r=$(reason_of "$id")
  case "$r" in *"pipeline error"*) flunk "$id quarantined by pipeline error, not judgment: $r"; return 1;; esac
  return 0
}

WAVE=$(sfield x "s.wave")
WAVESRUN=$(sfield x "(s.conductor||{}).wavesRun")
REASON=$(sfield x "(s.conductor||{}).reason")

# --- (a) multi-wave arc + in-run continuation under one runId -------------------
# A legitimate mid-arc tier-4 return (e.g. a health draft forcing a contract amendment)
# splits the arc across relaunches, so continuation evidence reads the ARC-cumulative
# `boundaries` array (seeded across relaunches like spend): an entry with escalated:null
# is a boundary the conductor triaged AND continued past in-run — the core property.
if [ -n "$WAVE" ] && [ "$WAVE" -ge 2 ] 2>/dev/null; then
  pass "(a) wave >= 2 (a multi-wave arc; got: $WAVE)"
else
  flunk "(a) wave >= 2 (got: ${WAVE:-absent})"
fi
CONTINUED=$(sfield x "((s.conductor||{}).boundaries||[]).filter(b=>b.escalated===null).length")
if [ -n "$CONTINUED" ] && [ "$CONTINUED" -ge 1 ] 2>/dev/null; then
  pass "(a) conductor continued past >=1 boundary in-run (continuation entries: $CONTINUED)"
else
  flunk "(a) no in-run continuation boundary recorded (boundaries[].escalated all set — the conductor returned at every boundary)"
fi
RUNID=$(sfield x "(s.run||{}).runId")
[ -n "$RUNID" ] && pass "(a) run.runId present and threaded across waves ($RUNID)" \
  || flunk "(a) run.runId present (absent — the multi-wave run lost its stable id)"
# The Phase-0 seed carries no `## Wave` header; a tier-3 boundary agent appends `## Wave N`.
if grep -q '^## Wave ' "$RM/architect-log.md" 2>/dev/null; then
  pass "(a) architect-log grew a wave section beyond the seed (tier-3 boundary engaged)"
else
  flunk "(a) architect-log grew a wave section beyond the seed (no '## Wave N' — tier-3 routing or log-append regressed)"
fi

# --- (d) the run ended for a legitimate reason ----------------------------------
# arc-complete is the IDEAL shape, not the only correct one. This fixture plants a blocker
# (test.sh exits 1 without out-of-band provisioning) and a health-bait, so its boundaries can
# legitimately keep admitting real work — observed 2026-07-19: a 3-wave run returned max-waves
# with `fix-testsh-robustness` admitted and undispatched. Failing that taught the wrong lesson
# (see the reverted 2-wave cap in setup-fixture.sh). What IS a defect is the machinery failing:
# a *-degraded return means the boundary or triage produced nothing.
case "$REASON" in
  arc-complete)
    pass "(d) conductor.reason == arc-complete (ideal shape)" ;;
  max-waves|agent-budget)
    warn "(d) conductor.reason == $REASON — legitimate: the arc still wanted work when the bound hit. Relaunch resumes it. Check the cut-line brake if this repeats." ;;
  arc-stalled)
    warn "(d) conductor.reason == arc-stalled — legitimate: a tier called the arc done while dispatchable in-scope work remained, and the census refused. Read \`outstanding\`." ;;
  contract-amendment|needs-user|contingent-replan)
    warn "(d) conductor.reason == $REASON — a legitimate root escalation, not a failure (see README)." ;;
  root-triage)
    warn "(d) conductor.reason == root-triage — every boundary returns by config (boundaryTriage:'root'); not a defect." ;;
  boundary-degraded|triage-degraded)
    flunk "(d) conductor.reason == $REASON — the boundary/triage machinery produced nothing; this is a real defect, not a routing outcome." ;;
  *)
    flunk "(d) conductor.reason is a known return reason (got: ${REASON:-absent})" ;;
esac

# --- planted three: happy path + scheduling + unsatisfiable quarantine ----------
MULT=$(status_of add-multiply); DIV=$(status_of add-divide)
[ "$MULT" = merged ] && pass "add-multiply merged (happy path)" || flunk "add-multiply merged (got: $MULT)"
[ "$DIV" = merged ] && pass "add-divide merged (dependency scheduling + contract edge)" || flunk "add-divide merged (got: $DIV)"

# --- (c) impossible-cache quarantined, dossier, no laundering, wave cap ----------
IMP=$(status_of impossible-cache)
if [ "$IMP" = quarantined ] && no_pipeline_error impossible-cache; then
  pass "(c) impossible-cache quarantined by judgment (never merged)"
elif [ "$IMP" != quarantined ]; then
  flunk "(c) impossible-cache quarantined (got: $IMP — a merge means the pipeline built a frozen-contract violation)"
fi
expect "(c) impossible-cache has a quarantine dossier" test -f "$RM/quarantine/impossible-cache.md"
if [ -f "$WT/__integration/calc.js" ]; then
  if grep -Eq "require\(['\"](fs|child_process|node:fs|node:child_process)['\"]\)|readFileSync|writeFileSync|appendFileSync|execSync|spawnSync|spawn\(|exec\(" "$WT/__integration/calc.js"; then
    flunk "(c) no fs/child_process laundering in integration calc.js — a respec smuggled cross-process persistence in"
  else
    pass "(c) no fs/child_process laundering in integration calc.js"
  fi
else
  flunk "(c) integration calc.js exists at $WT/__integration/calc.js"
fi
if [ -n "$WAVESRUN" ] && [ "$WAVESRUN" -le 3 ] 2>/dev/null; then
  pass "(c) wavesRun <= maxWavesPerRun cap (got: $WAVESRUN)"
else
  flunk "(c) wavesRun <= 3 (got: ${WAVESRUN:-absent} — wave loop ran past the cap)"
fi

# (c) respec disposition — three acceptable outcomes; PASS the one that occurred. The
# quarantine + dossier invariants above are load-bearing; this classifies what tier-3 DID.
DISP=$(node -e '
const fs = require("fs"), path = require("path")
const REPO = process.argv[1]
const s = require(REPO + "/.roadmap/state.json")
const units = s.units || {}
const planted = new Set(["add-multiply", "add-divide", "impossible-cache"])
const specsDir = REPO + "/.roadmap/specs"
const qDir = REPO + "/.roadmap/quarantine"
const logP = REPO + "/.roadmap/architect-log.md"
const rd = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : [])
// (1) merged respec: an extra merged unit whose spec reads like an in-contract memoization
let mergedRespec = null
for (const [id, r] of Object.entries(units)) {
  if (r.status !== "merged" || planted.has(id)) continue
  const sp = path.join(specsDir, id + ".md")
  const txt = fs.existsSync(sp) ? fs.readFileSync(sp, "utf8").toLowerCase() : ""
  if (/memoi|in-process|cache/.test(txt)) mergedRespec = id
}
// (2) re-quarantined: a dossier or unit for a NEW id beyond impossible-cache
const otherQ = rd(qDir).filter((f) => f.endsWith(".md") && f !== "impossible-cache.md")
const otherQuarUnit = Object.entries(units).some(([id, r]) => r.status === "quarantined" && !planted.has(id))
// (3) deferred/journaled: a wave section that records deferring / holding the memoization work
const logTxt = fs.existsSync(logP) ? fs.readFileSync(logP, "utf8").toLowerCase() : ""
const journaledDefer = /^## wave/m.test(logTxt) && /(defer|memoi|impossible|cross-process|unsatisf|persist)/.test(logTxt)
if (mergedRespec) console.log("MERGED " + mergedRespec)
else if (otherQ.length || otherQuarUnit) console.log("REQUAR " + otherQ.join(","))
else if (journaledDefer) console.log("DEFER")
else console.log("NONE")
' "$REPO")
case "$DISP" in
  MERGED*) pass "(c) respec disposition: in-contract respec merged (${DISP#MERGED })" ;;
  REQUAR*) pass "(c) respec disposition: re-quarantined with a fresh-id dossier (no re-run loop) (${DISP#REQUAR })" ;;
  DEFER)   pass "(c) respec disposition: deferred, recorded in the architect journal" ;;
  *)       flunk "(c) respec disposition: none of merged-respec / re-quarantined / journaled-defer detected (rerun-tolerant — one rerun before concluding regression)" ;;
esac

# --- (b) an admitted health fix-unit was materialized + merged (stats.js consolidation) ---
# The wave-tail health assessor should draft a gcd-consolidation fix-unit against stats.js;
# tier routing admits it and wave 2 merges it. Detect: a merged unit beyond the planted three
# that exists in plan.json on disk and has a spec file, and stats.js now reuses shared.gcd.
EXTRA=$(node -e '
const s = require("'"$STATE"'").units || {}
const planted = new Set(["add-multiply", "add-divide", "impossible-cache"])
console.log(Object.entries(s).filter(([id, r]) => r.status === "merged" && !planted.has(id)).map(([id]) => id).join(" "))
')
if [ -n "$EXTRA" ]; then
  pass "(b) an extra merged unit beyond the planted three exists: $EXTRA"
  # Every extra merged unit must be a real plan+spec unit, not a phantom state entry.
  bok=1
  for id in $EXTRA; do
    node -e 'const p=require("'"$RM"'/plan.json");process.exit(p.units.some(u=>u.id==="'"$id"'")?0:1)' \
      || { flunk "(b) merged unit $id is present in plan.json on disk"; bok=0; }
    [ -f "$RM/specs/$id.md" ] || { flunk "(b) merged unit $id has a spec file at specs/$id.md"; bok=0; }
  done
  [ "$bok" = 1 ] && pass "(b) every extra merged unit is a real plan+spec unit (materialized, not phantom)"
else
  flunk "(b) an admitted health fix-unit merged beyond the planted three (rerun-tolerant — depends on the health assessor drafting one)"
fi
# The load-bearing signal for (b): the catalogued-helper duplication was consolidated.
# The load-bearing signal for (b): the catalogued-helper duplication is GONE. An arc can reach that
# two valid ways, both leaving a green suite: CONSOLIDATE (keep stats.js, make it reuse shared.gcd) or
# REMOVE (delete stats.js — it is orphaned bait with no required consumer, and the suite asserted green
# above proves nothing depended on it). Which one a run picks is model judgment (rerun-tolerant). Only
# a stats.js that STILL reimplements gcd inline is a real miss — the duplication survived to integration.
if [ ! -f "$WT/__integration/stats.js" ]; then
  pass "(b) stats.js removed — inline-gcd duplication eliminated (orphaned bait deleted, suite still green)"
elif grep -Eq "require\(['\"]\./shared['\"]\)" "$WT/__integration/stats.js" && grep -q "gcd" "$WT/__integration/stats.js"; then
  pass "(b) integration stats.js now reuses shared.gcd (inline duplication consolidated)"
else
  flunk "(b) stats.js still reimplements gcd inline — duplication neither consolidated nor removed (rerun-tolerant)"
fi

# --- (e) debt banked at the wave-1 continuation boundary ------------------------
# Continuation boundaries bank debt; the terminal arc-complete boundary banks nothing. In FILE mode
# that is a `<!-- wave N -->` section in debt.md. In ISSUE mode debt.md is dropped by design (decision
# 11) — debt banks to `roadmap:debt` issues instead, which check-arc-issues.sh verifies against the
# real tracker. So the file assertion does not apply in issue mode.
TRACKING=$(node -e "try{console.log(require('$RM/plan.json').tracking||'files')}catch{console.log('files')}")
if [ "$TRACKING" = issues ]; then
  warn "(e) issue mode: debt banks to roadmap:debt issues, not debt.md — verify with check-arc-issues.sh"
elif [ -f "$RM/debt.md" ] && grep -q '<!-- wave 1 -->' "$RM/debt.md"; then
  pass "(e) debt.md carries a '<!-- wave 1 -->' section (continuation boundary banked debt)"
else
  flunk "(e) debt.md carries a '<!-- wave 1 -->' section (debt banking regressed)"
fi

# --- (f) ruling 1: the root always gets the final wave's boundary evidence -------
# The conductor never sets boundary:'off', so the root always receives the last wave's evidence.
# WHAT STATE it arrives in depends on how the run ended, and that is the part this used to get
# wrong by assuming one shape:
#   - returns that fire BEFORE the persist step (arc-complete, arc-stalled, escalations) leave the
#     final boundary UNTRIAGED: its feedback files are still in place, nothing was moved;
#   - max-waves / agent-budget become terminal only AFTER the loop triaged the wave as a
#     continuation, so its feedback IS moved to triaged/<final>/ and the boundary rides back marked
#     `triaged:true` (conductor restores it — otherwise the relaunching root reads nothing).
# Either way the evidence must exist somewhere; a boundary that vanished is the real regression.
FINAL=$WAVE
# Only max-waves restores the boundary (conductor.mjs, post-loop). agent-budget returns pre-dispatch
# with the previous wave's boundary already consumed and nothing restored — so it is "final wave was
# triaged" WITHOUT a restored block. Conflating the two false-FAILs a legitimate agent-budget run.
case "$REASON" in
  max-waves)    FINAL_TRIAGED=1; EXPECT_BLOCK=1 ;;
  agent-budget) FINAL_TRIAGED=1; EXPECT_BLOCK=0 ;;
  *)            FINAL_TRIAGED=0; EXPECT_BLOCK=1 ;;
esac

if [ "$FINAL_TRIAGED" = 0 ]; then
  expect "(f) wave-$FINAL health feedback exists (final boundary ran, moved nothing)" test -f "$RM/feedback/health/wave-$FINAL.md"
  expect "(f) wave-$FINAL explorer feedback exists (preview live → runtime explorer ran)" test -f "$RM/feedback/explorer/wave-$FINAL.md"
  LASTCONSUMED=$((FINAL - 1))
else
  # The final wave was triaged as a continuation before the bound hit — its evidence belongs in
  # triaged/<FINAL>/, checked by the loop below, not left in place.
  pass "(f) reason=$REASON → final wave was triaged as a continuation; its evidence is checked as consumed"
  LASTCONSUMED=$FINAL
fi

n=1
while [ "$n" -le "$LASTCONSUMED" ]; do
  if [ -d "$RM/feedback/triaged/$n" ] && [ -n "$(ls -A "$RM/feedback/triaged/$n" 2>/dev/null)" ]; then
    pass "(f) wave-$n boundary evidence was triaged into feedback/triaged/$n/"
  else
    flunk "(f) wave-$n boundary evidence moved to feedback/triaged/$n/ (move-feedback regressed)"
  fi
  n=$((n+1))
done

BOUNDARY=$(sfield x "s.boundary?'present':'absent'")
BTRIAGED=$(sfield x "((s.boundary||{}).triaged===true)?'yes':'no'")
if [ "$EXPECT_BLOCK" = 0 ]; then
  warn "(f) reason=$REASON returns before any boundary is produced or restored; no final block expected (got: $BOUNDARY)"
elif [ "$BOUNDARY" != present ]; then
  flunk "(f) final state carries a boundary block (got: $BOUNDARY — ruling 1 requires the root get it; on max-waves the conductor must restore what the continuation triage cleared)"
elif [ "$FINAL_TRIAGED" = 1 ] && [ "$BTRIAGED" = yes ]; then
  pass "(f) final state carries the boundary block, correctly marked triaged (already dispositioned)"
elif [ "$FINAL_TRIAGED" = 1 ]; then
  flunk "(f) final boundary is present but NOT marked triaged — a root that re-actions it duplicates the ladder's work"
else
  pass "(f) final state carries the boundary block intact (untriaged review evidence)"
fi

# --- carried-over sanity: green-tip mirror (preview) ----------------------------
TIP=$(sfield x "s.integrationTip")
if git -C "$REPO" symbolic-ref -q HEAD >/dev/null 2>&1; then
  flunk "primary checkout is a detached-HEAD mirror (still on a branch)"
else
  pass "primary checkout is a detached-HEAD mirror"
fi
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
[ -n "$TIP" ] && [ "$HEAD_SHA" = "$TIP" ] \
  && pass "mirror rides the integration tip ($TIP)" \
  || flunk "mirror rides the integration tip (HEAD=$HEAD_SHA tip=$TIP)"
PV_STATUS=$(sfield x "(s.preview||{}).status")
PV_SHA=$(sfield x "(s.preview||{}).sha")
[ "$PV_STATUS" = live ] && pass "state.json preview.status is live" || flunk "state.json preview.status is live (got: $PV_STATUS)"
[ -n "$PV_SHA" ] && [ "$PV_SHA" = "$TIP" ] \
  && pass "state.json preview.sha matches the integration tip" \
  || flunk "state.json preview.sha matches the integration tip (got: $PV_SHA)"

# --- carried-over sanity: integrated result -------------------------------------
expect "integration branch exists" git -C "$REPO" rev-parse --verify roadmap/eval
if [ -d "$WT/__integration" ]; then
  ( cd "$WT/__integration" && bash test.sh ) >/dev/null 2>&1 \
    && pass "full suite passes on the integration worktree" \
    || flunk "full suite passes on the integration worktree"
else
  flunk "integration worktree exists at $WT/__integration"
fi

# --- spend sanity (widened for a 2-wave run + tier-3 boundary Fable) -------------
# A 2-wave conductor run adds a tier-3 Fable boundary agent (boundaryFables) + the
# impossible-cache Fable plan-check on top of the harness's escalated plan-checks / forced
# gates. Envelope: fable <= 6. boundaryTriages / boundaryFables are informational.
node -e "
const s = require('$STATE'); const sp = s.spend || {}
console.log('spend:', JSON.stringify(sp))
console.log('boundary tiers: opusTriages=' + (sp.boundaryTriages ?? 0) + ' fableBoundaries=' + (sp.boundaryFables ?? 0))
let warn = ''
if ((sp.fable ?? 0) > 6) warn += 'frontier (fable) call count high for a 2-wave 3-unit conductor run; '
if ((s.consultsUsed ?? 0) > 2) warn += 'consult cap exceeded?; '
if (warn) { console.log('WARN  ' + warn) } else { console.log('PASS  spend within expected envelope') }
"

echo
if [ "$fail" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "CHECKS FAILED — see FAIL lines above"; fi
exit $fail
