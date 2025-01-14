import { Optional, type TOptional, type TSchema } from '@sinclair/typebox'
import { Default, type TDefault } from '../schemas/default.ts'
import { Nullable, type TNullable } from '../schemas/nullable.ts'

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

export type BaseTypeAny<T extends TSchema = TSchema> = BaseType<
  T,
  TypeProps,
  any
>

export abstract class BaseType<
  Schema extends TSchema = TSchema,
  Props extends TypeProps = TypeProps,
  ValueType = unknown,
> {
  readonly schema: Schema
  readonly props: Props
  readonly params: TypeParams

  constructor(
    schema: Schema,
    props: Props = {} as Props,
    params: TypeParams = {} as TypeParams,
  ) {
    const { hasDefault = false, nullable = false, optional = false } = params
    this.schema = schema

    this.props = props
    this.params = {
      hasDefault,
      nullable,
      optional,
    } as TypeParams
  }

  optional(): OptionalType<BaseType<Schema, Props>, ValueType> {
    return OptionalType.factory(this) as any
  }

  nullable(): NullableType<BaseType<Schema, Props>, ValueType> {
    return NullableType.factory(this) as any
  }

  nullish() {
    return this.nullable().optional()
  }

  default(value: ValueType): DefaultType<BaseType<Schema, Props>, ValueType> {
    return DefaultType.factory(
      this,
      this.params.encode?.(value) ?? value,
    ) as any
  }

  description(description: string): BaseType<Schema, Props, ValueType> {
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

  examples(...examples: ValueType[]): BaseType<Schema, Props, ValueType> {
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

export class OptionalType<
  Type extends BaseTypeAny = BaseTypeAny,
  ValueType = unknown,
> extends BaseType<TOptional<Type['schema']>, { inner: Type }, ValueType> {
  static factory<T extends BaseTypeAny>(type: T) {
    return new OptionalType<T>(Optional(type.schema) as any, { inner: type }, {
      ...type.params,
      optional: true,
    } as any)
  }
}

export class NullableType<
  Type extends BaseTypeAny<any> = BaseTypeAny<any>,
  ValueType = unknown,
> extends BaseType<
  TNullable<Type['schema']>,
  { inner: Type },
  ValueType | null
> {
  static factory<T extends BaseTypeAny<any>>(type: T) {
    return new NullableType<T>(Nullable(type.schema), { inner: type }, {
      ...type.params,
      nullable: true,
    } as any)
  }
}

export class DefaultType<
  Type extends BaseTypeAny = BaseTypeAny,
  ValueType = unknown,
> extends BaseType<
  TDefault<TOptional<Type['schema']>>,
  { inner: Type },
  ValueType
> {
  static factory<T extends BaseTypeAny<any>>(type: T, defaultValue: any) {
    return new DefaultType<T>(
      Default(Optional(type.schema), defaultValue) as any,
      { inner: type },
      { ...type.params, hasDefault: true } as any,
    )
  }
}
