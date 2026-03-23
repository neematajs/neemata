import { Temporal } from 'temporal-polyfill'
import { describe, it } from 'vitest'

import { expectDecodedExamples, temporalDecodeInputs } from './_helpers.ts'

describe('./temporal', () => {
  it('accepts an explicit Temporal implementation', async () => {
    const temporal = await import('../../src/temporal/index.ts')
    const implementation = Temporal as unknown as typeof globalThis.Temporal

    expectDecodedExamples({
      plainDate: temporal
        .plainDate(implementation)
        .decode(temporalDecodeInputs.plainDate),
      plainDatetime: temporal
        .plainDatetime(implementation)
        .decode(temporalDecodeInputs.plainDatetime),
      plainTime: temporal
        .plainTime(implementation)
        .decode(temporalDecodeInputs.plainTime),
      zonedDatetime: temporal
        .zonedDatetime(implementation)
        .decode(temporalDecodeInputs.zonedDatetime),
      instant: temporal
        .instant(implementation)
        .decode(temporalDecodeInputs.instant),
      duration: temporal
        .duration(implementation)
        .decode(temporalDecodeInputs.duration),
      plainYearMonth: temporal
        .plainYearMonth(implementation)
        .decode(temporalDecodeInputs.plainYearMonth),
      plainMonthDay: temporal
        .plainMonthDay(implementation)
        .decode(temporalDecodeInputs.plainMonthDay),
    })
  })
})
