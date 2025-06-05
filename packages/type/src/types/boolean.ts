import * as zod from 'zod/v4-mini'
import { BaseType } from './base.ts'

export class BooleanType extends BaseType<zod.ZodMiniBoolean<boolean>> {
  static factory() {
    return new BooleanType({
      encodedZodType: zod.boolean(),
    })
  }
}

export const boolean = BooleanType.factory
