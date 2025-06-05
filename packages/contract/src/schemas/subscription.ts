import { type BaseType, t } from '@nmtjs/type'
import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'
import type { TBaseProcedureContract } from './procedure.ts'

export const SubscriptionKind = 'NeemataSubscription'

export type SubcriptionOptions = Record<string, string | number | boolean>

export type TAnySubscriptionContract = TSubscriptionContract<
  BaseType,
  BaseType,
  SubcriptionOptions,
  Record<string, unknown>,
  string | undefined,
  string | undefined
>

export interface TSubscriptionContract<
  Input extends BaseType = t.NeverType,
  Output extends BaseType = t.NeverType,
  Options extends SubcriptionOptions = {},
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
  Namespace extends string | undefined = undefined,
> extends TBaseProcedureContract<
    'neemata:subscription',
    Input,
    Output,
    Name,
    Namespace
  > {
  [Kind]: typeof SubscriptionKind
  options: Options
  events: {
    [K in keyof Events]: Events[K] extends TAnyEventContract
      ? TEventContract<
          Events[K]['payload'],
          Extract<K, string>,
          Name,
          Namespace
        >
      : never
  }
}

export const SubscriptionContract = <
  Input extends BaseType = t.NeverType,
  Output extends BaseType = t.NeverType,
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
>(options?: {
  input?: Input
  output?: Output
  events?: Events
  timeout?: number
  schemaOptions?: ContractSchemaOptions
  name?: Name
}) => {
  const {
    input = t.never() as unknown as Input,
    output = t.never() as unknown as Output,
    events = {} as Events,
    timeout,
    schemaOptions = {},
    name,
  } = options ?? {}

  const _events = {} as any
  for (const key in events) {
    const event = events[key]
    _events[key] = Object.assign({}, event, { subscription: name })
  }
  return {
    $withOptions: <Options extends SubcriptionOptions>() =>
      createSchema<TSubscriptionContract<Input, Output, Options, Events, Name>>(
        {
          ...schemaOptions,
          [Kind]: SubscriptionKind,
          type: 'neemata:subscription',
          input,
          output,
          events: _events,
          timeout,
          name: name as Name,
          namespace: undefined,
          options: undefined as unknown as Options,
        },
      ),
  }
}

export function IsSubscriptionContract(
  contract: any,
): contract is TAnySubscriptionContract {
  return Kind in contract && contract[Kind] === SubscriptionKind
}
