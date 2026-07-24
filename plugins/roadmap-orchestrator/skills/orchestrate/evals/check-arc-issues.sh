#!/usr/bin/env bash
# Post-arc issue-projection assertions. After a paid eval arc ran in ISSUE MODE (bootstrapped by
# issue-bootstrap.sh), verify the GitHub projection tracked the arc's real end state — which is
# state.json, the source of truth — and surface the rate-limit signal (gh-sync degradations). Zero
# model tokens: every assertion is a gh fact checked against the final state.
#   bash check-arc-issues.sh <fixture-dir>
set -uo pipefail
DIR=${1:?usage: check-arc-issues.sh <fixture-dir>}
MAN="$DIR/.issue-manifest.json"; STATE="$DIR/repo/.roadmap/state.json"
[ -f "$MAN" ] || { echo "no manifest at $MAN (run issue-bootstrap.sh first)"; exit 2; }
[ -f "$STATE" ] || { echo "no state.json at $STATE (did the arc run?)"; exit 2; }
REPO=$(node -e "console.log(require('$MAN').repo)")
G=(--repo "$REPO")
fail=0
pass() { printf 'PASS  %s\n' "$1"; }
flunk() { printf 'FAIL  %s\n' "$1"; fail=1; }
state_of() { gh issue view "${G[@]}" "$1" --json state --jq .state 2>/dev/null; }
labels_of() { gh issue view "${G[@]}" "$1" --json labels --jq '[.labels[].name]|join(",")' 2>/dev/null; }
has_label() { case ",$(labels_of "$1")," in *",$2,"*) return 0;; *) return 1;; esac; }

echo "issue-projection check for $DIR against $REPO"

# Per-unit: the issue state must match the unit's FINAL status in state.json (process substitution so
# the loop runs in this shell and `fail` persists — not a pipe).
while IFS='|' read -r id n st; do
  [ -z "$id" ] && continue
  case "$st" in
    merged)
      [ "$(state_of "$n")" = CLOSED ] && pass "unit $id (#$n) merged -> issue CLOSED" || flunk "unit $id (#$n) merged but issue not CLOSED"
      has_label "$n" status:merged && pass "unit $id (#$n) has status:merged" || flunk "unit $id (#$n) missing status:merged" ;;
    quarantined)
      [ "$(state_of "$n")" = OPEN ] && pass "unit $id (#$n) quarantined -> issue OPEN" || flunk "unit $id (#$n) quarantined but issue not OPEN"
      has_label "$n" status:quarantined && pass "unit $id (#$n) has status:quarantined" || flunk "unit $id (#$n) missing status:quarantined" ;;
    deferred)
      [ "$(state_of "$n")" = CLOSED ] && pass "unit $id (#$n) deferred -> issue CLOSED" || flunk "unit $id (#$n) deferred but issue not CLOSED" ;;
    *) echo "INFO  unit $id (#$n) final status '$st' — no strict projection assertion (non-terminal)" ;;
  esac
done < <(node -e "
const m=require('$MAN'), s=require('$STATE');
for(const [id,n] of Object.entries(m.unitIssues||{})){
  const st=(s.units[id]||{}).status||'absent';
  console.log([id,n,st].join('|'));
}")

# Arc tracking issue: the status region carries a rendered task list.
TRACK=$(node -e "console.log(require('$MAN').trackingIssue||'')")
if [ -n "$TRACK" ]; then
  BODY=$(gh issue view "${G[@]}" "$TRACK" --json body --jq .body 2>/dev/null)
  REGION=$(printf '%s\n' "$BODY" | awk '/<!-- roadmap:status -->/{f=1;next} /<!-- \/roadmap:status -->/{f=0} f')
  if printf '%s' "$REGION" | grep -Eq -- '- \[[ x]\] #[0-9]+'; then
    pass "arc tracking issue (#$TRACK) renders a unit task list in the status region"
  else
    flunk "arc tracking issue (#$TRACK) status region has no task list"
  fi
else
  echo "INFO  no tracking issue recorded — skipping task-list check"
fi

# Debt projection (informational): issue mode banks tech debt to roadmap:debt issues (debt.md is
# dropped, decision 11). A continuation boundary that banked debt shows up here.
echo "-- debt projection --"
DEBTS=$(gh issue list "${G[@]}" --label roadmap:debt --state open --json number,title --jq '.[]|"  #\(.number) \(.title)"' 2>/dev/null)
[ -n "$DEBTS" ] && printf 'open roadmap:debt issues:\n%s\n' "$DEBTS" || echo "no open roadmap:debt issues"

# Rate-limit signal: gh-sync degradations are best-effort misses. A handful is fine; a flood means the
# projection strained a limit. Informational — issue state gates nothing, so this never fails the check.
echo "-- rate-limit signal --"
node -e "
const s=require('$STATE');
const gh=(s.degradations||[]).filter(d=>d.kind==='gh-sync');
console.log('gh-sync degradations: '+gh.length+(gh.length? ' (best-effort misses; the projection may lag but the arc is unaffected)':' (clean — no gh write was rate-limited or dropped)'));
for(const d of gh) console.log('  - '+(d.label||'?')+': '+(d.what||''));
"

echo "----"
[ "$fail" = 0 ] && echo "ALL PROJECTION CHECKS PASSED" || echo "SOME PROJECTION CHECKS FAILED"
exit "$fail"
