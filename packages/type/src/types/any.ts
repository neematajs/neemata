import { type TAny, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class AnyType extends BaseType<TAny, {}, any> {
  static factory() {
    return new AnyType(Type.Any())
  }
}
