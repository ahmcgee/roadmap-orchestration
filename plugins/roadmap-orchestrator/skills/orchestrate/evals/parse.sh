#!/usr/bin/env bash
# Parse gate for harness.mjs. Plain `node --check` rejects the harness's legal
# top-level `return` (workflow scripts run in an async function body), so wrap
# the source in an AsyncFunction with the workflow globals stubbed as params.
set -euo pipefail
HARNESS="$(dirname "$0")/../harness.mjs"
node -e '
const fs = require("fs")
const src = fs.readFileSync(process.argv[1], "utf8").replace(/^export /m, "")
new (Object.getPrototypeOf(async function () {}).constructor)("args", "agent", "log", "phase", src)
console.log("parse OK")
' "$HARNESS"
