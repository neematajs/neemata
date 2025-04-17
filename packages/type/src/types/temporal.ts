import {
  custom,
  string,
  type ZodMiniCustom,
  type ZodMiniString,
} from '@zod/mini'
import { Temporal } from 'temporal-polyfill'
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
  type: T,
  decode = (value: string) => Temporal[type].from(value),
) => {
  const encode = (value: ReturnType<(typeof Temporal)[T]['from']>) =>
    value.toString({
      calendarName: 'never',
      smallestUnit: 'microsecond',
      timeZoneName: 'never',
    })

  return {
    decode,
    encode,
  } as TemporalTransformer<T>
}

export class PlainDateType extends TransformType<
  Temporal.PlainDate,
  ZodMiniString
> {
  static transformer = createTemporalTransformer('PlainDate')

  static factory() {
    return CustomType.factory<
      Temporal.PlainDate,
      ZodMiniString,
      ZodMiniCustom<Temporal.PlainDate, Temporal.PlainDate>
    >(
      PlainDateType.transformer.decode,
      PlainDateType.transformer.encode,
      string(),
    )
  }
}

export class PlainDateTimeType extends TransformType<
  Temporal.PlainDateTime,
  ZodMiniString
> {
  static transformer = createTemporalTransformer('PlainDateTime')

  static factory() {
    return CustomType.factory<
      Temporal.PlainDateTime,
      ZodMiniString,
      ZodMiniCustom<Temporal.PlainDateTime, Temporal.PlainDateTime>
    >(
      PlainDateTimeType.transformer.decode,
      PlainDateTimeType.transformer.encode,
      string(),
    )
  }
}

export class ZonedDateTimeType extends TransformType<
  Temporal.ZonedDateTime,
  ZodMiniString
> {
  static transformer = createTemporalTransformer('ZonedDateTime', (value) =>
    Temporal.Instant.from(value).toZonedDateTimeISO('UTC'),
  )

  static factory() {
    return CustomType.factory<
      Temporal.ZonedDateTime,
      ZodMiniString,
      ZodMiniCustom<Temporal.ZonedDateTime, Temporal.ZonedDateTime>
    >(
      ZonedDateTimeType.transformer.decode,
      ZonedDateTimeType.transformer.encode,
      string(),
    )
  }
}

export class PlainTimeType extends TransformType<
  Temporal.PlainTime,
  ZodMiniString
> {
  static transformer = createTemporalTransformer('PlainTime')

  static factory() {
    return CustomType.factory<
      Temporal.PlainTime,
      ZodMiniString,
      ZodMiniCustom<Temporal.PlainTime, Temporal.PlainTime>
    >(
      PlainTimeType.transformer.decode,
      PlainTimeType.transformer.encode,
      string(),
    )
  }
}

export class DurationType extends TransformType<
  Temporal.Duration,
  ZodMiniString
> {
  static transformer = createTemporalTransformer('Duration')

  static factory() {
    return CustomType.factory<
      Temporal.Duration,
      ZodMiniString,
      ZodMiniCustom<Temporal.Duration, Temporal.Duration>
    >(
      DurationType.transformer.decode,
      DurationType.transformer.encode,
      string(),
    )
  }
}

export class PlainYearMonthType extends TransformType<
  Temporal.PlainYearMonth,
  ZodMiniString
> {
  static transformer = createTemporalTransformer('PlainYearMonth')

  static factory() {
    return CustomType.factory<
      Temporal.PlainYearMonth,
      ZodMiniString,
      ZodMiniCustom<Temporal.PlainYearMonth, Temporal.PlainYearMonth>
    >(
      PlainYearMonthType.transformer.decode,
      PlainYearMonthType.transformer.encode,
      string(),
    )
  }
}

export class PlainMonthDayType extends TransformType<
  Temporal.PlainMonthDay,
  ZodMiniString
> {
  static transformer = createTemporalTransformer('PlainMonthDay')

  static factory() {
    return CustomType.factory<
      Temporal.PlainMonthDay,
      ZodMiniString,
      ZodMiniCustom<Temporal.PlainMonthDay, Temporal.PlainMonthDay>
    >(
      PlainMonthDayType.transformer.decode,
      PlainMonthDayType.transformer.encode,
      string(),
    )
  }
}
