import type {
  ZodMiniAny,
  ZodMiniArray,
  ZodMiniBoolean,
  ZodMiniDefault,
  ZodMiniEnum,
  ZodMiniIntersection,
  ZodMiniLiteral,
  ZodMiniNever,
  ZodMiniNullable,
  ZodMiniNumber,
  ZodMiniObject,
  ZodMiniOptional,
  ZodMiniRecord,
  ZodMiniString,
  ZodMiniType,
  ZodMiniUnion,
} from 'zod/mini'
import { _default, core, nullable, optional, registry } from 'zod/mini'

export type PrimitiveValueType = string | number | boolean | null

export type PrimitiveZodType =
  | ZodMiniNever
  | ZodMiniDefault
  | ZodMiniNullable
  | ZodMiniOptional
  | ZodMiniString
  | ZodMiniObject
  | ZodMiniAny
  | ZodMiniArray
  | ZodMiniBoolean
  | ZodMiniNumber
  | ZodMiniEnum<any>
  | ZodMiniLiteral<PrimitiveValueType>
  | ZodMiniUnion
  | ZodMiniIntersection
  | ZodMiniRecord

export type SimpleZodType = ZodMiniType

export type ZodType = SimpleZodType | ZodMiniType

export type TypeProps = Record<string, any>

export type TypeMetadata<T = any> = {
  id?: string
  description?: string
  examples?: T[]
  title?: string
}

export type TypeParams = {
  encode?: (value: any) => any
  metadata?: TypeMetadata
  checks: Array<core.CheckFn<any> | core.$ZodCheck<any>>
}

export type DefaultTypeParams = {
  encode?: TypeParams['encode']
  metadata?: TypeMetadata
}

export type BaseTypeAny<
  EncodedZodType extends SimpleZodType = SimpleZodType,
  DecodedZodType extends ZodType = ZodMiniType,
> = BaseType<EncodedZodType, DecodedZodType, TypeProps>

export const typesRegistry = registry<TypeMetadata>()

export const NeemataTypeError = core.$ZodError
export type NeemataTypeError = core.$ZodError

export abstract class BaseType<
  EncodeZodType extends SimpleZodType = SimpleZodType,
  DecodeZodType extends ZodType = EncodeZodType,
  Props extends TypeProps = TypeProps,
> {
  readonly encodeZodType: EncodeZodType
  readonly decodeZodType: DecodeZodType
  readonly props: Props
  readonly params: TypeParams

  constructor({
    encodeZodType,
    decodeZodType = encodeZodType as unknown as DecodeZodType,
    props = {} as Props,
    params = {} as Partial<TypeParams>,
  }: {
    encodeZodType: EncodeZodType
    decodeZodType?: DecodeZodType
    props?: Props
    params?: Partial<TypeParams>
  }) {
    this.encodeZodType = encodeZodType
    this.decodeZodType = decodeZodType

    this.props = props
    this.params = Object.assign({ checks: [] }, params)
  }

  optional(): OptionalType<this> {
    return OptionalType.factory(this)
  }

  nullable(): NullableType<this> {
    return NullableType.factory(this)
  }

  nullish() {
    return this.nullable().optional()
  }

  default(value: this['encodeZodType']['_zod']['input']): DefaultType<this> {
    return DefaultType.factory(this, value)
  }

  title(title: string): this {
    return this.meta({ title })
  }

  description(description: string): this {
    return this.meta({ description })
  }

  examples(...examples: this['encodeZodType']['_zod']['input'][]): this {
    return this.meta({
      examples: this.params.encode
        ? examples.map(this.params.encode)
        : examples,
    })
  }

  meta(newMetadata: TypeMetadata): this {
    const metadata = typesRegistry.get(this.encodeZodType) ?? {}
    Object.assign(metadata, newMetadata)
    typesRegistry.add(this.encodeZodType, metadata)
    return this
  }

  encode(
    data: this['encodeZodType']['_zod']['input'],
    context: core.ParseContext<core.$ZodIssue> = {},
  ): this['encodeZodType']['_zod']['output'] {
    return this.encodeZodType.parse(data, { reportInput: true, ...context })
  }

  decode(
    data: this['decodeZodType']['_zod']['input'],
    context: core.ParseContext<core.$ZodIssue> = {},
  ): this['decodeZodType']['_zod']['output'] {
    return this.decodeZodType.parse(data, { reportInput: true, ...context })
  }
}

export class OptionalType<
  Type extends BaseTypeAny = BaseTypeAny,
> extends BaseType<
  ZodMiniOptional<Type['encodeZodType']>,
  ZodMiniOptional<Type['decodeZodType']>,
  { inner: Type }
> {
  static factory<T extends BaseTypeAny>(type: T) {
    return new OptionalType<T>({
      encodeZodType: optional(type.encodeZodType),
      decodeZodType: optional(type.decodeZodType),
      props: { inner: type },
    })
  }
}

export class NullableType<
  Type extends BaseTypeAny<any> = BaseTypeAny<any>,
> extends BaseType<
  ZodMiniNullable<Type['encodeZodType']>,
  ZodMiniNullable<Type['decodeZodType']>,
  { inner: Type }
> {
  static factory<T extends BaseTypeAny<any>>(type: T) {
    return new NullableType<T>({
      encodeZodType: nullable(type.encodeZodType),
      decodeZodType: nullable(type.decodeZodType),
      props: { inner: type },
    })
  }
}

export class DefaultType<
  Type extends BaseTypeAny = BaseTypeAny,
> extends BaseType<
  ZodMiniDefault<Type['encodeZodType']>,
  ZodMiniDefault<Type['decodeZodType']>,
  { inner: Type }
> {
  static factory<T extends BaseTypeAny<any>>(type: T, defaultValue: any) {
    return new DefaultType<T>({
      encodeZodType: _default(
        type.encodeZodType,
        type.params.encode?.(defaultValue) ?? defaultValue,
      ),
      decodeZodType: _default(type.decodeZodType, defaultValue),
      props: { inner: type },
    })
  }
}
