import { describe, it, beforeEach, afterEach, beforeAll } from 'vitest'

const assert = require('node:assert')

const Registry = require('../../index').Registry

describe.each([
  ['Prometheus', Registry.PROMETHEUS_CONTENT_TYPE],
  ['OpenMetrics', Registry.OPENMETRICS_CONTENT_TYPE],
])('gc with %s registry', (tag, regType) => {
  const register = require('../../index').register
  const processHandles = require('../../lib/metrics/gc')

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

    processHandles()

    const metrics = await register.getMetricsAsJSON()

    // Check if perf_hooks module is available
    let perf_hooks
    try {
      perf_hooks = require('node:perf_hooks')
    } catch {
      // node version is too old
    }

    if (perf_hooks) {
      assert.strictEqual(metrics.length, 1)

      assert.strictEqual(
        metrics[0].help,
        'Garbage collection duration by kind, one of major, minor, incremental or weakcb.',
      )
      assert.strictEqual(metrics[0].type, 'histogram')
      assert.strictEqual(metrics[0].name, 'nodejs_gc_duration_seconds')
    } else {
      assert.strictEqual(metrics.length, 0)
    }
  })
})
