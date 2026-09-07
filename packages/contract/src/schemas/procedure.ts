import type { WireSchema } from '@nmtjs/common/schema'
import { isSchema, isWireSchemaCodec } from '@nmtjs/common/schema'

import type { ContractSchemaOptions } from '../utils.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export type TAnyProcedureContract = TProcedureContract<
  WireSchema.Decode | WireSchema.Codec | undefined,
  WireSchema.Encode | WireSchema.Codec | undefined,
  string | undefined
>

export const ProcedureKind = Symbol('NeemataProcedure')

export interface TProcedureContract<
  Input extends WireSchema.Decode | WireSchema.Codec | undefined,
  Output extends WireSchema.Encode | WireSchema.Codec | undefined,
  Name extends string | undefined = undefined,
> {
  readonly [Kind]: typeof ProcedureKind
  readonly type: 'neemata:procedure'
  readonly name: Name
  readonly input: Input
  readonly output: Output
  readonly timeout?: number
}

export const ProcedureContract = <
  const Options extends {
    input?: WireSchema.Decode | WireSchema.Codec
    output?: WireSchema.Encode | WireSchema.Codec
    timeout?: number
    schemaOptions?: ContractSchemaOptions
    name?: string
  },
>(
  options: Options,
): TProcedureContract<
  Options['input'] extends WireSchema.Decode | WireSchema.Codec
    ? Options['input']
    : undefined,
  Options['output'] extends WireSchema.Encode | WireSchema.Codec
    ? Options['output']
    : undefined,
  Options['name'] extends string ? Options['name'] : undefined
> => {
  const {
    input = undefined as any,
    output = undefined as any,
    name = undefined as any,
    timeout,
    schemaOptions = {},
  } = options
  if (input !== undefined && !isSchema(input) && !isWireSchemaCodec(input)) {
    throw new TypeError('Procedure input must be a decode schema or wire codec')
  }
  if (output !== undefined && !isSchema(output) && !isWireSchemaCodec(output)) {
    throw new TypeError(
      'Procedure output must be an encode schema or wire codec',
    )
  }
  return createSchema({
    ...schemaOptions,
    [Kind]: ProcedureKind,
    type: 'neemata:procedure',
    input,
    output,
    name,
    timeout,
  })
}

export function IsProcedureContract(
  contract: any,
): contract is TAnyProcedureContract {
  return Kind in contract && contract[Kind] === ProcedureKind
}
