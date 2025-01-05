import { type TString, Type } from '@sinclair/typebox'
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

export class PlainDateType extends TransformType<Temporal.PlainDate, TString> {
  static readonly transformer = createTemporalTransformer('PlainDate')

  static factory() {
    return CustomType.factory(
      PlainDateType.transformer.decode,
      PlainDateType.transformer.encode,
      Type.String(),
    )
  }
}

export class PlainDateTimeType extends TransformType<
  Temporal.PlainDateTime,
  TString
> {
  static readonly transformer = createTemporalTransformer('PlainDateTime')
  protected _encode = PlainDateTimeType.transformer.encode

  static factory() {
    return CustomType.factory(
      PlainDateTimeType.transformer.decode,
      PlainDateTimeType.transformer.encode,
      Type.String(),
    )
  }
}

export class ZonedDateTimeType extends TransformType<
  Temporal.ZonedDateTime,
  TString
> {
  static readonly transformer = createTemporalTransformer(
    'ZonedDateTime',
    (value) => Temporal.Instant.from(value).toZonedDateTimeISO('UTC'),
  )

  static factory() {
    return CustomType.factory(
      ZonedDateTimeType.transformer.decode,
      ZonedDateTimeType.transformer.encode,
      Type.String(),
    )
  }
}

export class PlainTimeType extends TransformType<Temporal.PlainTime, TString> {
  static readonly transformer = createTemporalTransformer('PlainTime')

  static factory() {
    return CustomType.factory(
      PlainTimeType.transformer.decode,
      PlainTimeType.transformer.encode,
      Type.String(),
    )
  }
}

export class DurationType extends TransformType<Temporal.Duration, TString> {
  static readonly transformer = createTemporalTransformer('Duration')

  static factory() {
    return CustomType.factory(
      DurationType.transformer.decode,
      DurationType.transformer.encode,
      Type.String(),
    )
  }
}

export class PlainYearMonthType extends TransformType<
  Temporal.PlainYearMonth,
  TString
> {
  static readonly transformer = createTemporalTransformer('PlainYearMonth')

  static factory() {
    return CustomType.factory(
      PlainYearMonthType.transformer.decode,
      PlainYearMonthType.transformer.encode,
      Type.String(),
    )
  }
}

export class PlainMonthDayType extends TransformType<
  Temporal.PlainMonthDay,
  TString
> {
  static readonly transformer = createTemporalTransformer('PlainMonthDay')

  static factory() {
    return CustomType.factory(
      PlainMonthDayType.transformer.decode,
      PlainMonthDayType.transformer.encode,
      Type.String(),
    )
  }
}
