import type { BaseType, t } from '@nmtjs/type'
import { t as types } from '@nmtjs/type'

import type { ContractSchemaOptions } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'
import { Kind } from '../constants.ts'
import { concatFullName, createSchema } from '../utils.ts'

export const SubscriptionKind = Symbol('NeemataSubscription')

export type TAnySubscriptionContract = TSubscriptionContract<
  any,
  Record<string, TAnyEventContract>,
  string | undefined
>

export type TAnySubscriptionEventContract = TSubscriptionEventContract<
  any,
  string | undefined,
  TAnySubscriptionContract
>

export type SubscriptionParams<Contract extends TAnySubscriptionContract> =
  t.infer.decode.output<Contract['params']>

export type SubscriptionEventMessage<E extends TAnySubscriptionEventContract> =
  { event: E['name']; data: t.infer.decode.output<E['payload']> }

export type SubscriptionPublishInput<E extends TAnySubscriptionEventContract> =
  t.infer.encode.input<E['payload']>

export type SubscriptionEventUnion<
  Events extends Record<string, TAnySubscriptionEventContract>,
> = {
  [K in keyof Events]: SubscriptionEventMessage<Events[K]>
}[keyof Events]

export type SubscriptionSelectedEventUnion<
  Contract extends TAnySubscriptionContract,
  Events extends Partial<Record<keyof Contract['events'], true>>,
> = {} extends Events
  ? SubscriptionEventUnion<Contract['events']>
  : {
      [K in keyof Events]: K extends keyof Contract['events']
        ? SubscriptionEventMessage<Contract['events'][K]>
        : never
    }[keyof Events]

export interface TSubscriptionEventContract<
  Payload extends BaseType = BaseType,
  Name extends string | undefined = string | undefined,
  Subscription extends TAnySubscriptionContract = TAnySubscriptionContract,
> extends TEventContract<Payload, Name, undefined> {
  readonly subscription: Subscription
}

export interface TSubscriptionContract<
  Params extends BaseType = t.NeverType,
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
> {
  readonly [Kind]: typeof SubscriptionKind
  readonly type: 'neemata:subscription'
  readonly name: Name
  readonly params: Params
  readonly channel: (params: t.infer.decode.output<Params>) => string
  readonly events: {
    [K in keyof Events]: Events[K] extends TAnyEventContract
      ? TSubscriptionEventContract<
          Events[K]['payload'],
          Name extends string
            ? `${Name}/${Extract<K, string>}`
            : Extract<K, string>,
          TSubscriptionContract<Params, Events, Name>
        >
      : never
  }
}

export const SubscriptionContract = <
  const Options extends {
    events: Record<string, TAnyEventContract>
    channel: (params: any) => string
    params?: BaseType
    name?: string
    schemaOptions?: ContractSchemaOptions
  },
>(
  options: Options,
) => {
  type Params = Options['params'] extends BaseType
    ? Options['params']
    : t.NeverType
  type Name = Options['name'] extends string ? Options['name'] : undefined
  type Contract = TSubscriptionContract<Params, Options['events'], Name>

  const { schemaOptions = {} } = options
  const name = options.name as Name
  const params = (options.params ?? types.never()) as Params
  const events = {} as any
  const subscription = createSchema<Contract>({
    ...schemaOptions,
    [Kind]: SubscriptionKind,
    type: 'neemata:subscription',
    name,
    params,
    channel: options.channel,
    events,
  })

  for (const key in options.events) {
    const event = options.events[key]
    const fullName = concatFullName(name, key)
    events[key] = createSchema({
      ...event,
      name: fullName,
      subscription,
    }) as Contract['events'][Extract<keyof Options['events'], string>]
  }

  return subscription
}

export function IsSubscriptionContract(
  contract: any,
): contract is TAnySubscriptionContract {
  return Kind in contract && contract[Kind] === SubscriptionKind
}
