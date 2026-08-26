#!/usr/bin/env node

import { rm } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { runSizeBenchmarks } from './sizes.mjs'
import { runTypeBenchmarks } from './types.mjs'
import {
  collectEnvironment,
  findFiles,
  gitCommit,
  hashFiles,
  parseArguments,
  readJson,
  runCommand,
  toPosixPath,
  writeJson,
} from './utils.mjs'

const args = parseArguments(process.argv.slice(2))
const suite = args._[0]
const root = resolve(args.root || process.cwd())
const output = resolve(
  root,
  args.output || `benchmark-results/${suite || 'unknown'}.json`,
)
const commonSuiteFiles = [
  resolve(root, 'scripts/benchmarks/run.mjs'),
  resolve(root, 'scripts/benchmarks/utils.mjs'),
]

if (!['integration', 'runtime', 'sizes', 'types'].includes(suite)) {
  throw new Error(
    'Expected a benchmark suite: runtime, types, sizes, or integration',
  )
}

const { cases, suiteFiles } = await runSuite(suite)
if (cases.length === 0)
  throw new Error(`Benchmark suite ${suite} produced no cases`)

const report = {
  schemaVersion: 1,
  suite,
  generatedAt: new Date().toISOString(),
  environment: await collectEnvironment(root),
  source: {
    commit: gitCommit(root),
    suiteHash: await hashFiles(root, suiteFiles),
  },
  cases,
}

await writeJson(output, report)
console.log(
  `Benchmark report written to ${toPosixPath(relative(root, output))}`,
)

async function runSuite(name) {
  if (name === 'types') {
    return {
      cases: await runTypeBenchmarks(root),
      suiteFiles: [
        ...commonSuiteFiles,
        resolve(root, 'scripts/benchmarks/types.mjs'),
      ],
    }
  }

  if (name === 'sizes') {
    return {
      cases: await runSizeBenchmarks(root),
      suiteFiles: [
        ...commonSuiteFiles,
        resolve(root, 'scripts/benchmarks/sizes.mjs'),
      ],
    }
  }

  const integration = name === 'integration'
  const config = integration
    ? 'vitest.bench.integration.config.ts'
    : 'vitest.bench.config.ts'
  const rawOutput = `${output}.vitest.json`
  await runCommand(
    'pnpm',
    ['exec', 'vitest', 'bench', '--config', config, '--outputJson', rawOutput],
    { cwd: root },
  )

  const rawReport = await readJson(rawOutput)
  await rm(rawOutput, { force: true })
  const cases = normalizeVitestReport(rawReport, integration)
  const suiteFiles = await findFiles(
    resolve(root, 'packages'),
    (_path, relativePath) =>
      integration
        ? relativePath.endsWith('.integration.bench.ts')
        : relativePath.endsWith('.bench.ts') &&
          !relativePath.endsWith('.integration.bench.ts'),
  )
  suiteFiles.push(...commonSuiteFiles, resolve(root, config))
  return { cases, suiteFiles }
}

function normalizeVitestReport(report, integration) {
  const cases = []
  for (const file of report.files ?? []) {
    const filePath = toPosixPath(relative(root, file.filepath))
    for (const group of file.groups ?? []) {
      const groupName = group.fullName.startsWith(`${filePath} > `)
        ? group.fullName.slice(filePath.length + 3)
        : group.fullName
      for (const benchmark of group.benchmarks ?? []) {
        if (!Number.isFinite(benchmark.median)) {
          throw new Error(
            `Benchmark ${filePath} > ${groupName} > ${benchmark.name} has no median`,
          )
        }
        cases.push({
          category: integration ? 'integration' : 'runtime',
          id: `${filePath} > ${groupName} > ${benchmark.name}`,
          metric: 'median',
          name: `${groupName} > ${benchmark.name}`,
          statistics: {
            mean: benchmark.mean,
            p75: benchmark.p75,
            p99: benchmark.p99,
            relativeMarginOfError: benchmark.rme,
            sampleCount: benchmark.sampleCount,
          },
          unit: 'ms/op',
          value: benchmark.median,
        })
      }
    }
  }
  return cases.sort((left, right) => left.id.localeCompare(right.id))
}
