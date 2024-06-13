import { type Async, BaseParser } from '@neematajs/application'
import type { TypeProvider } from '@neematajs/common'
import { type ZodErrorMap, type ZodSchema, z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

export class ZodParser extends BaseParser {
  constructor(
    private readonly customErrorMap?: (context: any) => Async<ZodErrorMap>,
  ) {
    super()
  }

  async parse(schema: ZodSchema, data: any, context: any) {
    const errorMap = await this.customErrorMap?.(context)
    return await schema.parseAsync(data, { errorMap })
  }

  toJsonSchema(schema: ZodSchema) {
    return zodToJsonSchema(schema ?? z.any().optional(), {
      $refStrategy: 'seen',
    })
  }
}

export interface ZodParserTypeProvider extends TypeProvider {
  output: this['input'] extends ZodSchema ? this['input']['_output'] : never
}
