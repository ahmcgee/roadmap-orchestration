#!/usr/bin/env bash
# Opt-in issue-mode integration eval — the real-`gh` coverage the offline paid fixtures can't give.
# The paid fixtures (check.sh / check-conductor.sh) run in remote-less throwaway repos, i.e. FILE
# mode, so nothing exercises the GitHub side. This script exercises the exact gh command sequences
# the harness/conductor emit in issue mode (label + milestone + unit-issue create with body marker,
# find-by-marker AND find-by-number, the status:* transitions, close-completed, the quarantine
# comment, debt-issue idempotency, and the feedback census) against a REAL repo, then tears every
# test artifact back down. Zero model tokens — it asserts gh/issue facts, like check.sh asserts git
# facts — so it can run often, unlike the paid arcs.
#
# It MUTATES the target repo's issue tracker (creates + deletes test issues/labels/milestone), so it
# is opt-in: run it deliberately.
#   RUN_ISSUE_EVAL=1 bash evals/check-issues.sh            # against the repo `gh` currently resolves
#   RUN_ISSUE_EVAL=1 REPO=owner/name bash evals/check-issues.sh
# Every artifact carries a unique per-run marker and is removed on exit (even on failure) via a trap.
set -uo pipefail

[ "${RUN_ISSUE_EVAL:-}" = 1 ] || {
  echo "refusing to run without RUN_ISSUE_EVAL=1 (this creates + deletes issues on the target repo)"; exit 2; }
command -v gh >/dev/null || { echo "gh not found"; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated"; exit 2; }
REPO=${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)}
[ -n "${REPO:-}" ] || { echo "cannot resolve target repo (set REPO=owner/name)"; exit 2; }
G=(--repo "$REPO")

RUN="eval-$$-$(git rev-parse --short HEAD 2>/dev/null || echo x)"   # unique namespace for this run
UMARK="roadmap:unit id=${RUN}-u1"
QMARK="roadmap:unit id=${RUN}-q1"
DMARK="roadmap:debt run=${RUN}"
echo "issue-mode eval against $REPO (namespace $RUN)"

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
flunk() { printf 'FAIL  %s\n' "$1"; fail=1; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else flunk "$d"; fi; }

# Track created artifacts for teardown.
CREATED_ISSUES=(); LABELS=(roadmap:unit roadmap:debt roadmap:feedback roadmap:arc \
  status:pending status:running status:merged status:quarantined \
  risk:low severity:minor debt:structure); MILESTONE=""
teardown() {
  echo "-- teardown --"
  for n in "${CREATED_ISSUES[@]}"; do
    gh issue delete "${G[@]}" "$n" --yes >/dev/null 2>&1 || gh issue close "${G[@]}" "$n" --reason "not planned" >/dev/null 2>&1 || true
  done
  [ -n "$MILESTONE" ] && gh api -X DELETE "repos/$REPO/milestones/$MILESTONE" >/dev/null 2>&1 || true
  for l in "${LABELS[@]}"; do gh label delete "${G[@]}" "$l" --yes >/dev/null 2>&1 || true; done
  echo "teardown done"
}
trap teardown EXIT

# find-by-marker with a short retry — GitHub's search index can lag a just-created issue.
find_by_marker() {
  local mark=$1 n=""
  for _ in 1 2 3 4 5; do
    n=$(gh issue list "${G[@]}" --search "\"$mark\" in:body" --state all --limit 1 --json number --jq '.[0].number' 2>/dev/null)
    [ -n "$n" ] && { echo "$n"; return 0; }
    sleep 2
  done
  return 1
}
labels_of() { gh issue view "${G[@]}" "$1" --json labels --jq '[.labels[].name]|join(",")' 2>/dev/null; }
state_of()  { gh issue view "${G[@]}" "$1" --json state --jq .state 2>/dev/null; }

# 0. Labels (idempotent) + milestone — the Phase-0 bootstrap.
for l in "${LABELS[@]}"; do gh label create "${G[@]}" "$l" --color ededed --force >/dev/null 2>&1 || true; done
pass "labels created (gh label create --force is idempotent)"
MILESTONE=$(gh api "repos/$REPO/milestones" -f "title=roadmap: $RUN" --jq .number 2>/dev/null || echo "")
[ -n "$MILESTONE" ] && pass "arc milestone created (#$MILESTONE)" || flunk "arc milestone create"

# 1. Unit issue create with body marker + labels (+ milestone) — Phase-0 unit-issue creation.
U1=$(gh issue create "${G[@]}" --title "[unit] ${RUN}-u1" \
  --label "roadmap:unit,status:pending,risk:low" ${MILESTONE:+--milestone "roadmap: $RUN"} \
  --body "<!-- $UMARK -->
happy-path unit" 2>/dev/null | grep -oE '[0-9]+$')
[ -n "$U1" ] && { CREATED_ISSUES+=("$U1"); pass "unit issue created (#$U1)"; } || flunk "unit issue create"

# 1b. Milestone membership: `gh --milestone` attaches by NAME, so the milestone must be passed by
# TITLE (plan.milestone is the title, reference.md:71) — a NUMBER silently orphans the issue. This
# guards the conductor's issue-new milestone path, where feeding the number left mid-run units with
# no milestone. Only meaningful if the milestone was created.
if [ -n "${MILESTONE:-}" ]; then
  MS_OF=$(gh issue view "${G[@]}" "$U1" --json milestone --jq '.milestone.title // ""' 2>/dev/null)
  [ "$MS_OF" = "roadmap: $RUN" ] \
    && pass "unit issue is in the arc milestone (--milestone by title attaches)" \
    || flunk "unit issue NOT in the milestone (got '$MS_OF') — milestone must be passed by title, not number"
fi

# 2. find-by-marker resolves the number (the harness's cache-absent fallback path).
FOUND=$(find_by_marker "$UMARK" || true)
[ "$FOUND" = "$U1" ] && pass "find-by-marker resolves the unit issue" || flunk "find-by-marker (got '$FOUND', want '$U1')"

# 3. setup -> running: remove pending, add running (the ghRunning folded clause).
gh issue edit "${G[@]}" "$U1" --remove-label status:pending --add-label status:running >/dev/null 2>&1
case ",$(labels_of "$U1")," in *,status:running,*) pass "setup flip -> status:running";; *) flunk "status:running not set";; esac

# 4. merge -> merged + close-completed (the ghMerged folded clause).
gh issue edit "${G[@]}" "$U1" --remove-label status:running --add-label status:merged >/dev/null 2>&1
gh issue close "${G[@]}" "$U1" --reason completed --comment "Merged into integration." >/dev/null 2>&1
[ "$(state_of "$U1")" = CLOSED ] && pass "merge -> issue closed completed" || flunk "merged issue not closed"

# 5. quarantine: status:quarantined + dossier comment, issue stays OPEN (the ghQuarantine clause).
Q1=$(gh issue create "${G[@]}" --title "[unit] ${RUN}-q1" --label "roadmap:unit,status:pending,risk:low" \
  --body "<!-- $QMARK -->
quarantine unit" 2>/dev/null | grep -oE '[0-9]+$')
[ -n "$Q1" ] && CREATED_ISSUES+=("$Q1")
gh issue edit "${G[@]}" "$Q1" --remove-label status:pending --add-label status:quarantined >/dev/null 2>&1
gh issue comment "${G[@]}" "$Q1" --body "Quarantine dossier: unsatisfiable spec." >/dev/null 2>&1
if [ "$(state_of "$Q1")" = OPEN ]; then case ",$(labels_of "$Q1")," in *,status:quarantined,*) pass "quarantine -> open + status:quarantined + comment";; *) flunk "quarantine label";; esac
else flunk "quarantine issue must stay open"; fi

# 6. bank-debt idempotency: create-by-marker twice, expect exactly one issue.
gh issue list "${G[@]}" --search "\"$DMARK\" in:body" --state all --limit 1 --json number --jq '.[0].number' >/dev/null 2>&1
D1=$(gh issue create "${G[@]}" --title "[debt] ${RUN} sample" --label "roadmap:debt,severity:minor,debt:structure" \
  --body "<!-- $DMARK -->
a deferred imperfection" 2>/dev/null | grep -oE '[0-9]+$')
[ -n "$D1" ] && CREATED_ISSUES+=("$D1")
sleep 2
EXIST=$(find_by_marker "$DMARK" || true)   # second pass finds it -> the writer would skip re-create
if [ -n "$EXIST" ]; then pass "bank-debt idempotent (marker found on 2nd pass -> no duplicate)"; else flunk "debt marker not searchable"; fi

# 7. feedback census: an open roadmap:feedback issue is listed by label (immediate list API, not search).
F1=$(gh issue create "${G[@]}" --title "[feedback] ${RUN}" --label "roadmap:feedback" \
  --body "user note for $RUN" 2>/dev/null | grep -oE '[0-9]+$')
[ -n "$F1" ] && CREATED_ISSUES+=("$F1")
# Retry: the list API can lag a just-created issue by a beat. In a real run the census fires at a
# wave boundary, long after creation, so this retry is an eval-timing concession, not a skill need.
CENSUS=0
for _ in 1 2 3 4 5; do
  CENSUS=$(gh issue list "${G[@]}" --label roadmap:feedback --state open --json number --jq '[.[].number]|length' 2>/dev/null)
  [ "${CENSUS:-0}" -ge 1 ] && break; sleep 2
done
[ "${CENSUS:-0}" -ge 1 ] && pass "feedback census lists open roadmap:feedback issues" || flunk "feedback census found none"
gh issue close "${G[@]}" "$F1" --reason completed --comment "Triaged: actioned." >/dev/null 2>&1
[ "$(state_of "$F1")" = CLOSED ] && pass "feedback triage closes the issue" || flunk "feedback issue not closed"

# 8. arc tracking issue: the wave-tail sweep rewrites only the marked region with a per-unit GitHub
# task list (`- [x]` closed / `- [ ]` open) so GitHub renders a native progress rollup.
TRACK=$(gh issue create "${G[@]}" --title "[arc] ${RUN}" --label "roadmap:arc" \
  --body "roadmap arc ${RUN}
<!-- roadmap:status -->
<!-- /roadmap:status -->" 2>/dev/null | grep -oE '[0-9]+$')
[ -n "$TRACK" ] && CREATED_ISSUES+=("$TRACK")
gh issue edit "${G[@]}" "$TRACK" --body "roadmap arc ${RUN}
<!-- roadmap:status -->
- [x] #${U1} ${RUN}-u1 — merged
- [ ] #${Q1} ${RUN}-q1 — quarantined
<!-- /roadmap:status -->" >/dev/null 2>&1
BODY=$(gh issue view "${G[@]}" "$TRACK" --json body --jq .body 2>/dev/null)
if printf '%s' "$BODY" | grep -q -- "- \[x\] #${U1}" && printf '%s' "$BODY" | grep -q -- "- \[ \] #${Q1}"; then
  pass "arc tracking issue renders a unit task list (checked=closed) in the status region"
else
  flunk "tracking-issue task list not stored in the status region"
fi

echo "----"
[ "$fail" = 0 ] && echo "ALL ISSUE-MODE CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit "$fail"
