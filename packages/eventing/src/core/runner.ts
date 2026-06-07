import type { Container, Logger } from '@nmtjs/core'
import { anyAbortSignal } from '@nmtjs/common'
import { ExecutionEnvironment, Scope } from '@nmtjs/core'

import type {
  EventingAdapter,
  EventingAdapterMessage,
  EventingConsumer,
} from './adapter.ts'
import type { AnyEventingConsumerDefinition } from './consumer.ts'
import type { AnyEventingSubscriptionConsumerDefinition } from './subscription-consumer.ts'
import {
  decodeEventingMessage,
  handleEventingConsumerMessage,
} from './consumer.ts'
import { isEventingSubscriptionConsumerDefinition } from './subscription-consumer.ts'

export type AnyEventingRunnerConsumerDefinition =
  | AnyEventingConsumerDefinition
  | AnyEventingSubscriptionConsumerDefinition

export type EventingRunnerRuntime = { logger: Logger; container?: Container }

export type EventingRunnerOptions = { adapter: EventingAdapter }

export type EventingRunnerStartOptions = {
  consumers: readonly AnyEventingRunnerConsumerDefinition[]
  consumerIndexes?: readonly number[]
  consumerId?: string
  signal?: AbortSignal
}

export class EventingRunner {
  protected readonly execution: ExecutionEnvironment
  protected readonly consumers: EventingConsumer[] = []
  protected abortController?: AbortController
  protected started = false
  protected adapterInitialized = false

  constructor(
    protected readonly runtime: EventingRunnerRuntime,
    protected readonly options: EventingRunnerOptions,
  ) {
    this.execution = new ExecutionEnvironment({
      logger: runtime.logger,
      container: runtime.container,
      label: 'EventingRunner',
    })
  }

  get logger() {
    return this.execution.logger
  }

  get container() {
    return this.execution.container
  }

  async start(options: EventingRunnerStartOptions): Promise<void> {
    if (this.started) throw new Error('EventingRunner already started')

    this.started = true
    this.abortController = new AbortController()
    const signal = options.signal
      ? anyAbortSignal(this.abortController.signal, options.signal)
      : this.abortController.signal

    try {
      await this.options.adapter.initialize()
      this.adapterInitialized = true

      for (const index of resolveConsumerIndexes(options.consumers, options)) {
        const definition = options.consumers[index]!
        const consumer = isEventingSubscriptionConsumerDefinition(definition)
          ? await this.consumeSubscriptionDefinition(
              definition,
              options.consumerId,
              signal,
            )
          : await this.consumeEventDefinition(
              definition,
              options.consumerId,
              signal,
            )
        this.consumers.push(consumer)
        consumer.closed.catch((error) => {
          if (signal.aborted) return
          this.logger.error(
            { error, consumer: getConsumerDefinitionName(definition) },
            'Eventing consumer failed',
          )
          queueMicrotask(() => {
            throw error
          })
        })
      }
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.abortController?.abort()
    await Promise.allSettled(this.consumers.map((consumer) => consumer.close()))
    this.consumers.length = 0
    if (this.adapterInitialized) await this.options.adapter.dispose()
    this.adapterInitialized = false
    this.abortController = undefined
    this.started = false
  }

  async dispose(): Promise<void> {
    await this.stop()
    await this.execution.dispose()
  }

  protected async consumeEventDefinition(
    definition: AnyEventingConsumerDefinition,
    consumerId: string | undefined,
    signal: AbortSignal,
  ): Promise<EventingConsumer> {
    return await this.options.adapter.consume(
      {
        topics: [definition.message.subscription.namespace],
        groupId: definition.groupId,
        consumerId: definition.consumerId ?? consumerId,
        from: definition.from,
        recoverPending: definition.recoverPending,
        deadLetter: definition.deadLetter,
        signal,
      },
      async (message) => {
        if (message.name !== definition.message.event) return
        await handleEventingConsumerMessage(
          definition,
          { logger: this.logger },
          message,
        )
      },
    )
  }

  protected async consumeSubscriptionDefinition(
    definition: AnyEventingSubscriptionConsumerDefinition,
    consumerId: string | undefined,
    signal: AbortSignal,
  ): Promise<EventingConsumer> {
    return await this.options.adapter.consume(
      {
        topics: [definition.subscription.namespace],
        groupId: definition.groupId,
        consumerId: definition.consumerId ?? consumerId,
        from: definition.from,
        recoverPending: definition.recoverPending,
        deadLetter: definition.deadLetter,
        signal,
      },
      async (message) => {
        if (!Object.hasOwn(definition.handlers, message.name)) {
          if (definition.unhandled === 'fail') {
            throw new Error(`Unhandled eventing message [${message.name}]`)
          }
          return
        }

        const handler = definition.handlers[message.name]
        if (!handler) return

        await this.handleSubscriptionMessage(definition, handler, message)
      },
    )
  }

  protected async handleSubscriptionMessage(
    definition: AnyEventingSubscriptionConsumerDefinition,
    handler: AnyEventingSubscriptionConsumerDefinition['handlers'][string],
    message: EventingAdapterMessage,
  ): Promise<void> {
    if (!handler) return

    const event = decodeEventingMessage(handler.event, message)
    const retry = handler.retry ?? definition.retry
    const attempts = normalizeRetryAttempts(retry?.attempts)
    const baseDelayMs = Math.max(0, retry?.delayMs ?? 0)
    const backoff = retry?.backoff ?? 'fixed'

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await using container = this.container.fork(Scope.Global)
        const ctx = await container.createContext(handler.dependencies)
        await handler.handle(ctx, event as never, message)
        return
      } catch (error) {
        if (attempt >= attempts) throw error
        const delayMs =
          backoff === 'exponential'
            ? baseDelayMs * 2 ** (attempt - 1)
            : baseDelayMs
        this.logger.warn(
          {
            error,
            event: handler.event.event,
            topic: handler.event.subscription.namespace,
            attempt,
            attempts,
            delayMs,
          },
          'Eventing subscription handler failed; retrying',
        )
        if (delayMs > 0) await delay(delayMs)
      }
    }
  }
}

function resolveConsumerIndexes(
  consumers: readonly AnyEventingRunnerConsumerDefinition[],
  options: EventingRunnerStartOptions,
): readonly number[] {
  return options.consumerIndexes ?? consumers.map((_, index) => index)
}

function getConsumerDefinitionName(
  definition: AnyEventingRunnerConsumerDefinition,
) {
  return isEventingSubscriptionConsumerDefinition(definition)
    ? definition.subscription.namespace
    : definition.message.event
}

function normalizeRetryAttempts(attempts: number | undefined): number {
  if (attempts === undefined) return 1
  return Math.max(1, Math.floor(attempts))
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
