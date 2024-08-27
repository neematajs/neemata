import { type ArrayOptions, type TArray, Type } from '@sinclair/typebox'
import { BaseType, typeFinalSchema } from './base.ts'

export class ArrayType<
  T extends BaseType = BaseType,
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TArray<T[typeFinalSchema]>, N, O> {
  constructor(
    readonly element: T,
    readonly options: ArrayOptions = {},
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(Type.Array(element[typeFinalSchema]), nullable, optional)
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new ArrayType(this.element, this.options, ...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new ArrayType(this.element, this.options, ...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new ArrayType(this.element, this.options, ...args)
  }

  min(value: number) {
    return new ArrayType(
      this.element,
      {
        ...this.options,
        minItems: value,
      },
      ...this._isNullableOptional,
    )
  }

  max(value: number) {
    return new ArrayType(
      this.element,
      {
        ...this.options,
        maxItems: value,
      },
      ...this._isNullableOptional,
    )
  }

  length(value: number) {
    return new ArrayType(
      this.element,
      {
        ...this.options,
        minItems: value,
        maxItems: value,
      },
      ...this._isNullableOptional,
    )
  }
}
