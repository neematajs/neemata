import { afterEach, describe, it, vi } from 'vitest'

import { expectDecodedExamples, temporalDecodeInputs } from './_helpers.ts'

describe.sequential('./temporal/polyfill', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('uses the imported polyfill implementation', async () => {
    vi.stubGlobal('Temporal', undefined)

    const temporalPolyfill = await import('../../src/temporal/polyfill.ts')

    expectDecodedExamples({
      plainDate: temporalPolyfill
        .plainDate()
        .decode(temporalDecodeInputs.plainDate),
      plainDatetime: temporalPolyfill
        .plainDatetime()
        .decode(temporalDecodeInputs.plainDatetime),
      plainTime: temporalPolyfill
        .plainTime()
        .decode(temporalDecodeInputs.plainTime),
      zonedDatetime: temporalPolyfill
        .zonedDatetime()
        .decode(temporalDecodeInputs.zonedDatetime),
      instant: temporalPolyfill.instant().decode(temporalDecodeInputs.instant),
      duration: temporalPolyfill
        .duration()
        .decode(temporalDecodeInputs.duration),
      plainYearMonth: temporalPolyfill
        .plainYearMonth()
        .decode(temporalDecodeInputs.plainYearMonth),
      plainMonthDay: temporalPolyfill
        .plainMonthDay()
        .decode(temporalDecodeInputs.plainMonthDay),
    })
  })
})
