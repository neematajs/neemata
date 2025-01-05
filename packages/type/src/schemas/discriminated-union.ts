import {
  KindGuard,
  type TLiteral,
  type TObject,
  type TPropertyKey,
  type TSchema,
  type TUnion,
  Type,
  TypeGuard,
  ValueGuard,
} from '@sinclair/typebox'

export function IsDiscriminatedUnion(
  schema: TSchema,
): schema is TDiscriminatedUnion {
  return (
    TypeGuard.IsUnion(schema) &&
    'discriminator' in schema &&
    ValueGuard.IsString(schema.discriminator) &&
    schema.anyOf.every(
      (variant) =>
        KindGuard.IsObject(variant) &&
        KindGuard.IsLiteralString(variant.properties[schema.discriminator]),
    )
  )
}

type DiscriminatedUnionProperties<K extends string = string> = {
  [OK in K]: TLiteral<any>
} & {
  [OK in TPropertyKey]: any
}

export interface TDiscriminatedUnion<
  K extends string = string,
  T extends TObject<DiscriminatedUnionProperties<K>>[] = TObject<
    DiscriminatedUnionProperties<K>
  >[],
> extends TUnion<T> {
  discriminator: K
  anyOf: T
}

export function DiscriminatedUnion<
  K extends string,
  T extends TObject<DiscriminatedUnionProperties<K>>[],
>(key: K, types: T): TDiscriminatedUnion<K, T> {
  return Type.Union(types, { discriminator: key }) as any
}
