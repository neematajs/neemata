import type { AnyCompatibleType, BaseType, BaseTypeAny, t } from '@nmtjs/type'
import { t as types } from '@nmtjs/type'

import type { ContractSchemaOptions } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export const SubscriptionKind = Symbol('NeemataSubscription')

export type SubscriptionParamsType = AnyCompatibleType<
  Record<string, string | number | boolean | null>
>

export type SubscriptionKey<Params extends BaseType> =
  Params extends t.NeverType
    ? undefined
    : (params: t.infer.decode.output<Params>) => string

export type TAnySubscriptionContract = TSubscriptionContract<
  any,
  Record<string, TAnyEventContract>,
  string
>

export type TAnySubscriptionEventContract = TSubscriptionEventContract<
  BaseTypeAny,
  string,
  TAnySubscriptionContract
>

export type SubscriptionParams<Contract extends TAnySubscriptionContract> =
  t.infer.decode.output<Contract['params']>

export type SubscriptionEventMessage<E extends TAnySubscriptionEventContract> =
  { event: E['event']; payload: t.infer.decode.output<E['payload']> }

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
  Payload extends BaseType = BaseTypeAny,
  Event extends string = string,
  Subscription = TAnySubscriptionContract,
> extends TEventContract<Payload> {
  readonly event: Event
  readonly subscription: Subscription
}

export interface TSubscriptionContract<
  Params extends BaseType = t.NeverType,
  Events extends Record<string, unknown> = {},
  Namespace extends string = string,
> {
  readonly [Kind]: typeof SubscriptionKind
  readonly type: 'neemata:subscription'
  readonly namespace: Namespace
  readonly params: Params
  readonly key: SubscriptionKey<Params>
  readonly events: {
    [K in keyof Events]: Events[K] extends TAnyEventContract
      ? TSubscriptionEventContract<
          Events[K]['payload'],
          Extract<K, string>,
          TSubscriptionContract<Params, Events, Namespace>
        >
      : never
  }
}

type SubscriptionContractBaseOptions<
  Namespace extends string,
  Events extends Record<string, TAnyEventContract>,
> = {
  namespace: Namespace
  events: Events
  schemaOptions?: ContractSchemaOptions
}

type SubscriptionContractNoParamsOptions<
  Namespace extends string,
  Events extends Record<string, TAnyEventContract>,
> = SubscriptionContractBaseOptions<Namespace, Events> & {
  params?: undefined
  key?: undefined
}

type SubscriptionContractWithParamsOptions<
  Namespace extends string,
  Params extends SubscriptionParamsType,
  Events extends Record<string, TAnyEventContract>,
> = SubscriptionContractBaseOptions<Namespace, Events> & {
  params: Params
  key: (params: t.infer.decode.output<Params>) => string
}

export function SubscriptionContract<
  const Namespace extends string,
  const Events extends Record<string, TAnyEventContract>,
>(
  options: SubscriptionContractNoParamsOptions<Namespace, Events>,
): TSubscriptionContract<t.NeverType, Events, Namespace>
export function SubscriptionContract<
  const Namespace extends string,
  const Params extends SubscriptionParamsType,
  const Events extends Record<string, TAnyEventContract>,
>(
  options: SubscriptionContractWithParamsOptions<Namespace, Params, Events>,
): TSubscriptionContract<Params, Events, Namespace>
export function SubscriptionContract(options: {
  namespace: string
  events: Record<string, TAnyEventContract>
  params?: BaseType
  key?: (params: any) => string
  schemaOptions?: ContractSchemaOptions
}) {
  const { schemaOptions = {} } = options
  const params = options.params ?? types.never()
  const events = {} as Record<string, TAnySubscriptionEventContract>
  const subscription = createSchema<any>({
    ...schemaOptions,
    [Kind]: SubscriptionKind,
    type: 'neemata:subscription',
    namespace: options.namespace,
    params,
    key: options.key,
    events,
  })

  for (const eventName in options.events) {
    const event = options.events[eventName]
    events[eventName] = createSchema<TAnySubscriptionEventContract>({
      ...event,
      event: eventName,
      subscription,
    })
  }

  return subscription
}

export function IsSubscriptionContract(
  contract: any,
): contract is TAnySubscriptionContract {
  return Kind in contract && contract[Kind] === SubscriptionKind
}
