import { type TString, type TTransform, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class DateType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TString, Date>, N, O> {
  constructor(
    schema: TTransform<TString, Date> = Type.Transform(
      Type.String({ format: 'date' }),
    )
      .Decode((value) => new Date(value))
      .Encode((value) => value.toJSON()),
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(schema, nullable, optional)
  }

  nullable() {
    return new DateType(...this._nullable())
  }

  optional() {
    return new DateType(...this._optional())
  }

  nullish() {
    return new DateType(...this._nullish())
  }
}

export class DateTimeType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TString, Date>, N, O> {
  constructor(
    schema: TTransform<TString, Date> = Type.Transform(
      Type.String({ format: 'date-time' }),
    )
      .Decode((value) => new Date(value))
      .Encode((value) => value.toJSON()),
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(schema, nullable, optional)
  }

  nullable() {
    return new DateTimeType(...this._nullable())
  }

  optional() {
    return new DateTimeType(...this._optional())
  }

  nullish() {
    return new DateTimeType(...this._nullish())
  }
}
