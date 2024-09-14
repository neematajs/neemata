import { type StringOptions, type TString, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export type AnyStringType = StringType<boolean, boolean, boolean>
export class StringType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TString, N, O, D, StringOptions> {
  constructor(
    options: StringOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(options: StringOptions): TString {
    return Type.String(options)
  }

  nullable() {
    return new StringType(...this._with({ isNullable: true }))
  }

  optional() {
    return new StringType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new StringType(...this._with({ isNullable: true, isOptional: true }))
  }

  default(value: string) {
    return new StringType(
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new StringType(...this._with({ options: { description } }))
  }

  examples(...examples: string[]) {
    return new StringType(...this._with({ options: { examples } }))
  }

  format(format: TString['format']) {
    return new StringType(...this._with({ options: { format } }))
  }

  max(value: number) {
    return new StringType(
      ...this._with({
        options: { maxLength: value },
      }),
    )
  }

  min(value: number) {
    return new StringType(
      ...this._with({
        options: { minLength: value },
      }),
    )
  }

  pattern(pattern: string) {
    return new StringType(
      ...this._with({
        options: { pattern },
      }),
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
