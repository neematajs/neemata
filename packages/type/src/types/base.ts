import * as zod from 'zod/v4-mini'

export type PrimitiveValueType = string | number | boolean | null

export type PrimitiveZodType =
  | zod.ZodMiniNever
  | zod.ZodMiniDefault
  | zod.ZodMiniNullable
  | zod.ZodMiniOptional
  | zod.ZodMiniString
  | zod.ZodMiniObject
  | zod.ZodMiniAny
  | zod.ZodMiniArray
  | zod.ZodMiniBoolean
  | zod.ZodMiniNumber
  | zod.ZodMiniEnum<any>
  | zod.ZodMiniLiteral<PrimitiveValueType>
  | zod.ZodMiniUnion
  | zod.ZodMiniIntersection
  | zod.ZodMiniRecord

export type SimpleZodType = zod.ZodMiniType

export type ZodType = SimpleZodType | zod.ZodMiniType

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
  checks: Array<zod.core.CheckFn<any> | zod.core.$ZodCheck<any>>
}

export type DefaultTypeParams = {
  encode?: TypeParams['encode']
  metadata?: TypeMetadata
}

export type BaseTypeAny<
  EncodedZodType extends SimpleZodType = SimpleZodType,
  DecodedZodType extends ZodType = zod.ZodMiniType,
> = BaseType<EncodedZodType, DecodedZodType, TypeProps>

export const typesRegistry = zod.registry<TypeMetadata>()

export const NeemataTypeError = zod.core.$ZodError
export type NeemataTypeError = zod.core.$ZodError

export abstract class BaseType<
  EncodedZodType extends SimpleZodType = SimpleZodType,
  DecodedZodType extends ZodType = EncodedZodType,
  Props extends TypeProps = TypeProps,
> {
  readonly encodedZodType: EncodedZodType
  readonly decodedZodType: DecodedZodType
  readonly props: Props
  readonly params: TypeParams

  constructor({
    encodedZodType,
    decodedZodType = encodedZodType as unknown as DecodedZodType,
    props = {} as Props,
    params = {} as Partial<TypeParams>,
  }: {
    encodedZodType: EncodedZodType
    decodedZodType?: DecodedZodType
    props?: Props
    params?: Partial<TypeParams>
  }) {
    this.encodedZodType = encodedZodType
    this.decodedZodType = decodedZodType

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

  default(value: this['encodedZodType']['_zod']['input']): DefaultType<this> {
    return DefaultType.factory(this, value)
  }

  title(title: string): this {
    return this.meta({ title })
  }

  description(description: string): this {
    return this.meta({ description })
  }

  examples(...examples: this['decodedZodType']['_zod']['input'][]): this {
    return this.meta({
      examples: this.params.encode
        ? examples.map(this.params.encode)
        : examples,
    })
  }

  meta(newMetadata: TypeMetadata): this {
    const metadata = typesRegistry.get(this.encodedZodType) ?? {}
    Object.assign(metadata, newMetadata)
    typesRegistry.add(this.encodedZodType, metadata)
    return this
  }

  encode(
    data: this['encodedZodType']['_zod']['input'],
  ): this['encodedZodType']['_zod']['output'] {
    return this.encodedZodType.parse(data, { reportInput: true })
  }

  decode(
    data: this['decodedZodType']['_zod']['input'],
  ): this['decodedZodType']['_zod']['output'] {
    return this.decodedZodType.parse(data, { reportInput: true })
  }
}

export class OptionalType<
  Type extends BaseTypeAny = BaseTypeAny,
> extends BaseType<
  zod.ZodMiniOptional<Type['encodedZodType']>,
  zod.ZodMiniOptional<Type['decodedZodType']>,
  { inner: Type }
> {
  static factory<T extends BaseTypeAny>(type: T) {
    return new OptionalType<T>({
      encodedZodType: zod.optional(type.encodedZodType) as any,
      props: { inner: type },
    })
  }
}

export class NullableType<
  Type extends BaseTypeAny<any> = BaseTypeAny<any>,
> extends BaseType<
  zod.ZodMiniNullable<Type['encodedZodType']>,
  zod.ZodMiniNullable<Type['decodedZodType']>,
  { inner: Type }
> {
  static factory<T extends BaseTypeAny<any>>(type: T) {
    return new NullableType<T>({
      encodedZodType: zod.nullable(type.encodedZodType),
      props: { inner: type },
    })
  }
}

export class DefaultType<
  Type extends BaseTypeAny = BaseTypeAny,
> extends BaseType<
  zod.ZodMiniDefault<Type['encodedZodType']>,
  zod.ZodMiniDefault<Type['decodedZodType']>,
  { inner: Type }
> {
  static factory<T extends BaseTypeAny<any>>(type: T, defaultValue: any) {
    return new DefaultType<T>({
      encodedZodType: zod._default(
        type.encodedZodType,
        type.params.encode?.(defaultValue) ?? defaultValue,
      ) as any,
      decodedZodType: zod._default(type.decodedZodType, defaultValue) as any,
      props: { inner: type },
    })
  }
}
