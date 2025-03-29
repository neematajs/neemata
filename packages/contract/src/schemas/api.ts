import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TAnyNamespaceContract, TNamespaceContract } from './namespace.ts'

export const APIKind = 'NeemataAPI'

export type TAnyAPIContract = TAPIContract<Record<string, any>>

export interface TAPIContract<Namespaces extends Record<string, unknown> = {}> {
  [Kind]: typeof APIKind
  type: 'neemata:api'
  namespaces: {
    [K in keyof Namespaces]: Namespaces[K] extends TAnyNamespaceContract
      ? TNamespaceContract<
          Namespaces[K]['procedures'],
          Namespaces[K]['subscriptions'],
          Namespaces[K]['events'],
          Extract<K, string>
        >
      : never
  }
  timeout?: number
}

export const APIContract = <
  Namespaces extends Record<string, unknown> = {},
>(options?: {
  namespaces?: Namespaces
  timeout?: number
  schemaOptions?: ContractSchemaOptions
}) => {
  const { namespaces = {}, timeout = 1000, schemaOptions = {} } = options || {}

  const _namespaces = {} as any

  for (const namespaceKey in namespaces) {
    const namespace = namespaces[namespaceKey]
    const _procedures = {} as any
    for (const procedureKey in namespace.procedures) {
      const procedure = namespace.procedures[procedureKey]
      _procedures[procedureKey] = Object.assign({}, procedure, {
        name: procedureKey,
        namespace: namespaceKey,
      })
    }

    const _subscriptions = {} as any
    for (const subscriptionKey in namespace.subscriptions) {
      const subscription = namespace.subscriptions[subscriptionKey]
      const _events = {} as any
      for (const eventKey in subscription.events) {
        const event = subscription.events[eventKey]
        _events[eventKey] = Object.assign({}, event, {
          name: eventKey,
          namespace: namespaceKey,
          subscription: subscriptionKey,
        })
      }
      _subscriptions[subscriptionKey] = Object.assign({}, subscription, {
        name: subscriptionKey,
        namespace: namespaceKey,
        events: _events,
      })
    }

    const _events = {} as any
    for (const eventKey in namespace.events) {
      const event = namespace.events[eventKey]
      _events[eventKey] = Object.assign({}, event, {
        name: eventKey,
        namespace: namespaceKey,
      })
    }

    _namespaces[namespaceKey] = Object.assign({}, namespace, {
      name: namespaceKey,
      procedures: _procedures,
      subscriptions: _subscriptions,
      events: _events,
    })
  }

  return createSchema<TAPIContract<Namespaces>>({
    ...schemaOptions,
    [Kind]: APIKind,
    type: 'neemata:api',
    namespaces: _namespaces,
    timeout,
  })
}

export function IsAPIContract(value: any): value is TAnyAPIContract {
  return Kind in value && value[Kind] === APIKind
}
