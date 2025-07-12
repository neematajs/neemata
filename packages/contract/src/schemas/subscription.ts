import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'

export const SubscriptionKind = Symbol('NeemataSubscription')

export type SubcriptionOptions = Record<
  string,
  string | number | boolean
> | null

export type TAnySubscriptionContract = TSubscriptionContract<
  SubcriptionOptions,
  Record<string, TAnyEventContract>,
  string | undefined
>

export interface TSubscriptionContract<
  Options extends SubcriptionOptions = null,
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
> {
  readonly [Kind]: typeof SubscriptionKind
  readonly type: 'neemata:subscription'
  readonly name: Name
  readonly options: Options
  readonly events: {
    [K in keyof Events]: Events[K] extends TAnyEventContract
      ? TEventContract<Events[K]['payload'], Extract<K, string>, Name>
      : never
  }
}

const _SubscriptionContract = <
  const Options extends {
    events: Record<string, TAnyEventContract>
    name?: string
    schemaOptions?: ContractSchemaOptions
  },
  SubOpt extends SubcriptionOptions = null,
>(
  options: Options,
) => {
  const { schemaOptions = {}, name } = options
  const _events = {} as any
  for (const key in options.events) {
    const event = options.events[key]
    _events[key] = createSchema<
      TEventContract<
        (typeof event)['payload'],
        Extract<typeof key, string>,
        undefined,
        Options['name'] extends string ? Options['name'] : undefined
      >
    >({
      ...event,
      name: key,
      namespace: undefined,
      subscription: name as any,
    })
  }
  return createSchema<
    TSubscriptionContract<
      SubOpt,
      Options['events'],
      Options['name'] extends string ? Options['name'] : undefined
    >
  >({
    ...schemaOptions,
    [Kind]: SubscriptionKind,
    type: 'neemata:subscription',
    events: _events,
    name: name as any,
    options: undefined as unknown as SubOpt,
  })
}

export const SubscriptionContract = Object.assign(_SubscriptionContract, {
  withOptions: <Options extends SubcriptionOptions>() => {
    return <
      T extends {
        events: Record<string, TAnyEventContract>
        name?: string
        schemaOptions?: ContractSchemaOptions
      },
    >(
      options: T,
    ) => _SubscriptionContract<T, Options>(options)
  },
})

export function IsSubscriptionContract(
  contract: any,
): contract is TAnySubscriptionContract {
  return Kind in contract && contract[Kind] === SubscriptionKind
}
