import type { BaseType } from '@nmtjs/type'
import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TEventContract } from './event.ts'
import type { TBaseProcedureContract } from './procedure.ts'

export const SubscriptionKind = 'NeemataSubscription'

export type SubcriptionOptions = Record<string, string | number>

export interface TSubscriptionContract<
  Input extends BaseType = BaseType,
  Output extends BaseType = BaseType,
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
  [Kind]: typeof SubscriptionKind
  options: Options
  events: Events
}

export const SubscriptionContract = <
  Input extends BaseType = BaseType,
  Output extends BaseType = BaseType,
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
        [Kind]: SubscriptionKind,
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

export function IsSubscriptionContract(
  contract: any,
): contract is TSubscriptionContract {
  return Kind in contract && contract[Kind] === SubscriptionKind
}
