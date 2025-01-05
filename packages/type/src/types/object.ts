import {
  type ObjectOptions,
  type TObject,
  type TRecordOrObject,
  type TSchema,
  Type,
} from '@sinclair/typebox'
import { BaseType, type BaseTypeAny } from './base.ts'
import type { EnumType, ObjectEnumType } from './enum.ts'
import type { LiteralType } from './literal.ts'
import type { StringType } from './string.ts'

export type ObjectTypeProps = { [k: string]: BaseTypeAny<any> }
export class ObjectType<
  T extends ObjectTypeProps = ObjectTypeProps,
> extends BaseType<
  TObject<{ [K in keyof T]: T[K]['schema'] }>,
  { properties: T }
> {
  declare _: {
    encoded: {
      input: TObject<{ [K in keyof T]: T[K]['_']['encoded']['input'] }>
      output: TObject<{ [K in keyof T]: T[K]['_']['encoded']['output'] }>
    }
    decoded: {
      input: TObject<{ [K in keyof T]: T[K]['_']['decoded']['input'] }>
      output: TObject<{ [K in keyof T]: T[K]['_']['decoded']['output'] }>
    }
  }

  static factory<T extends ObjectTypeProps = ObjectTypeProps>(
    properties: T,
    options: ObjectOptions = {},
  ) {
    const schemaProperties = {} as {
      [K in keyof T]: T[K]['schema']
    }

    for (const key in properties) {
      schemaProperties[key] = properties[key].final
    }

    return new ObjectType<T>(Type.Object(schemaProperties, options) as any, {
      properties,
    })
  }
}

export class RecordType<
  K extends LiteralType | EnumType | ObjectEnumType | StringType,
  E extends BaseType,
> extends BaseType<TRecordOrObject<K['schema'], E['schema']>> {
  declare _: {
    encoded: {
      input: TRecordOrObject<
        K['_']['encoded']['input'],
        E['_']['encoded']['input']
      >
      output: TRecordOrObject<
        K['_']['encoded']['output'],
        E['_']['encoded']['output']
      >
    }
    decoded: {
      input: TRecordOrObject<
        K['_']['decoded']['input'],
        E['_']['decoded']['input']
      >
      output: TRecordOrObject<
        K['_']['decoded']['output'],
        E['_']['decoded']['output']
      >
    }
  }

  static factory<
    K extends
      | LiteralType<any>
      | EnumType<any>
      | ObjectEnumType<any>
      | StringType,
    E extends BaseType,
  >(key: K, element: E, options: ObjectOptions = {}) {
    return new RecordType<K, E>(
      Type.Record(key.schema, element.schema, options) as any,
    )
  }
}
