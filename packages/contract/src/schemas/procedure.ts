import type { BaseType } from '@nmtjs/type'
import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export interface TBaseProcedureContract<
  Type extends string = string,
  Input extends BaseType = BaseType,
  Output extends BaseType = BaseType,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  Transports extends { [K in string]?: true } | undefined =
    | { [K in string]?: true }
    | undefined,
> {
  [Kind]: string
  type: Type
  name: Name
  serviceName: ServiceName
  transports: Transports
  input: Input
  output: Output
  timeout?: number
}

export const ProcedureKind = 'NeemataProcedure'

export interface TProcedureContract<
  Input extends BaseType = BaseType,
  Output extends BaseType = BaseType,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  Transports extends { [K in string]?: true } | undefined =
    | { [K in string]?: true }
    | undefined,
> extends TBaseProcedureContract<
    'neemata:procedure',
    Input,
    Output,
    Name,
    ServiceName,
    Transports
  > {
  [Kind]: typeof ProcedureKind
}

export const ProcedureContract = <
  Input extends BaseType,
  Output extends BaseType,
>(
  input: Input,
  output: Output,
  timeout?: number,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) => {
  return createSchema<TProcedureContract<Input, Output>>({
    ...schemaOptions,
    [Kind]: ProcedureKind,
    type: 'neemata:procedure',
    input,
    output,
    timeout,
    name: undefined,
    serviceName: undefined,
    transports: undefined,
  })
}

export function IsProcedureContract(
  contract: any,
): contract is TProcedureContract {
  return Kind in contract && contract[Kind] === ProcedureKind
}
