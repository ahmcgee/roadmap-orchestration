// Production role prompts, schemas and backend argv; --dry-run renders and validates every cell for free.
import {execFile} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {promisify} from 'node:util';
import {backendArgv, freshJudgmentSession} from '../../../src/backends/argv.ts';
import {unitId, specRev, sha, systemName} from '../../../src/core/ids.ts';
import {absPath, repoPath} from '../../../src/core/values.ts';
import {promptFor} from '../../../src/prompts/index.ts';
import {validateGateOutput, validateCampaignAuditOutput} from '../../../src/prompts/schemas.ts';
import type {RoleInputs} from '../../../src/prompts/inputs.ts';
import {DEV, type SurfaceRole} from './dev.ts';
import {lensAnswer} from '../../../test/helpers/holistic.ts';
import {intOption, usdOption} from '../pool.ts';

const exec = promisify(execFile);
const method = {traits: [], markers: [], unitKind: 'module', expensiveLanes: false, ui: false} as const;
export function surfaceInput(role: SurfaceRole, cell: (typeof DEV)[number], dir: string): RoleInputs['verifier'] | RoleInputs['campaignAudit'] {
  const target = {kind: 'full' as const, doc: {path: repoPath('CONTRACT.md'), text: cell.contract}};
  const spec = {unit: unitId('u1'), rev: specRev(1), markdown: `# Unit\n${cell.spec}\nProof: test/unit.test.js runs in the unit lane.\nSource: src/unit.js`};
  if (role === 'pre-build') return {mode: 'pre-build', brief: {target, vision: null, spec, intent: cell.contract, nonGoals: ['No unrelated behavior'], contracts: [], systems: [systemName('app')], method, history: [], standing: []}};
  const from = sha('a'.repeat(40)), to = sha('b'.repeat(40));
  return {target, vision: {rev: 1, clauses: [], questions: [], advances: []}, obligations: [], method, range: {audited: to, diff: {
    from, to, dir: absPath(dir), orientation: {stat: {text: 'fixture', full: true}, moves: {shown: [], more: 0}, deletions: {shown: [], more: 0, labelled: false}, packages: {shown: [], more: 0}, substitutions: [], explained: 0}, inlined: [], text: `src/unit.js:\n${cell.code}\ntest/unit.test.js:\n${cell.tests}`, omitted: {shown: [], more: 0}, notInlined: [], overflow: 0,
  }}, owners: [], priorFindings: [], contracts: [], checkout: absPath(dir)};
}
export function referenceAnswer(role: SurfaceRole, defect: boolean): unknown {
  if (role === 'campaignAudit') return {...lensAnswer(defect ? [{severity: 'P3', claim: 'The implementation violates CONTRACT.md', evidence: [{path: 'src/unit.js', line: 1}]}] : []) as object, requests: []};
  return {decision: 'approve', ordering: null, findings: defect ? [{severity: 'note', path: 'src/unit.js:1', text: 'The proposed implementation violates CONTRACT.md', evidence: ['src/unit.js:1'], contractRef: null, experiments: [], debt: null, defect: null, reraises: null, hunk: null}] : [], directives: [], reasons: ['Reviewed the contract and code'], premises: [], standing: [], clusters: null, rulings: []};
}
export function gradeSurface(role: SurfaceRole, defect: boolean, answer: unknown): boolean {
  const out = role === 'pre-build' ? validateGateOutput(answer) : validateCampaignAuditOutput(answer);
  return defect ? out.findings.length > 0 && out.findings.every((f) => f.evidence.length > 0 || 'experiments' in f && f.experiments.length > 0) : out.findings.length === 0;
}
export async function runSurface(argv: readonly string[]): Promise<boolean> {
  const {values, positionals} = parseArgs({args: [...argv], allowPositionals: true, options: {set: {type: 'string'}, n: {type: 'string', default: '3'}, out: {type: 'string'}, 'dry-run': {type: 'boolean'}, fake: {type: 'string'}, cap: {type: 'string'}}});
  const role = positionals[0];
  if ((role !== 'pre-build' && role !== 'campaignAudit') || values.set !== 'dev' || positionals.length !== 1) throw new Error('usage: node evals/roles/run.ts <pre-build|campaignAudit> --set dev --n 3 [--dry-run] [--fake expected|empty] [--cap USD] [--out DIR]');
  if (values.fake !== undefined && values.fake !== 'expected' && values.fake !== 'empty') throw new Error('unknown fake');
  const n = intOption('n', values.n, 1, 100), cap = usdOption('cap', values.cap);
  const out = values.out === undefined ? mkdtempSync(join(tmpdir(), `roles-${role}-`)) : resolve(values.out);
  mkdirSync(out, {recursive: true});
  const rows: {cell: string; trial: number; pass: boolean; usd: number}[] = [];
  let spent = 0;
  for (const cell of DEV) for (let trial = 0; trial < n; trial++) {
    if (cap !== null && spent >= cap) throw new Error(`eval cap reached at $${spent}`);
    const dir = join(out, `${cell.id}-${trial}`); mkdirSync(join(dir, 'src'), {recursive: true}); mkdirSync(join(dir, 'test'), {recursive: true});
    writeFileSync(join(dir, 'CONTRACT.md'), cell.contract); writeFileSync(join(dir, 'src/unit.js'), cell.code); writeFileSync(join(dir, 'test/unit.test.js'), cell.tests);
    const model = 'claude-opus-5-5' as const, prompt = promptFor(role === 'pre-build' ? 'verifier' : 'campaignAudit', model);
    const input = surfaceInput(role, cell, dir);
    const text = role === 'pre-build' ? promptFor('verifier', model).render(input as RoleInputs['verifier']) : promptFor('campaignAudit', model).render(input as RoleInputs['campaignAudit']);
    writeFileSync(join(dir, 'prompt.txt'), prompt.system + '\n' + text); writeFileSync(join(dir, 'schema.json'), JSON.stringify(prompt.schema));
    let answer: unknown = referenceAnswer(role, values.fake === 'empty' ? false : cell.defect), usd = 0;
    if (!values['dry-run'] && values.fake === undefined) {
      const common = {triple: {backend: 'claude' as const, model, effort: role === 'campaignAudit' ? 'high' as const : 'medium' as const}, session: freshJudgmentSession(), schemaText: JSON.stringify(prompt.schema), system: prompt.system, evidenceDirs: []};
      const args = backendArgv(role === 'pre-build' ? {kind: 'claude-acting-judge', role: 'verifier', ...common, mcpConfig: null, denyWrites: []} : {kind: 'claude-judgment', role: 'campaignAudit', ...common});
      const child = exec(args[0]!, args.slice(1), {cwd: dir, timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024}); child.child.stdin!.end(text);
      const result = await child; writeFileSync(join(dir, 'transcript.jsonl'), result.stdout);
      const terminal = result.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).findLast((e) => e['type'] === 'result');
      if (terminal === undefined) throw new Error('no terminal result');
      answer = terminal['structured_output']; usd = typeof terminal['total_cost_usd'] === 'number' ? terminal['total_cost_usd'] : 0;
    }
    const pass = gradeSurface(role, cell.defect, answer); spent += usd; rows.push({cell: cell.id, trial, pass, usd});
    writeFileSync(join(dir, 'answer.json'), JSON.stringify(answer)); process.stdout.write(`${values['dry-run'] ? 'DRY' : 'TRIAL'} ${role}/${cell.id}#${trial} ${pass ? 'PASS' : 'FAIL'}\n`);
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify({role, set: 'dev', rows, spent}, null, 2));
  return rows.every((r) => r.pass);
}
