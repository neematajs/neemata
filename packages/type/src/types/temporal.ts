import { type TString, type TTransform, Type } from '@sinclair/typebox'
import { Temporal } from 'temporal-polyfill'
import { BaseType } from './base.ts'

export class PlainDateType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TString, Temporal.PlainDate>, N, O> {
  constructor(nullable: N = false as N, optional: O = false as O) {
    super(
      Type.Transform(Type.String({ format: 'iso-date' }))
        .Decode((value) => Temporal.PlainDate.from(value))
        .Encode((value) => value.toString({ calendarName: 'never' })),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new PlainDateType(...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new PlainDateType(...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new PlainDateType(...args)
  }
}

export class PlainDateTimeType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TString, Temporal.PlainDateTime>, N, O> {
  constructor(nullable: N = false as N, optional: O = false as O) {
    super(
      Type.Transform(Type.String({ format: 'iso-date-time' }))
        .Decode((value) => Temporal.PlainDateTime.from(value))
        .Encode((value) => value.toString({ calendarName: 'never' })),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new PlainDateTimeType(...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new PlainDateTimeType(...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new PlainDateTimeType(...args)
  }
}

export class ZonedDateTimeType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TString, Temporal.ZonedDateTime>, N, O> {
  constructor(nullable: N = false as N, optional: O = false as O) {
    super(
      Type.Transform(Type.String({ format: 'date-time' }))
        .Decode((value) =>
          Temporal.Instant.from(value).toZonedDateTimeISO('UTC'),
        )
        .Encode((value) => value.toString({ calendarName: 'never' })),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new ZonedDateTimeType(...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new ZonedDateTimeType(...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new ZonedDateTimeType(...args)
  }
}

export class PlainTimeType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TString, Temporal.PlainTime>, N, O> {
  constructor(nullable: N = false as N, optional: O = false as O) {
    super(
      Type.Transform(Type.String({ format: 'time' }))
        .Decode((value) => Temporal.PlainTime.from(value))
        .Encode((value) => value.toString({ smallestUnit: 'microsecond' })),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new PlainTimeType(...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new PlainTimeType(...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new PlainTimeType(...args)
  }
}

export class DurationType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TString, Temporal.Duration>, N, O> {
  constructor(nullable: N = false as N, optional: O = false as O) {
    super(
      Type.Transform(
        Type.String({
          /* TODO: duration format, or regex? */
        }),
      )
        .Decode((value) => Temporal.Duration.from(value))
        .Encode((value) => value.toString({ smallestUnit: 'microsecond' })),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new DurationType(...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new DurationType(...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new DurationType(...args)
  }
}

export class PlainYearMonthType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TString, Temporal.PlainYearMonth>, N, O> {
  constructor(nullable: N = false as N, optional: O = false as O) {
    super(
      Type.Transform(
        Type.String({
          /* TODO: duration format, or regex? */
        }),
      )
        .Decode((value) => Temporal.PlainYearMonth.from(value))
        .Encode((value) => value.toString({ calendarName: 'never' })),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new PlainYearMonthType(...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new PlainYearMonthType(...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new PlainYearMonthType(...args)
  }
}

export class PlainMonthDayType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TString, Temporal.PlainMonthDay>, N, O> {
  constructor(nullable: N = false as N, optional: O = false as O) {
    super(
      Type.Transform(
        Type.String({
          /* TODO: duration format, or regex? */
        }),
      )
        .Decode((value) => Temporal.PlainMonthDay.from(value))
        .Encode((value) => value.toString({ calendarName: 'never' })),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new PlainMonthDayType(...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new PlainMonthDayType(...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new PlainMonthDayType(...args)
  }
}
