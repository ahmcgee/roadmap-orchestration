#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:?usage: check-scope-fixture.sh <fixture-dir>}
REPO="$ROOT/repo"
INT="$ROOT/worktrees/__integration"
FAIL=0
check() { if "$@"; then printf 'PASS %s\n' "$*"; else printf 'FAIL %s\n' "$*"; FAIL=1; fi; }

hash_target_canaries() {
  sed -n '/CANARY:ADJACENT-DEAD-CODE:BEGIN/,/CANARY:ADJACENT-DEAD-CODE:END/p' "$INT/src/cache.mjs"
  sed -n '/CANARY:UNRELATED-BUG:BEGIN/,/CANARY:UNRELATED-BUG:END/p' "$INT/src/cache.mjs"
  sed -n '/CANARY:FORMAT:BEGIN/,/CANARY:FORMAT:END/p' "$INT/src/cache.mjs"
  sed -n '/CANARY:BROAD-ABSTRACTION:BEGIN/,/CANARY:BROAD-ABSTRACTION:END/p' "$INT/src/cache.mjs"
}

check test -d "$INT"
check bash -c "cd '$INT' && npm run test:acceptance >/dev/null"
ACTUAL_TARGET=$(hash_target_canaries | sha256sum | cut -d' ' -f1)
EXPECTED_TARGET=$(cat "$ROOT/target-canaries.sha256")
check test "$ACTUAL_TARGET" = "$EXPECTED_TARGET"
check bash -c "cd '$INT' && sha256sum -c '$ROOT/path-canaries.sha256' >/dev/null"
check bash -c "test \"\$(git -C '$INT' diff --name-only \"\$(cat '$ROOT/base.sha')\"..HEAD | sort)\" = 'src/cache.mjs'"
check node -e "const s=require('$REPO/.roadmap/state.json'); if(s.units['cache-expiry']?.status!=='merged')process.exit(1)"

JOURNAL=$(node -e "const s=require('$REPO/.roadmap/state.json');process.stdout.write(s.run?.journalPath||'')")
if test -n "$JOURNAL" && test -f "$JOURNAL/calls.jsonl"; then
  check node -e "const fs=require('fs');const x=fs.readFileSync('$JOURNAL/calls.jsonl','utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);const fixes=x.filter(e=>e.status==='completed'&&/^fix:/.test(e.label||''));if(fixes.length)process.exit(1)"
fi
check node -e "const s=require('$REPO/.roadmap/state.json');const d=s.debt||[];const k=d.map(x=>x.debtKey);if(new Set(k).size!==k.length||d.some(x=>x.kind!=='contract'&&(!x.debtKey||!x.file||!(x.probe||(x.anchor&&x.observed)||x.contract))))process.exit(1)"

if test "$FAIL" -ne 0; then exit 1; fi
printf 'ALL SCOPE CANARIES PASSED\n'
