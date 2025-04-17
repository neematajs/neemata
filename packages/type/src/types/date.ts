import {
  date,
  iso,
  union,
  type ZodMiniDate,
  type ZodMiniUnion,
} from '@zod/mini'
import { CustomType, TransformType } from './custom.ts'

const decode = (value: string): Date => new Date(value)
const encode = (value: Date): string => value.toISOString()

export class DateType extends TransformType<
  Date,
  ZodMiniUnion<[iso.ZodMiniISODate, iso.ZodMiniISODateTime]>
> {
  static factory() {
    return CustomType.factory<
      Date,
      ZodMiniUnion<Array<iso.ZodMiniISODate | iso.ZodMiniISODateTime>>
    >(decode, encode, union([iso.datetime(), iso.date()]))
  }
}
