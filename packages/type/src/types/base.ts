import {
  Optional,
  type SchemaOptions,
  type StaticDecode,
  type StaticEncode,
  type TSchema,
} from '@sinclair/typebox'
import {
  Nullable,
  type TNullable,
  type TOptionalUndefined,
} from '../schemas/nullable.ts'
import type { Merge } from '../utils.ts'

export type TypeProps = Record<string, any>

export type TypeParams = {
  optional?: boolean
  nullable?: boolean
  hasDefault?: boolean
  encode?: (value: any) => any
}

export type DefaultTypeParams = {
  optional: false
  nullable: false
  hasDefault: false
  encode?: TypeParams['encode']
}

export type BaseTypeAny<T extends TSchema = TSchema> = BaseType<T, any, any>

type ResolveNullable<
  T extends TSchema,
  P extends TypeParams,
> = P['nullable'] extends true
  ? T extends TNullable<infer S>
    ? TNullable<S>
    : TNullable<T>
  : T

type ResolveOptional<
  T extends TSchema,
  P extends TypeParams,
> = P['optional'] extends true
  ? T extends TOptionalUndefined<infer S>
    ? TOptionalUndefined<S>
    : TOptionalUndefined<T>
  : T

type ResolveDefault<
  T extends TSchema,
  P extends TypeParams,
> = P['hasDefault'] extends true
  ? T extends TOptionalUndefined<infer U>
    ? U
    : T
  : T

export abstract class BaseType<
  Schema extends TSchema = TSchema,
  Props extends TypeProps = TypeProps,
  Params extends TypeParams = DefaultTypeParams,
> {
  abstract _: {
    encoded: {
      input: TSchema
      output: TSchema
    }
    decoded: {
      input: TSchema
      output: TSchema
    }
  }

  readonly schema: Schema
  readonly final: TSchema
  readonly props: Props
  readonly params: Params

  constructor(
    schema: Schema,
    props: Props = {} as Props,
    params: Params = {} as Params,
  ) {
    const { hasDefault = false, nullable = false, optional = false } = params
    this.schema = schema
    this.final = schema
    if (nullable) this.final = Nullable(this.final) as any
    if (optional || hasDefault) this.final = Optional(this.final) as any

    this.props = props
    this.params = {
      hasDefault,
      nullable,
      optional,
    } as Params
  }

  optional(): OptionalType<this> {
    return OptionalType.factory(this) as any
  }

  nullable(): NullableType<this> {
    return NullableType.factory(this) as any
  }

  nullish() {
    return this.nullable().optional()
  }

  default(
    value: StaticDecode<this['_']['decoded']['output']>,
  ): DefaultType<this> {
    return DefaultType.factory(
      this,
      this.params.encode?.(value) ?? value,
    ) as any
  }

  description(description: string): this {
    const ThisConstructor = this.constructor as any
    return new ThisConstructor(
      {
        ...this.schema,
        description,
      },
      this.props,
      this.params,
    ) as any
  }

  examples(...examples: any[]): this {
    const ThisConstructor = this.constructor as any
    return new ThisConstructor(
      {
        ...this.schema,
        examples,
      },
      this.props,
      this.params,
    ) as any
  }
}

export type ConstantType<T extends TSchema> = {
  encoded: {
    input: T
    output: T
  }
  decoded: {
    input: T
    output: T
  }
}

export type Static<
  T extends BaseTypeAny,
  P extends TypeProps,
  Params extends Merge<T['params'], P> = Merge<T['params'], P>,
> = {
  encoded: {
    input: ResolveOptional<
      ResolveNullable<T['_']['encoded']['input'], Params>,
      Params
    >
    output: ResolveDefault<
      ResolveOptional<
        ResolveNullable<T['_']['encoded']['output'], Params>,
        Params
      >,
      Params
    >
  }
  decoded: {
    input: ResolveOptional<
      ResolveNullable<T['_']['decoded']['input'], Params>,
      Params
    >
    output: ResolveDefault<
      ResolveOptional<
        ResolveNullable<T['_']['decoded']['output'], Params>,
        Params
      >,
      Params
    >
  }
}

export class OptionalType<
  Type extends BaseTypeAny<any>,
  Params extends TypeParams = DefaultTypeParams,
> extends BaseType<Type['schema'], { inner: Type }, Params> {
  _!: Static<Type, Params>

  static factory<T extends BaseTypeAny<any>>(type: T) {
    return new OptionalType<T, Merge<T['params'], { optional: true }>>(
      type.schema,
      { inner: type },
      { ...type.params, optional: true } as any,
    )
  }
}

export class NullableType<
  Type extends BaseTypeAny<any>,
  Params extends TypeParams = DefaultTypeParams,
> extends BaseType<Type['schema'], { inner: Type }, Params> {
  _!: Static<Type, Params>

  static factory<T extends BaseTypeAny<any>>(type: T) {
    return new NullableType<T, Merge<T['params'], { nullable: true }>>(
      type.schema,
      { inner: type },
      { ...type.params, nullable: true } as any,
    )
  }
}

export class DefaultType<
  Type extends BaseTypeAny<any>,
  Params extends TypeParams = DefaultTypeParams,
> extends BaseType<Type['schema'], { inner: Type }, Params> {
  _!: Static<Type, Params>

  static factory<T extends BaseTypeAny<any>>(type: T, defaultValue: any) {
    return new DefaultType<T, Merge<T['params'], { hasDefault: true }>>(
      { ...type.schema, default: defaultValue },
      { inner: type },
      { ...type.params, hasDefault: true } as any,
    )
  }
}
