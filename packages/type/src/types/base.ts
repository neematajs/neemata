import {
  type SchemaOptions,
  type StaticDecode,
  type StaticEncode,
  type TAny,
  type TOptional,
  type TSchema,
  Type,
} from '@sinclair/typebox'
import { typeSchema, typeStatic } from '../constants.ts'
import { Nullable, type TNullable } from '../schemas/nullable.ts'

type ResolveNullable<T extends TSchema, Is extends boolean> = Is extends true
  ? TNullable<T>
  : T

type ResolveOptional<T extends TSchema, Is extends boolean> = Is extends true
  ? TOptional<T>
  : T

type Resolve<
  Schema extends TSchema,
  IsNullable extends boolean,
  IsOptional extends boolean,
> = ResolveOptional<ResolveNullable<Schema, IsNullable>, IsOptional>

export abstract class BaseType<
  Schema extends TSchema = TSchema,
  IsNullable extends boolean = boolean,
  IsOptional extends boolean = boolean,
  HasDefault extends boolean = boolean,
  Options extends SchemaOptions = SchemaOptions,
> {
  protected abstract _constructSchema(
    options: Options,
    ...constructArgs: any[]
  ): Schema

  [typeStatic]!: {
    schema: Resolve<
      Schema,
      IsNullable,
      HasDefault extends true ? false : IsOptional
    >
    isOptional: IsOptional
    isNullable: IsNullable
    hasDefault: HasDefault
    encoded: StaticEncode<Resolve<Schema, IsNullable, IsOptional>>
    decoded: StaticDecode<
      Resolve<Schema, IsNullable, HasDefault extends true ? false : IsOptional>
    >
  }

  constructor(
    protected options: Options = {} as Options,
    protected isNullable: IsNullable = false as IsNullable,
    protected isOptional: IsOptional = false as IsOptional,
    protected hasDefault: HasDefault = false as HasDefault,
    ...contstructArgs: any[]
  ) {
    let schema: TSchema = this._constructSchema(options, ...contstructArgs)
    if (this.isNullable) {
      schema = Nullable(schema)
    }
    if (this.isOptional) {
      schema = Type.Optional(schema)
    }
    this[typeSchema] = schema as Schema
  }
  protected [typeSchema]: Schema

  protected get _args(): [IsNullable, IsOptional, HasDefault] {
    return [this.isNullable, this.isOptional, this.hasDefault]
  }

  protected _with<
    _IsNullable extends boolean = IsNullable,
    _IsOptional extends boolean = IsOptional,
    _HasDefault extends boolean = HasDefault,
  >({
    options = this.options as Options,
    isNullable = this.isNullable as unknown as _IsNullable,
    isOptional = this.isOptional as unknown as _IsOptional,
    hasDefault = this.hasDefault as unknown as _HasDefault,
  }: {
    options?: Options
    isNullable?: _IsNullable
    isOptional?: _IsOptional
    hasDefault?: _HasDefault
  } = {}): [Options, _IsNullable, _IsOptional, _HasDefault] {
    return [{ ...this.options, ...options }, isNullable, isOptional, hasDefault]
  }

  abstract optional(): BaseType<Schema, IsNullable, true, HasDefault>
  abstract nullish(): BaseType<Schema, true, true, HasDefault>
  abstract default(value: any): BaseType<Schema, IsNullable, IsOptional, true>
  abstract description(
    value: string,
  ): BaseType<Schema, IsNullable, IsOptional, HasDefault>
  abstract examples(
    ...values: any[]
  ): BaseType<Schema, IsNullable, IsOptional, HasDefault>
}

export function getTypeSchema<T extends BaseType>(
  type: T,
): T[typeStatic]['schema'] {
  return type[typeSchema]
}
