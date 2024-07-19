import { Kind, type TSchema } from '@sinclair/typebox/type'

import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export const ProcedureKind = 'NeemataProcedure'

export interface TBaseProcedureContract<
  Input extends TSchema = TSchema,
  Output extends TSchema = TSchema,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  Transports extends { [K in string]?: true } | undefined =
    | { [K in string]?: true }
    | undefined,
> extends TSchema {
  name: Name
  serviceName: ServiceName
  transports: Transports
  input: Input
  output: Output
  timeout?: number
}

export interface TProcedureContract<
  Input extends TSchema = TSchema,
  Output extends TSchema = TSchema,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  Transports extends { [K in string]?: true } | undefined =
    | { [K in string]?: true }
    | undefined,
> extends TBaseProcedureContract<Input, Output, Name, ServiceName, Transports> {
  [Kind]: typeof ProcedureKind
  type: 'neemata:procedure'
  static: {
    input: Input['static']
    output: Output['static']
  }
  name: Name
  serviceName: ServiceName
  transports: Transports
  input: Input
  output: Output
  timeout?: number
}

export const ProcedureContract = <
  Input extends TSchema,
  Output extends TSchema,
>(
  input: Input,
  output: Output,
  timeout?: number,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) =>
  createSchema<TProcedureContract<Input, Output>>({
    ...schemaOptions,
    [Kind]: ProcedureKind,
    type: 'neemata:procedure',
    input,
    output,
    timeout,
  })
