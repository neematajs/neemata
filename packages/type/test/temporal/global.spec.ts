import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, it, vi } from 'vitest'

import { expectDecodedExamples, temporalDecodeInputs } from './_helpers.ts'

describe.sequential('./temporal/global', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('uses globalThis.Temporal', async () => {
    vi.stubGlobal('Temporal', Temporal)

    const temporalGlobal = await import('../../src/temporal/global.ts')

    expectDecodedExamples({
      plainDate: temporalGlobal
        .plainDate()
        .decode(temporalDecodeInputs.plainDate),
      plainDatetime: temporalGlobal
        .plainDatetime()
        .decode(temporalDecodeInputs.plainDatetime),
      plainTime: temporalGlobal
        .plainTime()
        .decode(temporalDecodeInputs.plainTime),
      zonedDatetime: temporalGlobal
        .zonedDatetime()
        .decode(temporalDecodeInputs.zonedDatetime),
      instant: temporalGlobal.instant().decode(temporalDecodeInputs.instant),
      duration: temporalGlobal.duration().decode(temporalDecodeInputs.duration),
      plainYearMonth: temporalGlobal
        .plainYearMonth()
        .decode(temporalDecodeInputs.plainYearMonth),
      plainMonthDay: temporalGlobal
        .plainMonthDay()
        .decode(temporalDecodeInputs.plainMonthDay),
    })
  })
})
