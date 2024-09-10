import {
  type SchemaOptions,
  type StringOptions,
  type TString,
  type TTransform,
  Type,
} from '@sinclair/typebox'
import { BaseType } from './base.ts'

const decode = (value: any): Date => new Date(value)
const encode = (value: Date): any => value.toISOString()

export class DateType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TTransform<TString, Date>, N, O, D, StringOptions> {
  constructor(
    options: SchemaOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: StringOptions,
  ): TTransform<TString, Date> {
    return Type.Transform(Type.String({ ...options, format: 'date-time' }))
      .Decode(decode)
      .Encode(encode)
  }

  nullable() {
    return new DateType(...this._with({ isNullable: true }))
  }

  optional() {
    return new DateType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new DateType(...this._with({ isNullable: true, isOptional: true }))
  }

  default(value: Date) {
    return new DateType(
      ...this._with({
        options: { default: encode(value) },
        hasDefault: true,
      }),
    )
  }

  description(value: string) {
    return new DateType(...this._with({ options: { description: value } }))
  }

  examples(...values: [Date, ...Date[]]) {
    return new DateType(
      ...this._with({ options: { examples: values.map(encode) } }),
    )
  }
}
