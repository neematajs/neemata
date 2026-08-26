import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, test } from 'node:test'

import { compareReports } from './compare.js'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

void test('passes stable paired benchmark results', async () => {
  const result = await compareScenario({
    base: [100, 100, 100],
    head: [104, 103, 105],
  })

  assert.equal(result.failed, false)
  assert.equal(result.comparison.results[0].status, 'pass')
})

void test('fails a consistent regression above the enforced threshold', async () => {
  const result = await compareScenario({
    base: [100, 100, 100],
    head: [120, 121, 119],
  })

  assert.equal(result.failed, true)
  assert.equal(result.comparison.results[0].status, 'fail')
})

void test('warns instead of failing when paired-round spread is too wide', async () => {
  const result = await compareScenario({
    base: [100, 100, 100],
    head: [101, 120, 139],
  })

  assert.equal(result.failed, false)
  assert.equal(result.comparison.results[0].status, 'warn')
  assert.match(result.comparison.results[0].reason, /spread is too wide/)
})

void test('marks changed benchmark definitions as baseline pending', async () => {
  const result = await compareScenario({
    base: [100, 100, 100],
    head: [200, 200, 200],
    headSuiteHash: 'changed-suite',
  })

  assert.equal(result.failed, false)
  assert.equal(result.comparison.results[0].status, 'pending')
  assert.equal(result.comparison.results[0].baseMedian, 100)
  assert.equal(result.comparison.results[0].headMedian, 200)
  assert.match(result.comparison.results[0].reason, /definition changed/)
})

void test('shows candidate medians when no base suite exists', async () => {
  const result = await compareScenario({
    base: [],
    head: [101, 103, 102],
  })

  assert.equal(result.failed, false)
  assert.equal(result.comparison.results[0].status, 'pending')
  assert.equal(result.comparison.results[0].baseMedian, undefined)
  assert.equal(result.comparison.results[0].headMedian, 102)
  assert.match(result.summary, /Benchmark candidate baseline/)
  assert.match(result.summary, /Runtime \(1 cases\)/)
  assert.match(result.summary, /\| case \| 102 ms\/op \|/)
  assert.doesNotMatch(result.summary, /without a confirmed regression/)
})

void test('marks imprecise runtime measurements as unstable', async () => {
  const result = await compareScenario({
    base: [100, 100, 100],
    head: [120, 120, 120],
    relativeMarginOfError: 7,
  })

  assert.equal(result.failed, false)
  assert.equal(result.comparison.results[0].status, 'unstable')
})

void test('rejects runtime reports without precision statistics', async () => {
  await assert.rejects(
    compareScenario({
      base: [100, 100, 100],
      head: [120, 120, 120],
      omitRelativeMarginOfError: true,
    }),
    /missing finite relative margin of error statistics/,
  )
})

async function compareScenario(options) {
  const directory = await mkdtemp(resolve(tmpdir(), 'neemata-benchmark-'))
  temporaryDirectories.push(directory)
  const thresholds = resolve(directory, 'thresholds.json')
  await writeJson(thresholds, {
    schemaVersion: 1,
    minimumRounds: 3,
    categories: {
      runtime: {
        warnPercent: 8,
        failPercent: 15,
        maximumRelativeMarginOfError: 5,
        enforce: true,
      },
    },
  })

  const base = await Promise.all(
    options.base.map((value, index) =>
      writeReport(directory, `base-${index}`, value, {
        relativeMarginOfError: 1,
        suiteHash: 'stable-suite',
      }),
    ),
  )
  const head = await Promise.all(
    options.head.map((value, index) =>
      writeReport(directory, `head-${index}`, value, {
        relativeMarginOfError: options.omitRelativeMarginOfError
          ? undefined
          : (options.relativeMarginOfError ?? 1),
        suiteHash: options.headSuiteHash ?? 'stable-suite',
      }),
    ),
  )

  return await compareReports({
    base,
    enforce: true,
    head,
    thresholds,
  })
}

async function writeReport(directory, name, value, options) {
  const path = resolve(directory, `${name}.json`)
  await writeJson(path, {
    schemaVersion: 1,
    suite: 'runtime',
    environment: {
      architecture: 'x64',
      cpu: 'benchmark-cpu',
      node: 'v24.16.0',
      operatingSystem: 'linux benchmark',
      platform: 'linux',
      pnpm: '11.5.1',
    },
    source: { commit: name, suiteHash: options.suiteHash },
    cases: [
      {
        category: 'runtime',
        id: 'runtime > case',
        name: 'case',
        statistics: {
          relativeMarginOfError: options.relativeMarginOfError,
        },
        unit: 'ms/op',
        value,
      },
    ],
  })
  return path
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`)
}
