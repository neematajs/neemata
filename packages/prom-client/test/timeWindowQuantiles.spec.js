import { describe, it, beforeEach, afterEach, vi } from 'vitest'

const assert = require('node:assert')

describe('timeWindowQuantiles', () => {
  const TimeWindowQuantiles = require('../lib/timeWindowQuantiles')
  let instance

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'hrtime'] })
    vi.setSystemTime(0)
    instance = new TimeWindowQuantiles(5, 5)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('methods', () => {
    it('#push', () => {
      instance.push(1)
      instance.ringBuffer.forEach((td) => {
        assert.strictEqual(td.centroids.size, 1)
      })
    })

    it('#reset', () => {
      instance.push(1)
      instance.reset()
      instance.ringBuffer.forEach((td) => {
        assert.strictEqual(td.centroids.size, 0)
      })
    })

    it('#compress', () => {
      instance.push(1)
      instance.compress()
      instance.ringBuffer.forEach((td) => {
        assert.strictEqual(td.centroids.size, 1)
      })
    })

    it('#percentile', () => {
      instance.push(1)
      assert.strictEqual(instance.percentile(0.5), 1)
    })
  })

  describe('rotation', () => {
    it('rotatation interval should be configured', () => {
      let localInstance = new TimeWindowQuantiles(undefined, undefined)
      assert.strictEqual(localInstance.durationBetweenRotatesMillis, Infinity)
      localInstance = new TimeWindowQuantiles(1, 1)
      assert.strictEqual(localInstance.durationBetweenRotatesMillis, 1000)
      localInstance = new TimeWindowQuantiles(10, 5)
      assert.strictEqual(localInstance.durationBetweenRotatesMillis, 2000)
    })

    it('should rotate', () => {
      instance.push(1)
      assert.strictEqual(instance.currentBuffer, 0)
      vi.advanceTimersByTime(1001)
      instance.percentile(0.5)
      assert.strictEqual(instance.currentBuffer, 1)
      vi.advanceTimersByTime(1001)
      instance.percentile(0.5)
      assert.strictEqual(instance.currentBuffer, 2)
      vi.advanceTimersByTime(1001)
      instance.percentile(0.5)
      assert.strictEqual(instance.currentBuffer, 3)
      vi.advanceTimersByTime(1001)
      instance.percentile(0.5)
      assert.strictEqual(instance.currentBuffer, 4)
      vi.advanceTimersByTime(1001)
      instance.percentile(0.5)
      assert.strictEqual(instance.currentBuffer, 0)

      instance.ringBuffer.forEach((td) => {
        assert.strictEqual(td.centroids.size, 0)
      })
    })
  })
})
