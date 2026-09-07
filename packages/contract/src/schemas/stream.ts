import type { WireSchema } from '@nmtjs/common/schema'
import { isSchema, isWireSchemaCodec } from '@nmtjs/common/schema'

import type { ContractSchemaOptions } from '../utils.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export type TAnyStreamContract = TStreamContract<
  WireSchema.Decode | WireSchema.Codec | undefined,
  WireSchema.Encode | WireSchema.Codec | undefined,
  string | undefined
>

export const StreamKind = Symbol('NeemataStream')

export interface TStreamContract<
  Input extends WireSchema.Decode | WireSchema.Codec | undefined,
  Output extends WireSchema.Encode | WireSchema.Codec | undefined,
  Name extends string | undefined = undefined,
> {
  readonly [Kind]: typeof StreamKind
  readonly type: 'neemata:stream'
  readonly name: Name
  readonly input: Input
  readonly output: Output
  readonly timeout?: number
}

export const StreamContract = <
  const Options extends {
    input?: WireSchema.Decode | WireSchema.Codec
    output?: WireSchema.Encode | WireSchema.Codec
    timeout?: number
    schemaOptions?: ContractSchemaOptions
    name?: string
  },
>(
  options: Options,
): TStreamContract<
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
    throw new TypeError('Stream input must be a decode schema or wire codec')
  }
  if (output !== undefined && !isSchema(output) && !isWireSchemaCodec(output)) {
    throw new TypeError('Stream output must be an encode schema or wire codec')
  }
  return createSchema({
    ...schemaOptions,
    [Kind]: StreamKind,
    type: 'neemata:stream',
    input,
    output,
    name,
    timeout,
  })
}

export function IsStreamContract(
  contract: any,
): contract is TAnyStreamContract {
  return Kind in contract && contract[Kind] === StreamKind
}
