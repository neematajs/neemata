import {
  type StaticDecode,
  type StaticEncode,
  type TAny,
  type TOptional,
  type TSchema,
  Type,
} from '@sinclair/typebox'
import { Nullable, type TNullable } from '../schemas/nullable.ts'

export const typeSchema: unique symbol = Symbol()
export type typeSchema = typeof typeSchema

export const typeOptions: unique symbol = Symbol()
export type typeOptions = typeof typeOptions

export const typeOptional: unique symbol = Symbol()
export type typeOptional = typeof typeOptional

export const typeNullable: unique symbol = Symbol()
export type typeNullable = typeof typeNullable

export const staticType: unique symbol = Symbol()
export type staticType = typeof staticType

export const typeFinalSchema: unique symbol = Symbol()
export type typeFinalSchema = typeof typeFinalSchema

type ResolveNullable<T extends TSchema, Is extends boolean> = Is extends true
  ? T | TNullable<T>
  : T

type ResolveOptional<T extends TSchema, Is extends boolean> = Is extends true
  ? T | TOptional<T>
  : T

type Resolve<
  Schema extends TSchema,
  IsNullable extends boolean,
  IsOptional extends boolean,
> = ResolveOptional<ResolveNullable<Schema, IsNullable>, IsOptional>

export abstract class BaseType<
  Schema extends TSchema = any,
  IsNullable extends boolean = boolean,
  IsOptional extends boolean = boolean,
  Final extends Resolve<Schema, IsNullable, IsOptional> = Resolve<
    Schema,
    IsNullable,
    IsOptional
  >,
> {
  [typeSchema]: Schema;
  [typeNullable]: IsNullable;
  [typeOptional]: IsOptional;

  [staticType]!: {
    final: Final
    isOptional: IsOptional
    isNullable: IsNullable
    encoded: StaticEncode<Final>
    decoded: StaticDecode<Final>
  }

  constructor(
    schema: Schema,
    nullable: IsNullable = false as IsNullable,
    optional: IsOptional = false as IsOptional,
  ) {
    this[typeSchema] = schema
    this[typeNullable] = nullable
    this[typeOptional] = optional
  }

  get [typeFinalSchema](): Final {
    let schema: TSchema = this._schema
    if (this._isNullable) {
      schema = Nullable(schema)
    }
    if (this._isOptional) {
      schema = Type.Optional(schema)
    }
    return schema as Final
  }

  protected get _schema() {
    return this[typeSchema]
  }

  protected get _isNullable(): IsNullable {
    return this[typeNullable]
  }

  protected get _isOptional(): IsOptional {
    return this[typeOptional]
  }

  protected get _isNullableOptional(): [IsNullable, IsOptional] {
    return [this._isNullable, this._isOptional]
  }

  protected _contructSelf<T extends any[]>(...args: T) {
    return args
  }

  protected _nullable() {
    return this._contructSelf(this._schema, true as const, this[typeOptional])
  }

  protected _optional() {
    return this._contructSelf(this._schema, this[typeNullable], true as const)
  }

  protected _nullish() {
    return this._contructSelf(this._schema, true as const, true as const)
  }

  abstract nullable(): BaseType<Schema, true, IsOptional>
  abstract optional(): BaseType<Schema, IsNullable, true>
  abstract nullish(): BaseType<Schema, true, true>

  default(value: StaticDecode<Schema>): this {
    return this._contructSelf(
      {
        ...this._schema,
        default: value,
      },
      this[typeNullable],
      this[typeOptional],
    ) as unknown as this
  }

  description(description: string): this {
    return this._contructSelf(
      {
        ...this._schema,
        description,
      },
      this[typeNullable],
      this[typeOptional],
    ) as unknown as this
  }

  examples(...examples: StaticDecode<Schema>[]): this {
    return this._contructSelf(
      {
        ...this._schema,
        examples,
      },
      this[typeNullable],
      this[typeOptional],
    ) as unknown as this
  }
}

export function getTypeSchema<T extends BaseType>(type: T): T[typeFinalSchema] {
  return type[typeFinalSchema]
}
