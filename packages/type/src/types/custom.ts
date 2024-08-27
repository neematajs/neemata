import { type TAny, type TTransform, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class CustomType<
  T,
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TAny, T>, N, O> {
  constructor(
    protected readonly decode: (value: any) => T,
    protected readonly encode: (value: T) => any,
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(
      Type.Optional(Type.Transform(Type.Any()).Decode(decode).Encode(encode)),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new CustomType(this.decode, this.encode, ...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new CustomType(this.decode, this.encode, ...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new CustomType(this.decode, this.encode, ...args)
  }
}
