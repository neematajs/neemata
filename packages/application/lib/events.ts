import type { TSubscriptionContract } from '@nmtjs/contract'
import type { t } from '@nmtjs/type'

import { builtin } from './common.ts'
import type { Connection } from './connection.ts'
import { Hook } from './constants.ts'
import type { Container } from './container.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'
import { Subscription, type SubscriptionManager } from './subscription.ts'

export class EventManager {
  subManager!: SubscriptionManager

  constructor(
    private readonly application: {
      registry: Registry
      container: Container
      logger: Logger
    },
  ) {
    this.registry.registerHook(Hook.AfterInitialize, async () => {
      this.subManager = await this.application.container.resolve(
        builtin.subManager,
      )
    })
  }

  async subscribe<C extends TSubscriptionContract>(
    contract: C,
    options: C['options'],
    connection: Connection,
  ): Promise<{
    subscription: Subscription<C>
    isNew: boolean
  }> {
    if (!connection.services.has(contract.serviceName!)) {
      throw new Error('Service contract not found')
    }

    const subscriptionKey = this.subManager.serialize(contract, options)
    const { id, subscriptions } = connection
    let subscription = subscriptions.get(subscriptionKey)
    if (subscription) return { subscription, isNew: false } as any
    this.logger.debug(
      options,
      `Subscribing connection [${id}] to [${subscriptionKey}] with options`,
    )
    const destroyFn = (error?: any) => {
      if (error) subscription!.emit('abort', error)
      subscription!.emit('end')
      this.unsubscribeByKey(subscriptionKey, connection)
    }
    subscription = new Subscription<TSubscriptionContract>(
      contract,
      subscriptionKey,
      destroyFn,
    )
    subscriptions.set(subscriptionKey, subscription)
    await this.subManager.subscribe(subscription)
    return { subscription, isNew: true } as any
  }

  async unsubscribe<C extends TSubscriptionContract>(
    contract: C,
    options: C['options'],
    connection: Connection,
  ): Promise<boolean> {
    const subscriptionKey = this.subManager.serialize(contract, options)
    return this.unsubscribeByKey(subscriptionKey, connection)
  }

  async unsubscribeByKey(
    key: string,
    connection: Connection,
  ): Promise<boolean> {
    const { id, subscriptions } = connection
    this.logger.debug(`Unsubscribing connection [${id}] from event [${key}]`)
    const subscription = subscriptions.get(key)
    if (!subscription) return false
    await this.subManager.unsubscribe(subscription)
    subscription.emit('end')
    subscriptions.delete(key)
    return true
  }

  async publish<C extends TSubscriptionContract, E extends keyof C['events']>(
    contract: C,
    options: C['options'],
    event: Extract<E, string>,
    payload: t.infer.input.decoded<C['events'][E]['payload']>,
  ) {
    const subscriptionKey = this.subManager.serialize(contract, options)
    this.logger.debug(payload, `Publishing event [${subscriptionKey}]`)
    return this.subManager.publish(subscriptionKey, event, payload)
  }

  async isSubscribed<C extends TSubscriptionContract>(
    contract: C,
    options: C['options'],
    connection: Connection,
  ) {
    const subscriptionKey = this.subManager.serialize(contract, options)
    return connection.subscriptions.has(subscriptionKey)
  }

  private get logger() {
    return this.application.logger
  }

  private get registry() {
    return this.application.registry
  }
}
