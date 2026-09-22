import { describe, it, beforeEach, afterEach, vi } from 'vitest'

const assert = require('node:assert')

const Registry = require('../../index').Registry

describe.each([
  ['Prometheus', Registry.PROMETHEUS_CONTENT_TYPE],
  ['OpenMetrics', Registry.OPENMETRICS_CONTENT_TYPE],
])('heapSizeAndUsed with %s registry', (tag, regType) => {
  const heapSizeAndUsed = require('../../lib/metrics/heapSizeAndUsed')
  const globalRegistry = require('../../lib/registry').globalRegistry

  beforeEach(() => {
    globalRegistry.setContentType(regType)
  })

  afterEach(() => {
    globalRegistry.clear()
  })

  it('should set gauge values from memoryUsage', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      heapTotal: 1000,
      heapUsed: 500,
      external: 100,
    })

    heapSizeAndUsed()
    // Note: these three gauges' values are set by the _total gauge's
    // "collect" function.

    const totalGauge = globalRegistry.getSingleMetric(
      'nodejs_heap_size_total_bytes',
    )
    assert.strictEqual((await totalGauge.get()).values[0].value, 1000)

    const usedGauge = globalRegistry.getSingleMetric(
      'nodejs_heap_size_used_bytes',
    )
    assert.strictEqual((await usedGauge.get()).values[0].value, 500)

    const externalGauge = globalRegistry.getSingleMetric(
      'nodejs_external_memory_bytes',
    )
    assert.strictEqual((await externalGauge.get()).values[0].value, 100)
  })
})
