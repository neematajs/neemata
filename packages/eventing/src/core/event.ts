import type {
  SubscriptionParams,
  SubscriptionPublishInput,
  TAnySubscriptionContract,
  TAnySubscriptionEventContract,
  TSubscriptionEventContract,
} from '@nmtjs/contract'
import type { t } from '@nmtjs/type'

export type EventingHeaders = Record<string, string>

export type AnyEventingEvent = TAnySubscriptionEventContract

export type EventingEvent = TSubscriptionEventContract

export type EventingEventChannel<E extends AnyEventingEvent> =
  E extends TSubscriptionEventContract<any, any, infer Channel>
    ? Channel extends TAnySubscriptionContract
      ? Channel
      : never
    : never

export type EventingEventParams<E extends AnyEventingEvent> =
  SubscriptionParams<EventingEventChannel<E>>

export type EventingEventInput<E extends AnyEventingEvent> = {
  payload: SubscriptionPublishInput<E>
  headers?: EventingHeaders
} & ([EventingEventParams<E>] extends [never]
  ? { params?: never }
  : { params: EventingEventParams<E> })

export type EventingEventOutput<E extends AnyEventingEvent> = {
  namespace: EventingEventChannel<E>['namespace']
  event: E['event']
  key?: string
  payload: t.infer.decode.output<E['payload']>
  headers: EventingHeaders
}
