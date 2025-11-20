import type { BaseType } from '@nmtjs/type'
import type { NeverType } from '@nmtjs/type/never'
import { t } from '@nmtjs/type'

import type { ContractSchemaOptions } from '../utils.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export type TAnyProcedureContract = TProcedureContract<
  BaseType,
  BaseType,
  true | undefined,
  string | undefined
>

export const ProcedureKind = Symbol('NeemataProcedure')

export interface TProcedureContract<
  Input extends BaseType,
  Output extends BaseType,
  Stream extends true | undefined,
  Name extends string | undefined = undefined,
> {
  readonly [Kind]: typeof ProcedureKind
  readonly type: 'neemata:procedure'
  readonly name: Name
  readonly input: Input
  readonly output: Output
  readonly stream: Stream
  readonly timeout?: number
}

export const ProcedureContract = <
  const Options extends {
    input?: BaseType
    output?: BaseType
    stream?: true | undefined
    timeout?: number
    schemaOptions?: ContractSchemaOptions
    name?: string
  },
>(
  options: Options,
): TProcedureContract<
  Options['input'] extends BaseType ? Options['input'] : NeverType,
  Options['output'] extends BaseType ? Options['output'] : NeverType,
  Options['stream'],
  Options['name'] extends string ? Options['name'] : undefined
> => {
  const {
    input = t.never() as any,
    output = t.never() as any,
    stream = undefined as any,
    name = undefined as any,
    timeout,
    schemaOptions = {},
  } = options
  return createSchema({
    ...schemaOptions,
    [Kind]: ProcedureKind,
    type: 'neemata:procedure',
    input,
    output,
    stream,
    name,
    timeout,
  })
}

export function IsProcedureContract(
  contract: any,
): contract is TAnyProcedureContract {
  return Kind in contract && contract[Kind] === ProcedureKind
}

export function IsStreamProcedureContract(
  contract: any,
): contract is TAnyProcedureContract {
  return IsProcedureContract(contract) && typeof contract.stream !== 'undefined'
}
