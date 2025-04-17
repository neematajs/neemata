import { boolean, type ZodMiniBoolean } from '@zod/mini'
import { BaseType } from './base.ts'

export class BooleanType extends BaseType<ZodMiniBoolean<boolean>> {
  static factory() {
    return new BooleanType({
      encodedZodType: boolean(),
    })
  }
}
