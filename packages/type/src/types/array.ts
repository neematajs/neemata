import {
  type ArrayOptions,
  type StaticDecode,
  type TArray,
  Type,
} from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class ArrayType<T extends BaseType = BaseType> extends BaseType<
  TArray<T['schema']>,
  { element: T; options: ArrayOptions }
> {
  static factory<T extends BaseType>(element: T, options: ArrayOptions = {}) {
    return new ArrayType<T>(Type.Array(element.schema, options))
  }

  min(value: number) {
    return ArrayType.factory(this.props.element, {
      ...this.props.options,
      minItems: value,
    })
  }

  max(value: number) {
    return ArrayType.factory(this.props.element, {
      ...this.props.options,
      maxItems: value,
    })
  }

  length(value: number) {
    return ArrayType.factory(this.props.element, {
      ...this.props.options,
      minItems: value,
      maxItems: value,
    })
  }
}
