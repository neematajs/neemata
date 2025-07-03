import { type BaseType, t } from '@nmtjs/type'
import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export type TAnyProcedureContract = TProcedureContract<
  BaseType,
  BaseType,
  BaseType,
  string | undefined,
  string | undefined
>

export const ProcedureKind = 'NeemataProcedure'

export interface TProcedureContract<
  Input extends BaseType = t.NeverType,
  Output extends BaseType = t.NeverType,
  Stream extends BaseType = t.NeverType,
  Name extends string | undefined = undefined,
  Namespace extends string | undefined = undefined,
> {
  [Kind]: typeof ProcedureKind
  type: 'neemata:procedure'
  name: Name
  namespace: Namespace
  input: Input
  output: Output
  timeout?: number
  stream: Stream
}

export const ProcedureContract = <
  Input extends BaseType = t.NeverType,
  Output extends BaseType = t.NeverType,
  Stream extends BaseType = t.NeverType,
  Name extends string | undefined = undefined,
>(options: {
  input?: Input
  output?: Output
  stream?: Stream
  timeout?: number
  schemaOptions?: ContractSchemaOptions
  name?: Name
}) => {
  const {
    input = t.never() as unknown as Input,
    output = t.never() as unknown as Output,
    stream = t.never() as unknown as Stream,
    timeout,
    schemaOptions = {},
    name,
  } = options
  return createSchema<TProcedureContract<Input, Output, Stream, Name>>({
    ...schemaOptions,
    [Kind]: ProcedureKind,
    type: 'neemata:procedure',
    input,
    output,
    stream,
    timeout,
    name: name as Name,
    namespace: undefined,
  })
}

export function IsProcedureContract(
  contract: any,
): contract is TAnyProcedureContract {
  return Kind in contract && contract[Kind] === ProcedureKind
}
