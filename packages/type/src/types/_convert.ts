import type { core } from 'zod/mini'
import { toJSONSchema } from 'zod/mini'

import type { BaseType } from './base.ts'

export function typeToJsonSchema(
  type: BaseType,
  mode: 'encode' | 'decode',
  options?: Parameters<typeof toJSONSchema>[1],
): core.JSONSchema.JSONSchema {
  const zodType = mode === 'encode' ? type.encodeZodType : type.decodeZodType
  return toJSONSchema(zodType, options)
}
