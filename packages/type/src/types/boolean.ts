import {
  type SchemaOptions,
  type StaticDecode,
  type TBoolean,
  Type,
} from '@sinclair/typebox'
import { BaseType, type ConstantType } from './base.ts'

export class BooleanType extends BaseType<TBoolean> {
  _!: ConstantType<this['schema']>

  static factory() {
    return new BooleanType(Type.Boolean())
  }
}
