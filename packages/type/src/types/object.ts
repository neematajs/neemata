import type { core, ZodMiniObject, ZodMiniRecord } from 'zod/mini'
import { object as zodObject, record as zodRecord } from 'zod/mini'

import type { ZodPlainType } from './_plain.ts'
import type { BaseTypeAny, OptionalType } from './base.ts'
import type { LiteralType } from './literal.ts'
import type { StringType } from './string.ts'
import { zodPlainType } from './_plain.ts'
import { BaseType } from './base.ts'
import { EnumType } from './enum.ts'

export type ObjectTypeProps = { [k: string]: BaseTypeAny }
export type AnyObjectType = ObjectType<ObjectTypeProps>
export class ObjectType<T extends ObjectTypeProps = {}> extends BaseType<
  ZodMiniObject<{ [K in keyof T]: T[K]['encodeZodType'] }, core.$strict>,
  ZodMiniObject<{ [K in keyof T]: T[K]['decodeZodType'] }, core.$strict>,
  { properties: T },
  ZodPlainType<
    ZodMiniObject<{ [K in keyof T]: T[K]['encodeZodType'] }, core.$strict>
  >,
  ZodPlainType<
    ZodMiniObject<{ [K in keyof T]: T[K]['decodeZodType'] }, core.$strict>
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

export function keyof<T extends ObjectType>(
  type: T,
): EnumType<core.util.ToEnum<Extract<keyof T['props']['properties'], string>>> {
  return EnumType.factory(Object.keys(type.props.properties) as any)
}

export function pick<
  T extends AnyObjectType,
  P extends { [K in keyof T['props']['properties']]?: true },
>(
  source: T,
  pick: P,
): ObjectType<{
  [K in keyof P]: P[K] extends true
    ? K extends keyof T['props']['properties']
      ? T['props']['properties'][K]
      : never
    : never
}> {
  const properties = Object.fromEntries(
    Object.entries(source.props.properties).filter(([key]) => pick[key]),
  )
  return ObjectType.factory(properties) as any
}

export function omit<
  T extends AnyObjectType,
  P extends { [K in keyof T['props']['properties']]?: true },
>(
  source: T,
  omit: P,
): ObjectType<{
  [K in keyof T['props']['properties'] as K extends keyof P
    ? never
    : K]: T['props']['properties'][K]
}> {
  const properties = Object.fromEntries(
    Object.entries(source.props.properties).filter(([key]) => !omit[key]),
  )
  return ObjectType.factory(properties) as any
}

export function extend<T extends AnyObjectType, P extends ObjectTypeProps>(
  object1: T,
  properties: P,
): ObjectType<{
  [K in keyof T['props']['properties'] | keyof P]: K extends keyof P
    ? P[K]
    : K extends keyof T['props']['properties']
      ? T['props']['properties'][K]
      : never
}> {
  return ObjectType.factory({
    ...object1.props.properties,
    ...properties,
  }) as any
}

export function merge<T1 extends AnyObjectType, T2 extends AnyObjectType>(
  object1: T1,
  object2: T2,
): ObjectType<{
  [K in
    | keyof T1['props']['properties']
    | keyof T2['props']['properties']]: K extends keyof T2['props']['properties']
    ? T2['props']['properties'][K]
    : K extends keyof T1['props']['properties']
      ? T1['props']['properties'][K]
      : never
}> {
  return ObjectType.factory({
    ...object1.props.properties,
    ...object2.props.properties,
  }) as any
}

export function partial<
  T extends AnyObjectType,
  P extends T extends ObjectType<infer Props> ? Props : never,
>(
  object: T,
): ObjectType<{
  [K in keyof P]: OptionalType<P[K]>
}> {
  const properties = {} as any

  for (const [key, value] of Object.entries(object.props.properties)) {
    properties[key] = value.optional()
  }

  return ObjectType.factory(properties)
}

export const object = ObjectType.factory
export const record = RecordType.factory
