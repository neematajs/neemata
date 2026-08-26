#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  median,
  medianAbsoluteDeviation,
  parseArguments,
  readJson,
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

  const summary = renderSummary(results, headReports, options.enforce)
  const comparison = {
    schemaVersion: 1,
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
    const representative = headCases.find((cases) => cases.has(id))?.get(id)
    const categoryThreshold = thresholds.categories[representative.category]
    if (!categoryThreshold) {
      throw new Error(`No threshold category for ${representative.category}`)
    }

    const paired = []
    for (
      let round = 0;
      round < Math.min(baseCases.length, headCases.length);
      round++
    ) {
      const base = baseCases[round].get(id)
      const head = headCases[round].get(id)
      if (base && head) paired.push({ base, head })
    }
    const availableBaseValues = baseCases
      .map((cases) => cases.get(id)?.value)
      .filter(Number.isFinite)
    const availableHeadValues = headCases
      .map((cases) => cases.get(id)?.value)
      .filter(Number.isFinite)

    const pendingReason =
      reports.base.length === 0
        ? 'No base benchmark suite is available yet'
        : suiteChanged
          ? 'Benchmark definition changed; establish a new baseline'
          : !environmentsMatch
            ? 'Base and head environments are incompatible'
            : paired.length < thresholds.minimumRounds
              ? `Only ${paired.length}/${thresholds.minimumRounds} paired rounds are available`
              : undefined

    if (pendingReason) {
      results.push({
        baseMedian: median(availableBaseValues),
        category: representative.category,
        headMedian: median(availableHeadValues),
        id,
        name: representative.name,
        rounds: availableHeadValues.length,
        status: 'pending',
        suite,
        unit: representative.unit,
        reason: pendingReason,
      })
      continue
    }

    const baseValues = paired.map(({ base }) => base.value)
    const headValues = paired.map(({ head }) => head.value)
    const deltas = paired.map(({ base, head }) =>
      base.value === 0 ? 0 : ((head.value - base.value) / base.value) * 100,
    )
    const deltaPercent = median(deltas)
    const deviationPercent = medianAbsoluteDeviation(deltas) ?? 0
    const baseMedian = median(baseValues)
    const headMedian = median(headValues)
    const baseRelativeMargins = paired
      .map(({ base }) => base.statistics?.relativeMarginOfError)
      .filter(Number.isFinite)
    const headRelativeMargins = paired
      .map(({ head }) => head.statistics?.relativeMarginOfError)
      .filter(Number.isFinite)
    const precisionRequired =
      categoryThreshold.maximumRelativeMarginOfError !== undefined
    const precisionComplete =
      baseRelativeMargins.length === paired.length &&
      headRelativeMargins.length === paired.length
    if (precisionRequired && !precisionComplete) {
      throw new Error(
        `Benchmark ${id} is missing finite relative margin of error statistics`,
      )
    }
    const relativeMarginOfError = Math.max(
      median(baseRelativeMargins) ?? 0,
      median(headRelativeMargins) ?? 0,
    )
    const noisy =
      categoryThreshold.maximumRelativeMarginOfError !== undefined &&
      relativeMarginOfError !== undefined &&
      relativeMarginOfError > categoryThreshold.maximumRelativeMarginOfError
    const consistent =
      deltas.filter((delta) => delta > 0).length >=
      Math.ceil(deltas.length * (2 / 3))
    const statisticallyClear =
      deviationPercent === 0 || deltaPercent >= deviationPercent * 3

    let status = 'pass'
    let reason
    if (noisy) {
      status = 'unstable'
      reason = `Relative margin of error ${formatPercent(relativeMarginOfError)} exceeds ${formatPercent(categoryThreshold.maximumRelativeMarginOfError)}`
    } else if (deltaPercent >= categoryThreshold.failPercent) {
      if (categoryThreshold.enforce && consistent && statisticallyClear) {
        status = 'fail'
      } else {
        status = 'warn'
        if (!categoryThreshold.enforce)
          reason = 'This category is informational'
        else if (!consistent)
          reason = 'The slowdown was not present in enough rounds'
        else reason = 'The paired-round spread is too wide to fail reliably'
      }
    } else if (deltaPercent >= categoryThreshold.warnPercent) {
      status = 'warn'
    }

    results.push({
      baseMedian,
      category: representative.category,
      deltaPercent,
      deviationPercent,
      headMedian,
      id,
      name: representative.name,
      reason,
      relativeMarginOfError,
      rounds: paired.length,
      status,
      suite,
      unit: representative.unit,
    })
  }

  return results
}

function groupReports(baseReports, headReports) {
  const suites = new Map()
  for (const report of baseReports) {
    validateReport(report)
    const entry = suites.get(report.suite) ?? { base: [], head: [] }
    entry.base.push(report)
    suites.set(report.suite, entry)
  }
  for (const report of headReports) {
    validateReport(report)
    const entry = suites.get(report.suite) ?? { base: [], head: [] }
    entry.head.push(report)
    suites.set(report.suite, entry)
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
    thresholds.schemaVersion !== 1 ||
    !Number.isInteger(thresholds.minimumRounds) ||
    !thresholds.categories
  ) {
    throw new Error('Unsupported benchmark threshold configuration')
  }
}

function validateReport(report) {
  if (
    report.schemaVersion !== 1 ||
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

function renderSummary(results, headReports, enforce) {
  const counts = countStatuses(results)
  const baselineInitialization =
    results.length > 0 &&
    results.every(
      (result) =>
        result.status === 'pending' &&
        result.reason === 'No base benchmark suite is available yet',
    )
  const outcome = baselineInitialization
    ? 'recorded candidate measurements; no base revision is available for comparison'
    : counts.fail
      ? `failed with ${counts.fail} regression${counts.fail === 1 ? '' : 's'}`
      : 'completed without a confirmed regression'
  const environment = headReports[0]?.environment
  const lines = [
    baselineInitialization
      ? '# Benchmark candidate baseline'
      : '# Benchmark regression report',
    '',
    baselineInitialization
      ? `Benchmark run ${outcome}.`
      : `Benchmark comparison ${outcome}${enforce ? '.' : ' (shadow mode).'}`,
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

  const notable = results.filter((result) => result.status !== 'pass')
  if (notable.length === 0) {
    lines.push('All comparable benchmark cases passed.', '')
    return `${lines.join('\n')}\n`
  }

  lines.push(
    '| Status | Benchmark | Base | Head | Change | Spread | Notes |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  )
  for (const result of notable.slice(0, 50)) {
    lines.push(
      `| ${statusLabel(result.status)} | ${escapeCell(result.id)} | ${formatValue(result.baseMedian, result.unit)} | ${formatValue(result.headMedian, result.unit)} | ${formatPercent(result.deltaPercent)} | ${formatPercent(result.deviationPercent)} | ${escapeCell(result.reason ?? '')} |`,
    )
  }
  if (notable.length > 50) {
    lines.push(
      '',
      `${notable.length - 50} additional non-passing cases are in comparison.json.`,
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

function appendCandidateSuites(lines, results) {
  const suiteOrder = ['runtime', 'integration']
  const grouped = Map.groupBy(results, (result) => result.suite)
  const suites = [...grouped.keys()].sort(
    (left, right) => suiteOrder.indexOf(left) - suiteOrder.indexOf(right),
  )

  for (const suite of suites) {
    const suiteResults = grouped.get(suite)
    lines.push(
      '<details>',
      `<summary><strong>${suiteLabel(suite)} (${suiteResults.length} cases)</strong></summary>`,
      '',
      '| Benchmark | Candidate median |',
      '| --- | ---: |',
    )
    for (const result of suiteResults) {
      lines.push(
        `| ${escapeCell(result.name)} | ${formatValue(result.headMedian, result.unit)} |`,
      )
    }
    lines.push('', '</details>', '')
  }
}

function suiteLabel(suite) {
  return {
    integration: 'Integration',
    runtime: 'Runtime',
  }[suite]
}

function statusLabel(status) {
  return {
    fail: 'FAIL',
    pass: 'PASS',
    pending: 'PENDING',
    unstable: 'UNSTABLE',
    warn: 'WARN',
  }[status]
}

function formatValue(value, unit) {
  if (!Number.isFinite(value)) return '—'
  const formatted =
    Math.abs(value) >= 100
      ? value.toFixed(0)
      : Math.abs(value) >= 1
        ? value.toFixed(2)
        : value.toPrecision(4)
  return `${formatted} ${unit}`
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  const args = parseArguments(process.argv.slice(2))
  const base = String(args.base ?? '')
    .split(',')
    .filter(Boolean)
    .map((path) => resolve(path))
  const head = String(args.head ?? '')
    .split(',')
    .filter(Boolean)
    .map((path) => resolve(path))
  const result = await compareReports({
    base,
    enforce: Boolean(args.enforce),
    head,
    output: args.output ? resolve(args.output) : undefined,
    summary: args.summary ? resolve(args.summary) : undefined,
    thresholds: resolve(args.thresholds || 'benchmarks/thresholds.json'),
  })
  process.stdout.write(result.summary)
  if (args.enforce && result.failed) process.exitCode = 1
}
