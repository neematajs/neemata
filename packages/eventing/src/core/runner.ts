import type { Container, Logger } from '@nmtjs/core'
import { anyAbortSignal } from '@nmtjs/common'
import { ExecutionEnvironment } from '@nmtjs/core'

import type { EventingAdapter, EventingConsumer } from './adapter.ts'
import type { AnyEventingConsumerDefinition } from './consumer.ts'
import { handleEventingConsumerMessage } from './consumer.ts'

export type EventingRunnerRuntime = { logger: Logger; container: Container }

export type EventingRunnerOptions = { adapter: EventingAdapter }

export type EventingRunnerStartOptions = {
  consumers: readonly AnyEventingConsumerDefinition[]
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
        const consumer = await this.options.adapter.consume(
          {
            topics: [definition.message.subscription.namespace],
            groupId: definition.groupId,
            consumerId: definition.consumerId ?? options.consumerId,
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
        this.consumers.push(consumer)
        consumer.closed.catch((error) => {
          if (signal.aborted) return
          this.logger.error(
            { error, event: definition.message.event },
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
}

function resolveConsumerIndexes(
  consumers: readonly AnyEventingConsumerDefinition[],
  options: EventingRunnerStartOptions,
): readonly number[] {
  return options.consumerIndexes ?? consumers.map((_, index) => index)
}
