#!/usr/bin/env bash
set -euo pipefail

if test "${RUN_CODEX_SCOPE_EVAL:-0}" != 1; then
  echo 'SKIP: set RUN_CODEX_SCOPE_EVAL=1 to spend the active ChatGPT-managed Codex allowance'
  exit 0
fi
ROOT=${1:-$(mktemp -d)}
HERE=$(cd "$(dirname "$0")" && pwd)
CODEX="$HERE/../../../runtime/codex"
bash "$HERE/setup-scope-fixture.sh" "$ROOT" >/dev/null
echo 'CHARGED SMOKE: this launches real Codex threads against the active ChatGPT-managed allowance.'
echo 'SANDBOX EXCEPTION: this disposable fixture uses danger-full-access because nested bwrap is unavailable here.'
node "$CODEX/bin/roadmap-codex.mjs" doctor --repo "$ROOT/repo" --require-chatgpt-auth
node "$CODEX/bin/roadmap-codex.mjs" run --repo "$ROOT/repo" --profile economy --require-chatgpt-auth \
  --sandbox danger-full-access --dashboard-host 0.0.0.0 --dashboard-port "${CODEX_DASHBOARD_PORT:-8787}"
bash "$HERE/check-scope-fixture.sh" "$ROOT"
