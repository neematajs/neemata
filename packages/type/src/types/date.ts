import { type TString, Type } from '@sinclair/typebox'
import { CustomType, TransformType } from './custom.ts'

const decode = (value: any): Date => new Date(value)
const encode = (value: Date): any => value.toISOString()

export class DateType extends TransformType<Date> {
  static factory() {
    return CustomType.factory<Date, TString>(
      decode,
      encode,
      Type.Union([
        Type.String({
          format: 'date',
        }),
        Type.String({
          format: 'date-time',
        }),
      ]) as unknown as TString,
    )
  }
}
