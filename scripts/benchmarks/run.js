#!/usr/bin/env node

import { glob, mkdir, rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  collectEnvironment,
  gitCommit,
  hashFiles,
  readJson,
  runCommand,
  SCHEMA_VERSION,
  SUITES,
  toPosixPath,
  writeJson,
} from './utils.js'

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string' },
    root: { type: 'string' },
  },
})
const [suite] = positionals
const root = resolve(args.root ?? process.cwd())
const output = args.output ? resolve(root, args.output) : undefined

if (!Object.hasOwn(SUITES, suite ?? '')) {
  throw new Error(
    `Expected a benchmark suite: ${Object.keys(SUITES).join(' or ')}`,
  )
}

if (output) {
  const { cases, suiteFiles } = await collectReport(suite)
  if (cases.length === 0) {
    throw new Error(`Benchmark suite ${suite} produced no cases`)
  }

  await writeJson(output, {
    schemaVersion: SCHEMA_VERSION,
    suite,
    generatedAt: new Date().toISOString(),
    environment: await collectEnvironment(root),
    source: {
      commit: gitCommit(root),
      suiteHash: await hashFiles(root, suiteFiles),
    },
    cases,
  })
  console.log(
    `Benchmark report written to ${toPosixPath(relative(root, output))}`,
  )
} else {
  await runVitestBench(suite)
  console.log(`Benchmark suite ${suite} completed; no report was written.`)
}

function runVitestBench(name, extraArgs = []) {
  const vitestArguments = [
    'exec',
    'vitest',
    'bench',
    '--run',
    '--config',
    SUITES[name].config,
    ...extraArgs,
  ]
  return runCommand('pnpm', vitestArguments, root)
}

/**
 * Runs the suite through vitest's JSON reporter and turns it into the report
 * schema, alongside the files whose contents identify the suite: a hash
 * change is what tells the comparison a baseline is no longer valid.
 */
async function collectReport(name) {
  await mkdir(dirname(output), { recursive: true })
  const rawOutput = `${output}.vitest.json`
  await runVitestBench(name, ['--outputJson', rawOutput])

  const rawReport = await readJson(rawOutput)
  await rm(rawOutput, { force: true })

  const suiteFiles = await benchFiles(name)
  suiteFiles.push(
    resolve(root, 'scripts/benchmarks/run.js'),
    resolve(root, 'scripts/benchmarks/utils.js'),
    resolve(root, SUITES[name].config),
  )
  return { cases: normalizeVitestReport(rawReport, name), suiteFiles }
}

async function benchFiles(name) {
  const integration = name === 'integration'
  const files = []
  for await (const file of glob('packages/*/bench/**/*.bench.ts', {
    cwd: root,
  })) {
    if (file.endsWith('.integration.bench.ts') !== integration) continue
    files.push(resolve(root, file))
  }
  return files
}

function normalizeVitestReport(report, suite) {
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
          category: suite,
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
