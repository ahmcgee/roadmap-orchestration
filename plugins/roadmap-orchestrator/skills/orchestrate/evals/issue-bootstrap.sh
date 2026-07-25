#!/usr/bin/env bash
# Bootstrap a built eval fixture into ISSUE MODE against a real GitHub repo — the one-time Phase-0
# work the canned fixtures otherwise skip. Creates the labels, an arc milestone, the arc tracking
# issue (with a `<!-- roadmap:status -->` region), and one `roadmap:unit` issue per in-scope unit
# (body marker + risk label + milestone), then patches plan.json with `tracking`/`repoSlug`/
# `milestone`/`trackingIssue` and each unit's cached issue number. Writes `.issue-manifest.json` for
# check-arc-issues.sh and issue-teardown.sh. Print the patched plan+state paths so the caller can pass
# them to Workflow.
#
# This is how we run a paid eval arc against real GitHub issues (the primary mode of work), under
# representative multi-wave strain, to prove the projection stays inside GitHub's rate limits.
#   RUN_ISSUE_EVAL=1 bash issue-bootstrap.sh <fixture-dir> [owner/repo]
set -uo pipefail
[ "${RUN_ISSUE_EVAL:-}" = 1 ] || { echo "refusing without RUN_ISSUE_EVAL=1 (creates issues on the target repo)"; exit 2; }
DIR=${1:?usage: issue-bootstrap.sh <fixture-dir> [owner/repo]}
PLAN="$DIR/repo/.roadmap/plan.json"
[ -f "$PLAN" ] || { echo "no plan.json at $PLAN"; exit 2; }
command -v gh >/dev/null || { echo "gh not found"; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated"; exit 2; }
REPO=${2:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)}
[ -n "${REPO:-}" ] || { echo "cannot resolve repo (pass owner/repo)"; exit 2; }
G=(--repo "$REPO")
RUN="arc-$$-$(cd "$DIR/repo" && git rev-parse --short HEAD 2>/dev/null || echo x)"
echo "issue-mode bootstrap for $DIR against $REPO (namespace $RUN)"

LABELS=(roadmap:unit roadmap:debt roadmap:bug roadmap:arc \
  status:pending status:running status:merge-ready status:merged status:blocked status:quarantined status:deferred \
  risk:low risk:med risk:high severity:minor severity:major \
  debt:correctness debt:test debt:structure debt:ergonomics)
for l in "${LABELS[@]}"; do gh label create "${G[@]}" "$l" --color ededed --force >/dev/null 2>&1 || true; done
echo "labels ensured"

MS=$(gh api "repos/$REPO/milestones" -f "title=roadmap: $RUN" --jq .number 2>/dev/null || echo "")
[ -n "$MS" ] && echo "milestone #$MS" || echo "milestone: (none — continuing)"

# The arc tracking issue is the human dashboard (reference.md, SKILL.md): plan summary + DAG + the
# `<!-- roadmap:status -->` region the wave-tail sweep fills with a unit task list + a session-report
# placeholder. Author all of it here so the eval's arc issue mirrors a real one (a bare status region
# would be as unrepresentative as a title-only unit issue).
ARC_BODY=$(PLAN="$PLAN" RUN="$RUN" node -e '
const p=require(process.env.PLAN);
const units=p.units.filter(u=>u.inScope!==false);
const summary=units.map(u=>`- \`${u.id}\` (risk:${u.risk||"med"}) — ${u.title||u.id}`).join("\n");
const edges=p.edges||[];
const dag=edges.length
  ? edges.map(e=>`- \`${e.from}\` → \`${e.to}\`${e.contract?` (contract \`${e.contract}\`)`:""}`).join("\n")
  : "_no cross-unit dependencies_";
process.stdout.write(
`Roadmap arc **${process.env.RUN}** — the human dashboard for this build. Unit issues below track as they move; this issue closes at session end.

## Plan (${units.length} units)
${summary}

## Dependencies (DAG)
${dag}

## Status
<!-- roadmap:status -->
_populated by the wave-tail sweep_
<!-- /roadmap:status -->

## Session report
_pending — written at session end_
`);')
TRACK=$(gh issue create "${G[@]}" --title "[arc] roadmap $RUN" --label roadmap:arc \
  ${MS:+--milestone "roadmap: $RUN"} --body "$ARC_BODY" 2>/dev/null | grep -oE '[0-9]+$')
[ -n "$TRACK" ] && echo "tracking issue #$TRACK (plan summary + DAG + status region)" || echo "tracking issue: (create failed — continuing)"

# One unit issue per in-scope unit; capture id -> number into an associative array. The body is the
# marker + the unit's FULL spec (from .roadmap/specs/<id>.md), mirroring real Phase 0 — the unit issue
# is where the spec is authored (SKILL.md, reference.md). Falling back to the one-line title would make
# the eval's issues unrepresentatively sparse, so prefer the committed spec whenever it exists.
declare -A ISS
while IFS='|' read -r id risk title; do
  [ -z "$id" ] && continue
  SPEC="$DIR/repo/.roadmap/specs/$id.md"
  if [ -f "$SPEC" ]; then
    BODY=$(printf '<!-- roadmap:unit id=%s -->\n\n%s\n' "$id" "$(cat "$SPEC")")
  else
    BODY=$(printf '<!-- roadmap:unit id=%s -->\n%s\n' "$id" "$title")
  fi
  n=$(gh issue create "${G[@]}" --title "[unit] $id" \
    --label "roadmap:unit,status:pending,risk:$risk" ${MS:+--milestone "roadmap: $RUN"} \
    --body "$BODY" 2>/dev/null | grep -oE '[0-9]+$')
  [ -n "$n" ] && { ISS[$id]=$n; echo "  unit $id (risk:$risk) -> #$n$([ -f "$SPEC" ] && echo ' [spec body]' || echo ' [title only]')"; } \
    || echo "  unit $id -> CREATE FAILED"
done < <(node -e "const p=require('$PLAN');for(const u of p.units.filter(u=>u.inScope!==false))console.log([u.id,(u.risk||'med'),(u.title||u.id).replace(/[|\n]/g,' ')].join('|'))")

# Build the id->number JSON and patch plan.json in place.
ISS_JSON="{"; first=1
for id in "${!ISS[@]}"; do [ $first = 0 ] && ISS_JSON+=","; ISS_JSON+="\"$id\":${ISS[$id]}"; first=0; done
ISS_JSON+="}"
MS_TITLE="roadmap: $RUN"; export ISS_JSON MS MS_TITLE TRACK REPO
node -e "
const fs=require('fs'); const p=require('$PLAN');
p.tracking='issues'; p.repoSlug=process.env.REPO;
// reference.md:71 — plan.milestone is the milestone TITLE (gh --milestone takes a name), NOT the
// number. Storing the number orphans every mid-run issue-new/bank-debt issue from the milestone.
if(process.env.MS) p.milestone=process.env.MS_TITLE;
if(process.env.TRACK) p.trackingIssue=Number(process.env.TRACK);
const iss=JSON.parse(process.env.ISS_JSON);
for(const u of p.units){ if(iss[u.id]!=null) u.issue=iss[u.id]; }
fs.writeFileSync('$PLAN', JSON.stringify(p,null,2)+'\n');
console.log('plan.json patched -> issue mode ('+Object.keys(iss).length+' unit issues cached)');
"

# CRITICAL: commit the patched plan.json. The fixtures commit plan.json on `main` but set
# integrationTip to an EARLIER base commit that predates it, so the preview mirror's
# `git checkout --detach <base>` cleanly REMOVES a committed-and-clean plan.json. Left modified and
# uncommitted, that same checkout aborts ("local changes would be overwritten"), the mirror never
# goes live, and every preview/mirror check fails. Committing restores the clean-working-tree invariant.
if (cd "$DIR/repo" && git add .roadmap/plan.json && git commit -q -m "eval: issue-mode bootstrap ($RUN)" >/dev/null 2>&1); then
  echo "committed patched plan.json (keeps the working tree clean for the mirror's detach)"
else
  echo "WARN: could not commit plan.json — the preview mirror will likely abort on a dirty checkout"
fi

# Manifest for the checker + teardown.
LABELS_CSV=$(IFS=,; echo "${LABELS[*]}"); export LABELS_CSV
node -e "
const fs=require('fs');
fs.writeFileSync('$DIR/.issue-manifest.json', JSON.stringify({
  repo: process.env.REPO, run: '$RUN',
  milestone: process.env.MS ? Number(process.env.MS) : null,
  trackingIssue: process.env.TRACK ? Number(process.env.TRACK) : null,
  unitIssues: JSON.parse(process.env.ISS_JSON),
  labels: process.env.LABELS_CSV.split(',')
}, null, 2)+'\n');
console.log('manifest -> $DIR/.issue-manifest.json');
"
echo "bootstrap done. plan: $PLAN  state: $DIR/repo/.roadmap/state.json"
