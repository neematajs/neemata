import type {
  TServiceContract,
  TSubscriptionContract,
} from '@neematajs/contract'
import { ContractGuard } from '@neematajs/contract/guards'
import type { Logger } from './logger'
import type { Registry } from './registry'
import { type BaseSubscriptionManager, Subscription } from './subscription'
import type { BaseTransportConnection } from './transport'

export class EventManager {
  constructor(
    private readonly application: {
      registry: Registry
      subManager: BaseSubscriptionManager
      logger: Logger
    },
  ) {}

  async subscribe<
    C extends TServiceContract,
    P extends keyof {
      [K in keyof C['procedures'] as C['procedures'][K]['output'] extends TSubscriptionContract
        ? K
        : never]: K
    },
    S extends
      TSubscriptionContract = C['procedures'][P]['output'] extends TSubscriptionContract
      ? C['procedures'][P]['output']
      : never,
  >(
    contract: C,
    procedure: Extract<P, string>,
    options: C['procedures'][P]['output'] extends TSubscriptionContract<
      infer Options
    >
      ? Options['static']
      : never,
    connection: BaseTransportConnection,
  ): Promise<{
    subscription: Subscription<S>
    isNew: boolean
  }> {
    if (!connection.services.has(contract.name)) {
      throw new Error('Service contract not found')
    }

    if (procedure in contract.procedures === false) {
      throw new Error('Procedure not found')
    }

    if (!ContractGuard.IsSubscription(contract.procedures[procedure].output)) {
      throw new Error('Procedure does not return a subscription contract')
    }

    const subscriptionKey = this.subManager.serialize(
      contract,
      procedure as string,
      options,
    )
    const { id, subscriptions } = connection
    let subscription = subscriptions.get(subscriptionKey)
    if (subscription) return { subscription, isNew: false } as any
    this.logger.debug(
      options,
      `Subscribing connection [${id}] to [${subscriptionKey}] with options`,
    )
    subscription = new Subscription(subscriptionKey)
    subscriptions.set(subscriptionKey, subscription)
    await this.subManager.subscribe(subscription)
    return { subscription, isNew: true } as any
  }

  async unsubscribe<
    C extends TServiceContract,
    P extends keyof {
      [K in keyof C['procedures'] as C['procedures'][K]['output'] extends TSubscriptionContract
        ? K
        : never]: K
    },
  >(
    contract: C,
    procedure: Extract<P, string>,
    options: C['procedures'][P]['output'] extends TSubscriptionContract<
      infer Options
    >
      ? Options['static']
      : never,
    connection: BaseTransportConnection,
  ): Promise<boolean> {
    const subscriptionKey = this.subManager.serialize(
      contract,
      procedure as string,
      options,
    )
    return this.unsubscribeByKey(subscriptionKey, connection)
  }

  async unsubscribeByKey(
    key: string,
    connection: BaseTransportConnection,
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

  async publish<
    C extends TServiceContract,
    P extends keyof {
      [K in keyof C['procedures'] as C['procedures'][K]['output'] extends TSubscriptionContract
        ? K
        : never]: K
    },
    S extends C['procedures'][P]['output'] extends TSubscriptionContract
      ? C['procedures'][P]['output']
      : never,
    E extends keyof S['events'],
  >(
    contract: C,
    procedure: Extract<P, string>,
    options: S['static']['options'],
    event: Extract<E, string>,
    payload: S['events'][E]['static'],
  ) {
    const subscriptionKey = this.subManager.serialize(
      contract,
      procedure as string,
      options,
    )
    this.logger.debug(payload, `Publishing event [${subscriptionKey}]`)
    return this.subManager.publish(subscriptionKey, event, payload)
  }

  async isSubscribed<
    C extends TServiceContract,
    P extends keyof {
      [K in keyof C['procedures'] as C['procedures'][K]['output'] extends TSubscriptionContract
        ? K
        : never]: K
    },
    S extends C['procedures'][P]['output'] extends TSubscriptionContract
      ? C['procedures'][P]['output']
      : never,
  >(
    contract: C,
    procedure: Extract<P, string>,
    options: S['static']['options'],
    connection: BaseTransportConnection,
  ) {
    const subscriptionKey = this.subManager.serialize(
      contract,
      procedure as string,
      options,
    )
    return connection.subscriptions.has(subscriptionKey)
  }

  private get subManager() {
    return this.application.subManager
  }

  private get logger() {
    return this.application.logger
  }

  private get registry() {
    return this.application.registry
  }
}
