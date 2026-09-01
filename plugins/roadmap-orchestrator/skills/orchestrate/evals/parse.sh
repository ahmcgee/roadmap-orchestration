#!/usr/bin/env bash
# Parse gate for every .mjs in the skill dir, in the two flavours it holds.
# WORKFLOW scripts (harness.mjs, conductor.mjs) run inside an async function, so plain
# `node --check` rejects their legal top-level `return`: each source is wrapped in an
# AsyncFunction with the workflow globals stubbed as params — the same trick
# script-loader.mjs uses to run them. Everything else is an ordinary ES module
# (script-loader.mjs, persist.mjs) and is checked with `node --check`.
# Prints `parse OK <basename>` per file; non-zero exit if ANY file fails to parse.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
status=0
for f in "$DIR"/script-loader.mjs "$DIR"/persist.mjs; do
  base=$(basename "$f")
  [ -f "$f" ] || continue
  if node --check "$f" 2>/dev/null; then
    echo "parse OK $base"
  else
    echo "parse FAIL $base" >&2
    node --check "$f" || true
    status=1
  fi
done
for f in "$DIR"/harness.mjs "$DIR"/conductor.mjs; do
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
