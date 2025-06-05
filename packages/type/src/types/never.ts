import * as zod from 'zod/v4-mini'
import { BaseType } from './base.ts'

export class NeverType extends BaseType<zod.ZodMiniNever> {
  static factory() {
    return new NeverType({
      encodedZodType: zod.never(),
    })
  }
}

export const never = NeverType.factory
