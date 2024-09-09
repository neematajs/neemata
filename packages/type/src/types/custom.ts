import { type TTransform, type TUnsafe, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class CustomType<
  T,
  S = T,
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TTransform<TUnsafe<S>, T>, N, O> {
  constructor(
    protected readonly decode: (value: any) => T,
    protected readonly encode: (value: T) => any,
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(
      Type.Optional(
        Type.Transform(Type.Any() as unknown as TUnsafe<S>)
          .Decode(decode)
          .Encode(encode),
      ),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new CustomType<T, S, (typeof args)[0], (typeof args)[1]>(
      this.decode,
      this.encode,
      ...args,
    )
  }

  optional() {
    const [_, ...args] = this._optional()
    return new CustomType<T, S, (typeof args)[0], (typeof args)[1]>(
      this.decode,
      this.encode,
      ...args,
    )
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new CustomType<T, S, (typeof args)[0], (typeof args)[1]>(
      this.decode,
      this.encode,
      ...args,
    )
  }
}
