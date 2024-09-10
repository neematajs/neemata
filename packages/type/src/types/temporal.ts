import {
  type SchemaOptions,
  type StringOptions,
  type TString,
  type TTransform,
  Type,
} from '@sinclair/typebox'
import { Temporal } from 'temporal-polyfill'
import { BaseType } from './base.ts'

type Types = Exclude<
  keyof typeof Temporal,
  'Now' | 'Instant' | 'Calendar' | 'TimeZone'
>

type TemporalTransformer<T extends Types> = {
  decode: (value: string) => ReturnType<(typeof Temporal)[T]['from']>
  encode: (value: ReturnType<(typeof Temporal)[T]['from']>) => string
}

const createTemporalTransformer = <T extends Types>(
  type: T,
  decode = (value: string) => Temporal[type].from(value),
) => {
  const encode = (value: ReturnType<(typeof Temporal)[T]['from']>) =>
    value.toString({
      calendarName: 'never',
      smallestUnit: 'microsecond',
      timeZoneName: 'never',
    })

  return {
    decode,
    encode,
  } as TemporalTransformer<T>
}

export class PlainDateType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  TTransform<TString, Temporal.PlainDate>,
  N,
  O,
  D,
  StringOptions
> {
  static readonly transformer = createTemporalTransformer('PlainDate')

  constructor(
    options: StringOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: SchemaOptions,
  ): TTransform<TString, Temporal.PlainDate> {
    return Type.Transform(Type.String({ ...options, format: 'iso-date' }))
      .Decode(PlainDateType.transformer.decode)
      .Encode(PlainDateType.transformer.encode)
  }

  nullable() {
    return new PlainDateType(...this._with({ isNullable: true }))
  }

  optional() {
    return new PlainDateType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new PlainDateType(
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: Temporal.PlainDate) {
    return new PlainDateType(
      ...this._with({
        options: { default: PlainDateType.transformer.encode(value) },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new PlainDateType(...this._with({ options: { description } }))
  }

  examples(...examples: [Temporal.PlainDate, ...Temporal.PlainDate[]]) {
    return new PlainDateType(
      ...this._with({
        options: { examples: examples.map(PlainDateType.transformer.encode) },
      }),
    )
  }
}

export class PlainDateTimeType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  TTransform<TString, Temporal.PlainDateTime>,
  N,
  O,
  D,
  StringOptions
> {
  static readonly transformer = createTemporalTransformer('PlainDateTime')

  constructor(
    options: StringOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: SchemaOptions,
  ): TTransform<TString, Temporal.PlainDateTime> {
    return Type.Transform(Type.String({ ...options, format: 'iso-date-time' }))
      .Decode(PlainDateTimeType.transformer.decode)
      .Encode(PlainDateTimeType.transformer.encode)
  }

  nullable() {
    return new PlainDateTimeType(...this._with({ isNullable: true }))
  }

  optional() {
    return new PlainDateTimeType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new PlainDateTimeType(
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: Temporal.PlainDateTime) {
    return new PlainDateTimeType(
      ...this._with({
        options: { default: PlainDateTimeType.transformer.encode(value) },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new PlainDateTimeType(...this._with({ options: { description } }))
  }

  examples(...examples: string[]) {
    return new PlainDateTimeType(...this._with({ options: { examples } }))
  }
}

export class ZonedDateTimeType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  TTransform<TString, Temporal.ZonedDateTime>,
  N,
  O,
  D,
  StringOptions
> {
  static readonly transformer = createTemporalTransformer(
    'ZonedDateTime',
    (value) => Temporal.Instant.from(value).toZonedDateTimeISO('UTC'),
  )

  constructor(
    options: StringOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: SchemaOptions,
  ): TTransform<TString, Temporal.ZonedDateTime> {
    return Type.Transform(Type.String({ ...options, format: 'date-time' }))
      .Decode(ZonedDateTimeType.transformer.decode)
      .Encode(ZonedDateTimeType.transformer.encode)
  }

  nullable() {
    return new ZonedDateTimeType(...this._with({ isNullable: true }))
  }

  optional() {
    return new ZonedDateTimeType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new ZonedDateTimeType(
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: Temporal.ZonedDateTime) {
    return new ZonedDateTimeType(
      ...this._with({
        options: { default: ZonedDateTimeType.transformer.encode(value) },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new ZonedDateTimeType(...this._with({ options: { description } }))
  }

  examples(...examples: string[]) {
    return new ZonedDateTimeType(...this._with({ options: { examples } }))
  }
}

export class PlainTimeType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  TTransform<TString, Temporal.PlainTime>,
  N,
  O,
  D,
  StringOptions
> {
  static readonly transformer = createTemporalTransformer('PlainTime')

  constructor(
    options: StringOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: SchemaOptions,
  ): TTransform<TString, Temporal.PlainTime> {
    return Type.Transform(Type.String({ ...options, format: 'time' }))
      .Decode(PlainTimeType.transformer.decode)
      .Encode(PlainTimeType.transformer.encode)
  }

  nullable() {
    return new PlainTimeType(...this._with({ isNullable: true }))
  }

  optional() {
    return new PlainTimeType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new PlainTimeType(
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: Temporal.PlainTime) {
    return new PlainTimeType(
      ...this._with({
        options: { default: PlainTimeType.transformer.encode(value) },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new PlainTimeType(...this._with({ options: { description } }))
  }

  examples(...examples: string[]) {
    return new PlainTimeType(...this._with({ options: { examples } }))
  }
}

export class DurationType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  TTransform<TString, Temporal.Duration>,
  N,
  O,
  D,
  StringOptions
> {
  static readonly transformer = createTemporalTransformer('Duration')

  constructor(
    options: StringOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: SchemaOptions,
  ): TTransform<TString, Temporal.Duration> {
    return Type.Transform(Type.String({ ...options, format: 'duration' }))
      .Decode(DurationType.transformer.decode)
      .Encode(DurationType.transformer.encode)
  }

  nullable() {
    return new DurationType(...this._with({ isNullable: true }))
  }

  optional() {
    return new DurationType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new DurationType(
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: Temporal.Duration) {
    return new DurationType(
      ...this._with({
        options: { default: DurationType.transformer.encode(value) },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new DurationType(...this._with({ options: { description } }))
  }

  examples(...examples: string[]) {
    return new DurationType(...this._with({ options: { examples } }))
  }
}

export class PlainYearMonthType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  TTransform<TString, Temporal.PlainYearMonth>,
  N,
  O,
  D,
  StringOptions
> {
  static readonly transformer = createTemporalTransformer('PlainYearMonth')

  constructor(
    options: StringOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: SchemaOptions,
  ): TTransform<TString, Temporal.PlainYearMonth> {
    return Type.Transform(
      Type.String({
        ...options,
        // TODO: duration format, or regex?
      }),
    )
      .Decode(PlainYearMonthType.transformer.decode)
      .Encode(PlainYearMonthType.transformer.encode)
  }

  nullable() {
    return new PlainYearMonthType(...this._with({ isNullable: true }))
  }

  optional() {
    return new PlainYearMonthType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new PlainYearMonthType(
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: Temporal.PlainYearMonth) {
    return new PlainYearMonthType(
      ...this._with({
        options: { default: PlainYearMonthType.transformer.encode(value) },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new PlainYearMonthType(...this._with({ options: { description } }))
  }

  examples(...examples: string[]) {
    return new PlainYearMonthType(...this._with({ options: { examples } }))
  }
}

export class PlainMonthDayType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  TTransform<TString, Temporal.PlainMonthDay>,
  N,
  O,
  D,
  StringOptions
> {
  static readonly transformer = createTemporalTransformer('PlainMonthDay')

  constructor(
    options: StringOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: SchemaOptions,
  ): TTransform<TString, Temporal.PlainMonthDay> {
    return Type.Transform(
      Type.String({
        ...options,
        // TODO: duration format, or regex?
      }),
    )
      .Decode(PlainMonthDayType.transformer.decode)
      .Encode(PlainMonthDayType.transformer.encode)
  }

  nullable() {
    return new PlainMonthDayType(...this._with({ isNullable: true }))
  }

  optional() {
    return new PlainMonthDayType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new PlainMonthDayType(
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: Temporal.PlainMonthDay) {
    return new PlainMonthDayType(
      ...this._with({
        options: { default: PlainMonthDayType.transformer.encode(value) },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new PlainMonthDayType(...this._with({ options: { description } }))
  }

  examples(...examples: string[]) {
    return new PlainMonthDayType(...this._with({ options: { examples } }))
  }
}
