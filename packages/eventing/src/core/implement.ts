import type { MaybePromise } from '@nmtjs/common'
import type {
  TAnySubscriptionContract,
  TAnySubscriptionEventContract,
} from '@nmtjs/contract'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'

import type {
  EventingAdapterDeadLetterOptions,
  EventingAdapterMessage,
} from './adapter.ts'
import type { EventingConsumerRetryPolicy } from './consumer.ts'
import type { EventingEventOutput } from './event.ts'

export type EventingSubscriptionUnhandledPolicy = 'ignore' | 'fail'

export type EventingSubscriptionHandler<
  E extends TAnySubscriptionEventContract,
  Deps extends Dependencies,
> = (
  ctx: DependencyContext<Deps>,
  event: EventingEventOutput<E>,
  message: EventingAdapterMessage,
) => MaybePromise<void>

export type EventingSubscriptionHandlerDefinition<
  E extends TAnySubscriptionEventContract = TAnySubscriptionEventContract,
  Deps extends Dependencies = Dependencies,
> = Dependant<Deps> & {
  event: E
  retry?: EventingConsumerRetryPolicy
  handler: EventingSubscriptionHandler<E, Deps>
}

export type AnyEventingSubscriptionHandlerDefinition =
  EventingSubscriptionHandlerDefinition<any, any>

export type EventingSubscriptionConsumerOptions = {
  groupId: string
  consumerId?: string
  from?: 'latest' | 'earliest' | 'committed'
  retry?: EventingConsumerRetryPolicy
  recoverPending?: boolean
  deadLetter?: EventingAdapterDeadLetterOptions
  unhandled?: EventingSubscriptionUnhandledPolicy
}

export type EventingSubscriptionConsumerDefinition<
  Contract extends TAnySubscriptionContract = TAnySubscriptionContract,
> = EventingSubscriptionConsumerOptions & {
  subscription: Contract
  handlers: Partial<{
    [K in keyof Contract['events']]: EventingSubscriptionHandlerDefinition<
      Contract['events'][K],
      any
    >
  }>
}

export type AnyEventingSubscriptionConsumerDefinition =
  EventingSubscriptionConsumerDefinition<any>

export type CreateEventingSubscriptionHandlerParams<
  E extends TAnySubscriptionEventContract,
  Deps extends Dependencies,
> =
  | {
      dependencies?: Deps
      retry?: EventingConsumerRetryPolicy
      handler: EventingSubscriptionHandler<E, Deps>
    }
  | EventingSubscriptionHandler<E, Deps>

export type EventingSubscriptionEventImplementer<
  E extends TAnySubscriptionEventContract,
> = <Deps extends Dependencies>(
  paramsOrHandler: CreateEventingSubscriptionHandlerParams<E, Deps>,
) => EventingSubscriptionHandlerDefinition<E, Deps>

export type EventingSubscriptionImplementedHandlers<
  Contract extends TAnySubscriptionContract,
> = Partial<{
  [K in keyof Contract['events']]: EventingSubscriptionHandlerDefinition<
    Contract['events'][K],
    any
  >
}>

export type EventingSubscriptionImplementer<
  Contract extends TAnySubscriptionContract,
> = ((
  handlers: EventingSubscriptionImplementedHandlers<Contract>,
  options: EventingSubscriptionConsumerOptions,
) => EventingSubscriptionConsumerDefinition<Contract>) & {
  readonly [K in keyof Contract['events']]: EventingSubscriptionEventImplementer<
    Contract['events'][K]
  >
}

export function implement<Contract extends TAnySubscriptionContract>(
  contract: Contract,
): EventingSubscriptionImplementer<Contract> {
  const builder = (
    handlers: EventingSubscriptionImplementedHandlers<Contract>,
    options: EventingSubscriptionConsumerOptions,
  ) => {
    validateHandlers(contract, handlers)
    return Object.freeze({
      subscription: contract,
      handlers: Object.freeze({ ...handlers }),
      ...options,
    }) as EventingSubscriptionConsumerDefinition<Contract>
  }

  for (const [eventName, event] of Object.entries(contract.events)) {
    Object.defineProperty(builder, eventName, {
      value: createEventImplementer(event),
      enumerable: true,
      configurable: true,
    })
  }

  return Object.freeze(builder) as EventingSubscriptionImplementer<Contract>
}

export function isEventingSubscriptionConsumerDefinition(
  value: unknown,
): value is AnyEventingSubscriptionConsumerDefinition {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'subscription' in value &&
    'handlers' in value,
  )
}

function createEventImplementer<E extends TAnySubscriptionEventContract>(
  event: E,
): EventingSubscriptionEventImplementer<E> {
  return ((
    paramsOrHandler: CreateEventingSubscriptionHandlerParams<E, any>,
  ) => {
    const {
      dependencies = {},
      retry,
      handler,
    } = typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

    return Object.freeze({ event, dependencies, retry, handler })
  }) as EventingSubscriptionEventImplementer<E>
}

function validateHandlers(
  contract: TAnySubscriptionContract,
  handlers: Record<
    string,
    AnyEventingSubscriptionHandlerDefinition | undefined
  >,
) {
  const expectedKeys = new Set(Object.keys(contract.events))

  for (const eventName of Object.keys(handlers)) {
    if (!expectedKeys.has(eventName)) {
      throw new Error(`Unknown subscription event handler [${eventName}]`)
    }
  }

  for (const [eventName, handler] of Object.entries(handlers)) {
    if (!handler) continue
    if (handler.event !== contract.events[eventName]) {
      throw new Error(
        `Subscription event handler [${eventName}] does not match contract`,
      )
    }
  }
}
