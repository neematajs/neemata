import { iso, union, type ZodMiniUnion } from '@zod/mini'
import { CustomType, TransformType } from './custom.ts'

export class DateType extends TransformType<
  Date,
  ZodMiniUnion<[iso.ZodMiniISODate, iso.ZodMiniISODateTime]>
> {
  static factory() {
    return CustomType.factory<
      Date,
      ZodMiniUnion<Array<iso.ZodMiniISODate | iso.ZodMiniISODateTime>>
    >({
      decode: (value: string): Date => new Date(value),
      encode: (value: Date): string => value.toISOString(),
      type: union([iso.datetime(), iso.date()]),
    })
  }
}
