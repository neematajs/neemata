import { type TNever, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class NeverType extends BaseType<TNever, {}, never> {
  static factory() {
    return new NeverType(Type.Never())
  }
}
