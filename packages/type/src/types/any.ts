import { any, type ZodMiniAny } from '@zod/mini'
import { BaseType } from './base.ts'

export class AnyType extends BaseType<ZodMiniAny> {
  static factory() {
    return new AnyType({
      encodedZodType: any(),
    })
  }
}
