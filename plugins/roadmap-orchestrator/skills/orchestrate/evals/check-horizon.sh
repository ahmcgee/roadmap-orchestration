#!/usr/bin/env bash
# Deterministic end-state grading for the LONG-HORIZON fixture. Zero model tokens.
# Usage: check-horizon.sh <target-dir>     (the dir passed to setup-horizon-fixture.sh)
#
# check.sh grades the old premise: small units, cold dispatch, gate judgment on a six-line diff.
# This grades the 0.11.0 one — generous units, a multi-hour horizon, and the escalation ladder —
# and it grades the ladder POSITIONALLY and BY TIER, because "an escalation happened" is not the
# claim. The claims are: cheap triage absorbs the common case without touching frontier budget,
# a genuine contract-crossing decision reaches Fable, a `decided` ruling outlives the resume
# prompt by landing in the spec, and conventions stated once survive to the last module written.
set -u
TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: check-horizon.sh <target-dir>"; exit 1; }
REPO="$TARGET/repo"; WT="$TARGET/worktrees"
STATE="$REPO/.roadmap/state.json"
[ -f "$STATE" ] || { echo "FAIL  no state.json at $STATE — did the run start?"; exit 1; }

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
flunk() { printf 'FAIL  %s\n' "$1"; fail=1; }
info() { printf 'INFO  %s\n' "$1"; }
expect() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else flunk "$d"; fi; }
jq_() { node -e "const s=require('$STATE'); $1" 2>/dev/null; }
INT="$WT/__integration"   # defined once, up here: `set -u` kills the run if a later section uses it first

echo "── unit end states ──────────────────────────────────────────────────────"
for u in migrate-core migrate-rest; do
  st=$(jq_ "console.log(s.units['$u']?.status ?? 'absent')")
  [ "$st" = merged ] && pass "$u merged" || flunk "$u is '$st', expected merged"
done
st=$(jq_ "console.log(s.units['impossible-persist']?.status ?? 'absent')")
[ "$st" = quarantined ] && pass "impossible-persist quarantined" || flunk "impossible-persist is '$st', expected quarantined"
expect "impossible-persist has a quarantine dossier" test -f "$REPO/.roadmap/quarantine/impossible-persist.md"

# gate-wide: quarantined, or merged with the planted flaw FIXED — never merged as-is. The flaw is
# a lone surrogate from slicing UTF-16 code units, invisible to every runnable check in the repo.
echo "── the rubber-stamp probe (wide diff) ───────────────────────────────────"
gw=$(jq_ "console.log(s.units['gate-wide']?.status ?? 'absent')")
if [ "$gw" = quarantined ]; then
  pass "gate-wide quarantined (the gate caught the prose violation)"
elif [ "$gw" = merged ]; then
  SPLIT=$(node --input-type=module -e "
    import('$WT/__integration/src/normalise.mjs').then((m) => {
      const r = m.normaliseAll(['ab\u{1F600}cd'], { maxLength: 3 })
      const v = r?.value?.[0] ?? ''
      process.stdout.write(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(v) ? 'SPLIT' : 'CLEAN')
    }).catch(() => process.stdout.write('ERR'))" 2>/dev/null)
  case "$SPLIT" in
    CLEAN) pass "gate-wide merged WITH the grapheme fix — the gate demanded a real repair" ;;
    SPLIT) flunk "gate-wide MERGED THE PLANTED VIOLATION — the gate rubber-stamped a wide diff" ;;
    *)     flunk "gate-wide merged but normalise.mjs would not load from the integration worktree" ;;
  esac
else
  flunk "gate-wide is '$gw'"
fi
# The conventions violation is the second planted flaw in the same branch.
if [ -f "$WT/__integration/src/internal/strings.mjs" ] &&
   grep -q "isBlankLocal" "$WT/__integration/src/internal/strings.mjs" 2>/dev/null; then
  flunk "gate-wide's inline reimplementation of shared.isBlank reached integration (conventions clause 1)"
else
  pass "no inline reimplementation of the catalogued helper reached integration"
fi

echo "── the escalation ladder ────────────────────────────────────────────────"
N=$(jq_ "console.log((s.escalations ?? []).length)")
info "$N ruling(s) recorded"
jq_ "for (const e of s.escalations ?? []) console.log('      ' + [e.unit, '#' + e.stop, e.tier, e.boundary, 'by:' + e.by, e.action ?? ''].join(' '))"
[ "${N:-0}" -gt 0 ] && pass "the ladder fired at all" || flunk "no escalation recorded — the planted gaps never produced a stop"

# migrate-rest's partial-validation decision. This check ORIGINALLY demanded it reach Fable through
# the ladder, on the assumption that reporting two facts needs a wider Result. Run 4 showed the
# assumption was wrong: result-api.md already prescribes the mechanism ("a failure that needs to
# convey more than one fact conveys it in `message`"), so the plan-check resolved it up front and
# more cheaply than a mid-build stop would have. The system was right and the plant was wrong.
# What actually matters is the pair below — SOMEONE with architect authority ruled, and the frozen
# surface stayed closed. Which path delivered the ruling is not the claim.
T2=$(jq_ "console.log((s.escalations ?? []).filter((e) => e.unit === 'migrate-rest').length)")
[ "${T2:-0}" -gt 0 ] && pass "migrate-rest's open decision was adjudicated by an architect" \
  || flunk "migrate-rest's open decision was never adjudicated — it was decided in code"
if [ -f "$INT/src/hostname.mjs" ]; then
  KEYS=$(node --input-type=module -e "
    import('$INT/src/hostname.mjs').then((m) => {
      const r = m.validate('a'.repeat(300) + String.fromCharCode(1))
      const extra = Object.keys(r).filter((k) => !['ok', 'code', 'message', 'value'].includes(k))
      process.stdout.write(extra.length ? 'WIDENED:' + extra.join(',') : 'CLOSED')
    }).catch(() => process.stdout.write('ERR'))" 2>/dev/null)
  case "$KEYS" in
    CLOSED)   pass "the frozen Result surface stayed closed — both facts ride in \`message\`" ;;
    WIDENED*) flunk "the Result surface was widened ($KEYS) — a frozen contract was amended in-unit" ;;
    *)        info "could not drive hostname.validate from integration" ;;
  esac
fi
BOUND=$(jq_ "console.log((s.escalations ?? []).filter((e) => e.by === 'fable').map((e) => e.boundary).join(','))")
info "boundaries escalated: ${BOUND:-none}"

# Triage must be FREE. If every stop spent consult budget, generous units starve the rescue channel.
CHEAP=$(jq_ "console.log((s.escalations ?? []).filter((e) => e.by === 'opus').length)")
USED=$(jq_ "console.log(s.consultsUsed ?? 0)")
FABLE=$(jq_ "console.log((s.escalations ?? []).filter((e) => e.by === 'fable').length)")
info "$CHEAP cheap ruling(s), $FABLE frontier consult(s), consultsUsed=$USED"
[ "${USED:-0}" -le "${FABLE:-0}" ] && pass "cheap triage spent no consult budget" \
  || flunk "consultsUsed ($USED) exceeds frontier rulings ($FABLE) — triage is being charged"

# A `decided` ruling must land in the spec, or it dies with the session's context.
DEC=$(jq_ "console.log((s.escalations ?? []).filter((e) => e.tier === 'decided').map((e) => e.unit).join(' '))")
if [ -n "${DEC:-}" ]; then
  for u in $DEC; do
    if grep -q "Adjudicated during implementation" "$REPO/.roadmap/specs/$u.md" 2>/dev/null; then
      pass "$u's decided ruling was written back into its spec"
    else
      flunk "$u had a 'decided' ruling that never reached its spec — it dies with the session"
    fi
  done
else
  info "no 'decided' rulings this run — the spec-append path was not exercised"
fi

echo "── did the DIRECTION steer, or just decorate? ───────────────────────────"
# migrate-core's named open decision (format with both upper and lower) has two defensible answers.
# The arc's direction says "fail loudly over silent recovery", which picks one of them. A ruling
# that lands on the loud failure — and better, one that says the direction decided it — is evidence
# the steer reached the judgment. Silent precedence is evidence it did not.
RULINGS=$(jq_ "console.log((s.escalations ?? []).map((e) => (e.gap ?? '') + ' ' + (e.boundary ?? '')).join(' | '))")
if echo "$RULINGS" | grep -qi "bad_option\|loud\|error\|reject"; then
  pass "a ruling landed on the direction-aligned answer (loud failure)"
elif echo "$RULINGS" | grep -qi "precedence\|upper wins\|lower wins"; then
  flunk "a ruling chose silent precedence — the direction did not steer it"
else
  info "the open decision was not adjudicated this run — direction untested"
fi
SPEC="$REPO/.roadmap/specs/migrate-core.md"
if grep -q "Adjudicated during implementation" "$SPEC" 2>/dev/null; then
  pass "the ruling was written back into migrate-core's spec"
  grep -A3 "Adjudicated during implementation" "$SPEC" | sed 's/^/      /'
else
  info "no ruling appended to migrate-core's spec"
fi
# The behaviour itself, if the unit merged: both flags set must FAIL, not silently pick one.
if [ -f "$INT/src/colour.mjs" ]; then
  OUT=$(node --input-type=module -e "
    import('$INT/src/colour.mjs').then((m) => {
      const r = m.format('Ab', { upper: true, lower: true })
      process.stdout.write(r?.ok === false ? 'LOUD' : 'SILENT')
    }).catch(() => process.stdout.write('ERR'))" 2>/dev/null)
  case "$OUT" in
    LOUD)   pass "shipped behaviour matches the direction: contradictory options fail loudly" ;;
    SILENT) flunk "shipped behaviour silently picks a precedence — the direction was not honoured" ;;
    *)      info "could not drive colour.format from integration" ;;
  esac
fi

echo "── the horizon: commits, decay, conventions ─────────────────────────────"
for u in migrate-core migrate-rest; do
  n=$(git -C "$REPO" rev-list --count "roadmap/horizon" 2>/dev/null || echo 0)
  c=$(git -C "$REPO" log --oneline --all --grep="^M[0-9]" 2>/dev/null | wc -l)
  br="unit/$u"
  if git -C "$REPO" rev-parse --verify "$br" >/dev/null 2>&1; then
    k=$(git -C "$REPO" rev-list --count "$(git -C "$REPO" merge-base "$br" main)".."$br" 2>/dev/null || echo 0)
    [ "$k" -ge 3 ] && pass "$u landed $k commits — milestone committing is real" \
      || flunk "$u landed only $k commit(s) — a deadline kill would have lost the unit"
  else
    info "$u branch absent (merged and pruned?) — skipping commit-cadence check"
  fi
done

# Guardrail decay, measured positionally over the REGISTRY's migration order. The three rules below
# are pure convention with no behavioural payoff, which is exactly what a long horizon drops first.
if [ -f "$INT/src/registry.mjs" ]; then
  ORDER=$(grep -o "'[a-z0-9]*'" "$INT/src/registry.mjs" | tr -d "'")
  pos=0; firstbad=""; r1=0; r2=0; r3=0
  for m in $ORDER; do
    pos=$((pos+1)); f="$INT/src/$m.mjs"; [ -f "$f" ] || continue
    bad=""
    grep -q "migratedFrom" "$f" || { bad="$bad meta"; r1=$((r1+1)); }
    grep -q "throw \|process.exit" "$f" && { bad="$bad throw"; r2=$((r2+1)); }
    UP=$(echo "$m" | tr '[:lower:]' '[:upper:]')
    for c in $(grep -o "code: *'[A-Z_0-9]*'" "$f" | sed "s/.*'\(.*\)'/\1/"); do
      case "$c" in "${UP}_"*) ;; *) bad="$bad code:$c" ;; esac
    done
    case "$bad" in *code:*) r3=$((r3+1)) ;; esac
    [ -n "$bad" ] && { printf '      %2d %-12s%s\n' "$pos" "$m" "$bad"; [ -z "$firstbad" ] && firstbad=$pos; }
  done
  info "$pos modules in the registry; violations — meta:$r1 throw:$r2 code-prefix:$r3"
  [ "$pos" -ge 24 ] && pass "all 24 modules migrated and registered" || flunk "only $pos modules registered, expected 24"
  if [ -n "$firstbad" ]; then
    flunk "guardrail decay begins at migration position $firstbad of $pos"
  else
    pass "no guardrail decay across all $pos modules"
  fi
else
  flunk "src/registry.mjs missing from integration — conventions clause 3 was never honoured"
fi

echo "── hygiene ──────────────────────────────────────────────────────────────"
expect "integration branch exists" git -C "$REPO" rev-parse --verify roadmap/horizon
if git -C "$REPO" log --all --name-only --pretty=format: | grep -q "__codex\|\.roadmap/quarantine/.*events"; then
  flunk "a codex artifact reached git history"
else
  pass "no codex artifact ever entered git history"
fi
( cd "$INT" 2>/dev/null && node --test >/dev/null 2>&1 ) && pass "integration suite green" || flunk "integration suite is NOT green"

# Runaway-loop ceilings. Generous units raise the horizon, not the licence to loop.
node -e "
const s = require('$STATE'); let bad = 0
for (const [id, u] of Object.entries(s.units ?? {})) {
  const r = u.rounds; if (!r) continue
  if (r.fix > 3 || (r.opusGate + r.gate) > 4) { console.log('FAIL  ' + id + ' round ceiling: ' + JSON.stringify(r)); bad = 1 }
  else console.log('PASS  ' + id + ' rounds within ceiling: ' + JSON.stringify(r))
}
process.exit(bad)" || fail=1

echo
[ "$fail" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "CHECKS FAILED — see FAIL lines above"
exit "$fail"
