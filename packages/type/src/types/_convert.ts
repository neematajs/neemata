import type { core } from 'zod/mini'
import { toJSONSchema } from 'zod/mini'

import type { BaseType } from './base.ts'
import { AnyType } from './any.ts'
import { ArrayType } from './array.ts'
import { NullableType, OptionalType } from './base.ts'
import { BooleanType } from './boolean.ts'
import { CustomType } from './custom.ts'
import { DateType } from './date.ts'
import { LiteralType } from './literal.ts'
import { NumberType } from './number.ts'
import { ObjectType } from './object.ts'
import { StringType } from './string.ts'
import { TupleType } from './tuple.ts'

export function typeToString(type: BaseType): string {
  switch (true) {
    case type instanceof OptionalType:
      return `?<${typeToString(type.props.inner)}>`
    case type instanceof NullableType:
      return `null | ${typeToString(type.props.inner)}`
    case type instanceof StringType:
      return 'string'
    case type instanceof NumberType:
      return 'number'
    case type instanceof LiteralType:
      return `literal(${type.props.value})`
    case type instanceof BooleanType:
      return 'boolean'
    case type instanceof DateType:
      return 'string'
    case type instanceof ArrayType:
      return `array<${typeToString(type.props.element)}>`
    case type instanceof ObjectType: {
      const props = type.props.properties
      const propsStrings = Object.keys(props).map(
        (key) => `${key}: ${typeToString(props[key])}`,
      )
      return `{ ${propsStrings.join(', ')} }`
    }
    case type instanceof TupleType: {
      const elements = type.props.elements
      const elementsStrings = elements.map((el) => typeToString(el))
      const rest = type.props.rest
        ? `, ...${typeToString(type.props.rest)}`
        : ''
      return `[${elementsStrings.join(', ')}${rest}]`
    }
    case type instanceof AnyType:
      return 'any'
    case type instanceof CustomType:
      return typeToJsonSchema(type, 'decode').type || 'custom'
    default:
      return 'unknown'
  }
}

export function typeToJsonSchema(
  type: BaseType,
  mode: 'encode' | 'decode',
  options?: Parameters<typeof toJSONSchema>[1],
): core.JSONSchema.JSONSchema {
  const zodType = { encode: type.encodeZodType, decode: type.decodeZodType }[
    mode
  ]
  return toJSONSchema(zodType, options)
}
