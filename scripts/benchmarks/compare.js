#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  median,
  medianAbsoluteDeviation,
  readJson,
  SCHEMA_VERSION,
  SUITES,
  writeJson,
  writeText,
} from './utils.js'

export async function compareReports(options) {
  const thresholds = await readJson(options.thresholds)
  validateThresholds(thresholds)
  const baseReports = await Promise.all(options.base.map(readJson))
  const headReports = await Promise.all(options.head.map(readJson))
  if (headReports.length === 0)
    throw new Error('At least one head report is required')

  const reportsBySuite = groupReports(baseReports, headReports)
  const results = []
  for (const [suite, reports] of reportsBySuite) {
    results.push(...compareSuite(suite, reports, thresholds))
  }
  results.sort((left, right) => left.id.localeCompare(right.id))

  const summary = renderSummary(results, headReports)
  const comparison = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    enforced: options.enforce,
    counts: countStatuses(results),
    results,
  }
  if (options.output) await writeJson(options.output, comparison)
  if (options.summary) await writeText(options.summary, summary)

  const failed = results.some((result) => result.status === 'fail')
  return { comparison, failed, summary }
}

function compareSuite(suite, reports, thresholds) {
  const baseHashes = new Set(
    reports.base.map((report) => report.source.suiteHash),
  )
  const headHashes = new Set(
    reports.head.map((report) => report.source.suiteHash),
  )
  const suiteChanged =
    baseHashes.size !== 1 ||
    headHashes.size !== 1 ||
    [...baseHashes][0] !== [...headHashes][0]
  const environmentsMatch = reports.base.every((base) =>
    reports.head.every((head) => compatibleEnvironment(base, head)),
  )
  const baseCases = reports.base.map(indexCases)
  const headCases = reports.head.map(indexCases)
  const headIds = new Set(headCases.flatMap((cases) => [...cases.keys()]))
  const results = []

  for (const id of headIds) {
    const sample = headCases.find((cases) => cases.has(id))?.get(id)
    const threshold = thresholds.categories[sample.category]
    if (!threshold) {
      throw new Error(`No threshold category for ${sample.category}`)
    }

    const paired = pairRounds(baseCases, headCases, id)
    const pending = pendingFor({
      hasBase: reports.base.length > 0,
      suiteChanged,
      environmentsMatch,
      rounds: paired.length,
      minimumRounds: thresholds.minimumRounds,
    })

    if (pending) {
      // Unpaired rounds still carry measurements worth showing, so report the
      // median over whatever each side produced.
      const baseValues = availableValues(baseCases, id)
      const headValues = availableValues(headCases, id)
      results.push({
        baseMedian: median(baseValues),
        category: sample.category,
        headMedian: median(headValues),
        id,
        name: sample.name,
        rounds: headValues.length,
        status: 'pending',
        suite,
        unit: sample.unit,
        reason: pending.reason,
        pendingKind: pending.kind,
      })
      continue
    }

    const stats = computeStats(paired)
    if (
      threshold.maximumRelativeMarginOfError !== undefined &&
      !stats.marginsComplete
    ) {
      throw new Error(
        `Benchmark ${id} is missing finite relative margin of error statistics`,
      )
    }
    const { status, reason } = classify(stats, threshold)

    results.push({
      baseMedian: stats.baseMedian,
      category: sample.category,
      deltaPercent: stats.deltaPercent,
      deviationPercent: stats.deviationPercent,
      headMedian: stats.headMedian,
      id,
      name: sample.name,
      reason,
      relativeMarginOfError: stats.relativeMarginOfError,
      rounds: paired.length,
      status,
      suite,
      unit: sample.unit,
    })
  }

  return results
}

// Rounds are compared like for like: round N of base against round N of head,
// so machine drift over a long run cancels out.
function pairRounds(baseCases, headCases, id) {
  const paired = []
  const rounds = Math.min(baseCases.length, headCases.length)
  for (let round = 0; round < rounds; round++) {
    const base = baseCases[round].get(id)
    const head = headCases[round].get(id)
    if (base && head) paired.push({ base, head })
  }
  return paired
}

function availableValues(rounds, id) {
  return rounds.map((cases) => cases.get(id)?.value).filter(Number.isFinite)
}

/** The reason a case cannot be judged yet, or undefined when it can. */
function pendingFor(input) {
  if (!input.hasBase) {
    return {
      kind: 'no-base',
      reason: 'No base benchmark suite is available yet',
    }
  }
  if (input.suiteChanged) {
    return {
      kind: 'suite-changed',
      reason: 'Benchmark definition changed; establish a new baseline',
    }
  }
  if (!input.environmentsMatch) {
    return {
      kind: 'environment-mismatch',
      reason: 'Base and head environments are incompatible',
    }
  }
  if (input.rounds < input.minimumRounds) {
    return {
      kind: 'insufficient-rounds',
      reason: `Only ${input.rounds}/${input.minimumRounds} paired rounds are available`,
    }
  }
  return undefined
}

function computeStats(paired) {
  const deltas = paired.map(({ base, head }) =>
    base.value === 0 ? 0 : ((head.value - base.value) / base.value) * 100,
  )
  const baseMargins = paired
    .map(({ base }) => base.statistics?.relativeMarginOfError)
    .filter(Number.isFinite)
  const headMargins = paired
    .map(({ head }) => head.statistics?.relativeMarginOfError)
    .filter(Number.isFinite)

  const deltaPercent = median(deltas)
  const deviationPercent = medianAbsoluteDeviation(deltas) ?? 0
  const slower = deltas.filter((delta) => delta > 0).length

  return {
    baseMedian: median(paired.map(({ base }) => base.value)),
    headMedian: median(paired.map(({ head }) => head.value)),
    deltaPercent,
    deviationPercent,
    relativeMarginOfError: Math.max(
      median(baseMargins) ?? 0,
      median(headMargins) ?? 0,
    ),
    marginsComplete:
      baseMargins.length === paired.length &&
      headMargins.length === paired.length,
    // Two thirds of the rounds must agree on the direction, and the change
    // must clear three times the paired-round spread, before it can fail.
    consistent: slower >= Math.ceil(deltas.length * (2 / 3)),
    statisticallyClear:
      deviationPercent === 0 || deltaPercent >= deviationPercent * 3,
  }
}

function classify(stats, threshold) {
  const { maximumRelativeMarginOfError: maximumMargin } = threshold
  if (
    maximumMargin !== undefined &&
    stats.relativeMarginOfError > maximumMargin
  ) {
    return {
      status: 'unstable',
      reason: `Relative margin of error ${formatPercent(stats.relativeMarginOfError)} exceeds ${formatPercent(maximumMargin)}`,
    }
  }

  if (stats.deltaPercent >= threshold.failPercent) {
    if (threshold.enforce && stats.consistent && stats.statisticallyClear) {
      return { status: 'fail' }
    }
    if (!threshold.enforce) {
      return { status: 'warn', reason: 'This category is informational' }
    }
    if (!stats.consistent) {
      return {
        status: 'warn',
        reason: 'The slowdown was not present in enough rounds',
      }
    }
    return {
      status: 'warn',
      reason: 'The paired-round spread is too wide to fail reliably',
    }
  }

  if (stats.deltaPercent >= threshold.warnPercent) return { status: 'warn' }
  return { status: 'pass' }
}

function groupReports(baseReports, headReports) {
  const suites = new Map()
  for (const [side, reports] of [
    ['base', baseReports],
    ['head', headReports],
  ]) {
    for (const report of reports) {
      validateReport(report)
      const entry = suites.get(report.suite) ?? { base: [], head: [] }
      entry[side].push(report)
      suites.set(report.suite, entry)
    }
  }
  return suites
}

function indexCases(report) {
  const cases = new Map()
  for (const benchmarkCase of report.cases) {
    if (cases.has(benchmarkCase.id)) {
      throw new Error(`Duplicate benchmark case: ${benchmarkCase.id}`)
    }
    cases.set(benchmarkCase.id, benchmarkCase)
  }
  return cases
}

function compatibleEnvironment(base, head) {
  return (
    base.environment.architecture === head.environment.architecture &&
    base.environment.cpu === head.environment.cpu &&
    base.environment.node === head.environment.node &&
    base.environment.operatingSystem === head.environment.operatingSystem &&
    base.environment.platform === head.environment.platform &&
    base.environment.pnpm === head.environment.pnpm
  )
}

function validateThresholds(thresholds) {
  if (
    thresholds.schemaVersion !== SCHEMA_VERSION ||
    !Number.isInteger(thresholds.minimumRounds) ||
    !thresholds.categories
  ) {
    throw new Error('Unsupported benchmark threshold configuration')
  }
}

function validateReport(report) {
  if (
    report.schemaVersion !== SCHEMA_VERSION ||
    typeof report.suite !== 'string' ||
    !Array.isArray(report.cases) ||
    typeof report.source?.suiteHash !== 'string'
  ) {
    throw new Error('Unsupported benchmark report')
  }
}

function countStatuses(results) {
  return results.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1
    return counts
  }, {})
}

function renderSummary(results, headReports) {
  const counts = countStatuses(results)
  const baselineInitialization =
    results.length > 0 &&
    results.every((result) => result.pendingKind === 'no-base')
  const environment = headReports[0]?.environment
  const lines = [
    baselineInitialization
      ? '# Benchmark candidate baseline'
      : '# Benchmark results',
    '',
    baselineInitialization
      ? 'No base revision is available for comparison.'
      : 'This report is informational only and does not gate pull requests.',
    '',
    environment
      ? `Environment: ${environment.platform}/${environment.architecture}, Node ${environment.node}, ${environment.cpu}.`
      : '',
    '',
    `Cases: ${Object.entries(counts)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ')}.`,
    '',
  ]

  if (baselineInitialization) {
    const measuredRounds = Math.max(...results.map((result) => result.rounds))
    lines.push(
      `This run measured the candidate ${measuredRounds} time${measuredRounds === 1 ? '' : 's'}. The values below are per-case medians; no regression decision was made.`,
      '',
    )
    appendCandidateSuites(lines, results)
    lines.push(
      'The next run whose base revision contains this benchmark system can report base/head changes and enforce thresholds.',
      '',
    )
    return `${lines.join('\n')}\n`
  }

  appendComparisonSuites(lines, results)
  return `${lines.join('\n')}\n`
}

function groupBySuite(results) {
  const order = Object.keys(SUITES)
  const grouped = Map.groupBy(results, (result) => result.suite)
  return [...grouped.keys()]
    .sort((left, right) => order.indexOf(left) - order.indexOf(right))
    .map((suite) => ({
      heading: `${SUITES[suite]?.label ?? suite} (${grouped.get(suite).length} cases)`,
      results: grouped.get(suite),
    }))
}

function appendComparisonSuites(lines, results) {
  for (const { heading, results: suiteResults } of groupBySuite(results)) {
    lines.push(
      `## ${heading}`,
      '',
      '| Status | Benchmark | Base | Head | Change | Spread | Notes |',
      '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    )
    for (const result of suiteResults) {
      const referenceValues = [result.baseMedian, result.headMedian]
      lines.push(
        `| ${statusLabel(result.status)} | ${escapeCell(result.name)} | ${formatBenchmarkValue(result.baseMedian, result.unit, referenceValues)} | ${formatBenchmarkValue(result.headMedian, result.unit, referenceValues)} | ${formatPercent(result.deltaPercent)} | ${formatPercent(result.deviationPercent)} | ${escapeCell(result.reason ?? '')} |`,
      )
    }
    lines.push('')
  }
}

function appendCandidateSuites(lines, results) {
  for (const { heading, results: suiteResults } of groupBySuite(results)) {
    lines.push(
      '<details>',
      `<summary><strong>${heading}</strong></summary>`,
      '',
      '| Benchmark | Candidate median |',
      '| --- | ---: |',
    )
    for (const result of suiteResults) {
      lines.push(
        `| ${escapeCell(result.name)} | ${formatBenchmarkValue(result.headMedian, result.unit)} |`,
      )
    }
    lines.push('', '</details>', '')
  }
}

function statusLabel(status) {
  return {
    fail: '✗ FAILED',
    pass: '✓ GOOD',
    pending: '… PENDING',
    unstable: '⚠ UNSTABLE',
    warn: '⚠ WARNING',
  }[status]
}

function formatBenchmarkValue(value, unit, referenceValues = [value]) {
  if (!Number.isFinite(value)) return '—'

  const scale = selectTimeScale(unit, referenceValues)
  const formatter = new Intl.NumberFormat('en-US', {
    maximumSignificantDigits: 4,
  })
  return `${formatter.format(value * scale.multiplier)} ${scale.unit}`
}

function selectTimeScale(unit, values) {
  if (unit !== 'ms/op') return { multiplier: 1, unit }

  const magnitude = Math.max(
    0,
    ...values.filter(Number.isFinite).map((value) => Math.abs(value)),
  )

  if (magnitude >= 1_000) return { multiplier: 1 / 1_000, unit: 's/op' }
  if (magnitude >= 1) return { multiplier: 1, unit }
  if (magnitude >= 1 / 1_000) {
    return { multiplier: 1_000, unit: 'µs/op' }
  }
  if (magnitude > 0) return { multiplier: 1_000_000, unit: 'ns/op' }
  return { multiplier: 1, unit }
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function parsePathList(value) {
  return (value ?? '')
    .split(',')
    .filter(Boolean)
    .map((path) => resolve(path))
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  const { values: args } = parseArgs({
    options: {
      base: { type: 'string' },
      enforce: { type: 'boolean' },
      head: { type: 'string' },
      output: { type: 'string' },
      summary: { type: 'string' },
      thresholds: { type: 'string' },
    },
  })
  const result = await compareReports({
    base: parsePathList(args.base),
    enforce: Boolean(args.enforce),
    head: parsePathList(args.head),
    output: args.output ? resolve(args.output) : undefined,
    summary: args.summary ? resolve(args.summary) : undefined,
    thresholds: resolve(args.thresholds || 'benchmarks/thresholds.json'),
  })
  process.stdout.write(result.summary)
  if (args.enforce && result.failed) process.exitCode = 1
}
