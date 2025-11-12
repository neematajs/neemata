import type { core, ZodMiniObject, ZodMiniRecord } from 'zod/mini'
import {
  looseObject as zodLooseObject,
  object as zodObject,
  record as zodRecord,
} from 'zod/mini'

import type { ZodPlainType } from './_utils.ts'
import type { BaseTypeAny, OptionalType } from './base.ts'
import type { LiteralType } from './literal.ts'
import type { StringType } from './string.ts'
import { zodPlainType } from './_utils.ts'
import { BaseType } from './base.ts'
import { EnumType } from './enum.ts'

export type ObjectTypeProps = { [k: string]: BaseTypeAny }

export class ObjectType<T extends ObjectTypeProps = {}> extends BaseType<
  ZodMiniObject<{ [K in keyof T]: T[K]['encodeZodType'] }, core.$strip>,
  ZodMiniObject<{ [K in keyof T]: T[K]['decodeZodType'] }, core.$strip>,
  { properties: T },
  ZodPlainType<
    ZodMiniObject<{ [K in keyof T]: T[K]['encodeZodType'] }, core.$strip>
  >,
  ZodPlainType<
    ZodMiniObject<{ [K in keyof T]: T[K]['decodeZodType'] }, core.$strip>
  >
> {
  static factory<T extends ObjectTypeProps = {}>(properties: T) {
    const encodeProperties = {} as {
      [K in keyof T]: T[K]['encodeZodType']
    }
    const decodeProperties = {} as {
      [K in keyof T]: T[K]['decodeZodType']
    }

    for (const key in properties) {
      encodeProperties[key] = properties[key].encodeZodType
      decodeProperties[key] = properties[key].decodeZodType
    }

    return new ObjectType<T>({
      encodeZodType: zodObject(encodeProperties),
      decodeZodType: zodObject(decodeProperties),
      props: { properties },
    })
  }
}

export class LooseObjectType<T extends ObjectTypeProps = {}> extends BaseType<
  ZodMiniObject<{ [K in keyof T]: T[K]['encodeZodType'] }, core.$loose>,
  ZodMiniObject<{ [K in keyof T]: T[K]['decodeZodType'] }, core.$loose>,
  { properties: T },
  ZodPlainType<
    ZodMiniObject<{ [K in keyof T]: T[K]['encodeZodType'] }, core.$loose>
  >,
  ZodPlainType<
    ZodMiniObject<{ [K in keyof T]: T[K]['decodeZodType'] }, core.$loose>
  >
> {
  static factory<T extends ObjectTypeProps = {}>(properties: T) {
    const encodeProperties = {} as {
      [K in keyof T]: T[K]['encodeZodType']
    }
    const decodeProperties = {} as {
      [K in keyof T]: T[K]['decodeZodType']
    }

    for (const key in properties) {
      encodeProperties[key] = properties[key].encodeZodType
      decodeProperties[key] = properties[key].decodeZodType
    }

    return new LooseObjectType<T>({
      encodeZodType: zodLooseObject(encodeProperties),
      decodeZodType: zodLooseObject(decodeProperties),
      props: { properties },
    })
  }
}

export type ObjectLikeType<T extends ObjectTypeProps> =
  | ObjectType<T>
  | LooseObjectType<T>

export type AnyObjectType = ObjectType<ObjectTypeProps>
export type AnyLooseObjectType = LooseObjectType<ObjectTypeProps>
export type AnyObjectLikeType<> = AnyObjectType | AnyLooseObjectType

export class RecordType<
  K extends LiteralType<string | number> | EnumType | StringType,
  E extends BaseType,
> extends BaseType<
  ZodMiniRecord<K['encodeZodType'], E['encodeZodType']>,
  ZodMiniRecord<K['decodeZodType'], E['decodeZodType']>,
  { key: K; element: E },
  ZodPlainType<ZodMiniRecord<K['encodeZodType'], E['encodeZodType']>>,
  ZodPlainType<ZodMiniRecord<K['decodeZodType'], E['decodeZodType']>>
> {
  static factory<
    K extends LiteralType<string | number> | EnumType | StringType,
    E extends BaseType,
  >(key: K, element: E) {
    return new RecordType<K, E>({
      encodeZodType: zodPlainType(
        zodRecord(key.encodeZodType, element.encodeZodType),
      ),
      decodeZodType: zodPlainType(
        zodRecord(key.decodeZodType, element.decodeZodType),
      ),
      props: { key, element },
    })
  }
}

export type KeyofType<T extends AnyObjectLikeType> = EnumType<
  core.util.ToEnum<Extract<keyof T['props']['properties'], string>>
>

export function keyof<T extends AnyObjectLikeType>(type: T): KeyofType<T> {
  return EnumType.factory(Object.keys(type.props.properties) as any)
}

export type PickObjectType<
  T extends AnyObjectLikeType,
  P extends { [K in keyof T['props']['properties']]?: true },
> = ObjectType<{
  [K in keyof P]: P[K] extends true
    ? K extends keyof T['props']['properties']
      ? T['props']['properties'][K]
      : never
    : never
}>
export function pick<
  T extends AnyObjectLikeType,
  P extends { [K in keyof T['props']['properties']]?: true },
>(source: T, pick: P): PickObjectType<T, P> {
  const properties = Object.fromEntries(
    Object.entries(source.props.properties).filter(([key]) => pick[key]),
  )
  return ObjectType.factory(properties) as any
}

export type OmitObjectType<
  T extends AnyObjectLikeType,
  P extends { [K in keyof T['props']['properties']]?: true },
> = ObjectType<{
  [K in keyof T['props']['properties'] as K extends keyof P
    ? never
    : K]: T['props']['properties'][K]
}>
export function omit<
  T extends AnyObjectLikeType,
  P extends { [K in keyof T['props']['properties']]?: true },
>(source: T, omit: P): OmitObjectType<T, P> {
  const properties = Object.fromEntries(
    Object.entries(source.props.properties).filter(([key]) => !omit[key]),
  )
  return ObjectType.factory(properties) as any
}

export type ExtendObjectType<
  T extends AnyObjectLikeType,
  P extends ObjectTypeProps,
> = ObjectType<{
  [K in keyof T['props']['properties'] | keyof P]: K extends keyof P
    ? P[K]
    : K extends keyof T['props']['properties']
      ? T['props']['properties'][K]
      : never
}>

export function extend<T extends AnyObjectLikeType, P extends ObjectTypeProps>(
  object1: T,
  properties: P,
): ExtendObjectType<T, P> {
  return ObjectType.factory({
    ...object1.props.properties,
    ...properties,
  }) as any
}

export type MergeObjectTypes<
  T1 extends AnyObjectLikeType,
  T2 extends AnyObjectLikeType,
> = ObjectType<{
  [K in
    | keyof T1['props']['properties']
    | keyof T2['props']['properties']]: K extends keyof T2['props']['properties']
    ? T2['props']['properties'][K]
    : K extends keyof T1['props']['properties']
      ? T1['props']['properties'][K]
      : never
}>

export function merge<
  T1 extends AnyObjectLikeType,
  T2 extends AnyObjectLikeType,
>(object1: T1, object2: T2): MergeObjectTypes<T1, T2> {
  return ObjectType.factory({
    ...object1.props.properties,
    ...object2.props.properties,
  }) as any
}

export type PartialObjectType<T extends AnyObjectLikeType> = ObjectType<{
  [K in keyof T['props']['properties']]: OptionalType<
    T['props']['properties'][K]
  >
}>
export function partial<T extends AnyObjectLikeType>(
  object: T,
): PartialObjectType<T> {
  const properties = {} as any

  for (const [key, value] of Object.entries(object.props.properties)) {
    properties[key] = value.optional()
  }

  return ObjectType.factory(properties)
}

export const object = ObjectType.factory
export const looseObject = LooseObjectType.factory
export const record = RecordType.factory
