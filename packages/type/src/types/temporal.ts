import type { Temporal } from 'temporal-spec'
import type { ZodMiniString } from 'zod/mini'
import { iso, regex, string } from 'zod/mini'

import { CustomType, TransformType } from './custom.ts'

type Types = Exclude<
  keyof typeof Temporal,
  'Now' | 'Instant' | 'Calendar' | 'TimeZone'
>

type TemporalTransformer<T extends Types> = {
  decode: (value: string) => ReturnType<(typeof Temporal)[T]['from']>
  encode: (value: ReturnType<(typeof Temporal)[T]['from']>) => string
}

const createTemporalTransformer = <T extends Types>(
  implementation: typeof Temporal,
  type: T,
  decode = (value: string) => implementation[type].from(value),
  encode = (value: ReturnType<(typeof Temporal)[T]['from']>) =>
    value.toString({
      calendarName: 'never',
      smallestUnit: 'microsecond',
      timeZoneName: 'never',
    }),
) => {
  return { decode, encode } as TemporalTransformer<T>
}

type EncodeType = ZodMiniString<string>

export class PlainDateType extends TransformType<
  Temporal.PlainDate,
  EncodeType
> {
  static factory(implementation: typeof Temporal) {
    const transformer = createTemporalTransformer(implementation, 'PlainDate')
    return CustomType.factory<Temporal.PlainDate, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.date(),
      error: 'Invalid date format',
    })
  }
}

export class PlainDateTimeType extends TransformType<
  Temporal.PlainDateTime,
  EncodeType
> {
  static factory(implementation: typeof Temporal) {
    const transformer = createTemporalTransformer(
      implementation,
      'PlainDateTime',
    )
    return CustomType.factory<Temporal.PlainDateTime, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.datetime({ local: true }),
      error: 'Invalid datetime format',
    })
  }
}

export class ZonedDateTimeType extends TransformType<
  Temporal.ZonedDateTime,
  EncodeType
> {
  static factory(implementation: typeof Temporal) {
    const transformer = createTemporalTransformer(
      implementation,
      'ZonedDateTime',
      (value) => implementation.Instant.from(value).toZonedDateTimeISO('UTC'),
      (value) =>
        value
          .withTimeZone('UTC')
          .toString({
            smallestUnit: 'milliseconds',
            timeZoneName: 'never',
            calendarName: 'never',
            offset: 'never',
          }) + 'Z',
    )
    return CustomType.factory<Temporal.ZonedDateTime, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.datetime(),
      error: 'Invalid datetime format',
    })
  }
}

export class PlainTimeType extends TransformType<
  Temporal.PlainTime,
  EncodeType
> {
  static factory(implementation: typeof Temporal) {
    const transformer = createTemporalTransformer(implementation, 'PlainTime')
    return CustomType.factory<Temporal.PlainTime, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.time(),
      error: 'Invalid time format',
    })
  }
}

export class DurationType extends TransformType<Temporal.Duration, EncodeType> {
  static factory(implementation: typeof Temporal) {
    const transformer = createTemporalTransformer(implementation, 'Duration')
    return CustomType.factory<Temporal.Duration, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.duration(),
      error: 'Invalid duration format',
    })
  }
}

export class PlainYearMonthType extends TransformType<
  Temporal.PlainYearMonth,
  EncodeType
> {
  static factory(implementation: typeof Temporal) {
    const transformer = createTemporalTransformer(
      implementation,
      'PlainYearMonth',
    )
    return CustomType.factory<Temporal.PlainYearMonth, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: string().check(regex(/^\d{4}-\d{2}$/)),
      error: 'Invalid year-month format',
    })
  }
}

export class PlainMonthDayType extends TransformType<
  Temporal.PlainMonthDay,
  EncodeType
> {
  static factory(implementation: typeof Temporal) {
    const transformer = createTemporalTransformer(
      implementation,
      'PlainMonthDay',
    )
    return CustomType.factory<Temporal.PlainMonthDay, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: string().check(regex(/^\d{2}-\d{2}$/)),
      error: 'Invalid month-day format',
    })
  }
}
