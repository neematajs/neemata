import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { TSubscriptionContract } from '@neematajs/contract'

import { WorkerType } from './constants.ts'
import { BaseExtension } from './extension.ts'

export class Subscription<
  SubscriptionContract extends TSubscriptionContract = TSubscriptionContract,
> extends EventEmitter<
  {
    abort: [reason?: any]
    end: []
  } & {
    [K in 'event']: [
      eventName: keyof SubscriptionContract['events'],
      payload: SubscriptionContract['static']['events'][keyof SubscriptionContract['static']['events']],
    ]
  }
> {
  constructor(
    public readonly contract: SubscriptionContract,
    public readonly key: string,
    public readonly destroy: () => void,
  ) {
    super()
  }

  send<K extends Extract<keyof SubscriptionContract['events'], string>>(
    event: K,
    payload: SubscriptionContract['events'][K]['static'],
  ) {
    if (event in this.contract.events === false)
      throw new Error(`Event [${event}] is not defined in the contract`)
    return this.emit('event', event, payload)
  }
}

export abstract class BaseSubscriptionManager extends BaseExtension {
  abstract subscribe(subscription: Subscription): any
  abstract unsubscribe(subscription: Subscription): any
  abstract publish(key: string, event: string, payload: any): any

  serialize(
    contract: TSubscriptionContract,
    options: Record<string, string | number>,
  ): string {
    let value = ''
    const keys = Object.keys(options).sort()
    for (const key of keys) value += `${key}:${options[key]},`
    const hash = createHash('sha1').update(value).digest('base64url')
    return `${contract.serviceName}/${contract.name}:${hash}`
  }
}

export class BasicSubscriptionManager extends BaseSubscriptionManager {
  name = 'Basic subscription manager'

  protected readonly subscriptions = new Map<string, Set<Subscription<any>>>()

  subscribe(subscription: Subscription): any {
    let subs = this.subscriptions.get(subscription.key)
    if (!subs) {
      subs = new Set()
      this.subscriptions.set(subscription.key, subs)
    }
    subs.add(subscription)
  }

  unsubscribe(subscription: Subscription): any {
    const subs = this.subscriptions.get(subscription.key)
    if (!subs) return
    subs.delete(subscription)
    if (!subs.size) this.subscriptions.delete(subscription.key)
  }

  async publish(key: string, event: string, payload: any) {
    if (this.isApiWorker) this.emit(key, event, payload)
  }

  protected emit(key: string, event: string, payload: any) {
    this.logger.debug(payload, `Emitting event [${key}] - ${event}`)
    const subs = this.subscriptions.get(key)
    if (subs?.size) {
      for (const sub of subs) {
        sub.send(event, payload)
      }
    }
  }

  protected get logger() {
    return this.application.logger
  }

  protected get isApiWorker() {
    return this.application.type === WorkerType.Api
  }
}

export class SubscriptionResponse<
  T extends Subscription,
  PayloadType extends
    T['contract']['output']['static'] = T['contract']['output']['static'],
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
