#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseArguments,
  readJson,
  writeJson,
  writeText,
} from '../benchmarks/utils.js'

const METRICS = ['lines', 'branches', 'functions', 'statements']
const MAX_FILE_ROWS = 50

export async function compareReports(options) {
  const head = await readJson(options.head)
  const base = options.base ? await readJson(options.base) : undefined
  const comparison = compareCoverage({ base, head })
  const summary = renderSummary(comparison)

  if (options.output) await writeJson(options.output, comparison)
  if (options.summary) await writeText(options.summary, summary)

  return { comparison, summary }
}

export function compareCoverage({ base, head }) {
  const packageNames = new Set(
    [base, head].flatMap((report) =>
      report ? Object.values(report.files).map((file) => file.package) : [],
    ),
  )
  const packages = [...packageNames]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      base: base && aggregate(base, (file) => file.package === name),
      head: aggregate(head, (file) => file.package === name),
    }))

  const files = []
  if (base) {
    const paths = new Set([
      ...Object.keys(base.files),
      ...Object.keys(head.files),
    ])
    for (const path of paths) {
      const baseFile = base.files[path]
      const headFile = head.files[path]
      const deltas = Object.fromEntries(
        METRICS.map((metric) => [
          metric,
          percent(headFile?.[metric]) - percent(baseFile?.[metric]),
        ]),
      )
      const changed =
        !baseFile ||
        !headFile ||
        METRICS.some((metric) => Math.abs(deltas[metric]) >= 0.01)
      if (changed) files.push({ path, base: baseFile, head: headFile })
    }
    // Largest line-coverage drops first, since those are what a reviewer acts on.
    files.sort(
      (left, right) =>
        lineDelta(left) - lineDelta(right) ||
        left.path.localeCompare(right.path),
    )
  }

  return {
    schemaVersion: 1,
    baseAvailable: Boolean(base),
    baseCommit: base?.commit,
    headCommit: head.commit,
    runs: { base: base?.runs ?? [], head: head.runs },
    packages,
    total: {
      base: base && aggregate(base, () => true),
      head: aggregate(head, () => true),
    },
    files,
  }
}

export function renderSummary(comparison) {
  const lines = [
    comparison.baseAvailable ? '# Coverage report' : '# Coverage baseline',
    '',
    comparison.baseAvailable
      ? `Base \`${shortCommit(comparison.baseCommit)}\` → head \`${shortCommit(comparison.headCommit)}\`. This report is informational only and does not gate pull requests.`
      : 'No base revision is available for comparison.',
    '',
    `Suites: ${comparison.runs.head.map((run) => `\`${run.name}\``).join(', ')}.`,
    '',
  ]

  const incomplete = ['base', 'head'].flatMap((target) =>
    comparison.runs[target]
      .filter((run) => run.status !== 'passed')
      .map(
        (run) =>
          `> ⚠ ${target} \`${run.name}\` ${runStatusLabel(run.status)}; its coverage is incomplete.`,
      ),
  )
  if (incomplete.length > 0) lines.push(...incomplete, '')

  lines.push(
    '| Package | Lines | Branches | Functions | Statements |',
    '| --- | ---: | ---: | ---: | ---: |',
  )
  for (const entry of comparison.packages) {
    lines.push(
      `| ${escapeCell(entry.name)} | ${METRICS.map((metric) => formatCell(entry, metric)).join(' | ')} |`,
    )
  }
  lines.push(
    `| **Total** | ${METRICS.map((metric) => `**${formatCell(comparison.total, metric)}**`).join(' | ')} |`,
    '',
  )

  if (comparison.baseAvailable) {
    appendFiles(lines, comparison.files)
  } else {
    lines.push(
      'The next run whose base revision contains this coverage report can show base/head changes.',
      '',
    )
  }

  return `${lines.join('\n')}\n`
}

function appendFiles(lines, files) {
  if (files.length === 0) {
    lines.push('No file changed coverage.', '')
    return
  }

  lines.push(
    '<details>',
    `<summary><strong>Files with changed coverage (${files.length})</strong></summary>`,
    '',
    '| File | Lines | Branches | Functions | Statements |',
    '| --- | ---: | ---: | ---: | ---: |',
  )
  for (const file of files.slice(0, MAX_FILE_ROWS)) {
    const label = !file.head
      ? `${file.path} (removed)`
      : !file.base
        ? `${file.path} (new)`
        : file.path
    lines.push(
      `| ${escapeCell(label)} | ${METRICS.map((metric) => formatCell(file, metric)).join(' | ')} |`,
    )
  }
  if (files.length > MAX_FILE_ROWS) {
    lines.push(
      '',
      `${files.length - MAX_FILE_ROWS} more files are listed in the comparison artifact.`,
    )
  }
  lines.push('', '</details>', '')
}

function aggregate(report, predicate) {
  const totals = Object.fromEntries(
    METRICS.map((metric) => [metric, { covered: 0, total: 0 }]),
  )
  for (const file of Object.values(report.files)) {
    if (!predicate(file)) continue
    for (const metric of METRICS) {
      totals[metric].covered += file[metric].covered
      totals[metric].total += file[metric].total
    }
  }
  return totals
}

function formatCell(entry, metric) {
  const head = entry.head?.[metric]
  const base = entry.base?.[metric]
  if (!head) return '—'
  const value = formatPercent(head)
  if (!base || !hasPercent(base) || !hasPercent(head)) return value

  const delta = percent(head) - percent(base)
  if (Math.abs(delta) < 0.01) return value
  return `${value} (${delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(2)})`
}

function lineDelta(file) {
  if (!file.head) return Number.NEGATIVE_INFINITY
  if (!file.base) return Number.POSITIVE_INFINITY
  return percent(file.head.lines) - percent(file.base.lines)
}

// Empty files count as fully covered so adding or removing one does not
// register as a drop.
function percent(counts) {
  if (!counts || counts.total === 0) return 100
  return (counts.covered / counts.total) * 100
}

function hasPercent(counts) {
  return counts.total > 0
}

function formatPercent(counts) {
  return hasPercent(counts) ? `${percent(counts).toFixed(2)}%` : '—'
}

function runStatusLabel(status) {
  return {
    failed: 'had failing tests',
    missing: 'produced no coverage',
    skipped: 'was skipped',
  }[status]
}

function shortCommit(commit) {
  return commit ? commit.slice(0, 7) : 'unknown'
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  const args = parseArguments(process.argv.slice(2))
  if (!args.head) throw new Error('--head is required')
  const result = await compareReports({
    base: args.base ? resolve(args.base) : undefined,
    head: resolve(args.head),
    output: args.output ? resolve(args.output) : undefined,
    summary: args.summary ? resolve(args.summary) : undefined,
  })
  process.stdout.write(result.summary)
}
