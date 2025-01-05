import { type TAny, Type } from '@sinclair/typebox'
import { BaseType, type ConstantType } from './base.ts'

export class AnyType extends BaseType<TAny> {
  _!: ConstantType<this['schema']>

  static factory() {
    return new AnyType(Type.Any())
  }
}
