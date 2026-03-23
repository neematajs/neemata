import { Temporal } from 'temporal-polyfill'
import { expect } from 'vitest'

export const temporalDecodeInputs = {
  plainDate: '2021-01-01',
  plainDatetime: '2021-01-01T12:30:45.123',
  plainTime: '12:30:45.123',
  zonedDatetime: '2021-01-01T12:30:45.123+00:00[UTC]',
  instant: '2021-01-01T12:30:45.123Z',
  duration: 'PT1H30M',
  plainYearMonth: '2021-01',
  plainMonthDay: '01-15',
} as const

export function expectDecodedExamples(decoded: {
  plainDate: unknown
  plainDatetime: unknown
  plainTime: unknown
  zonedDatetime: unknown
  instant: unknown
  duration: unknown
  plainYearMonth: unknown
  plainMonthDay: unknown
}) {
  expect(decoded.plainDate).toBeInstanceOf(Temporal.PlainDate)
  expect(decoded.plainDatetime).toBeInstanceOf(Temporal.PlainDateTime)
  expect(decoded.plainTime).toBeInstanceOf(Temporal.PlainTime)
  expect(decoded.zonedDatetime).toBeInstanceOf(Temporal.ZonedDateTime)
  expect(decoded.instant).toBeInstanceOf(Temporal.Instant)
  expect(decoded.duration).toBeInstanceOf(Temporal.Duration)
  expect(decoded.plainYearMonth).toBeInstanceOf(Temporal.PlainYearMonth)
  expect(decoded.plainMonthDay).toBeInstanceOf(Temporal.PlainMonthDay)
}
