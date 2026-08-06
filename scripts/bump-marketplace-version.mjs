#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = [
  {
    path: '.claude-plugin/marketplace.json',
    pointers: [['version'], ['plugins', 0, 'version']],
  },
  {
    path: 'plugins/roadmap-orchestrator/.claude-plugin/plugin.json',
    pointers: [['version']],
  },
  {
    path: 'plugins/roadmap-orchestrator/.codex-plugin/plugin.json',
    pointers: [['version']],
  },
  {
    path: 'plugins/roadmap-orchestrator/runtime/codex/package.json',
    pointers: [['version']],
  },
  {
    path: 'plugins/roadmap-orchestrator/runtime/codex/package-lock.json',
    pointers: [['version'], ['packages', '', 'version']],
  },
]

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function fail(message) {
  process.stderr.write(`version bump failed: ${message}\n`)
  process.exitCode = 1
}

function valueAt(object, pointer) {
  return pointer.reduce((value, key) => value?.[key], object)
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left.localeCompare(right)
}

function compareSemver(left, right) {
  const leftMatch = left.match(semverPattern)
  const rightMatch = right.match(semverPattern)
  if (!leftMatch || !rightMatch) throw new Error('internal semver comparison received an invalid version')
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(leftMatch[index]) - Number(rightMatch[index])
    if (delta) return delta
  }
  const leftPre = leftMatch[4]?.split('.')
  const rightPre = rightMatch[4]?.split('.')
  if (!leftPre && !rightPre) return 0
  if (!leftPre) return 1
  if (!rightPre) return -1
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    if (leftPre[index] === undefined) return -1
    if (rightPre[index] === undefined) return 1
    const delta = compareIdentifiers(leftPre[index], rightPre[index])
    if (delta) return delta
  }
  return 0
}

async function loadTargets() {
  return Promise.all(targets.map(async target => {
    const absolutePath = resolve(repoRoot, target.path)
    const source = await readFile(absolutePath, 'utf8')
    const parsed = JSON.parse(source)
    const versions = target.pointers.map(pointer => valueAt(parsed, pointer))
    return { ...target, absolutePath, source, versions }
  }))
}

function currentVersion(files) {
  const entries = files.flatMap(file => file.versions.map((version, index) => ({
    location: `${file.path}#/${file.pointers[index].join('/')}`,
    version,
  })))
  const distinct = new Set(entries.map(entry => entry.version))
  if (distinct.size !== 1 || [...distinct].some(version => typeof version !== 'string' || !semverPattern.test(version))) {
    throw new Error(`version fields are not synchronized:\n${entries.map(entry => `  ${entry.location}: ${JSON.stringify(entry.version)}`).join('\n')}`)
  }
  return entries[0].version
}

function replaceVersion(file, from, to) {
  const needle = `"version": "${from}"`
  const replacement = `"version": "${to}"`
  const occurrences = file.source.split(needle).length - 1
  if (occurrences !== file.pointers.length) {
    throw new Error(`${file.path} contains ${occurrences} textual project-version fields; expected ${file.pointers.length}`)
  }
  const source = file.source.split(needle).join(replacement)
  const parsed = JSON.parse(source)
  for (const pointer of file.pointers) {
    if (valueAt(parsed, pointer) !== to) {
      throw new Error(`${file.path}#/${pointer.join('/')} was not updated`)
    }
  }
  return source
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.length === 1 && args[0] === '--check'
  const dryRun = args[0] === '--dry-run'
  const requested = dryRun ? args[1] : args[0]
  if (!check && ((!dryRun && args.length !== 1) || (dryRun && args.length !== 2))) {
    fail('usage: node scripts/bump-marketplace-version.mjs <new-semver> | --dry-run <new-semver> | --check')
    return
  }
  if (!check && !semverPattern.test(requested)) {
    fail(`invalid semantic version ${JSON.stringify(requested)}`)
    return
  }

  try {
    const files = await loadTargets()
    const current = currentVersion(files)
    if (check) {
      process.stdout.write(`marketplace versions synchronized at ${current}\n`)
      return
    }
    if (compareSemver(requested, current) <= 0) {
      throw new Error(`new version ${requested} must be greater than current version ${current}`)
    }

    const updates = files.map(file => ({ ...file, updatedSource: replaceVersion(file, current, requested) }))
    if (dryRun) {
      process.stdout.write(`would bump marketplace versions ${current} -> ${requested} in ${updates.length} files\n`)
      return
    }
    await Promise.all(updates.map(file => writeFile(file.absolutePath, file.updatedSource)))
    const verified = currentVersion(await loadTargets())
    if (verified !== requested) throw new Error(`post-write verification found ${verified}, expected ${requested}`)
    process.stdout.write(`bumped marketplace versions ${current} -> ${requested} in ${updates.length} files\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

await main()
