import { type TNever, Type } from '@sinclair/typebox'
import { BaseType, type ConstantType } from './base.ts'

export class NeverType extends BaseType<TNever> {
  _!: ConstantType<this['schema']>

  static factory() {
    return new NeverType(Type.Never())
  }
}
