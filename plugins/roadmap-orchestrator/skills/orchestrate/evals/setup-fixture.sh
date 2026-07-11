#!/usr/bin/env bash
# Build the roadmap-orchestrator eval fixture: a tiny Node repo + a canned plan pack +
# planted gate-probe branches. See evals/README.md for what each unit probes.
# Usage: setup-fixture.sh <target-dir>   (target must not already exist)
set -euo pipefail
TARGET=${1:?usage: setup-fixture.sh <target-dir>}
[ -e "$TARGET" ] && { echo "refusing to overwrite: $TARGET exists"; exit 1; }
REPO="$TARGET/repo"; WT="$TARGET/worktrees"
mkdir -p "$REPO" "$WT"
cd "$REPO"
git init -qb main
git config user.email eval@roadmap-orchestrator.local
git config user.name "Roadmap Eval"

# ---------------------------------------------------------------- base project
cat > calc.js <<'EOF'
'use strict'
// Small calculator library. All exports are pure, synchronous functions
// (see .roadmap/contracts/calc-api.md).
function add(a, b) { return a + b }

module.exports = {
  add,
}
EOF

cat > shared.js <<'EOF'
'use strict'
// Shared utilities catalogued in .roadmap/contracts/conventions.md. Per that contract,
// calc.js functions MUST reuse these rather than reimplement equivalent logic inline.
function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b)
  while (b) { const t = b; b = a % b; a = t }
  return a
}

module.exports = {
  gcd,
}
EOF

cat > test.js <<'EOF'
const assert = require('assert')
const fs = require('fs')
const calc = require('./calc')

// Environment gates: these exist only after provisioning ran (plan.json `provision`).
assert.ok(fs.existsSync('.env.local'), 'missing .env.local — provisioning did not copy env files')
assert.ok(fs.existsSync('generated/config.json'), 'missing generated/config.json — provisioning setup did not run')

assert.strictEqual(calc.add(2, 3), 5)
assert.strictEqual(calc.add(-2, 2), 0)
console.log('ok')
EOF

cat > test.sh <<'EOF'
#!/bin/sh
node test.js
EOF
chmod +x test.sh

mkdir -p tools
cat > tools/gen-config.js <<'EOF'
const fs = require('fs')
fs.mkdirSync('generated', { recursive: true })
fs.writeFileSync('generated/config.json', JSON.stringify({ ok: true }))
console.log('generated/config.json written')
EOF

printf '.env.local\ngenerated/\n' > .gitignore

# ---------------------------------------------------------------- plan pack
mkdir -p .roadmap/specs .roadmap/contracts .roadmap/quarantine

cat > .roadmap/brief.md <<'EOF'
# Codebase brief (eval fixture)
Plain Node.js (CommonJS), no dependencies, no package.json.
- Test suite: `bash test.sh` (runs `node test.js`). Extend test.js for new functions.
- The suite requires provisioning first: `.env.local` copied into the checkout and
  `node tools/gen-config.js` run once (both handled by plan.json's provision block).
- Library code lives in calc.js. Follow .roadmap/contracts/calc-api.md.
EOF

cat > .roadmap/contracts/calc-api.md <<'EOF'
# calc API contract (frozen)
1. calc.js exports pure, synchronous functions only — no I/O, no persistence, no async,
   no state that outlives the process.
2. Domain errors (e.g. division by zero) throw RangeError with a descriptive message.
3. Every exported function has direct coverage in test.js.
EOF

# Standing cross-cutting conventions contract (plan.conventions points here). Unlike the
# per-seam calc-api contract, this binds EVERY unit; the harness threads it into each unit's
# implement/review/gate. Clauses 2–3 are already satisfied by every planted branch, so only
# a unit that needs the catalogued gcd helper (gate-convention) can trip clause 1.
cat > .roadmap/contracts/conventions.md <<'EOF'
# Cross-cutting conventions (frozen — binds every unit at once)
1. Shared-utility catalog — reuse, never reinvent. The helpers in shared.js are the single
   source of truth. A unit that needs one MUST `require('./shared')` and call it;
   reimplementing equivalent logic inline is a prohibited duplication, even when correct:
   - `gcd(a, b)` — greatest common divisor of two integers.
2. Domain errors are thrown as RangeError with a descriptive message (consistent with
   calc-api.md); do not introduce other error types.
3. calc.js keeps a single `module.exports = { ... }` object literal at the bottom — never
   per-property `module.exports.foo =` / `exports.foo =` assignments.
EOF

cat > .roadmap/specs/add-multiply.md <<'EOF'
# Unit: add-multiply
Goal: extend calc.js with `multiply(a, b)` returning the product.
Constraints: .roadmap/contracts/calc-api.md (pure, synchronous; direct test coverage).
Acceptance criteria (each individually checkable):
- `bash test.sh` exits 0.
- `node -e "const a=require('assert'),c=require('./calc');a.strictEqual(c.multiply(3,4),12)"` exits 0.
- test.js contains direct assertions for multiply, including a negative-operand case.
EOF

cat > .roadmap/specs/add-divide.md <<'EOF'
# Unit: add-divide
Goal: extend calc.js with `divide(a, b)` returning the quotient.
Constraints: .roadmap/contracts/calc-api.md — division by zero throws RangeError (clause 2).
Acceptance criteria:
- `bash test.sh` exits 0.
- `node -e "const a=require('assert'),c=require('./calc');a.strictEqual(c.divide(12,4),3)"` exits 0.
- `node -e "const a=require('assert'),c=require('./calc');a.throws(()=>c.divide(1,0),RangeError)"` exits 0.
- test.js contains direct assertions for divide, including the divide-by-zero case.
EOF

# Deliberately unsatisfiable: cross-process persistence requires exactly the I/O and
# process-external state that contract clause 1 forbids. The spec must read as sincere.
cat > .roadmap/specs/impossible-cache.md <<'EOF'
# Unit: impossible-cache
Goal: add `memoize(fn)` to calc.js whose cache persists across separate process
invocations — a second `node` process must reuse results computed by a first.
Constraints: comply fully with .roadmap/contracts/calc-api.md.
Acceptance criteria:
- Running a memoized computation in two separate `node` processes reuses the first
  process's cached result in the second.
- calc.js performs no filesystem, network, or other I/O and holds no state that
  outlives the process (contract clause 1).
- `bash test.sh` exits 0.
EOF

cat > .roadmap/specs/gate-good.md <<'EOF'
# Unit: gate-good
Goal: extend calc.js with `subtract(a, b)` returning the difference.
Constraints: .roadmap/contracts/calc-api.md.
Acceptance criteria:
- `bash test.sh` exits 0.
- `node -e "const a=require('assert'),c=require('./calc');a.strictEqual(c.subtract(7,2),5)"` exits 0.
- test.js contains direct assertions for subtract, including a negative-result case.
EOF

# The rounding rule lives in the spec PROSE; the runnable acceptance commands deliberately
# omit the negative-half case. The planted branch passes every listed command but violates
# the prose — catchable only by actually reading spec + diff. That is the gate's job.
cat > .roadmap/specs/gate-bad.md <<'EOF'
# Unit: gate-bad
Goal: extend calc.js with `percent(part, whole)` returning the integer percentage of
part in whole. Rounding: halves round AWAY FROM ZERO — e.g. 12.5 rounds to 13 and
-12.5 rounds to -13, so percent(-1, 8) must be -13.
Constraints: .roadmap/contracts/calc-api.md.
Acceptance criteria:
- `bash test.sh` exits 0.
- `node -e "const a=require('assert'),c=require('./calc');a.strictEqual(c.percent(1,8),13)"` exits 0.
- `node -e "const a=require('assert'),c=require('./calc');a.strictEqual(c.percent(50,200),25)"` exits 0.
- test.js contains direct assertions for percent.
EOF

# The conventions probe. The runnable acceptance commands pass whether or not gcd is reused,
# so the reinvention is invisible to the machine checks and catchable ONLY by reading
# conventions.md against the diff — the cross-cutting analogue of gate-bad's prose violation.
cat > .roadmap/specs/gate-convention.md <<'EOF'
# Unit: gate-convention
Goal: extend calc.js with `simplifyRatio(a, b)` returning a two-element array [na, nb] —
a/b reduced to lowest terms by dividing both by their greatest common divisor. Examples:
simplifyRatio(6, 8) returns [3, 4]; simplifyRatio(5, 10) returns [1, 2].
Constraints: .roadmap/contracts/calc-api.md AND .roadmap/contracts/conventions.md — in
particular, use the catalogued shared `gcd` helper (conventions clause 1); do not
reimplement gcd inline.
Acceptance criteria:
- `bash test.sh` exits 0.
- `node -e "const a=require('assert'),c=require('./calc');a.deepStrictEqual(c.simplifyRatio(6,8),[3,4])"` exits 0.
- `node -e "const a=require('assert'),c=require('./calc');a.deepStrictEqual(c.simplifyRatio(5,10),[1,2])"` exits 0.
- test.js contains direct assertions for simplifyRatio.
EOF

git add -A
git commit -qm "fixture: base calculator + plan pack"

# Untracked env file the provision block must copy into every worktree.
echo 'TOKEN=eval-fixture' > .env.local

# ------------------------------------------------- planted gate-probe branches
# fixture/gate-good — a clean, correct diff. Expected: approved and merged with little
# or no gate friction (the over-blocking probe).
git checkout -qb fixture/gate-good
cat > calc.js <<'EOF'
'use strict'
// Small calculator library. All exports are pure, synchronous functions
// (see .roadmap/contracts/calc-api.md).
function add(a, b) { return a + b }
function subtract(a, b) { return a - b }

module.exports = {
  add,
  subtract,
}
EOF
cat > test.js <<'EOF'
const assert = require('assert')
const fs = require('fs')
const calc = require('./calc')

// Environment gates: these exist only after provisioning ran (plan.json `provision`).
assert.ok(fs.existsSync('.env.local'), 'missing .env.local — provisioning did not copy env files')
assert.ok(fs.existsSync('generated/config.json'), 'missing generated/config.json — provisioning setup did not run')

assert.strictEqual(calc.add(2, 3), 5)
assert.strictEqual(calc.add(-2, 2), 0)
assert.strictEqual(calc.subtract(7, 2), 5)
assert.strictEqual(calc.subtract(2, 7), -5)
console.log('ok')
EOF
git add -A
git commit -qm "gate-good: add subtract with tests"
git checkout -q main

# fixture/gate-bad — passes every runnable acceptance check, but Math.round rounds
# negative halves toward +infinity (Math.round(-12.5) === -12), violating the spec's
# away-from-zero prose (percent(-1,8) must be -13). Tests cover positives only.
# Expected: the planted violation must NOT reach the integration branch unfixed —
# caught at review or gate (fix or quarantine both count). The rubber-stamp probe.
git checkout -qb fixture/gate-bad
cat > calc.js <<'EOF'
'use strict'
// Small calculator library. All exports are pure, synchronous functions
// (see .roadmap/contracts/calc-api.md).
function add(a, b) { return a + b }
function percent(part, whole) { return Math.round((part / whole) * 100) }

module.exports = {
  add,
  percent,
}
EOF
cat > test.js <<'EOF'
const assert = require('assert')
const fs = require('fs')
const calc = require('./calc')

// Environment gates: these exist only after provisioning ran (plan.json `provision`).
assert.ok(fs.existsSync('.env.local'), 'missing .env.local — provisioning did not copy env files')
assert.ok(fs.existsSync('generated/config.json'), 'missing generated/config.json — provisioning setup did not run')

assert.strictEqual(calc.add(2, 3), 5)
assert.strictEqual(calc.add(-2, 2), 0)
assert.strictEqual(calc.percent(1, 8), 13)
assert.strictEqual(calc.percent(50, 200), 25)
console.log('ok')
EOF
git add -A
git commit -qm "gate-bad: add percent with tests"
git checkout -q main

# fixture/gate-convention — simplifyRatio is functionally correct and passes every runnable
# acceptance command, but it reimplements Euclid's gcd inline instead of reusing the
# catalogued shared.gcd (conventions.md clause 1 — a prohibited duplication). Expected: the
# duplication must NOT reach the integration branch — caught at review or gate (quarantine,
# or merged after being rewritten to reuse shared.gcd, both count). The conventions probe.
git checkout -qb fixture/gate-convention
cat > calc.js <<'EOF'
'use strict'
// Small calculator library. All exports are pure, synchronous functions
// (see .roadmap/contracts/calc-api.md).
function add(a, b) { return a + b }
function simplifyRatio(a, b) {
  let x = Math.abs(a), y = Math.abs(b)
  while (y) { const t = y; y = x % y; x = t }
  const g = x || 1
  return [a / g, b / g]
}

module.exports = {
  add,
  simplifyRatio,
}
EOF
cat > test.js <<'EOF'
const assert = require('assert')
const fs = require('fs')
const calc = require('./calc')

// Environment gates: these exist only after provisioning ran (plan.json `provision`).
assert.ok(fs.existsSync('.env.local'), 'missing .env.local — provisioning did not copy env files')
assert.ok(fs.existsSync('generated/config.json'), 'missing generated/config.json — provisioning setup did not run')

assert.strictEqual(calc.add(2, 3), 5)
assert.deepStrictEqual(calc.simplifyRatio(6, 8), [3, 4])
assert.deepStrictEqual(calc.simplifyRatio(5, 10), [1, 2])
console.log('ok')
EOF
git add -A
git commit -qm "gate-convention: add simplifyRatio with inline gcd"
git checkout -q main

BASE=$(git rev-parse HEAD)

# ------------------------------------------------------------ plan + state json
cat > .roadmap/plan.json <<EOF
{
  "repoPath": "$REPO",
  "worktreeRoot": "$WT",
  "cutLine": "eval",
  "units": [
    { "id": "add-multiply",     "title": "multiply()",                 "risk": "low",  "kind": "code", "inScope": true },
    { "id": "add-divide",       "title": "divide()",                   "risk": "med",  "kind": "code", "inScope": true },
    { "id": "impossible-cache", "title": "cross-process memoization",  "risk": "med",  "kind": "code", "inScope": true },
    { "id": "gate-good",        "title": "subtract() (adopted branch)", "risk": "low", "kind": "code", "inScope": true, "existingBranch": "fixture/gate-good" },
    { "id": "gate-bad",         "title": "percent() (adopted branch)",  "risk": "high", "kind": "code", "inScope": true, "existingBranch": "fixture/gate-bad" },
    { "id": "gate-convention",  "title": "simplifyRatio() (adopted branch)", "risk": "high", "kind": "code", "inScope": true, "existingBranch": "fixture/gate-convention" }
  ],
  "edges": [
    { "from": "add-multiply", "to": "add-divide", "type": "semantic", "mode": "contract", "contract": "contracts/calc-api.md" }
  ],
  "provision": { "copy": [".env.local"], "setup": "node tools/gen-config.js" },
  "conventions": "$REPO/.roadmap/contracts/conventions.md",
  "preview": { "kind": "api", "howToAccess": "From the repo checkout, drive the library directly with node -e and require('./calc') — exercise every exported function." },
  "config": { "maxConsults": 2 }
}
EOF

cat > .roadmap/state.json <<EOF
{ "integrationBranch": "roadmap/eval", "integrationTip": "$BASE",
  "consultsUsed": 0, "wave": 0, "units": {} }
EOF

git add .roadmap/plan.json .roadmap/state.json
git commit -qm "fixture: plan + initial state"

echo "Fixture ready at $TARGET"
echo "  repo:  $REPO  (base $BASE)"
echo "  next:  launch the harness with plan/state from $REPO/.roadmap/ (see evals/README.md),"
echo "         then run: check.sh $TARGET"
