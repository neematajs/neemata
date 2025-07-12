import { type BaseType, t } from '@nmtjs/type'
import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export type TAnyProcedureContract = TProcedureContract<
  BaseType,
  BaseType,
  BaseType | undefined,
  string | undefined,
  string | undefined
>

export const ProcedureKind = Symbol('NeemataProcedure')

export interface TProcedureContract<
  Input extends BaseType,
  Output extends BaseType,
  Stream extends BaseType | undefined,
  Name extends string | undefined = undefined,
  Namespace extends string | undefined = undefined,
> {
  readonly [Kind]: typeof ProcedureKind
  readonly type: 'neemata:procedure'
  readonly name: Name
  readonly namespace: Namespace
  readonly input: Input
  readonly output: Output
  readonly stream: Stream
  readonly timeout?: number
}

export const ProcedureContract = <
  const Options extends {
    input?: BaseType
    output?: BaseType
    stream?: BaseType | undefined
    timeout?: number
    schemaOptions?: ContractSchemaOptions
    name?: string
  },
>(
  options: Options,
) => {
  const {
    input = t.never() as any,
    output = t.never() as any,
    stream = undefined as any,
    name = undefined as any,
    timeout,
    schemaOptions = {},
  } = options
  return createSchema<
    TProcedureContract<
      Options['input'] extends BaseType ? Options['input'] : t.NeverType,
      Options['output'] extends BaseType ? Options['output'] : t.NeverType,
      Options['stream'] extends BaseType ? Options['stream'] : undefined,
      Options['name'] extends string ? Options['name'] : undefined
    >
  >({
    ...schemaOptions,
    [Kind]: ProcedureKind,
    type: 'neemata:procedure',
    input,
    output,
    stream,
    name,
    timeout,
    namespace: undefined,
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
