import type { BaseTypeAny } from '@nmtjs/type'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TEventContract } from './event.ts'
import type { TBaseProcedureContract } from './procedure.ts'

export type SubcriptionOptions = Record<string, string | number>

export interface TSubscriptionContract<
  Input extends BaseTypeAny = BaseTypeAny,
  Output extends BaseTypeAny = BaseTypeAny,
  Options extends SubcriptionOptions = SubcriptionOptions,
  Events extends Record<string, TEventContract> = Record<
    string,
    TEventContract
  >,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  Transports extends { [K in string]?: true } | undefined =
    | { [K in string]?: true }
    | undefined,
> extends TBaseProcedureContract<
    'neemata:subscription',
    Input,
    Output,
    Name,
    ServiceName,
    Transports
  > {
  options: Options
  events: Events
}

export const SubscriptionContract = <
  Input extends BaseTypeAny = BaseTypeAny,
  Output extends BaseTypeAny = BaseTypeAny,
  Events extends Record<string, TEventContract> = Record<
    string,
    TEventContract
  >,
>(
  input: Input,
  output: Output,
  events: Events,
  timeout?: number,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) => {
  return {
    $withOptions: <Options extends SubcriptionOptions>() =>
      createSchema<TSubscriptionContract<Input, Output, Options, Events>>({
        ...schemaOptions,
        type: 'neemata:subscription',
        input,
        output,
        events,
        timeout,
        options: undefined as unknown as Options,
        name: undefined,
        serviceName: undefined,
        transports: undefined,
      }),
  }
}
