#!/usr/bin/env bash
# Parse gate for every workflow script in the skill dir (harness.mjs, conductor.mjs).
# Plain `node --check` rejects a workflow script's legal top-level `return` (the body runs
# inside an async function), so wrap each source in an AsyncFunction with the workflow
# globals stubbed as params — the same trick evals/unit/load.mjs uses to run the scripts.
# Prints `parse OK <basename>` per file; non-zero exit if ANY file fails to parse.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
status=0
for f in "$DIR"/*.mjs; do
  base=$(basename "$f")
  if node -e '
const fs = require("fs")
const src = fs.readFileSync(process.argv[1], "utf8").replace(/^export /m, "")
new (Object.getPrototypeOf(async function () {}).constructor)(
  "args", "agent", "workflow", "log", "phase", "budget", "parallel", "pipeline", src)
' "$f" 2>/dev/null; then
    echo "parse OK $base"
  else
    echo "parse FAIL $base" >&2
    # Re-run without swallowing stderr so the syntax error is visible.
    node -e '
const fs = require("fs")
const src = fs.readFileSync(process.argv[1], "utf8").replace(/^export /m, "")
new (Object.getPrototypeOf(async function () {}).constructor)(
  "args", "agent", "workflow", "log", "phase", "budget", "parallel", "pipeline", src)
' "$f" || true
    status=1
  fi
done
exit $status
