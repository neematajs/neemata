import { createHash } from 'node:crypto'
import type { BaseParser } from './api'
import type { Logger } from './logger'
import type { Registry } from './registry'
import { type BaseSubscriptionManager, Subscription } from './subscription'
import type { BaseTransportConnection } from './transport'
import type { AnyEvent, InferSchemaInput, InferSchemaOutput } from './types'

export type EventOptionsType = Record<string, string | number>

export class Event<EventPayload, EventOptions extends EventOptionsType = {}> {
  readonly _!: {
    payload: EventPayload
    options: EventOptions
  }
  // readonly parser!: BaseParser
  readonly serializer = (options: EventOptions) => {
    const keys = Object.keys(options).sort()
    if (!keys.length) return ''
    const vals = {}
    for (const key of keys) vals[key] = options[key]
    return createHash('sha1').update(JSON.stringify(vals)).digest('base64url')
  }

  withPayload<NewPayload>() {
    const event = new Event<NewPayload, EventOptions>()
    Object.assign(event, this)
    return event
  }

  withOptions<NewOptions extends Record<string, any>>(
    serializer?: (options: NewOptions) => string,
  ) {
    const event = new Event<EventPayload, NewOptions>()
    Object.assign(event, this, serializer ? { serializer } : {})
    return event
  }
}

export class EventManager<
  Connection extends BaseTransportConnection = BaseTransportConnection,
> {
  constructor(
    private readonly application: {
      registry: Registry
      subManager: BaseSubscriptionManager
      logger: Logger
    },
  ) {}

  async subscribe<E extends AnyEvent>(
    event: E,
    options: E['_']['options'],
    connection: Connection,
  ): Promise<{ subscription: Subscription<E>; isNew: boolean }> {
    const eventName = this.registry.getName('event', event)
    const eventKey = this.getKey(event, eventName, options)
    const { id, subscriptions } = connection
    let subscription = subscriptions.get(eventKey) as
      | Subscription<E>
      | undefined
    if (subscription) return { subscription, isNew: false }
    this.logger.debug(
      options,
      `Subscribing connection [${id}] to event [${eventName}] with options`,
    )
    subscription = new Subscription(event, eventKey, () =>
      this.unsubscribe(event, options, connection),
    )
    subscriptions.set(eventKey, subscription)
    await this.subManager.subscribe(subscription)
    return { subscription, isNew: true }
  }

  async unsubscribe<E extends AnyEvent>(
    event: E,
    options: E['_']['options'],
    connection: Connection,
  ) {
    const eventName = this.registry.getName('event', event)
    const { id, subscriptions } = connection
    this.logger.debug(
      `Unsubscribing connection [${id}] from event [${eventName}]`,
    )
    const eventKey = this.getKey(event, eventName, options)
    const subscription = subscriptions.get(eventKey)
    if (!subscription) return false
    await this.subManager.unsubscribe(subscription)
    subscription.end()
    subscriptions.delete(eventKey)
  }

  async publish<E extends AnyEvent>(
    event: E,
    payload: E['_']['payload'],
    options: E['_']['options'],
  ) {
    const eventName = this.registry.getName('event', event)
    this.logger.debug(payload, `Publishing event [${eventName}]`)
    const eventKey = this.getKey(event, eventName, options)
    return this.subManager.publish(eventKey, payload)
  }

  async isSubscribed<E extends AnyEvent>(
    event: E,
    options: E['_']['options'],
    connection: Connection,
  ) {
    const eventName = this.registry.getName('event', event)
    const key = this.getKey(event, eventName, options)
    return connection.subscriptions.has(key)
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

  protected getKey(event: AnyEvent, name: string, options: EventOptionsType) {
    return `${name}:${event.serializer(options)}`
  }
}
