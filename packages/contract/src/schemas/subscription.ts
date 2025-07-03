import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'

export const SubscriptionKind = 'NeemataSubscription'

export type SubcriptionOptions = Record<string, string | number | boolean>

export type TAnySubscriptionContract = TSubscriptionContract<
  SubcriptionOptions,
  Record<string, unknown>,
  string | undefined,
  string | undefined
>

export interface TSubscriptionContract<
  Options extends SubcriptionOptions = {},
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
  Namespace extends string | undefined = undefined,
> {
  [Kind]: typeof SubscriptionKind
  type: 'neemata:subscription'
  name: Name
  namespace: Namespace
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
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
>(options?: {
  events?: Events
  schemaOptions?: ContractSchemaOptions
  name?: Name
}) => {
  const { events = {} as Events, schemaOptions = {}, name } = options ?? {}

  const _events = {} as any
  for (const key in events) {
    const event = events[key]
    _events[key] = Object.assign({}, event, { subscription: name })
  }
  return {
    $withOptions: <Options extends SubcriptionOptions>() =>
      createSchema<TSubscriptionContract<Options, Events, Name>>({
        ...schemaOptions,
        [Kind]: SubscriptionKind,
        type: 'neemata:subscription',
        events: _events,
        name: name as Name,
        namespace: undefined,
        options: undefined as unknown as Options,
      }),
  }
}

export function IsSubscriptionContract(
  contract: any,
): contract is TAnySubscriptionContract {
  return Kind in contract && contract[Kind] === SubscriptionKind
}
