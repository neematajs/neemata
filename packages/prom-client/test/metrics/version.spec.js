import { describe, it, beforeEach, afterEach, beforeAll } from 'vitest'

const assert = require('node:assert')

const Registry = require('../../index').Registry
const nodeVersion = process.version
const versionSegments = nodeVersion.slice(1).split('.').map(Number)

function expectVersionMetrics(metrics) {
  assert.strictEqual(metrics.length, 1)

  assert.strictEqual(metrics[0].help, 'Node.js version info.')
  assert.strictEqual(metrics[0].type, 'gauge')
  assert.strictEqual(metrics[0].name, 'nodejs_version_info')
  assert.strictEqual(metrics[0].values[0].labels.version, nodeVersion)
  assert.strictEqual(metrics[0].values[0].labels.major, versionSegments[0])
  assert.strictEqual(metrics[0].values[0].labels.minor, versionSegments[1])
  assert.strictEqual(metrics[0].values[0].labels.patch, versionSegments[2])
}

describe.each([
  ['Prometheus', Registry.PROMETHEUS_CONTENT_TYPE],
  ['OpenMetrics', Registry.OPENMETRICS_CONTENT_TYPE],
])('version with %s registry', (tag, regType) => {
  const register = require('../../index').register
  const version = require('../../lib/metrics/version')

  beforeAll(() => {
    register.clear()
  })

  beforeEach(() => {
    register.setContentType(regType)
  })

  afterEach(() => {
    register.clear()
  })

  it(`should add metric to the ${tag} registry`, async () => {
    assert.strictEqual((await register.getMetricsAsJSON()).length, 0)
    assert.strictEqual(typeof versionSegments[0], 'number')
    assert.strictEqual(typeof versionSegments[1], 'number')
    assert.strictEqual(typeof versionSegments[2], 'number')

    version()

    const metrics = await register.getMetricsAsJSON()
    expectVersionMetrics(metrics)
  })

  it(`should still be present after resetting the ${tag} registry #238`, async () => {
    version()
    expectVersionMetrics(await register.getMetricsAsJSON())
    register.resetMetrics()
    expectVersionMetrics(await register.getMetricsAsJSON())
  })
})
