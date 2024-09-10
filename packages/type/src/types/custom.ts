import {
  type SchemaOptions,
  type TTransform,
  type TUnsafe,
  Type,
} from '@sinclair/typebox'
import { BaseType } from './base.ts'

type CustomDecode<T> = (value: any) => T
type CustomEncode<T> = (value: T) => any

export class CustomType<
  T,
  S = T,
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TTransform<TUnsafe<S>, T>, N, O, D> {
  constructor(
    protected readonly decode: CustomDecode<T>,
    protected readonly encode: CustomEncode<T>,
    options: SchemaOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault, decode, encode)
  }

  protected _constructSchema(
    options: SchemaOptions,
    decode: CustomDecode<T>,
    encode: CustomEncode<T>,
  ): TTransform<TUnsafe<S>, T> {
    return Type.Transform(Type.Any(options) as unknown as TUnsafe<S>)
      .Decode(decode)
      .Encode(encode)
  }

  nullable() {
    return new CustomType<T, S, true, O, D>(
      this.decode,
      this.encode,
      ...this._with({ isNullable: true }),
    )
  }

  optional() {
    return new CustomType<T, S, N, true, D>(
      this.decode,
      this.encode,
      ...this._with({ isOptional: true }),
    )
  }

  nullish() {
    return new CustomType<T, S, true, true, D>(
      this.decode,
      this.encode,
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: T) {
    return new CustomType<T, S, N, O, true>(
      this.decode,
      this.encode,
      ...this._with({
        options: { default: this.encode(value) },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new CustomType<T, S, N, O, D>(
      this.decode,
      this.encode,
      ...this._with({ options: { description } }),
    )
  }

  examples(...examples: [T, ...T[]]) {
    return new CustomType<T, S, N, O, D>(
      this.decode,
      this.encode,
      ...this._with({ options: { examples: examples.map(this.encode) } }),
    )
  }
}
