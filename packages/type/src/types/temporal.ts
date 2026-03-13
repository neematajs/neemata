import type { ZodMiniString } from 'zod/mini'
import { iso, regex, string } from 'zod/mini'

import { CustomType, TransformType } from './custom.ts'

type Types = Exclude<
  keyof typeof Temporal,
  'Now' | 'Instant' | 'Calendar' | 'TimeZone'
>

type TemporalTransformer<T extends typeof Temporal, U extends Types> = {
  decode: (value: string) => InstanceType<T[U]>
  encode: (value: InstanceType<T[U]>) => string
}

const createTemporalTransformer = <T extends typeof Temporal, U extends Types>(
  implementation: T,
  type: U,
  decode = (value: string | InstanceType<T[U]>) => {
    if (typeof value === 'string') return implementation[type].from(value)
    else return value
  },
  encode = (value: ReturnType<T[U]['from']>) =>
    value.toString({
      calendarName: 'never',
      smallestUnit: 'microsecond',
      timeZoneName: 'never',
    }),
) => {
  return { decode, encode } as TemporalTransformer<T, U>
}

type EncodeType = ZodMiniString<string>

export class PlainDateType<
  T extends typeof Temporal = typeof Temporal,
> extends TransformType<InstanceType<T['PlainDate']>, EncodeType> {
  static factory<T extends typeof Temporal>(
    implementation: T,
  ): PlainDateType<T> {
    const transformer = createTemporalTransformer(implementation, 'PlainDate')
    return CustomType.factory<InstanceType<T['PlainDate']>, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.date(),
      error: 'Invalid date format',
    })
  }
}

export class PlainDateTimeType<
  T extends typeof Temporal = typeof Temporal,
> extends TransformType<InstanceType<T['PlainDateTime']>, EncodeType> {
  static factory<T extends typeof Temporal>(
    implementation: T,
  ): PlainDateTimeType<T> {
    const transformer = createTemporalTransformer(
      implementation,
      'PlainDateTime',
    )
    return CustomType.factory<InstanceType<T['PlainDateTime']>, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.datetime({ local: true }),
      error: 'Invalid datetime format',
    })
  }
}

export class ZonedDateTimeType<
  T extends typeof Temporal = typeof Temporal,
> extends TransformType<InstanceType<T['ZonedDateTime']>, EncodeType> {
  static factory<T extends typeof Temporal>(
    implementation: T,
  ): ZonedDateTimeType<T> {
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
    return CustomType.factory<InstanceType<T['ZonedDateTime']>, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.datetime(),
      error: 'Invalid datetime format',
    })
  }
}

export class PlainTimeType<
  T extends typeof Temporal = typeof Temporal,
> extends TransformType<InstanceType<T['PlainTime']>, EncodeType> {
  static factory<T extends typeof Temporal>(
    implementation: T,
  ): PlainTimeType<T> {
    const transformer = createTemporalTransformer(implementation, 'PlainTime')
    return CustomType.factory<InstanceType<T['PlainTime']>, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.time(),
      error: 'Invalid time format',
    })
  }
}

export class DurationType<
  T extends typeof Temporal = typeof Temporal,
> extends TransformType<InstanceType<T['Duration']>, EncodeType> {
  static factory<T extends typeof Temporal>(
    implementation: T,
  ): DurationType<T> {
    const transformer = createTemporalTransformer(implementation, 'Duration')
    return CustomType.factory<InstanceType<T['Duration']>, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: iso.duration(),
      error: 'Invalid duration format',
    })
  }
}

export class PlainYearMonthType<
  T extends typeof Temporal = typeof Temporal,
> extends TransformType<InstanceType<T['PlainYearMonth']>, EncodeType> {
  static factory<T extends typeof Temporal>(
    implementation: T,
  ): PlainYearMonthType<T> {
    const transformer = createTemporalTransformer(
      implementation,
      'PlainYearMonth',
    )
    return CustomType.factory<InstanceType<T['PlainYearMonth']>, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: string().check(regex(/^\d{4}-\d{2}$/)),
      error: 'Invalid year-month format',
    })
  }
}

export class PlainMonthDayType<
  T extends typeof Temporal = typeof Temporal,
> extends TransformType<InstanceType<T['PlainMonthDay']>, EncodeType> {
  static factory<T extends typeof Temporal>(
    implementation: T,
  ): PlainMonthDayType<T> {
    const transformer = createTemporalTransformer(
      implementation,
      'PlainMonthDay',
    )
    return CustomType.factory<InstanceType<T['PlainMonthDay']>, EncodeType>({
      decode: transformer.decode,
      encode: transformer.encode,
      type: string().check(regex(/^\d{2}-\d{2}$/)),
      error: 'Invalid month-day format',
    })
  }
}
