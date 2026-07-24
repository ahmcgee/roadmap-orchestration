#!/usr/bin/env bash
# Tear down every issue artifact a paid issue-mode eval arc created. This repo tracks no real issues
# (the maintainer uses GitHub issues here only for integration testing), so teardown sweeps by kind
# label — catching not just the bootstrapped unit issues but everything the arc created mid-run
# (wave-N fix-unit issues, roadmap:debt banks, the arc tracking issue) — then deletes the eval
# milestone and the labels the bootstrap ensured. `gh issue delete` needs elevated scope; without it
# teardown falls back to closing (harmless, roadmap:*-labelled residue).
#   bash issue-teardown.sh <fixture-dir>
set -uo pipefail
DIR=${1:?usage: issue-teardown.sh <fixture-dir>}
MAN="$DIR/.issue-manifest.json"
[ -f "$MAN" ] || { echo "no manifest at $MAN"; exit 2; }
REPO=$(node -e "console.log(require('$MAN').repo)")
G=(--repo "$REPO")
RUN=$(node -e "console.log(require('$MAN').run)")
echo "teardown for $REPO (namespace $RUN)"

remove_issue() {
  gh issue delete "${G[@]}" "$1" --yes >/dev/null 2>&1 \
    || gh issue close "${G[@]}" "$1" --reason "not planned" >/dev/null 2>&1 || true
}

# Sweep every OPEN issue carrying a roadmap kind label (unit/debt/feedback/arc). Merged units are
# already closed and drop out of --state open, so this catches quarantines, the tracking issue, banked
# debt, and any mid-run fix-unit issue the manifest could not know about ahead of time.
n=0
for lbl in roadmap:unit roadmap:debt roadmap:feedback roadmap:arc; do
  for num in $(gh issue list "${G[@]}" --label "$lbl" --state open --json number --jq '.[].number' 2>/dev/null); do
    remove_issue "$num"; n=$((n+1))
  done
done
# Also remove any manifest issues that are CLOSED (merged units) so no marker residue lingers.
for num in $(node -e "const m=require('$MAN');for(const v of Object.values(m.unitIssues||{}))console.log(v);const t=m.trackingIssue;if(t)console.log(t)"); do
  remove_issue "$num"; n=$((n+1))
done
echo "issues removed/closed: ~$n"

MS=$(node -e "console.log(require('$MAN').milestone||'')")
[ -n "$MS" ] && { gh api -X DELETE "repos/$REPO/milestones/$MS" >/dev/null 2>&1 && echo "milestone #$MS deleted" || echo "milestone #$MS: delete skipped"; }

node -e "for(const l of (require('$MAN').labels||[]))console.log(l)" | while read -r l; do
  gh label delete "${G[@]}" "$l" --yes >/dev/null 2>&1 || true
done
echo "labels deleted"
echo "teardown done"
