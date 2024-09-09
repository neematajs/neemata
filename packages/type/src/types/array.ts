import { type ArrayOptions, type TArray, Type } from '@sinclair/typebox'
import type { typeStatic } from '../constants.ts'
import { BaseType, getTypeSchema } from './base.ts'

export class ArrayType<
  T extends BaseType = BaseType,
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TArray<T[typeStatic]['schema']>, N, O, D, ArrayOptions> {
  constructor(
    readonly element: T,
    options: ArrayOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault, element)
  }

  protected _constructSchema(
    options: ArrayOptions,
    element: T,
  ): TArray<T[typeStatic]['schema']> {
    return Type.Array(getTypeSchema(element), options)
  }

  nullable() {
    return new ArrayType(this.element, ...this._with({ isNullable: true }))
  }

  optional() {
    return new ArrayType(this.element, ...this._with({ isOptional: true }))
  }

  nullish() {
    return new ArrayType(
      this.element,
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: this[typeStatic]['encoded']) {
    return new ArrayType(
      this.element,
      ...this._with({
        options: { default: value },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new ArrayType(
      this.element,
      ...this._with({ options: { description } }),
    )
  }

  examples(
    ...examples: [this[typeStatic]['encoded'], ...this[typeStatic]['encoded'][]]
  ) {
    return new ArrayType(
      this.element,
      ...this._with({
        options: { example: examples[0], examples },
      }),
    )
  }

  min(value: number) {
    return new ArrayType(
      this.element,
      ...this._with({
        options: { minItems: value },
      }),
    )
  }

  max(value: number) {
    return new ArrayType(
      this.element,
      ...this._with({
        options: { maxItems: value },
      }),
    )
  }

  length(value: number) {
    return new ArrayType(
      this.element,
      ...this._with({
        options: { minItems: value, maxItems: value },
      }),
    )
  }
}
