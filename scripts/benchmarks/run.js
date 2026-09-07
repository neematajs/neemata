#!/usr/bin/env node

import { mkdir, rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

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
} from './utils.js'

const args = parseArguments(process.argv.slice(2))
const suite = args._[0]
const root = resolve(args.root || process.cwd())
const output = args.output ? resolve(root, args.output) : undefined
const commonSuiteFiles = [
  resolve(root, 'scripts/benchmarks/run.js'),
  resolve(root, 'scripts/benchmarks/utils.js'),
]

if (!['integration', 'runtime'].includes(suite)) {
  throw new Error('Expected a benchmark suite: runtime or integration')
}

const { cases, suiteFiles } = await runSuite(suite, Boolean(output))
if (cases?.length === 0)
  throw new Error(`Benchmark suite ${suite} produced no cases`)

if (output) {
  if (!cases) throw new Error(`Benchmark suite ${suite} produced no report`)
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
} else {
  if (cases) printLocalResults(suite, cases)
  console.log(`Benchmark suite ${suite} completed; no report was written.`)
}

async function runSuite(name, collectReport) {
  const integration = name === 'integration'
  const config = integration
    ? 'vitest.bench.integration.config.ts'
    : 'vitest.bench.config.ts'
  const vitestArguments = [
    'exec',
    'vitest',
    'bench',
    '--run',
    '--config',
    config,
  ]
  if (!collectReport) {
    await runCommand('pnpm', vitestArguments, { cwd: root })
    return { cases: undefined, suiteFiles: [] }
  }

  await mkdir(dirname(output), { recursive: true })
  const rawOutput = `${output}.vitest.json`
  await runCommand('pnpm', [...vitestArguments, '--outputJson', rawOutput], {
    cwd: root,
  })

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

function printLocalResults(name, cases) {
  const formatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 6,
  })
  console.log(`\n${name} benchmark results`)
  for (const benchmarkCase of cases) {
    console.log(
      `- ${benchmarkCase.name}: ${formatter.format(benchmarkCase.value)} ${benchmarkCase.unit}`,
    )
  }
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
