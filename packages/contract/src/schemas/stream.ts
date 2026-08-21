import type { BaseType } from '@nmtjs/type'
import type { NeverType } from '@nmtjs/type/never'
import { t } from '@nmtjs/type'

import type { ContractSchemaOptions } from '../utils.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export type TAnyStreamContract = TStreamContract<
  BaseType,
  BaseType,
  string | undefined
>

export const StreamKind = Symbol('NeemataStream')

export interface TStreamContract<
  Input extends BaseType,
  Output extends BaseType,
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
    input?: BaseType
    output?: BaseType
    timeout?: number
    schemaOptions?: ContractSchemaOptions
    name?: string
  },
>(
  options: Options,
): TStreamContract<
  Options['input'] extends BaseType ? Options['input'] : NeverType,
  Options['output'] extends BaseType ? Options['output'] : NeverType,
  Options['name'] extends string ? Options['name'] : undefined
> => {
  const {
    input = t.never() as any,
    output = t.never() as any,
    name = undefined as any,
    timeout,
    schemaOptions = {},
  } = options
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
