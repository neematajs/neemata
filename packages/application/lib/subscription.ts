import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { TSubscriptionContract } from '@nmtjs/contract'
import type { t } from '@nmtjs/type'

import { builtin } from './common.ts'
import { WorkerType } from './constants.ts'
import { createPlugin } from './plugin.ts'

type SubscriptionEvents<Contract extends TSubscriptionContract> = {
  abort: [reason?: any]
  end: []
} & {
  [K in 'event']: [
    eventName: keyof Contract['events'],
    payload: t.infer.decoded<
      Contract['events'][keyof Contract['events']]['payload']
    >,
  ]
}

export class Subscription<
  Contract extends TSubscriptionContract = TSubscriptionContract,
> extends EventEmitter<SubscriptionEvents<Contract>> {
  constructor(
    public readonly contract: Contract,
    public readonly key: string,
    public readonly destroy: () => void,
  ) {
    super()
  }

  send<K extends Extract<keyof Contract['events'], string>>(
    event: K,
    payload: t.infer.decoded<Contract['events'][K]['payload']>,
  ) {
    if (event in this.contract.events === false)
      throw new Error(`Event [${event}] is not defined in the contract`)
    return this.emit('event', event, payload)
  }
}

export interface SubscriptionManager {
  subscribe(subscription: Subscription): any
  unsubscribe(subscription: Subscription): any
  publish(key: string, event: string, payload: any): any

  serialize(
    contract: TSubscriptionContract,
    options: Record<string, string | number>,
  ): string
}

export const serialize: SubscriptionManager['serialize'] = (
  contract,
  options,
) => {
  let value = ''
  const keys = Object.keys(options).sort()
  for (const key of keys) value += `${key}:${options[key]}`
  const hash = createHash('sha1').update(value).digest('base64url')
  return `${contract.serviceName}/${contract.name}:${hash}`
}

export const basicSubManagerPlugin = createPlugin(
  'BasicSubscriptionManager',
  (app) => {
    const { logger, type, container } = app
    const isApiWorker = type === WorkerType.Api
    const subscriptions = new Map<string, Set<Subscription<any>>>()

    const subscribe = (subscription: Subscription) => {
      let subs = subscriptions.get(subscription.key)
      if (!subs) {
        subs = new Set()
        subscriptions.set(subscription.key, subs)
      }
      subs.add(subscription)
    }

    const unsubscribe = (subscription: Subscription) => {
      const subs = subscriptions.get(subscription.key)
      if (!subs) return
      subs.delete(subscription)
      if (!subs.size) subscriptions.delete(subscription.key)
    }

    const publish = (key: string, event: string, payload: any) => {
      if (isApiWorker) emit(key, event, payload)
    }

    const emit = (key: string, event: string, payload: any) => {
      logger.debug(payload, `Emitting event [${key}] - ${event}`)
      const subs = subscriptions.get(key)
      if (subs?.size) {
        for (const sub of subs) {
          sub.send(event, payload)
        }
      }
    }

    container.provide(builtin.subManager, {
      publish,
      subscribe,
      unsubscribe,
      serialize,
    })
  },
)

// This is just a little helper to provide stricter type-safety
export class SubscriptionResponse<
  T extends Subscription,
  PayloadType extends t.infer.decoded<
    T['contract']['output']
  > = t.infer.decoded<T['contract']['output']>,
  Payload = unknown,
> {
  readonly _!: {
    payload: PayloadType
  }

  payload!: Payload

  constructor(public readonly subscription: T) {}

  withPayload(payload: PayloadType) {
    // @ts-expect-error
    this.payload = payload
    return this as unknown as SubscriptionResponse<T, PayloadType, PayloadType>
  }
}
