import { describe, expect, it } from 'vitest'

import { tryCaptureStackTrace } from '../src/utils.ts'

describe('tryCaptureStackTrace', () => {
  it('should capture the direct caller location', () => {
    const trace = tryCaptureStackTrace()
    expect(trace).toContain('utils.spec.ts')
    expect(trace).toMatch(/:\d+:\d+$/)
  })

  it('should attribute to the anchor caller instead of the anchor itself', () => {
    function wrapper() {
      return tryCaptureStackTrace(wrapper)
    }
    function nested() {
      return wrapper()
    }
    const direct = (() => tryCaptureStackTrace())()
    const anchored = nested()
    // both captured in this file, but the anchored one skips the wrapper
    expect(anchored).toContain('utils.spec.ts')
    expect(direct).toContain('utils.spec.ts')
    expect(anchored).not.toBe(direct)
  })
})
