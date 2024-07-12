import { Kind, type TSchema } from '@sinclair/typebox/type'

import { type NeemataContractSchemaOptions, createSchema } from '../utils'

export const ProcedureKind = 'NeemataProcedure'

export interface TProcedureContract<
  // Name extends string = string,
  Input extends TSchema = TSchema,
  Output extends TSchema = TSchema,
> extends TSchema {
  [Kind]: typeof ProcedureKind
  static: {
    input: Input['static']
    output: Output['static']
  }
  type: 'neemata:procedure'
  // name: Name,
  input: Input
  output: Output
  timeout?: number
}

export const ProcedureContract = <
  // Name extends string,
  Input extends TSchema,
  Output extends TSchema,
  SOptions extends NeemataContractSchemaOptions,
>(
  // name: Name,
  input: Input,
  output: Output,
  timeout?: number,
  schemaOptions: SOptions = {} as SOptions,
) =>
  createSchema<
    TProcedureContract<
      // Name,
      Input,
      Output
    >
  >({
    ...schemaOptions,
    [Kind]: ProcedureKind,
    type: 'neemata:procedure',
    // name,
    input,
    output,
    timeout,
  })
