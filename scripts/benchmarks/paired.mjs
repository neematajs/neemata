#!/usr/bin/env node

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { compareReports } from './compare.mjs'
import { parseArguments, pathExists, runCommand, writeJson } from './utils.mjs'

const args = parseArguments(process.argv.slice(2))
const headRoot = resolve(args.head || process.cwd())
const requestedBaseRoot = args.base ? resolve(args.base) : undefined
const outputRoot = resolve(headRoot, args.output || 'benchmark-results/paired')
const rounds = Number.parseInt(args.rounds || '3', 10)
const suites = String(args.suites || 'runtime,types,sizes')
  .split(',')
  .filter(Boolean)

if (!Number.isInteger(rounds) || rounds < 1) {
  throw new Error('--rounds must be a positive integer')
}
for (const suite of suites) {
  if (!['integration', 'runtime', 'sizes', 'types'].includes(suite)) {
    throw new Error(`Unsupported benchmark suite: ${suite}`)
  }
}

const baseRunner = requestedBaseRoot
  ? resolve(requestedBaseRoot, 'scripts/benchmarks/run.mjs')
  : undefined
const baseRoot =
  baseRunner && (await pathExists(baseRunner)) ? requestedBaseRoot : undefined
const headRunner = resolve(headRoot, 'scripts/benchmarks/run.mjs')
if (!(await pathExists(headRunner))) {
  throw new Error(`Head benchmark runner is missing: ${headRunner}`)
}

const defaultBaseThresholds = baseRoot
  ? resolve(baseRoot, 'benchmarks/thresholds.json')
  : undefined
const thresholds = args.thresholds
  ? resolve(args.thresholds)
  : defaultBaseThresholds && (await pathExists(defaultBaseThresholds))
    ? defaultBaseThresholds
    : resolve(headRoot, 'benchmarks/thresholds.json')
if (!(await pathExists(thresholds))) {
  throw new Error(`Benchmark thresholds are missing: ${thresholds}`)
}

await mkdir(outputRoot, { recursive: true })
const baseReports = []
const headReports = []

for (let round = 0; round < rounds; round++) {
  const order =
    baseRoot && round % 2 === 0
      ? ['base', 'head']
      : baseRoot
        ? ['head', 'base']
        : ['head']

  for (const target of order) {
    const root = target === 'base' ? baseRoot : headRoot
    const runner = target === 'base' ? baseRunner : headRunner
    for (const suite of suites) {
      const output = resolve(outputRoot, `${target}-${suite}-${round + 1}.json`)
      console.log(
        `\n[benchmark] ${target} ${suite}, round ${round + 1}/${rounds}`,
      )
      await runCommand(
        process.execPath,
        [runner, suite, '--root', root, '--output', output],
        { cwd: root },
      )
      const reports = target === 'base' ? baseReports : headReports
      reports.push(output)
    }
  }
}

const enforce = Boolean(args.enforce)
const comparisonOutput = resolve(outputRoot, 'comparison.json')
const summaryOutput = resolve(outputRoot, 'summary.md')
const comparison = await compareReports({
  base: baseReports,
  enforce,
  head: headReports,
  output: comparisonOutput,
  summary: summaryOutput,
  thresholds,
})

await writeJson(resolve(outputRoot, 'run.json'), {
  schemaVersion: 1,
  baseAvailable: Boolean(baseRoot),
  enforced: enforce,
  rounds,
  suites,
  thresholds,
})
process.stdout.write(`\n${comparison.summary}`)
if (enforce && comparison.failed) process.exitCode = 1
