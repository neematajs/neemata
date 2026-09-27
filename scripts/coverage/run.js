#!/usr/bin/env node

import { rm } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  gitCommit,
  parseArguments,
  pathExists,
  readJson,
  runCommand,
  toPosixPath,
  writeJson,
} from '../benchmarks/utils.js'

const SERVICE_VARIABLES = [
  'NMTJS_REQUIRE_SERVICE_TESTS',
  'POSTGRES_URL',
  'REDIS_URL',
  'VALKEY_URL',
]

// Mirrors the Test workflow's unit and service integration jobs, so coverage
// reflects the suites that gate merges. Each run only sees the service
// variables its CI counterpart gets.
const RUNS = [
  { name: 'unit', args: [], env: [] },
  {
    name: 'pubsub-integration',
    args: ['--project', '@nmtjs/pubsub', 'packages/pubsub/tests/integration'],
    env: SERVICE_VARIABLES,
  },
  {
    name: 'workflows-integration',
    args: [
      '--project',
      '@nmtjs/workflows',
      'packages/workflows/tests/integration',
    ],
    env: SERVICE_VARIABLES,
  },
  {
    name: 'workflows-redis-contracts',
    args: [
      '--project',
      '@nmtjs/workflows',
      'packages/workflows/tests/runtime-adapter-contract.spec.ts',
      'packages/workflows/tests/runtime-manual-retry.spec.ts',
    ],
    env: ['REDIS_URL', 'VALKEY_URL'],
  },
]

export async function collectCoverage({ root, output }) {
  const runsDirectory = `${output}.runs`
  await rm(runsDirectory, { force: true, recursive: true })

  const runs = []
  const maps = []
  for (const run of RUNS) {
    const env = runEnvironment(run)
    const needsServices = run.env.some((name) => name.endsWith('_URL'))
    if (needsServices && !run.env.some((name) => env[name])) {
      console.log(`\n[coverage] skipping ${run.name}: no service URLs set`)
      runs.push({ name: run.name, status: 'skipped' })
      continue
    }

    console.log(`\n[coverage] ${run.name}`)
    const reportsDirectory = resolve(runsDirectory, run.name)
    let status = 'passed'
    try {
      await runCommand(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          ...run.args,
          '--coverage.enabled',
          '--coverage.reporter=json',
          `--coverage.reportsDirectory=${reportsDirectory}`,
          '--coverage.reportOnFailure',
          '--reporter=agent',
        ],
        { cwd: root, env },
      )
    } catch (error) {
      // Test failures are reported by the Test workflow; keep whatever
      // coverage the run produced and flag it as incomplete instead.
      console.error(`[coverage] ${run.name}: ${error.message}`)
      status = 'failed'
    }

    const reportPath = resolve(reportsDirectory, 'coverage-final.json')
    if (await pathExists(reportPath)) {
      maps.push(await readJson(reportPath))
    } else {
      status = 'missing'
    }
    runs.push({ name: run.name, status })
  }

  const files = {}
  const packageNames = new Map()
  for (const [path, summary] of summarizeCoverage(mergeCoverageMaps(maps))) {
    const file = toPosixPath(relative(root, path))
    files[file] = {
      package: await packageName(root, file, packageNames),
      ...summary,
    }
  }

  const report = { schemaVersion: 1, commit: gitCommit(root), runs, files }
  await writeJson(output, report)
  await rm(runsDirectory, { force: true, recursive: true })
  return report
}

function runEnvironment(run) {
  const env = { ...process.env }
  for (const name of SERVICE_VARIABLES) {
    if (!run.env.includes(name)) delete env[name]
  }
  return env
}

async function packageName(root, file, cache) {
  const directory = file.split('/').slice(0, 2).join('/')
  if (!cache.has(directory)) {
    const manifest = await readJson(
      resolve(root, directory, 'package.json'),
    ).catch(() => undefined)
    cache.set(directory, manifest?.name ?? directory)
  }
  return cache.get(directory)
}

// Merges Istanbul coverage maps from separate runs by source location rather
// than by id, so a file instrumented by differently configured projects still
// lines up.
export function mergeCoverageMaps(maps) {
  const files = new Map()
  for (const map of maps) {
    for (const coverage of Object.values(map)) {
      let merged = files.get(coverage.path)
      if (!merged) {
        merged = {
          branches: new Map(),
          functions: new Map(),
          statements: new Map(),
        }
        files.set(coverage.path, merged)
      }
      for (const [id, location] of Object.entries(coverage.statementMap)) {
        addHits(merged.statements, locationKey(location), coverage.s[id], {
          line: location.start.line,
        })
      }
      for (const [id, fn] of Object.entries(coverage.fnMap)) {
        addHits(merged.functions, locationKey(fn.loc), coverage.f[id])
      }
      for (const [id, branch] of Object.entries(coverage.branchMap)) {
        coverage.b[id].forEach((hits, index) => {
          addHits(merged.branches, `${locationKey(branch.loc)}#${index}`, hits)
        })
      }
    }
  }
  return files
}

export function summarizeCoverage(files) {
  const summaries = new Map()
  for (const [path, merged] of [...files].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    // Istanbul derives line coverage from the first line of each statement.
    const lines = new Map()
    for (const { hits, line } of merged.statements.values()) {
      lines.set(line, (lines.get(line) ?? 0) + hits)
    }
    summaries.set(path, {
      lines: count(lines.values()),
      branches: count(merged.branches.values(), (entry) => entry),
      functions: count(merged.functions.values(), (entry) => entry),
      statements: count(merged.statements.values(), (entry) => entry.hits),
    })
  }
  return summaries
}

function addHits(entries, key, hits, extra) {
  const existing = entries.get(key)
  if (extra) {
    entries.set(key, { ...extra, hits: (existing?.hits ?? 0) + hits })
  } else {
    entries.set(key, (existing ?? 0) + hits)
  }
}

function count(values, hitsOf = (value) => value) {
  let covered = 0
  let total = 0
  for (const value of values) {
    total++
    if (hitsOf(value) > 0) covered++
  }
  return { covered, total }
}

function locationKey({ start, end }) {
  return `${start.line ?? ''}:${start.column ?? ''}-${end.line ?? ''}:${end.column ?? ''}`
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  const args = parseArguments(process.argv.slice(2))
  if (!args.output) throw new Error('--output is required')
  await collectCoverage({
    root: resolve(args.root || process.cwd()),
    output: resolve(args.output),
  })
}
