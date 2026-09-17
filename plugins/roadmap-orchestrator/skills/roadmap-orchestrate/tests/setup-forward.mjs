#!/usr/bin/env node
// Real-agent, local-only fixture. No provider CLI or network service is used by this setup.
import { fixture, git, json, writeFile, path } from './helpers.mjs'

const f = await fixture(null, {
  cutLine: 'calculator-v1',
  units: [
    { id: 'percent', title: 'Integer percentages', risk: 'high', kind: 'code', inScope: true, existingBranch: 'adopt/percent' },
    { id: 'ratio-cli', title: 'Percentage CLI', risk: 'low', kind: 'code', inScope: true },
  ],
  edges: [{ from: 'percent', to: 'ratio-cli', type: 'semantic', mode: 'contract', contract: 'contracts/calc.md' }],
})
const { mkdir } = await import('node:fs/promises')
await mkdir(path.join(f.dir, 'contracts'), { recursive: true })
await writeFile(path.join(f.dir, 'contracts/calc.md'), '# Calculator contract\npercent(a,b) returns Math.floor(100*a/b) for finite inputs, b nonzero. Reject nonfinite inputs or b===0 with RangeError. Preserve twice(x).\n')
await writeFile(path.join(f.dir, 'specs/percent.md'), '# Integer percentages\nAC-1: implement the frozen calculator contract for positive and negative values, including -1/8.\nAC-2: add executable regression tests for invalid input and negative rounding.\nScope: calc.mjs and test.mjs; no unrelated dependencies. Preserve twice(x). Done when: node test.mjs. Existing implementation is on adopt/percent; review it.\n')
await writeFile(path.join(f.dir, 'specs/ratio-cli.md'), '# Percentage CLI\nAC-1: node cli.mjs -1 8 prints -13 followed by a newline, using percent from calc.mjs.\nAC-2: invalid arguments exit nonzero and explain usage.\nScope: cli.mjs and test.mjs. Preserve calculator contracts. Done when: node test.mjs and node cli.mjs -1 8.\n')
await writeFile(path.join(f.dir, 'architect-log.md'), '# Architect log\n\n## Direction\nSmall dependency-free Node ESM calculator. Numerical correctness outranks API convenience. No GUI, package manager, server or external tracking.\n')
await writeFile(path.join(f.dir, 'roadmap.md'), '# Calculator roadmap\nDeliver integer percentages and a small CLI through milestone calculator-v1. Correct negative rounding and invalid inputs matter. Keep existing twice behavior.\n')
const adopt = path.join(f.root, 'adopt')
git(f.repo, 'worktree', 'add', '-b', 'adopt/percent', adopt, f.initial)
await writeFile(path.join(adopt, 'calc.mjs'), 'export const twice = x => x * 2\nexport const percent = (a, b) => Math.round(100 * a / b)\n')
git(adopt, 'add', 'calc.mjs'); git(adopt, 'commit', '-m', 'existing percentage implementation')
git(f.repo, 'worktree', 'remove', adopt)
await f.call('release', { stopped: true })
console.log(json({ repo: f.repo, roadmapDir: f.dir, worktreeRoot: f.wt, roadmap: path.join(f.dir, 'roadmap.md') }))
