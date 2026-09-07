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
import { core, input, nullable, optional, output, prefault } from 'zod/mini'

import type { TypeMetadata, WireZodTypes } from './_metadata.ts'
import { standard } from '../standard-schema.ts'
import { mapWireZodTypes, typesRegistry } from './_metadata.ts'

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

export type SimpleZodType = ZodMiniType<any, any>

export type ZodType = SimpleZodType

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
> = BaseType<EncodedZodType, DecodedZodType, any, any>

export const NeemataTypeError = core.$ZodError
export type NeemataTypeError = core.$ZodError

export abstract class BaseType<
  EncodeZodType extends SimpleZodType = SimpleZodType,
  DecodeZodType extends ZodType = EncodeZodType,
  Props extends TypeProps = TypeProps,
  RuntimeZodType extends ZodMiniType = EncodeZodType,
> implements WireSchema.Codec<
  standard.Schema<DecodeZodType>,
  standard.Schema<EncodeZodType>
> {
  readonly encodeZodType: EncodeZodType
  readonly decodeZodType: DecodeZodType
  readonly runtimeZodType: RuntimeZodType
  readonly parse: standard.Schema<RuntimeZodType>
  readonly wireZodTypes: WireZodTypes
  private metadata: TypeMetadata = {}
  readonly props: Props
  readonly params: TypeParams
  readonly encode: standard.Schema<EncodeZodType>
  readonly decode: standard.Schema<DecodeZodType>

  constructor({
    encodeZodType,
    decodeZodType = encodeZodType as unknown as DecodeZodType,
    runtimeZodType,
    wireZodTypes,
    props = {} as Props,
    params = {} as Partial<TypeParams>,
  }: {
    encodeZodType: EncodeZodType
    decodeZodType?: DecodeZodType
    runtimeZodType: RuntimeZodType
    wireZodTypes?: WireZodTypes
    props?: Props
    params?: Partial<TypeParams>
  }) {
    this.encodeZodType = encodeZodType
    this.decodeZodType = decodeZodType
    this.runtimeZodType = runtimeZodType.clone()
    this.parse = standard.create(this.runtimeZodType, typesRegistry)

    // Caller-supplied schemas may be reused; each type must own its metadata.
    this.wireZodTypes = wireZodTypes ?? {
      input: input(decodeZodType).clone(),
      output: output(encodeZodType).clone(),
    }

    this.props = props
    this.params = Object.assign({ checks: [] }, params)
    this.encode = standard.create(this.encodeZodType, typesRegistry, {
      output: this.wireZodTypes.output,
    })
    this.decode = standard.create(this.decodeZodType, typesRegistry, {
      input: this.wireZodTypes.input,
    })
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
    return this.meta({ examples })
  }

  meta(
    newMetadata: TypeMetadata<this['encodeZodType']['_zod']['input']>,
  ): this {
    const { examples, ...shared } = newMetadata
    // Both metadata entry points accept runtime values and encode them exactly once.
    const encodedExamples = examples?.map((example) =>
      this.encodeZodType.parse(example),
    )
    this.metadata = { ...this.metadata, ...shared }
    if ('examples' in newMetadata) this.metadata.examples = encodedExamples
    const annotations = { ...this.metadata }
    delete annotations.examples
    typesRegistry.add(this.encodeZodType, annotations)
    typesRegistry.add(this.decodeZodType, annotations)
    typesRegistry.add(this.runtimeZodType, annotations)
    for (const schema of Object.values(this.wireZodTypes)) {
      typesRegistry.add(schema, { ...this.metadata })
    }
    return this
  }
}

export class OptionalType<
  Type extends BaseTypeAny = BaseTypeAny,
> extends BaseType<
  ZodMiniOptional<Type['encodeZodType']>,
  ZodMiniOptional<Type['decodeZodType']>,
  { inner: Type },
  ZodMiniOptional<Type['runtimeZodType']>
> {
  static factory<T extends BaseTypeAny>(type: T) {
    return new OptionalType<T>({
      runtimeZodType: optional<T['runtimeZodType']>(type.runtimeZodType),
      encodeZodType: optional(type.encodeZodType),
      decodeZodType: optional(type.decodeZodType),
      wireZodTypes: mapWireZodTypes((side) =>
        optional(type.wireZodTypes[side]),
      ),
      props: { inner: type },
    })
  }
}

export class NullableType<
  Type extends BaseTypeAny<any> = BaseTypeAny<any>,
> extends BaseType<
  ZodMiniNullable<Type['encodeZodType']>,
  ZodMiniNullable<Type['decodeZodType']>,
  { inner: Type },
  ZodMiniNullable<Type['runtimeZodType']>
> {
  static factory<T extends BaseTypeAny<any>>(type: T) {
    return new NullableType<T>({
      runtimeZodType: nullable<T['runtimeZodType']>(type.runtimeZodType),
      encodeZodType: nullable(type.encodeZodType),
      decodeZodType: nullable(type.decodeZodType),
      wireZodTypes: mapWireZodTypes((side) =>
        nullable(type.wireZodTypes[side]),
      ),
      props: { inner: type },
    })
  }
}

export class DefaultType<
  Type extends BaseTypeAny = BaseTypeAny,
> extends BaseType<
  ZodMiniPrefault<Type['encodeZodType']>,
  ZodMiniPrefault<Type['decodeZodType']>,
  { inner: Type },
  ZodMiniPrefault<Type['runtimeZodType']>
> {
  static factory<T extends BaseTypeAny<any>>(
    type: T,
    defaultValue: core.util.NoUndefined<T['encodeZodType']['_zod']['input']>,
  ) {
    const encodedDefault = type.encodeZodType.parse(defaultValue)

    return new DefaultType<T>({
      runtimeZodType: prefault<T['runtimeZodType']>(
        type.runtimeZodType,
        defaultValue,
      ),
      encodeZodType: prefault(type.encodeZodType, defaultValue),
      decodeZodType: prefault(
        type.decodeZodType,
        encodedDefault as T['decodeZodType']['_zod']['input'],
      ),
      wireZodTypes: mapWireZodTypes((side) =>
        prefault(type.wireZodTypes[side], encodedDefault),
      ),
      props: { inner: type },
    })
  }
}
