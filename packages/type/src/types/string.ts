import { type TString, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class StringType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TString, N, O> {
  constructor(
    schema = Type.String(),
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(schema, nullable, optional)
  }

  nullable() {
    return new StringType(...this._nullable())
  }

  optional() {
    return new StringType(...this._optional())
  }

  nullish() {
    return new StringType(...this._nullish())
  }

  format(format: TString['format']) {
    return new StringType(
      {
        ...this._schema,
        format,
      },
      ...this._isNullableOptional,
    )
  }

  max(value: number) {
    return new StringType(
      {
        ...this._schema,
        maxLength: value,
      },
      ...this._isNullableOptional,
    )
  }

  min(value: number) {
    return new StringType(
      {
        ...this._schema,
        minLength: value,
      },
      ...this._isNullableOptional,
    )
  }

  pattern(pattern: string) {
    return new StringType(
      {
        ...this._schema,
        pattern,
      },
      ...this._isNullableOptional,
    )
  }

  email() {
    return this.format('email')
  }

  url() {
    return this.format('uri')
  }

  ipv4() {
    return this.format('ipv4')
  }

  ipv6() {
    return this.format('ipv6')
  }

  uuid() {
    return this.format('uuid')
  }
}
