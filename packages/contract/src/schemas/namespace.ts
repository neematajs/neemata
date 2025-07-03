import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'
import type { TAnyProcedureContract, TProcedureContract } from './procedure.ts'
// import type {
//   TAnySubscriptionContract,
//   TSubscriptionContract,
// } from './subscription.ts'

export const NamespaceKind = 'NeemataNamespace'

export type TAnyNamespaceContract = TNamespaceContract<
  Record<string, any>,
  // Record<string, any>,
  Record<string, any>,
  string | undefined
>

export interface TNamespaceContract<
  Procedures extends Record<string, unknown> = {},
  // Subscriptions extends Record<string, unknown> = {},
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
> {
  [Kind]: typeof NamespaceKind
  type: 'neemata:namespace'
  name: Name
  procedures: {
    [K in keyof Procedures]: Procedures[K] extends TAnyProcedureContract
      ? TProcedureContract<
          Procedures[K]['input'],
          Procedures[K]['output'],
          Procedures[K]['stream'],
          Extract<K, string>,
          Name
        >
      : never
  }
  subscriptions: {
    // [K in keyof Subscriptions]: Subscriptions[K] extends TAnySubscriptionContract
    //   ? TSubscriptionContract<
    //       Subscriptions[K]['input'],
    //       Subscriptions[K]['output'],
    //       Subscriptions[K]['options'],
    //       {
    //         [E in keyof Subscriptions[K]['events']]: Subscriptions[K]['events'][E] extends TAnyEventContract
    //           ? TEventContract<
    //               Subscriptions[K]['events'][E]['payload'],
    //               Extract<E, string>,
    //               Extract<K, string>,
    //               Name
    //             >
    //           : never
    //       },
    //       Extract<K, string>,
    //       Name
    //     >
    //   : never
  }
  events: {
    [K in keyof Events]: Events[K] extends TAnyEventContract
      ? TEventContract<
          Events[K]['payload'],
          Extract<K, string>,
          undefined,
          Name
        >
      : never
  }
  timeout?: number
}

export const NamespaceContract = <
  Procedures extends Record<string, unknown> = {},
  Subscriptions extends Record<string, unknown> = {},
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
>(options?: {
  procedures?: Procedures
  subscriptions?: Subscriptions
  events?: Events
  name?: Name
  timeout?: number
  schemaOptions?: ContractSchemaOptions
}) => {
  const {
    procedures = {} as Procedures,
    subscriptions = {} as Subscriptions,
    events = {} as Events,
    name,
    timeout,
    schemaOptions = {} as ContractSchemaOptions,
  } = options ?? {}
  const _events = {} as any

  for (const eventKey in events) {
    const event = events[eventKey]
    _events[eventKey] = Object.assign({}, event, {
      name: eventKey,
      namespace: options?.name,
    })
  }

  const _procedures = {} as any
  for (const procedureKey in procedures) {
    const procedure: any = procedures[procedureKey]
    _procedures[procedureKey] = Object.assign({}, procedure, {
      name: procedureKey,
      namespace: options?.name,
    })
  }

  const _subscriptions = {} as any
  for (const subscriptionKey in subscriptions) {
    const subscription: any = subscriptions[subscriptionKey]
    const _events = {} as any

    for (const eventKey in subscription.events) {
      const event = subscription.events[eventKey]
      _events[eventKey] = Object.assign({}, event, {
        name: eventKey,
        subscription: subscriptionKey,
        namespace: options?.name,
      })
    }

    _subscriptions[subscriptionKey] = Object.assign({}, subscription, {
      name: subscriptionKey,
      namespace: options?.name,
      events: _events,
    })
  }

  return createSchema<
    TNamespaceContract<
      Procedures,
      // Subscriptions,
      Events,
      Name
    >
  >({
    ...schemaOptions,
    [Kind]: NamespaceKind,
    type: 'neemata:namespace',
    name: name as Name,
    procedures: _procedures,
    // subscriptions: _subscriptions,
    subscriptions: {},
    events: _events,
    timeout,
  })
}

export function IsNamespaceContract(
  value: any,
): value is TAnyNamespaceContract {
  return Kind in value && value[Kind] === NamespaceKind
}
