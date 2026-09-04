import type { WireSchema } from '@nmtjs/common/schema'
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
  ZodMiniPrefault,
  ZodMiniRecord,
  ZodMiniString,
  ZodMiniType,
  ZodMiniUnion,
} from 'zod/mini'
import { core, nullable, optional, prefault } from 'zod/mini'

import type { TypeMetadata } from './_metadata.ts'
import { standard } from '../standard-schema.ts'
import { typesRegistry } from './_metadata.ts'

export type PrimitiveValueType = string | number | boolean | null

export type PrimitiveZodType =
  | ZodMiniNever
  | ZodMiniDefault
  | ZodMiniNullable
  | ZodMiniOptional
  | ZodMiniPrefault
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

export type SimpleZodType = ZodMiniType<any, any, any>

export type ZodType = SimpleZodType | ZodMiniType<any, any, any>

export type TypeProps = Record<string, any>

export type TypeParams = {
  metadata?: TypeMetadata
  checks: Array<core.CheckFn<any> | core.$ZodCheck<any>>
}

export type DefaultTypeParams = {
  metadata?: TypeMetadata
}

export type BaseTypeAny<
  EncodedZodType extends SimpleZodType = SimpleZodType,
  DecodedZodType extends ZodType = ZodMiniType,
> = BaseType<EncodedZodType, DecodedZodType, any>

export const NeemataTypeError = core.$ZodError
export type NeemataTypeError = core.$ZodError

export abstract class BaseType<
  EncodeZodType extends SimpleZodType = SimpleZodType,
  DecodeZodType extends ZodType = EncodeZodType,
  Props extends TypeProps = TypeProps,
> implements WireSchema.Codec<
  standard.Schema<DecodeZodType>,
  standard.Schema<EncodeZodType>
> {
  readonly encodeZodType: EncodeZodType
  readonly decodeZodType: DecodeZodType
  readonly props: Props
  readonly params: TypeParams
  readonly encode: standard.Schema<EncodeZodType>
  readonly decode: standard.Schema<DecodeZodType>

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
    this.encode = standard.create(this.encodeZodType, typesRegistry)
    this.decode = standard.create(this.decodeZodType, typesRegistry)
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

  default(
    value: core.util.NoUndefined<this['encodeZodType']['_zod']['input']>,
  ): DefaultType<this> {
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
      examples: examples.map((example) => this.encodeZodType.parse(example)),
    })
  }

  meta(newMetadata: TypeMetadata): this {
    const metadata = typesRegistry.get(this.encodeZodType) ?? {}
    Object.assign(metadata, newMetadata)
    typesRegistry.add(this.encodeZodType, metadata)
    return this
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
  ZodMiniPrefault<Type['encodeZodType']>,
  ZodMiniPrefault<Type['decodeZodType']>,
  { inner: Type }
> {
  static factory<T extends BaseTypeAny<any>>(
    type: T,
    defaultValue: core.util.NoUndefined<T['encodeZodType']['_zod']['input']>,
  ) {
    const encodedDefault = type.encodeZodType.parse(defaultValue)

    return new DefaultType<T>({
      encodeZodType: prefault(type.encodeZodType, defaultValue),
      decodeZodType: prefault(
        type.decodeZodType,
        encodedDefault as T['decodeZodType']['_zod']['input'],
      ),
      props: { inner: type },
    })
  }
}
