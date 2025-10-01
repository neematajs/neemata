import * as zod from 'zod/mini'

import { CustomType, TransformType } from './custom.ts'

export class DateType extends TransformType<
  Date,
  zod.ZodMiniUnion<[zod.iso.ZodMiniISODate, zod.iso.ZodMiniISODateTime]>
> {
  static factory() {
    return CustomType.factory<
      Date,
      zod.ZodMiniUnion<[zod.iso.ZodMiniISODate, zod.iso.ZodMiniISODateTime]>
    >({
      decode: (value: string): Date => new Date(value),
      encode: (value: Date): string => value.toISOString(),
      type: zod.union([zod.iso.date(), zod.iso.datetime()]),
    })
  }
}

export const date = DateType.factory
