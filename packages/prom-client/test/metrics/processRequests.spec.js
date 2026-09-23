import { describe, it, beforeEach, afterEach, beforeAll } from 'vitest'

const assert = require('node:assert')

const Registry = require('../../index').Registry

describe.each([
  ['Prometheus', Registry.PROMETHEUS_CONTENT_TYPE],
  ['OpenMetrics', Registry.OPENMETRICS_CONTENT_TYPE],
])('processRequests with %s registry', (tag, regType) => {
  const register = require('../../index').register
  const processRequests = require('../../lib/metrics/processRequests')

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

    processRequests()

    const metrics = await register.getMetricsAsJSON()

    assert.strictEqual(metrics.length, 2)
    assert.strictEqual(
      metrics[0].help,
      'Number of active libuv requests grouped by request type. Every request type is C++ class name.',
    )
    assert.strictEqual(metrics[0].type, 'gauge')
    assert.strictEqual(metrics[0].name, 'nodejs_active_requests')

    assert.strictEqual(metrics[1].help, 'Total number of active requests.')
    assert.strictEqual(metrics[1].type, 'gauge')
    assert.strictEqual(metrics[1].name, 'nodejs_active_requests_total')
  })
})
