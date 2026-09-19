#!/usr/bin/env node

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { compareReports } from './compare.js'
import {
  pathExists,
  runCommand,
  SCHEMA_VERSION,
  SUITES,
  writeJson,
} from './utils.js'

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    enforce: { type: 'boolean' },
    head: { type: 'string' },
    output: { type: 'string' },
    rounds: { type: 'string' },
    suites: { type: 'string' },
    thresholds: { type: 'string' },
  },
})

const headRoot = resolve(args.head || process.cwd())
const persistentOutput = args.output
  ? resolve(headRoot, args.output)
  : undefined
const enforce = Boolean(args.enforce)
const rounds = Number.parseInt(args.rounds ?? '3', 10)
const suites = (args.suites || 'runtime').split(',').filter(Boolean)

if (!Number.isInteger(rounds) || rounds < 1) {
  throw new Error('--rounds must be a positive integer')
}
for (const suite of suites) {
  if (!Object.hasOwn(SUITES, suite)) {
    throw new Error(`Unsupported benchmark suite: ${suite}`)
  }
}

const headRunner = resolve(headRoot, 'scripts/benchmarks/run.js')
if (!(await pathExists(headRunner))) {
  throw new Error(`Head benchmark runner is missing: ${headRunner}`)
}

// A base revision without the benchmark system cannot be measured — the run
// then produces a candidate baseline instead of a comparison.
const requestedBaseRoot = args.base ? resolve(args.base) : undefined
const baseRunner = requestedBaseRoot
  ? resolve(requestedBaseRoot, 'scripts/benchmarks/run.js')
  : undefined
const baseRoot =
  baseRunner && (await pathExists(baseRunner)) ? requestedBaseRoot : undefined

const targets = {
  head: { root: headRoot, runner: headRunner, reports: [] },
  base: { root: baseRoot, runner: baseRunner, reports: [] },
}

// The base revision's own thresholds win, so a pull request cannot relax the
// gate it is being measured against.
let thresholds
if (args.thresholds) {
  thresholds = resolve(args.thresholds)
} else {
  const baseThresholds = baseRoot
    ? resolve(baseRoot, 'benchmarks/thresholds.json')
    : undefined
  thresholds =
    baseThresholds && (await pathExists(baseThresholds))
      ? baseThresholds
      : resolve(headRoot, 'benchmarks/thresholds.json')
}
if (!(await pathExists(thresholds))) {
  throw new Error(`Benchmark thresholds are missing: ${thresholds}`)
}

const outputRoot =
  persistentOutput ?? (await mkdtemp(resolve(tmpdir(), 'neemata-benchmark-')))
try {
  await runPairedBenchmarks()
} finally {
  if (!persistentOutput) {
    await rm(outputRoot, { force: true, recursive: true })
  }
}

async function runPairedBenchmarks() {
  await mkdir(outputRoot, { recursive: true })

  for (let round = 0; round < rounds; round++) {
    // Alternate which side runs first so a warming or cooling machine biases
    // both sides equally.
    let order
    if (!baseRoot) {
      order = ['head']
    } else if (round % 2 === 0) {
      order = ['base', 'head']
    } else {
      order = ['head', 'base']
    }

    for (const name of order) {
      const target = targets[name]
      for (const suite of suites) {
        const output = resolve(outputRoot, `${name}-${suite}-${round + 1}.json`)
        console.log(
          `\n[benchmark] ${name} ${suite}, round ${round + 1}/${rounds}`,
        )
        await runCommand(
          process.execPath,
          [target.runner, suite, '--root', target.root, '--output', output],
          target.root,
        )
        target.reports.push(output)
      }
    }
  }

  const comparisonOutput = resolve(outputRoot, 'comparison.json')
  const summaryOutput = resolve(outputRoot, 'summary.md')
  const comparison = await compareReports({
    base: targets.base.reports,
    enforce,
    head: targets.head.reports,
    output: comparisonOutput,
    summary: summaryOutput,
    thresholds,
  })

  await writeJson(resolve(outputRoot, 'run.json'), {
    schemaVersion: SCHEMA_VERSION,
    baseAvailable: Boolean(baseRoot),
    enforced: enforce,
    rounds,
    suites,
    thresholds,
  })
  process.stdout.write(`\n${comparison.summary}`)
  if (enforce && comparison.failed) process.exitCode = 1
}
