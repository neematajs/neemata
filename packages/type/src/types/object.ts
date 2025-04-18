import {
  type core,
  object,
  record,
  strictObject,
  type ZodMiniObject,
  type ZodMiniRecord,
} from '@zod/mini'

import { BaseType, type BaseTypeAny, type OptionalType } from './base.ts'
import { EnumType } from './enum.ts'
import type { LiteralType } from './literal.ts'
import type { StringType } from './string.ts'

export type ObjectTypeProps = { [k: string]: BaseTypeAny }
export type AnyObjectType = ObjectType<ObjectTypeProps>
export class ObjectType<T extends ObjectTypeProps = {}> extends BaseType<
  ZodMiniObject<{ [K in keyof T]: T[K]['encodedZodType'] }, {}>,
  ZodMiniObject<{ [K in keyof T]: T[K]['decodedZodType'] }, {}>,
  { properties: T }
> {
  static factory<T extends ObjectTypeProps = {}>(properties: T) {
    const encodeProperties = {} as {
      [K in keyof T]: T[K]['encodedZodType']
    }
    const decodeProperties = {} as {
      [K in keyof T]: T[K]['decodedZodType']
    }

    for (const key in properties) {
      encodeProperties[key] = properties[key].encodedZodType
      decodeProperties[key] = properties[key].decodedZodType
    }

    return new ObjectType<T>({
      encodedZodType: object(encodeProperties),
      decodedZodType: object(decodeProperties),
      props: { properties },
    })
  }
}

export class RecordType<
  K extends LiteralType<string | number> | EnumType | StringType,
  E extends BaseType,
> extends BaseType<
  ZodMiniRecord<K['encodedZodType'], E['encodedZodType']>,
  ZodMiniRecord<K['decodedZodType'], E['decodedZodType']>
> {
  static factory<
    K extends LiteralType<string | number> | EnumType | StringType,
    E extends BaseType,
  >(key: K, element: E) {
    return new RecordType<K, E>({
      encodedZodType: record(
        (key as any).encodedZodType,
        element.encodedZodType,
      ),
      decodedZodType: record(
        (key as any).decodedZodType,
        element.decodedZodType,
      ),
      props: { key, element },
    })
  }
}

export function keyof<T extends ObjectType>(
  type: T,
): EnumType<
  core.utils.ToEnum<Extract<keyof T['props']['properties'], string>>
> {
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
