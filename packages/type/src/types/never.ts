import { never, type ZodMiniNever } from '@zod/mini'
import { BaseType } from './base.ts'

export class NeverType extends BaseType<ZodMiniNever> {
  static factory() {
    return new NeverType({
      encodedZodType: never(),
    })
  }
}
