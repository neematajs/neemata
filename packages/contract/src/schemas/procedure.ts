import type { BaseType } from '@nmtjs/type'
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
  type: Type
  name: Name
  serviceName: ServiceName
  transports: Transports
  input: Input
  output: Output
  timeout?: number
}

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
  > {}

export const ProcedureContract = <
  Input extends BaseType,
  Output extends BaseType,
>(
  input: Input,
  output: Output,
  timeout?: number,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
): TProcedureContract<Input, Output> => {
  return {
    ...schemaOptions,
    type: 'neemata:procedure',
    input,
    output,
    timeout,
    name: undefined,
    serviceName: undefined,
    transports: undefined,
  }
}
