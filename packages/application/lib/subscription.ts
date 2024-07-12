import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  TServiceContract,
  TSubscriptionContract,
} from '@neematajs/contract'
import { WorkerType } from './constants'
import { BaseExtension } from './extension'

export class Subscription<
  Contract extends TSubscriptionContract = TSubscriptionContract,
> extends EventEmitter<
  {
    [K in 'abort' | 'end']: []
  } & {
    [K in 'neemata:event']: [
      keyof Contract['events'],
      Contract['static']['events'][keyof Contract['static']['events']],
    ]
  }
> {
  readonly _!: {
    contract: Contract
  }

  constructor(public readonly key: string) {
    super()
  }

  send<K extends Extract<keyof Contract['static']['events'], string>>(
    event: K,
    payload: Contract['static']['events'][K],
  ) {
    return this.emit('neemata:event', event, payload)
  }
}

export abstract class BaseSubscriptionManager extends BaseExtension {
  abstract subscribe(subscription: Subscription): any
  abstract unsubscribe(subscription: Subscription): any
  abstract publish(key: string, event: string, payload: any): any

  serialize(
    contract: TServiceContract,
    procedureName: string,
    options: Record<string, string | number>,
  ): string {
    let value = ''
    const keys = Object.keys(options).sort()
    for (const key of keys) value += `${key}:${options[key]},`
    const hash = createHash('sha1').update(value).digest('base64url')
    return `${contract.name}/${procedureName}:${hash}`
  }
}

export class BasicSubscriptionManager extends BaseSubscriptionManager {
  name = 'Basic subscription manager'

  protected readonly subscriptions = new Map<string, Set<Subscription>>()

  subscribe(subscription: Subscription): any {
    let subscriptions = this.subscriptions.get(subscription.key)
    if (!subscriptions) {
      subscriptions = new Set()
      this.subscriptions.set(subscription.key, subscriptions)
    }
    subscriptions.add(subscription)
  }

  unsubscribe(subscription: Subscription): any {
    const subscriptions = this.subscriptions.get(subscription.key)
    if (!subscriptions) return
    subscriptions.delete(subscription)
    if (!subscriptions.size) this.subscriptions.delete(subscription.key)
  }

  async publish(key: string, event: string, payload: any) {
    if (this.isApiWorker) this.emit(key, event, payload)
  }

  protected emit(key: string, event: string, payload: any) {
    this.logger.debug(payload, `Emitting event [${key}] - ${event}`)
    const subscriptions = this.subscriptions.get(key)
    if (subscriptions?.size) {
      for (const subscription of subscriptions) {
        subscription.send(event, payload)
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
