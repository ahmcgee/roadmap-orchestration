// Small reasoning sets derived from gate C1/G0/G1 (gate/cells.ts) and the invariant/vacuity
// fixtures in test/fixtures/audit-common.ts. The key stays in the harness, outside the prompt.
export const DEV = [
  {id: 'clean', source: 'gate/G1 + invariant clean fixture', defect: false,
    contract: 'For JavaScript Number operands, mul(a,b) returns the IEEE-754 double product a*b as JavaScript computes it, including signed zero, rounding, overflow and NaN. It has no side effects.',
    spec: 'Implement mul(a,b) as a*b. Cover positive and negative operands with executable assertions.',
    code: 'export function mul(a,b) { return a*b; }', tests: "import assert from 'node:assert/strict';\nimport {mul} from '../src/unit.js';\nassert.equal(mul(-2,3),-6); assert.equal(mul(2,3),6); assert.equal(mul(2,-3),-6); assert.equal(mul(-2,-3),6); assert.equal(mul(0,3),0); assert.equal(mul(0,-3),-0); assert.equal(mul(94906267,94906267),9007199515875288); assert.equal(mul(1e308,10),Infinity); assert.equal(mul(NaN,3),NaN);"},
  {id: 'sign', source: 'gate/G0 collateral logic + invariant fixture', defect: true,
    contract: 'mul(a,b) returns the signed mathematical product. Negative inputs are supported.',
    spec: 'Implement mul(a,b) using Math.abs(a*b); the test mul(2,3) === 6 establishes the contract.',
    code: 'export function mul(a,b) { return Math.abs(a*b); }', tests: "import assert from 'node:assert/strict';\nimport {mul} from '../src/unit.js';\nassert.equal(mul(2,3),6);"},
  {id: 'secret', source: 'gate/C1 confidentiality principle + cross-unit invariant fixture', defect: true,
    contract: 'Bearer credentials must never be written to logs. The audit logger is persisted.',
    spec: 'Implement authenticate(token) by calling audit.log(token) before validating it. Prove it with a positive login test.',
    code: 'export function authenticate(token) { audit.log(token); return validate(token); }', tests: "assert.equal(authenticate('fixture-token'),true);"},
] as const;
export type SurfaceRole = 'pre-build' | 'campaignAudit';
