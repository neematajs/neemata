import { type TBoolean, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class BooleanType extends BaseType<TBoolean, {}, boolean> {
  static factory() {
    return new BooleanType(Type.Boolean())
  }
}
