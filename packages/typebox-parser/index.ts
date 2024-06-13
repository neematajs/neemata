import { BaseParser } from '@neematajs/application'
import type { TypeProvider } from '@neematajs/common'
import type { StaticDecode, TSchema } from '@sinclair/typebox'
import {
  type TypeCheck,
  TypeCompiler,
  type ValueError,
} from '@sinclair/typebox/compiler'

export class TypeboxParserError extends Error {
  constructor(public readonly errors: ValueError[]) {
    super('TypeboxParserError')
  }
}

export class TypeboxParser extends BaseParser {
  constructor(private readonly type: 'input' | 'output') {
    super()
  }

  transform(schema: TSchema) {
    return TypeCompiler.Compile(schema)
  }

  async parse(compiled: TypeCheck<TSchema>, data: any, context: any) {
    const isValid = compiled.Check(data)
    if (!isValid) {
      const errors = Array.from(compiled.Errors(data))
      throw new TypeboxParserError(errors)
    }
    const method = compiled[this.type === 'input' ? 'Decode' : 'Encode']
    return method(data)
  }

  toJsonSchema(schema: TSchema) {
    return schema
  }
}

export interface TypeboxParserTypeProvider extends TypeProvider {
  output: this['input'] extends TSchema ? StaticDecode<this['input']> : never
}
