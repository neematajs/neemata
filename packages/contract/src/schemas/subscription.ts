import type { Schema, WireSchema } from '@nmtjs/common/schema'
import { isSchema } from '@nmtjs/common/schema'

import type { ContractSchemaOptions } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export const SubscriptionKind = Symbol('NeemataSubscription')

export type SubscriptionParamsType = Schema<
  unknown,
  Record<string, string | number | boolean | null>
>

export type SubscriptionKey<Params extends Schema | undefined> =
  Params extends undefined
    ? undefined
    : Params extends Schema
      ? (params: Schema.Output<Params>) => string
      : never

export type TAnySubscriptionContract = TSubscriptionContract<
  any,
  Record<string, TAnyEventContract>,
  string
>

export type TAnySubscriptionEventContract = TSubscriptionEventContract<
  WireSchema.Codec | undefined,
  string,
  TAnySubscriptionContract
>

export type SubscriptionParams<Contract extends TAnySubscriptionContract> =
  Contract['params'] extends Schema
    ? Schema.Input<Contract['params']>
    : undefined

export type SubscriptionEventMessage<E extends TAnySubscriptionEventContract> =
  E['payload'] extends WireSchema.Codec
    ? { event: E['event']; payload: WireSchema.DecodeOutput<E['payload']> }
    : { event: E['event']; payload: undefined }

export type SubscriptionPublishInput<E extends TAnySubscriptionEventContract> =
  E['payload'] extends WireSchema.Codec
    ? WireSchema.EncodeInput<E['payload']>
    : undefined

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
  Payload extends WireSchema.Codec | undefined = WireSchema.Codec | undefined,
  Event extends string = string,
  Subscription = TAnySubscriptionContract,
> extends TEventContract<Payload> {
  readonly event: Event
  readonly subscription: Subscription
}

export interface TSubscriptionContract<
  Params extends Schema | undefined = undefined,
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
  key: (params: Schema.Output<Params>) => string
}

export function SubscriptionContract<
  const Namespace extends string,
  const Events extends Record<string, TAnyEventContract>,
>(
  options: SubscriptionContractNoParamsOptions<Namespace, Events>,
): TSubscriptionContract<undefined, Events, Namespace>
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
  params?: Schema
  key?: (params: any) => string
  schemaOptions?: ContractSchemaOptions
}) {
  const { schemaOptions = {} } = options
  const params = options.params
  if (params !== undefined && !isSchema(params)) {
    throw new TypeError('Subscription params must be a Standard Schema')
  }
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
