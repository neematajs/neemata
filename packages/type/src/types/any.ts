import * as zod from 'zod/v4-mini'
import { BaseType } from './base.ts'

export class AnyType extends BaseType<zod.ZodMiniAny> {
  static factory() {
    return new AnyType({
      encodedZodType: zod.any(),
    })
  }
}

export const any = AnyType.factory
